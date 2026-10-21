import test from 'node:test';
import assert from 'node:assert/strict';
import { openStore, CotalkError, isRelevant } from '../daemon/store.js';

function setup() {
  let t = 1_000_000;
  const clock = { now: () => t, advance: ms => { t += ms; } };
  const store = openStore(':memory:', { now: clock.now });
  store.register({ workspace: 'shop', agent: 'api', role: 'REST API', owns: ['api/**'], tool: 'claude' });
  store.register({ workspace: 'shop', agent: 'web', role: 'frontend', tool: 'agy' });
  return { store, clock };
}

const code = (fn) => { try { fn(); } catch (e) { assert.ok(e instanceof CotalkError); return e.code; } assert.fail('expected CotalkError'); };

test('register + peers + status', () => {
  const { store, clock } = setup();
  const peers = store.peers('shop');
  assert.deepEqual(peers.map(p => p.agent), ['api', 'web']);
  assert.deepEqual(peers[0].owns, ['api/**']);
  assert.equal(peers[0].status, 'active');
  clock.advance(5 * 60_000);
  assert.equal(store.getAgent('shop', 'api').status, 'idle');
  clock.advance(60 * 60_000);
  assert.equal(store.getAgent('shop', 'api').status, 'offline');
  assert.deepEqual(store.workspaces(), ['shop']);
});

test('new agent does not inherit history as unread', () => {
  const { store } = setup();
  store.writeEntry({ workspace: 'shop', agent: 'api', key: 'api.users', kind: 'contract', title: 'Users', body: '{}' });
  store.register({ workspace: 'shop', agent: 'billing' });
  assert.equal(store.unread('shop', 'billing').summary.total, 0);
  assert.equal(store.unread('shop', 'web').summary.board, 1);
});

test('re-register keeps cursors and emits no duplicate join', () => {
  const { store } = setup();
  store.writeEntry({ workspace: 'shop', agent: 'api', key: 'api.a', kind: 'note', title: 'A', body: 'x' });
  store.unread('shop', 'web', { advance: true });
  store.register({ workspace: 'shop', agent: 'web', session_id: 'second-terminal' });
  assert.equal(store.unread('shop', 'web').summary.total, 0);
  assert.equal(store.getAgent('shop', 'web').role, 'frontend');
  assert.equal(store.getAgent('shop', 'web').session_id, 'second-terminal');
});

test('offline agent coming back emits agent.joined', () => {
  const { store, clock } = setup();
  store.unread('shop', 'api', { advance: true }); // drop web's initial join
  clock.advance(60 * 60_000);
  store.touch('shop', 'web');
  const ev = store.unread('shop', 'api').events;
  assert.equal(ev.length, 1);
  assert.equal(ev[0].type, 'agent.joined');
});

test('board write, versioning, ownership', () => {
  const { store } = setup();
  const e1 = store.writeEntry({ workspace: 'shop', agent: 'api', key: 'api.users.schema', kind: 'contract', title: 'Users', body: 'v1' });
  assert.equal(e1.version, 1);
  const e2 = store.writeEntry({ workspace: 'shop', agent: 'api', key: 'api.users.schema', kind: 'contract', title: 'Users', body: 'v2' });
  assert.equal(e2.version, 2);
  assert.equal(store.readEntry('shop', 'api.users.schema').body, 'v2');
  assert.equal(code(() => store.writeEntry({ workspace: 'shop', agent: 'web', key: 'api.users.schema', kind: 'contract', title: 'x', body: 'x' })), 'forbidden');
  assert.equal(code(() => store.writeEntry({ workspace: 'shop', agent: 'web', key: 'api.other', kind: 'note', title: 'x', body: 'x' })), 'forbidden');
  store.writeEntry({ workspace: 'shop', agent: 'web', key: 'shared.colors', kind: 'decision', title: 'Colors', body: 'blue' });
  assert.equal(code(() => store.writeEntry({ workspace: 'shop', agent: 'api', key: 'shared.colors', kind: 'decision', title: 'x', body: 'x' })), 'forbidden');
  assert.deepEqual(store.listEntries('shop').map(e => e.key), ['api.users.schema', 'shared.colors']);
  assert.deepEqual(store.listEntries('shop', 'api.').map(e => e.key), ['api.users.schema']);
  assert.equal(store.listEntries('shop')[0].body, undefined);
  assert.equal(store.readEntry('shop', 'nope'), null);
});

