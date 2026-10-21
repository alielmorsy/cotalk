import http from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { timingSafeEqual } from 'node:crypto';
import { LttError, isRelevant, USER } from './store.js';
const MAX_BODY = 1024 * 1024;
const BAD_JSON = Symbol('bad json');
const DASHBOARD = readFileSync(new URL('./dashboard/index.html', import.meta.url));
const DASHBOARD_HEADERS = {
  'content-type': 'text/html; charset=utf-8',
  'content-security-policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:",
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
};
const NOT_SIGNED_IN_HTML = '<!doctype html><html><body><p>Not signed in. Run `ltt dashboard` and open the link it prints.</p></body></html>\n';
const DASHBOARD_DIR = fileURLToPath(new URL('./dashboard', import.meta.url));
const DASHBOARD_FILE_RE = /^[a-z0-9-]+\.(js|css)$/;

function serveStaticFile(res, pathname) {
  const filename = pathname.slice('/dashboard/'.length);
  if (!DASHBOARD_FILE_RE.test(filename)) {
    throw new LttError('invalid', 'file name must match /^[a-z0-9-]+\\.(js|css)$/');
  }
  const filePath = join(DASHBOARD_DIR, filename);
  if (!existsSync(filePath)) {
    throw new LttError('not_found', 'file not found');
  }
  const content = readFileSync(filePath);
  const contentType = filename.endsWith('.js')
    ? 'text/javascript; charset=utf-8'
    : 'text/css; charset=utf-8';
  res.writeHead(200, {
    'content-type': contentType,
    'x-content-type-options': 'nosniff',
  });
  res.end(content);
}

const same = (a, b) => typeof a === 'string' && a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

function send(res, status, data, headers = {}) {
  const body = data === undefined ? '' : JSON.stringify(data);
  res.writeHead(status, { ...(body ? { 'content-type': 'application/json' } : {}), ...headers });
  res.end(body);
}

