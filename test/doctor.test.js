import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startDaemon } from './helpers.js';

const CLI = fileURLToPath(new URL('../bin/ltt.js', import.meta.url));
const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url)).replaceAll('\\', '/').replace(/\/+$/, '');
const FAKE_TOOL = fileURLToPath(new URL('./fixtures/fake-tool.js', import.meta.url));

function tmp(t) {
  const d = mkdtempSync(join(tmpdir(), 'ltt-doctor-test-'));
  t.after(() => rmSync(d, { recursive: true, force: true }));
  return d;
}

test('doctor checks node version, path, daemon, dashboard, tools, and identity', async (t) => {
  const d = await startDaemon(t);
  const dir = tmp(t);
  const agySettings = join(dir, 'settings.json');
  const agyMcpConfig = join(dir, 'mcp_config.json');
  const codexConfig = join(dir, 'config.toml');

  // Set up valid settings and tokens
  writeFileSync(agySettings, JSON.stringify({ permissions: { allow: ['mcp(let-them-talk/*)'] } }));
  writeFileSync(agyMcpConfig, JSON.stringify({ mcpServers: { 'let-them-talk': { headers: { 'X-LTT-Token': d.token } } } }));
  writeFileSync(codexConfig, `[mcp_servers.let-them-talk]\nhttp_headers = { "X-LTT-Token" = "${d.token}" }\n`);
  writeFileSync(join(dir, '.ltt.json'), JSON.stringify({ workspace: 'testws', agent: 'tester' }));

  const env = {
    ...process.env,
    LTT_HOME: d.home,
    LTT_PORT: String(d.port),
    LTT_BIN_PATH: join(REPO_ROOT, 'bin', 'ltt.js'),
    LTT_CLAUDE_BIN: FAKE_TOOL,
    LTT_AGY_BIN: FAKE_TOOL,
    LTT_CODEX_BIN: FAKE_TOOL,
    LTT_AGY_SETTINGS: agySettings,
    LTT_AGY_MCP_CONFIG: agyMcpConfig,
    LTT_CODEX_CONFIG: codexConfig,
  };

  const r = spawnSync(process.execPath, [CLI, 'doctor'], { cwd: dir, encoding: 'utf8', env });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /✔ Node v/);
  assert.match(r.stdout, /✔ ltt on PATH resolves to/);
  assert.match(r.stdout, /✔ daemon running on/);
  assert.match(r.stdout, /✔ dashboard built/);
  assert.match(r.stdout, /✔ claude: let-them-talk plugin installed/);
  assert.match(r.stdout, /✔ agy: let-them-talk MCP registered and permissions allowed/);
  assert.match(r.stdout, /✔ codex: let-them-talk MCP server configured/);
  assert.match(r.stdout, /✔ identity: tester in testws/);
});

test('doctor --json returns structured results and exits 1 on failure', (t) => {
  const dir = tmp(t);
  const home = tmp(t);

  const env = {
    ...process.env,
    LTT_HOME: home,
    LTT_PORT: '1',
    LTT_BIN_PATH: join(dir, 'other-ltt.js'),
    LTT_CLAUDE_BIN: join(dir, 'no-claude'),
    LTT_AGY_BIN: join(dir, 'no-agy'),
    LTT_CODEX_BIN: join(dir, 'no-codex'),
  };

  const r = spawnSync(process.execPath, [CLI, 'doctor', '--json'], { cwd: dir, encoding: 'utf8', env });
  assert.equal(r.status, 1);
  const list = JSON.parse(r.stdout);
  assert.ok(Array.isArray(list));
  for (const item of list) {
    assert.ok(typeof item.check === 'string');
    assert.ok(typeof item.ok === 'boolean');
    assert.ok(['✔', '✖', '!'].includes(item.level));
    assert.ok(typeof item.detail === 'string');
  }

  const pathCheck = list.find(x => x.check === 'ltt-path');
  assert.equal(pathCheck.ok, false);
  assert.equal(pathCheck.level, '✖');
  assert.equal(pathCheck.fix, 'npm link');

  const daemonCheck = list.find(x => x.check === 'daemon');
  assert.equal(daemonCheck.ok, false);
  assert.equal(daemonCheck.level, '✖');

  const identityCheck = list.find(x => x.check === 'identity');
  assert.equal(identityCheck.ok, false);
  assert.equal(identityCheck.level, '!');
  assert.equal(identityCheck.fix, 'ltt init');
});

test('doctor detects token mismatch between daemon and agy/codex', async (t) => {
  const d = await startDaemon(t);
  const dir = tmp(t);
  const agySettings = join(dir, 'settings.json');
  const agyMcpConfig = join(dir, 'mcp_config.json');
  const codexConfig = join(dir, 'config.toml');

  writeFileSync(agySettings, JSON.stringify({ permissions: { allow: ['mcp(let-them-talk/*)'] } }));
  // Stale tokens
  writeFileSync(agyMcpConfig, JSON.stringify({ mcpServers: { 'let-them-talk': { headers: { 'X-LTT-Token': 'old-stale-token' } } } }));
  writeFileSync(codexConfig, `[mcp_servers.let-them-talk]\nhttp_headers = { "X-LTT-Token" = "old-stale-token" }\n`);
  writeFileSync(join(dir, '.ltt.json'), JSON.stringify({ workspace: 'testws', agent: 'tester' }));

  const env = {
    ...process.env,
    LTT_HOME: d.home,
    LTT_PORT: String(d.port),
    LTT_BIN_PATH: join(REPO_ROOT, 'bin', 'ltt.js'),
    LTT_CLAUDE_BIN: join(dir, 'no-claude'),
    LTT_AGY_BIN: FAKE_TOOL,
    LTT_CODEX_BIN: FAKE_TOOL,
    LTT_AGY_SETTINGS: agySettings,
    LTT_AGY_MCP_CONFIG: agyMcpConfig,
    LTT_CODEX_CONFIG: codexConfig,
  };

  const r = spawnSync(process.execPath, [CLI, 'doctor', '--json'], { cwd: dir, encoding: 'utf8', env });
  assert.equal(r.status, 1);
  const list = JSON.parse(r.stdout);
  const agyCheck = list.find(x => x.check === 'agy');
  assert.equal(agyCheck.ok, false);
  assert.equal(agyCheck.level, '✖');
  assert.match(agyCheck.detail, /stale MCP token/);
  assert.equal(agyCheck.fix, 'ltt setup');

  const codexCheck = list.find(x => x.check === 'codex');
  assert.equal(codexCheck.ok, false);
  assert.equal(codexCheck.level, '✖');
  assert.match(codexCheck.detail, /stale MCP token/);
  assert.equal(codexCheck.fix, 'ltt setup');
});
