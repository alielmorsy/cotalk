import { readFileSync, existsSync, realpathSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import { base, isUp, readToken, api, findConfig, home } from '../lib/client.js';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url)).replaceAll('\\', '/').replace(/\/+$/, '');

function probeTool(tool) {
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

function findLttOnPath() {
  if (process.env.LTT_BIN_PATH) return process.env.LTT_BIN_PATH;
  try {
    const cmd = process.platform === 'win32' ? 'where.exe ltt' : 'which ltt';
    const r = spawnSync(cmd, { encoding: 'utf8', shell: true });
    if (!r.error && r.status === 0) {
      const lines = r.stdout.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
      return lines[0] || null;
    }
  } catch {}
  return null;
}

function checkLttResolvesToRepo(foundPath, repoRoot) {
  if (!foundPath) return false;
  const nRepo = resolve(repoRoot).toLowerCase();
  const nFound = resolve(foundPath).toLowerCase();
  if (nFound.startsWith(nRepo)) return true;
  try {
    const real = realpathSync(foundPath);
    if (resolve(real).toLowerCase().startsWith(nRepo)) return true;
  } catch {}
  try {
    const nm = join(dirname(foundPath), 'node_modules', 'let-them-talk');
    if (existsSync(nm)) {
      const realNm = realpathSync(nm);
      if (resolve(realNm).toLowerCase().startsWith(nRepo)) return true;
    }
  } catch {}
  try {
    const text = readFileSync(foundPath, 'utf8');
    if (text.toLowerCase().includes(nRepo)) return true;
  } catch {}
  return false;
}

export async function main(cmd, rawArgs) {
  const jsonMode = rawArgs.includes('--json');
  const results = [];

  // 1. Node version >= 22.13
  const [major, minor] = process.versions.node.split('.').map(Number);
  const nodeOk = major > 22 || (major === 22 && minor >= 13);
  results.push({
    check: 'node',
    ok: nodeOk,
    level: nodeOk ? '✔' : '✖',
    detail: nodeOk ? `Node v${process.versions.node} (>= 22.13)` : `Node v${process.versions.node} is below 22.13`,
    fix: nodeOk ? undefined : 'Install Node >= 22.13',
  });

  // 2. ltt on PATH resolves to this repo
  const lttPath = findLttOnPath();
  if (!lttPath) {
    results.push({
      check: 'ltt-path',
      ok: false,
      level: '✖',
      detail: 'ltt not found on PATH',
      fix: 'npm link',
    });
  } else if (checkLttResolvesToRepo(lttPath, REPO_ROOT)) {
    results.push({
      check: 'ltt-path',
      ok: true,
      level: '✔',
      detail: `ltt on PATH resolves to ${REPO_ROOT}`,
    });
  } else {
    results.push({
      check: 'ltt-path',
      ok: false,
      level: '✖',
      detail: `ltt on PATH (${lttPath}) does not resolve to ${REPO_ROOT}`,
      fix: 'npm link',
    });
  }

  // 3. daemon up (isUp), token file readable, /api/state responds, port base()
  const daemonUp = await isUp();
  const daemonToken = readToken();
  if (!daemonUp) {
    results.push({
      check: 'daemon',
      ok: false,
      level: '✖',
      detail: `daemon not running on ${base()}`,
      fix: 'ltt start',
    });
  } else if (!daemonToken) {
    results.push({
      check: 'daemon',
      ok: false,
      level: '✖',
      detail: `daemon running on ${base()} but token file unreadable in ${home()}`,
      fix: 'ltt start',
    });
  } else {
    let stateOk = false;
    let stateErr = '';
    try {
      await api('GET', '/api/state');
      stateOk = true;
    } catch (e) {
      stateErr = e.message;
    }
    if (stateOk) {
      results.push({
        check: 'daemon',
        ok: true,
        level: '✔',
        detail: `daemon running on ${base()} (state ok)`,
      });
    } else {
      results.push({
        check: 'daemon',
        ok: false,
        level: '✖',
        detail: `daemon running on ${base()} but /api/state failed: ${stateErr}`,
        fix: 'ltt start',
      });
    }
  }

  // 4. dashboard built: daemon/public/index.html exists
  const dashboardPath = join(REPO_ROOT, 'daemon', 'public', 'index.html');
  const dashboardExists = existsSync(dashboardPath);
  results.push({
    check: 'dashboard',
    ok: dashboardExists,
    level: dashboardExists ? '✔' : '✖',
    detail: dashboardExists ? 'dashboard built (daemon/public/index.html exists)' : 'dashboard not built (daemon/public/index.html missing)',
    fix: dashboardExists ? undefined : 'npm run build',
  });

  // 5. Per tool found on PATH: claude, agy, codex
  // claude
  const claudeProbe = probeTool('claude');
  if (claudeProbe.found) {
    const r = runTool(claudeProbe.bin, ['plugin', 'list']);
    const out = (r.stdout || '') + (r.stderr || '');
    const installed = out.includes('let-them-talk');
    results.push({
      check: 'claude',
      ok: installed,
      level: installed ? '✔' : '✖',
      detail: installed ? 'claude: let-them-talk plugin installed' : 'claude: let-them-talk plugin not installed',
      fix: installed ? undefined : 'ltt setup --only claude',
    });
  }

  // agy
  const agyProbe = probeTool('agy');
  if (agyProbe.found) {
    const r = runTool(agyProbe.bin, ['mcp', 'list']);
    const out = (r.stdout || '') + (r.stderr || '');
    const mcpRegistered = out.includes('let-them-talk');

    const settingsPath = process.env.LTT_AGY_SETTINGS || join(os.homedir(), '.gemini', 'antigravity-cli', 'settings.json');
    let hasAllowRule = false;
    try {
      const settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
      hasAllowRule = Array.isArray(settings?.permissions?.allow) && settings.permissions.allow.includes('mcp(let-them-talk/*)');
    } catch {}

    let agyToken = null;
    const agyMcpPaths = [
      process.env.LTT_AGY_MCP_CONFIG,
      join(os.homedir(), '.gemini', 'config', 'mcp_config.json'),
      join(os.homedir(), '.gemini', 'antigravity-cli', 'mcp_config.json'),
    ].filter(Boolean);
    for (const p of agyMcpPaths) {
      if (existsSync(p)) {
        try {
          const cfg = JSON.parse(readFileSync(p, 'utf8'));
          const s = cfg?.mcpServers?.['let-them-talk'] || cfg?.['let-them-talk'];
          agyToken = s?.headers?.['X-LTT-Token'] || null;
          if (agyToken) break;
        } catch {}
      }
    }

    if (!mcpRegistered) {
      results.push({
        check: 'agy',
        ok: false,
        level: '✖',
        detail: 'agy: let-them-talk MCP not registered',
        fix: 'ltt setup --only agy',
      });
    } else if (!hasAllowRule) {
      results.push({
        check: 'agy',
        ok: false,
        level: '✖',
        detail: `agy: allow-rule mcp(let-them-talk/*) missing in ${settingsPath}`,
        fix: 'ltt agy-mcp',
      });
    } else if (daemonToken && agyToken && agyToken !== daemonToken) {
      results.push({
        check: 'agy',
        ok: false,
        level: '✖',
        detail: 'agy: stale MCP token (does not match daemon)',
        fix: 'ltt setup',
      });
    } else {
      results.push({
        check: 'agy',
        ok: true,
        level: '✔',
        detail: 'agy: let-them-talk MCP registered and permissions allowed',
      });
    }
  }

  // codex
  const codexProbe = probeTool('codex');
  if (codexProbe.found) {
    const codexCfgPath = process.env.LTT_CODEX_CONFIG || join(os.homedir(), '.codex', 'config.toml');
    let hasMcp = false;
    let codexToken = null;
    if (existsSync(codexCfgPath)) {
      try {
        const text = readFileSync(codexCfgPath, 'utf8');
        hasMcp = text.includes('[mcp_servers.let-them-talk]');
        const m = /"X-LTT-Token"\s*=\s*"([^"]+)"/.exec(text);
        if (m) codexToken = m[1];
      } catch {}
    }

    if (!hasMcp) {
      results.push({
        check: 'codex',
        ok: false,
        level: '✖',
        detail: `codex: [mcp_servers.let-them-talk] missing in ${codexCfgPath}`,
        fix: 'ltt setup --only codex',
      });
    } else if (daemonToken && codexToken && codexToken !== daemonToken) {
      results.push({
        check: 'codex',
        ok: false,
        level: '✖',
        detail: `codex: stale MCP token in ${codexCfgPath} (does not match daemon)`,
        fix: 'ltt setup',
      });
    } else {
      results.push({
        check: 'codex',
        ok: true,
        level: '✔',
        detail: `codex: let-them-talk MCP server configured in ${codexCfgPath}`,
      });
    }
  }

  // 6. identity: .ltt.json found from cwd and valid (findConfig); warn (not fail) when absent
  const cfg = findConfig(process.cwd());
  if (cfg) {
    const who = cfg.config.agent ? `${cfg.config.agent} in ${cfg.config.workspace}` : `workspace ${cfg.config.workspace}`;
    results.push({
      check: 'identity',
      ok: true,
      level: '✔',
      detail: `identity: ${who} [${cfg.path}]`,
    });
  } else {
    let dir = process.cwd();
    let foundFile = null;
    for (;;) {
      const p = join(dir, '.ltt.json');
      if (existsSync(p)) { foundFile = p; break; }
      const up = dirname(dir);
      if (up === dir) break;
      dir = up;
    }
    if (foundFile) {
      results.push({
        check: 'identity',
        ok: false,
        level: '✖',
        detail: `invalid .ltt.json at ${foundFile}`,
        fix: 'ltt init --force',
      });
    } else {
      results.push({
        check: 'identity',
        ok: false,
        level: '!',
        detail: 'no .ltt.json found from current directory',
        fix: 'ltt init',
      });
    }
  }

  // 7. Output
  if (jsonMode) {
    console.log(JSON.stringify(results, null, 2));
  } else {
    for (const r of results) {
      console.log(`${r.level} ${r.detail}`);
      if (r.fix && r.level !== '✔') console.log(`  fix: ${r.fix}`);
    }
  }

  if (results.some(r => r.level === '✖')) {
    process.exitCode = 1;
  }
}
