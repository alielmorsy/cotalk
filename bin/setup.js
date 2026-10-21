import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { base, ensureDaemon, readToken } from '../lib/client.js';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url)).replaceAll('\\', '/').replace(/\/+$/, '');
const LTT_CLI = fileURLToPath(new URL('./ltt.js', import.meta.url));

function getMarketplaceName() {
  const p = join(REPO_ROOT, '.claude-plugin', 'marketplace.json');
  try {
    return JSON.parse(readFileSync(p, 'utf8')).name || 'let-them-talk-dev';
  } catch {
    return 'let-them-talk-dev';
  }
}

export function probeTool(tool) {
  const envKey = `LTT_${tool.toUpperCase()}_BIN`;
  const bin = process.env[envKey] || tool;
  try {
    if (bin.endsWith('.js')) {
      const r = spawnSync(process.execPath, [bin, '--version'], { encoding: 'utf8' });
      return { found: !r.error && r.status === 0, bin };
    }
    const r = process.platform === 'win32'
      ? spawnSync(`"${bin}" --version`, { shell: true, encoding: 'utf8' })
      : spawnSync(bin, ['--version'], { encoding: 'utf8' });
    return { found: !r.error && r.status === 0, bin };
  } catch {
    return { found: false, bin };
  }
}

function runTool(bin, args) {
  if (bin.endsWith('.js')) {
    return spawnSync(process.execPath, [bin, ...args], { encoding: 'utf8' });
  }
  if (process.platform === 'win32') {
    const cmdStr = `"${bin}" ${args.map(a => /\s/.test(a) ? `"${a}"` : a).join(' ')}`;
    return spawnSync(cmdStr, { shell: true, encoding: 'utf8' });
  }
  return spawnSync(bin, args, { encoding: 'utf8' });
}

function runLtt(args, env = process.env) {
  return spawnSync(process.execPath, [LTT_CLI, ...args], { encoding: 'utf8', env });
}

function commandsFor(tool, repoRoot, marketplaceName, statusline) {
  const list = [];
  if (tool === 'claude') {
    list.push(`claude plugin marketplace add ${repoRoot}`);
    list.push(`claude plugin install let-them-talk@${marketplaceName}`);
    if (statusline) list.push('ltt statusline claude');
  } else if (tool === 'agy') {
    list.push(`agy plugin install ${repoRoot}`);
    list.push('ltt agy-mcp');
    if (statusline) list.push('ltt statusline agy');
  } else if (tool === 'codex') {
    list.push('ltt codex-mcp');
  }
  return list;
}

export async function main(cmd, rawArgs) {
  const dry = rawArgs.includes('--dry-run');
  const statusline = rawArgs.includes('--statusline');

  let only = null;
  const onlyIdx = rawArgs.findIndex(a => a === '--only' || a.startsWith('--only='));
  if (onlyIdx >= 0) {
    const val = rawArgs[onlyIdx].startsWith('--only=') ? rawArgs[onlyIdx].slice(7) : rawArgs[onlyIdx + 1];
    if (val) only = val.split(',').map(s => s.trim().toLowerCase());
  }

  const allTools = ['claude', 'agy', 'codex'];
  const tools = only ? allTools.filter(t => only.includes(t)) : allTools;
  const marketplaceName = getMarketplaceName();

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
        const r2 = runTool(probe.bin, ['plugin', 'install', `let-them-talk@${marketplaceName}`]);
        const out2 = (r2.stdout || '') + (r2.stderr || '');
        if (r2.status !== 0 && !out2.toLowerCase().includes('already')) {
          throw new Error(out2.trim() || `plugin install exit code ${r2.status}`);
        }
        if (statusline) {
          const r3 = runLtt(['statusline', 'claude', ...settingsArgs]);
          if (r3.status !== 0) throw new Error(r3.stderr.trim() || r3.stdout.trim() || `statusline failed`);
        }
      } else if (tool === 'agy') {
        const r1 = runTool(probe.bin, ['plugin', 'install', REPO_ROOT]);
        const out1 = (r1.stdout || '') + (r1.stderr || '');
        if (r1.status !== 0 && !out1.toLowerCase().includes('already')) {
          throw new Error(out1.trim() || `plugin install exit code ${r1.status}`);
        }
        const r2 = runLtt(['agy-mcp', ...settingsArgs]);
        if (r2.status !== 0) throw new Error(r2.stderr.trim() || r2.stdout.trim() || `agy-mcp failed`);
        if (statusline) {
          const r3 = runLtt(['statusline', 'agy', ...settingsArgs]);
          if (r3.status !== 0) throw new Error(r3.stderr.trim() || r3.stdout.trim() || `statusline failed`);
        }
      } else if (tool === 'codex') {
        const r = runLtt(['codex-mcp']);
        if (r.status !== 0) throw new Error(r.stderr.trim() || r.stdout.trim() || `codex-mcp failed`);
      }
      console.log(`${tool}: ok`);
    } catch (e) {
      console.log(`${tool}: failed: ${e.message}`);
      failedCount++;
    }
  }

  console.log('Restart your tools to load changes.');
  const token = readToken();
  console.log(`Dashboard: ${base()}/?token=${token || ''}`);

  if (failedCount > 0) process.exitCode = 1;
}