test('validation', () => {
  const { store } = setup();
  assert.equal(code(() => store.register({ workspace: 'bad name', agent: 'x' })), 'invalid');
  assert.equal(code(() => store.writeEntry({ workspace: 'shop', agent: 'api', key: 'api.x', kind: 'weird', title: 't', body: 'b' })), 'invalid');
  assert.equal(code(() => store.writeEntry({ workspace: 'shop', agent: 'api', key: 'api.x', kind: 'note', title: 'x'.repeat(201), body: 'b' })), 'invalid');
  assert.equal(code(() => store.createRequest({ workspace: 'shop', agent: 'web', to: 'ghost', kind: 'question', title: 'hi' })), 'not_found');
  assert.equal(code(() => store.createRequest({ workspace: 'shop', agent: 'web', to: 'web', kind: 'question', title: 'hi' })), 'invalid');
});

test('question flow + unread routing', () => {
  const { store } = setup();
  const q = store.createRequest({ workspace: 'shop', agent: 'web', to: 'api', kind: 'question', title: 'Pagination?', refs: ['api.users.schema'] });
  assert.equal(q.status, 'open');
  assert.deepEqual(q.refs, ['api.users.schema']);
  const apiUnread = store.unread('shop', 'api');
  assert.equal(apiUnread.summary.questions, 1);
  assert.equal(store.unread('shop', 'web').summary.total, 0, 'own events are not unread');
  assert.deepEqual(store.listRequests('shop', 'api', 'incoming').map(r => r.id), [q.id]);
  assert.equal(code(() => store.updateRequest({ workspace: 'shop', agent: 'api', id: q.id, action: 'claim' })), 'invalid_transition');
  const a = store.updateRequest({ workspace: 'shop', agent: 'api', id: q.id, action: 'answer', response: 'cursor based' });
  assert.equal(a.status, 'answered');
  assert.equal(a.response, 'cursor based');
  assert.equal(store.unread('shop', 'web').summary.updates, 1);
  assert.equal(store.listRequests('shop', 'api', 'incoming').length, 0);
  assert.equal(store.listRequests('shop', 'web', 'outgoing')[0].status, 'answered');
  assert.equal(code(() => store.updateRequest({ workspace: 'shop', agent: 'api', id: 999, action: 'answer' })), 'not_found');
});

test('task flow with broadcast to *', () => {
  const { store } = setup();
  store.register({ workspace: 'shop', agent: 'billing' });
  const t = store.createRequest({ workspace: 'shop', agent: 'billing', to: '*', kind: 'task', title: 'Add invoice endpoint' });
  assert.equal(store.unread('shop', 'api').summary.tasks, 1);
  assert.equal(store.unread('shop', 'web').summary.tasks, 1);
  const c = store.updateRequest({ workspace: 'shop', agent: 'api', id: t.id, action: 'claim' });
  assert.equal(c.claimed_by, 'api');
  assert.equal(store.listRequests('shop', 'web', 'incoming').length, 0, 'claimed by someone else');
  assert.equal(code(() => store.updateRequest({ workspace: 'shop', agent: 'web', id: t.id, action: 'done' })), 'invalid_transition');
  const d = store.updateRequest({ workspace: 'shop', agent: 'api', id: t.id, action: 'done', response: 'POST /invoices' });
  assert.equal(d.status, 'done');
  assert.equal(store.listRequests('shop', 'api', 'open').length, 0);
});

