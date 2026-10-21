import { readFileSync, existsSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { base, ensureDaemon, readToken, home } from '../lib/client.js';

const REPO_ROOT = (process.env.COTALK_REPO_ROOT || fileURLToPath(new URL('..', import.meta.url))).replaceAll('\\', '/').replace(/\/+$/, '');
// the npm package name; the command is always `cotalk`
export const PKG = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).name;
const COTALK_CLI = fileURLToPath(new URL('./cotalk.js', import.meta.url));

function getMarketplaceName(root = REPO_ROOT) {
  const p = join(root, '.claude-plugin', 'marketplace.json');
  try {
    return JSON.parse(readFileSync(p, 'utf8')).name || 'cotalk';
  } catch {
    return 'cotalk';
  }
}

// quote only when needed: a quoted .cmd shim ("npm") resolves %~dp0 against the cwd and breaks
const q = (a) => /\s/.test(a) ? `"${a}"` : a;

export function probeTool(tool) {
  const envKey = `COTALK_${tool.toUpperCase()}_BIN`;
  const bin = process.env[envKey] || tool;
  try {
    if (bin.endsWith('.js')) {
      const r = spawnSync(process.execPath, [bin, '--version'], { encoding: 'utf8' });
      return { found: !r.error && r.status === 0, bin };
    }
    const r = process.platform === 'win32'
      ? spawnSync(`${q(bin)} --version`, { shell: true, encoding: 'utf8' })
      : spawnSync(bin, ['--version'], { encoding: 'utf8' });
    return { found: !r.error && r.status === 0, bin };
  } catch {
    return { found: false, bin };
  }
}

export function runTool(bin, args) {
  if (bin.endsWith('.js')) {
    return spawnSync(process.execPath, [bin, ...args], { encoding: 'utf8' });
  }
  if (process.platform === 'win32') {
    return spawnSync([bin, ...args].map(q).join(' '), { shell: true, encoding: 'utf8' });
  }
  return spawnSync(bin, args, { encoding: 'utf8' });
}

const runNpm = (args) => runTool(process.env.COTALK_NPM_BIN || 'npm', args);

function runCotalk(args, env = process.env) {
  return spawnSync(process.execPath, [COTALK_CLI, ...args], { encoding: 'utf8', env });
}

function commandsFor(tool, repoRoot, marketplaceName, statusline) {
  const list = [];
  if (tool === 'claude') {
    list.push(`claude plugin marketplace add ${repoRoot}`);
    list.push(`claude plugin install cotalk@${marketplaceName}`);
    list.push(`claude plugin marketplace update ${marketplaceName}`);
    list.push(`claude plugin update cotalk@${marketplaceName}`);
    if (statusline) list.push('cotalk statusline claude');
  } else if (tool === 'agy') {
    list.push(`agy plugin install ${repoRoot}`);
    list.push('cotalk agy-mcp');
    if (statusline) list.push('cotalk statusline agy');
  } else if (tool === 'codex') {
    list.push('cotalk codex-mcp');
  }
  return list;
}

