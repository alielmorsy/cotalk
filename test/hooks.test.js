import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startDaemon, tmpHome, freePort, mcp } from './helpers.js';
import { POLL_S } from '../lib/client.js';

const hook = name => fileURLToPath(new URL(`../hooks/${name}`, import.meta.url));

function runHook(name, input, env, { killAfterMs } = {}) {
  return new Promise((resolve) => {
    const started = Date.now();
    const p = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', hook(name)], { env: { ...process.env, ...env } });
    let out = '', err = '';
    p.stdout.on('data', d => out += d);
    p.stderr.on('data', d => err += d);
    const timer = killAfterMs ? setTimeout(() => p.kill(), killAfterMs) : null;
    p.on('close', code => { clearTimeout(timer); resolve({ code, out, err, ms: Date.now() - started, json: out.trim() ? JSON.parse(out) : null }); });
    p.stdin.end(JSON.stringify(input));
  });
}

function project(t, cfg) {
  const dir = tmpHome(t);
  writeFileSync(join(dir, '.ltt.json'), JSON.stringify(cfg));
  return dir;
}

test('hooks.json references existing scripts', () => {
  const h = JSON.parse(readFileSync(new URL('../hooks/hooks.json', import.meta.url), 'utf8')).hooks;
  assert.ok(h.SessionStart && h.UserPromptSubmit && h.Stop);
  assert.equal(h.Stop[0].hooks[1].asyncRewake, true);
});

test('hooks down: nudge/stop/wake exit 0 fast with no output', async (t) => {
  const home = tmpHome(t), port = await freePort();
  const cwd = project(t, { workspace: 'shop', agent: 'api' });
  for (const name of ['nudge.js', 'stop.js', 'wake.js']) {
    const r = await runHook(name, { cwd, session_id: 's' }, { LTT_HOME: home, LTT_PORT: String(port), CLAUDECODE: '1' });
    assert.equal(r.code, 0, name);
    assert.equal(r.out, '', name);
    // wall time includes node spawn/boot/teardown, which alone reach 1-3 s on Windows while the parallel suite runs;
    // the hook's own down-path is ~200 ms (isUp gets ECONNREFUSED in ~2 ms). 2500 still catches any 3 s api/4 s start timeout.
    assert.ok(r.ms < 2500, `${name} took ${r.ms}ms`);
  }
});

test('session-start without config explains how to join', async (t) => {
  const cwd = tmpHome(t), home = tmpHome(t);
  const r = await runHook('session-start.js', { cwd, hook_event_name: 'SessionStart' }, { LTT_HOME: home, LTT_PORT: String(await freePort()) });
  assert.equal(r.code, 0);
  assert.match(r.json.hookSpecificOutput.additionalContext, /no \.ltt\.json/);
});

test('session-start starts the daemon, registers, and lists peers', async (t) => {
  // registered first: after-hooks run FIFO, so the detached daemon must be shut down (and gone) before tmpHome removes its home
  let home, port;
  t.after(async () => {
    try { await fetch(`http://127.0.0.1:${port}/api/shutdown`, { method: 'POST', headers: { 'x-ltt-token': readFileSync(join(home, 'token'), 'utf8').trim() } }); } catch {}
    for (let i = 0; i < 40; i++) {
      try { await fetch(`http://127.0.0.1:${port}/health`); } catch { break; }
      await new Promise(r => setTimeout(r, 100));
    }
    await new Promise(r => setTimeout(r, 200)); // port closes just before process.exit releases the db
  });
  home = tmpHome(t); port = await freePort();
  const env = { LTT_HOME: home, LTT_PORT: String(port), CLAUDECODE: '1' };
  const web = project(t, { workspace: 'shop', agent: 'web', role: 'frontend' });
  const api = project(t, { workspace: 'shop', agent: 'api', role: 'REST API', owns: ['api/**'] });
  const r1 = await runHook('session-start.js', { cwd: web, session_id: 'w1', hook_event_name: 'SessionStart' }, env);
  assert.match(r1.json.hookSpecificOutput.additionalContext, /you are agent "web" in workspace "shop"/);
  const r2 = await runHook('session-start.js', { cwd: api, session_id: 'a1', hook_event_name: 'SessionStart' }, env);
  const ctx = r2.json.hookSpecificOutput.additionalContext;
  assert.match(ctx, /- web — frontend \[active, claude\]/);
  assert.doesNotMatch(ctx, /- api — /, 'excludes self');
});

