#!/usr/bin/env node
import { readFileSync, writeFileSync, existsSync, copyFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import os from 'node:os';
import { spawnSync, execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { home, base, findConfig, readToken, api, isUp, ensureDaemon } from '../lib/client.js';
import { unreadLine, formatUsage } from '../lib/format.js';

const NAME = /^[a-z0-9][a-z0-9_-]{0,31}$/i;
const USAGE = `usage: cotalk <command>
  start | stop | status | token | headers | dashboard
  usage [--fresh] [--json]
  init --workspace W --agent A [--role R] [--owns "a/**,b/**"] [--force]
  setup [--dry-run] [--only claude,agy,codex] [--statusline]
  doctor [--json]
  agy-mcp [--dry-run]
  codex-mcp [--dry-run]
  statusline claude|agy [--dry-run] [--settings <path>]
  run <agent> [--role R] [--owns "a/**"] -- <command> [args...]
  worker <name> [--role R] [--owns "a/**"] [--workspace W] [--yolo] [--detach] [--chat] [-- <agy args...>]
  wait [--workspace W]
  inbox | reply <id> <text...> [--reject] | ask <agent> <title...> [--body B] | task <agent> <title...> [--body B]`;

// commands that live in their own module get the raw argv (they parse `--` themselves)
const MODULES = { run: './run.js', worker: './worker.js', wait: './wait.js', inbox: './human.js', reply: './human.js', ask: './human.js', task: './human.js', 'codex-mcp': './codex.js', setup: './setup.js', doctor: './doctor.js' };

const [cmd, ...rest] = process.argv.slice(2);
const pos = [], flags = {};
for (let i = 0; i < rest.length; i++) {
  if (rest[i].startsWith('--')) {
    const k = rest[i].slice(2);
    flags[k] = rest[i + 1] !== undefined && !rest[i + 1].startsWith('--') ? rest[++i] : true;
  } else pos.push(rest[i]);
}

// never process.exit() after a fetch: on Windows (Node 24) it can abort in libuv (UV_HANDLE_CLOSING).
// die() throws; the top level sets exitCode and lets the process end on its own.
class Exit extends Error {}
const die = (msg) => { console.error(msg); throw new Exit(msg); };
const fail = (e) => { if (!(e instanceof Exit)) console.error(`cotalk ${cmd}: ${e.message}`); process.exitCode = 1; };
const readJson = (p, fallback) => existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : fallback;

const commands = {
  async start() {
    if (!(await ensureDaemon())) die(`cotalk daemon failed to start (see ${join(home(), 'daemon.log')})`);
    console.log(`cotalk daemon running on ${base()}`);
    console.log(`dashboard: ${base()}/?token=${readToken()}`);
  },

  async stop() {
    if (!(await isUp())) return console.log('not running');
    await api('POST', '/api/shutdown');
    console.log('stopped');
  },

  async status() {
    const up = await isUp();
    console.log(`daemon: ${up ? 'running' : 'not running'} (${base()})`);
    const found = findConfig(process.cwd());
    if (!found) return console.log('no .cotalk.json found');
    const { workspace, agent, role } = found.config;
    if (!agent) console.log(`you: no role in ${workspace} — roles: ${found.config.roles.join(', ')}; pick one with "cotalk run <role> -- <tool>"  [${found.path}]`);
    else console.log(`you: ${agent} in ${workspace}${role ? ` (${role})` : ''}  [${found.path}]`);
    if (!up) return;
    const state = await api('GET', '/api/state');
    const ws = state.workspaces.find(w => w.workspace === workspace);
    for (const p of ws?.peers || []) console.log(`  ${p.agent}  ${p.role || '-'}  ${p.status}  ${p.tool || '-'}`);
    if (!agent) return;
    const u = await api('GET', '/api/unread', { query: { workspace, agent, mode: 'peek' } });
    console.log(unreadLine(u.summary));
  },

  init() {
    const { workspace, agent, role, owns, force } = flags;
    if (!NAME.test(workspace ?? '') || !NAME.test(agent ?? '')) die('init: --workspace and --agent must match ' + NAME);
    const path = join(process.cwd(), '.cotalk.json');
    if (existsSync(path) && !force) die(`${path} exists (use --force to overwrite)`);
    const cfg = { workspace, agent };
    if (typeof role === 'string') cfg.role = role;
    if (typeof owns === 'string') cfg.owns = owns.split(',').map(s => s.trim()).filter(Boolean);
    writeFileSync(path, JSON.stringify(cfg, null, 2) + '\n');
    console.log(`wrote ${path}`);
  },

  async token() {
    if (!(await ensureDaemon())) die('daemon not running');
    console.log(readToken());
  },

  async headers() {
    const token = (await ensureDaemon()) && readToken();
    process.stdout.write(token ? JSON.stringify({ 'X-COTALK-Token': token }) : '{}');
  },

  async 'agy-mcp'() {
    const url = `${base()}/mcp`;
    const settingsPath = typeof flags.settings === 'string' ? flags.settings : join(os.homedir(), '.gemini', 'antigravity-cli', 'settings.json');
    // a headless agy (workers) auto-denies MCP calls unless an allow-rule exists, so its first turn does nothing
    const rule = 'mcp(cotalk/*)';
    if (flags['dry-run']) return console.log(`agy mcp add --header "X-COTALK-Token: <token>" cotalk ${url}\nadd "${rule}" to permissions.allow in ${settingsPath}`);
    if (!(await ensureDaemon())) die('daemon not running');
    const bin = process.env.COTALK_AGY_BIN || 'agy'; // agy is a real .exe: no shell, so the header stays one argv element
    const args = ['mcp', 'add', '--header', `X-COTALK-Token: ${readToken()}`, 'cotalk', url];
    const r = bin.endsWith('.js') ? spawnSync(process.execPath, [bin, ...args], { stdio: 'inherit' })
      : spawnSync(bin, args, { stdio: 'inherit' });
    if (r.error?.code === 'ENOENT') die(`agy not found (${bin}); put agy on PATH or set COTALK_AGY_BIN to its path`);
    process.exitCode = r.status ?? 1;
    if (r.status !== 0) return;
    const settings = readJson(settingsPath, {});
    const allow = ((settings.permissions ??= {}).allow ??= []);
    if (allow.includes(rule)) return;
    allow.push(rule);
    if (!existsSync(settingsPath)) mkdirSync(dirname(settingsPath), { recursive: true });
    else if (!existsSync(settingsPath + '.cotalk-bak')) copyFileSync(settingsPath, settingsPath + '.cotalk-bak');
    writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
    console.log(`allow-rule ${rule} added to ${settingsPath}`);
  },

  statusline() {
    const tool = pos[0];
    if (tool !== 'claude' && tool !== 'agy') die(USAGE);
    const path = typeof flags.settings === 'string' ? flags.settings
      : tool === 'claude' ? join(os.homedir(), '.claude', 'settings.json')
      : join(os.homedir(), '.gemini', 'antigravity-cli', 'settings.json');
    const script = join(home(), 'cotalk-statusline.mjs'); // .mjs: $COTALK_HOME has no package.json, so .js would trigger Node's module-type warning
    const settings = readJson(path, {});
    const prev = settings.statusLine?.command;
    const statusLine = (script) => {
      const p = script.replaceAll('\\', '/');
      const command = `node ${/\s/.test(p) ? `"${p}"` : p}`;
      return tool === 'claude'
        ? { type: 'command', command, padding: 0, refreshInterval: 5 }
        : { type: 'command', command, enabled: true, stack_with_default: true };
    };
    settings.statusLine = statusLine(script);
    if (flags['dry-run']) return console.log(JSON.stringify(settings, null, 2));

    mkdirSync(home(), { recursive: true });
    copyFileSync(fileURLToPath(new URL('../statusline/cotalk-statusline.js', import.meta.url)), script);
    if (tool === 'agy' && /\s/.test(script)) {
      // agy splits the command on whitespace and ignores quotes, so a path with spaces needs its 8.3 short name
      const dir = process.platform === 'win32' && execSync(`for %I in ("${home()}") do @echo %~sI`, { encoding: 'utf8' }).trim();
      if (!dir || /\s/.test(dir)) die(`agy can't run a status line whose path has spaces (${script}); set COTALK_HOME to a path without spaces`);
      settings.statusLine = statusLine(join(dir, 'cotalk-statusline.mjs')); // short dir only: node needs the real .mjs extension
    }
    if (tool === 'claude' && prev && !prev.includes('cotalk-statusline')) {
      const cfgPath = join(home(), 'config.json');
      const cfg = readJson(cfgPath, {});
      cfg.prevStatusLine = { ...cfg.prevStatusLine, claude: prev };
      writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + '\n');
    }
    if (!existsSync(path)) mkdirSync(dirname(path), { recursive: true });
    else if (!existsSync(path + '.cotalk-bak')) copyFileSync(path, path + '.cotalk-bak'); // keep the pre-cotalk original
    writeFileSync(path, JSON.stringify(settings, null, 2) + '\n');
    console.log(`status line installed in ${path}`);
  },

  // quota left for agy and claude; the daemon runs both tools (~5s each, cached 60s), so wait longer than api()'s default
  async usage() {
    if (!(await ensureDaemon())) die('daemon not running');
    const u = await api('GET', '/api/usage', { query: { fresh: flags.fresh ? 1 : undefined }, timeoutMs: 40_000 });
    console.log(flags.json ? JSON.stringify(u, null, 2) : formatUsage(u));
  },

  async dashboard() {
    if (!(await ensureDaemon())) die('daemon not running');
    console.log(`${base()}/?token=${readToken()}`);
    console.log(`open it once; after that ${base()}/ works (bookmark it)`);
  },
};

if (Object.hasOwn(MODULES, cmd ?? '')) {
  try { await (await import(MODULES[cmd])).main(cmd, rest); } catch (e) { fail(e); }
} else {
const fn = Object.hasOwn(commands, cmd ?? '') ? commands[cmd] : null;
if (!fn) { console.error(USAGE); process.exitCode = 1; }
else try { await fn(); } catch (e) { fail(e); }
}
