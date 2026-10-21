import { DatabaseSync } from 'node:sqlite';
import { URGENT_TYPES, summarize } from '../lib/format.js';

export class LttError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

export const USER = 'user'; // the human: never registered, can be a request's `to`, acts via the HTTP API
const isUser = (v) => typeof v === 'string' && v.toLowerCase() === USER; // names differ only by case => same person to a reader
const NAME = /^[a-z0-9][a-z0-9_-]{0,31}$/i;
const KEY = /^[a-z0-9][a-z0-9_.-]{0,127}$/i;
const ACTIVE_MS = 2 * 60_000, IDLE_MS = 30 * 60_000;
const ENTRY_KINDS = ['contract', 'decision', 'note'];
const REQUEST_KINDS = ['question', 'task'];
const MAX_TITLE = 200, MAX_BODY = 100_000;

export function isRelevant(e, workspace, agent, { urgentOnly = false } = {}) {
  return e.workspace === workspace && e.actor !== agent &&
    (e.target === null || e.target === agent) &&
    (!urgentOnly || URGENT_TYPES.includes(e.type));
}

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA busy_timeout = 3000;
CREATE TABLE IF NOT EXISTS agents (
  workspace TEXT NOT NULL, agent TEXT NOT NULL, role TEXT NOT NULL DEFAULT '',
  owns TEXT NOT NULL DEFAULT '[]', cwd TEXT NOT NULL DEFAULT '', tool TEXT NOT NULL DEFAULT '',
  session_id TEXT NOT NULL DEFAULT '', last_seen INTEGER NOT NULL,
  cursor INTEGER NOT NULL DEFAULT 0, notified_cursor INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (workspace, agent));
CREATE TABLE IF NOT EXISTS entries (
  workspace TEXT NOT NULL, key TEXT NOT NULL, author TEXT NOT NULL, kind TEXT NOT NULL,
  title TEXT NOT NULL, body TEXT NOT NULL, version INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  PRIMARY KEY (workspace, key));
CREATE TABLE IF NOT EXISTS requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT, workspace TEXT NOT NULL, kind TEXT NOT NULL,
  from_agent TEXT NOT NULL, to_agent TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL,
  refs TEXT NOT NULL, status TEXT NOT NULL, claimed_by TEXT NOT NULL DEFAULT '',
  response TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT, workspace TEXT NOT NULL, type TEXT NOT NULL,
  actor TEXT NOT NULL, target TEXT, ref_id TEXT NOT NULL, summary TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS events_ws ON events (workspace, id);
