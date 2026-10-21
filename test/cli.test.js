import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startDaemon } from './helpers.js';

const CLI = fileURLToPath(new URL('../bin/ltt.js', import.meta.url));

function run(args, { cwd, home }) {
  return spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: 'utf8', env: { ...process.env, LTT_HOME: home, LTT_PORT: '1' } });
}
function tmp(t) {
  const d = mkdtempSync(join(tmpdir(), 'ltt-cli-'));
  t.after(() => rmSync(d, { recursive: true, force: true }));
  return d;
}

test('init writes .ltt.json and refuses overwrite', (t) => {
  const cwd = tmp(t), home = tmp(t);
  const r = run(['init', '--workspace', 'shop', '--agent', 'api', '--role', 'REST API', '--owns', 'api/**,shared/**'], { cwd, home });
  assert.equal(r.status, 0, r.stderr);
  const cfg = JSON.parse(readFileSync(join(cwd, '.ltt.json'), 'utf8'));
  assert.deepEqual(cfg, { workspace: 'shop', agent: 'api', role: 'REST API', owns: ['api/**', 'shared/**'] });
  assert.equal(run(['init', '--workspace', 'shop', '--agent', 'x'], { cwd, home }).status, 1);
  assert.equal(run(['init', '--workspace', 'shop', '--agent', 'x', '--force'], { cwd, home }).status, 0);
  assert.equal(run(['init', '--workspace', 'bad name', '--agent', 'x', '--force'], { cwd, home }).status, 1);
});

test('statusline claude: backs up, chains previous, dry-run writes nothing', (t) => {
  const cwd = tmp(t), home = tmp(t);
  const settings = join(cwd, 'settings.json');
  const original = JSON.stringify({ theme: 'dark', statusLine: { type: 'command', command: 'echo old' } });
  writeFileSync(settings, original);
  const dry = run(['statusline', 'claude', '--settings', settings, '--dry-run'], { cwd, home });
  assert.equal(dry.status, 0, dry.stderr);
  assert.equal(JSON.parse(readFileSync(settings, 'utf8')).statusLine.command, 'echo old');
  const r = run(['statusline', 'claude', '--settings', settings], { cwd, home });
  assert.equal(r.status, 0, r.stderr);
  const s = JSON.parse(readFileSync(settings, 'utf8'));
  assert.equal(s.theme, 'dark');
  assert.match(s.statusLine.command, /ltt-statusline\.mjs/);
  assert.equal(s.statusLine.refreshInterval, 5);
  assert.ok(existsSync(settings + '.ltt-bak'));
  assert.ok(existsSync(join(home, 'ltt-statusline.mjs')));
  assert.equal(JSON.parse(readFileSync(join(home, 'config.json'), 'utf8')).prevStatusLine.claude, 'echo old');
  run(['statusline', 'claude', '--settings', settings], { cwd, home });
  assert.equal(JSON.parse(readFileSync(join(home, 'config.json'), 'utf8')).prevStatusLine.claude, 'echo old', 're-run keeps original');
  assert.equal(readFileSync(settings + '.ltt-bak', 'utf8'), original, 're-run keeps the original backup');
});

test('statusline agy stacks with default', (t) => {
  const cwd = tmp(t), home = tmp(t);
  const settings = join(cwd, 'agy-settings.json');
  const r = run(['statusline', 'agy', '--settings', settings], { cwd, home });
  assert.equal(r.status, 0, r.stderr);
  const s = JSON.parse(readFileSync(settings, 'utf8'));
  assert.equal(s.statusLine.stack_with_default, true);
  assert.equal(s.statusLine.enabled, true);
});

