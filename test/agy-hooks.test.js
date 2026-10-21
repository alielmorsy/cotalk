import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startDaemon, tmpHome, freePort, mcp } from './helpers.js';

const HOOK = fileURLToPath(new URL('../hooks/agy.js', import.meta.url));

async function runAgy(event, input, env) {
  const started = Date.now();
  const { code, out } = await new Promise((resolve) => {
    const p = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', HOOK, event], { env: { ...process.env, ...env } });
    let out = '';
    p.stdout.on('data', d => out += d);
    p.on('close', code => resolve({ code, out }));
    p.stdin.end(JSON.stringify(input));
  });
  assert.equal(code, 0, `${event} exit code`);
  assert.doesNotMatch(out, /hookSpecificOutput/);
  const json = JSON.parse(out); // exactly one JSON object
  assert.ok(json && typeof json === 'object' && !Array.isArray(json));
  return { json, ms: Date.now() - started, msg: json.injectSteps?.map(s => s.ephemeralMessage).join('\n') ?? '' };
}

function project(t, cfg) {
  const dir = tmpHome(t);
  writeFileSync(join(dir, '.cotalk.json'), JSON.stringify(cfg));
  return dir;
}

const inv = (dir, conversationId) => ({ conversationId, workspacePaths: [dir], modelName: 'auto', invocationNum: 1, initialNumSteps: 0 });

test('agy: no config notices once per conversation; stop is a no-op', async (t) => {
  const home = tmpHome(t), cwd = tmpHome(t);
  const env = { COTALK_HOME: home, COTALK_PORT: String(await freePort()) };
  const r1 = await runAgy('pre-invocation', inv(cwd, 'c1'), env);
  assert.match(r1.msg, /no \.cotalk\.json/);
  assert.ok(existsSync(join(home, 'agy-sessions', 'c1')));
  assert.deepEqual((await runAgy('pre-invocation', inv(cwd, 'c1'), env)).json, {});
  assert.match((await runAgy('pre-invocation', inv(cwd, 'c2'), env)).msg, /no \.cotalk\.json/, 'new conversation');
  assert.deepEqual((await runAgy('stop', { conversationId: 'c1', workspacePaths: [cwd], terminationReason: 'model_stop' }, env)).json, {});
});

test('agy: roster folder without a role lists the roles and tells a desktop app to ask the user', async (t) => {
  const cwd = project(t, { workspace: 'engine', agents: { lead: {}, physics: {} } });
  const env = { COTALK_HOME: tmpHome(t), COTALK_PORT: String(await freePort()) };
  const { msg } = await runAgy('pre-invocation', inv(cwd, 'c1'), env);
  assert.match(msg, /lead, physics/);
  assert.match(msg, /desktop app.*ask the user which role.*cotalk_register/);
});

test('agy: first call starts daemon + registers + full context; later calls remind and relay unread once', async (t) => {
  // registered first: after-hooks run FIFO, so the detached daemon must be gone before tmpHome removes its home
  let home, port;
  t.after(async () => {
    try { await fetch(`http://127.0.0.1:${port}/api/shutdown`, { method: 'POST', headers: { 'x-cotalk-token': readFileSync(join(home, 'token'), 'utf8').trim() } }); } catch {}
    for (let i = 0; i < 40; i++) {
      try { await fetch(`http://127.0.0.1:${port}/health`); } catch { break; }
      await new Promise(r => setTimeout(r, 100));
    }
    await new Promise(r => setTimeout(r, 200));
  });
  home = tmpHome(t); port = await freePort();
  const env = { COTALK_HOME: home, COTALK_PORT: String(port) };
  const web = project(t, { workspace: 'shop', agent: 'web', role: 'frontend' });
  const api = project(t, { workspace: 'shop', agent: 'api', role: 'REST API', owns: ['api/**'] });

  const w1 = await runAgy('pre-invocation', inv(web, 'conv-web'), env);
  assert.match(w1.msg, /you are agent "web" in workspace "shop"/);
  const a1 = await runAgy('pre-invocation', inv(api, 'conv-api'), env);
  assert.match(a1.msg, /- web — frontend \[active, agy\]/);
  assert.doesNotMatch(a1.msg, /- api — /, 'excludes self');

  const reminder = /^cotalk: you are "api" in workspace "shop"; pass workspace\/agent on cotalk_\* calls\. `cotalk` is on PATH; never look for its source\.$/;
  await runAgy('pre-invocation', inv(api, 'conv-api'), env); // drain anything already pending
  const token = readFileSync(join(home, 'token'), 'utf8').trim();
  await mcp(`http://127.0.0.1:${port}`, token).call('cotalk_board_write', { workspace: 'shop', agent: 'web', key: 'web.routes', kind: 'note', title: 'Routes', body: '/' });
  const a2 = await runAgy('pre-invocation', inv(api, 'conv-api'), env);
  assert.match(a2.msg.split('\n')[0], reminder);
  assert.match(a2.msg, /1 board update/);
  assert.match(a2.msg, /web\.routes|Routes/);
  const a3 = await runAgy('pre-invocation', inv(api, 'conv-api'), env);
  assert.match(a3.msg, reminder, 'no repeated unread');
});

