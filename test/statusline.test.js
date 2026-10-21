import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('../statusline/ltt-statusline.js', import.meta.url));

function tmp(t) { const d = mkdtempSync(join(tmpdir(), 'ltt-sl-')); t.after(() => rmSync(d, { recursive: true, force: true })); return d; }

function run(stdin, env) {
  return new Promise((resolve) => {
    const started = Date.now();
    const p = spawn(process.execPath, [SCRIPT], { env: { ...process.env, ...env } });
    let out = '';
    p.stdout.on('data', d => out += d);
    p.on('close', code => resolve({ code, out: out.trim(), ms: Date.now() - started }));
    p.stdin.end(JSON.stringify(stdin));
  });
}

test('no config prints nothing', async (t) => {
  const cwd = tmp(t), home = tmp(t);
  const r = await run({ cwd }, { LTT_HOME: home, LTT_PORT: '1', CLAUDECODE: '' });
  assert.equal(r.code, 0);
  assert.equal(r.out, '');
});

test('daemon down shows offline quickly', async (t) => {
  const cwd = tmp(t), home = tmp(t);
  writeFileSync(join(cwd, '.ltt.json'), JSON.stringify({ workspace: 'shop', agent: 'api' }));
  const r = await run({ workspace: { current_dir: cwd } }, { LTT_HOME: home, LTT_PORT: '1', CLAUDECODE: '' });
  assert.equal(r.out, '[api@shop] ⚫ offline');
  assert.ok(r.ms < 2500, `took ${r.ms}ms`); // includes node spawn/boot, 1-3 s on Windows under the parallel suite (port 1: fetch fails at once)
});

test('shows unread and incoming, chains previous status line', async (t) => {
  const cwd = tmp(t), home = tmp(t);
  writeFileSync(join(cwd, '.ltt.json'), JSON.stringify({ workspace: 'shop', agent: 'api' }));
  writeFileSync(join(home, 'token'), 'tok');
  writeFileSync(join(home, 'config.json'), JSON.stringify({ prevStatusLine: { claude: 'echo PREV' } }));
  const srv = http.createServer((req, res) => {
    assert.equal(req.headers['x-ltt-token'], 'tok');
    assert.match(req.url, /^\/api\/unread\?/);
    assert.match(req.url, /mode=peek/);
    res.end(JSON.stringify({ summary: { total: 2 }, incoming: 1 }));
  });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  t.after(() => srv.close());
  const r = await run({ cwd }, { LTT_HOME: home, LTT_PORT: String(srv.address().port), CLAUDECODE: '1' });
  assert.equal(r.out, 'PREV [api@shop] 📬2 ⏳1');
});
