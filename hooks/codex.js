// Codex hooks: `node hooks/codex.js session-start|user-prompt|stop`. Fail open: always exit 0.
// Codex 0.115 fires SessionStart and Stop only; user-prompt is for newer Codex versions.
import { findConfig, api, isUp, ensureDaemon, readStdinJson } from '../lib/client.js';
import { unreadLine, describeEvents, URGENT_TYPES } from '../lib/format.js';
import { sessionContext, noRoleText } from './context.js';

let out = '';
try {
  const event = process.argv[2];
  const input = await readStdinJson();
  const found = findConfig(input.cwd || process.cwd(), process.env, 'codex');
  const id = found?.config.agent ? found : null; // agent may be null for a multi-role folder
  const context = (name, text) => out = JSON.stringify({ hookSpecificOutput: { hookEventName: name, additionalContext: text.slice(0, 9000) } });
  const notify = () => api('GET', '/api/unread', { query: { workspace: id.config.workspace, agent: id.config.agent, mode: 'notify' } });

  if (event === 'session-start') {
    if (!id) context('SessionStart', found ? noRoleText(found.config.roles, 'codex')
      : 'let-them-talk: this folder has no .ltt.json, so this session is not on the shared board. If the user wants it to coordinate with other sessions, use the ltt-setup skill. To join, relaunch with `ltt run <role> -- codex`.');
    else if (!(await ensureDaemon())) context('SessionStart', 'let-them-talk: daemon unreachable, board unavailable this session (try `ltt start`).');
    else {
      const { workspace, agent, role = '', owns = [] } = id.config;
      const r = await api('POST', '/api/register', {
        body: { workspace, agent, role, owns, cwd: id.dir, tool: 'codex', session_id: input.session_id || '' }, timeoutMs: 4000,
      });
      context('SessionStart', sessionContext(r, id.config));
    }
  } else if (event === 'user-prompt' && id && await isUp()) {
    const n = await notify();
    if (n.summary.total) context('UserPromptSubmit', `let-them-talk: ${unreadLine(n.summary)}\n${describeEvents(n.events, 10)}`);
  } else if (event === 'stop' && id && input.stop_hook_active !== true && await isUp()) {
    // notify never repeats an event, so this blocks at most once per batch
    const urgent = (await notify()).events.filter(e => URGENT_TYPES.includes(e.type));
    if (urgent.length) {
      out = JSON.stringify({ decision: 'block', reason: (`let-them-talk: peers need you before you stop:\n${describeEvents(urgent, 10)}\n`
        + 'Handle them now (ltt_inbox, then ltt_respond or ltt_requests), or tell the user why you are leaving them, then stop.').slice(0, 9000) });
    }
  }
} catch { out = ''; }
process.stdout.write(out); // no process.exit(): on Windows it can hit a libuv assert (win/async.c) after fetch
