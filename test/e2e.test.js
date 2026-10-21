import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { startDaemon, mcp } from './helpers.js';

const W = 'shop';

test('api, web and billing coordinate through the daemon', async (t) => {
  const d = await startDaemon(t);
  const c = mcp(d.base, d.token);
  const as = agent => (name, args = {}) => c.call(name, { workspace: W, agent, ...args });
  const api = as('api'), web = as('web'), billing = as('billing');

  await api('cotalk_register', { role: 'REST API', owns: ['api/**'] });
  await web('cotalk_register', { role: 'frontend', owns: ['web/**'] });
  await billing('cotalk_register', { role: 'billing', owns: ['billing/**'] });

  // api publishes a contract; web reads it
  await api('cotalk_board_write', { key: 'api.users.schema', kind: 'contract', title: 'User', body: '{"id":"uuid","email":"string"}' });
  const entry = await web('cotalk_board_read', { key: 'api.users.schema' });
  assert.equal(entry.data.entry.version, 1);

  // web asks; api is blocked in cotalk_wait and wakes up
  await api('cotalk_inbox'); // clear join events so the wait below is about the question
  const waiting = api('cotalk_wait', { timeout_seconds: 30 });
  await new Promise(r => setTimeout(r, 200));
  const q = await web('cotalk_request', { to: 'api', kind: 'question', title: 'Is email unique?', refs: ['api.users.schema'] });
  const woke = await waiting;
  assert.ok(woke.data.events.some(e => e.type === 'question.new'));
  await api('cotalk_respond', { id: q.data.request.id, action: 'answer', response: 'yes, unique index' });
  const answered = await web('cotalk_requests', { id: q.data.request.id });
  assert.equal(answered.data.request.status, 'answered');

  // billing broadcasts a task; api claims and finishes it
  const task = await billing('cotalk_request', { to: '*', kind: 'task', title: 'Expose GET /users/:id/plan' });
  await api('cotalk_respond', { id: task.data.request.id, action: 'claim' });
  const webIncoming = await web('cotalk_requests', { box: 'incoming' });
  assert.equal(webIncoming.data.requests.length, 0);
  await api('cotalk_board_write', { key: 'api.users.plan', kind: 'contract', title: 'GET /users/:id/plan', body: '{"plan":"free|pro"}' });
  await api('cotalk_respond', { id: task.data.request.id, action: 'done', response: 'see api.users.plan' });
  const billingInbox = await billing('cotalk_inbox');
  assert.ok(billingInbox.data.events.some(e => e.type === 'request.updated' && /finished/.test(e.summary)));

  // web cannot overwrite api's contract
  const denied = await web('cotalk_board_write', { key: 'api.users.schema', kind: 'contract', title: 'x', body: 'x' });
  assert.equal(denied.isError, true);

  // peers view
  const peers = await billing('cotalk_peers');
  assert.deepEqual(peers.data.peers.map(p => p.agent), ['api', 'billing', 'web']);
});

test('data survives daemon restart', async (t) => {
  // d2 owns cleanup of the shared home; d1 gets a no-op context so its cleanup can't delete the home under d2
  const home = mkdtempSync(join(tmpdir(), 'cotalk-test-'));
  const d1 = await startDaemon({ after() {} }, { home });
  t.after(d1.stop);
  await mcp(d1.base, d1.token).call('cotalk_board_write', { workspace: W, agent: 'api', key: 'api.k', kind: 'note', title: 'K', body: 'kept' });
  await d1.stop();
  const d2 = await startDaemon(t, { home, port: d1.port });
  const r = await mcp(d2.base, d2.token).call('cotalk_board_read', { workspace: W, agent: 'web', key: 'api.k' });
  assert.equal(r.data.entry.body, 'kept');
});

test('hook HTTP API: register, notify, urgent wait wakes on a peer task', async (t) => {
  const d = await startDaemon(t);
  const headers = { 'content-type': 'application/json', 'x-cotalk-token': d.token };
  const get = async (path) => {
    const r = await fetch(`${d.base}${path}`, { headers });
    assert.equal(r.status, 200);
    return r.json();
  };
  const register = async (agent) => {
    const r = await fetch(`${d.base}/api/register`, { method: 'POST', headers, body: JSON.stringify({ workspace: W, agent, role: agent, tool: 'claude' }) });
    assert.equal(r.status, 200);
    return r.json();
  };
  const q = (agent, extra = '') => `workspace=${W}&agent=${agent}${extra}`;

  const reg = await register('api');
  assert.equal(reg.you.agent, 'api');
  await register('billing');

  // notify mode returns billing's join once, then nothing
  const first = await get(`/api/unread?${q('api', '&mode=notify')}`);
  assert.ok(first.events.some(e => e.type === 'agent.joined' && e.actor === 'billing'));
  assert.equal((await get(`/api/unread?${q('api', '&mode=notify')}`)).events.length, 0);

  // urgent-only wait ignores a board write, wakes on a task
  const waiting = get(`/api/wait?${q('api', '&urgent=1&timeout=20&holder=e2e')}`);
  let settled = false;
  waiting.then(() => { settled = true });
  const billing = (name, args) => mcp(d.base, d.token).call(name, { workspace: W, agent: 'billing', ...args });
  await billing('cotalk_board_write', { key: 'billing.plans', kind: 'note', title: 'Plans', body: 'free|pro' });
  await new Promise(r => setTimeout(r, 300));
  assert.equal(settled, false);
  await billing('cotalk_request', { to: 'api', kind: 'task', title: 'Expose plan' });
  assert.deepEqual(await waiting, { result: 'event' });

  const after = await get(`/api/unread?${q('api', '&mode=notify')}`);
  assert.ok(after.events.some(e => e.type === 'task.new'));
  assert.equal(after.incoming, 1);
});
