import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startDaemon, mcp } from './helpers.js';
import { POLL_S } from '../lib/client.js';
import { parseArgs, agyArgs, chatArgs, turnLine, render, pushPrompt, bootstrapPrompt } from '../bin/worker.js';

const CLI = fileURLToPath(new URL('../bin/cotalk.js', import.meta.url));
const FAKE = fileURLToPath(new URL('./fixtures/fake-agy.js', import.meta.url));
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function until(fn, ms = 5000, what = 'condition') {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(50);
  }
}

// ---- pure helpers ----

test('parseArgs: name, flags, owns list, extra args after --', () => {
  assert.deepEqual(parseArgs(['physics', '--role', 'Phys', '--owns', 'a/**, b/**', '--yolo', '--', '--model', 'x', '--detach']), {
    name: 'physics', role: 'Phys', owns: ['a/**', 'b/**'], workspace: undefined, yolo: true, detach: false, chat: false, extra: ['--model', 'x', '--detach'],
  });
  assert.deepEqual(parseArgs(['w1', '--workspace', 'engine', '--detach']), {
    name: 'w1', role: undefined, owns: undefined, workspace: 'engine', yolo: false, detach: true, chat: false, extra: [],
  });
  assert.throws(() => parseArgs(['w1', '--bogus']), /unknown option/);
  assert.throws(() => parseArgs(['w1', '--role']), /needs a value/);
});

test('agyArgs: stream-json, yolo flags, extra args before -p=', () => {
  const io = ['--input-format', 'stream-json', '--output-format', 'stream-json'];
  assert.deepEqual(agyArgs({ yolo: false, extra: [] }), [...io, '-p=']);
  assert.deepEqual(agyArgs({ yolo: true, extra: ['--model', 'm'] }), [...io, '--dangerously-skip-permissions', '--sandbox', '--model', 'm', '-p=']);
});

test('turnLine is one NDJSON user event', () => {
  const line = turnLine('hi "there"\nnext');
  assert.ok(line.endsWith('\n'));
  assert.equal(line.split('\n').length, 2);
  assert.deepEqual(JSON.parse(line), { event: 'user', message: { content: 'hi "there"\nnext' } });
});

test('render: text, tool steps, results, everything else null', () => {
  const su = (s) => ({ event: 'step_update', step_update: s });
  assert.equal(render(su({ step_index: 1, state: 'DONE', step_type: 'agent_response', text_delta: 'hello' })), 'hello');
  assert.equal(render(su({ step_index: 1, state: 'ACTIVE', step_type: 'tool', tool_name: 'view_file' })), '  → view_file');
  assert.equal(render(su({ step_index: 1, state: 'ACTIVE', step_type: 'tool', tool_name: 'call_mcp_tool',
    tool_info: { name: 'call_mcp_tool', parameters: { server_name: 'cotalk', tool_name: 'cotalk_inbox' } } })), '  → call_mcp_tool cotalk_inbox');
  assert.equal(render(su({ step_index: 1, state: 'DONE', step_type: 'tool', tool_name: 'view_file' })), null);
  assert.equal(render(su({ step_index: 0, state: 'DONE', step_type: 'user_input' })), null);
  assert.equal(render({ event: 'init', conversation_id: 'c' }), null);
  assert.equal(render({ event: 'result', result: { status: 'SUCCESS', response: 'x', usage: { total_tokens: 42 } } }), '✓ turn done (42 tokens)');
  assert.equal(render({ event: 'result', result: { status: 'ERROR', error: 'boom' } }), '✗ boom');
});

test('prompts: bootstrap names identity and cotalk_inbox; push lists events', () => {
  const b = bootstrapPrompt({ workspace: 'engine', name: 'physics', role: 'Phys' });
  for (const s of ['worker "physics"', 'Phys', '"engine"', 'cotalk_inbox', 'done', '"user"', 'lead', 'ready']) assert.ok(b.includes(s), s);
  const p = pushPrompt([{ id: 3, type: 'task.new', summary: 'lead assigns physics a task: A (#1)' }]);
  assert.ok(p.startsWith('cotalk: new for you:\n- #3 lead assigns physics a task: A (#1)\nCall cotalk_inbox and handle them (claim → do → done with a summary). '), p);
  assert.ok(p.includes('installed on PATH'), p);
});

