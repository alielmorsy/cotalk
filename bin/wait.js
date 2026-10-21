// cotalk wait: blocks (no tokens) until a peer needs this agent, prints what happened, exits.
// Run it as a background task in a tool without an idle wake (agy): its exit wakes the agent for one short turn.
import { findConfig, api, ensureDaemon, POLL_S } from '../lib/client.js';
import { describeEvents, URGENT_TYPES } from '../lib/format.js';

export async function main(cmd, rawArgs) {
  const wi = rawArgs.indexOf('--workspace');
  const found = findConfig(process.cwd());
  const workspace = (wi >= 0 && rawArgs[wi + 1]) || found?.config.workspace;
  const agent = found?.config.agent;
  if (!workspace || !agent) throw new Error('no identity: run inside a session/folder with .cotalk.json and an agent (COTALK_AGENT)');
  if (!(await ensureDaemon())) throw new Error('daemon not running');
  for (let i = 0; i < 50; i++) { // ~3.3 h of POLL_S polls, then exit so the agent re-arms
    // holder per agent: a re-armed wait supersedes an orphan from a dead one
    const w = await api('GET', '/api/wait', {
      query: { workspace, agent, timeout: POLL_S, holder: `wait:${workspace}/${agent}`, urgent: 1 },
      timeoutMs: (POLL_S + 10) * 1000,
    });
    if (w.result === 'superseded') return console.log('cotalk: another wait took over.');
    if (w.result !== 'event') continue;
    const n = await api('GET', '/api/unread', { query: { workspace, agent, mode: 'notify' } });
    const urgent = n.events.filter(e => URGENT_TYPES.includes(e.type));
    if (!urgent.length) continue;
    return console.log(`cotalk: a peer needs you:\n${describeEvents(urgent, 10)}\nCall cotalk_inbox and handle it, then start \`cotalk wait\` in the background again.`);
  }
  console.log('cotalk: nothing yet. Start `cotalk wait` in the background again.');
}
