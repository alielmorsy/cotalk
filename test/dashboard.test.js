import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { formatAgo, formatClock, parseErrorCode, filterRequests } from '../dashboard/dom.js';
import { summarizeUsage } from '../dashboard/usage.js';

const DASHBOARD_DIR = fileURLToPath(new URL('../dashboard', import.meta.url));

test('dashboard static scan: no forbidden HTML injection methods', () => {
  const files = readdirSync(DASHBOARD_DIR);
  assert.ok(files.length > 0, 'dashboard should contain files');

  // Forbidden scan including DOMParser, srcdoc, and setAttribute('style
  const forbidden = /innerHTML|outerHTML|insertAdjacentHTML|document\.write|DOMParser|srcdoc|setAttribute\(['"]style/i;

  for (const file of files) {
    const filePath = join(DASHBOARD_DIR, file);
    const content = readFileSync(filePath, 'utf8');
    assert.doesNotMatch(
      content,
      forbidden,
      `File ${file} must not contain forbidden DOM/injection patterns`
    );
  }
});

test('dashboard static scan: index.html has no inline script or style', () => {
  const html = readFileSync(join(DASHBOARD_DIR, 'index.html'), 'utf8');

  // Must not have <style> tags
  assert.doesNotMatch(html, /<style/i, 'index.html must not contain inline <style> tags');

  // Must not have inline <script> tags (i.e. <script> without src)
  const scriptTags = html.match(/<script\b[^>]*>/gi) || [];
  assert.ok(scriptTags.length > 0, 'index.html should have a script tag');
  for (const tag of scriptTags) {
    assert.match(tag, /\bsrc=["']\.\/app\.js["']/i, 'script tag must load ./app.js');
  }

  // Must have external css link
  assert.match(html, /<link\b[^>]*href=["']\.\/app\.css["']/i, 'index.html must link to ./app.css');
});

test('dashboard static scan: flat folder and filename allowlist', () => {
  const files = readdirSync(DASHBOARD_DIR);
  const allowlist = /^[a-z0-9-]+\.(js|css|html)$/;

  for (const file of files) {
    const fullPath = join(DASHBOARD_DIR, file);
    const st = statSync(fullPath);
    assert.ok(!st.isDirectory(), `dashboard must be flat; found subfolder ${file}`);
    assert.match(file, allowlist, `File ${file} does not match allowed filename pattern`);
  }
});

test('dashboard static scan: all relative imports resolve to existing files', () => {
  const files = readdirSync(DASHBOARD_DIR).filter(f => f.endsWith('.js'));
  const fileSet = new Set(files);

  for (const file of files) {
    const content = readFileSync(join(DASHBOARD_DIR, file), 'utf8');
    const importMatches = [...content.matchAll(/import\s+(?:[^'"]*from\s+)?['"](\.[^'"]+)['"]/g)];

    for (const match of importMatches) {
      const importPath = match[1];
      assert.ok(importPath.startsWith('./'), `Import in ${file} must be relative ./, got ${importPath}`);
      const targetName = importPath.replace(/^\.\//, '');
      assert.ok(
        fileSet.has(targetName),
        `Module ${file} imports non-existent file: ${importPath}`
      );
    }
  }
});

test('dashboard imports: dynamic import of modules verifying exports', async () => {
  // Modules that do not execute DOM queries at top level
  const nonDomModules = ['dom.js', 'api.js', 'state.js'];
  for (const name of nonDomModules) {
    const moduleUrl = pathToFileURL(join(DASHBOARD_DIR, name)).href;
    const mod = await import(moduleUrl);
    assert.ok(mod, `Module ${name} should import cleanly`);
  }
});

test('unit test: formatAgo computes human-readable relative time', () => {
  const now = 1700000000000;
  assert.equal(formatAgo(now - 10000, now), '10s ago');
  assert.equal(formatAgo(now - 120000, now), '2m ago');
  assert.equal(formatAgo(now - 7200000, now), '2h ago');
  assert.equal(formatAgo(now - 86400000 * 3, now), '3d ago');
});

test('unit test: formatClock formats time string', () => {
  const date = new Date('2026-09-30T14:30:45Z');
  const clockStr = formatClock(date.getTime());
  assert.ok(typeof clockStr === 'string' && clockStr.length > 0);
});

test('unit test: parseErrorCode parses code and message', () => {
  assert.deepEqual(parseErrorCode('invalid: name is required'), {
    code: 'invalid',
    message: 'name is required',
  });
  assert.deepEqual(parseErrorCode('not_found: no agent tester'), {
    code: 'not_found',
    message: 'no agent tester',
  });
  assert.deepEqual(parseErrorCode('generic error without code'), {
    code: 'unknown',
    message: 'generic error without code',
  });
});

test('unit test: filterRequests filters by status, kind, agent, and query', () => {
  const reqs = [
    { id: 1, kind: 'task', from: 'lead', to: 'ui', title: 'Design dashboard', body: 'wireframe', status: 'open' },
    { id: 2, kind: 'question', from: 'ui', to: 'api', title: 'Contract query', body: 'routes', status: 'answered' },
    { id: 3, kind: 'task', from: 'lead', to: 'ops', title: 'Worker control', body: 'daemon', status: 'claimed' },
    { id: 4, kind: 'task', from: 'lead', to: 'ui', title: 'Fix bug', body: 'css issue', status: 'cancelled' },
  ];

  // Status filter
  assert.deepEqual(filterRequests(reqs, { status: 'open' }).map(r => r.id), [1]);
  assert.deepEqual(filterRequests(reqs, { status: 'resolved' }).map(r => r.id), [2]);
  assert.deepEqual(filterRequests(reqs, { status: 'closed' }).map(r => r.id), [4]);

  // Kind filter
  assert.deepEqual(filterRequests(reqs, { kind: 'question' }).map(r => r.id), [2]);

  // Agent filter
  assert.deepEqual(filterRequests(reqs, { to: 'ui' }).map(r => r.id), [1, 4]);
  assert.deepEqual(filterRequests(reqs, { from: 'ui' }).map(r => r.id), [2]);

  // Search query
  assert.deepEqual(filterRequests(reqs, { query: 'css' }).map(r => r.id), [4]);
  assert.deepEqual(filterRequests(reqs, { query: '#1' }).map(r => r.id), [1]);
  assert.deepEqual(filterRequests(reqs, { query: 'contract' }).map(r => r.id), [2]);
});

test('dashboard static scan: no token in URLs or headers', () => {
  const files = readdirSync(DASHBOARD_DIR).filter(f => f.endsWith('.js') || f.endsWith('.html'));
  for (const file of files) {
    const content = readFileSync(join(DASHBOARD_DIR, file), 'utf8');
    assert.doesNotMatch(content, /x-cotalk-token/i, `File ${file} must not reference x-cotalk-token header`);
    assert.doesNotMatch(content, /[?&]token=/i, `File ${file} must not reference ?token= in URLs`);
  }
});

test('unit test: summarizeUsage shows the 5h and weekly figure per tool, flags low quota, carries errors', () => {
  const u = {
    agy: { ok: true, windows: [
      { label: 'Gemini · Weekly', window: 'week', remaining: 15, resets: 'r1' },
      { label: 'Gemini · Five Hour', window: '5h', remaining: 54, resets: 'r2' },
      { label: 'Claude · Weekly', window: 'week', remaining: 100, resets: 'r3' },
      { label: 'Claude · Five Hour', window: '5h', remaining: 100, resets: 'r4' },
    ] },
    claude: { ok: false, error: 'claude not found' },
  };
  assert.deepEqual(summarizeUsage(u), [
    { tool: 'agy', text: 'agy 5h 54% · wk 15%', level: 'warning',
      title: [
        'agy quota left (click to refresh)',
        'Gemini · Weekly: 15% (resets r1)',
        'Gemini · Five Hour: 54% (resets r2)',
        'Claude · Weekly: 100% (resets r3)',
        'Claude · Five Hour: 100% (resets r4)',
      ].join('\n') },
    { tool: 'claude', text: 'claude ?', level: 'bad', title: 'claude unavailable: claude not found (click to retry)' },
  ]);

  const claude = { ok: true, windows: [
    { label: 'Current session', window: '5h', remaining: 89, resets: 'r' },
    { label: 'Current week (all models)', window: 'week', remaining: 21, resets: 'r' },
    { label: 'Current week (Fable)', window: 'week', remaining: 99, resets: 'r' },
  ] };
  const [, c] = summarizeUsage({ agy: claude, claude });
  assert.equal(c.text, 'claude 5h 89% · wk 21%', 'weekly is the lowest of the weekly windows');
  assert.equal(c.level, 'ok');

  const untagged = { ok: true, windows: [{ label: 'w', remaining: 20, resets: 'r' }] };
  const [a] = summarizeUsage({ agy: untagged, claude });
  assert.equal(a.text, 'agy 20%', 'windows of another kind fall back to the tightest one');
  assert.equal(a.level, 'ok', '20% left is not yet low');
  assert.deepEqual(summarizeUsage(null), [], 'nothing before the first fetch');
});