// ---- integration: bin/cotalk.js worker against a real daemon and the fake agy ----

function cleanEnv(extra) {
  const env = { ...process.env, ...extra };
  for (const k of ['COTALK_AGENT', 'COTALK_ROLE', 'COTALK_OWNS', 'COTALK_WORKER', 'COTALK_WORKER_DETACHED', 'COTALK_TOOL', 'CLAUDECODE']) delete env[k];
  return env;
}

function runner(args, { cwd, env }) {
  const child = spawn(process.execPath, [CLI, 'worker', ...args], { cwd, env, stdio: 'pipe', windowsHide: true });
  const r = { child, out: '', err: '', code: undefined };
  child.stdout.on('data', d => { r.out += d; });
  child.stderr.on('data', d => { r.err += d; });
  r.exited = new Promise(res => child.on('close', (code) => { r.code = code; res(code); }));
  return r;
}

async function stopRunner(r) {
  if (!r || r.code !== undefined) return;
  try { r.child.stdin.end('/quit\n'); } catch {}
  const t = setTimeout(() => r.child.kill(), 3000); // the fake agy exits on its own once its stdin pipe closes
  await r.exited;
  clearTimeout(t);
}

async function setup(t, { delay, mcpConfig = true, cotalk = true, fake = {} } = {}) {
  let r;
  t.after(() => stopRunner(r)); // registered before startDaemon: after-hooks run FIFO, so the runner stops before the daemon
  const d = await startDaemon(t);
  const dir = mkdtempSync(join(tmpdir(), 'cotalk-worker-'));
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const cwd = join(dir, 'proj');
  mkdirSync(cwd);
  if (cotalk) writeFileSync(join(cwd, '.cotalk.json'), JSON.stringify({ workspace: 'engine', agent: 'lead' }));
  const mcpPath = join(dir, 'mcp_config.json');
  if (mcpConfig) writeFileSync(mcpPath, JSON.stringify({ mcpServers: { 'cotalk': { serverUrl: `${d.base}/mcp` } } }));
  const agyLog = join(dir, 'agy-turns.log');
  const env = cleanEnv({
    COTALK_HOME: d.home, COTALK_PORT: String(d.port), COTALK_AGY_BIN: FAKE, COTALK_AGY_MCP_CONFIG: mcpPath, FAKE_AGY_LOG: agyLog,
    ...(delay ? { FAKE_AGY_DELAY_MS: String(delay) } : {}), ...fake,
  });
  const turns = () => { try { return readFileSync(agyLog, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)); } catch { return []; } };
  const state = async () => (await (await fetch(`${d.base}/api/state`, { headers: { 'x-cotalk-token': d.token } })).json())
    .workspaces.find(w => w.workspace === 'engine');
  const start = (args = ['physics', '--role', 'Phys']) => (r = runner(args, { cwd, env }));
  return { d, dir, cwd, env, turns, state, start, m: mcp(d.base, d.token) };
}

test('worker started from a Claude shell asks the task sender, not the human', async (t) => {
  const s = await setup(t);
  s.env.CLAUDECODE = '1';
  s.start();
  const boot = await until(() => s.turns()[0], 5000, 'bootstrap turn');
  assert.ok(boot.includes('sent you the task'), boot);
});

