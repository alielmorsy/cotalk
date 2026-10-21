import { findConfig, api, isUp, readStdinJson } from '../lib/client.js';
import { describeEvents, URGENT_TYPES } from '../lib/format.js';

let out = '';
try {
  const input = await readStdinJson();
  const found = input.stop_hook_active === true ? null : findConfig(input.cwd || process.cwd(), process.env, 'claude');
  if (found?.config.agent && await isUp()) {
    const { workspace, agent } = found.config;
    const n = await api('GET', '/api/unread', { query: { workspace, agent, mode: 'notify' } });
    const urgent = n.events.filter(e => URGENT_TYPES.includes(e.type));
    if (urgent.length) {
      const reason = `let-them-talk: peers need you before you stop:\n${describeEvents(urgent, 10)}\n`
        + 'Handle them now (ltt_inbox, then ltt_respond or ltt_requests), or tell the user why you are leaving them, then stop.';
      out = JSON.stringify({ decision: 'block', reason: reason.slice(0, 9000) });
    }
  }
} catch {}
process.stdout.write(out); // no process.exit(): on Windows it can hit a libuv assert (win/async.c) after fetch; the loop drains on its own
