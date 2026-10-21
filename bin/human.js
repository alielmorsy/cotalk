// cotalk inbox | reply | ask | task: the human (`user`) reads and answers requests without a model session
import { join } from 'node:path';
import { findConfig, api, ensureDaemon, home } from '../lib/client.js';

const USAGE = 'usage: cotalk inbox | reply <id> <text...> [--reject] | ask <agent> <title...> [--body B] | task <agent> <title...> [--body B]  [--workspace W]';
const die = (msg) => { console.error(msg); process.exit(1); };

function parse(rawArgs) {
  const pos = [], o = {};
  for (let i = 0; i < rawArgs.length; i++) {
    const a = rawArgs[i];
    if (a === '--reject') o.reject = true;
    else if ((a === '--body' || a === '--workspace') && i + 1 < rawArgs.length) o[a.slice(2)] = rawArgs[++i];
    else pos.push(a);
  }
  return { pos, ...o };
}

export async function main(cmd, rawArgs) {
  const { pos, body, workspace: w, reject } = parse(rawArgs);
  const workspace = w || findConfig(process.cwd())?.config.workspace;
  if (!workspace) die('no workspace: pass --workspace or run inside a folder with .cotalk.json');
  if ((cmd === 'reply' && (!/^\d+$/.test(pos[0] ?? '') || (pos.length < 2 && !reject))) || ((cmd === 'ask' || cmd === 'task') && pos.length < 2)) die(USAGE);
  // once a fetch ran, never process.exit(): on Windows it can abort in libuv (UV_HANDLE_CLOSING) while the socket closes
  try { await run(cmd, workspace, { pos, body, reject }); } catch (e) {
    console.error(`cotalk ${cmd}: ${e.message}`);
    process.exitCode = 1;
  }
}

async function run(cmd, workspace, { pos, body, reject }) {
  if (!(await ensureDaemon())) throw new Error(`daemon failed to start (see ${join(home(), 'daemon.log')})`);

  if (cmd === 'inbox') {
    const list = async (box) => (await api('GET', '/api/requests', { query: { workspace, agent: 'user', box } })).requests;
    const [incoming, outgoing] = await Promise.all([list('incoming'), list('outgoing')]);
    const lines = ['Waiting on you:'];
    for (const r of incoming) {
      lines.push(`#${r.id} ${r.kind} from ${r.from}: ${r.title}`);
      if (r.body) lines.push(`  ${r.body.split('\n')[0]}`);
    }
    if (!incoming.length) lines.push('(nothing)');
    lines.push('Your requests:');
    for (const r of outgoing) {
      const answered = ['answered', 'done', 'rejected'].includes(r.status) && r.response;
      lines.push(`#${r.id} → ${r.to} [${r.status}] ${r.title}${answered ? ` — ${r.response}` : ''}`);
    }
    if (!outgoing.length) lines.push('(nothing)');
    return console.log(lines.join('\n'));
  }
  if (cmd === 'reply') {
    const id = Number(pos[0]);
    const { request } = await api('POST', '/api/respond', {
      body: { workspace, id, response: pos.slice(1).join(' '), ...(reject ? { action: 'reject' } : {}) },
    });
    return console.log(`#${id} ${request.status}`);
  }
  const [to, ...title] = pos;
  const { request } = await api('POST', '/api/request', {
    body: { workspace, to, kind: cmd === 'ask' ? 'question' : 'task', title: title.join(' '), ...(body !== undefined ? { body } : {}) },
  });
  console.log(`#${request.id} sent to ${to}`);
}
