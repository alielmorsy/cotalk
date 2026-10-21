import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startDaemon, tmpHome, freePort, mcp } from './helpers.js';
import { patchToml } from '../bin/codex.js';

const LTT = fileURLToPath(new URL('../bin/ltt.js', import.meta.url));
const HOOK = fileURLToPath(new URL('../hooks/codex.js', import.meta.url));

function ltt(args, env) {
  return spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', LTT, ...args], { env: { ...process.env, ...env }, encoding: 'utf8' });
}
function fakeCodex(t) { // stands in for `codex --version`
  const p = join(tmpHome(t), 'fake-codex.js');
  writeFileSync(p, "console.log('codex-cli 0.115.0')");
  return p;
}

test('codex-mcp --dry-run masks the token and touches nothing', async (t) => {
  const dir = tmpHome(t), cfg = join(dir, 'config.toml');
  const env = { LTT_HOME: dir, LTT_PORT: String(await freePort()), LTT_CODEX_CONFIG: cfg };
  writeFileSync(join(dir, 'token'), 'sekrit-token');
  const r = ltt(['codex-mcp', '--dry-run', '--hooks'], env);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /\[mcp_servers\.let-them-talk\]/);
  assert.match(r.stdout, /"X-LTT-Token" = "<token>"/);
  assert.doesNotMatch(r.stdout, /sekrit/);
  assert.ok(!existsSync(cfg));
});

test('codex-mcp: codex missing -> clear message, exit 1, nothing written', (t) => {
  const dir = tmpHome(t), cfg = join(dir, 'config.toml');
  const r = ltt(['codex-mcp'], { LTT_HOME: dir, LTT_CODEX_CONFIG: cfg, LTT_CODEX_BIN: join(dir, 'nope', 'codex.exe') });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /codex not found/);
  assert.ok(!existsSync(cfg));
});

test('codex-mcp patches only our table, keeps the first backup, re-run replaces it', async (t) => {
  const d = await startDaemon(t);
  const cfg = join(d.home, 'config.toml');
  const original = 'model = "x"\n\n[projects.\'E:\\a\']\ntrust_level = "trusted"\n\n[mcp_servers.other]\nurl = "http://o"\n\n[mcp_servers.let-them-talk]\nurl = "old"\n\n[mcp_servers.let-them-talk.extra]\na = 1\n\n[windows]\nsandbox = "unelevated"\n';
  writeFileSync(cfg, original);
  const env = { LTT_HOME: d.home, LTT_PORT: String(d.port), LTT_CODEX_CONFIG: cfg, LTT_CODEX_BIN: fakeCodex(t) };
  const r = ltt(['codex-mcp'], env);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!(r.stdout + r.stderr).includes(d.token), 'token never printed');
  const out = readFileSync(cfg, 'utf8');
  assert.equal(readFileSync(cfg + '.ltt-bak', 'utf8'), original);
  assert.equal(readFileSync(cfg + '.ltt-prev', 'utf8'), original);
  for (const keep of ['model = "x"', "[projects.'E:\\a']", '[mcp_servers.other]\nurl = "http://o"', '[windows]\nsandbox = "unelevated"']) assert.ok(out.includes(keep), keep);
  assert.doesNotMatch(out, /url = "old"|extra/);
  assert.ok(out.includes(`url = "${d.base}/mcp"`));
  assert.ok(out.includes(`http_headers = { "X-LTT-Token" = "${d.token}" }`));

  assert.equal(ltt(['codex-mcp'], env).status, 0);
  const again = readFileSync(cfg, 'utf8');
  assert.equal(again.split('[mcp_servers.let-them-talk]').length, 2, 'one table');
  assert.equal(readFileSync(cfg + '.ltt-bak', 'utf8'), original, 'first backup kept');
  assert.equal(readFileSync(cfg + '.ltt-prev', 'utf8'), out, 'pre-edit content of the latest write');
  assert.ok(again.includes('[mcp_servers.other]'));
});