test('inbox cursor advance and notify cursor are independent', () => {
  const { store } = setup();
  store.createRequest({ workspace: 'shop', agent: 'web', to: 'api', kind: 'question', title: 'Q1' });
  assert.equal(store.pendingNotify('shop', 'api'), true);
  const n = store.notify('shop', 'api');
  assert.equal(n.summary.questions, 1);
  assert.equal(store.pendingNotify('shop', 'api'), false);
  assert.equal(store.notify('shop', 'api').summary.total, 0, 'notify never repeats');
  assert.equal(store.unread('shop', 'api').summary.questions, 1, 'inbox still unread');
  store.unread('shop', 'api', { advance: true });
  assert.equal(store.unread('shop', 'api').summary.total, 0);
});

test('inbox read also advances the notify cursor', () => {
  const { store } = setup();
  store.createRequest({ workspace: 'shop', agent: 'web', to: 'api', kind: 'question', title: 'Q1' });
  store.unread('shop', 'api', { advance: true });
  assert.equal(store.pendingNotify('shop', 'api'), false, 'already read via inbox');
  assert.equal(store.notify('shop', 'api').summary.total, 0);
});

test('pendingNotify urgentOnly ignores board updates', () => {
  const { store } = setup();
  store.writeEntry({ workspace: 'shop', agent: 'web', key: 'web.routes', kind: 'note', title: 'Routes', body: '/' });
  assert.equal(store.pendingNotify('shop', 'api'), true);
  assert.equal(store.pendingNotify('shop', 'api', { urgentOnly: true }), false);
});

test('onEvent + isRelevant + recentEvents', () => {
  const { store } = setup();
  const seen = [];
  const off = store.onEvent(e => seen.push(e));
  store.createRequest({ workspace: 'shop', agent: 'web', to: 'api', kind: 'question', title: 'Q' });
  off();
  store.writeEntry({ workspace: 'shop', agent: 'api', key: 'api.z', kind: 'note', title: 'Z', body: 'z' });
  assert.equal(seen.length, 1);
  assert.equal(isRelevant(seen[0], 'shop', 'api'), true);
  assert.equal(isRelevant(seen[0], 'shop', 'web'), false);
  assert.equal(isRelevant(seen[0], 'other', 'api'), false);
  assert.equal(isRelevant(seen[0], 'shop', 'api', { urgentOnly: true }), true);
  assert.equal(store.recentEvents('shop', 1)[0].type, 'entry.updated');
});

