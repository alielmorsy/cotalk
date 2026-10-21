#!/usr/bin/env node
// Test double for `agy --input-format stream-json --output-format stream-json -p=` (event shapes from the 2026-09-30 spike).
// FAKE_AGY_LOG: file that gets each turn's content (one JSON string per line). FAKE_AGY_DELAY_MS: delay before each result.
// FAKE_AGY_NULL=1: emit a `null` JSON line first. FAKE_AGY_GRANDCHILD=<pidfile>: leave a sleeper holding stdout/stderr.
// A turn "env" answers with this process's COTALK_TOOL.
import { appendFileSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

if (!process.argv.includes('-p=')) process.exit(0); // `node --test` also runs test/**/*.js: don't hang on its stdin

const out = (ev) => process.stdout.write(JSON.stringify(ev) + '\n');
const delay = Number(process.env.FAKE_AGY_DELAY_MS) || 0;
let queue = Promise.resolve(), step = 0;

if (process.env.FAKE_AGY_GRANDCHILD) {
  const g = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { detached: true, stdio: ['ignore', 'inherit', 'inherit'], windowsHide: true });
  writeFileSync(process.env.FAKE_AGY_GRANDCHILD, String(g.pid));
  g.unref();
}
out({ event: 'init', conversation_id: 'fake-conversation' });
if (process.env.FAKE_AGY_NULL) out(null);
createInterface({ input: process.stdin }).on('line', (line) => {
  if (!line.trim()) return;
  const content = String(JSON.parse(line).message?.content ?? '');
  if (process.env.FAKE_AGY_LOG) appendFileSync(process.env.FAKE_AGY_LOG, JSON.stringify(content) + '\n');
  if (content === 'crash') process.exit(7);
  queue = queue.then(async () => { // turns run one at a time, like agy's queue
    out({ event: 'step_update', step_update: { step_index: step++, state: 'DONE', step_type: 'user_input' } });
    out({ event: 'step_update', step_update: { step_index: step++, state: 'DONE', step_type: 'agent_response', text_delta: content === 'env' ? `COTALK_TOOL=${process.env.COTALK_TOOL}` : `ack: ${content.slice(0, 40)}` } });
    if (delay) await new Promise(r => setTimeout(r, delay));
    out({ event: 'result', result: { status: 'SUCCESS', response: 'ack', usage: { total_tokens: 1 } } });
  });
});
// stdin end: the queue drains, then nothing is left and the process exits 0
