import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { openStore } from '../daemon/store.js';
import { createServer } from '../daemon/server.js';

async function setup(t, { workers, roster, settings, applySettings, usage } = {}) {
  const store = openStore(':memory:');
  let shutdown = 0;
  const defaultApplySettings = (s) => {
    store.setThresholds({ activeMs: s?.activeMs, idleMs: s?.idleMs });
    store.pruneEvents({
      maxAgeMs: (s?.eventRetentionDays ?? 7) * 86_400_000,
      keepMin: s?.eventRetentionKeepMin ?? 200,
    });
  };
  const { server, waitForEvent, waiterCount } = createServer({
    store, token: 'tok', port: 0, onShutdown: () => shutdown++,
    workers, roster, settings, usage,
    applySettings: applySettings ?? defaultApplySettings,
    mcpFactory: () => async (m) => (m.id === undefined ? null : { jsonrpc: '2.0', id: m.id, result: { echo: m.method } }),
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(() => { server.closeAllConnections?.(); server.close(); store.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const req = (path, { method = 'GET', body, token = 'tok', headers = {} } = {}) =>
    fetch(base + path, { method, headers: { 'content-type': 'application/json', ...(token ? { 'x-ltt-token': token } : {}), ...headers }, body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)) });
  const rawReq = (path, { method = 'GET', headers = {} } = {}) =>
    new Promise((resolve, reject) => {
      const r = http.request({ host: '127.0.0.1', port: server.address().port, path, method, headers }, (res) => {
        let body = '';
        res.on('data', chunk => { body += chunk; });
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: () => Promise.resolve(body) }));
      });
      r.on('error', reject);
      r.end();
    });
  return { store, server, waitForEvent, waiterCount, base, req, rawReq, shutdowns: () => shutdown };
}

test('health needs no auth; everything else does', async (t) => {
  const { req, base } = await setup(t);
  const h = await req('/health', { token: null });
  assert.equal((await h.json()).name, 'let-them-talk');
  assert.equal((await req('/api/state', { token: null })).status, 401);
  assert.equal((await req('/api/state', { token: 'nope' })).status, 401);
  assert.equal((await req('/api/state?token=tok', { token: null })).status, 401, 'query token rejected on /api');
  const loginRes = await fetch(`${base}/?token=tok`, { redirect: 'manual' });
  assert.equal(loginRes.status, 302);
  assert.equal(loginRes.headers.get('location'), '/');
  assert.match(loginRes.headers.get('set-cookie'), /^ltt_token=tok; HttpOnly; SameSite=Strict; Path=\/; Max-Age=31536000/);
  const badLogin = await fetch(`${base}/?token=bad`, { redirect: 'manual' });
  assert.equal(badLogin.status, 401);
  assert.match(badLogin.headers.get('content-type'), /text\/html/);
  assert.match(await badLogin.text(), /Not signed in/);
  const noAuth = await req('/', { token: null });
  assert.equal(noAuth.status, 401);
  assert.match(noAuth.headers.get('content-type'), /text\/html/);
  assert.match(await noAuth.text(), /Not signed in/);
});

test('foreign Origin rejected', async (t) => {
  const { req } = await setup(t);
  assert.equal((await req('/api/state', { headers: { origin: 'http://evil.example' } })).status, 403);
});

test('requestTimeout disabled for long polls', async (t) => {
  const { server } = await setup(t);
  assert.equal(server.requestTimeout, 0);
});

test('/mcp: single, batch, notification-only, parse error, GET 405', async (t) => {
  const { req } = await setup(t);
  const one = await req('/mcp', { method: 'POST', body: { jsonrpc: '2.0', id: 1, method: 'ping' } });
  assert.deepEqual(await one.json(), { jsonrpc: '2.0', id: 1, result: { echo: 'ping' } });
  const batch = await req('/mcp', { method: 'POST', body: [{ jsonrpc: '2.0', id: 1, method: 'a' }, { jsonrpc: '2.0', method: 'n' }] });
  assert.deepEqual((await batch.json()).map(r => r.id), [1]);
  assert.equal((await req('/mcp', { method: 'POST', body: { jsonrpc: '2.0', method: 'n' } })).status, 202);
  const bad = await req('/mcp', { method: 'POST', body: '{nope' });
  assert.equal(bad.status, 400);
  assert.equal((await bad.json()).error.code, -32700);
  const get = await req('/mcp');
  assert.equal(get.status, 405);
  assert.equal(get.headers.get('allow'), 'POST');
  assert.equal((await req('/mcp', { method: 'POST', body: 'x'.repeat(1_100_000) })).status, 413);
});

