import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { openStore, CotalkError, USER } from '../daemon/store.js';
import { createServer } from '../daemon/server.js';
import { startDaemon, mcp } from './helpers.js';

const CLI = fileURLToPath(new URL('../bin/cotalk.js', import.meta.url));
const WS = 'engine';
const code = (fn) => { try { fn(); } catch (e) { assert.ok(e instanceof CotalkError); return e.code; } assert.fail('expected CotalkError'); };

function storeSetup() {
  const store = openStore(':memory:');
  store.register({ workspace: WS, agent: 'lead' });
  store.register({ workspace: WS, agent: 'physics' });
  return store;
}

test('store: user is reserved', () => {
  const store = storeSetup();
  assert.equal(USER, 'user');
  assert.equal(code(() => store.register({ workspace: WS, agent: 'user' })), 'invalid');
  assert.equal(code(() => store.touch(WS, 'user')), 'invalid');
  assert.ok(!store.peers(WS).some(p => p.agent === 'user'));
});

test('store: user is reserved in any case; to: USER means the human', () => {
  const store = storeSetup();
  for (const agent of ['User', 'USER', 'uSeR']) {
    assert.equal(code(() => store.register({ workspace: WS, agent })), 'invalid', agent);
    assert.equal(code(() => store.touch(WS, agent)), 'invalid', agent);
  }
  assert.ok(!store.peers(WS).some(p => p.agent.toLowerCase() === 'user'));
  const r = store.createRequest({ workspace: WS, agent: 'physics', to: 'USER', kind: 'question', title: 'Q?' });
  assert.equal(r.to, 'user');
  assert.deepEqual(store.listRequests(WS, USER, 'incoming').map(x => x.id), [r.id]);
  assert.equal(code(() => store.createRequest({ workspace: WS, agent: USER, to: 'User', kind: 'task', title: 'x' })), 'invalid');
});

test('store: human can cancel an open or claimed request once', () => {
  const store = storeSetup();
  const t = store.createRequest({ workspace: WS, agent: 'lead', to: 'physics', kind: 'task', title: 'T' });
  store.updateRequest({ workspace: WS, agent: 'physics', id: t.id, action: 'claim' });
  assert.equal(store.cancelRequest({ workspace: WS, id: t.id }).status, 'cancelled');
  assert.equal(store.listRequests(WS, '', 'open').length, 0);
  assert.equal(code(() => store.cancelRequest({ workspace: WS, id: t.id })), 'invalid_transition');
  assert.equal(code(() => store.cancelRequest({ workspace: WS, id: 999 })), 'not_found');
});

test('store: worker asks user, human answers, requester gets request.updated', () => {
  const store = storeSetup();
  store.unread(WS, 'physics', { advance: true });
  const q = store.createRequest({ workspace: WS, agent: 'physics', to: 'user', kind: 'question', title: 'Tabs or spaces?' });
  let ev = store.recentEvents(WS, 1)[0];
  assert.equal(ev.target, 'user');
  assert.equal(ev.summary, `physics asks you: Tabs or spaces? (#${q.id})`);
  const t = store.createRequest({ workspace: WS, agent: 'physics', to: 'user', kind: 'task', title: 'Run the migration' });
  assert.equal(store.recentEvents(WS, 1)[0].summary, `physics asks you to: Run the migration (#${t.id})`);
  assert.equal(store.unread(WS, 'lead').events.filter(e => e.type === 'question.new').length, 0, 'not for other agents');

  const bc = store.createRequest({ workspace: WS, agent: 'lead', to: '*', kind: 'question', title: 'Anyone?' });
  assert.deepEqual(store.listRequests(WS, USER, 'incoming').map(r => r.id), [q.id, t.id], 'broadcasts are for agents');

  const a = store.updateRequest({ workspace: WS, agent: USER, id: q.id, action: 'answer', response: 'spaces' });
  assert.equal(a.status, 'answered');
  assert.equal(a.response, 'spaces');
  ev = store.unread(WS, 'physics').events.filter(e => e.type === 'request.updated');
  assert.equal(ev.length, 1);
  assert.equal(ev[0].actor, 'user');
  assert.equal(store.updateRequest({ workspace: WS, agent: USER, id: t.id, action: 'done', response: 'ok' }).status, 'done');

  const other = store.createRequest({ workspace: WS, agent: 'lead', to: 'physics', kind: 'question', title: 'Q' });
  assert.equal(code(() => store.updateRequest({ workspace: WS, agent: USER, id: other.id, action: 'answer', response: 'x' })), 'invalid_transition');
  assert.equal(code(() => store.updateRequest({ workspace: WS, agent: USER, id: bc.id, action: 'answer', response: 'x' })), 'invalid_transition');
  assert.equal(store.getRequest(WS, other.id).status, 'open');
});

