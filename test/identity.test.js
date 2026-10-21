import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { findConfig } from '../lib/client.js';
import { main as runMain } from '../bin/run.js';
import { startDaemon, tmpHome, freePort, mcp } from './helpers.js';

const file = rel => fileURLToPath(new URL(`../${rel}`, import.meta.url));
const ROSTER = { workspace: 'engine', agents: { lead: { role: 'architect', owns: ['docs/**'] }, physics: { role: 'physics', owns: ['src/physics/**'] } } };
// never inherit the identity of the session running the tests
const CLEAN = { COTALK_AGENT: '', COTALK_ROLE: '', COTALK_OWNS: '', COTALK_WORKER: '', COTALK_TOOL: '' };

function project(t, cfg) {
  const dir = tmpHome(t);
  writeFileSync(join(dir, '.cotalk.json'), JSON.stringify(cfg));
  return dir;
}

function run(args, { input = '', env = {}, cwd } = {}) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', ...args], { cwd, env: { ...process.env, ...CLEAN, ...env } });
    let out = '', err = '';
    p.stdout.on('data', d => out += d);
    p.stderr.on('data', d => err += d);
    p.on('close', code => resolve({ code, out, err }));
    p.stdin.end(input);
  });
}

test('roster + COTALK_AGENT picks that agent', (t) => {
  const dir = project(t, ROSTER);
  const { config } = findConfig(dir, { COTALK_AGENT: 'physics' });
  assert.equal(config.agent, 'physics');
  assert.equal(config.role, 'physics');
  assert.deepEqual(config.owns, ['src/physics/**']);
  assert.deepEqual(config.roles, ['lead', 'physics']);
  assert.equal(config.workspace, 'engine');
});

test('roster without env has no agent but lists roles', (t) => {
  const found = findConfig(project(t, ROSTER), {});
  assert.equal(found.config.agent, null);
  assert.equal(found.config.role, '');
  assert.deepEqual(found.config.owns, []);
  assert.deepEqual(found.config.roles, ['lead', 'physics']);
});

test('single-agent file: env overrides agent, role and owns', (t) => {
  const dir = project(t, { workspace: 'shop', agent: 'api', role: 'REST', owns: ['api/**'] });
  assert.deepEqual(findConfig(dir, {}).config, { workspace: 'shop', agent: 'api', role: 'REST', owns: ['api/**'], roles: ['api'] });
  const other = findConfig(dir, { COTALK_AGENT: 'other' }).config;
  assert.equal(other.agent, 'other');
  assert.equal(other.role, '');
  assert.deepEqual(other.owns, []);
  const full = findConfig(dir, { COTALK_AGENT: 'other', COTALK_ROLE: 'x', COTALK_OWNS: 'a/**, b/**' }).config;
  assert.equal(full.role, 'x');
  assert.deepEqual(full.owns, ['a/**', 'b/**']);
});

test('reserved or invalid agent names resolve to no agent', (t) => {
  const dir = project(t, ROSTER);
  assert.equal(findConfig(dir, { COTALK_AGENT: 'user' }).config.agent, null);
  assert.equal(findConfig(dir, { COTALK_AGENT: 'bad name' }).config.agent, null);
  assert.equal(findConfig(project(t, { workspace: 'shop', agent: 'user' }), {}).config.agent, null);
});

test('session-start with roster and no identity explains cotalk run, starts nothing', async (t) => {
  const cwd = project(t, ROSTER), home = tmpHome(t), port = await freePort();
  const r = await run([file('hooks/session-start.js')], {
    input: JSON.stringify({ cwd, hook_event_name: 'SessionStart' }), env: { COTALK_HOME: home, COTALK_PORT: String(port), CLAUDECODE: '1' },
  });
  assert.equal(r.code, 0);
  const ctx = JSON.parse(r.out).hookSpecificOutput.additionalContext;
  assert.match(ctx, /cotalk run <role> -- claude/);
  assert.match(ctx, /lead/);
  assert.match(ctx, /physics/);
  assert.match(ctx, /desktop app.*ask the user which role.*cotalk_register/, 'a GUI cannot relaunch, so it picks a role itself');
  await assert.rejects(fetch(`http://127.0.0.1:${port}/health`), 'no daemon started');
});

