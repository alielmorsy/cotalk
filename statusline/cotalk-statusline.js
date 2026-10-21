// self-contained: copied to $COTALK_HOME by `cotalk statusline`
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { spawnSync } from 'node:child_process';

const home = process.env.COTALK_HOME || join(homedir(), '.cotalk');
const port = process.env.COTALK_PORT || '7878';

async function readStdin() {
  return new Promise((resolve) => {
    let s = '';
    const done = () => resolve(s);
    setTimeout(done, 500).unref();
    process.stdin.on('data', d => s += d).on('end', done).on('error', done);
  });
}

// same identity rules as lib/client.js findConfig (only workspace + agent needed here)
function findConfig(dir) {
  const tool = process.env.CLAUDECODE === '1' ? 'claude' : 'agy';
  const envAgent = process.env.COTALK_TOOL && process.env.COTALK_TOOL !== tool ? '' : process.env.COTALK_AGENT; // identity meant for another tool
  for (;;) {
    let text = null;
    try { text = readFileSync(join(dir, '.cotalk.json'), 'utf8'); } catch {}
    if (text !== null) {
      let file;
      try { file = JSON.parse(text); } catch { return null; }
      const agent = envAgent || file?.agent;
      return file?.workspace && typeof agent === 'string' && /^[a-z0-9][a-z0-9_-]{0,31}$/i.test(agent) && agent.toLowerCase() !== 'user'
        ? { workspace: file.workspace, agent } : null;
    }
    const up = dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

async function main() {
  const input = await readStdin();
  let j = {};
  try { j = JSON.parse(input); } catch {}
  const cwd = j.cwd || j.workspace?.current_dir || process.cwd();

  let prev = '';
  if (process.env.CLAUDECODE === '1') {
    try {
      const cmd = JSON.parse(readFileSync(join(home, 'config.json'), 'utf8')).prevStatusLine?.claude;
      // spawnSync keeps stdout when the command exits without reading stdin (EPIPE on Linux, e.g. `echo`)
      if (cmd) prev = (spawnSync(cmd, { shell: true, input, timeout: 2000, encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] }).stdout || '').trim();
    } catch {}
  }

  let ours = '';
  const cfg = findConfig(cwd);
  if (cfg?.workspace && cfg?.agent) {
    const tag = `[${cfg.agent}@${cfg.workspace}]`;
    ours = `${tag} ⚫ offline`;
    try {
      const token = readFileSync(join(home, 'token'), 'utf8').trim();
      const q = new URLSearchParams({ workspace: cfg.workspace, agent: cfg.agent, mode: 'peek' });
      const res = await fetch(`http://127.0.0.1:${port}/api/unread?${q}`, { headers: { 'x-cotalk-token': token }, signal: AbortSignal.timeout(800) });
      if (res.ok) {
        const d = await res.json();
        ours = `${tag} 📬${d.summary.total} ⏳${d.incoming}`;
      }
    } catch {}
  }
  const out = [prev, ours].filter(Boolean).join(' ');
  if (out) process.stdout.write(out + '\n');
}

main().catch(() => {}).finally(() => process.exit(0));