test('persists across reopen', async (t) => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const dir = mkdtempSync(join(tmpdir(), 'cotalk-store-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'cotalk.db');
  const s1 = openStore(path);
  s1.register({ workspace: 'shop', agent: 'api' });
  s1.writeEntry({ workspace: 'shop', agent: 'api', key: 'api.k', kind: 'note', title: 'K', body: 'b' });
  s1.close();
  const s2 = openStore(path);
  assert.equal(s2.readEntry('shop', 'api.k').body, 'b');
  s2.close();
});

test('dynamic thresholds: getThresholds & setThresholds', () => {
  const { store, clock } = setup();
  assert.deepEqual(store.getThresholds(), { activeMs: 120_000, idleMs: 1_800_000 });
  store.setThresholds({ activeMs: 60_000, idleMs: 300_000 });
  assert.deepEqual(store.getThresholds(), { activeMs: 60_000, idleMs: 300_000 });
  clock.advance(70_000);
  assert.equal(store.getAgent('shop', 'api').status, 'idle');
  clock.advance(300_000);
  assert.equal(store.getAgent('shop', 'api').status, 'offline');
});

test('queryRequests: filtering, pagination, ordering', () => {
  const { store } = setup();
  const q1 = store.createRequest({ workspace: 'shop', agent: 'web', to: 'api', kind: 'question', title: 'Q1' });
  const q2 = store.createRequest({ workspace: 'shop', agent: 'web', to: 'api', kind: 'question', title: 'Q2' });
  const t1 = store.createRequest({ workspace: 'shop', agent: 'web', to: 'api', kind: 'task', title: 'T1' });
  store.updateRequest({ workspace: 'shop', agent: 'api', id: q1.id, action: 'answer', response: 'A1' });
  store.updateRequest({ workspace: 'shop', agent: 'api', id: t1.id, action: 'claim' });

  // query all
  const all = store.queryRequests({ workspace: 'shop' });
  assert.equal(all.total, 3);
  assert.equal(all.requests.length, 3);
  assert.equal(all.requests[0].id, t1.id, 'default DESC order');

  // filter by single status
  const answered = store.queryRequests({ workspace: 'shop', status: 'answered' });
  assert.equal(answered.total, 1);
  assert.equal(answered.requests[0].id, q1.id);

  // filter by comma-separated status
  const active = store.queryRequests({ workspace: 'shop', status: 'open,claimed' });
  assert.equal(active.total, 2);

  // filter by string of statuses
  const stringStatuses = store.queryRequests({ workspace: 'shop', status: 'open, claimed' });
  assert.equal(stringStatuses.total, 2);

  // filter by kind
  const tasks = store.queryRequests({ workspace: 'shop', kind: 'task' });
  assert.equal(tasks.total, 1);
  assert.equal(tasks.requests[0].id, t1.id);

  // pagination
  const page = store.queryRequests({ workspace: 'shop', limit: 2, offset: 1 });
  assert.equal(page.total, 3);
  assert.equal(page.requests.length, 2);
  assert.equal(page.requests[0].id, q2.id);
});

test('bulkCancelRequests: cancel open/claimed, skip others, notify claimed_by', () => {
  const { store } = setup();
  const q1 = store.createRequest({ workspace: 'shop', agent: 'web', to: 'api', kind: 'question', title: 'Q1' });
  const t1 = store.createRequest({ workspace: 'shop', agent: 'web', to: 'api', kind: 'task', title: 'T1' });
  const t2 = store.createRequest({ workspace: 'shop', agent: 'web', to: 'api', kind: 'task', title: 'T2' });
  store.updateRequest({ workspace: 'shop', agent: 'api', id: q1.id, action: 'answer', response: 'done' });
  store.updateRequest({ workspace: 'shop', agent: 'api', id: t1.id, action: 'claim' });
  store.unread('shop', 'api', { advance: true });

  const res = store.bulkCancelRequests({ workspace: 'shop', ids: [t1.id, t2.id, q1.id, 999] });
  assert.deepEqual(res.cancelled, [t1.id, t2.id]);
  assert.equal(res.skipped.length, 2);
  assert.equal(res.skipped[0].id, q1.id);
  assert.equal(res.skipped[1].id, 999);

  assert.equal(store.getRequest('shop', t1.id).status, 'cancelled');
  assert.equal(store.getRequest('shop', t2.id).status, 'cancelled');
  assert.ok(store.unread('shop', 'api').events.some(e => e.type === 'request.updated' && e.ref_id === String(t1.id)));

  // cancelRequest also notifies claimed_by
  const t3 = store.createRequest({ workspace: 'shop', agent: 'web', to: 'api', kind: 'task', title: 'T3' });
  store.updateRequest({ workspace: 'shop', agent: 'api', id: t3.id, action: 'claim' });
  store.unread('shop', 'api', { advance: true });
  store.cancelRequest({ workspace: 'shop', id: t3.id });
  assert.ok(store.unread('shop', 'api').events.some(e => e.type === 'request.updated' && e.ref_id === String(t3.id)));
});

test('reassignRequest: reassign open and claimed requests and notify; reject to === from', () => {
  const { store } = setup();
  store.register({ workspace: 'shop', agent: 'ops' });
  const t1 = store.createRequest({ workspace: 'shop', agent: 'web', to: 'api', kind: 'task', title: 'T1' });
  store.updateRequest({ workspace: 'shop', agent: 'api', id: t1.id, action: 'claim' });

  // cannot reassign to request creator
  assert.equal(code(() => store.reassignRequest({ workspace: 'shop', id: t1.id, to: 'web' })), 'invalid');

  const updated = store.reassignRequest({ workspace: 'shop', id: t1.id, to: 'ops' });
  assert.equal(updated.to, 'ops');
  assert.equal(updated.status, 'open');
  assert.equal(updated.claimed_by, '');

  // terminal cannot be reassigned
  store.updateRequest({ workspace: 'shop', agent: 'ops', id: t1.id, action: 'claim' });
  store.updateRequest({ workspace: 'shop', agent: 'ops', id: t1.id, action: 'done', response: 'finished' });
  assert.equal(code(() => store.reassignRequest({ workspace: 'shop', id: t1.id, to: 'api' })), 'invalid_transition');
});

test('deleteEntry: removes entry and errors if missing', () => {
  const { store } = setup();
  store.writeEntry({ workspace: 'shop', agent: 'api', key: 'api.spec', kind: 'contract', title: 'Spec', body: '...' });

  const res = store.deleteEntry({ workspace: 'shop', key: 'api.spec' });
  assert.deepEqual(res, { ok: true, key: 'api.spec' });
  assert.equal(store.readEntry('shop', 'api.spec'), null);

  assert.equal(code(() => store.deleteEntry({ workspace: 'shop', key: 'api.missing' })), 'not_found');
});

test('forgetAgent: unclaims tasks, leaves addressed requests, no agent.joined', () => {
  const { store, clock } = setup();
  store.register({ workspace: 'shop', agent: 'ops' });
  const t1 = store.createRequest({ workspace: 'shop', agent: 'web', to: 'ops', kind: 'task', title: 'T1' });
  store.updateRequest({ workspace: 'shop', agent: 'ops', id: t1.id, action: 'claim' });

  // active agent requires force
  assert.equal(code(() => store.forgetAgent({ workspace: 'shop', agent: 'ops', force: false })), 'invalid');

  // with force: true
  const beforeCount = store.recentEvents('shop', 50).length;
  const res = store.forgetAgent({ workspace: 'shop', agent: 'ops', force: true });
  assert.deepEqual(res, { ok: true, agent: 'ops' });
  assert.equal(store.getAgent('shop', 'ops'), null);

  // t1 was unclaimed
  const req = store.getRequest('shop', t1.id);
  assert.equal(req.status, 'open');
  assert.equal(req.claimed_by, '');
  assert.equal(req.to, 'ops', 'requests addressed to forgotten agent stay');

  // no agent.joined was emitted by forgetAgent
  const allEvents = store.recentEvents('shop', 50);
  const emittedByForget = allEvents.slice(0, allEvents.length - beforeCount);
  assert.ok(!emittedByForget.some(e => e.type === 'agent.joined'));
});

test('clearWorkspace: removes all data for workspace', () => {
  const { store } = setup();
  store.writeEntry({ workspace: 'shop', agent: 'api', key: 'api.x', kind: 'note', title: 'X', body: 'x' });
  store.createRequest({ workspace: 'shop', agent: 'web', to: 'api', kind: 'question', title: 'Q' });

  const res = store.clearWorkspace({ workspace: 'shop' });
  assert.deepEqual(res, { ok: true, workspace: 'shop' });
  assert.equal(store.peers('shop').length, 0);
  assert.equal(store.listEntries('shop').length, 0);
  assert.equal(store.listRequests('shop', '', 'open').length, 0);
  assert.equal(store.recentEvents('shop').length, 0);
});

test('pruneEvents: respects live agent cursors and keepMin', () => {
  const { store, clock } = setup();
  for (let i = 0; i < 10; i++) {
    store.writeEntry({ workspace: 'shop', agent: 'api', key: `api.k${i}`, kind: 'note', title: `K${i}`, body: 'b' });
  }
  assert.equal(store.recentEvents('shop', 50).length >= 10, true);

  clock.advance(10 * 86_400_000);
  // keep api and web active so their cursors at 0 hold back pruning
  store.touch('shop', 'api');
  store.touch('shop', 'web');

  let p = store.pruneEvents({ workspace: 'shop', maxAgeMs: 5 * 86_400_000, keepMin: 2 });
  assert.equal(p.deleted, 0, 'held back by live agent cursors');

  // advance api and web cursors
  store.unread('shop', 'api', { advance: true });
  store.unread('shop', 'web', { advance: true });

  // now prune, keeping at least 3
  p = store.pruneEvents({ workspace: 'shop', maxAgeMs: 5 * 86_400_000, keepMin: 3 });
  assert.ok(p.deleted > 0);
  assert.ok(store.recentEvents('shop', 50).length >= 3);
});
