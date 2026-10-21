import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startDaemon } from './helpers.js';

const CLI = fileURLToPath(new URL('../bin/cotalk.js', import.meta.url));
const FAKE_TOOL = fileURLToPath(new URL('./fixtures/fake-tool.js', import.meta.url));
const PKG = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).name; // npm name, not the command
const FAKE_NPM = fileURLToPath(new URL('./fixtures/fake-npm.js', import.meta.url));

function tmp(t) {
  const d = mkdtempSync(join(tmpdir(), 'cotalk-setup-test-'));
  t.after(() => rmSync(d, { recursive: true, force: true }));
  return d;
}

test('setup --dry-run prints plan and runs nothing', (t) => {
  const dir = tmp(t);
  const home = tmp(t);
  const logFile = join(dir, 'tool.log');

  const env = {
    ...process.env,
    COTALK_HOME: home,
    COTALK_PORT: '1',
    COTALK_CLAUDE_BIN: FAKE_TOOL,
    COTALK_AGY_BIN: FAKE_TOOL,
    COTALK_CODEX_BIN: FAKE_TOOL,
    FAKE_TOOL_LOG: logFile,
  };

  const r = spawnSync(process.execPath, [CLI, 'setup', '--dry-run'], { cwd: dir, encoding: 'utf8', env });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /claude:\s+claude plugin marketplace add/);
  assert.match(r.stdout, /claude plugin install cotalk@/);
  assert.match(r.stdout, /agy:\s+agy plugin install/);
  assert.match(r.stdout, /cotalk agy-mcp/);
  assert.match(r.stdout, /codex:\s+cotalk codex-mcp/);
  // nothing was run (except --version probe)
  if (existsSync(logFile)) {
    const lines = readFileSync(logFile, 'utf8').trim().split('\n').map(JSON.parse);
    assert.ok(lines.every(args => args.includes('--version')), 'only probed versions');
  }
});

test('setup --dry-run respects --only and --statusline and reports skipped tools', (t) => {
  const dir = tmp(t);
  const home = tmp(t);

  const env = {
    ...process.env,
    COTALK_HOME: home,
    COTALK_PORT: '1',
    COTALK_AGY_BIN: FAKE_TOOL,
    COTALK_CLAUDE_BIN: join(dir, 'no-such-claude.exe'),
    COTALK_CODEX_BIN: join(dir, 'no-such-codex.exe'),
  };

  const r = spawnSync(process.execPath, [CLI, 'setup', '--dry-run', '--only', 'agy,claude', '--statusline'], { cwd: dir, encoding: 'utf8', env });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /claude: skipped \(not found\)/);
  assert.match(r.stdout, /agy:\s+agy plugin install/);
  assert.match(r.stdout, /cotalk statusline agy/);
  assert.doesNotMatch(r.stdout, /codex/, '--only codex was excluded');
});

test('setup executes detected tools, starts daemon, reports ok and dashboard url', async (t) => {
  const d = await startDaemon(t);
  const dir = tmp(t);
  const logFile = join(dir, 'tool.log');
  const agySettings = join(dir, 'agy-settings.json');
  const codexConfig = join(dir, 'config.toml');

  writeFileSync(agySettings, JSON.stringify({ permissions: { allow: [] } }));

  const env = {
    ...process.env,
    COTALK_HOME: d.home,
    COTALK_PORT: String(d.port),
    COTALK_CLAUDE_BIN: FAKE_TOOL,
    COTALK_AGY_BIN: FAKE_TOOL,
    COTALK_CODEX_BIN: FAKE_TOOL,
    COTALK_CODEX_CONFIG: codexConfig,
    FAKE_TOOL_LOG: logFile,
  };

  const r = spawnSync(process.execPath, [CLI, 'setup', '--settings', agySettings], { cwd: dir, encoding: 'utf8', env });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /claude: ok/);
  assert.match(r.stdout, /agy: ok/);
  assert.match(r.stdout, /codex: ok/);
  assert.match(r.stdout, /Restart your tools to load changes/);
  assert.match(r.stdout, new RegExp(`Dashboard: ${d.base}/\\?token=${d.token}`));

  // verify codex config and agy settings got written
  assert.ok(existsSync(codexConfig));
  assert.match(readFileSync(codexConfig, 'utf8'), /\[mcp_servers\.cotalk\]/);
  const settings = JSON.parse(readFileSync(agySettings, 'utf8'));
  assert.ok(settings.permissions.allow.includes('mcp(cotalk/*)'));
});

