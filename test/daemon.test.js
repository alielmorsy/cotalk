import test from 'node:test';
import assert from 'node:assert/strict';
import { statSync } from 'node:fs';
import { join } from 'node:path';
import { startDaemon, mcp } from './helpers.js';

test('daemon creates token, serves health and MCP initialize', async (t) => {
  const d = await startDaemon(t);
  assert.match(d.token, /^[0-9a-f]{48}$/);
  assert.ok(statSync(join(d.home, 'cotalk.db')).size > 0);
  const { rpc } = mcp(d.base, d.token);
  const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } });
  assert.equal(init.result.serverInfo.name, 'cotalk');
});

test('concurrent daemon starts agree on one token', async (t) => {
  const { spawn } = await import('node:child_process');
  const { readFileSync } = await import('node:fs');
  const { DAEMON, tmpHome, freePort } = await import('./helpers.js');
  const home = tmpHome(t), port = await freePort();
  const kids = Array.from({ length: 6 }, () => spawn(process.execPath, ['--disable-warning=ExperimentalWarning', DAEMON],
    { env: { ...process.env, COTALK_HOME: home, COTALK_PORT: String(port) }, stdio: 'ignore' }));
  t.after(() => Promise.all(kids.map(k => k.exitCode !== null ? null : new Promise(r => { k.once('exit', r); k.kill(); }))));
  let up = false;
  for (let i = 0; i < 50 && !up; i++) {
    try { up = (await fetch(`http://127.0.0.1:${port}/health`)).ok; } catch { await new Promise(r => setTimeout(r, 100)); }
  }
  assert.ok(up);
  const token = readFileSync(join(home, 'token'), 'utf8').trim();
  assert.match(token, /^[0-9a-f]{48}$/);
  const r = await fetch(`http://127.0.0.1:${port}/api/state`, { headers: { 'x-cotalk-token': token } });
  assert.equal(r.status, 200, 'token file matches the running daemon');
});

test('existing token file is reused', async (t) => {
  const { tmpHome } = await import('./helpers.js');
  const { writeFileSync } = await import('node:fs');
  const home = tmpHome(t);
  writeFileSync(join(home, 'token'), 'pre-existing-token\n');
  const d = await startDaemon(t, { home });
  assert.equal(d.token, 'pre-existing-token');
  assert.equal((await fetch(`${d.base}/api/state`, { headers: { 'x-cotalk-token': d.token } })).status, 200);
});

test('second daemon on same port exits 0', async (t) => {
  const d = await startDaemon(t);
  const { spawnSync } = await import('node:child_process');
  const { DAEMON } = await import('./helpers.js');
  const r = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', DAEMON], { env: { ...process.env, COTALK_HOME: d.home, COTALK_PORT: String(d.port) }, timeout: 5000 });
  assert.equal(r.status, 0);
});
