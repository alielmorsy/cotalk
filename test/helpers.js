import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import net from 'node:net';
import { fileURLToPath } from 'node:url';

export const DAEMON = fileURLToPath(new URL('../daemon/index.js', import.meta.url));

export function tmpHome(t) {
  const d = mkdtempSync(join(tmpdir(), 'cotalk-test-'));
  t.after(() => { try { rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch {} }); // Windows: a live daemon may still hold the db
  return d;
}

export function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
    s.on('error', reject);
  });
}

export async function startDaemon(t, { home, port } = {}) {
  home ??= tmpHome(t);
  port ??= await freePort();
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', DAEMON], {
    env: { ...process.env, COTALK_HOME: home, COTALK_PORT: String(port) }, stdio: 'ignore',
  });
  const base = `http://127.0.0.1:${port}`;
  const stop = () => new Promise(r => {
    if (child.exitCode !== null || child.signalCode !== null) return r();
    child.once('exit', () => r());
    child.kill();
  });
  // after-hooks run FIFO, so tmpHome's cleanup ran while the daemon still held the db (Windows); remove it again after the kill
  t.after(async () => { await stop(); try { rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch {} });
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(`${base}/health`)).ok) break; } catch {}
    await new Promise(r => setTimeout(r, 100));
  }
  const token = readFileSync(join(home, 'token'), 'utf8').trim();
  return { home, port, token, base, stop, child };
}

// tool text = '<unread line>\n\n<json>' on success, 'error (...)\n\n<unread line>' on error
export function parseData(text) {
  try { return JSON.parse(text.split('\n\n').slice(1).join('\n\n')); } catch { return null; }
}

export function mcp(base, token) {
  let id = 0;
  const rpc = async (method, params) => {
    const r = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'x-cotalk-token': token },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }),
    });
    return r.json();
  };
  const call = async (name, args) => {
    const r = await rpc('tools/call', { name, arguments: args });
    const text = r.result.content[0].text;
    return { isError: r.result.isError, text, data: parseData(text) };
  };
  return { rpc, call };
}
