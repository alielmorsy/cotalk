import test from 'node:test';
import assert from 'node:assert/strict';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseAgy, parseClaude, createUsage, runTool } from '../daemon/usage.js';

const FAKE = fileURLToPath(new URL('./fixtures/fake-usage.js', import.meta.url));

const AGY = [
  'Gemini Models\tWeekly Limit Remaining\t15%\t2026-09-30T17:48:23Z',
  'Gemini Models\tFive Hour Limit Remaining\t54%\t2026-09-30T20:04:58Z',
  'Claude and GPT models\tWeekly Limit Remaining\t100%\t2026-10-07T16:10:55Z',
  'Claude and GPT models\tFive Hour Limit Remaining\t100%\t2026-09-30T21:10:55Z',
].join('\n') + '\n';

const CLAUDE = `You are currently using your subscription to power your Claude Code usage

Current session: 10% used · resets Sep 30, 10pm (Africa/Cairo)
Current week (all models): 79% used · resets Oct 3, 1pm (Africa/Cairo)
Current week (Fable): 1% used · resets Oct 3, 1pm (Africa/Cairo)

What's contributing to your limits usage?
Approximate, based on local sessions on this machine — does not include other devices or claude.ai. Behaviors are independent characteristics, not a breakdown.

Last 24h · 3984 requests · 28 sessions
  84% of your usage came from subagent-heavy sessions
  66% of your usage was at >150k context
`;

test('parseAgy: one window per row, remaining % as a number', () => {
  assert.deepEqual(parseAgy(AGY), {
    ok: true,
    windows: [
      { label: 'Gemini Models · Weekly Limit', window: 'week', remaining: 15, resets: '2026-09-30T17:48:23Z' },
      { label: 'Gemini Models · Five Hour Limit', window: '5h', remaining: 54, resets: '2026-09-30T20:04:58Z' },
      { label: 'Claude and GPT models · Weekly Limit', window: 'week', remaining: 100, resets: '2026-10-07T16:10:55Z' },
      { label: 'Claude and GPT models · Five Hour Limit', window: '5h', remaining: 100, resets: '2026-09-30T21:10:55Z' },
    ],
  });
});

test('parseAgy: a window that is neither weekly nor five-hour has no window tag', () => {
  const r = parseAgy('Gemini Models\tMonthly Limit Remaining\t40%\t2026-10-30T00:00:00Z\n');
  assert.deepEqual(r.windows, [{ label: 'Gemini Models · Monthly Limit', remaining: 40, resets: '2026-10-30T00:00:00Z' }]);
});

test('parseAgy: space-aligned columns (as pasted in a terminal) parse the same', () => {
  const aligned = AGY.replaceAll('\t', '   ');
  assert.deepEqual(parseAgy(aligned), parseAgy(AGY));
});

test('parseClaude: used % becomes remaining %, breakdown section ignored', () => {
  assert.deepEqual(parseClaude(CLAUDE), {
    ok: true,
    windows: [
      { label: 'Current session', window: '5h', remaining: 90, resets: 'Sep 30, 10pm (Africa/Cairo)' },
      { label: 'Current week (all models)', window: 'week', remaining: 21, resets: 'Oct 3, 1pm (Africa/Cairo)' },
      { label: 'Current week (Fable)', window: 'week', remaining: 99, resets: 'Oct 3, 1pm (Africa/Cairo)' },
    ],
  });
});

test('parsers: unrecognized output is ok:false and quotes the first line', () => {
  const api = 'You are currently using an API key. /usage is not available.\nmore';
  assert.deepEqual(parseClaude(api), { ok: false, error: 'unrecognized output: You are currently using an API key. /usage is not available.' });
  assert.deepEqual(parseAgy(''), { ok: false, error: 'unrecognized output: (empty)' });
  assert.equal(parseAgy('Not logged in\n').ok, false);
});

// --- cache: one run per ttl, shared by concurrent callers ---