test('session-start with roster + COTALK_AGENT registers that agent', async (t) => {
  const d = await startDaemon(t);
  const cwd = project(t, ROSTER);
  const r = await run([file('hooks/session-start.js')], {
    input: JSON.stringify({ cwd, session_id: 's1', hook_event_name: 'SessionStart' }),
    env: { COTALK_HOME: d.home, COTALK_PORT: String(d.port), CLAUDECODE: '1', COTALK_AGENT: 'physics' },
  });
  assert.match(JSON.parse(r.out).hookSpecificOutput.additionalContext, /you are agent "physics" in workspace "engine" \(physics\)/);
  const state = await (await fetch(`${d.base}/api/state`, { headers: { 'x-cotalk-token': d.token } })).json();
  const peers = state.workspaces.find(w => w.workspace === 'engine').peers;
  assert.deepEqual(peers.map(p => [p.agent, p.role]), [['physics', 'physics']]);
});

test('nudge/stop/wake with roster and no identity print nothing', async (t) => {
  const d = await startDaemon(t);
  const cwd = project(t, ROSTER);
  for (const name of ['nudge.js', 'stop.js', 'wake.js']) {
    const r = await run([file(`hooks/${name}`)], { input: JSON.stringify({ cwd }), env: { COTALK_HOME: d.home, COTALK_PORT: String(d.port), CLAUDECODE: '1' } });
    assert.equal(r.code, 0, name);
    assert.equal(r.out, '', name);
  }
});

test('agy pre-invocation with roster and no identity tells once; stop is a no-op', async (t) => {
  const d = await startDaemon(t);
  const cwd = project(t, ROSTER);
  const env = { COTALK_HOME: d.home, COTALK_PORT: String(d.port) };
  const inv = JSON.stringify({ conversationId: 'c1', workspacePaths: [cwd] });
  const r1 = await run([file('hooks/agy.js'), 'pre-invocation'], { input: inv, env });
  assert.match(JSON.parse(r1.out).injectSteps[0].ephemeralMessage, /this folder has roles lead, physics, but this session has none/);
  assert.deepEqual(JSON.parse((await run([file('hooks/agy.js'), 'pre-invocation'], { input: inv, env })).out), {});
  assert.deepEqual(JSON.parse((await run([file('hooks/agy.js'), 'stop'], { input: inv, env })).out), {});
});