export async function main(cmd, rawArgs) {
  const dry = rawArgs.includes('--dry-run');
  const statusline = rawArgs.includes('--statusline');

  // Check if running from an npx cache (contains `/_npx/`, case-insensitive)
  const isNpx = /\/_npx\//i.test(REPO_ROOT); // REPO_ROOT already uses forward slashes
  if (isNpx) {
    const pkgPath = join(REPO_ROOT, 'package.json');
    let version = 'latest';
    try {
      version = JSON.parse(readFileSync(pkgPath, 'utf8')).version || 'latest';
    } catch {}

    let globalRoot = '<globalRoot>';
    try {
      const rRoot = runNpm(['root', '-g']);
      if (rRoot.status === 0 && rRoot.stdout.trim()) {
        globalRoot = join(rRoot.stdout.trim(), PKG).replaceAll('\\', '/');
      }
    } catch {}

    if (dry) {
      console.log(`running under npx: installing ${PKG}@${version} globally first`);
      console.log(`  npm install -g ${PKG}@${version}`);
      console.log(`  node ${globalRoot}/bin/cotalk.js setup${rawArgs.length ? ' ' + rawArgs.join(' ') : ''}`);
      return;
    }

    console.log(`running under npx: installing ${PKG}@${version} globally first...`);
    const install = runNpm(['install', '-g', `${PKG}@${version}`]);
    if (install.status !== 0) {
      console.error(install.stderr || install.stdout || 'npm install -g failed');
      process.exitCode = install.status ?? 1;
      return;
    }

    const rRoot = runNpm(['root', '-g']);
    if (rRoot.status !== 0 || !rRoot.stdout.trim()) {
      console.error(rRoot.stderr || rRoot.stdout || 'npm root -g failed');
      process.exitCode = rRoot.status ?? 1;
      return;
    }
    const realGlobalRoot = join(rRoot.stdout.trim(), PKG).replaceAll('\\', '/');
    const globalCli = join(realGlobalRoot, 'bin', 'cotalk.js');
    const { COTALK_REPO_ROOT, ...env } = process.env; // the child must use its own root, or it re-enters this branch
    const r = spawnSync(process.execPath, [globalCli, 'setup', ...rawArgs], { stdio: 'inherit', env });
    process.exitCode = r.status ?? 1;
    return;
  }

  let only = null;
  const onlyIdx = rawArgs.findIndex(a => a === '--only' || a.startsWith('--only='));
  if (onlyIdx >= 0) {
    const val = rawArgs[onlyIdx].startsWith('--only=') ? rawArgs[onlyIdx].slice(7) : rawArgs[onlyIdx + 1];
    if (val) only = val.split(',').map(s => s.trim().toLowerCase());
  }

  const allTools = ['claude', 'agy', 'codex'];
  const tools = only ? allTools.filter(t => only.includes(t)) : allTools;
  const marketplaceName = getMarketplaceName(REPO_ROOT);

  if (dry) {
    for (const tool of tools) {
      const probe = probeTool(tool);
      if (!probe.found) {
        console.log(`${tool}: skipped (not found)`);
        continue;
      }
      console.log(`${tool}:`);
      for (const c of commandsFor(tool, REPO_ROOT, marketplaceName, statusline)) {
        console.log(`  ${c}`);
      }
    }
    return;
  }

  // 1. Start daemon
  if (!(await ensureDaemon())) {
    console.error('failed: could not start daemon');
    process.exitCode = 1;
    return;
  }

  // Pass through any settings flag
  const settingsIdx = rawArgs.indexOf('--settings');
  const settingsArgs = settingsIdx >= 0 && rawArgs[settingsIdx + 1] ? ['--settings', rawArgs[settingsIdx + 1]] : [];

  let failedCount = 0;

  for (const tool of tools) {
    const probe = probeTool(tool);
    if (!probe.found) {
      console.log(`${tool}: skipped (not found)`);
      continue;
    }

    try {
      if (tool === 'claude') {
        const r1 = runTool(probe.bin, ['plugin', 'marketplace', 'add', REPO_ROOT]);
        const out1 = (r1.stdout || '') + (r1.stderr || '');
        if (r1.status !== 0 && !out1.toLowerCase().includes('already')) {
          throw new Error(out1.trim() || `marketplace add exit code ${r1.status}`);
        }
        const r2 = runTool(probe.bin, ['plugin', 'install', `cotalk@${marketplaceName}`]);
        const out2 = (r2.stdout || '') + (r2.stderr || '');
        if (r2.status !== 0 && !out2.toLowerCase().includes('already')) {
          throw new Error(out2.trim() || `plugin install exit code ${r2.status}`);
        }
        // an installed plugin stays on its cached version until the marketplace is re-read and the plugin updated
        for (const args of [['plugin', 'marketplace', 'update', marketplaceName], ['plugin', 'update', `cotalk@${marketplaceName}`]]) {
          const r = runTool(probe.bin, args);
          const out = (r.stdout || '') + (r.stderr || '');
          if (r.status !== 0 && !/already|latest|up to date/i.test(out)) throw new Error(out.trim() || `${args.join(' ')} exit code ${r.status}`);
        }
        if (statusline) {
          const r3 = runCotalk(['statusline', 'claude', ...settingsArgs]);
          if (r3.status !== 0) throw new Error(r3.stderr.trim() || r3.stdout.trim() || `statusline failed`);
        }
      } else if (tool === 'agy') {
        const r1 = runTool(probe.bin, ['plugin', 'install', REPO_ROOT]);
        const out1 = (r1.stdout || '') + (r1.stderr || '');
        if (r1.status !== 0 && !out1.toLowerCase().includes('already')) {
          throw new Error(out1.trim() || `plugin install exit code ${r1.status}`);
        }
        const r2 = runCotalk(['agy-mcp', ...settingsArgs]);
        if (r2.status !== 0) throw new Error(r2.stderr.trim() || r2.stdout.trim() || `agy-mcp failed`);
        if (statusline) {
          const r3 = runCotalk(['statusline', 'agy', ...settingsArgs]);
          if (r3.status !== 0) throw new Error(r3.stderr.trim() || r3.stdout.trim() || `statusline failed`);
        }
      } else if (tool === 'codex') {
        const r = runCotalk(['codex-mcp']);
        if (r.status !== 0) throw new Error(r.stderr.trim() || r.stdout.trim() || `codex-mcp failed`);
      }
      console.log(`${tool}: ok`);
    } catch (e) {
      console.log(`${tool}: failed: ${e.message}`);
      failedCount++;
    }
  }

  // an installed status line runs a copy of the script; keep it in step with this version
  const statuslineCopy = join(home(), 'cotalk-statusline.mjs');
  if (existsSync(statuslineCopy)) copyFileSync(fileURLToPath(new URL('../statusline/cotalk-statusline.js', import.meta.url)), statuslineCopy);

  console.log('Restart your tools to load changes.');
  const token = readToken();
  console.log(`Dashboard: ${base()}/?token=${token || ''}`);

  if (failedCount > 0) process.exitCode = 1;
}