const URL_ = 'http://127.0.0.1:7777/mcp';
const TABLE = `[mcp_servers.let-them-talk]\nurl = "${URL_}"\nhttp_headers = { "X-LTT-Token" = "tok" }\n`;
const patch = (text, hooks = false) => patchToml(text, URL_, 'tok', { hooks });
const refused = (text, hooks = false) => {
  try { patch(text, hooks); } catch (e) { return e.refusal === true; }
  return false;
};

test('patchToml: a following header containing ] ends our table', () => {
  const out = patch("[mcp_servers.let-them-talk]\nurl = \"old\"\n[projects.'E:\\a[1]']\ntrust_level = \"trusted\"\n");
  assert.equal(out, `[projects.'E:\\a[1]']\ntrust_level = "trusted"\n\n${TABLE}`);
});

test('patchToml: our header inside a multiline string is just text', () => {
  for (const q of ['"""', "'''"]) {
    const text = `notes = ${q}\n[mcp_servers.let-them-talk]\nkeep me\n${q}\n\n[windows]\nsandbox = "u"\n`;
    assert.equal(patch(text), `${text}\n${TABLE}`, q);
  }
});

test('patchToml: comments just above the next table survive', () => {
  const out = patch('[mcp_servers.let-them-talk]\nurl = "old"\n\n# sandbox settings\n[windows]\nsandbox = "u"\n');
  assert.equal(out, `\n# sandbox settings\n[windows]\nsandbox = "u"\n\n${TABLE}`);
});

test('patchToml: refuses edits that would be ambiguous or produce duplicate keys', () => {
  for (const [text, hooks] of [
    ['[ features ]\nfoo = 1\n', true],
    ['[[features]]\nfoo = 1\n', true],
    ['features.codex_hooks = false\n', true],
    ['features.other = 1\n', true],
    ['features = { codex_hooks = false }\n', true],
    ['[features]\n"codex_hooks" = false\n', true],
    ["[features]\n'codex_hooks' = false\n", true],
    ['[features]\na = 1\n[features]\nb = 2\n', true],
    ['[mcp_servers]\nlet-them-talk = { url = "x" }\n', false],
    ['[mcp_servers]\n"let-them-talk".url = "x"\n', false],
    ['mcp_servers.let-them-talk.url = "x"\n', false],
    ['mcp_servers = { other = { url = "x" } }\n', false],
    ['[mcp_servers."let-them-talk"]\nurl = "x"\n', false],
    ['[ mcp_servers.let-them-talk ]\nurl = "x"\n', false],
    ['[[mcp_servers.let-them-talk]]\nurl = "x"\n', false],
    ['[[mcp_servers]]\nurl = "x"\n', false],
    ['not toml at all\n', false],
    ['notes = """\nnever closed\n', false],
  ]) assert.ok(refused(text, hooks), text);
  // fine: features quirks without --hooks, other inline servers, a canonical [features]
  for (const [text, hooks] of [
    ['[ features ]\nfoo = 1\n', false],
    ['features.codex_hooks = false\n', false],
    ['[mcp_servers]\nother = { url = "x" }\n', false],
    ['[features]\ncodex_hooks = false  # off\n[features.sub]\nx = 1\n', true],
  ]) assert.ok(!refused(text, hooks), text);
  assert.equal(patch('[features]\ncodex_hooks = false  # off\n[features.sub]\nx = 1\n', true),
    `[features]\ncodex_hooks = true\n[features.sub]\nx = 1\n\n${TABLE}`);
});