test('statusline agy: home with spaces gets a whitespace-free command (agy splits on spaces)', { skip: process.platform !== 'win32' }, (t) => {
  const cwd = tmp(t), home = join(tmp(t), 'with space');
  const settings = join(cwd, 'agy-settings.json');
  const r = run(['statusline', 'agy', '--settings', settings], { cwd, home });
  assert.equal(r.status, 0, r.stderr);
  const { command } = JSON.parse(readFileSync(settings, 'utf8')).statusLine;
  assert.doesNotMatch(command.slice('node '.length), /[\s"]/, 'agy passes quotes through literally');
  assert.match(command, /\.mjs$/, 'node needs the real extension');
});

test('agy-mcp dry-run hides token', (t) => {
  const cwd = tmp(t), home = tmp(t);
  writeFileSync(join(home, 'token'), 'secret-token');
  const r = run(['agy-mcp', '--dry-run'], { cwd, home });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /agy mcp add --header "X-LTT-Token: <token>" let-them-talk http:\/\/127\.0\.0\.1:1\/mcp/);
  assert.doesNotMatch(r.stdout + r.stderr, /secret-token/);
});

test('agy-mcp passes the header as one argv element; clear error when agy is missing', async (t) => {
  const d = await startDaemon(t);
  const dir = tmp(t);
  const shim = join(dir, 'agy-shim.js'), out = join(dir, 'argv.json');
  writeFileSync(shim, "require('node:fs').writeFileSync(process.env.SHIM_OUT, JSON.stringify(process.argv.slice(2)));");
  // no real agy may ever run: PATH holds only an empty dir
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => k.toUpperCase() !== 'PATH'));
  Object.assign(env, { PATH: dir, LTT_HOME: d.home, LTT_PORT: String(d.port), SHIM_OUT: out });
  const settings = join(dir, 'agy-settings.json'); // never touch the real ~/.gemini settings
  writeFileSync(settings, JSON.stringify({ theme: 'dark', permissions: { allow: ['command(a)'] } }));
  const cli = (extra) => spawnSync(process.execPath, [CLI, 'agy-mcp', '--settings', settings], { cwd: dir, encoding: 'utf8', env: { ...env, ...extra } });
  const r = cli({ LTT_AGY_BIN: shim });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(readFileSync(out, 'utf8')),
    ['mcp', 'add', '--header', `X-LTT-Token: ${d.token}`, 'let-them-talk', `${d.base}/mcp`]);
  // headless workers need the allow-rule; existing settings survive; re-running adds nothing
  const s = JSON.parse(readFileSync(settings, 'utf8'));
  assert.deepEqual(s.permissions.allow, ['command(a)', 'mcp(let-them-talk/*)']);
  assert.equal(s.theme, 'dark');
  assert.ok(existsSync(settings + '.ltt-bak'));
  assert.equal(cli({ LTT_AGY_BIN: shim }).status, 0);
  assert.equal(JSON.parse(readFileSync(settings, 'utf8')).permissions.allow.length, 2, 'idempotent');
  const missing = cli({});
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /agy not found/);
});

test('unknown command prints usage', (t) => {
  const cwd = tmp(t), home = tmp(t);
  const r = run(['wat'], { cwd, home });
  assert.equal(r.status, 1);
  assert.match(r.stdout + r.stderr, /usage/i);
});

test('usage: slow tools are waited for, a missing tool is reported not fatal, --json is the snapshot', async (t) => {
  const dir = tmp(t);
  const fake = fileURLToPath(new URL('./fixtures/fake-usage.js', import.meta.url));
  // the daemon runs the tools, so the fakes go into its env; agy takes longer than the client's default 3s timeout
  const vars = { LTT_AGY_BIN: fake, LTT_CLAUDE_BIN: join(dir, 'no-such-claude.exe'), FAKE_USAGE_DELAY_MS: '3300',
    FAKE_USAGE_OUT: 'Gemini Models\tWeekly Limit Remaining\t15%\t2026-09-30T17:48:23Z' };
  const old = Object.fromEntries(Object.keys(vars).map(k => [k, process.env[k]]));
  Object.assign(process.env, vars);
  const d = await startDaemon(t);
  for (const [k, v] of Object.entries(old)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  const cli = (...args) => spawnSync(process.execPath, [CLI, 'usage', ...args], { cwd: dir, encoding: 'utf8', env: { ...process.env, LTT_HOME: d.home, LTT_PORT: String(d.port) } });

  const j = cli('--json');
  assert.equal(j.status, 0, j.stderr);
  const snap = JSON.parse(j.stdout);
  assert.deepEqual(snap.agy, { ok: true, windows: [{ label: 'Gemini Models · Weekly Limit', window: 'week', remaining: 15, resets: '2026-09-30T17:48:23Z' }] });
  assert.equal(snap.claude.ok, false);
  assert.match(snap.claude.error, /claude not found .*LTT_CLAUDE_BIN/);

  const text = cli();
  assert.equal(text.status, 0, text.stderr);
  assert.match(text.stdout, /^agy\n {2}Gemini Models · Weekly Limit {2} 15% left {2}resets 2026-09-30T17:48:23Z\nclaude\n {2}unavailable: claude not found/);
});