test('store: human posts requests to agents', () => {
  const store = storeSetup();
  store.unread(WS, 'physics', { advance: true });
  const r = store.createRequest({ workspace: WS, agent: USER, to: 'physics', kind: 'task', title: 'Fix gravity' });
  assert.equal(r.from, 'user');
  const ev = store.unread(WS, 'physics').events.find(e => e.type === 'task.new');
  assert.ok(ev.summary.startsWith('user assigns physics'), ev.summary);
  assert.equal(store.createRequest({ workspace: WS, agent: USER, to: '*', kind: 'question', title: 'Anyone?' }).to, '*');
  assert.equal(code(() => store.createRequest({ workspace: WS, agent: USER, to: 'nobody', kind: 'task', title: 'x' })), 'not_found');
  assert.equal(code(() => store.createRequest({ workspace: WS, agent: USER, to: USER, kind: 'task', title: 'x' })), 'invalid');
  store.updateRequest({ workspace: WS, agent: 'physics', id: r.id, action: 'done', response: 'fixed' });
  const out = store.listRequests(WS, USER, 'outgoing').find(x => x.id === r.id);
  assert.equal(out.status, 'done');
  assert.equal(store.unread(WS, 'lead').events.filter(e => e.type === 'request.updated').length, 0);
});

async function httpSetup(t) {
  const store = storeSetup();
  const { server } = createServer({ store, token: 'tok', port: 0, mcpFactory: () => async () => null });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(() => { server.closeAllConnections?.(); server.close(); store.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const req = async (path, { method = 'GET', body, headers = { 'x-cotalk-token': 'tok' } } = {}) => {
    const r = await fetch(base + path, { method, headers: { 'content-type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, data: await r.json() };
  };
  return { store, req };
}

test('HTTP: /api/request and /api/respond act as user', async (t) => {
  const { store, req } = await httpSetup(t);
  const posted = await req('/api/request', { method: 'POST', body: { workspace: WS, to: 'physics', kind: 'task', title: 'Tune', body: 'details' } });
  assert.equal(posted.status, 200);
  assert.equal(posted.data.request.from, 'user');
  assert.equal(posted.data.request.body, 'details');
  assert.equal((await req('/api/request', { method: 'POST', body: { workspace: WS, to: 'nobody', kind: 'task', title: 'x' } })).status, 400);

  const q = store.createRequest({ workspace: WS, agent: 'physics', to: 'user', kind: 'question', title: 'Q?' });
  const tk = store.createRequest({ workspace: WS, agent: 'physics', to: 'user', kind: 'task', title: 'T' });
  const x = store.createRequest({ workspace: WS, agent: 'physics', to: 'user', kind: 'question', title: 'X?' });
  const a = await req('/api/respond', { method: 'POST', body: { workspace: WS, id: q.id, response: 'yes' } });
  assert.equal(a.data.request.status, 'answered');
  assert.equal(a.data.request.response, 'yes');
  assert.equal((await req('/api/respond', { method: 'POST', body: { workspace: WS, id: tk.id } })).data.request.status, 'done');
  assert.equal((await req('/api/respond', { method: 'POST', body: { workspace: WS, id: x.id, action: 'reject', response: 'no' } })).data.request.status, 'rejected');

  const other = store.createRequest({ workspace: WS, agent: 'lead', to: 'physics', kind: 'question', title: 'not yours' });
  const bad = await req('/api/respond', { method: 'POST', body: { workspace: WS, id: other.id, response: 'hijack' } });
  assert.equal(bad.status, 400);
  assert.match(bad.data.error, /^invalid_transition/);
  assert.equal(store.getRequest(WS, other.id).status, 'open');
  assert.equal(store.getRequest(WS, other.id).response, '');
  assert.match((await req('/api/respond', { method: 'POST', body: { workspace: WS, id: 999 } })).data.error, /^not_found/);
  assert.match((await req('/api/respond', { method: 'POST', body: { workspace: WS, id: String(q.id) } })).data.error, /^invalid/);
  assert.equal((await req('/api/respond', { method: 'POST', body: [] })).status, 400);
  assert.equal((await req(`/api/respond?token=tok`, { method: 'POST', headers: {}, body: { workspace: WS, id: tk.id } })).status, 401, 'header token only');
});

test('HTTP: /api/requests validates params; /api/state includes user', async (t) => {
  const { store, req } = await httpSetup(t);
  assert.equal((await req('/api/requests?workspace=engine')).status, 400);
  assert.equal((await req('/api/requests?agent=user')).status, 400);
  assert.equal((await req('/api/requests?workspace=engine&agent=user&box=nope')).status, 400);
  const q = store.createRequest({ workspace: WS, agent: 'physics', to: 'user', kind: 'question', title: 'Q?' });
  const mine = store.createRequest({ workspace: WS, agent: USER, to: 'physics', kind: 'task', title: 'T' });
  assert.deepEqual((await req('/api/requests?workspace=engine&agent=user&box=incoming')).data.requests.map(r => r.id), [q.id]);
  assert.deepEqual((await req('/api/requests?workspace=engine&agent=user&box=outgoing')).data.requests.map(r => r.id), [mine.id]);
  assert.deepEqual((await req('/api/requests?workspace=engine&agent=physics&box=incoming')).data.requests.map(r => r.id), [mine.id]);
  const { data } = await req('/api/state');
  assert.deepEqual(data.workspaces[0].user.incoming.map(r => r.id), [q.id]);
  assert.deepEqual(data.workspaces[0].user.outgoing.map(r => r.id), [mine.id]);
});

function tmp(t) {
  const d = mkdtempSync(join(tmpdir(), 'cotalk-human-'));
  t.after(() => rmSync(d, { recursive: true, force: true }));
  return d;
}

test('CLI: ask, task, inbox, reply, reject', async (t) => {
  const d = await startDaemon(t);
  const cwd = tmp(t);
  writeFileSync(join(cwd, '.cotalk.json'), JSON.stringify({ workspace: WS, agent: 'lead' }));
  const cli = (...args) => spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: 'utf8', env: { ...process.env, COTALK_HOME: d.home, COTALK_PORT: String(d.port) } });
  const m = mcp(d.base, d.token);
  await m.call('cotalk_register', { workspace: WS, agent: 'physics' });

  let r = cli('ask', 'physics', 'Which', 'integrator?', '--body', 'RK4 or Verlet');
  assert.equal(r.status, 0, r.stderr);
  const qid = Number(r.stdout.match(/^#(\d+) sent to physics$/m)?.[1]);
  const got = (await m.call('cotalk_requests', { workspace: WS, agent: 'physics', id: qid })).data.request;
  assert.deepEqual([got.from, got.kind, got.title, got.body], ['user', 'question', 'Which integrator?', 'RK4 or Verlet']);
  r = cli('task', 'physics', 'Tune', 'damping');
  assert.equal(r.status, 0, r.stderr);
  const tid = Number(r.stdout.match(/^#(\d+) sent to physics$/m)?.[1]);
  assert.equal((await m.call('cotalk_requests', { workspace: WS, agent: 'physics', id: tid })).data.request.kind, 'task');
  assert.equal(cli('ask', 'nobody', 'x').status, 1);

  await m.call('cotalk_respond', { workspace: WS, agent: 'physics', id: qid, action: 'answer', response: 'Verlet' });
  const q2 = (await m.call('cotalk_request', { workspace: WS, agent: 'physics', to: 'user', kind: 'question', title: 'Ship on Friday?', body: 'line1\nline2' })).data.request;
  r = cli('inbox');
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stdout.includes(`Waiting on you:\n#${q2.id} question from physics: Ship on Friday?\n  line1\n`), r.stdout);
  assert.ok(!r.stdout.includes('line2'));
  assert.ok(r.stdout.includes(`Your requests:\n`), r.stdout);
  assert.ok(r.stdout.includes(`#${qid} → physics [answered] Which integrator? — Verlet\n`), r.stdout);
  assert.ok(r.stdout.includes(`#${tid} → physics [open] Tune damping\n`), r.stdout);

  r = cli('reply', String(q2.id));
  assert.equal(r.status, 1, 'reply needs text');
  assert.match(r.stderr, /usage/);
  assert.equal((await m.call('cotalk_requests', { workspace: WS, agent: 'physics', id: q2.id })).data.request.status, 'open');

  r = cli('reply', String(q2.id), 'yes,', 'ship', 'it');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), `#${q2.id} answered`);
  assert.equal((await m.call('cotalk_requests', { workspace: WS, agent: 'physics', id: q2.id })).data.request.response, 'yes, ship it');

  const q3 = (await m.call('cotalk_request', { workspace: WS, agent: 'physics', to: 'user', kind: 'question', title: 'Rewrite?' })).data.request;
  r = cli('reply', String(q3.id), 'not', 'now', '--reject');
  assert.equal(r.stdout.trim(), `#${q3.id} rejected`, r.stderr);
  const again = cli('reply', String(q3.id), 'again');
  assert.equal(again.status, 1);
  assert.match(again.stderr, /invalid_transition/);
  assert.equal(cli('reply').status, 1, 'usage');
  const q4 = (await m.call('cotalk_request', { workspace: WS, agent: 'physics', to: 'user', kind: 'question', title: 'Skip?' })).data.request;
  assert.equal(cli('reply', String(q4.id), '--reject').stdout.trim(), `#${q4.id} rejected`, '--reject needs no text');

  r = cli('inbox', '--workspace', WS);
  assert.ok(r.stdout.startsWith('Waiting on you:\n(nothing)\n'), r.stdout);
});

test('CLI: no workspace exits 1', (t) => {
  const cwd = tmp(t), home = tmp(t);
  for (const args of [['inbox'], ['ask', 'physics', 'x']]) {
    const r = spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: 'utf8', env: { ...process.env, COTALK_HOME: home, COTALK_PORT: '1' } });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /no workspace: pass --workspace or run inside a folder with \.cotalk\.json/);
  }
});

test('dashboard: answer box posts to /api/respond without token in URL or header', () => {
  const files = ['index.html', 'app.js', 'api.js', 'view-inbox.js'].map(f =>
    readFileSync(new URL(`../dashboard/${f}`, import.meta.url), 'utf8')
  ).join('\n');
  assert.match(files, /\/api\/respond/);
  assert.match(files, /textarea/);
  assert.doesNotMatch(files, /x-cotalk-token/i);
  assert.doesNotMatch(files, /[?&]token=/i);
  assert.doesNotMatch(files, /innerHTML|outerHTML|insertAdjacentHTML|document\.write|DOMParser|srcdoc/);
});