test('cotalk run passes identity to the child and propagates its exit code', async (t) => {
  const cwd = project(t, ROSTER);
  const cotalk = file('bin/cotalk.js');
  const r = await run([cotalk, 'run', 'physics', '--role', 'Phys', '--', 'node', '-e', 'console.log(process.env.COTALK_AGENT, process.env.COTALK_ROLE)'], { cwd });
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out.trim(), 'physics Phys');
  assert.equal(r.err, '', 'physics is in the roster: no warning');
  assert.equal((await run([cotalk, 'run', 'physics', '--', process.execPath, '-e', 'console.log(process.env.COTALK_TOOL)'], { cwd })).out.trim(), 'node', 'COTALK_TOOL = command basename, no extension, lowercased');
  assert.equal((await run([cotalk, 'run', 'physics', '--', 'node', '-e', 'process.exit(3)'], { cwd })).code, 3);
  const stranger = await run([cotalk, 'run', 'ghost', '--owns', 'a/**,b/**', '--', 'node', '-e', 'console.log(process.env.COTALK_OWNS)'], { cwd });
  assert.equal(stranger.out.trim(), 'a/**,b/**');
  assert.match(stranger.err, /ghost/, 'warns about a name outside the roster');
  // PowerShell drops `--` before the npm .ps1 shim, so it must be optional
  const bare = await run([cotalk, 'run', 'physics', '--role', 'Phys', 'node', '-e', 'console.log(process.env.COTALK_AGENT, process.env.COTALK_ROLE)'], { cwd });
  assert.equal(bare.out.trim(), 'physics Phys', 'no --');
  const show = 'console.log(process.argv.slice(1).join(" "))';
  assert.equal((await run([cotalk, 'run', 'physics', '--yolo', '--', 'node', '-e', show, 'x'], { cwd })).out.trim(), 'x --dangerously-skip-permissions', '--yolo → the tool\'s skip-permissions flag, appended');
  assert.equal((await run([cotalk, 'run', 'physics', '--role', 'Phys', '--yolo', 'node', '-e', show, 'x'], { cwd })).out.trim(), 'x --dangerously-skip-permissions', '--yolo without --');
  assert.equal((await run([cotalk, 'run', 'physics'], { cwd })).code, 1, 'no command, no --');
  assert.equal((await run([cotalk, 'run', 'physics', '--role', 'Phys'], { cwd })).code, 1, 'flags only, no --');
  assert.equal((await run([cotalk, 'run', 'physics', '--'], { cwd })).code, 1, 'missing command');
  assert.equal((await run([cotalk, 'run', 'user', '--', 'node', '-e', '1'], { cwd })).code, 1, 'reserved name');
});

test('cotalk run falls back to the shell for .cmd shims on Windows', { skip: process.platform !== 'win32' }, async (t) => {
  const dir = tmpHome(t);
  writeFileSync(join(dir, 'cotalk-shim-test.cmd'), '@echo %COTALK_AGENT% %1 %2\r\n');
  const pathKey = Object.keys(process.env).find(k => k.toUpperCase() === 'PATH') ?? 'PATH'; // Windows spells it Path
  const r = await run([file('bin/cotalk.js'), 'run', 'physics', '--', 'cotalk-shim-test', 'plain', 'two words'], { cwd: dir, env: { [pathKey]: `${dir};${process.env.PATH}` } });
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out.trim(), 'physics plain "two words"');
});

test('cotalk run shell fallback refuses cmd.exe metacharacters and runs nothing', { skip: process.platform !== 'win32' }, async (t) => {
  const dir = tmpHome(t);
  writeFileSync(join(dir, 'cotalk-shim-test.cmd'), '@echo ARGS %1\r\n');
  const pathKey = Object.keys(process.env).find(k => k.toUpperCase() === 'PATH') ?? 'PATH';
  for (const arg of ['fix a"&echo INJECTED&"b', '%PATH%', 'a|b', 'a^b', '!x!', 'a<b', 'a>b', 'a\nb']) {
    const r = await run([file('bin/cotalk.js'), 'run', 'physics', '--', 'cotalk-shim-test', arg], { cwd: dir, env: { [pathKey]: `${dir};${process.env.PATH}` } });
    assert.equal(r.code, 1, arg);
    assert.equal(r.out, '', `${arg}: nothing ran`);
    assert.match(r.err, /cotalk run/, arg);
  }
});

test('cotalk run leaves Ctrl+C / termination to the child', async () => {
  const sigs = ['SIGINT', 'SIGTERM', ...(process.platform === 'win32' ? ['SIGBREAK'] : [])];
  const before = sigs.map(s => process.listeners(s));
  try {
    await runMain('run', ['physics', '--', process.execPath, '-e', '1']);
    for (const [i, s] of sigs.entries()) assert.equal(process.listenerCount(s), before[i].length + 1, s);
  } finally {
    for (const [i, s] of sigs.entries()) for (const l of process.listeners(s)) if (!before[i].includes(l)) process.off(s, l);
    process.exitCode = undefined;
  }
});

