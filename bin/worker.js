// ltt worker: a headless agy (stream-json) kept alive as a worker; peers' tasks/questions are pushed in as new turns.
import { spawn, spawnSync } from 'node:child_process';
import { readFileSync, appendFileSync, mkdirSync, openSync, closeSync, writeFileSync, unlinkSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { findConfig, api, ensureDaemon, home, base, readToken, POLL_S } from '../lib/client.js';
import { describeEvents, URGENT_TYPES, LTT_ON_PATH } from '../lib/format.js';

const NAME = /^[a-z0-9][a-z0-9_-]{0,31}$/i;
const LTT = fileURLToPath(new URL('./ltt.js', import.meta.url));

export function parseArgs(rawArgs) {
  const dash = rawArgs.indexOf('--');
  const own = dash < 0 ? rawArgs : rawArgs.slice(0, dash);
  const o = { name: undefined, role: undefined, owns: undefined, workspace: undefined, yolo: false, detach: false, chat: false,
    extra: dash < 0 ? [] : rawArgs.slice(dash + 1) };
  for (let i = 0; i < own.length; i++) {
    const a = own[i];
    if (a === '--yolo' || a === '--detach' || a === '--chat' || a === '--ask') o[a.slice(2)] = true;
    else if (a === '--role' || a === '--owns' || a === '--workspace') {
      if (own[i + 1] === undefined) throw new Error(`${a} needs a value`);
      o[a.slice(2)] = own[++i];
    } else if (a.startsWith('-')) throw new Error(`unknown option ${a}`);
    else if (o.name === undefined) o.name = a;
    else throw new Error(`unexpected argument ${a}`);
  }
  if (o.owns !== undefined) o.owns = o.owns.split(',').map(s => s.trim()).filter(Boolean);
  return o;
}

export const agyArgs = ({ yolo, extra = [] }) => ['--input-format', 'stream-json', '--output-format', 'stream-json',
  ...(yolo ? ['--dangerously-skip-permissions', '--sandbox'] : []), ...extra, '-p='];

export const turnLine = (text) => JSON.stringify({ event: 'user', message: { content: text } }) + '\n';

// --ask: the task's sender (a Claude lead that started this worker) asks the human for it.
// Without it the human started the worker, so every question goes to the human, never to the lead.
// ponytail: prompt-only, the daemon still accepts any `to`; enforce in createRequest if agy ignores it
const ASK_SENDER = 'Never send requests to "user", even when a task says to. Send every question, including ones for the human, to the agent that sent you the task '
  + '(its `from`); start the title with "[user] " when only the human can answer. That agent asks the human and answers you. ';
const ASK_USER = 'Send every question (decisions, approvals, design) to "user", the human, never to "lead"; ask a peer only about code that peer owns. ';
const ASK_CHAT = 'The human is watching this chat: ask them every question (decisions, approvals, design) here directly, '
  + 'never with ltt_request to "user" or "lead"; ask a peer only about code that peer owns. ';

export const bootstrapPrompt = ({ workspace, name, role, ask }) =>
  `You are let-them-talk worker "${name}"${role ? ` (role: ${role})` : ''} in workspace "${workspace}". ` +
  `Pass workspace "${workspace}" and agent "${name}" on every ltt_* tool call. Follow the using-let-them-talk skill. ${LTT_ON_PATH} ` +
  'Call ltt_inbox now and handle what is addressed to you: claim a task, do it, then ltt_respond done with a summary. ' +
  (ask ? ASK_SENDER : ASK_USER) + 'If there is nothing for you, reply "ready".';

// --chat: a normal interactive agy (nobody pushes to it), so it parks on a background `ltt wait` and its exit wakes it
export const chatArgs = ({ workspace, name, role, ask, yolo, extra = [] }) => ['-i',
  `You are let-them-talk agent "${name}"${role ? ` (role: ${role})` : ''} in workspace "${workspace}". ` +
  `Pass workspace "${workspace}" and agent "${name}" on every ltt_* tool call. Follow the using-let-them-talk skill. ${LTT_ON_PATH} ` +
  'Call ltt_inbox now and handle what is addressed to you: claim a task, do it, then ltt_respond done with a summary. ' +
  (ask ? ASK_SENDER : ASK_CHAT) + 'When you have no task, run `ltt wait` as a BACKGROUND task (not foreground, not ltt_wait) ' +
  'and end your turn; when it finishes you are woken, so handle the task the same way and start `ltt wait` in the background again.',
  ...(yolo ? ['--dangerously-skip-permissions'] : []), ...extra];

export const pushPrompt = (events, ask) =>
  `let-them-talk: new for you:\n${describeEvents(events, 10)}\nCall ltt_inbox and handle them (claim → do → done with a summary). `
  + (ask ? 'Questions go to the task\'s sender ("[user] " title when only the human can answer). ' : 'Questions go to "user", not "lead". ')
  + LTT_ON_PATH;

const errText = (e) => (typeof e === 'string' ? e : e?.message ?? JSON.stringify(e));

export function render(ev) {
  if (ev?.event === 'result') {
    const r = ev.result || {};
    return r.status === 'SUCCESS' ? `✓ turn done (${r.usage?.total_tokens ?? '?'} tokens)` : `✗ ${errText(r.error ?? r.status)}`;
  }
  const s = ev?.event === 'step_update' ? ev.step_update : null;
  if (!s) return null;
  if (s.step_type === 'agent_response' && s.text_delta) return s.text_delta;
  if (s.step_type === 'tool' && s.state === 'ACTIVE') {
    const tool = s.tool_name ?? s.tool_info?.name ?? 'tool';
    let p = s.tool_info?.parameters;
    if (typeof p === 'string') try { p = JSON.parse(p); } catch { p = null; }
    // agy tool params are PascalCase (spike saw `Arguments`); ToolName is the likely key — unknown → just the agy tool name
    const inner = tool === 'call_mcp_tool' ? p?.ToolName ?? p?.toolName ?? p?.tool_name ?? p?.name : null;
    return `  → ${tool}${typeof inner === 'string' ? ` ${inner}` : ''}`;
  }
  return null;
}

export async function main(cmd, rawArgs) {
  const o = parseArgs(rawArgs);
  if (!NAME.test(o.name ?? '') || o.name.toLowerCase() === 'user')
    throw new Error(`usage: ltt worker <name> [--role R] [--owns "a/**"] [--workspace W] [--ask] [--yolo] [--detach] [--chat] [-- <agy args...>] (<name> must match ${NAME} and not be "user")`);
  const { name } = o;
  // started from a Claude session's shell (CLAUDECODE=1): that session asks the human; started by the human: never
  if (process.env.CLAUDECODE === '1') o.ask = true;
  const found = findConfig(process.cwd(), { LTT_AGENT: name });
  const workspace = o.workspace ?? found?.config.workspace;
  if (!NAME.test(workspace ?? '')) throw new Error('no workspace: pass --workspace or run inside a folder with .ltt.json');
  const mine = found?.config.agent === name; // pre-roster findConfig returns the file's own agent
  const role = o.role ?? (mine ? found.config.role : undefined) ?? '';
  const owns = o.owns ?? (mine ? found.config.owns : undefined) ?? [];

  const mcpPath = process.env.LTT_AGY_MCP_CONFIG || join(os.homedir(), '.gemini', 'config', 'mcp_config.json');
  let servers = null;
  try { servers = JSON.parse(readFileSync(mcpPath, 'utf8')).mcpServers; } catch {}
  if (!servers?.['let-them-talk']) throw new Error(`agy has no let-them-talk MCP server (${mcpPath}): run \`ltt agy-mcp\` first`);

  if (!(await ensureDaemon())) throw new Error(`daemon failed to start (see ${join(home(), 'daemon.log')})`);
  if (o.chat && o.detach) throw new Error('--chat needs your terminal: it cannot be combined with --detach');
  await api('POST', '/api/register', { body: { workspace, agent: name, role, owns, cwd: process.cwd(), tool: o.chat ? 'agy' : 'agy-worker', session_id: '' } });

  if (o.chat) { // interactive agy owns the console; the runner just gives it identity and a first prompt
    const bin = process.env.LTT_AGY_BIN || 'agy';
    const env = { ...process.env, LTT_AGENT: name, LTT_ROLE: role, LTT_OWNS: owns.join(','), LTT_TOOL: 'agy' };
    delete env.LTT_WORKER;
    for (const s of ['SIGINT', 'SIGTERM']) process.on(s, () => {}); // Ctrl+C belongs to the child
    const args = chatArgs({ workspace, name, role, ask: o.ask, yolo: o.yolo, extra: o.extra });
    const r = bin.endsWith('.js') ? spawnSync(process.execPath, [bin, ...args], { stdio: 'inherit', env }) : spawnSync(bin, args, { stdio: 'inherit', env });
    if (r.error) throw new Error(r.error.code === 'ENOENT' ? `agy not found (${bin}); put agy on PATH or set LTT_AGY_BIN to its path` : r.error.message);
    process.exitCode = r.status ?? 1;
    return;
  }

  const logDir = join(home(), 'workers'); // never cwd: the log may quote peers' content, and the project stays clean
  mkdirSync(logDir, { recursive: true });
  const logPath = join(logDir, `${workspace}.${name}.log`);
  const legacyLogPath = join(logDir, `${workspace}-${name}.log`);

  if (o.detach) {
    const dash = rawArgs.indexOf('--');
    const args = rawArgs.filter((a, i) => !(a === '--detach' && (dash < 0 || i < dash)));
    const fd = openSync(logPath, 'a');
    const child = spawn(process.execPath, [LTT, 'worker', ...args], {
      detached: true, stdio: ['ignore', fd, fd], windowsHide: true, env: { ...process.env, LTT_WORKER_DETACHED: '1' },
    });
    closeSync(fd);
    child.unref();
    console.log(`worker ${name} started (pid ${child.pid}), log: ${logPath}`);
    return;
  }
  const detached = process.env.LTT_WORKER_DETACHED === '1'; // stdout already is the log; no stdin
  const pidPath = join(logDir, `${workspace}.${name}.json`);
  const stopPath = join(logDir, `${workspace}.${name}.stop`);
  try { unlinkSync(stopPath); } catch {}

  const pidInfo = {
    name,
    workspace,
    pid: process.pid,
    role,
    owns,
    cwd: process.cwd(),
    yolo: !!o.yolo,
    startedAt: Date.now(),
    logFile: logPath,
  };
  try { writeFileSync(pidPath, JSON.stringify(pidInfo, null, 2) + '\n', 'utf8'); } catch {}
  const cleanupPid = () => {
    try {
      const cur = JSON.parse(readFileSync(pidPath, 'utf8'));
      if (cur?.pid === process.pid) unlinkSync(pidPath);
    } catch {}
    try { unlinkSync(stopPath); } catch {}
  };
  process.on('exit', cleanupPid);

  const stopInterval = setInterval(() => {
    if (existsSync(stopPath)) {
      try { unlinkSync(stopPath); } catch {}
      agy.stdin.end();
    }
  }, 1000);
  stopInterval.unref();

  let midLine = false; // agent text may arrive as deltas without newlines
  const print = (s, delta = false) => {
    const text = (midLine && !delta ? '\n' : '') + s + (delta ? '' : '\n');
    midLine = delta && !s.endsWith('\n');
    process.stdout.write(text);
    if (!detached) {
      try { appendFileSync(logPath, text); } catch {}
      try { appendFileSync(legacyLogPath, text); } catch {}
    }
  };

  const bin = process.env.LTT_AGY_BIN || 'agy';
  const env = { ...process.env, LTT_AGENT: name, LTT_ROLE: role, LTT_OWNS: owns.join(','), LTT_WORKER: '1', LTT_TOOL: 'agy' };
  delete env.LTT_WORKER_DETACHED;
  const opts = { cwd: process.cwd(), env, stdio: 'pipe', windowsHide: true };
  const agy = bin.endsWith('.js') ? spawn(process.execPath, [bin, ...agyArgs(o)], opts) : spawn(bin, agyArgs(o), opts);
  const closed = new Promise(resolve => {
    // exit, not only close: a grandchild of agy may keep its stdio pipes open forever (first one wins, resolve is idempotent)
    agy.on('exit', (code) => resolve(code));
    agy.on('close', (code) => resolve(code));
    agy.on('error', (e) => {
      print(e.code === 'ENOENT' ? `agy not found (${bin}); put agy on PATH or set LTT_AGY_BIN to its path` : `⚠ ${e.message}`);
      resolve(1);
    });
  });
  agy.stdin.on('error', () => {}); // EPIPE after agy died; the close handler reports it

  let inflight = 0, exited = false, onIdle = null;
  const ac = new AbortController();
  const idle = () => (inflight === 0 || exited ? Promise.resolve() : new Promise(r => { onIdle = r; }));
  const send = (text) => {
    if (exited || agy.stdin.writableEnded) return;
    inflight++; // agy queues turns written mid-turn and runs them in order, one result each
    agy.stdin.write(turnLine(text));
    if (!detached) {
      try { appendFileSync(logPath, `» ${text}\n`); } catch {}
      try { appendFileSync(legacyLogPath, `» ${text}\n`); } catch {}
    }
  };

  const shown = new Set();
  async function showQuestions() {
    const { workspaces } = await api('GET', '/api/state');
    for (const r of workspaces.find(w => w.workspace === workspace)?.requests ?? [])
      if (r.from === name && r.to === 'user' && !shown.has(r.id)) {
        shown.add(r.id);
        print(`❓ #${r.id} ${r.title} — answer: /reply ${r.id} <text>`);
      }
  }

  createInterface({ input: agy.stdout }).on('line', (line) => {
    let ev;
    try { ev = JSON.parse(line); } catch { if (line.trim()) print(line); return; }
    if (!ev || typeof ev !== 'object') return; // e.g. `null`: nothing to render, and must not throw here
    const out = render(ev);
    if (out !== null) print(out, ev.step_update?.step_type === 'agent_response');
    if (ev.event !== 'result') return;
    inflight = Math.max(0, inflight - 1);
    if (!inflight) { onIdle?.(); onIdle = null; }
    showQuestions().catch(() => {});
  });
  createInterface({ input: agy.stderr }).on('line', (line) => { if (line.trim()) print(`⚠ ${line}`); });

  async function waitOnce() { // own fetch (not api()) so the pending long-poll can be aborted when agy exits
    const url = new URL('/api/wait', base());
    url.search = new URLSearchParams({ workspace, agent: name, timeout: POLL_S, holder: `worker:${workspace}/${name}`, urgent: 1 });
    const res = await fetch(url, {
      headers: { 'x-ltt-token': readToken() || '' },
      signal: AbortSignal.any([ac.signal, AbortSignal.timeout((POLL_S + 10) * 1000)]),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }

  async function pushLoop() {
    while (!exited) {
      try {
        const w = await waitOnce();
        if (w.result === 'superseded') return print(`⚠ another runner for ${name} took over; no more pushes here`);
        if (w.result !== 'event') continue;
        await idle(); // never interrupt a running turn; events that arrive meanwhile go into the same push
        if (exited) return;
        const n = await api('GET', '/api/unread', { query: { workspace, agent: name, mode: 'notify' } });
        const urgent = n.events.filter(e => URGENT_TYPES.includes(e.type));
        if (urgent.length) send(pushPrompt(urgent, o.ask));
      } catch {
        if (!exited) await new Promise(r => setTimeout(r, 2000).unref());
      }
    }
  }

  async function onInput(line) {
    if (!line) return;
    if (line === '/quit') return agy.stdin.end();
    if (line.startsWith('/reply')) {
      const m = /^\/reply\s+#?(\d+)\s+(.+)$/s.exec(line);
      if (!m) return print('usage: /reply <id> <text>');
      const { request } = await api('POST', '/api/respond', { body: { workspace, id: Number(m[1]), response: m[2] } });
      return print(`#${request.id} ${request.status}`);
    }
    send(line);
  }

  send(bootstrapPrompt({ workspace, name, role, ask: o.ask }));
  pushLoop();
  const rl = detached ? null : createInterface({ input: process.stdin });
  rl?.on('line', (line) => onInput(line.trim()).catch(e => print(`⚠ ${e.message}`)));
  const onSignal = () => agy.kill();
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  const code = await closed;
  exited = true;
  ac.abort();
  onIdle?.();
  rl?.close();
  process.stdin.destroy();
  process.off('SIGINT', onSignal);
  process.off('SIGTERM', onSignal);
  cleanupPid();
  print(`agy exited (${code})`);
  process.exitCode = code ?? 1;
  // no immediate process.exit(): on Windows it can trip a libuv assert right after fetch (hooks/wake.js); this is only a backstop
  setTimeout(() => process.exit(), 2000).unref();
}
