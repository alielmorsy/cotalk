import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startDaemon, mcp } from './helpers.js';

const CLI = fileURLToPath(new URL('../bin/ltt.js', import.meta.url));

test('ltt wait: blocks until a peer sends a task, prints it, exits 0', async (t) => {
  const d = await startDaemon(t);
  const cwd = mkdtempSync(join(tmpdir(), 'ltt-wait-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  writeFileSync(join(cwd, '.ltt.json'), JSON.stringify({ workspace: 'shop', agent: 'gfx' }));
  const { call } = mcp(d.base, d.token);
  await call('ltt_register', { workspace: 'shop', agent: 'gfx' });
  await call('ltt_register', { workspace: 'shop', agent: 'lead' });

  const child = spawn(process.execPath, [CLI, 'wait'], { cwd, env: { ...process.env, LTT_HOME: d.home, LTT_PORT: String(d.port) } });
  let out = '';
  child.stdout.on('data', c => { out += c; });
  const exited = new Promise(r => child.on('exit', r));
  await new Promise(r => setTimeout(r, 800));
  assert.equal(child.exitCode, null, 'still waiting while nothing is addressed to it');

  await call('ltt_request', { workspace: 'shop', agent: 'lead', to: 'gfx', kind: 'task', title: 'Draw the triangle' });
  assert.equal(await Promise.race([exited, new Promise(r => setTimeout(() => r('hung'), 8000))]), 0);
  assert.match(out, /a peer needs you/);
  assert.match(out, /Draw the triangle/);
});
