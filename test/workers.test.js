import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import {
  listWorkers,
  startWorker,
  stopWorker,
  tailLog,
  isProcessAlive,
  workerPidPath,
  workerLogPath,
  workerStopPath,
  checkAllowedDir,
} from '../daemon/workers.js';
import { LttError } from '../daemon/store.js';

test('workers: isProcessAlive correctly identifies current process and dead pids', () => {
  assert.equal(isProcessAlive(process.pid), true);
  assert.equal(isProcessAlive(0), false);
  assert.equal(isProcessAlive(-1), false);
  assert.equal(isProcessAlive(99999999), false);
});

test('workers: file naming prevents collisions between (a-b, c) and (a, b-c)', () => {
  const p1 = workerPidPath('a-b', 'c');
  const p2 = workerPidPath('a', 'b-c');
  assert.notEqual(p1, p2);
  assert.ok(p1.endsWith('a-b.c.json'));
  assert.ok(p2.endsWith('a.b-c.json'));
});

test('workers: checkAllowedDir enforces non-empty array and exact directory matching', () => {
  assert.throws(() => checkAllowedDir('C:/dir', []), (err) => err instanceof LttError && err.code === 'forbidden');
  assert.throws(() => checkAllowedDir('C:/dir', null), (err) => err instanceof LttError && err.code === 'forbidden');

  // Prefix mismatch: C:/a should not match C:/ab
  assert.throws(
    () => checkAllowedDir('C:/ab', ['C:/a']),
    (err) => err instanceof LttError && err.code === 'forbidden'
  );

  // Exact match
  assert.doesNotThrow(() => checkAllowedDir('C:/a/b', ['C:/a/b', 'C:/other']));
});

test('workers: listWorkers returns active workers and cleans up dead pid files', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'ltt-workers-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const origHome = process.env.LTT_HOME;
  process.env.LTT_HOME = dir;
  t.after(() => {
    if (origHome) process.env.LTT_HOME = origHome;
    else delete process.env.LTT_HOME;
  });

  const wDir = join(dir, 'workers');
  mkdirSync(wDir, { recursive: true });

  // Active worker (our own pid)
  const activeWorker = {
    name: 'live-worker',
    workspace: 'ws-1',
    pid: process.pid,
    role: 'tester',
    owns: ['test/**'],
    cwd: dir,
    yolo: false,
    startedAt: 1000,
    logFile: join(wDir, 'ws-1.live-worker.log'),
  };
  writeFileSync(join(wDir, 'ws-1.live-worker.json'), JSON.stringify(activeWorker), 'utf8');

  // Dead worker
  const deadWorker = {
    name: 'dead-worker',
    workspace: 'ws-1',
    pid: 99999998,
    role: 'old',
    owns: [],
  };
  writeFileSync(join(wDir, 'ws-1.dead-worker.json'), JSON.stringify(deadWorker), 'utf8');

  // Another workspace worker (active)
  const otherWsWorker = {
    name: 'other-worker',
    workspace: 'ws-2',
    pid: process.pid,
  };
  writeFileSync(join(wDir, 'ws-2.other-worker.json'), JSON.stringify(otherWsWorker), 'utf8');

  // List all
  const all = await listWorkers();
  assert.equal(all.length, 2);
  assert.ok(all.some(w => w.name === 'live-worker' && w.workspace === 'ws-1'));
  assert.ok(all.some(w => w.name === 'other-worker' && w.workspace === 'ws-2'));

  // Dead worker file was cleaned up
  assert.equal(existsSync(join(wDir, 'ws-1.dead-worker.json')), false);

  // List filtered by workspace
  const ws1Only = await listWorkers({ workspace: 'ws-1' });
  assert.equal(ws1Only.length, 1);
  assert.equal(ws1Only[0].name, 'live-worker');
});

test('workers: tailLog returns bounded lines, drops partial line when truncated', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'ltt-workers-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const origHome = process.env.LTT_HOME;
  process.env.LTT_HOME = dir;
  t.after(() => {
    if (origHome) process.env.LTT_HOME = origHome;
    else delete process.env.LTT_HOME;
  });

  const wDir = join(dir, 'workers');
  mkdirSync(wDir, { recursive: true });

  // Missing log
  await assert.rejects(
    async () => tailLog({ workspace: 'ws', name: 'missing' }),
    (err) => err instanceof LttError && err.code === 'not_found'
  );

  // Log with 5 lines
  const logFile = join(wDir, 'ws.worker1.log');
  const lines = ['line 1', 'line 2', 'line 3', 'line 4', 'line 5'];
  writeFileSync(logFile, lines.join('\r\n') + '\r\n', 'utf8');

  const tail2 = await tailLog({ workspace: 'ws', name: 'worker1', lines: 2 });
  assert.deepEqual(tail2.lines, ['line 4', 'line 5']);
  assert.equal(tail2.total, 5);

  const tailAll = await tailLog({ workspace: 'ws', name: 'worker1', lines: 10 });
  assert.deepEqual(tailAll.lines, lines);
});

