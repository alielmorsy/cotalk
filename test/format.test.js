import test from 'node:test';
import assert from 'node:assert/strict';
import { summarize, unreadLine, describeEvents, formatUsage, URGENT_TYPES } from '../lib/format.js';

const ev = (id, type, summary = `s${id}`) => ({ id, type, summary });

test('summarize counts by type', () => {
  const s = summarize([ev(1, 'question.new'), ev(2, 'task.new'), ev(3, 'entry.updated'), ev(4, 'entry.updated'), ev(5, 'request.updated'), ev(6, 'agent.joined')]);
  assert.deepEqual(s, { total: 6, questions: 1, tasks: 1, updates: 1, board: 2, joined: 1 });
});

test('unreadLine empty and plural', () => {
  assert.equal(unreadLine({ total: 0 }), '📭 no unread');
  assert.equal(unreadLine(null), '📭 no unread');
  assert.equal(
    unreadLine({ total: 3, questions: 2, tasks: 0, updates: 0, board: 1, joined: 0 }),
    '📬 3 unread: 2 questions, 1 board update — call cotalk_inbox'
  );
});

test('describeEvents caps list', () => {
  const events = [1, 2, 3].map(i => ev(i, 'entry.updated'));
  assert.equal(describeEvents(events, 2), '- #1 s1\n- #2 s2\n- …and 1 more');
});

test('urgent types', () => {
  assert.deepEqual(URGENT_TYPES, ['question.new', 'task.new', 'request.updated']);
});

test('formatUsage: aligned rows per tool, a failed tool says why', () => {
  const u = {
    agy: { ok: true, windows: [{ label: 'Gemini · Weekly', remaining: 5, resets: '2026-10-07T16:10:55Z' }] },
    claude: { ok: false, error: 'claude not found' },
  };
  assert.equal(formatUsage(u), [
    'agy',
    '  Gemini · Weekly    5% left  resets 2026-10-07T16:10:55Z',
    'claude',
    '  unavailable: claude not found',
  ].join('\n'));
  const both = { ...u, claude: { ok: true, windows: [{ label: 'Current session', remaining: 90, resets: 'Sep 30, 10pm (Africa/Cairo)' }] } };
  assert.equal(formatUsage(both).split('\n')[3], '  Current session   90% left  resets Sep 30, 10pm (Africa/Cairo)');
});
