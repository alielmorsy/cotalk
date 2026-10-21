import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';

const read = p => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const json = p => JSON.parse(read(p));
const TOOLS = ['ltt_register', 'ltt_peers', 'ltt_board_read', 'ltt_board_write', 'ltt_request', 'ltt_respond', 'ltt_requests', 'ltt_inbox', 'ltt_wait'];

test('package.json', () => {
  const p = json('package.json');
  assert.equal(p.type, 'module');
  assert.equal(p.bin.ltt, 'bin/ltt.js');
  assert.deepEqual(p.dependencies ?? {}, {});
  assert.match(p.engines.node, />=22\.13/);
  assert.match(p.scripts.test, /--test/);
});

test('manifests agree on name and version', () => {
  const c = json('.claude-plugin/plugin.json'), a = json('plugin.json'), g = json('gemini-extension.json');
  const m = json('.claude-plugin/marketplace.json');
  for (const x of [c, a, g]) assert.equal(x.name, 'let-them-talk');
  assert.equal(c.version, a.version); assert.equal(a.version, g.version);
  assert.equal(m.plugins[0].name, 'let-them-talk');
  assert.equal(m.plugins[0].source, './');
  assert.equal(g.contextFileName, 'GEMINI.md');
});

test('.mcp.json uses http + headersHelper', () => {
  const s = json('.mcp.json').mcpServers.ltt;
  assert.equal(s.type, 'http');
  assert.equal(s.url, 'http://127.0.0.1:${LTT_PORT:-7777}/mcp');
  assert.match(s.headersHelper, /bin\/ltt\.js" headers$/);
});

test('skills have frontmatter and protocol skill names every tool', () => {
  for (const s of ['using-let-them-talk', 'ltt-setup', 'ltt-sync', 'ltt-lead']) {
    const md = read(`skills/${s}/SKILL.md`);
    assert.match(md, new RegExp(`^---\\nname: ${s}\\ndescription: .+\\n`, 'm'));
  }
  const proto = read('skills/using-let-them-talk/SKILL.md');
  for (const t of TOOLS) assert.ok(proto.includes(t), `protocol mentions ${t}`);
  assert.ok(proto.includes('"user"'), 'protocol mentions "user"');
  assert.ok(read('README.md').includes('ltt worker'));
  assert.ok(read('GEMINI.md').includes('@./skills/using-let-them-talk/SKILL.md'));
});

test('gitignore ignores db files', () => {
  assert.match(read('.gitignore'), /\*\.db/);
  assert.ok(existsSync(new URL('../README.md', import.meta.url)));
});

test('agy root hooks.json uses agy named format and events', () => {
  const root = json('hooks.json');
  assert.deepEqual(Object.keys(root), ['let-them-talk']);
  const h = root['let-them-talk'];
  assert.deepEqual(Object.keys(h).sort(), ['PreInvocation', 'Stop']);
  for (const [ev, arg] of [['PreInvocation', 'pre-invocation'], ['Stop', 'stop']]) {
    assert.ok(Array.isArray(h[ev]) && h[ev].length, ev);
    for (const x of h[ev]) {
      assert.equal(x.hooks, undefined, `${ev} is a flat handler list`);
      assert.equal(x.type, 'command');
      assert.equal(x.command, `node hooks/agy.js ${arg}`);
      assert.ok(Number.isInteger(x.timeout));
    }
  }
  assert.doesNotMatch(read('hooks.json'), /wake|asyncRewake|CLAUDE_PLUGIN_ROOT/);
});

test('codex manifest matches and ships codex-tools.md', () => {
  const x = json('.codex-plugin/plugin.json');
  assert.equal(x.name, 'let-them-talk');
  assert.equal(x.version, json('.claude-plugin/plugin.json').version);
  assert.equal(x.skills, './skills/');
  assert.ok(existsSync(new URL('../' + x.hooks, import.meta.url)));
  assert.ok(existsSync(new URL('../skills/using-let-them-talk/references/codex-tools.md', import.meta.url)));
  assert.equal(json('.agents/plugins/marketplace.json').plugins[0].name, 'let-them-talk');
});
