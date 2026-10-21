import { readdirSync, readFileSync, writeFileSync, unlinkSync, existsSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { LttError, USER } from './store.js';
import { home } from '../lib/client.js';

export const NAME = /^[a-z0-9][a-z0-9_-]{0,31}$/i;
const LTT_BIN = fileURLToPath(new URL('../bin/ltt.js', import.meta.url));

export const workersDir = () => join(home(), 'workers');
export const workerLogPath = (workspace, name) => join(workersDir(), `${workspace}.${name}.log`);
export const workerPidPath = (workspace, name) => join(workersDir(), `${workspace}.${name}.json`);
export const workerStopPath = (workspace, name) => join(workersDir(), `${workspace}.${name}.stop`);

export function normalizeDir(p) {
  const resolved = resolve(p);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

export function checkAllowedDir(dir, allowedDirs) {
  if (!dir) throw new LttError('invalid', 'cwd is required');
  if (!Array.isArray(allowedDirs) || allowedDirs.length === 0) {
    throw new LttError('forbidden', 'allowedDirs must be a non-empty array');
  }
  const target = normalizeDir(dir);
  const match = allowedDirs.some(a => normalizeDir(a) === target);
  if (!match) {
    throw new LttError('forbidden', `directory "${dir}" is not in allowedDirs for workspace`);
  }
}

// ponytail: pid reuse can fool process.kill(pid, 0)
export function isProcessAlive(pid) {
  if (!pid || typeof pid !== 'number' || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

export async function listWorkers({ workspace } = {}) {
  const dir = workersDir();
  if (!existsSync(dir)) return [];

  let entries = [];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }

  const workers = [];
  for (const file of entries) {
    if (!file.endsWith('.json')) continue;
    const filePath = join(dir, file);
    let info = null;
    try {
      const raw = readFileSync(filePath, 'utf8');
      info = JSON.parse(raw);
    } catch {
      continue;
    }
    if (!info || typeof info !== 'object' || !info.name || !info.workspace) continue;
    if (file !== `${info.workspace}.${info.name}.json`) continue;
    if (workspace && info.workspace !== workspace) continue;

    const alive = isProcessAlive(info.pid);
    if (!alive) {
      try { unlinkSync(filePath); } catch {}
      continue;
    }

    workers.push({
      name: info.name,
      workspace: info.workspace,
      pid: info.pid,
      role: info.role || '',
      owns: Array.isArray(info.owns) ? info.owns : [],
      cwd: info.cwd || '',
      yolo: !!info.yolo,
      startedAt: info.startedAt || 0,
      alive: true,
      logFile: info.logFile || workerLogPath(info.workspace, info.name),
    });
  }

  return workers;
}

export async function startWorker({ workspace, name, role = '', owns = [], cwd, yolo = false, allowedDirs } = {}) {
  if (!workspace || !NAME.test(workspace)) {
    throw new LttError('invalid', `invalid workspace "${workspace}"`);
  }
  if (!name || !NAME.test(name) || name.toLowerCase() === USER) {
    throw new LttError('invalid', `invalid worker name "${name}"`);
  }
  if (!cwd) {
    throw new LttError('invalid', 'cwd is required');
  }

  checkAllowedDir(cwd, allowedDirs);

  const pidPath = workerPidPath(workspace, name);
  if (existsSync(pidPath)) {
    try {
      const existing = JSON.parse(readFileSync(pidPath, 'utf8'));
      if (existing?.workspace === workspace && existing?.name === name && existing?.pid && isProcessAlive(existing.pid)) {
        throw new LttError('conflict', `worker "${name}" is already running in workspace "${workspace}" (pid ${existing.pid})`);
      } else {
        try { unlinkSync(pidPath); } catch {}
      }
    } catch (err) {
      if (err instanceof LttError) throw err;
      try { unlinkSync(pidPath); } catch {}
    }
  }

  const args = [
    LTT_BIN,
    'worker',
    name,
    '--workspace', workspace,
  ];

  if (typeof role === 'string' && role.trim().length > 0) {
    args.push('--role', role.trim());
  }

  const ownsList = Array.isArray(owns)
    ? owns.filter(s => typeof s === 'string' && s.trim().length > 0).join(',')
    : (typeof owns === 'string' ? owns.trim() : '');
  if (ownsList.length > 0) {
    args.push('--owns', ownsList);
  }

  if (yolo === true) {
    args.push('--yolo');
  }

  args.push('--detach');

  const env = { ...process.env };
  delete env.CLAUDECODE;
  for (const k of ['LTT_AGENT', 'LTT_ROLE', 'LTT_OWNS', 'LTT_WORKER', 'LTT_WORKER_DETACHED', 'LTT_TOOL']) {
    delete env[k];
  }

  const spawner = spawn(process.execPath, args, {
    cwd: resolve(cwd),
    stdio: 'pipe',
    windowsHide: true,
    env,
  });

  let stderrText = '';
  spawner.stderr?.on('data', (d) => { stderrText += d.toString(); });

  const spawnerCode = await new Promise((res, rej) => {
    spawner.on('error', rej);
    spawner.on('close', (code) => res(code));
  });

  if (spawnerCode !== 0) {
    throw new LttError('invalid', `failed to start worker spawner (exit ${spawnerCode})${stderrText ? `: ${stderrText.trim()}` : ''}`);
  }

  // Poll briefly (<= 3s) for runner to write the pid file
  const end = Date.now() + 3000;
  while (Date.now() < end) {
    if (existsSync(pidPath)) {
      try {
        const info = JSON.parse(readFileSync(pidPath, 'utf8'));
        if (info && info.pid && info.workspace === workspace && info.name === name) {
          return {
            name: info.name,
            workspace: info.workspace,
            pid: info.pid,
            role: info.role || role,
            owns: Array.isArray(info.owns) ? info.owns : (Array.isArray(owns) ? owns : []),
            cwd: info.cwd || cwd,
            yolo: !!info.yolo,
            startedAt: info.startedAt || Date.now(),
            alive: isProcessAlive(info.pid),
            logFile: info.logFile || workerLogPath(workspace, name),
          };
        }
      } catch {}
    }
    await new Promise(r => setTimeout(r, 60));
  }

  throw new LttError('invalid', `worker started but pid file not found within 3s (${pidPath})`);
}

export async function stopWorker({ workspace, name, force = false } = {}) {
  if (!workspace || !NAME.test(workspace)) {
    throw new LttError('invalid', `invalid workspace "${workspace}"`);
  }
  if (!name || !NAME.test(name) || name.toLowerCase() === USER) {
    throw new LttError('invalid', `invalid worker name "${name}"`);
  }

  const pidPath = workerPidPath(workspace, name);
  if (!existsSync(pidPath)) {
    throw new LttError('not_found', `worker "${name}" not found in workspace "${workspace}"`);
  }

  let info;
  try {
    info = JSON.parse(readFileSync(pidPath, 'utf8'));
  } catch {
    try { unlinkSync(pidPath); } catch {}
    return { ok: true, stopped: true, forced: false };
  }

  if (info?.workspace !== workspace || info?.name !== name) {
    throw new LttError('invalid', `worker pid file does not match workspace "${workspace}" and name "${name}"`);
  }

  const pid = info?.pid;
  if (!pid || !isProcessAlive(pid)) {
    try { unlinkSync(pidPath); } catch {}
    return { ok: true, stopped: true, forced: false };
  }

  let forced = false;
  let warning;

  if (!force) {
    const stopPath = workerStopPath(workspace, name);
    try { writeFileSync(stopPath, '', 'utf8'); } catch {}

    const end = Date.now() + 10_000;
    while (Date.now() < end) {
      if (!isProcessAlive(pid)) break;
      await new Promise(r => setTimeout(r, 200));
    }
    try { unlinkSync(stopPath); } catch {}
  }

  if (force || isProcessAlive(pid)) {
    forced = true;
    if (process.platform === 'win32') {
      await new Promise((res) => {
        execFile('taskkill', ['/pid', String(pid), '/T', '/F'], (err, stdout, stderr) => {
          if (err && stderr) warning = stderr.trim();
          res();
        });
      });
    } else {
      try {
        process.kill(-pid, 'SIGKILL');
      } catch {
        try { process.kill(pid, 'SIGKILL'); } catch {}
      }
    }
    await new Promise(r => setTimeout(r, 100));
  }

  const stopped = !isProcessAlive(pid);
  if (stopped) {
    try { unlinkSync(pidPath); } catch {}
  }

  const res = { ok: stopped, stopped, forced };
  if (warning) res.warning = warning;
  return res;
}

export async function tailLog({ workspace, name, lines = 100 } = {}) {
  if (!workspace || !NAME.test(workspace)) {
    throw new LttError('invalid', `invalid workspace "${workspace}"`);
  }
  if (!name || !NAME.test(name) || name.toLowerCase() === USER) {
    throw new LttError('invalid', `invalid worker name "${name}"`);
  }

  const count = Math.min(Math.max(1, Math.floor(Number(lines) || 100)), 1000);
  const logPath = workerLogPath(workspace, name);
  if (!existsSync(logPath)) {
    throw new LttError('not_found', `log file not found for worker "${name}" in workspace "${workspace}"`);
  }

  let stat;
  try {
    stat = statSync(logPath);
  } catch {
    throw new LttError('not_found', `failed to stat log file for worker "${name}"`);
  }

  const maxBytes = 1024 * 1024;
  const start = Math.max(0, stat.size - maxBytes);
  const readLen = stat.size - start;

  const buf = Buffer.alloc(readLen);
  const fd = openSync(logPath, 'r');
  try {
    readSync(fd, buf, 0, readLen, start);
  } finally {
    closeSync(fd);
  }

  const content = buf.toString('utf8');
  let allLines = content.split(/\r?\n/);
  if (allLines.length && allLines[allLines.length - 1] === '') {
    allLines.pop();
  }

  if (start > 0 && allLines.length > 0) {
    allLines.shift();
  }

  const resultLines = allLines.slice(-count);
  return {
    name,
    lines: resultLines,
    total: allLines.length,
  };
}