function counting(outputs) {
  const calls = [];
  const run = async (tool) => { calls.push(tool); const o = outputs[tool]; if (o instanceof Error) throw o; return o; };
  return { run, calls };
}

test('getUsage: parses both tools and stamps the time', async () => {
  const { run } = counting({ agy: AGY, claude: CLAUDE });
  const u = await createUsage({ run, now: () => Date.parse('2026-09-30T12:00:00Z') }).getUsage();
  assert.equal(u.at, '2026-09-30T12:00:00.000Z');
  assert.equal(u.agy.windows.length, 4);
  assert.equal(u.claude.windows.length, 3);
});

test('getUsage: one tool failing does not hide the other', async () => {
  const { run } = counting({ agy: new Error('spawn agy ENOENT'), claude: CLAUDE });
  const u = await createUsage({ run }).getUsage();
  assert.deepEqual(u.agy, { ok: false, error: 'spawn agy ENOENT' });
  assert.equal(u.claude.ok, true);
});

test('getUsage: cached within ttl, re-run after ttl or with fresh', async () => {
  const { run, calls } = counting({ agy: AGY, claude: CLAUDE });
  let t = 0;
  const { getUsage } = createUsage({ run, ttlMs: 1000, now: () => t });
  await getUsage(); await getUsage();
  assert.equal(calls.length, 2, 'two tools, one run');
  t = 999; await getUsage();
  assert.equal(calls.length, 2, 'still inside ttl');
  await getUsage({ fresh: true });
  assert.equal(calls.length, 4, 'fresh bypasses the cache');
  t = 5000; await getUsage();
  assert.equal(calls.length, 6, 'expired');
});

test('getUsage: concurrent callers share one run', async () => {
  const { run, calls } = counting({ agy: AGY, claude: CLAUDE });
  const { getUsage } = createUsage({ run });
  const [a, b, c] = await Promise.all([getUsage(), getUsage(), getUsage({ fresh: true })]);
  assert.equal(calls.length, 2);
  assert.equal(a, b); assert.equal(b, c);
});

// --- runTool: the real process, against a fake binary ---
function withEnv(t, vars) {
  for (const [k, v] of Object.entries(vars)) {
    const old = process.env[k];
    process.env[k] = v;
    t.after(() => { if (old === undefined) delete process.env[k]; else process.env[k] = old; });
  }
}

test('runTool: runs `-p /usage` from the temp dir without the session\'s COTALK_* identity', async (t) => {
  withEnv(t, { COTALK_AGY_BIN: FAKE, COTALK_CLAUDE_BIN: FAKE, COTALK_AGENT: 'lead', COTALK_TOOL: 'claude' });
  for (const tool of ['agy', 'claude']) {
    const out = JSON.parse(await runTool(tool));
    assert.deepEqual(out.args, ['-p', '/usage']);
    assert.equal(realpathSync(out.cwd), realpathSync(tmpdir()), 'no .cotalk.json above the cwd');
    assert.deepEqual(out.cotalk, [], 'claude -p started here must not register as the lead');
  }
});

test('runTool: a missing binary names the env var that fixes it', async (t) => {
  withEnv(t, { COTALK_AGY_BIN: join(tmpdir(), 'no-such-agy.exe') });
  await assert.rejects(runTool('agy'), /agy not found .*set COTALK_AGY_BIN/);
});

test('runTool: a failing tool reports its exit code and first stderr line', async (t) => {
  withEnv(t, { COTALK_AGY_BIN: FAKE, FAKE_USAGE_FAIL: '1' });
  await assert.rejects(runTool('agy'), { message: 'agy exited 3: boom' });
});

test('runTool: a hung tool is killed after the timeout', async (t) => {
  withEnv(t, { COTALK_AGY_BIN: FAKE, FAKE_USAGE_HANG: '1' });
  await assert.rejects(runTool('agy', { timeoutMs: 300 }), { message: 'agy timed out after 0.3s' });
});
