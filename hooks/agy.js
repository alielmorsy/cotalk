// agy (Antigravity) hooks: `node hooks/agy.js pre-invocation|stop`. Prints one JSON object, always exits 0.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { findConfig, api, isUp, ensureDaemon, readStdinJson, home } from '../lib/client.js';
import { unreadLine, describeEvents, URGENT_TYPES, LTT_ON_PATH } from '../lib/format.js';
import { sessionContext, noRoleText } from './context.js';

let out = {};
try {
  const event = process.argv[2];
  const input = await readStdinJson();
  const found = findConfig(input.workspacePaths?.[0] || process.cwd(), process.env, 'agy');
  const say = text => out = { injectSteps: [{ ephemeralMessage: text.slice(0, 9000) }] };
  const notify = () => api('GET', '/api/unread', { query: { workspace: found.config.workspace, agent: found.config.agent, mode: 'notify' } });

  if (event === 'pre-invocation') {
    const marker = join(home(), 'agy-sessions', String(input.conversationId || 'default').replace(/[^\w-]/g, '_'));
    const first = !existsSync(marker);
    const mark = () => { mkdirSync(dirname(marker), { recursive: true }); writeFileSync(marker, ''); };
    if (!found?.config.agent) {
      if (first) {
        say(found ? noRoleText(found.config.roles, 'agy')
          : 'let-them-talk: this folder has no .ltt.json, so this session is not on the shared board. If the user wants it to coordinate with other sessions, use the ltt-setup skill.');
        mark();
      }
    } else {
      const { workspace, agent, role = '', owns = [] } = found.config;
      const reminder = `let-them-talk: you are "${agent}" in workspace "${workspace}"; pass workspace/agent on ltt_* calls. \`ltt\` is on PATH; never look for its source.`;
      if (first) {
        mark(); // before the daemon work: a failed start must not respawn on every model call
        if (await ensureDaemon()) {
          const r = await api('POST', '/api/register', {
            body: { workspace, agent, role, owns, cwd: found.dir, tool: process.env.LTT_WORKER === '1' ? 'agy-worker' : 'agy', session_id: input.conversationId || '' },
            timeoutMs: 4000,
          }).catch(() => null);
          // interactive agy is never woken from outside: it waits inside a turn, so peers' tasks show up in the chat the user watches
          const idleWait = process.env.LTT_WORKER === '1' ? '' : '\nWhen you have no task, wait for work without spending tokens: run `ltt wait` as a BACKGROUND task (not foreground, not ltt_wait) and end your turn. '
            + 'When it finishes you are woken: call ltt_inbox, claim the task, do it, ltt_respond done, then start `ltt wait` in the background again.\n'
            + 'The human is watching this chat: ask them every question (decisions, approvals, design) here directly, '
            + 'never with ltt_request to "user" or "lead"; ask a peer only about code that peer owns.';
          say(r ? `${sessionContext(r, found.config, { lead: false })}\n${LTT_ON_PATH}${idleWait}` : reminder);
        } else {
          say(`${reminder}\nlet-them-talk: daemon unreachable, board unavailable for now (try \`ltt start\`).`);
        }
      } else {
        const n = await isUp() ? await notify().catch(() => null) : null;
        say(n?.events.length ? `${reminder}\n${unreadLine(n.summary)}\n${describeEvents(n.events, 10)}` : reminder);
      }
    }
  } else if (event === 'stop' && found?.config.agent && await isUp()) {
    // notify never repeats an event, so this blocks at most once per batch
    const urgent = (await notify()).events.filter(e => URGENT_TYPES.includes(e.type));
    if (urgent.length) {
      out = {
        decision: 'continue',
        reason: (`let-them-talk: peers need you before you stop:\n${describeEvents(urgent, 10)}\n`
          + 'Handle them (ltt_inbox, then ltt_respond), or tell the user why you\'re leaving them, then stop.').slice(0, 9000),
      };
    }
  }
} catch { out = {}; }
process.stdout.write(JSON.stringify(out)); // no process.exit(): on Windows it can hit a libuv assert (win/async.c) after fetch
