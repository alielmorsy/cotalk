// cotalk run <agent> [--role R] [--owns "a/**,b/**"] -- <command> [args...]: launch any tool with an cotalk identity in its env.
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { basename, extname } from 'node:path';
import { findConfig } from '../lib/client.js';

const NAME = /^[a-z0-9][a-z0-9_-]{0,31}$/i;
const USAGE = 'usage: cotalk run <agent> [--role R] [--owns "a/**,b/**"] [--yolo] -- <command> [args...]';
const YOLO = { codex: '--dangerously-bypass-approvals-and-sandbox' }; // agy and claude: --dangerously-skip-permissions
const CMD_META = /["%!^&|<>\r\n]/; // cmd.exe has no escape inside "..." for these: refuse, never guess
const quote = a => /^[\w\-.:\/=@]+$/.test(a) ? a : '"' + a.replace(/"/g, '\\"') + '"';

export async function main(cmd, rawArgs) {
  let sep = rawArgs.indexOf('--');
  const dashed = sep >= 0;
  if (!dashed) { // PowerShell drops `--` when it calls the npm .ps1 shim: the command starts after the agent and its --role/--owns
    sep = Math.min(1, rawArgs.length);
    while (['--role', '--owns', '--yolo'].includes(rawArgs[sep])) sep += rawArgs[sep] === '--yolo' ? 1 : 2;
  }
  const [command, ...args] = rawArgs.slice(dashed ? sep + 1 : sep);
  const opts = rawArgs.slice(0, sep);
  if (opts.includes('--yolo') && command) args.push(YOLO[basename(command, extname(command)).toLowerCase()] ?? '--dangerously-skip-permissions');
  const agent = opts[0];
  const flag = k => { const i = opts.indexOf(`--${k}`); return i > 0 ? opts[i + 1] : undefined; };
  const role = flag('role'), owns = flag('owns');
  if (!command) { console.error(USAGE); process.exitCode = 1; return; }
  if (!NAME.test(agent ?? '') || agent.toLowerCase() === 'user') { console.error(`cotalk run: agent must match ${NAME} and not be "user"\n${USAGE}`); process.exitCode = 1; return; }

  const found = findConfig(process.cwd(), {});
  if (found) {
    const roster = JSON.parse(readFileSync(found.path, 'utf8')).agents;
    if (roster && typeof roster === 'object' && !found.config.roles.includes(agent)) {
      console.error(`cotalk run: warning: "${agent}" is not in ${found.path} (roles: ${found.config.roles.join(', ')})`);
    }
  }

  const env = { ...process.env, COTALK_AGENT: agent, COTALK_TOOL: basename(command, extname(command)).toLowerCase() };
  if (role !== undefined) env.COTALK_ROLE = role;
  if (owns !== undefined) env.COTALK_OWNS = owns;
  // the child owns the console: Ctrl+C / close must not kill this wrapper while the child keeps running
  for (const s of ['SIGINT', 'SIGTERM', ...(process.platform === 'win32' ? ['SIGBREAK'] : [])]) process.on(s, () => {});
  let r = spawnSync(command, args, { stdio: 'inherit', env });
  // npm-installed CLIs (claude, agy shims) are .cmd files on Windows: only a shell finds them
  if (r.error?.code === 'ENOENT' && process.platform === 'win32') {
    const bad = [command, ...args].find(a => CMD_META.test(a));
    if (bad !== undefined) {
      console.error(`cotalk run: ${command} needs cmd.exe (a .cmd shim), which would interpret ${JSON.stringify(bad)}; nothing was run. Avoid " % ! ^ & | < > and newlines, or pass the full path to an .exe`);
      process.exitCode = 1;
      return;
    }
    r = spawnSync([command, ...args].map(quote).join(' '), { stdio: 'inherit', env, shell: true });
  }
  if (r.error) console.error(`cotalk run: ${command}: ${r.error.message}`);
  process.exitCode = r.status ?? 1; // no process.exit(): cotalk.js may have network handles closing (libuv assert on Windows)
}
