import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { newer } from '../bin/update.js';

const CLI = fileURLToPath(new URL('../bin/cotalk.js', import.meta.url));
const FAKE_NPM = fileURLToPath(new URL('./fixtures/fake-npm.js', import.meta.url));
const PKG = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).name;

function tmp(t) {
  const d = mkdtempSync(join(tmpdir(), 'cotalk-update-test-'));
  t.after(() => rmSync(d, { recursive: true, force: true }));
  return d;
}

// an npm-installed copy at version 0.1.0, a fake global root, and a fake new cotalk.js that records its argv
function setupInstall(t, latest) {
  const dir = tmp(t);
  const root = join(dir, 'installed');
  mkdirSync(root);
  writeFileSync(join(root, 'package.json'), JSON.stringify({ version: '0.1.0' }));
  const globalLib = join(dir, 'global-lib');
  const witness = join(dir, 'witness.json');
  mkdirSync(join(globalLib, PKG, 'bin'), { recursive: true });
  writeFileSync(join(globalLib, PKG, 'bin', 'cotalk.js'),
    `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(witness)}, JSON.stringify(process.argv.slice(2)));`);
  const npmLog = join(dir, 'npm.log');
  const env = {
    ...process.env, COTALK_HOME: join(dir, 'home'), COTALK_PORT: '1', COTALK_REPO_ROOT: root,
    COTALK_NPM_BIN: FAKE_NPM, FAKE_NPM_ROOT: globalLib, FAKE_NPM_LATEST: latest, FAKE_NPM_LOG: npmLog,
  };
  const run = (...args) => spawnSync(process.execPath, [CLI, 'update', ...args.filter(a => a !== '--noop-install')],
    { cwd: dir, encoding: 'utf8', env: args.includes('--noop-install') ? { ...env, FAKE_NPM_NOOP: '1' } : env });
  const npmCalls = () => existsSync(npmLog) ? readFileSync(npmLog, 'utf8').trim().split('\n').map(JSON.parse) : [];
  return { dir, run, witness, npmCalls };
}

test('newer compares x.y.z numerically', () => {
  assert.equal(newer('0.1.10', '0.1.9'), true);
  assert.equal(newer('0.2.0', '0.1.9'), true);
  assert.equal(newer('0.1.1', '0.1.1'), false);
  assert.equal(newer('0.1.0', '0.1.1'), false);
});

test('update in a git checkout says to git pull and touches nothing', (t) => {
  const s = setupInstall(t, '9.9.9');
  mkdirSync(join(s.dir, 'installed', '.git'));
  const r = s.run();
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /git pull/);
  assert.deepEqual(s.npmCalls(), []);
});

test('update reports up to date when npm has nothing newer', (t) => {
  const s = setupInstall(t, '0.1.0');
  const r = s.run();
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /0\.1\.0 is up to date/);
  assert.ok(!s.npmCalls().some(a => a[0] === 'install'));
});

test('update --check only reports the new version', (t) => {
  const s = setupInstall(t, '0.2.0');
  const r = s.run('--check');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /update available: 0\.1\.0 -> 0\.2\.0/);
  assert.ok(!s.npmCalls().some(a => a[0] === 'install'));
  assert.ok(!existsSync(s.witness));
});

test('update installs the exact version without scripts, then runs the new setup', (t) => {
  const s = setupInstall(t, '0.2.0');
  const r = s.run('--only', 'claude');
  assert.equal(r.status, 0, r.stderr);
  assert.ok(s.npmCalls().some(a => a.join(' ') === `install -g --ignore-scripts ${PKG}@0.2.0`), JSON.stringify(s.npmCalls()));
  assert.deepEqual(JSON.parse(readFileSync(s.witness, 'utf8')), ['setup', '--only', 'claude']);
  assert.match(r.stdout, /updated cotalk 0\.1\.0 -> 0\.2\.0/);
});

test('update fails when the install does not produce the new version', (t) => {
  const s = setupInstall(t, '0.2.0');
  writeFileSync(join(s.dir, 'global-lib', PKG, 'package.json'), JSON.stringify({ version: '0.1.0' }));
  const r = s.run('--noop-install');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /has 0.1.0 instead of 0.2.0/);
  assert.ok(!existsSync(s.witness));
});