test('patchToml: a realistic config round-trips byte for byte outside our table', () => {
  const before = [
    '# Codex config', 'model = "gpt-5"  # default', '',
    "[projects.'C:\\x[1]']", 'trust_level = "trusted"', '',
    '[mcp_servers.other]', 'command = "node"', 'args = [', '  "server.js",', '  ["nested", "[array]"],', ']', '', '',
  ].join('\n');
  const ours = ['[mcp_servers.let-them-talk]', 'url = "old"', 'http_headers = { "X-LTT-Token" = "old" }', '',
    '[mcp_servers.let-them-talk.env]', 'A = "1"', ''].join('\n');
  const after = [
    '# profiles', '[[profiles]]', 'name = "a"', '',
    '[[profiles]]', 'name = "b"', "instructions = '''", '[mcp_servers.let-them-talk]', "not a table'''",
    'prompt = """', '[features]', 'codex_hooks = false', '"""', '',
    '[windows]', 'sandbox = "unelevated"', '',
  ].join('\n');
  const kept = (before + after).trimEnd();
  assert.equal(patch(before + ours + after), `${kept}\n\n${TABLE}`);
  assert.equal(patch(before + ours + after, true), `${kept}\n\n[features]\ncodex_hooks = true\n\n${TABLE}`);
  const crlf = s => s.replaceAll('\n', '\r\n');
  assert.equal(patch(crlf(before + ours + after), true), crlf(`${kept}\n\n[features]\ncodex_hooks = true\n\n${TABLE}`));
  const once = patch(before + ours + after);
  assert.equal(patch(once), once, 'idempotent');
});

test('codex-mcp refuses an ambiguous config: exit 1, nothing written, snippet printed', async (t) => {
  const dir = tmpHome(t), cfg = join(dir, 'config.toml');
  const original = '[mcp_servers]\nlet-them-talk = { url = "x" }\n';
  writeFileSync(cfg, original);
  writeFileSync(join(dir, 'token'), 'sekrit-token');
  const env = { LTT_HOME: dir, LTT_PORT: String(await freePort()), LTT_CODEX_CONFIG: cfg, LTT_CODEX_BIN: fakeCodex(t) };
  for (const args of [['codex-mcp', '--hooks'], ['codex-mcp', '--dry-run']]) {
    const r = ltt(args, env);
    assert.equal(r.status, 1, args.join(' '));
    const all = r.stdout + r.stderr;
    assert.ok(all.includes(cfg), all);
    assert.match(all, /\[mcp_servers\.let-them-talk\]\nurl = "http:\/\/127\.0\.0\.1:\d+\/mcp"\nhttp_headers = \{ "X-LTT-Token" = "<token>" \}/);
    assert.doesNotMatch(all, /sekrit/);
  }
  assert.equal(readFileSync(cfg, 'utf8'), original);
  for (const f of [cfg + '.ltt-bak', cfg + '.ltt-prev', join(dir, 'hooks.json')]) assert.ok(!existsSync(f), f);
});

test('codex-mcp --hooks writes hooks.json + feature flag, merging existing hooks', async (t) => {
  const d = await startDaemon(t);
  const cfg = join(d.home, 'config.toml'), hj = join(d.home, 'hooks.json');
  writeFileSync(cfg, '[features]\nfoo = true\n');
  writeFileSync(hj, JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'mine' }] }] } }));
  const env = { LTT_HOME: d.home, LTT_PORT: String(d.port), LTT_CODEX_CONFIG: cfg, LTT_CODEX_BIN: fakeCodex(t) };
  for (let i = 0; i < 2; i++) assert.equal(ltt(['codex-mcp', '--hooks'], env).status, 0);
  assert.match(readFileSync(cfg, 'utf8'), /\[features\]\ncodex_hooks = true\nfoo = true/);
  const h = JSON.parse(readFileSync(hj, 'utf8')).hooks;
  assert.deepEqual(Object.keys(h).sort(), ['SessionStart', 'Stop']);
  assert.equal(h.Stop.length, 2, 'ours added once, existing kept');
  assert.equal(h.Stop[0].hooks[0].command, 'mine');
  assert.match(h.Stop[1].hooks[0].command, /hooks\/codex\.js" stop$/);
  assert.equal(JSON.parse(readFileSync(hj + '.ltt-bak', 'utf8')).hooks.Stop.length, 1);
});