test('agy: stop blocks once for a pending question', async (t) => {
  const d = await startDaemon(t);
  const env = { COTALK_HOME: d.home, COTALK_PORT: String(d.port) };
  const cwd = project(t, { workspace: 'shop', agent: 'api' });
  const { call } = mcp(d.base, d.token);
  await call('cotalk_register', { workspace: 'shop', agent: 'api' });
  await call('cotalk_register', { workspace: 'shop', agent: 'web' });
  await call('cotalk_request', { workspace: 'shop', agent: 'web', to: 'api', kind: 'question', title: 'Pagination?' });
  const input = { conversationId: 'c', workspacePaths: [cwd], executionNum: 1, terminationReason: 'model_stop', fullyIdle: true };
  const s1 = await runAgy('stop', input, env);
  assert.equal(s1.json.decision, 'continue');
  assert.match(s1.json.reason, /Pagination\?/);
  assert.deepEqual((await runAgy('stop', input, env)).json, {}, 'blocks once');
});

test('agy: daemon down is fast, valid JSON, exit 0', async (t) => {
  const home = tmpHome(t);
  const env = { COTALK_HOME: home, COTALK_PORT: String(await freePort()) };
  const cwd = project(t, { workspace: 'shop', agent: 'api' });
  mkdirSync(join(home, 'agy-sessions'), { recursive: true });
  writeFileSync(join(home, 'agy-sessions', 'seen'), ''); // a later invocation: must not spawn the daemon
  const p = await runAgy('pre-invocation', inv(cwd, 'seen'), env);
  assert.match(p.msg, /^cotalk: you are "api" in workspace "shop"; pass workspace\/agent on cotalk_\* calls\. `cotalk` is on PATH; never look for its source\.$/);
  assert.ok(p.ms < 2500, `pre-invocation took ${p.ms}ms`);
  const s = await runAgy('stop', { conversationId: 'seen', workspacePaths: [cwd] }, env);
  assert.deepEqual(s.json, {});
  assert.ok(s.ms < 2500, `stop took ${s.ms}ms`);
  assert.deepEqual((await runAgy('bogus', {}, env)).json, {});
});

test('agy: a worker\'s agy keeps the runner\'s agy-worker tool', async (t) => {
  const d = await startDaemon(t);
  const cwd = project(t, { workspace: 'shop', agent: 'lead' });
  const env = { COTALK_HOME: d.home, COTALK_PORT: String(d.port), COTALK_WORKER: '1', COTALK_TOOL: 'agy', COTALK_AGENT: 'w1' };
  const w = (await runAgy('pre-invocation', inv(cwd, 'cw'), env)).msg;
  assert.match(w, /you are agent "w1"/);
  assert.doesNotMatch(w, /cotalk wait/, 'a headless worker is pushed to, it must not park on a wait');
  const state = await (await fetch(`${d.base}/api/state`, { headers: { 'x-cotalk-token': d.token } })).json();
  assert.deepEqual(state.workspaces.find(w => w.workspace === 'shop').peers.map(p => [p.agent, p.tool]), [['w1', 'agy-worker']]);
});

test('agy: interactive agy is told to park on a background `cotalk wait`', async (t) => {
  const d = await startDaemon(t);
  const cwd = project(t, { workspace: 'shop', agent: 'lead' });
  const env = { COTALK_HOME: d.home, COTALK_PORT: String(d.port), COTALK_TOOL: 'agy', COTALK_AGENT: 'gfx' };
  const msg = (await runAgy('pre-invocation', inv(cwd, 'ci'), env)).msg;
  assert.match(msg, /BACKGROUND task.*cotalk wait|`cotalk wait` as a BACKGROUND/);
  assert.match(msg, /ask them every question .* here directly, never with cotalk_request to "user" or "lead"/);
  assert.match(msg, /installed on PATH.*Never search for, read or run cotalk's source/);
  assert.doesNotMatch(msg, /cotalk-lead/, 'the lead hint is for Claude');
});
