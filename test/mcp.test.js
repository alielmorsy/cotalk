import test from 'node:test';
import assert from 'node:assert/strict';
import { openStore } from '../daemon/store.js';
import { createMcpHandler } from '../daemon/mcp.js';
import { TOOLS } from '../daemon/tools.js';

function setup(waitForEvent = async () => 'timeout') {
  const store = openStore(':memory:');
  const handle = createMcpHandler(store, { waitForEvent });
  let id = 0;
  const rpc = (method, params) => handle({ jsonrpc: '2.0', id: ++id, method, params });
  const call = async (name, args) => {
    const r = await rpc('tools/call', { name, arguments: args });
    const text = r.result.content[0].text;
    let data = null;
    try { data = JSON.parse(text.split('\n\n').slice(1).join('\n\n')); } catch {}
    return { ...r.result, text, data };
  };
  return { store, handle, rpc, call };
}
const me = (agent) => ({ workspace: 'shop', agent });

test('initialize negotiates version', async () => {
  const { rpc } = setup();
  const r = await rpc('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'x', version: '1' } });
  assert.equal(r.result.protocolVersion, '2025-03-26');
  assert.equal(r.result.serverInfo.name, 'let-them-talk');
  assert.ok(r.result.capabilities.tools);
  const r2 = await rpc('initialize', { protocolVersion: '1999-01-01' });
  assert.equal(r2.result.protocolVersion, '2025-06-18');
});

test('notifications return null, unknown method errors, bad request errors', async () => {
  const { handle, rpc } = setup();
  assert.equal(await handle({ jsonrpc: '2.0', method: 'notifications/initialized' }), null);
  assert.equal((await rpc('nope')).error.code, -32601);
  assert.equal((await handle({ id: 5 })).error.code, -32600);
  assert.deepEqual((await rpc('ping')).result, {});
});

test('tools/list exposes all tools with closed schemas', async () => {
  const { rpc } = setup();
  const { tools } = (await rpc('tools/list')).result;
  assert.deepEqual(tools.map(t => t.name).sort(), ['ltt_board_read', 'ltt_board_write', 'ltt_inbox', 'ltt_peers', 'ltt_register', 'ltt_request', 'ltt_requests', 'ltt_respond', 'ltt_wait']);
  for (const t of TOOLS) {
    assert.equal(t.inputSchema.additionalProperties, false, t.name);
    assert.ok(t.inputSchema.required.includes('workspace') && t.inputSchema.required.includes('agent'), t.name);
  }
});

test('unknown tool is a JSON-RPC error', async () => {
  const { rpc } = setup();
  assert.equal((await rpc('tools/call', { name: 'ltt_nope', arguments: me('api') })).error.code, -32602);
});

test('full question round trip with unread lines', async () => {
  const { call } = setup();
  await call('ltt_register', { ...me('api'), role: 'REST API', owns: ['api/**'] });
  const reg = await call('ltt_register', { ...me('web'), role: 'frontend' });
  assert.deepEqual(reg.data.peers.map(p => p.agent), ['api', 'web']);
  await call('ltt_board_write', { ...me('api'), key: 'api.users.schema', kind: 'contract', title: 'Users', body: '{"id":"string"}' });
  const board = await call('ltt_board_read', { ...me('web') });
  assert.match(board.text, /^📬 1 unread: 1 board update/);
  assert.equal(board.data.entries[0].key, 'api.users.schema');
  const q = await call('ltt_request', { ...me('web'), to: 'api', kind: 'question', title: 'Pagination?' });
  const peers = await call('ltt_peers', me('api'));
  assert.match(peers.text, /1 question/);
  const inbox = await call('ltt_inbox', me('api'));
  assert.match(inbox.text, /^📭 no unread/);
  assert.ok(inbox.data.events.some(e => e.type === 'question.new'));
  await call('ltt_respond', { ...me('api'), id: q.data.request.id, action: 'answer', response: 'cursor' });
  const mine = await call('ltt_requests', { ...me('web'), id: q.data.request.id });
  assert.equal(mine.data.request.response, 'cursor');
});

test('errors are tool errors, not protocol errors', async () => {
  const { call } = setup();
  await call('ltt_register', me('api'));
  await call('ltt_register', me('web'));
  await call('ltt_board_write', { ...me('api'), key: 'api.x', kind: 'note', title: 'X', body: 'x' });
  const r = await call('ltt_board_write', { ...me('web'), key: 'api.x', kind: 'note', title: 'X', body: 'y' });
  assert.equal(r.isError, true);
  assert.match(r.text, /^error \(forbidden\)/);
  const bad = await call('ltt_respond', { ...me('api'), id: 'one', action: 'answer' });
  assert.equal(bad.isError, true);
  assert.match(bad.text, /^error \(invalid\)/);
});

test('ltt_wait returns immediately when unread exists, else uses waitForEvent', async () => {
  const waits = [];
  const { call } = setup(async (ws, agent, ms) => { waits.push([ws, agent, ms]); return 'timeout'; });
  await call('ltt_register', me('api'));
  const w1 = await call('ltt_wait', { ...me('api'), timeout_seconds: 5 });
  assert.deepEqual(w1.data, { timed_out: true });
  assert.deepEqual(waits, [['shop', 'api', 5000]]);
  const w2 = await call('ltt_wait', { ...me('api'), timeout_seconds: 500 });
  assert.equal(w2.isError, true, 'timeout above 90 rejected');
  await call('ltt_register', me('web'));
  const w3 = await call('ltt_wait', me('api'));
  assert.equal(w3.data.events[0].type, 'agent.joined');
  assert.equal(waits.length, 1);
});
