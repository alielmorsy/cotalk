import { execFile } from 'node:child_process';
import { tmpdir } from 'node:os';

// Quota for the two tools, read from `agy -p /usage` and `claude -p /usage`.
// Both report windows; we normalise to { label, window ('5h' | 'week', when it is one of those), remaining (% left), resets }.
// label and resets are copied from the tool's own text (agy: UTC ISO, claude: local prose).
// ponytail: no timezone parsing of claude's reset text; parse it if something needs to compare reset times.

const unrecognized = (text) => ({
  ok: false,
  error: `unrecognized output: ${text.split(/\r?\n/).find(l => l.trim())?.trim() ?? '(empty)'}`,
});

// { window: '5h' | 'week' } from a window's own name; nothing for any other kind, so callers can spread it
const tag = (name) => {
  const window = /five hour|session/i.test(name) ? '5h' : /week/i.test(name) ? 'week' : null;
  return window && { window };
};

const done = (text, windows) => (windows.length ? { ok: true, windows } : unrecognized(text));

// rows: `<pool> <window> Remaining <NN%> <reset>`, separated by tabs (or 2+ spaces when aligned)
export function parseAgy(text) {
  const windows = [];
  for (const line of text.split(/\r?\n/)) {
    const [pool, window, pct, resets] = line.trim().split(/\t|\s{2,}/);
    const m = /^(\d+)%$/.exec(pct ?? '');
    if (m && resets) windows.push({ label: `${pool} · ${window.replace(/ Remaining$/, '')}`, ...tag(window), remaining: Number(m[1]), resets });
  }
  return done(text, windows);
}

// lines: `Current <scope>: NN% used · resets <when>`; the "what's contributing" breakdown is ignored
export function parseClaude(text) {
  const windows = [...text.matchAll(/^(Current .+?):\s*(\d+)% used\s*·\s*resets (.+)$/gm)]
    .map(([, label, used, resets]) => ({ label, ...tag(label), remaining: 100 - Number(used), resets: resets.trim() }));
  return done(text, windows);
}

const BIN_VAR = { agy: 'COTALK_AGY_BIN', claude: 'COTALK_CLAUDE_BIN' };

// resolves to the tool's stdout. Run from the temp dir with no COTALK_* env, so a `claude -p` started here
// can't find a .cotalk.json or a role and re-register as an agent (e.g. the lead).
// ponytail: real executables only (both are .exe); an npm .cmd shim gives "not found", set COTALK_<TOOL>_BIN.
export function runTool(tool, { timeoutMs = 20_000 } = {}) {
  const bin = process.env[BIN_VAR[tool]] || tool;
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('COTALK_')));
  const [file, args] = bin.endsWith('.js') ? [process.execPath, [bin, '-p', '/usage']] : [bin, ['-p', '/usage']];
  return new Promise((resolve, reject) => {
    execFile(file, args, { cwd: tmpdir(), env, timeout: timeoutMs, windowsHide: true }, (err, stdout, stderr) => {
      if (!err) return resolve(stdout);
      if (err.code === 'ENOENT') reject(new Error(`${tool} not found (${bin}); put it on PATH or set ${BIN_VAR[tool]}`));
      else if (err.killed) reject(new Error(`${tool} timed out after ${timeoutMs / 1000}s`));
      else reject(new Error(`${tool} exited ${err.code}: ${(stderr || err.message).trim().split('\n')[0]}`));
    });
  });
}

// cache + de-dupe: each run takes ~5s per tool, and the dashboard, the CLI and the lead all ask
export function createUsage({ run = runTool, ttlMs = 60_000, now = Date.now } = {}) {
  let cached, cachedAt = 0, inflight = null;
  const one = (tool, parse) => run(tool).then(parse, e => ({ ok: false, error: e.message }));
  const query = async () => {
    const [agy, claude] = await Promise.all([one('agy', parseAgy), one('claude', parseClaude)]);
    cachedAt = now();
    return (cached = { at: new Date(cachedAt).toISOString(), agy, claude });
  };
  return {
    getUsage({ fresh = false } = {}) {
      if (!fresh && cached && now() - cachedAt < ttlMs) return Promise.resolve(cached);
      return (inflight ??= query().finally(() => { inflight = null; }));
    },
  };
}

export const { getUsage } = createUsage();
