import { findConfig, api, isUp, readStdinJson } from '../lib/client.js';
import { unreadLine, describeEvents } from '../lib/format.js';

let out = '';
try {
  const input = await readStdinJson();
  const found = findConfig(input.cwd || process.cwd(), process.env, 'claude');
  if (found?.config.agent && await isUp()) {
    const { workspace, agent } = found.config;
    const n = await api('GET', '/api/unread', { query: { workspace, agent, mode: 'notify' } });
    if (n.summary.total) {
      const text = `cotalk: ${unreadLine(n.summary)}\n${describeEvents(n.events, 10)}`;
      out = JSON.stringify({
        hookSpecificOutput: { hookEventName: input.hook_event_name || 'UserPromptSubmit', additionalContext: text.slice(0, 9000) },
      });
    }
  }
} catch {}
process.stdout.write(out); // no process.exit(): on Windows it can hit a libuv assert (win/async.c) after fetch; the loop drains on its own