test('codex hooks: roster folder without a role lists the roles and tells a desktop app to ask the user', async (t) => {
  const cwd = tmpHome(t);
  writeFileSync(join(cwd, '.ltt.json'), JSON.stringify({ workspace: 'engine', agents: { lead: {}, physics: {} } }));
  const s = await runHook('session-start', { cwd, hook_event_name: 'SessionStart' }, { LTT_HOME: tmpHome(t), LTT_PORT: String(await freePort()) });
  assert.match(ctx(s), /lead, physics/);
  assert.match(ctx(s), /ltt run <role> -- codex/);
  assert.match(ctx(s), /desktop app.*ask the user which role.*ltt_register/);
});

async function runHook(event, input, env) {
  const { code, out } = await new Promise((resolve) => {
    const p = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', HOOK, event], { env: { ...process.env, ...env } });
    let out = '';
    p.stdout.on('data', d => out += d);
    p.on('close', code => resolve({ code, out }));
    p.stdin.end(JSON.stringify(input));
  });
  assert.equal(code, 0);
  return out ? JSON.parse(out) : {};
}
const ctx = j => j.hookSpecificOutput?.additionalContext ?? '';

test('codex hooks: no config, session context, unread nudge, stop blocks once', async (t) => {
  const d = await startDaemon(t);
  const env = { LTT_HOME: d.home, LTT_PORT: String(d.port) };
  const bare = tmpHome(t), api = tmpHome(t);
  writeFileSync(join(api, '.ltt.json'), JSON.stringify({ workspace: 'shop', agent: 'api', role: 'REST' }));

  const none = await runHook('session-start', { cwd: bare, hook_event_name: 'SessionStart' }, env);
  assert.match(ctx(none), /no \.ltt\.json/);
  assert.match(ctx(none), /ltt run <role> -- codex/);
  assert.deepEqual(await runHook('stop', { cwd: bare }, env), {});

  const s = await runHook('session-start', { cwd: api, session_id: 's1', hook_event_name: 'SessionStart' }, env);
  assert.equal(s.hookSpecificOutput.hookEventName, 'SessionStart');
  assert.match(ctx(s), /you are agent "api" in workspace "shop"/);
  const state = await (await fetch(`${d.base}/api/state`, { headers: { 'x-ltt-token': d.token } })).json();
  assert.equal(state.workspaces.find(w => w.workspace === 'shop').peers.find(p => p.agent === 'api').tool, 'codex');

  assert.deepEqual(await runHook('user-prompt', { cwd: api }, env), {}, 'nothing unread');
  const { call } = mcp(d.base, d.token);
  await call('ltt_register', { workspace: 'shop', agent: 'web' });
  await call('ltt_request', { workspace: 'shop', agent: 'web', to: 'api', kind: 'question', title: 'Pagination?' });
  const stop = { cwd: api, hook_event_name: 'Stop', stop_hook_active: false };
  assert.deepEqual(await runHook('stop', { ...stop, stop_hook_active: true }, env), {}, 'stop_hook_active is skipped');
  const b = await runHook('stop', stop, env);
  assert.equal(b.decision, 'block');
  assert.match(b.reason, /Pagination\?/);
  assert.deepEqual(await runHook('stop', stop, env), {}, 'blocks once');
});

test('codex hooks: daemon down is valid and quiet; bogus event is a no-op', async (t) => {
  const home = tmpHome(t), cwd = tmpHome(t);
  writeFileSync(join(cwd, '.ltt.json'), JSON.stringify({ workspace: 'shop', agent: 'api' }));
  const env = { LTT_HOME: home, LTT_PORT: String(await freePort()) };
  assert.deepEqual(await runHook('stop', { cwd }, env), {});
  assert.deepEqual(await runHook('user-prompt', { cwd }, env), {});
  assert.deepEqual(await runHook('bogus', { cwd }, env), {});
});