test('setup reports failed: <reason> and exits 1 if a tool fails', async (t) => {
  const d = await startDaemon(t);
  const dir = tmp(t);

  const env = {
    ...process.env,
    COTALK_HOME: d.home,
    COTALK_PORT: String(d.port),
    COTALK_CLAUDE_BIN: FAKE_TOOL,
    FAKE_TOOL_FAIL: '1',
  };

  const r = spawnSync(process.execPath, [CLI, 'setup', '--only', 'claude'], { cwd: dir, encoding: 'utf8', env });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /claude: failed: simulated plugin failure/);
});

test('setup under npx cache: --dry-run prints global install plan and runs nothing', (t) => {
  const dir = tmp(t);
  const npxRoot = join(dir, '_npx', '12345', 'node_modules', 'cotalk');
  mkdirSync(npxRoot, { recursive: true });
  writeFileSync(join(npxRoot, 'package.json'), JSON.stringify({ version: '0.1.5' }));

  const npmLog = join(dir, 'npm.log');
  const globalLib = join(dir, 'global-lib');

  const env = {
    ...process.env,
    COTALK_REPO_ROOT: npxRoot,
    COTALK_NPM_BIN: FAKE_NPM,
    FAKE_NPM_ROOT: globalLib,
    FAKE_NPM_LOG: npmLog,
  };

  const r = spawnSync(process.execPath, [CLI, 'setup', '--dry-run'], { cwd: dir, encoding: 'utf8', env });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stdout.includes(`running under npx: installing ${PKG}@0.1.5 globally first`), r.stdout);
  assert.ok(r.stdout.includes(`npm install -g ${PKG}@0.1.5`));
  assert.ok(r.stdout.includes(`/${PKG}/bin/cotalk.js setup --dry-run`), r.stdout);

  // verify npm install was NOT executed
  if (existsSync(npmLog)) {
    const lines = readFileSync(npmLog, 'utf8').trim().split('\n').map(JSON.parse);
    assert.ok(!lines.some(args => args.includes('install')), 'install -g must not be called in dry-run');
  }
});

test('setup under npx cache: installs globally and re-runs setup from global install', (t) => {
  const dir = tmp(t);
  const npxRoot = join(dir, '_npx', '12345', 'node_modules', 'cotalk');
  mkdirSync(npxRoot, { recursive: true });
  writeFileSync(join(npxRoot, 'package.json'), JSON.stringify({ version: '0.1.5' }));

  const npmLog = join(dir, 'npm.log');
  const globalLib = join(dir, 'global-lib');
  const globalCotalkBin = join(globalLib, PKG, 'bin');
  mkdirSync(globalCotalkBin, { recursive: true });

  const witness = join(dir, 'witness.json');
  // Write a fake global cotalk.js that logs its invocation
  writeFileSync(join(globalCotalkBin, 'cotalk.js'), `
    import { writeFileSync } from 'node:fs';
    writeFileSync(${JSON.stringify(witness)}, JSON.stringify(process.argv.slice(2)));
    process.exit(0);
  `);

  const env = {
    ...process.env,
    COTALK_REPO_ROOT: npxRoot,
    COTALK_NPM_BIN: FAKE_NPM,
    FAKE_NPM_ROOT: globalLib,
    FAKE_NPM_LOG: npmLog,
  };

  const r = spawnSync(process.execPath, [CLI, 'setup', '--only', 'agy'], { cwd: dir, encoding: 'utf8', env });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stdout.includes(`running under npx: installing ${PKG}@0.1.5 globally first`), r.stdout);

  // verify npm install was called with correct package version
  assert.ok(existsSync(npmLog));
  const lines = readFileSync(npmLog, 'utf8').trim().split('\n').map(JSON.parse);
  assert.ok(lines.some(args => args[0] === 'install' && args[1] === '-g' && args[2] === `${PKG}@0.1.5`));

  // verify global cotalk.js was re-run with same args
  assert.ok(existsSync(witness));
  assert.deepEqual(JSON.parse(readFileSync(witness, 'utf8')), ['setup', '--only', 'agy']);
});
