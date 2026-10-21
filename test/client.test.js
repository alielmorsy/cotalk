import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import http from 'node:http';
import { findConfig, readToken, api, isUp, home, port, base } from '../lib/client.js';

function tmp(t) {
  const d = mkdtempSync(join(tmpdir(), 'ltt-client-'));
  t.after(() => rmSync(d, { recursive: true, force: true }));
  return d;
}

test('env-driven paths are read at call time', (t) => {
  const d = tmp(t);
  process.env.LTT_HOME = d; process.env.LTT_PORT = '7788';
  assert.equal(home(), d);
  assert.equal(port(), 7788);
  assert.equal(base(), 'http://127.0.0.1:7788');
});

test('findConfig walks up and stops at root', (t) => {
  const d = tmp(t);
  writeFileSync(join(d, '.ltt.json'), JSON.stringify({ workspace: 'shop', agent: 'api' }));
  const deep = join(d, 'a', 'b', 'c');
  mkdirSync(deep, { recursive: true });
  const found = findConfig(deep);
  assert.equal(found.dir, d);
  assert.equal(found.config.agent, 'api');
  const empty = tmp(t);
  assert.equal(findConfig(empty), null);
});

test('findConfig rejects invalid config', (t) => {
  const d = tmp(t);
  writeFileSync(join(d, '.ltt.json'), '{not json');
  assert.equal(findConfig(d), null);
  writeFileSync(join(d, '.ltt.json'), JSON.stringify({ workspace: 'shop' }));
  assert.equal(findConfig(d), null);
});

test('readToken', (t) => {
  const d = tmp(t);
  process.env.LTT_HOME = d;
  assert.equal(readToken(), null);
  writeFileSync(join(d, 'token'), 'abc\n');
  assert.equal(readToken(), 'abc');
});

test('api sends token, isUp checks name, errors carry status', async (t) => {
  const d = tmp(t);
  process.env.LTT_HOME = d;
  writeFileSync(join(d, 'token'), 'tok');
  const srv = http.createServer((req, res) => {
    if (req.url === '/health') return res.end(JSON.stringify({ ok: true, name: 'let-them-talk' }));
    if (req.headers['x-ltt-token'] !== 'tok') { res.statusCode = 401; return res.end(JSON.stringify({ error: 'unauthorized' })); }
    res.end(JSON.stringify({ url: req.url }));
  });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  t.after(() => srv.close());
  process.env.LTT_PORT = String(srv.address().port);
  assert.equal(await isUp(), true);
  assert.deepEqual(await api('GET', '/api/x', { query: { a: 'b c' } }), { url: '/api/x?a=b+c' });
  writeFileSync(join(d, 'token'), 'wrong');
  await assert.rejects(api('GET', '/api/x'), e => e.status === 401 && /unauthorized/.test(e.message));
});

test('isUp false when nothing listens', async () => {
  process.env.LTT_PORT = '1';
  assert.equal(await isUp(200), false);
});
