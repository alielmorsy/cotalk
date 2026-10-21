import { findConfig, api, ensureDaemon, readStdinJson, toolName } from '../lib/client.js';
import { sessionContext, noRoleText } from './context.js';

let out = '';
try {
  const input = await readStdinJson();
  const emit = (text) => out = JSON.stringify({
    hookSpecificOutput: { hookEventName: input.hook_event_name || 'SessionStart', additionalContext: text.slice(0, 9000) },
  });
  const found = findConfig(input.cwd || process.cwd(), process.env, 'claude');
  if (!found) {
    emit('cotalk: this folder has no .cotalk.json, so this session is not on the shared board. If the user wants it to coordinate with other sessions, use the cotalk-setup skill.');
  } else if (!found.config.agent) {
    emit(noRoleText(found.config.roles));
  } else if (!(await ensureDaemon())) {
    emit('cotalk: daemon unreachable, board unavailable this session (try `cotalk start`).');
  } else {
    const { workspace, agent, role = '', owns = [] } = found.config;
    const r = await api('POST', '/api/register', {
      body: { workspace, agent, role, owns, cwd: found.dir, tool: toolName(), session_id: input.session_id || '' },
      timeoutMs: 4000,
    });
    emit(sessionContext(r, found.config));
  }
} catch {}
process.stdout.write(out); // no process.exit(): on Windows it can hit a libuv assert (win/async.c) after fetch; the loop drains on its own
