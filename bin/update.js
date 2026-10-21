import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isUp, api } from '../lib/client.js';
import { PKG, runTool, main as setup } from './setup.js';

const REPO_ROOT = (process.env.COTALK_REPO_ROOT || fileURLToPath(new URL('..', import.meta.url))).replaceAll('\\', '/').replace(/\/+$/, '');
const npm = (args) => runTool(process.env.COTALK_NPM_BIN || 'npm', args);
const versionAt = (root) => JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;

// ponytail: plain x.y.z compare, prerelease tags ignored; use semver if we ever publish prereleases
export const newer = (a, b) => {
  const [x, y] = [a, b].map(v => v.split(/[.-]/).slice(0, 3).map(Number));
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
  return false;
};

// cotalk update [--check]: install the latest npm release, then refresh every tool it is set up in
export async function main(cmd, rawArgs) {
  const current = versionAt(REPO_ROOT);

  if (existsSync(join(REPO_ROOT, '.git'))) {
    console.log(`cotalk ${current} runs from a git checkout (${REPO_ROOT}).`);
    console.log('update it with: git pull && npm install && cotalk setup');
    return;
  }
  // under npx this copy is already the latest; setup installs it globally and refreshes the tools
  if (/\/_npx\//i.test(REPO_ROOT)) return setup('setup', rawArgs.filter(a => a !== '--check'));

  const view = npm(['view', PKG, 'version', '--fetch-timeout=10000', '--fetch-retries=0']);
  const latest = (view.stdout || '').trim();
  if (view.status !== 0 || !/^\d+\.\d+\.\d+/.test(latest)) {
    console.error(`could not read the latest ${PKG} version from npm: ${(view.stderr || latest || '').trim()}`);
    process.exitCode = 1;
    return;
  }
  if (!newer(latest, current)) return console.log(`cotalk ${current} is up to date`);
  console.log(`update available: ${current} -> ${latest}`);
  if (rawArgs.includes('--check')) return;

  // the daemon runs the old code from the folder npm is about to replace; stop it, setup starts the new one
  if (await isUp()) {
    await api('POST', '/api/shutdown');
    for (let i = 0; i < 40 && await isUp(300); i++) await new Promise(r => setTimeout(r, 150));
  }

  console.log(`installing ${PKG}@${latest}...`);
  const install = npm(['install', '-g', '--ignore-scripts', `${PKG}@${latest}`]);
  const rootOut = install.status === 0 ? npm(['root', '-g']) : null;
  if (!rootOut || rootOut.status !== 0) {
    console.error(((install.stderr || install.stdout || '') + (rootOut?.stderr || '')).trim() || 'npm install -g failed');
    process.exitCode = 1;
    return;
  }
  const newRoot = join(rootOut.stdout.trim(), PKG);
  const installed = existsSync(join(newRoot, 'package.json')) ? versionAt(newRoot) : null;
  if (installed !== latest) {
    console.error(`npm finished, but ${newRoot} has ${installed ?? 'no cotalk'} instead of ${latest}`);
    process.exitCode = 1;
    return;
  }

  // the new version refreshes plugins, MCP entries, the status line and restarts the daemon
  const { COTALK_REPO_ROOT, ...env } = process.env;
  const r = spawnSync(process.execPath, [join(newRoot, 'bin', 'cotalk.js'), 'setup', ...rawArgs], { stdio: 'inherit', env });
  if (r.status === 0) console.log(`updated cotalk ${current} -> ${latest}`);
  process.exitCode = r.status ?? 1;
}
