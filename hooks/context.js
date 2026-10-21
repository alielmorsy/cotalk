import { unreadLine } from '../lib/format.js';

// Roster folder, but this session has no identity (no LTT_AGENT).
// A desktop app (Codex, Antigravity) cannot be relaunched with LTT_AGENT, so it names itself: MCP tools take workspace/agent as arguments.
export const noRoleText = (roles, tool = 'claude') => `let-them-talk: this folder has roles ${roles.join(', ')}, but this session has none. `
  + `Relaunch with \`ltt run <role> -- ${tool}\` (or run agy workers with \`ltt worker <role>\`). `
  + 'In a desktop app you cannot relaunch: ask the user which role you are, then pass that workspace/agent on every ltt_* call and call ltt_register.';

// Session context text from a POST /api/register response; shared by the Claude and agy hooks.
export function sessionContext(r, { workspace, agent, role = '' }, { lead = true } = {}) {
  const peers = r.peers.filter(p => p.agent !== agent)
    .map(p => `- ${p.agent} — ${p.role || 'no role'} [${p.status}, ${p.tool}] owns: ${p.owns?.length ? p.owns.join(', ') : '-'}`);
  const keys = r.board.slice(0, 30).map(e => e.key).join(', ');
  const waiting = r.incoming.slice(0, 10).map(q => `- #${q.id} ${q.kind} from ${q.from}: ${q.title}`);
  return [
    `let-them-talk: you are agent "${agent}" in workspace "${workspace}" (${role || 'no role'}). Pass workspace="${workspace}" agent="${agent}" on every ltt_* tool call. Follow the using-let-them-talk skill.`,
    'Peers:', ...(peers.length ? peers : ['(none yet)']),
    `Board (${r.board.length} entries): ${keys || '(empty)'}`,
    'Waiting on you:', ...(waiting.length ? waiting : ['(nothing)']),
    unreadLine(r.unread),
    ...(!lead || process.env.LTT_WORKER === '1' ? [] : [
      'To have agy do work, start headless agy workers yourself with the ltt-lead skill (it asks the user first). Never ask the user to open an agy session.',
    ]),
  ].join('\n');
}