// resolves to the raw body string, or null when it exceeds MAX_BODY (drained, not buffered)
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', c => { size += c.length; if (size <= MAX_BODY) chunks.push(c); });
    req.on('end', () => resolve(size > MAX_BODY ? null : Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

export function createServer({
  store,
  token,
  port,
  mcpFactory,
  onShutdown = () => {},
  version = '0.1.0',
  workers,
  roster,
  settings,
  usage,
  applySettings = () => {},
}) {
  const waiters = new Set();
  store.onEvent(e => {
    for (const w of waiters) if (isRelevant(e, w.workspace, w.agent, { urgentOnly: w.urgentOnly })) w.done('event');
  });

  function waitForEvent(workspace, agent, timeoutMs, { holder, urgentOnly = false, signal } = {}) {
    return new Promise(resolve => {
      if (holder) for (const w of waiters) if (w.holder === holder) w.done('superseded');
      const w = { workspace, agent, holder, urgentOnly };
      const timer = setTimeout(() => w.done('timeout'), timeoutMs);
      const onAbort = () => w.done('closed');
      w.done = (result) => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); waiters.delete(w); resolve(result); };
      waiters.add(w);
      if (signal?.aborted) onAbort();
      else signal?.addEventListener('abort', onAbort);
    });
  }

  const handleMcp = mcpFactory(waitForEvent);
  const allowedOrigins = [`http://127.0.0.1:${port}`, `http://localhost:${port}`];
  const getAllowedDirs = (ws) => store.peers(ws).map(p => p.cwd).filter(Boolean);

  const who = (url) => {
    const workspace = url.searchParams.get('workspace'), agent = url.searchParams.get('agent');
    if (!workspace || !agent) throw new LttError('invalid', 'workspace and agent query params are required');
    store.touch(workspace, agent);
    return { workspace, agent };
  };

  async function jsonBody(req, res) {
    const raw = await readBody(req);
    if (raw === null) { send(res, 413, { error: 'body too large' }); return undefined; }
    try { return JSON.parse(raw); } catch { return BAD_JSON; }
  }

  // JSON object body, or undefined when a response was already sent (413)
  async function objectBody(req, res) {
    const body = await jsonBody(req, res);
    if (body !== undefined && (!body || typeof body !== 'object' || Array.isArray(body))) throw new LttError('invalid', 'body must be a JSON object');
    return body;
  }

  const routes = {
    async 'POST /mcp'(req, res) {
      const msg = await jsonBody(req, res);
      if (msg === undefined) return;
      if (msg === BAD_JSON)
        return send(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } });
      if (msg === null || typeof msg !== 'object')
        return send(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'invalid request' } });
      if (Array.isArray(msg)) {
        const out = (await Promise.all(msg.map(m => handleMcp(m)))).filter(r => r !== null);
        return out.length ? send(res, 200, out) : send(res, 202);
      }
      const r = await handleMcp(msg);
      return r === null ? send(res, 202) : send(res, 200, r);
    },
    'GET /mcp': (req, res) => send(res, 405, { error: 'method not allowed' }, { allow: 'POST' }),
    'DELETE /mcp': (req, res) => send(res, 405, { error: 'method not allowed' }, { allow: 'POST' }),

    async 'POST /api/register'(req, res) {
      const body = await objectBody(req, res);
      if (body === undefined) return;
      const { workspace, agent, role, owns, cwd, tool, session_id } = body;
      const you = store.register({ workspace, agent, role, owns, cwd, tool, session_id });
      send(res, 200, {
        you, peers: store.peers(workspace), board: store.listEntries(workspace),
        incoming: store.listRequests(workspace, agent, 'incoming'), unread: store.unread(workspace, agent).summary,
      });
    },

    'GET /api/unread'(req, res, url) {
      const { workspace, agent } = who(url);
      const { summary, events } = url.searchParams.get('mode') === 'notify'
        ? store.notify(workspace, agent) : store.unread(workspace, agent);
      send(res, 200, { summary, events, incoming: store.listRequests(workspace, agent, 'incoming').length });
    },

    async 'GET /api/wait'(req, res, url) {
      const { workspace, agent } = who(url);
      const t = Number(url.searchParams.get('timeout') || 60);
      const ms = Math.min(1800, Math.max(1, Number.isFinite(t) ? t : 60)) * 1000;
      const urgentOnly = url.searchParams.get('urgent') === '1';
      if (store.pendingNotify(workspace, agent, { urgentOnly })) return send(res, 200, { result: 'event' });
      const ac = new AbortController();
      res.on('close', () => ac.abort()); // client gone: drop the waiter (no-op once answered, done() unhooks it)
      const result = await waitForEvent(workspace, agent, ms, { holder: url.searchParams.get('holder') || '', urgentOnly, signal: ac.signal });
      if (result !== 'closed') send(res, 200, { result });
    },

    // human actions: the HTTP API acts as `user`
    async 'POST /api/request'(req, res) {
      const body = await objectBody(req, res);
      if (body === undefined) return;
      const { workspace, to, kind, title, body: text, refs } = body;
      send(res, 200, { request: store.createRequest({ workspace, agent: USER, to, kind, title, body: text, refs }) });
    },

    async 'POST /api/respond'(req, res) {
      const body = await objectBody(req, res);
      if (body === undefined) return;
      const { workspace, id, response } = body;
      if (!Number.isInteger(id)) throw new LttError('invalid', 'id must be an integer');
      let { action } = body;
      if (action === undefined) {
        const r = store.getRequest(workspace, id);
        if (!r) throw new LttError('not_found', `no request #${id}`);
        action = r.kind === 'question' ? 'answer' : 'done';
      }
      send(res, 200, { request: store.updateRequest({ workspace, agent: USER, id, action, response }) });
    },

    async 'POST /api/cancel'(req, res) {
      const body = await objectBody(req, res);
      if (body === undefined) return;
      const { workspace, id } = body;
      if (!Number.isInteger(id)) throw new LttError('invalid', 'id must be an integer');
      send(res, 200, { request: store.cancelRequest({ workspace, id }) });
    },

    'GET /api/requests'(req, res, url) {
      const workspace = url.searchParams.get('workspace'), agent = url.searchParams.get('agent');
      if (!workspace || !agent) throw new LttError('invalid', 'workspace and agent query params are required');
      send(res, 200, { requests: store.listRequests(workspace, agent, url.searchParams.get('box') || 'incoming') });
    },

    'GET /api/state'(req, res) {
      send(res, 200, {
        workspaces: store.workspaces().map(ws => ({
          workspace: ws, peers: store.peers(ws), board: store.listEntries(ws),
          requests: store.listRequests(ws, '', 'open'), events: store.recentEvents(ws, 30),
          user: { incoming: store.listRequests(ws, USER, 'incoming'), outgoing: store.listRequests(ws, USER, 'outgoing') },
        })),
      });
    },

    'GET /events'(req, res) {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      res.flushHeaders();
      const off = store.onEvent(e => res.write(`data: ${JSON.stringify(e)}\n\n`));
      const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
      res.on('close', () => { off(); clearInterval(ping); });
    },

    'GET /api/entry'(req, res, url) {
      const workspace = url.searchParams.get('workspace'), key = url.searchParams.get('key');
      if (!workspace || !key) throw new LttError('invalid', 'workspace and key query params are required');
      const entry = store.readEntry(workspace, key);
      if (!entry) throw new LttError('not_found', `no entry ${key}`);
      send(res, 200, { entry });
    },

    async 'POST /api/entry/delete'(req, res) {
      const body = await objectBody(req, res);
      if (body === undefined) return;
      const { workspace, key } = body;
      send(res, 200, store.deleteEntry({ workspace, key, agent: USER }));
    },

    'GET /api/requests/history'(req, res, url) {
      const workspace = url.searchParams.get('workspace');
      if (!workspace) throw new LttError('invalid', 'workspace query param is required');
      const status = url.searchParams.get('status') || undefined;
      const kind = url.searchParams.get('kind') || undefined;
      const from = url.searchParams.get('from') || undefined;
      const to = url.searchParams.get('to') || undefined;
      const limitParam = url.searchParams.get('limit');
      const offsetParam = url.searchParams.get('offset');
      const limit = limitParam !== null ? Number(limitParam) : 50;
      const offset = offsetParam !== null ? Number(offsetParam) : 0;
      send(res, 200, store.queryRequests({ workspace, status, kind, from, to, limit, offset }));
    },

    async 'POST /api/requests/cancel'(req, res) {
      const body = await objectBody(req, res);
      if (body === undefined) return;
      const { workspace, ids } = body;
      send(res, 200, store.bulkCancelRequests({ workspace, ids, agent: USER }));
    },

    async 'POST /api/requests/reassign'(req, res) {
      const body = await objectBody(req, res);
      if (body === undefined) return;
      const { workspace, id, to } = body;
      send(res, 200, { request: store.reassignRequest({ workspace, id, to, agent: USER }) });
    },

    async 'POST /api/peers/forget'(req, res) {
      const body = await objectBody(req, res);
      if (body === undefined) return;
      const { workspace, agent, force } = body;
      send(res, 200, store.forgetAgent({ workspace, agent, force: force === true }));
    },

    async 'POST /api/workspace/clear'(req, res) {
      const body = await objectBody(req, res);
      if (body === undefined) return;
      const { workspace } = body;
      send(res, 200, store.clearWorkspace({ workspace, agent: USER }));
    },

    async 'GET /api/workers'(req, res, url) {
      const workspace = url.searchParams.get('workspace');
      if (!workspace) throw new LttError('invalid', 'workspace query param is required');
      const list = await workers.listWorkers({ workspace });
      send(res, 200, { workers: list });
    },

    async 'POST /api/workers/start'(req, res) {
      const body = await objectBody(req, res);
      if (body === undefined) return;
      const { workspace, name, role, owns, cwd, yolo } = body;
      if (!workspace) throw new LttError('invalid', 'workspace is required');
      const allowedDirs = getAllowedDirs(workspace);
      const worker = await workers.startWorker({ workspace, name, role, owns, cwd, yolo, allowedDirs });
      send(res, 200, { ok: true, worker });
    },

    async 'POST /api/workers/stop'(req, res) {
      const body = await objectBody(req, res);
      if (body === undefined) return;
      const { workspace, name, force } = body;
      if (!workspace || !name) throw new LttError('invalid', 'workspace and name are required');
      const stopped = await workers.stopWorker({ workspace, name, force: force === true });
      send(res, 200, stopped);
    },

    async 'GET /api/workers/log'(req, res, url) {
      const workspace = url.searchParams.get('workspace'), name = url.searchParams.get('name');
      if (!workspace || !name) throw new LttError('invalid', 'workspace and name query params are required');
      const linesParam = url.searchParams.get('lines');
      const lines = linesParam !== null ? Number(linesParam) : 100;
      const log = await workers.tailLog({ workspace, name, lines });
      send(res, 200, log);
    },

    async 'GET /api/roster'(req, res, url) {
      const workspace = url.searchParams.get('workspace'), cwd = url.searchParams.get('cwd') || undefined;
      if (!workspace) throw new LttError('invalid', 'workspace query param is required');
      const allowedDirs = getAllowedDirs(workspace);
      const data = await roster.readRoster({ workspace, cwd, allowedDirs });
      send(res, 200, data);
    },

    async 'POST /api/roster'(req, res) {
      const body = await objectBody(req, res);
      if (body === undefined) return;
      const { workspace, cwd, agents } = body;
      if (!workspace) throw new LttError('invalid', 'workspace is required');
      const allowedDirs = getAllowedDirs(workspace);
      const result = await roster.writeRoster({ workspace, cwd, agents, allowedDirs });
      send(res, 200, result);
    },

    async 'GET /api/settings'(req, res) {
      const fileSettings = await settings.readSettings();
      const thresholds = store.getThresholds();
      send(res, 200, { settings: { ...fileSettings, ...thresholds } });
    },

    async 'POST /api/settings'(req, res) {
      const body = await objectBody(req, res);
      if (body === undefined) return;
      if (!body.settings || typeof body.settings !== 'object') throw new LttError('invalid', 'settings object is required');
      const updated = await settings.writeSettings(body.settings);
      try {
        await applySettings(updated);
      } catch {}
      send(res, 200, { ok: true, settings: updated });
    },

    async 'GET /api/usage'(req, res, url) {
      send(res, 200, await usage.getUsage({ fresh: url.searchParams.get('fresh') === '1' }));
    },

    'GET /'(req, res) { res.writeHead(200, DASHBOARD_HEADERS); res.end(DASHBOARD); },

    'POST /api/shutdown'(req, res) { send(res, 200, { ok: true }); onShutdown(); },
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    try {
      if (req.method === 'GET' && url.pathname === '/health')
        return send(res, 200, { ok: true, name: 'let-them-talk', version });
      if (req.headers.origin !== undefined && !allowedOrigins.includes(req.headers.origin))
        return send(res, 403, { error: 'forbidden origin' });

      // Reject path traversal attempting to escape /dashboard/
      if (req.url.startsWith('/dashboard/') && !url.pathname.startsWith('/dashboard/')) {
        throw new LttError('invalid', 'file name must match /^[a-z0-9-]+\\.(js|css)$/');
      }

      // Static dashboard assets require no token (A5, contract v3)
      if (req.method === 'GET' && url.pathname.startsWith('/dashboard/')) {
        return serveStaticFile(res, url.pathname);
      }

      // One-time dashboard login via link
      if (req.method === 'GET' && url.pathname === '/' && url.searchParams.has('token')) {
        if (same(url.searchParams.get('token'), token)) {
          res.writeHead(302, {
            'location': '/',
            'set-cookie': `ltt_token=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000`,
          });
          return res.end();
        }
        res.writeHead(401, DASHBOARD_HEADERS);
        return res.end(NOT_SIGNED_IN_HTML);
      }

      const cookieToken = req.headers.cookie?.match(/(?:^|;\s*)ltt_token=([^;]+)/)?.[1];
      const authenticated = same(req.headers['x-ltt-token'], token) || same(cookieToken, token);
      if (!authenticated) {
        if (req.method === 'GET' && url.pathname === '/') {
          res.writeHead(401, DASHBOARD_HEADERS);
          return res.end(NOT_SIGNED_IN_HTML);
        }
        return send(res, 401, { error: 'unauthorized' });
      }

      const route = routes[`${req.method} ${url.pathname}`];
      if (!route) return send(res, 404, { error: 'not found' });
      await route(req, res, url);
    } catch (err) {
      if (res.headersSent) return res.destroy();
      if (err instanceof LttError) send(res, 400, { error: `${err.code}: ${err.message}` });
      else send(res, 500, { error: err.message });
    }
  });
  server.requestTimeout = 0;
  server.headersTimeout = 60_000;
  return { server, waitForEvent, waiterCount: () => waiters.size };
}
