// Claude-only asyncRewake hook: long-polls, exits 2 (stderr = wake message) when a peer needs this idle session.
import { findConfig, api, isUp, readStdinJson, POLL_S } from '../lib/client.js';
import { describeEvents, URGENT_TYPES } from '../lib/format.js';

if (process.env.CLAUDECODE !== '1') process.exit(0); // agy may not support async hooks; never block it

try {
  const input = await readStdinJson();
  const found = findConfig(input.cwd || process.cwd(), process.env, 'claude');
  if (found?.config.agent && await isUp()) {
    const { workspace, agent } = found.config;
    for (let i = 0; i < 50; i++) { // ~3.3 h of POLL_S polls
      try { process.kill(process.ppid, 0); } catch { break; } // parent session gone: stop waiting
      // holder per agent, not per session: the newest wake supersedes orphans from dead sessions
      const w = await api('GET', '/api/wait', {
        query: { workspace, agent, timeout: POLL_S, holder: `${workspace}/${agent}`, urgent: 1 },
        timeoutMs: (POLL_S + 10) * 1000,
      });
      if (w.result === 'superseded') break;
      if (w.result !== 'event') continue;
      const n = await api('GET', '/api/unread', { query: { workspace, agent, mode: 'notify' } });
      const urgent = n.events.filter(e => URGENT_TYPES.includes(e.type));
      if (urgent.length) {
        process.stderr.write(`let-them-talk: a peer needs you:\n${describeEvents(urgent, 10)}\nCall ltt_inbox and handle it.`);
        process.exitCode = 2;
        break;
      }
    }
  }
} catch { process.exitCode = 0; }
// no process.exit() here: on Windows it hits a libuv assert (win/async.c UV_HANDLE_CLOSING) after fetch; let the loop drain