test('COTALK_TOOL scopes env identity to the tool it was set for', (t) => {
  const dir = project(t, ROSTER);
  const env = { COTALK_TOOL: 'claude', COTALK_AGENT: 'lead', COTALK_ROLE: 'x', COTALK_OWNS: 'a/**' };
  const other = findConfig(dir, env, 'agy').config;
  assert.equal(other.agent, null, 'nested agy: roster has no identity of its own');
  assert.equal(other.role, '');
  assert.deepEqual(other.owns, []);
  assert.equal(findConfig(dir, env, 'claude').config.agent, 'lead', 'same tool');
  assert.equal(findConfig(dir, env).config.agent, 'lead', 'no tool (CLI commands)');
  assert.equal(findConfig(dir, { COTALK_AGENT: 'lead' }, 'agy').config.agent, 'lead', 'no COTALK_TOOL: as before');
  const single = project(t, { workspace: 'shop', agent: 'api', role: 'REST' });
  assert.deepEqual(findConfig(single, env, 'agy').config, { workspace: 'shop', agent: 'api', role: 'REST', owns: [], roles: ['api'] }, 'file identity');
});

test('hooks ignore identity meant for another tool', async (t) => {
  const d = await startDaemon(t);
  const cwd = project(t, ROSTER);
  const m = mcp(d.base, d.token);
  await m.call('cotalk_register', { workspace: 'engine', agent: 'lead' });
  await m.call('cotalk_register', { workspace: 'engine', agent: 'physics' });
  assert.equal((await m.call('cotalk_request', { workspace: 'engine', agent: 'lead', to: 'physics', kind: 'task', title: 'Nested leak' })).isError, false);
  const base = { COTALK_HOME: d.home, COTALK_PORT: String(d.port), COTALK_AGENT: 'physics' };
  const hook = (name, args, env) => run([file(`hooks/${name}`), ...args], { input: JSON.stringify({ cwd, workspacePaths: [cwd], conversationId: 'c1', session_id: 's1', hook_event_name: 'SessionStart' }), env: { ...base, ...env } });
  const claude = { CLAUDECODE: '1', COTALK_TOOL: 'agy' };
  for (const name of ['nudge.js', 'stop.js', 'wake.js']) {
    const r = await hook(name, [], claude);
    assert.deepEqual([r.code, r.out, r.err], [0, '', ''], name);
  }
  assert.match(JSON.parse((await hook('session-start.js', [], claude)).out).hookSpecificOutput.additionalContext, /cotalk run <role> -- claude/);
  assert.match(JSON.parse((await hook('agy.js', ['pre-invocation'], { COTALK_TOOL: 'claude' })).out).injectSteps[0].ephemeralMessage, /this session has none/);
  assert.match(JSON.parse((await hook('codex.js', ['session-start'], { COTALK_TOOL: 'claude' })).out).hookSpecificOutput.additionalContext, /this session has none/);
  const own = await hook('wake.js', [], { CLAUDECODE: '1', COTALK_TOOL: 'claude' }); // positive control: the task is still unconsumed
  assert.equal(own.code, 2, own.err);
  assert.match(own.err, /Nested leak/);
});

test('statusline uses env identity over a roster', async (t) => {
  const cwd = project(t, ROSTER), home = tmpHome(t);
  const sl = (env) => run([file('statusline/cotalk-statusline.js')], { input: JSON.stringify({ cwd }), env: { COTALK_HOME: home, COTALK_PORT: '1', CLAUDECODE: '', ...env } });
  assert.equal((await sl({ COTALK_AGENT: 'physics' })).out.trim(), '[physics@engine] ⚫ offline');
  assert.equal((await sl({})).out, '', 'no identity: nothing of ours');
  assert.equal((await sl({ COTALK_AGENT: 'physics', COTALK_TOOL: 'agy' })).out.trim(), '[physics@engine] ⚫ offline', 'agy statusline, agy identity');
  assert.equal((await sl({ COTALK_AGENT: 'physics', COTALK_TOOL: 'agy', CLAUDECODE: '1' })).out, '', 'claude statusline ignores an agy identity');
});
