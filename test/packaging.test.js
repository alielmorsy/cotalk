import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';

const read = p => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const json = p => JSON.parse(read(p));
const TOOLS = ['cotalk_register', 'cotalk_peers', 'cotalk_board_read', 'cotalk_board_write', 'cotalk_request', 'cotalk_respond', 'cotalk_requests', 'cotalk_inbox', 'cotalk_wait'];

test('package.json', () => {
  const p = json('package.json');
  assert.equal(p.type, 'module');
  assert.equal(p.bin.cotalk, 'bin/cotalk.js');
  assert.deepEqual(p.dependencies ?? {}, {});
  assert.match(p.engines.node, />=22\.13/);
  assert.match(p.scripts.test, /--test/);
});

test('manifests agree on name and version', () => {
  const c = json('.claude-plugin/plugin.json'), a = json('plugin.json'), g = json('gemini-extension.json');
  const m = json('.claude-plugin/marketplace.json');
  for (const x of [c, a, g]) assert.equal(x.name, 'cotalk');
  assert.equal(c.version, a.version); assert.equal(a.version, g.version);
  assert.equal(json('package.json').version, c.version, 'package.json matches the plugin manifests');
  assert.equal(m.plugins[0].name, 'cotalk');
  assert.equal(m.plugins[0].source, './');
  assert.equal(g.contextFileName, 'GEMINI.md');
});

test('.mcp.json uses http + headersHelper', () => {
  const s = json('.mcp.json').mcpServers.cotalk;
  assert.equal(s.type, 'http');
  assert.equal(s.url, 'http://127.0.0.1:${COTALK_PORT:-7878}/mcp');
  assert.match(s.headersHelper, /bin\/cotalk\.js" headers$/);
});

test('skills have frontmatter and protocol skill names every tool', () => {
  for (const s of ['using-cotalk', 'cotalk-setup', 'cotalk-sync', 'cotalk-lead']) {
    const md = read(`skills/${s}/SKILL.md`);
    assert.match(md, new RegExp(`^---\\nname: ${s}\\ndescription: .+\\n`, 'm'));
  }
  const proto = read('skills/using-cotalk/SKILL.md');
  for (const t of TOOLS) assert.ok(proto.includes(t), `protocol mentions ${t}`);
  assert.ok(proto.includes('"user"'), 'protocol mentions "user"');
  assert.ok(read('README.md').includes('cotalk worker'));
  assert.ok(read('GEMINI.md').includes('@./skills/using-cotalk/SKILL.md'));
});

test('gitignore ignores db files', () => {
  assert.match(read('.gitignore'), /\*\.db/);
  assert.ok(existsSync(new URL('../README.md', import.meta.url)));
});

test('agy root hooks.json uses agy named format and events', () => {
  const root = json('hooks.json');
  assert.deepEqual(Object.keys(root), ['cotalk']);
  const h = root['cotalk'];
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
  assert.equal(x.name, 'cotalk');
  assert.equal(x.version, json('.claude-plugin/plugin.json').version);
  assert.equal(x.skills, './skills/');
  assert.ok(existsSync(new URL('../' + x.hooks, import.meta.url)));
  assert.ok(existsSync(new URL('../skills/using-cotalk/references/codex-tools.md', import.meta.url)));
  assert.equal(json('.agents/plugins/marketplace.json').plugins[0].name, 'cotalk');
});