test('worker: bootstrap, registration, pushed task, typed line, clean cwd, /quit', async (t) => {
  const s = await setup(t);
  const r = s.start();
  const boot = await until(() => s.turns()[0], 5000, 'bootstrap turn');
  assert.match(boot, /worker "physics"/);
  assert.match(boot, /cotalk_inbox/);
  const me = await until(async () => (await s.state())?.peers.find(p => p.agent === 'physics'), 5000, 'registration');
  assert.equal(me.tool, 'agy-worker');
  assert.equal(me.role, 'Phys');
  await until(() => r.out.includes('✓ turn done (1 tokens)'), 5000, 'bootstrap result rendered');
  assert.match(r.out, /ack: /);

  await s.m.call('cotalk_register', { workspace: 'engine', agent: 'lead', role: 'architect' });
  const task = await s.m.call('cotalk_request', { workspace: 'engine', agent: 'lead', to: 'physics', kind: 'task', title: 'Tune gravity constant' });
  assert.equal(task.isError, false, task.text);
  const push = await until(() => s.turns().find(x => x.includes('Tune gravity constant')), 5000, 'pushed task turn');
  assert.match(push, /^cotalk: new for you:/);

  r.child.stdin.write('hello\n');
  await until(() => s.turns().includes('hello'), 5000, 'typed turn');

  r.child.stdin.write('/quit\n');
  assert.equal(await r.exited, 0, r.err);
  assert.match(r.out, /agy exited \(0\)/);
  assert.deepEqual(readdirSync(s.cwd), ['.cotalk.json'], 'nothing written into cwd');
  assert.ok(readFileSync(join(s.d.home, 'workers', 'engine.physics.log'), 'utf8').includes('Tune gravity constant'), 'log in COTALK_HOME/workers');
});

test('worker: push waits for idle and pushes once with both tasks', async (t) => {
  const s = await setup(t, { delay: 1500 });
  await s.m.call('cotalk_register', { workspace: 'engine', agent: 'lead' });
  const r = s.start();
  await until(async () => (await s.state())?.peers.find(p => p.agent === 'physics'), 5000, 'registration');
  await until(() => s.turns().length === 1, 5000, 'bootstrap turn'); // bootstrap is now running for 1.5 s
  for (const title of ['First busy task', 'Second busy task'])
    assert.equal((await s.m.call('cotalk_request', { workspace: 'engine', agent: 'lead', to: 'physics', kind: 'task', title })).isError, false);
  await sleep(300);
  assert.equal(s.turns().length, 1, 'nothing pushed while busy');
  await until(() => s.turns().length >= 2, 5000, 'push after result');
  await until(() => (r.out.match(/✓ turn done/g) || []).length >= 2, 5000, 'push turn result');
  await sleep(500);
  const pushes = s.turns().filter(x => x.startsWith('cotalk: new for you:'));
  assert.equal(pushes.length, 1, JSON.stringify(s.turns()));
  assert.match(pushes[0], /First busy task/);
  assert.match(pushes[0], /Second busy task/);
});

test('worker: /reply answers a question the worker asked the user', async (t) => {
  const s = await setup(t);
  const r = s.start();
  await until(async () => (await s.state())?.peers.find(p => p.agent === 'physics'), 5000, 'registration');
  const q = await s.m.call('cotalk_request', { workspace: 'engine', agent: 'physics', to: 'user', kind: 'question', title: 'Use SI units?' });
  assert.equal(q.isError, false, q.text);
  const id = q.data.request.id;
  r.child.stdin.write('hello\n'); // questions are listed after each turn's result
  await until(() => r.out.includes(`❓ #${id} Use SI units? — answer: /reply ${id} <text>`), 5000, 'question shown');
  r.child.stdin.write(`/reply ${id} yes\n`);
  await until(() => r.out.includes(`#${id} answered`), 5000, 'reply ack');
  const got = await s.m.call('cotalk_requests', { workspace: 'engine', agent: 'physics', id });
  assert.equal(got.data.request.status, 'answered');
  assert.equal(got.data.request.response, 'yes');
});

test('worker: exits with agy exit code when agy crashes', async (t) => {
  const s = await setup(t);
  const r = s.start();
  await until(() => r.out.includes('✓ turn done'), 5000, 'bootstrap result');
  const t0 = Date.now();
  r.child.stdin.write('crash\n');
  assert.equal(await r.exited, 7);
  assert.ok(Date.now() - t0 < 3000, `exit took ${Date.now() - t0} ms`);
  assert.match(r.out, /agy exited \(7\)/);
});