test('register, unread peek vs notify, state', async (t) => {
  const { req, store } = await setup(t);
  const r = await (await req('/api/register', { method: 'POST', body: { workspace: 'shop', agent: 'api', role: 'REST', tool: 'claude', session_id: 's1' } })).json();
  assert.equal(r.you.agent, 'api');
  await req('/api/register', { method: 'POST', body: { workspace: 'shop', agent: 'web' } });
  store.createRequest({ workspace: 'shop', agent: 'web', to: 'api', kind: 'question', title: 'Q' });
  const peek = await (await req('/api/unread?workspace=shop&agent=api&mode=peek')).json();
  assert.equal(peek.summary.total, 2);
  assert.equal(peek.incoming, 1);
  const n1 = await (await req('/api/unread?workspace=shop&agent=api&mode=notify')).json();
  assert.equal(n1.summary.questions, 1);
  const n2 = await (await req('/api/unread?workspace=shop&agent=api&mode=notify')).json();
  assert.equal(n2.summary.total, 0);
  const state = await (await req('/api/state')).json();
  assert.equal(state.workspaces[0].workspace, 'shop');
  assert.equal(state.workspaces[0].requests.length, 1);
  assert.equal((await req('/api/unread?workspace=shop')).status, 400);
  const bad = await req('/api/register', { method: 'POST', body: { workspace: 'bad name', agent: 'x' } });
  assert.equal(bad.status, 400);
  assert.match((await bad.json()).error, /^invalid/);
});

test('wait resolves on relevant event, immediate when pending', async (t) => {
  const { req, store } = await setup(t);
  store.register({ workspace: 'shop', agent: 'api' });
  store.register({ workspace: 'shop', agent: 'web' });
  store.notify('shop', 'api');
  const pending = req('/api/wait?workspace=shop&agent=api&timeout=10&urgent=1').then(r => r.json());
  await new Promise(r => setTimeout(r, 100));
  store.writeEntry({ workspace: 'shop', agent: 'web', key: 'web.x', kind: 'note', title: 'X', body: 'x' }); // not urgent
  store.createRequest({ workspace: 'shop', agent: 'web', to: 'api', kind: 'task', title: 'T' });
  assert.deepEqual(await pending, { result: 'event' });
  const again = await (await req('/api/wait?workspace=shop&agent=api&timeout=10&urgent=1')).json();
  assert.deepEqual(again, { result: 'event' }, 'still un-notified, so immediate');
});

test('holder supersedes and timeout', async (t) => {
  const { waitForEvent, store } = await setup(t);
  store.register({ workspace: 'shop', agent: 'api' });
  const first = waitForEvent('shop', 'api', 5000, { holder: 'sess' });
  const second = waitForEvent('shop', 'api', 50, { holder: 'sess' });
  assert.equal(await first, 'superseded');
  assert.equal(await second, 'timeout');
});

test('wait: client disconnect removes the waiter; aborted signal resolves closed', async (t) => {
  const { base, store, waitForEvent, waiterCount } = await setup(t);
  store.register({ workspace: 'shop', agent: 'api' });
  store.notify('shop', 'api');
  const ctrl = new AbortController();
  const pending = fetch(`${base}/api/wait?workspace=shop&agent=api&timeout=60`, { headers: { 'x-ltt-token': 'tok' }, signal: ctrl.signal }).catch(() => {});
  for (let i = 0; i < 50 && waiterCount() === 0; i++) await new Promise(r => setTimeout(r, 20));
  assert.equal(waiterCount(), 1);
  ctrl.abort();
  await pending;
  for (let i = 0; i < 50 && waiterCount() > 0; i++) await new Promise(r => setTimeout(r, 20));
  assert.equal(waiterCount(), 0, 'waiter removed on disconnect');
  const ac = new AbortController();
  const w = waitForEvent('shop', 'api', 60_000, { signal: ac.signal });
  ac.abort();
  assert.equal(await w, 'closed');
  assert.equal(waiterCount(), 0);
});

