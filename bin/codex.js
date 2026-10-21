// `ltt codex-mcp [--dry-run] [--hooks]`: `codex mcp add` has no header option, so patch ~/.codex/config.toml directly.
import { readFileSync, writeFileSync, existsSync, copyFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { base, ensureDaemon, readToken, home } from '../lib/client.js';

const NAME = 'let-them-talk';
const HOOK_JS = fileURLToPath(new URL('../hooks/codex.js', import.meta.url)).replaceAll('\\', '/');
const T = ['mcp_servers', NAME];
const CANON_OURS = /^\s*\[mcp_servers\.let-them-talk(\.[A-Za-z0-9_-]+)*\]\s*(#.*)?$/;
const CANON_FEATURES = /^\s*\[features\]\s*(#.*)?$/;
const refuse = (why) => { throw Object.assign(new Error(why), { refusal: true }); };
const related = (a, b) => a.every((x, i) => i >= b.length || x === b[i]); // one key path is a prefix of the other
const isOurs = (l) => l.kind === 'header' && l.parts.length >= 2 && related(l.parts, T);
const bare = (l) => l.raw.replace(/\r$/, '');

// ---- a line-level TOML scanner: just enough to tell headers, key/values and string/array continuation lines apart.
// Anything it can't read makes the patch refuse, so it never has to be a full parser.

// a dotted key at s[i..] -> { parts, quoted, end } or null
function parseKey(s, i) {
  const parts = [];
  let quoted = false;
  for (;;) {
    while (s[i] === ' ' || s[i] === '\t') i++;
    const rest = s.slice(i);
    let m;
    if ((m = /^"(?:[^"\\]|\\.)*"/.exec(rest))) {
      try { parts.push(JSON.parse(m[0])); } catch { return null; }
      quoted = true;
    } else if ((m = /^'[^']*'/.exec(rest))) { parts.push(m[0].slice(1, -1)); quoted = true; }
    else if ((m = /^[A-Za-z0-9_-]+/.exec(rest))) parts.push(m[0]);
    else return null;
    i += m[0].length;
    while (s[i] === ' ' || s[i] === '\t') i++;
    if (s[i] !== '.') return { parts, quoted, end: i };
    i++;
  }
}

// walk a value from t[i..], tracking open multiline strings and [ { nesting across lines
function lex(t, i, st) {
  while (i < t.length) {
    if (st.ml) {
      if (st.ml === '"""' && t[i] === '\\') i += 2;
      else if (t.startsWith(st.ml, i)) { i += 3; while (t[i] === st.ml[0]) i++; st.ml = null; } // up to 2 quotes may end the content
      else i++;
      continue;
    }
    const c = t[i];
    if (c === '#') return;
    if (t.startsWith('"""', i) || t.startsWith("'''", i)) { st.ml = t.slice(i, i + 3); i += 3; continue; }
    if (c === '"') { const m = /^"(?:[^"\\]|\\.)*"/.exec(t.slice(i)); i += m ? m[0].length : t.length; continue; }
    if (c === "'") { const e = t.indexOf("'", i + 1); i = e < 0 ? t.length : e + 1; continue; }
    if (c === '[' || c === '{') st.depth++;
    else if ((c === ']' || c === '}') && st.depth > 0) st.depth--;
    i++;
  }
}

function header(t) {
  const open = /^\s*(\[\[?)/.exec(t);
  const k = parseKey(t, open[0].length), close = open[1] === '[[' ? ']]' : ']';
  if (!k || !t.startsWith(close, k.end) || !/^\s*(#.*)?$/.test(t.slice(k.end + close.length))) return { kind: 'bad' };
  return { kind: 'header', parts: k.parts, array: close === ']]' };
}

// -> [{ raw, kind: 'header'|'kv'|'blank'(or comment)|'cont'(inside a multiline string/array)|'bad', parts?, quoted?, array? }]
function scan(text) {
  const st = { ml: null, depth: 0 };
  const lines = text.split('\n').map(raw => {
    const t = raw.replace(/\r$/, '');
    if (st.ml || st.depth) { lex(t, 0, st); return { raw, kind: 'cont' }; }
    if (/^\s*(#.*)?$/.test(t)) return { raw, kind: 'blank' };
    if (/^\s*\[/.test(t)) return { raw, ...header(t) };
    const k = parseKey(t, 0);
    if (!k || t[k.end] !== '=') return { raw, kind: 'bad' };
    lex(t, k.end + 1, st);
    return { raw, kind: 'kv', ...k };
  });
  if (st.ml || st.depth) refuse('a multiline string or array is never closed');
  return lines;
}

// refuse anything where "drop our table, append a fresh one (and set [features] codex_hooks)" could be wrong
function check(lines, hooks) {
  let table = [], canonOurs = false, canonFeatures = false;
  lines.forEach((l, n) => {
    const at = `line ${n + 1} (${bare(l).trim()})`;
    if (l.kind === 'bad') refuse(`${at} is not TOML this tool can read`);
    if (l.kind === 'header') {
      table = l.parts;
      canonOurs = CANON_OURS.test(bare(l));
      canonFeatures = CANON_FEATURES.test(bare(l));
      if (related(table, T) && (l.array || (table.length > 1 && !canonOurs))) refuse(`${at} conflicts with a plain [mcp_servers.${NAME}] table`);
      if (hooks && table[0] === 'features' && (table.length === 1 ? !canonFeatures : table[1] === 'codex_hooks')) refuse(`${at} is not written as a plain [features] table`);
    } else if (l.kind === 'kv') {
      const full = [...table, ...l.parts];
      if (!canonOurs && related(full, T)) refuse(`${at} conflicts with a plain [mcp_servers.${NAME}] table`);
      if (hooks && full[0] === 'features' && table[0] !== 'features') refuse(`${at} sets features outside a [features] table`);
      if (hooks && canonFeatures && l.parts[0] === 'codex_hooks' && (l.quoted || l.parts.length > 1)) refuse(`${at} is not a plain codex_hooks key`);
    }
  });
}

// Drop our [mcp_servers.let-them-talk] table (and subtables) and append a fresh one; every other line is kept byte for byte.
// Throws an Error with .refusal = true when the edit would be ambiguous.
export function patchToml(text, url, token, { hooks = false } = {}) {
  const eol = text.includes('\r\n') ? '\r\n' : '\n', cr = eol === '\r\n' ? '\r' : '';
  const lines = scan(text);
  check(lines, hooks);

  const kept = [];
  let skip = false, held = []; // blank/comment lines while skipping: they belong to the next header if one follows
  for (const l of lines) {
    if (l.kind === 'header') {
      if (skip && !isOurs(l)) kept.push(...held);
      skip = isOurs(l);
      held = [];
      if (skip) continue;
    }
    if (!skip) kept.push(l);
    else if (l.kind === 'blank') held.push(l);
    else held = [];
  }

  // [features] codex_hooks = true (Codex 0.115 gates hooks behind it)
  let addFeatures = false;
  if (hooks) {
    const at = kept.findIndex(l => l.kind === 'header' && CANON_FEATURES.test(bare(l)));
    if (at < 0) addFeatures = true;
    else {
      let end = at + 1;
      while (end < kept.length && kept[end].kind !== 'header') end++;
      const i = kept.slice(at + 1, end).findIndex(l => l.kind === 'kv' && l.parts[0] === 'codex_hooks');
      const line = { raw: 'codex_hooks = true' + cr, kind: 'kv' };
      if (i >= 0) kept[at + 1 + i] = line;
      else kept.splice(at + 1, 0, line);
    }
  }

  const q = JSON.stringify; // a TOML basic string
  let out = kept.map(l => l.raw).join('\n').replace(/\s+$/, '');
  if (addFeatures) out = (out ? out + eol + eol : '') + `[features]${eol}codex_hooks = true`;
  out = (out ? out + eol + eol : '') + [`[mcp_servers.${NAME}]`, `url = ${q(url)}`, `http_headers = { "X-LTT-Token" = ${q(token)} }`].join(eol) + eol;

  // sanity: still readable, our table exactly once, [features] at most once, every other header kept in order
  const clean = 'the edited file did not come out clean (duplicate, missing or broken tables)';
  let after;
  try { after = scan(out); check(after, hooks); } catch { refuse(clean); }
  const heads = ls => ls.filter(l => l.kind === 'header');
  const others = hs => hs.filter(h => !isOurs(h)).map(bare);
  const want = [...others(heads(lines)), ...(addFeatures ? ['[features]'] : [])];
  if (heads(after).filter(isOurs).length !== 1
    || heads(after).filter(h => h.parts.length === 1 && h.parts[0] === 'features').length > 1
    || q(others(heads(after))) !== q(want)) refuse(clean);
  return out;
}

// Codex 0.115 hook events: SessionStart and Stop only (UserPromptSubmit is not in that binary).
export function hooksJson(existing) {
  const cmd = ev => `node "${HOOK_JS}" ${ev}`;
  const hooks = existing?.hooks && typeof existing.hooks === 'object' ? existing.hooks : {};
  const strip = arr => (Array.isArray(arr) ? arr : []).filter(g => !JSON.stringify(g).includes('hooks/codex.js'));
  const add = (ev, arg, extra = {}) => {
    hooks[ev] = [...strip(hooks[ev]), { ...extra, hooks: [{ type: 'command', command: cmd(arg), timeout: 15 }] }];
  };
  add('SessionStart', 'session-start');
  add('Stop', 'stop');
  return { ...existing, hooks };
}

// .ltt-bak = the file before ltt ever touched it; .ltt-prev = the file before this write
const backup = p => {
  if (!existsSync(p)) return;
  if (!existsSync(p + '.ltt-bak')) copyFileSync(p, p + '.ltt-bak');
  copyFileSync(p, p + '.ltt-prev');
};
const readText = p => existsSync(p) ? readFileSync(p, 'utf8') : '';

export async function main(cmd, rawArgs) {
  const dry = rawArgs.includes('--dry-run'), hooks = rawArgs.includes('--hooks');
  const url = `${base()}/mcp`;
  const cfgPath = process.env.LTT_CODEX_CONFIG || join(os.homedir(), '.codex', 'config.toml');
  const hooksPath = join(dirname(cfgPath), 'hooks.json');
  const plan = token => {
    try { return patchToml(readText(cfgPath), url, token, { hooks }); } catch (e) {
      if (!e.refusal) throw e;
      console.error([
        `ltt codex-mcp: not editing ${cfgPath}: ${e.message}. Nothing was written.`,
        `Edit ${cfgPath} by hand: remove any existing let-them-talk server entry, then add this table`,
        `(replace <token> with the contents of ${join(home(), 'token')}):`, '',
        `[mcp_servers.${NAME}]`, `url = ${JSON.stringify(url)}`, 'http_headers = { "X-LTT-Token" = "<token>" }',
        ...(hooks ? ['', 'and set this in your one [features] table (create it if missing):', '', '[features]', 'codex_hooks = true',
          '', `(${hooksPath} is written by \`ltt codex-mcp --hooks\` once the config is in this plain form.)`] : []),
      ].join('\n'));
      process.exitCode = 1;
      return null;
    }
  };

  const preview = plan('<token>'); // refuse before probing or starting anything
  if (preview === null) return;
  if (dry) {
    console.log(`patch ${cfgPath}:\n${preview.split(/\r?\n/).slice(-4).join('\n').trim()}`);
    if (hooks) console.log(`\nand write ${hooksPath}:\n${JSON.stringify(hooksJson(null), null, 2)}\n(plus [features] codex_hooks = true in the config)`);
    return;
  }

  const bin = process.env.LTT_CODEX_BIN || 'codex';
  // probe only: the token never goes on a command line. `codex` is a .cmd shim on Windows, so it needs a shell there.
  const shell = process.platform === 'win32' && !/\.(js|exe)$/i.test(bin);
  const probe = bin.endsWith('.js') ? spawnSync(process.execPath, [bin, '--version'], { encoding: 'utf8' })
    : spawnSync(bin, ['--version'], { encoding: 'utf8', shell });
  if (probe.error || probe.status !== 0) {
    console.error(`codex not found (${bin}); put codex on PATH or set LTT_CODEX_BIN to its path`);
    process.exitCode = 1;
    return;
  }
  if (!(await ensureDaemon())) throw new Error('daemon not running');
  const token = readToken();
  if (!token) throw new Error('no token found (start the daemon first)');

  const next = plan(token);
  if (next === null) return;
  mkdirSync(dirname(cfgPath), { recursive: true });
  backup(cfgPath);
  writeFileSync(cfgPath, next);
  console.log(`let-them-talk MCP server written to ${cfgPath}`);
  if (hooks) {
    backup(hooksPath);
    let cur = null;
    try { cur = JSON.parse(readText(hooksPath) || 'null'); } catch { throw new Error(`${hooksPath} is not valid JSON; fix or move it first`); }
    writeFileSync(hooksPath, JSON.stringify(hooksJson(cur), null, 2) + '\n');
    console.log(`hooks written to ${hooksPath} and codex_hooks enabled. Open /hooks in codex to trust them.`);
  }
  console.log('Restart codex to load it.');
}