test('worker: missing MCP config or workspace → exit 1', async (t) => {
  const noMcp = await setup(t, { mcpConfig: false });
  const a = noMcp.start();
  assert.equal(await a.exited, 1);
  assert.match(a.err, /cotalk agy-mcp/);
  assert.deepEqual(noMcp.turns(), [], 'agy never started');

  const noWs = await setup(t, { cotalk: false });
  const b = noWs.start();
  assert.equal(await b.exited, 1);
  assert.match(b.err, /no workspace/);

  const bad = await setup(t);
  const c = bad.start(['user']);
  assert.equal(await c.exited, 1);
});

test('worker: long-poll stays under the fetch 300 s headers timeout', () => {
  assert.ok(POLL_S + 10 < 300, String(POLL_S));
});

test('worker: skips a null JSON line; agy gets COTALK_TOOL=agy', async (t) => {
  const s = await setup(t, { fake: { FAKE_AGY_NULL: '1' } });
  const r = s.start();
  await until(() => r.out.includes('✓ turn done') || r.code !== undefined, 5000, 'bootstrap result');
  assert.equal(r.code, undefined, r.err);
  r.child.stdin.write('env' + String.fromCharCode(10));
  await until(() => r.out.includes('COTALK_TOOL=agy'), 5000, 'env turn');
  r.child.stdin.write('/quit' + String.fromCharCode(10));
  assert.equal(await r.exited, 0, r.err);
});

test('worker: exits when agy exits even if a grandchild still holds its pipes', async (t) => {
  let pidFile;
  t.after(() => { try { process.kill(Number(readFileSync(pidFile, 'utf8'))); } catch {} });
  const s = await setup(t);
  pidFile = join(s.dir, 'grandchild.pid');
  s.env.FAKE_AGY_GRANDCHILD = pidFile;
  const r = s.start();
  await until(() => r.out.includes('✓ turn done'), 5000, 'bootstrap result');
  r.child.stdin.write('/quit' + String.fromCharCode(10));
  assert.equal(await Promise.race([r.exited, sleep(6000).then(() => 'hung')]), 0, r.err);
  assert.match(r.out, /agy exited \(0\)/);
});

test('--ask: questions go to the task sender, tagged [user]; without it they go to the human', () => {
  assert.equal(parseArgs(['g', '--ask']).ask, true);
  const b = bootstrapPrompt({ workspace: 'e', name: 'g', ask: true });
  for (const s of ['Never send requests to "user"', 'sent you the task', '"[user] "', 'installed on PATH', 'ready']) assert.ok(b.includes(s), s);
  const own = bootstrapPrompt({ workspace: 'e', name: 'g' });
  assert.ok(own.includes('to "user", the human, never to "lead"'), own);
  assert.ok(!own.includes('[user]'));
  assert.ok(chatArgs({ workspace: 'e', name: 'g', ask: true })[1].includes('sent you the task'));
  assert.ok(chatArgs({ workspace: 'e', name: 'g' })[1].includes('here directly, never with cotalk_request to "user" or "lead"'));
  assert.ok(pushPrompt([], true).includes("task's sender") && pushPrompt([]).includes('not "lead"'));
});

test('--chat: parsed, and chatArgs is an interactive agy (-i) that parks on a background cotalk wait', () => {
  assert.equal(parseArgs(['g', '--chat']).chat, true);
  const a = chatArgs({ workspace: 'engine', name: 'gfx', role: 'RHI', yolo: true, extra: ['--model', 'm'] });
  assert.equal(a[0], '-i');
  for (const s of ['"gfx"', '"engine"', 'RHI', 'cotalk_inbox', '`cotalk wait`', 'BACKGROUND']) assert.ok(a[1].includes(s), s);
  assert.deepEqual(a.slice(2), ['--dangerously-skip-permissions', '--model', 'm']);
  assert.deepEqual(chatArgs({ workspace: 'e', name: 'g' }).slice(2), []);
});