test('nudge injects once; stop blocks once', async (t) => {
  const d = await startDaemon(t);
  const env = { LTT_HOME: d.home, LTT_PORT: String(d.port), CLAUDECODE: '1' };
  const cwd = project(t, { workspace: 'shop', agent: 'api' });
  const { call } = mcp(d.base, d.token);
  await call('ltt_register', { workspace: 'shop', agent: 'api' });
  await call('ltt_register', { workspace: 'shop', agent: 'web' });
  await call('ltt_request', { workspace: 'shop', agent: 'web', to: 'api', kind: 'question', title: 'Pagination?' });
  const s1 = await runHook('stop.js', { cwd, hook_event_name: 'Stop' }, env);
  assert.equal(s1.json.decision, 'block');
  assert.match(s1.json.reason, /Pagination\?/);
  const s2 = await runHook('stop.js', { cwd, hook_event_name: 'Stop' }, env);
  assert.equal(s2.out, '', 'stop blocks once');
  await call('ltt_board_write', { workspace: 'shop', agent: 'web', key: 'web.routes', kind: 'note', title: 'Routes', body: '/' });
  const n1 = await runHook('nudge.js', { cwd, hook_event_name: 'UserPromptSubmit' }, env);
  assert.equal(n1.json.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
  assert.match(n1.json.hookSpecificOutput.additionalContext, /1 board update/);
  const n2 = await runHook('nudge.js', { cwd, hook_event_name: 'UserPromptSubmit' }, env);
  assert.equal(n2.out, '');
  const s3 = await runHook('stop.js', { cwd, hook_event_name: 'Stop', stop_hook_active: true }, env);
  assert.equal(s3.out, '');
});

test('stop does not block on a claim (nothing for the requester to do)', async (t) => {
  const d = await startDaemon(t);
  const env = { LTT_HOME: d.home, LTT_PORT: String(d.port), CLAUDECODE: '1' };
  const cwd = project(t, { workspace: 'shop', agent: 'web' });
  const { call } = mcp(d.base, d.token);
  await call('ltt_register', { workspace: 'shop', agent: 'web' });
  await call('ltt_register', { workspace: 'shop', agent: 'api' });
  await call('ltt_request', { workspace: 'shop', agent: 'web', to: 'api', kind: 'task', title: 'Build it' });
  await call('ltt_respond', { workspace: 'shop', agent: 'api', id: 1, action: 'claim' });
  const s1 = await runHook('stop.js', { cwd, hook_event_name: 'Stop' }, env);
  assert.equal(s1.out, '', 'claim is not urgent');
  await call('ltt_respond', { workspace: 'shop', agent: 'api', id: 1, action: 'done', response: 'ok' });
  const s2 = await runHook('stop.js', { cwd, hook_event_name: 'Stop' }, env);
  assert.equal(s2.json.decision, 'block', 'done is urgent');
});

test('wake: poll stays below the 30 min offline threshold and the fetch 300 s headers timeout', () => {
  const src = readFileSync(hook('wake.js'), 'utf8');
  assert.ok(POLL_S > 0 && POLL_S + 10 < 300, `poll ${POLL_S}s`);
  assert.match(src, /POLL_S \} from '\.\.\/lib\/client\.js'/);
  assert.match(src, /timeout: POLL_S,/);
  assert.match(src, /timeoutMs: \(POLL_S \+ 10\) \* 1000/);
});

test('wake: exits 2 when a peer asks; exits 0 at once outside Claude', async (t) => {
  const d = await startDaemon(t);
  const env = { LTT_HOME: d.home, LTT_PORT: String(d.port), CLAUDECODE: '1' };
  const cwd = project(t, { workspace: 'shop', agent: 'api' });
  const { call } = mcp(d.base, d.token);
  await call('ltt_register', { workspace: 'shop', agent: 'api' });
  await call('ltt_register', { workspace: 'shop', agent: 'web' });
  const notAgy = await runHook('wake.js', { cwd, session_id: 'x' }, { ...env, CLAUDECODE: '' });
  assert.equal(notAgy.code, 0);
  assert.ok(notAgy.ms < 2500); // measures node startup too: flaky under parallel load below this
  const waking = runHook('wake.js', { cwd, session_id: 'sess-1' }, env, { killAfterMs: 10_000 });
  await new Promise(r => setTimeout(r, 500));
  await call('ltt_request', { workspace: 'shop', agent: 'web', to: 'api', kind: 'task', title: 'Add /invoices' });
  const r = await waking;
  assert.equal(r.code, 2);
  assert.match(r.err, /Add \/invoices/);
});

test('wake: newer waiter for the same agent supersedes older (even from another session)', async (t) => {
  const d = await startDaemon(t);
  const env = { LTT_HOME: d.home, LTT_PORT: String(d.port), CLAUDECODE: '1' };
  const cwd = project(t, { workspace: 'shop', agent: 'api' });
  await mcp(d.base, d.token).call('ltt_register', { workspace: 'shop', agent: 'api' });
  const older = runHook('wake.js', { cwd, session_id: 'dead-session' }, env, { killAfterMs: 10_000 });
  await new Promise(r => setTimeout(r, 500));
  const newer = runHook('wake.js', { cwd, session_id: 'new-session' }, env, { killAfterMs: 1500 });
  assert.equal((await older).code, 0);
  await newer;
});