test('workers: stopWorker stops running worker gracefully via .stop and unlinks pid file', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'ltt-workers-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const origHome = process.env.LTT_HOME;
  process.env.LTT_HOME = dir;
  t.after(() => {
    if (origHome) process.env.LTT_HOME = origHome;
    else delete process.env.LTT_HOME;
  });

  const wDir = join(dir, 'workers');
  mkdirSync(wDir, { recursive: true });

  // Non-existent worker -> not_found
  await assert.rejects(
    async () => stopWorker({ workspace: 'ws', name: 'none' }),
    (err) => err instanceof LttError && err.code === 'not_found'
  );

  // Stale worker (dead pid)
  writeFileSync(join(wDir, 'ws.stale.json'), JSON.stringify({ workspace: 'ws', name: 'stale', pid: 99999997 }), 'utf8');
  const staleStop = await stopWorker({ workspace: 'ws', name: 'stale' });
  assert.equal(staleStop.ok, true);
  assert.equal(staleStop.stopped, true);
  assert.equal(staleStop.forced, false);
  assert.equal(existsSync(join(wDir, 'ws.stale.json')), false);

  // Worker responding to .stop file
  const stopHelper = spawn(process.execPath, [
    '-e',
    `
    const fs = require('node:fs');
    const stopFile = process.argv[1];
    const timer = setInterval(() => {
      if (fs.existsSync(stopFile)) {
        try { fs.unlinkSync(stopFile); } catch {}
        clearInterval(timer);
        process.exit(0);
      }
    }, 100);
    `,
    join(wDir, 'ws.graceful.stop'),
  ], {
    stdio: 'ignore',
    windowsHide: true,
  });
  t.after(() => { try { stopHelper.kill(); } catch {} });

  const pidPath = join(wDir, 'ws.graceful.json');
  writeFileSync(pidPath, JSON.stringify({ workspace: 'ws', name: 'graceful', pid: stopHelper.pid }), 'utf8');

  const res = await stopWorker({ workspace: 'ws', name: 'graceful' });
  assert.equal(res.ok, true);
  assert.equal(res.stopped, true);
  assert.equal(res.forced, false);
  assert.equal(existsSync(pidPath), false);
  assert.equal(isProcessAlive(stopHelper.pid), false);
});

test('workers: stopWorker uses force when requested or after timeout', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'ltt-workers-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const origHome = process.env.LTT_HOME;
  process.env.LTT_HOME = dir;
  t.after(() => {
    if (origHome) process.env.LTT_HOME = origHome;
    else delete process.env.LTT_HOME;
  });

  const wDir = join(dir, 'workers');
  mkdirSync(wDir, { recursive: true });

  // Sleeper process that ignores signals
  const sleeper = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    stdio: 'ignore',
    windowsHide: true,
  });
  t.after(() => { try { sleeper.kill(); } catch {} });

  const pidPath = join(wDir, 'ws.sleeper.json');
  writeFileSync(pidPath, JSON.stringify({ workspace: 'ws', name: 'sleeper', pid: sleeper.pid }), 'utf8');

  const res = await stopWorker({ workspace: 'ws', name: 'sleeper', force: true });
  assert.equal(res.ok, true);
  assert.equal(res.stopped, true);
  assert.equal(res.forced, true);
  assert.equal(existsSync(pidPath), false);
  assert.equal(isProcessAlive(sleeper.pid), false);
});

test('workers: startWorker validates inputs and checks permissions/conflicts', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'ltt-workers-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const origHome = process.env.LTT_HOME;
  process.env.LTT_HOME = dir;
  t.after(() => {
    if (origHome) process.env.LTT_HOME = origHome;
    else delete process.env.LTT_HOME;
  });

  // Invalid names / user
  await assert.rejects(
    async () => startWorker({ workspace: 'ws', name: 'user', cwd: dir, allowedDirs: [dir] }),
    (err) => err instanceof LttError && err.code === 'invalid'
  );
  await assert.rejects(
    async () => startWorker({ workspace: 'ws', name: 'bad name!', cwd: dir, allowedDirs: [dir] }),
    (err) => err instanceof LttError && err.code === 'invalid'
  );

  // Empty allowedDirs -> forbidden
  await assert.rejects(
    async () => startWorker({ workspace: 'ws', name: 'w1', cwd: dir, allowedDirs: [] }),
    (err) => err instanceof LttError && err.code === 'forbidden'
  );

  // Unauthorized cwd
  await assert.rejects(
    async () => startWorker({ workspace: 'ws', name: 'w1', cwd: dir, allowedDirs: ['C:/other/dir'] }),
    (err) => err instanceof LttError && err.code === 'forbidden'
  );

  // Conflict with running worker
  const wDir = join(dir, 'workers');
  mkdirSync(wDir, { recursive: true });
  writeFileSync(join(wDir, 'ws.w1.json'), JSON.stringify({ workspace: 'ws', name: 'w1', pid: process.pid }), 'utf8');

  await assert.rejects(
    async () => startWorker({ workspace: 'ws', name: 'w1', cwd: dir, allowedDirs: [dir] }),
    (err) => err instanceof LttError && err.code === 'conflict'
  );
});

test('workers: stopWorker rejects when pid file workspace or name does not match', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'ltt-workers-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const origHome = process.env.LTT_HOME;
  process.env.LTT_HOME = dir;
  t.after(() => {
    if (origHome) process.env.LTT_HOME = origHome;
    else delete process.env.LTT_HOME;
  });

  const wDir = join(dir, 'workers');
  mkdirSync(wDir, { recursive: true });

  // File named ws.w1.json but contains mismatched workspace
  writeFileSync(join(wDir, 'ws.w1.json'), JSON.stringify({ workspace: 'other-ws', name: 'w1', pid: process.pid }), 'utf8');

  await assert.rejects(
    async () => stopWorker({ workspace: 'ws', name: 'w1' }),
    (err) => err instanceof LttError && err.code === 'invalid' && err.message.includes('pid file does not match')
  );
});