test('SSE streams events', async (t) => {
  const { base, store } = await setup(t);
  const ctrl = new AbortController();
  t.after(() => ctrl.abort());

  // query token on /events rejected
  const bad = await fetch(`${base}/events?token=tok`, { signal: ctrl.signal });
  assert.equal(bad.status, 401);

  // cookie connects to SSE
  const res = await fetch(`${base}/events`, { headers: { cookie: 'ltt_token=tok' }, signal: ctrl.signal });
  assert.equal(res.headers.get('content-type'), 'text/event-stream');
  const reader = res.body.getReader();
  store.register({ workspace: 'shop', agent: 'api' });
  let buf = '';
  while (!buf.includes('\n\n')) buf += new TextDecoder().decode((await reader.read()).value);
  assert.equal(JSON.parse(buf.replace(/^data: /, '').trim()).type, 'agent.joined');
});

test('dashboard served and never uses innerHTML', async (t) => {
  const { req } = await setup(t);
  const r = await req('/', { headers: { cookie: 'ltt_token=tok' }, token: null });
  assert.match(r.headers.get('content-type'), /text\/html/);
  assert.equal(r.headers.get('content-security-policy'), "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:");
  assert.equal(r.headers.get('referrer-policy'), 'no-referrer');
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  const html = readFileSync(new URL('../daemon/dashboard/index.html', import.meta.url), 'utf8');
  assert.doesNotMatch(html, /innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
  assert.match(html, /<script type="module" src="\/dashboard\/app\.js"><\/script>/);
});

test('static assets /dashboard/:file served without auth', async (t) => {
  const { req, rawReq } = await setup(t);
  const js = await req('/dashboard/app.js', { token: null });
  assert.equal(js.status, 200);
  assert.equal(js.headers.get('content-type'), 'text/javascript; charset=utf-8');
  assert.equal(js.headers.get('x-content-type-options'), 'nosniff');

  const css = await req('/dashboard/app.css', { token: null });
  assert.equal(css.status, 200);
  assert.equal(css.headers.get('content-type'), 'text/css; charset=utf-8');
  assert.equal(css.headers.get('x-content-type-options'), 'nosniff');

  const sub = await req('/dashboard/sub/file.js', { token: null });
  assert.equal(sub.status, 400);
  assert.match((await sub.json()).error, /^invalid/);

  const dots = await req('/dashboard/foo..bar.js', { token: null });
  assert.equal(dots.status, 400);
  assert.match((await dots.json()).error, /^invalid/);

  const badExt = await req('/dashboard/index.html', { token: null });
  assert.equal(badExt.status, 400);
  assert.match((await badExt.json()).error, /^invalid/);

  const missing = await req('/dashboard/missing.js', { token: null });
  assert.equal(missing.status, 400);
  assert.match((await missing.json()).error, /^not_found/);

  // static traversal vectors: 400 and never file contents
  const traversalVectors = [
    '%2e%2e/server.js',
    '%2E%2E/%2E%2E/package.json',
    '..%2fserver.js',
    '..\\\\server.js',
    'APP.JS',
    'app.js%00.css',
  ];
  for (const v of traversalVectors) {
    const res = await rawReq('/dashboard/' + v);
    assert.equal(res.status, 400, `vector ${v} should return 400`);
    const text = await res.text();
    assert.equal(text.includes('createServer'), false, `vector ${v} must not leak server.js`);
    assert.equal(text.includes('let-them-talk'), false, `vector ${v} must not leak package.json`);
  }
});

test('board routes: GET /api/entry and POST /api/entry/delete', async (t) => {
  const { req, store } = await setup(t);
  store.register({ workspace: 'shop', agent: 'api' });
  store.writeEntry({ workspace: 'shop', agent: 'api', key: 'api.users', kind: 'contract', title: 'Users API', body: '# Users' });

  const ok = await (await req('/api/entry?workspace=shop&key=api.users')).json();
  assert.equal(ok.entry.key, 'api.users');
  assert.equal(ok.entry.body, '# Users');

  const miss = await req('/api/entry?workspace=shop&key=api.missing');
  assert.equal(miss.status, 400);
  assert.match((await miss.json()).error, /^not_found/);

  const del = await (await req('/api/entry/delete', { method: 'POST', body: { workspace: 'shop', key: 'api.users' } })).json();
  assert.deepEqual(del, { ok: true, key: 'api.users' });
  assert.equal(store.readEntry('shop', 'api.users'), null);
});

test('requests: history, cancel, reassign', async (t) => {
  const { req, store } = await setup(t);
  store.register({ workspace: 'shop', agent: 'api' });
  store.register({ workspace: 'shop', agent: 'web' });
  store.register({ workspace: 'shop', agent: 'ops' });
  const q1 = store.createRequest({ workspace: 'shop', agent: 'web', to: 'api', kind: 'question', title: 'Q1' });
  const t1 = store.createRequest({ workspace: 'shop', agent: 'web', to: 'api', kind: 'task', title: 'T1' });
  store.updateRequest({ workspace: 'shop', agent: 'api', id: q1.id, action: 'answer', response: 'done' });

  const hist = await (await req('/api/requests/history?workspace=shop&status=open')).json();
  assert.equal(hist.total, 1);
  assert.equal(hist.requests[0].id, t1.id);

  // cannot reassign to creator
  const selfReass = await req('/api/requests/reassign', { method: 'POST', body: { workspace: 'shop', id: t1.id, to: 'web' } });
  assert.equal(selfReass.status, 400);
  assert.match((await selfReass.json()).error, /^invalid/);

  const reass = await (await req('/api/requests/reassign', { method: 'POST', body: { workspace: 'shop', id: t1.id, to: 'ops' } })).json();
  assert.equal(reass.request.to, 'ops');
  assert.equal(reass.request.status, 'open');

  const cancel = await (await req('/api/requests/cancel', { method: 'POST', body: { workspace: 'shop', ids: [t1.id, q1.id, 999] } })).json();
  assert.deepEqual(cancel.cancelled, [t1.id]);
  assert.equal(cancel.skipped.length, 2);
});

test('peers forget and workspace clear', async (t) => {
  const { req, store } = await setup(t);
  store.register({ workspace: 'shop', agent: 'api' });
  store.register({ workspace: 'shop', agent: 'web' });

  // active agent without force
  const fail = await req('/api/peers/forget', { method: 'POST', body: { workspace: 'shop', agent: 'web' } });
  assert.equal(fail.status, 400);
  assert.match((await fail.json()).error, /^invalid/);

  // string "false" must not force
  const failStr = await req('/api/peers/forget', { method: 'POST', body: { workspace: 'shop', agent: 'web', force: 'false' } });
  assert.equal(failStr.status, 400);
  assert.match((await failStr.json()).error, /^invalid/);

  // with force: true
  const f = await (await req('/api/peers/forget', { method: 'POST', body: { workspace: 'shop', agent: 'web', force: true } })).json();
  assert.deepEqual(f, { ok: true, agent: 'web' });
  assert.equal(store.getAgent('shop', 'web'), null);

  const clear = await (await req('/api/workspace/clear', { method: 'POST', body: { workspace: 'shop' } })).json();
  assert.deepEqual(clear, { ok: true, workspace: 'shop' });
  assert.equal(store.peers('shop').length, 0);
});

test('ops routes: workers, roster, settings via DI', async (t) => {
  const recorded = {
    workers: {},
    roster: {},
    settings: {},
  };
  const mockWorkers = {
    listWorkers: async (args) => { recorded.workers.listWorkers = args; return [{ name: 'w1', workspace: args.workspace, pid: 123, alive: true, logFile: 'w1.log' }]; },
    startWorker: async (args) => { recorded.workers.startWorker = args; return { name: args.name, workspace: args.workspace, pid: 456 }; },
    stopWorker: async (args) => { recorded.workers.stopWorker = args; return { ok: true, name: args.name, stopped: true, force: args.force }; },
    tailLog: async (args) => { recorded.workers.tailLog = args; return { name: args.name, lines: ['log line 1'], total: 1 }; },
  };
  const mockRoster = {
    readRoster: async (args) => { recorded.roster.readRoster = args; return { path: '/repo/.ltt.json', format: 'multi', workspace: args.workspace, agents: [] }; },
    writeRoster: async (args) => { recorded.roster.writeRoster = args; return { ok: true, path: '/repo/.ltt.json', count: 1 }; },
  };
  const mockSettings = {
    readSettings: async () => ({ activeMs: 120_000, idleMs: 1_800_000, eventRetentionDays: 7, eventRetentionKeepMin: 200 }),
    writeSettings: async (s) => ({ activeMs: 60_000, idleMs: 600_000, eventRetentionDays: 14, eventRetentionKeepMin: 300, ...s }),
  };

  const { req, store } = await setup(t, { workers: mockWorkers, roster: mockRoster, settings: mockSettings });
  store.register({ workspace: 'shop', agent: 'api', cwd: 'E:/works' });

  // workers
  const wList = await (await req('/api/workers?workspace=shop')).json();
  assert.equal(wList.workers[0].name, 'w1');
  assert.equal(recorded.workers.listWorkers.workspace, 'shop');

  const wStart = await (await req('/api/workers/start', { method: 'POST', body: { workspace: 'shop', name: 'w2', cwd: 'E:/works', pid: 9999, allowedDirs: ['/evil/dir'] } })).json();
  assert.equal(wStart.worker.name, 'w2');
  assert.deepEqual(recorded.workers.startWorker.allowedDirs, ['E:/works'], 'allowedDirs matches registered peer cwds and body allowedDirs is ignored');
  assert.equal(recorded.workers.startWorker.pid, undefined, 'body-supplied pid is ignored');

  const wStop = await (await req('/api/workers/stop', { method: 'POST', body: { workspace: 'shop', name: 'w1', force: 'false' } })).json();
  assert.equal(wStop.stopped, true);
  assert.equal(recorded.workers.stopWorker.force, false, 'string "false" must not force');

  const wLog = await (await req('/api/workers/log?workspace=shop&name=w1')).json();
  assert.equal(wLog.lines[0], 'log line 1');

  // roster
  const rRead = await (await req('/api/roster?workspace=shop')).json();
  assert.equal(rRead.format, 'multi');
  assert.deepEqual(recorded.roster.readRoster.allowedDirs, ['E:/works'], 'readRoster receives allowedDirs matching peer cwds');

  const rWrite = await (await req('/api/roster', { method: 'POST', body: { workspace: 'shop', agents: [], allowedDirs: ['/evil/dir'] } })).json();
  assert.equal(rWrite.ok, true);
  assert.deepEqual(recorded.roster.writeRoster.allowedDirs, ['E:/works'], 'writeRoster receives allowedDirs matching peer cwds and body allowedDirs is ignored');

  // settings
  const sGet = await (await req('/api/settings')).json();
  assert.equal(sGet.settings.eventRetentionDays, 7);

  const sPost = await (await req('/api/settings', { method: 'POST', body: { settings: { activeMs: 40_000, idleMs: 700_000, eventRetentionDays: 14 } } })).json();
  assert.equal(sPost.settings.eventRetentionDays, 14);
  assert.deepEqual(store.getThresholds(), { activeMs: 40_000, idleMs: 700_000 }, 'POST /api/settings changes store.getThresholds()');
});

test('auth: loop over every new /api route rejects without token (401) and foreign origin (403)', async (t) => {
  const mockWorkers = {
    listWorkers: async () => [],
    startWorker: async () => ({}),
    stopWorker: async () => ({ ok: true }),
    tailLog: async () => ({ lines: [] }),
  };
  const mockRoster = {
    readRoster: async () => ({}),
    writeRoster: async () => ({ ok: true }),
  };
  const mockSettings = {
    readSettings: async () => ({}),
    writeSettings: async () => ({}),
  };
  const { req } = await setup(t, { workers: mockWorkers, roster: mockRoster, settings: mockSettings });

  const newApiRoutes = [
    { method: 'GET', path: '/api/entry?workspace=shop&key=k' },
    { method: 'POST', path: '/api/entry/delete', body: { workspace: 'shop', key: 'k' } },
    { method: 'GET', path: '/api/requests/history?workspace=shop' },
    { method: 'POST', path: '/api/requests/cancel', body: { workspace: 'shop', ids: [1] } },
    { method: 'POST', path: '/api/requests/reassign', body: { workspace: 'shop', id: 1, to: 'api' } },
    { method: 'POST', path: '/api/peers/forget', body: { workspace: 'shop', agent: 'web' } },
    { method: 'POST', path: '/api/workspace/clear', body: { workspace: 'shop' } },
    { method: 'GET', path: '/api/workers?workspace=shop' },
    { method: 'POST', path: '/api/workers/start', body: { workspace: 'shop', name: 'w1' } },
    { method: 'POST', path: '/api/workers/stop', body: { workspace: 'shop', name: 'w1' } },
    { method: 'GET', path: '/api/workers/log?workspace=shop&name=w1' },
    { method: 'GET', path: '/api/roster?workspace=shop' },
    { method: 'POST', path: '/api/roster', body: { workspace: 'shop' } },
    { method: 'GET', path: '/api/settings' },
    { method: 'POST', path: '/api/settings', body: { settings: {} } },
  ];

  for (const r of newApiRoutes) {
    const noToken = await req(r.path, { method: r.method, body: r.body, token: null });
    assert.equal(noToken.status, 401, `${r.method} ${r.path} without token must return 401`);

    const evilOrigin = await req(r.path, { method: r.method, body: r.body, headers: { origin: 'http://evil.com' } });
    assert.equal(evilOrigin.status, 403, `${r.method} ${r.path} with foreign origin must return 403`);
  }

  assert.equal((await req('/', { token: null })).status, 401, 'GET / without token must return 401');
});

test('shutdown calls hook', async (t) => {
  const { req, shutdowns } = await setup(t);
  assert.equal((await req('/api/shutdown', { method: 'POST' })).status, 200);
  assert.equal(shutdowns(), 1);
});

test('dashboard cookie auth (lead.dashboard.cookie)', async (t) => {
  const { req, base } = await setup(t);

  // 1. Login link sets the cookie and redirects (302)
  const login = await fetch(`${base}/?token=tok`, { redirect: 'manual' });
  assert.equal(login.status, 302);
  assert.equal(login.headers.get('location'), '/');
  assert.match(login.headers.get('set-cookie'), /^ltt_token=tok; HttpOnly; SameSite=Strict; Path=\/; Max-Age=31536000/);

  // 2. Cookie alone authorizes GET /, /api/state, POST route, and /events
  const dash = await req('/', { headers: { cookie: 'ltt_token=tok' }, token: null });
  assert.equal(dash.status, 200);
  assert.match(dash.headers.get('content-type'), /text\/html/);

  const stateRes = await req('/api/state', { headers: { cookie: 'ltt_token=tok' }, token: null });
  assert.equal(stateRes.status, 200);
  assert.ok((await stateRes.json()).workspaces);

  const postRes = await req('/api/requests/cancel', { method: 'POST', body: { workspace: 'shop', ids: [999] }, headers: { cookie: 'ltt_token=tok' }, token: null });
  assert.equal(postRes.status, 200);

  const ac = new AbortController();
  t.after(() => ac.abort());
  const evRes = await fetch(`${base}/events`, { headers: { cookie: 'ltt_token=tok' }, signal: ac.signal });
  assert.equal(evRes.status, 200);
  assert.equal(evRes.headers.get('content-type'), 'text/event-stream');

  // 3. Wrong cookie -> 401
  const badApi = await req('/api/state', { headers: { cookie: 'ltt_token=wrong' }, token: null });
  assert.equal(badApi.status, 401);

  const badDash = await req('/', { headers: { cookie: 'ltt_token=wrong' }, token: null });
  assert.equal(badDash.status, 401);
  assert.match(badDash.headers.get('content-type'), /text\/html/);

  // 4. Cross-origin POST with cookie -> 403
  const evilPost = await req('/api/requests/cancel', { method: 'POST', body: { workspace: 'shop', ids: [999] }, headers: { cookie: 'ltt_token=tok', origin: 'http://evil.com' }, token: null });
  assert.equal(evilPost.status, 403);

  // 5. Header token still works
  const hdrGet = await req('/api/state', { token: 'tok' });
  assert.equal(hdrGet.status, 200);
  const hdrPost = await req('/api/requests/cancel', { method: 'POST', body: { workspace: 'shop', ids: [999] }, token: 'tok' });
  assert.equal(hdrPost.status, 200);

  // 6. /events?token= no longer accepted
  const evQuery = await fetch(`${base}/events?token=tok`, { signal: ac.signal });
  assert.equal(evQuery.status, 401);
});

test('GET /api/usage: authenticated, passes fresh=1 to the usage source', async (t) => {
  const calls = [];
  const snapshot = { at: '2026-09-30T12:00:00.000Z', agy: { ok: true, windows: [] }, claude: { ok: false, error: 'claude not found' } };
  const { req } = await setup(t, { usage: { getUsage: async (o) => { calls.push(o); return snapshot; } } });
  assert.equal((await req('/api/usage', { token: null })).status, 401);
  const r = await req('/api/usage');
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), snapshot);
  await req('/api/usage?fresh=1');
  assert.deepEqual(calls, [{ fresh: false }, { fresh: true }]);
});