CREATE INDEX IF NOT EXISTS requests_ws_status_id ON requests (workspace, status, id);
`;

// ---- validation ----
const invalid = (msg) => { throw new LttError('invalid', msg); };
function name(v, field) {
  if (typeof v !== 'string' || !NAME.test(v)) invalid(`${field} must match ${NAME}`);
  return v;
}
// returns undefined when missing; callers apply their own default
function text(v, field, max, { required = false } = {}) {
  if (v === undefined || v === null) {
    if (required) invalid(`${field} is required`);
    return undefined;
  }
  if (typeof v !== 'string') invalid(`${field} must be a string`);
  if (required && !v.length) invalid(`${field} must not be empty`);
  if (v.length > max) invalid(`${field} must be <= ${max} chars`);
  return v;
}
function strArray(v, field) {
  if (!Array.isArray(v) || v.some(x => typeof x !== 'string' || x.length > 1000) || v.length > 200)
    invalid(`${field} must be an array of strings`);
  return v;
}
function oneOf(v, list, field) {
  if (!list.includes(v)) invalid(`${field} must be one of ${list.join('|')}`);
  return v;
}

export function openStore(dbPath, { now = Date.now } = {}) {
  const db = new DatabaseSync(dbPath);
  db.exec(SCHEMA);
  const listeners = new Set();
  let pending = [];

  let currentActiveMs = ACTIVE_MS;
  let currentIdleMs = IDLE_MS;

  const q = (sql) => db.prepare(sql);
  const plain = (row) => (row ? { ...row } : null);

  const statusOf = (lastSeen) => {
    const age = now() - lastSeen;
    return age < currentActiveMs ? 'active' : age < currentIdleMs ? 'idle' : 'offline';
  };
  const getThresholds = () => ({ activeMs: currentActiveMs, idleMs: currentIdleMs });
  const setThresholds = ({ activeMs, idleMs } = {}) => {
    if (typeof activeMs === 'number' && Number.isFinite(activeMs) && activeMs > 0) currentActiveMs = activeMs;
    if (typeof idleMs === 'number' && Number.isFinite(idleMs) && idleMs > 0) currentIdleMs = idleMs;
  };
  const toAgent = (r) => r && ({
    workspace: r.workspace, agent: r.agent, role: r.role, owns: JSON.parse(r.owns), cwd: r.cwd,
    tool: r.tool, session_id: r.session_id, last_seen: r.last_seen, status: statusOf(r.last_seen),
  });
  const toEntry = (r, withBody = true) => {
    if (!r) return null;
    const e = { key: r.key, kind: r.kind, title: r.title, author: r.author, version: r.version, updated_at: r.updated_at };
    if (withBody) e.body = r.body;
    return e;
  };
  const toRequest = (r) => r && ({
    id: r.id, kind: r.kind, from: r.from_agent, to: r.to_agent, title: r.title, body: r.body,
    refs: JSON.parse(r.refs), status: r.status, claimed_by: r.claimed_by, response: r.response,
    created_at: r.created_at, updated_at: r.updated_at,
  });

  function tx(fn) {
    db.exec('BEGIN');
    let result;
    try {
      result = fn();
      db.exec('COMMIT');
    } catch (err) {
      pending = [];
      try { db.exec('ROLLBACK'); } catch {}
      throw err;
    }
    const fired = pending; pending = [];
    for (const e of fired) for (const fn of listeners) { try { fn(e); } catch {} }
    return result;
  }

  function emit(workspace, type, actor, target, ref_id, summary) {
    const { lastInsertRowid } = q('INSERT INTO events (workspace, type, actor, target, ref_id, summary, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(workspace, type, actor, target, String(ref_id), summary, now());
    pending.push(plain(q('SELECT * FROM events WHERE id = ?').get(lastInsertRowid)));
  }

  const maxEventId = () => q('SELECT COALESCE(MAX(id), 0) AS m FROM events').get().m;
  const agentRow = (workspace, agent) => q('SELECT * FROM agents WHERE workspace = ? AND agent = ?').get(workspace, agent);

  function register({ workspace, agent, role, owns, cwd, tool, session_id } = {}) {
    name(workspace, 'workspace'); name(agent, 'agent');
    if (isUser(agent)) invalid('user is reserved for the human (in any case)');
    role = text(role, 'role', MAX_TITLE);
    if (owns !== undefined) strArray(owns, 'owns');
    cwd = text(cwd, 'cwd', 4096);
    tool = text(tool, 'tool', 64);
    session_id = text(session_id, 'session_id', 256);
    return tx(() => {
      const old = agentRow(workspace, agent);
      const t = now();
      if (!old) {
        const cur = maxEventId();
        q('INSERT INTO agents (workspace, agent, role, owns, cwd, tool, session_id, last_seen, cursor, notified_cursor) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
          .run(workspace, agent, role ?? '', JSON.stringify(owns ?? []), cwd ?? '', tool ?? '', session_id ?? '', t, cur, cur);
      } else {
        q('UPDATE agents SET role = ?, owns = ?, cwd = ?, tool = ?, session_id = ?, last_seen = ? WHERE workspace = ? AND agent = ?')
          .run(role ?? old.role, owns ? JSON.stringify(owns) : old.owns, cwd ?? old.cwd, tool ?? old.tool,
            session_id ?? old.session_id, t, workspace, agent);
      }
      if (!old || statusOf(old.last_seen) === 'offline') {
        const r = role ?? old?.role ?? '';
        emit(workspace, 'agent.joined', agent, null, agent, `${agent} joined (${r || 'no role'})`);
      }
      return toAgent(agentRow(workspace, agent));
    });
  }

  const getAgent = (workspace, agent) => toAgent(agentRow(workspace, agent)) ?? null;

  function writeEntry({ workspace, agent, key, kind, title, body } = {}) {
    name(workspace, 'workspace'); name(agent, 'agent');
    if (typeof key !== 'string' || !KEY.test(key)) invalid(`key must match ${KEY}`);
    oneOf(kind, ENTRY_KINDS, 'kind');
    text(title, 'title', MAX_TITLE, { required: true });
    body = text(body, 'body', MAX_BODY) ?? '';
    return tx(() => {
      const seg = key.split('.')[0];
      if (seg !== agent && agentRow(workspace, seg))
        throw new LttError('forbidden', `keys starting with "${seg}." belong to agent ${seg}`);
      const old = q('SELECT * FROM entries WHERE workspace = ? AND key = ?').get(workspace, key);
      if (old && old.author !== agent)
        throw new LttError('forbidden', `${key} is owned by ${old.author}`);
      const version = old ? old.version + 1 : 1;
      q('INSERT OR REPLACE INTO entries (workspace, key, author, kind, title, body, version, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(workspace, key, agent, kind, title, body, version, now());
      emit(workspace, 'entry.updated', agent, null, key, `${agent} updated ${key} v${version}: ${title}`);
      return readEntry(workspace, key);
    });
  }

  const readEntry = (workspace, key) =>
    toEntry(q('SELECT * FROM entries WHERE workspace = ? AND key = ?').get(workspace, key));

  function listEntries(workspace, prefix = '') {
    return q("SELECT * FROM entries WHERE workspace = ? AND substr(key, 1, length(?)) = ? ORDER BY key")
      .all(workspace, prefix, prefix).map(r => toEntry(r, false));
  }

  const requestRow = (workspace, id) => q('SELECT * FROM requests WHERE workspace = ? AND id = ?').get(workspace, id);
  const getRequest = (workspace, id) => toRequest(requestRow(workspace, id)) ?? null;

  function createRequest({ workspace, agent, to, kind, title, body = '', refs = [] } = {}) {
    name(workspace, 'workspace'); name(agent, 'agent');
    oneOf(kind, REQUEST_KINDS, 'kind');
    text(title, 'title', MAX_TITLE, { required: true });
    body = text(body, 'body', MAX_BODY) ?? '';
    strArray(refs, 'refs');
    if (isUser(to)) to = USER;
    if (to === agent) invalid('cannot send a request to yourself');
    if (to !== '*' && to !== USER) {
      name(to, 'to');
      if (!agentRow(workspace, to)) throw new LttError('not_found', `no agent ${to} in workspace ${workspace}`);
    }
    return tx(() => {
      const t = now();
      const { lastInsertRowid } = q('INSERT INTO requests (workspace, kind, from_agent, to_agent, title, body, refs, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(workspace, kind, agent, to, title, body, JSON.stringify(refs), 'open', t, t);
      const id = Number(lastInsertRowid);
      const summary = to === USER
        ? `${agent} asks you${kind === 'question' ? '' : ' to'}: ${title} (#${id})`
        : kind === 'question'
          ? `${agent} asks ${to}: ${title} (#${id})`
          : `${agent} assigns ${to} a task: ${title} (#${id})`;
      emit(workspace, `${kind}.new`, agent, to === '*' ? null : to, id, summary);
      return getRequest(workspace, id);
    });
  }

  const VERB = { done: 'finished', answer: 'answered', claim: 'claimed', reject: 'rejected' };

  function updateRequest({ workspace, agent, id, action, response = '' } = {}) {
    name(workspace, 'workspace'); name(agent, 'agent');
    oneOf(action, Object.keys(VERB), 'action');
    response = text(response, 'response', MAX_BODY) ?? '';
    return tx(() => {
      const r = toRequest(requestRow(workspace, id));
      if (!r) throw new LttError('not_found', `no request #${id}`);
      const mine = r.to === agent || (r.to === '*' && !isUser(agent)); // broadcasts are for agents
      const iClaimed = r.status === 'claimed' && r.claimed_by === agent;
      let set;
      if (action === 'claim' && r.kind === 'task' && r.status === 'open' && mine)
        set = { status: 'claimed', claimed_by: agent, response: r.response };
      else if (action === 'answer' && r.kind === 'question' && r.status === 'open' && mine)
        set = { status: 'answered', claimed_by: r.claimed_by, response };
      else if (action === 'done' && r.kind === 'task' && (iClaimed || (r.status === 'open' && r.to === agent)))
        set = { status: 'done', claimed_by: agent, response };
      else if (action === 'reject' && ((r.status === 'open' && mine) || iClaimed))
        set = { status: 'rejected', claimed_by: r.claimed_by, response };
      else
        throw new LttError('invalid_transition', `cannot ${action} #${id} (${r.kind}, ${r.status})`);
      q('UPDATE requests SET status = ?, claimed_by = ?, response = ?, updated_at = ? WHERE id = ?')
        .run(set.status, set.claimed_by, set.response, now(), r.id);
      // a claim needs no action from the requester: not urgent, so it never blocks a stop or wakes a session
      emit(workspace, action === 'claim' ? 'request.claimed' : 'request.updated', agent, r.from, r.id, `${agent} ${VERB[action]} #${r.id}: ${r.title}`);
      return getRequest(workspace, r.id);
    });
  }

  // human override: drop an open/claimed request whose agent is gone
  function cancelRequest({ workspace, id } = {}) {
    name(workspace, 'workspace');
    return tx(() => {
      const r = toRequest(requestRow(workspace, id));
      if (!r) throw new LttError('not_found', `no request #${id}`);
      if (r.status !== 'open' && r.status !== 'claimed')
        throw new LttError('invalid_transition', `cannot cancel #${id} (${r.kind}, ${r.status})`);
      q('UPDATE requests SET status = ?, updated_at = ? WHERE id = ?').run('cancelled', now(), r.id);
      emit(workspace, 'request.updated', USER, r.from, r.id, `${USER} cancelled #${r.id}: ${r.title}`);
      if (r.claimed_by && r.claimed_by !== r.from) {
        emit(workspace, 'request.updated', USER, r.claimed_by, r.id, `${USER} cancelled #${r.id}: ${r.title}`);
      }
      return getRequest(workspace, r.id);
    });
  }

  function listRequests(workspace, agent, box = 'incoming') {
    oneOf(box, ['incoming', 'outgoing', 'open'], 'box');
    const rows = box === 'incoming'
      ? q(`SELECT * FROM requests WHERE workspace = ? AND status IN ('open', 'claimed')
           AND (to_agent = ? OR (to_agent = '*' AND from_agent != ? AND lower(?) != '${USER}'))
           AND (status = 'open' OR claimed_by = ?) ORDER BY id`).all(workspace, agent, agent, agent, agent)
      : box === 'outgoing'
        ? q('SELECT * FROM requests WHERE workspace = ? AND from_agent = ? ORDER BY id DESC LIMIT 50').all(workspace, agent)
        : q("SELECT * FROM requests WHERE workspace = ? AND status IN ('open', 'claimed') ORDER BY id").all(workspace);
    return rows.map(toRequest);
  }

  // relevance in SQL, mirrors isRelevant
  const RELEVANT = 'workspace = ? AND id > ? AND actor != ? AND (target IS NULL OR target = ?)';
  const relevantEvents = (workspace, agent, after) =>
    q(`SELECT * FROM events WHERE ${RELEVANT} ORDER BY id`).all(workspace, after, agent, agent).map(plain);

  function readFrom(column, workspace, agent, advance) {
    const row = agentRow(workspace, agent);
    if (!row) return { events: [], summary: summarize([]) };
    const events = relevantEvents(workspace, agent, row[column]);
    if (advance && events.length) {
      const id = events.at(-1).id;
      q(`UPDATE agents SET ${column} = ? WHERE workspace = ? AND agent = ?`).run(id, workspace, agent);
      // already read (inbox) => never notify about it later
      q('UPDATE agents SET notified_cursor = MAX(notified_cursor, ?) WHERE workspace = ? AND agent = ?').run(id, workspace, agent);
    }
    return { events, summary: summarize(events) };
  }

  function pendingNotify(workspace, agent, { urgentOnly = false } = {}) {
    const row = agentRow(workspace, agent);
    if (!row) return false;
    const types = urgentOnly ? ` AND type IN (${URGENT_TYPES.map(() => '?').join(', ')})` : '';
    return !!q(`SELECT 1 FROM events WHERE ${RELEVANT}${types} LIMIT 1`)
      .get(workspace, row.notified_cursor, agent, agent, ...(urgentOnly ? URGENT_TYPES : []));
  }

  function deleteEntry({ workspace, key } = {}) {
    name(workspace, 'workspace');
    if (typeof key !== 'string' || !KEY.test(key)) invalid(`key must match ${KEY}`);
    return tx(() => {
      const old = q('SELECT * FROM entries WHERE workspace = ? AND key = ?').get(workspace, key);
      if (!old) throw new LttError('not_found', `no entry ${key}`);
      q('DELETE FROM entries WHERE workspace = ? AND key = ?').run(workspace, key);
      emit(workspace, 'entry.updated', USER, null, key, `${USER} deleted ${key}`);
      return { ok: true, key };
    });
  }

  function queryRequests({ workspace, status, kind, from, to, limit = 50, offset = 0 } = {}) {
    name(workspace, 'workspace');
    limit = Number(limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) invalid('limit must be an integer between 1 and 200');
    offset = Number(offset);
    if (!Number.isInteger(offset) || offset < 0) invalid('offset must be a non-negative integer');
    if (kind !== undefined && kind !== null && kind !== '') oneOf(kind, REQUEST_KINDS, 'kind');

    const clauses = ['workspace = ?'];
    const params = [workspace];

    if (kind) {
      clauses.push('kind = ?');
      params.push(kind);
    }
    if (from) {
      clauses.push('from_agent = ?');
      params.push(from);
    }
    if (to) {
      clauses.push('to_agent = ?');
      params.push(to);
    }
    if (status !== undefined && status !== null && status !== '') {
      const rawStatuses = String(status).split(',').map(s => s.trim()).filter(Boolean);
      if (rawStatuses.length > 0) {
        const placeholders = rawStatuses.map(() => '?').join(', ');
        clauses.push(`status IN (${placeholders})`);
        params.push(...rawStatuses);
      }
    }

    const where = clauses.join(' AND ');

    const countRow = q(`SELECT COUNT(*) AS total FROM requests WHERE ${where}`).get(...params);
    const total = Number(countRow.total);

    const rows = q(`SELECT * FROM requests WHERE ${where} ORDER BY id DESC LIMIT ? OFFSET ?`).all(...params, limit, offset);
    return {
      requests: rows.map(toRequest),
      total,
      limit,
      offset,
    };
  }

  function bulkCancelRequests({ workspace, ids } = {}) {
    name(workspace, 'workspace');
    if (!Array.isArray(ids) || ids.length === 0 || ids.some(id => !Number.isInteger(id))) {
      invalid('ids must be a non-empty array of numbers');
    }
    return tx(() => {
      const cancelled = [];
      const skipped = [];
      const t = now();
      for (const id of ids) {
        const r = toRequest(requestRow(workspace, id));
        if (!r) {
          skipped.push({ id, reason: 'not found' });
          continue;
        }
        if (r.status !== 'open' && r.status !== 'claimed') {
          skipped.push({ id, reason: `already ${r.status}` });
          continue;
        }
        q('UPDATE requests SET status = ?, updated_at = ? WHERE id = ?').run('cancelled', t, r.id);
        emit(workspace, 'request.updated', USER, r.from, r.id, `${USER} cancelled #${r.id}: ${r.title}`);
        if (r.claimed_by && r.claimed_by !== r.from) {
          emit(workspace, 'request.updated', USER, r.claimed_by, r.id, `${USER} cancelled #${r.id}: ${r.title}`);
        }
        cancelled.push(r.id);
      }
      return { ok: true, cancelled, skipped };
    });
  }

  function reassignRequest({ workspace, id, to } = {}) {
    name(workspace, 'workspace');
    if (!Number.isInteger(id)) invalid('id must be an integer');
    if (isUser(to)) to = USER;
    if (to !== '*' && to !== USER) {
      name(to, 'to');
      if (!agentRow(workspace, to)) throw new LttError('not_found', `no agent ${to} in workspace ${workspace}`);
    }
    return tx(() => {
      const r = toRequest(requestRow(workspace, id));
      if (!r) throw new LttError('not_found', `no request #${id}`);
      if (to === r.from) invalid('cannot send a request to yourself');
      if (r.status !== 'open' && r.status !== 'claimed') {
        throw new LttError('invalid_transition', 'cannot reassign terminal request');
      }
      const oldTo = r.to;
      const oldClaimedBy = r.claimed_by;
      const t = now();
      q("UPDATE requests SET to_agent = ?, status = 'open', claimed_by = '', updated_at = ? WHERE id = ?").run(to, t, r.id);

      const summary = to === USER
        ? `${USER} asks you${r.kind === 'question' ? '' : ' to'}: ${r.title} (#${r.id})`
        : r.kind === 'question'
          ? `${USER} asks ${to}: ${r.title} (#${r.id})`
          : `${USER} assigns ${to} a task: ${r.title} (#${r.id})`;
      emit(workspace, `${r.kind}.new`, USER, to === '*' ? null : to, r.id, summary);

      const prev = oldClaimedBy || (oldTo !== '*' ? oldTo : null);
      if (prev && prev !== to && prev !== USER) {
        emit(workspace, 'request.updated', USER, prev, r.id, `${USER} reassigned #${r.id} away to ${to}: ${r.title}`);
      }

      return getRequest(workspace, r.id);
    });
  }

  function forgetAgent({ workspace, agent, force = false } = {}) {
    name(workspace, 'workspace');
    name(agent, 'agent');
    const row = agentRow(workspace, agent);
    if (!row) throw new LttError('not_found', `no agent ${agent} in workspace ${workspace}`);
    const st = statusOf(row.last_seen);
    if (st !== 'offline' && !force) {
      throw new LttError('invalid', 'agent is currently active/idle; wait for offline or pass force=true');
    }
    return tx(() => {
      const claimedRows = q("SELECT * FROM requests WHERE workspace = ? AND status = 'claimed' AND claimed_by = ?").all(workspace, agent);
      const t = now();
      for (const r of claimedRows) {
        q("UPDATE requests SET status = 'open', claimed_by = '', updated_at = ? WHERE id = ?").run(t, r.id);
        emit(workspace, 'request.updated', USER, r.from_agent, r.id, `${USER} unclaimed #${r.id} (forgot ${agent}): ${r.title}`);
      }
      q('DELETE FROM agents WHERE workspace = ? AND agent = ?').run(workspace, agent);
      return { ok: true, agent };
    });
  }

  function clearWorkspace({ workspace } = {}) {
    name(workspace, 'workspace');
    return tx(() => {
      q('DELETE FROM agents WHERE workspace = ?').run(workspace);
      q('DELETE FROM entries WHERE workspace = ?').run(workspace);
      q('DELETE FROM requests WHERE workspace = ?').run(workspace);
      q('DELETE FROM events WHERE workspace = ?').run(workspace);
      return { ok: true, workspace };
    });
  }

  function pruneEvents({ workspace, maxAgeMs = 7 * 86_400_000, keepMin = 200 } = {}) {
    if (workspace !== undefined && workspace !== null) name(workspace, 'workspace');
    const targetWorkspaces = workspace ? [workspace] : q('SELECT DISTINCT workspace FROM events').all().map(r => r.workspace);

    return tx(() => {
      let deletedCount = 0;
      const t = now();
      const cutoff = t - maxAgeMs;

      for (const ws of targetWorkspaces) {
        const agents = q('SELECT * FROM agents WHERE workspace = ?').all(ws);
        const liveAgents = agents.filter(a => statusOf(a.last_seen) !== 'offline');
        let minCursor = Infinity;
        for (const a of liveAgents) {
          minCursor = Math.min(minCursor, a.cursor, a.notified_cursor);
        }

        const keepMinRow = q('SELECT id FROM events WHERE workspace = ? ORDER BY id DESC LIMIT 1 OFFSET ?').get(ws, keepMin - 1);
        if (!keepMinRow) continue;
        const keepMinId = keepMinRow.id;
        const maxEligibleId = Math.min(keepMinId - 1, minCursor === Infinity ? Infinity : minCursor - 1);

        if (maxEligibleId > 0 && Number.isFinite(maxEligibleId)) {
          const info = q('DELETE FROM events WHERE workspace = ? AND created_at < ? AND id <= ?').run(ws, cutoff, maxEligibleId);
          deletedCount += Number(info.changes ?? 0);
        }
      }
      return { ok: true, deleted: deletedCount };
    });
  }

  return {
    register,
    touch: (workspace, agent) => register({ workspace, agent }),
    getAgent,
    peers: (workspace) => q('SELECT * FROM agents WHERE workspace = ? ORDER BY agent').all(workspace).map(toAgent),
    workspaces: () => q('SELECT DISTINCT workspace FROM agents ORDER BY workspace').all().map(r => r.workspace),
    writeEntry,
    readEntry,
    listEntries,
    deleteEntry,
    createRequest,
    getRequest,
    updateRequest, cancelRequest,
    listRequests,
    queryRequests,
    bulkCancelRequests,
    reassignRequest,
    forgetAgent,
    clearWorkspace,
    pruneEvents,
    getThresholds,
    setThresholds,
    unread: (workspace, agent, { advance = false } = {}) => readFrom('cursor', workspace, agent, advance),
    notify: (workspace, agent) => readFrom('notified_cursor', workspace, agent, true),
    pendingNotify,
    recentEvents: (workspace, limit = 30) =>
      q('SELECT * FROM events WHERE workspace = ? ORDER BY id DESC LIMIT ?').all(workspace, limit).map(plain),
    onEvent(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    close: () => db.close(),
  };
}
