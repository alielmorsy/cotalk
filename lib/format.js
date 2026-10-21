export const URGENT_TYPES = ['question.new', 'task.new', 'request.updated'];

const KEY = { 'question.new': 'questions', 'task.new': 'tasks', 'request.updated': 'updates', 'request.claimed': 'updates', 'entry.updated': 'board', 'agent.joined': 'joined' };

export function summarize(events) {
  const s = { total: events.length, questions: 0, tasks: 0, updates: 0, board: 0, joined: 0 };
  for (const e of events) if (KEY[e.type]) s[KEY[e.type]]++;
  return s;
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

export function unreadLine(s) {
  if (!s || !s.total) return '📭 no unread';
  const parts = [];
  if (s.questions) parts.push(plural(s.questions, 'question'));
  if (s.tasks) parts.push(plural(s.tasks, 'task'));
  if (s.updates) parts.push(plural(s.updates, 'request update'));
  if (s.board) parts.push(plural(s.board, 'board update'));
  if (s.joined) parts.push(`${s.joined} peer${s.joined === 1 ? '' : 's'} joined`);
  return `📬 ${s.total} unread: ${parts.join(', ')} — call ltt_inbox`;
}

export function describeEvents(events, max = 20) {
  const lines = events.slice(0, max).map(e => `- #${e.id} ${e.summary}`);
  if (events.length > max) lines.push(`- …and ${events.length - max} more`);
  return lines.join('\n');
}

// agy kept hunting for and running let-them-talk's source instead of the `ltt` on PATH
export const LTT_ON_PATH = '`ltt` is installed on PATH: run it exactly as written (e.g. `ltt status`). '
  + 'Never search for, read or run let-them-talk\'s source code or plugin files.';

// `ltt usage`: one block per tool, windows aligned, remaining % first
export function formatUsage(u) {
  const tools = ['agy', 'claude'].map(name => [name, u[name]]);
  const width = Math.max(0, ...tools.flatMap(([, t]) => (t.windows ?? []).map(w => w.label.length)));
  return tools.flatMap(([name, t]) => [name, ...(t.ok
    ? t.windows.map(w => `  ${w.label.padEnd(width)}  ${String(w.remaining).padStart(3)}% left  resets ${w.resets}`)
    : [`  unavailable: ${t.error}`])]).join('\n');
}
