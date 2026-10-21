import { readFileSync, mkdirSync, openSync, closeSync } from 'node:fs';
import { join, dirname } from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const home = () => process.env.LTT_HOME || join(os.homedir(), '.let-them-talk');
export const port = () => Number(process.env.LTT_PORT) || 7777;
export const base = () => `http://127.0.0.1:${port()}`;
export const DAEMON_PATH = fileURLToPath(new URL('../daemon/index.js', import.meta.url));
// long-poll seconds for /api/wait: the daemon sends no headers until it answers, and Node fetch gives up after 300 s
// without headers (undici headersTimeout); each re-poll also must stay below the store's 30 min offline threshold
export const POLL_S = 240;
export const toolName = () => (process.env.CLAUDECODE === '1' ? 'claude' : 'agy');

const NAME = /^[a-z0-9][a-z0-9_-]{0,31}$/i;

// Nearest .ltt.json: a single `agent` or an `agents` roster; env LTT_AGENT/LTT_ROLE/LTT_OWNS pick/override the identity.
// config.agent is null when no valid identity resolves (roster without LTT_AGENT, bad or reserved name).
// tool (hooks pass theirs): env identity set by `ltt run`/`ltt worker` for another tool (LTT_TOOL) is ignored, so a
// tool nested inside a session (e.g. `agy -p` run by Claude) doesn't act as that session's agent.
export function findConfig(startDir, env = process.env, tool) {
  if (tool && env.LTT_TOOL && env.LTT_TOOL !== tool) env = {};
  let dir = startDir;
  for (;;) {
    const path = join(dir, '.ltt.json');
    let text = null;
    try { text = readFileSync(path, 'utf8'); } catch {}
    if (text !== null) {
      let file;
      try { file = JSON.parse(text); } catch { return null; }
      const roster = file?.agents && typeof file.agents === 'object' && !Array.isArray(file.agents) ? file.agents : null;
      if (!file?.workspace || !(file.agent || roster)) return null;
      let agent = env.LTT_AGENT || file.agent || null;
      if (typeof agent !== 'string' || !NAME.test(agent) || agent.toLowerCase() === 'user') agent = null;
      const entry = agent && roster && Object.hasOwn(roster, agent) ? roster[agent] ?? {} : {};
      const self = agent !== null && agent === file.agent;
      const config = {
        workspace: file.workspace, agent,
        role: env.LTT_ROLE || entry.role || (self && file.role) || '',
        owns: env.LTT_OWNS ? env.LTT_OWNS.split(',').map(s => s.trim()).filter(Boolean) : entry.owns || (self && file.owns) || [],
        roles: roster ? Object.keys(roster) : [file.agent],
      };
      return { path, dir, config };
    }
    const up = dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

export function readToken() {
  try { return readFileSync(join(home(), 'token'), 'utf8').trim() || null; } catch { return null; }
}

export async function api(method, path, { query, body, timeoutMs = 3000 } = {}) {
  const url = new URL(path, base());
  for (const [k, v] of Object.entries(query || {})) if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
  const headers = { 'x-ltt-token': readToken() || '' };
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(url, {
    method, headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!res.ok) {
    const err = new Error(data?.error || `HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

export async function isUp(timeoutMs = 500) {
  try {
    const res = await fetch(`${base()}/health`, { signal: AbortSignal.timeout(timeoutMs) });
    return (await res.json())?.name === 'let-them-talk';
  } catch { return false; }
}

export async function ensureDaemon({ waitMs = 4000 } = {}) {
  if (await isUp()) return true;
  try {
    mkdirSync(home(), { recursive: true });
    const fd = openSync(join(home(), 'daemon.log'), 'a');
    const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', DAEMON_PATH], {
      detached: true, stdio: ['ignore', fd, fd], windowsHide: true, env: process.env,
    });
    child.on('error', () => {});
    child.unref();
    closeSync(fd);
  } catch { return false; }
  const end = Date.now() + waitMs;
  while (Date.now() < end) {
    if (await isUp(300)) return true;
    await new Promise(r => setTimeout(r, 150));
  }
  return false;
}

export function readStdinJson(timeoutMs = 1000) {
  return new Promise(resolve => {
    if (process.stdin.isTTY) return resolve({});
    let buf = '';
    const done = () => {
      clearTimeout(timer);
      process.stdin.removeAllListeners('data');
      process.stdin.removeAllListeners('end');
      process.stdin.destroy();
      try { const v = JSON.parse(buf); resolve(v && typeof v === 'object' ? v : {}); } catch { resolve({}); }
    };
    const timer = setTimeout(() => { buf = ''; done(); }, timeoutMs);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', c => { buf += c; });
    process.stdin.on('end', done);
    process.stdin.on('error', done);
  });
}
