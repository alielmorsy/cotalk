import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readRoster, writeRoster } from '../daemon/roster.js';
import { LttError } from '../daemon/store.js';

test('roster: readRoster parses multi-agent object map into normalized array', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'ltt-roster-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const content = {
    workspace: 'ltt-dev',
    agents: {
      api: { role: 'routes', owns: ['daemon/server.js'] },
      ops: { role: 'workers', owns: ['daemon/workers.js'] },
    },
  };
  writeFileSync(join(dir, '.ltt.json'), JSON.stringify(content, null, 2), 'utf8');

  const r = await readRoster({ cwd: dir, workspace: 'ltt-dev', allowedDirs: [dir] });
  assert.equal(r.format, 'multi');
  assert.equal(r.workspace, 'ltt-dev');
  assert.equal(r.agents.length, 2);
  assert.deepEqual(r.agents.find(a => a.agent === 'api'), {
    agent: 'api',
    role: 'routes',
    owns: ['daemon/server.js'],
  });
  assert.deepEqual(r.agents.find(a => a.agent === 'ops'), {
    agent: 'ops',
    role: 'workers',
    owns: ['daemon/workers.js'],
  });
});

test('roster: readRoster parses single-agent format into normalized array', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'ltt-roster-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const content = {
    workspace: 'my-project',
    agent: 'worker1',
    role: 'coder',
    owns: ['src/**'],
  };
  writeFileSync(join(dir, '.ltt.json'), JSON.stringify(content, null, 2), 'utf8');

  const r = await readRoster({ cwd: dir, allowedDirs: [dir] });
  assert.equal(r.format, 'single');
  assert.equal(r.workspace, 'my-project');
  assert.equal(r.agents.length, 1);
  assert.deepEqual(r.agents[0], { agent: 'worker1', role: 'coder', owns: ['src/**'] });
});

test('roster: readRoster rejects empty allowedDirs, prefix mismatch (C:\\a vs C:\\ab), and invalid paths', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'ltt-roster-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, '.ltt.json'), JSON.stringify({ workspace: 'ws', agent: 'lead' }), 'utf8');

  // Empty allowedDirs -> forbidden
  await assert.rejects(
    async () => readRoster({ cwd: dir, allowedDirs: [] }),
    (err) => err instanceof LttError && err.code === 'forbidden'
  );
  await assert.rejects(
    async () => readRoster({ cwd: dir, allowedDirs: undefined }),
    (err) => err instanceof LttError && err.code === 'forbidden'
  );

  // Prefix mismatch: e.g. dir is C:\a\b, allowedDirs is C:\a\bc
  const dirAb = `${dir}extra`;
  await assert.rejects(
    async () => readRoster({ cwd: dirAb, allowedDirs: [dir] }),
    (err) => err instanceof LttError && err.code === 'forbidden'
  );

  // win32 case-insensitivity: uppercase allowedDir should match lowercase cwd on win32
  if (process.platform === 'win32') {
    const res = await readRoster({ cwd: dir.toLowerCase(), allowedDirs: [dir.toUpperCase()] });
    assert.equal(res.workspace, 'ws');
  }
});

test('roster: readRoster rejects missing or corrupted file and workspace mismatch', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'ltt-roster-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  // Missing file
  await assert.rejects(
    async () => readRoster({ cwd: dir, allowedDirs: [dir] }),
    (err) => err instanceof LttError && err.code === 'not_found'
  );

  // Corrupted json
  writeFileSync(join(dir, '.ltt.json'), 'not valid json', 'utf8');
  await assert.rejects(
    async () => readRoster({ cwd: dir, allowedDirs: [dir] }),
    (err) => err instanceof LttError && err.code === 'invalid'
  );

  // Workspace mismatch
  writeFileSync(join(dir, '.ltt.json'), JSON.stringify({ workspace: 'ws-a', agent: 'lead' }), 'utf8');
  await assert.rejects(
    async () => readRoster({ cwd: dir, workspace: 'ws-b', allowedDirs: [dir] }),
    (err) => err instanceof LttError && err.code === 'invalid'
  );
});

test('roster: writeRoster updates multi-agent file, preserves unknown keys and creates backup', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'ltt-roster-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const initial = {
    workspace: 'ltt-dev',
    customField: 'stay-here',
    agents: {
      api: { role: 'old-role', owns: ['old.js'], extra: 'keep-me' },
    },
  };
  const lttPath = join(dir, '.ltt.json');
  writeFileSync(lttPath, JSON.stringify(initial, null, 2), 'utf8');

  const updateResult = await writeRoster({
    cwd: dir,
    allowedDirs: [dir],
    agents: [
      { agent: 'api', role: 'new-role', owns: ['new.js'] },
      { agent: 'ops', role: 'ops-role', owns: ['daemon/workers.js'] },
    ],
  });

  assert.equal(updateResult.ok, true);
  assert.equal(updateResult.count, 2);

  // Backup exists
  assert.ok(existsSync(`${lttPath}.bak`));
  const bak = JSON.parse(readFileSync(`${lttPath}.bak`, 'utf8'));
  assert.equal(bak.customField, 'stay-here');
  assert.equal(bak.agents.api.role, 'old-role');

  // Updated file
  const updated = JSON.parse(readFileSync(lttPath, 'utf8'));
  assert.equal(updated.customField, 'stay-here');
  assert.equal(updated.agents.api.role, 'new-role');
  assert.deepEqual(updated.agents.api.owns, ['new.js']);
  assert.equal(updated.agents.api.extra, 'keep-me');
  assert.equal(updated.agents.ops.role, 'ops-role');
  assert.deepEqual(updated.agents.ops.owns, ['daemon/workers.js']);
});

test('roster: writeRoster throws mismatch when workspace argument does not match file', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'ltt-roster-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const lttPath = join(dir, '.ltt.json');
  writeFileSync(lttPath, JSON.stringify({ workspace: 'ws-original', agent: 'lead' }), 'utf8');

  await assert.rejects(
    async () => writeRoster({
      cwd: dir,
      workspace: 'ws-different',
      allowedDirs: [dir],
      agents: [{ agent: 'lead', role: 'new', owns: [] }],
    }),
    (err) => err instanceof LttError && err.code === 'invalid' && err.message.includes('workspace mismatch')
  );
});

test('roster: writeRoster validates agents list and owns elements', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'ltt-roster-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const lttPath = join(dir, '.ltt.json');
  writeFileSync(lttPath, JSON.stringify({ workspace: 'ws', agent: 'a' }), 'utf8');

  // Empty agents array -> invalid
  await assert.rejects(
    async () => writeRoster({ cwd: dir, allowedDirs: [dir], agents: [] }),
    (err) => err instanceof LttError && err.code === 'invalid'
  );

  // Non-string in owns -> invalid
  await assert.rejects(
    async () => writeRoster({ cwd: dir, allowedDirs: [dir], agents: [{ agent: 'a', owns: [123] }] }),
    (err) => err instanceof LttError && err.code === 'invalid'
  );

  // User reserved
  await assert.rejects(
    async () => writeRoster({ cwd: dir, allowedDirs: [dir], agents: [{ agent: 'user' }] }),
    (err) => err instanceof LttError && err.code === 'invalid'
  );

  // Duplicate names
  await assert.rejects(
    async () => writeRoster({ cwd: dir, allowedDirs: [dir], agents: [{ agent: 'agent1' }, { agent: 'agent1' }] }),
    (err) => err instanceof LttError && err.code === 'invalid'
  );
});
