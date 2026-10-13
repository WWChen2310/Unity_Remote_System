'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter, once } = require('node:events');

const { AgentClient } = require('../agent-client');
const { createAgentServer } = require('../agent/room-agent');
const { validateAgentConfig } = require('../agent/agent-config');

const config = validateAgentConfig({
  port: 3100,
  token: 'test-token',
  allowedRemotes: ['127.0.0.1'],
  profiles: { s1: { processes: [{ name: 's1', exe: 'C:/Room/S1/RoomS1.exe', args: [] }] } },
}, {});

class FakeSupervisor extends EventEmitter {
  constructor({ hang = false } = {}) {
    super();
    this.hang = hang;
  }

  activate(profileId) {
    if (this.hang) return new Promise(() => {});
    return Promise.resolve({ started: [{ name: profileId, pid: 1 }] });
  }

  ensure() { return Promise.resolve({ started: [] }); }

  stop() { return Promise.resolve({ stopped: true }); }

  status() { return { running: [] }; }
}

async function startAgent(t, { port = 0, supervisor = new FakeSupervisor() } = {}) {
  const agent = createAgentServer({ config, supervisor, port, host: '127.0.0.1' });
  await agent.ready;
  t.after(() => agent.close());
  return { agent, supervisor, port: agent.port() };
}

function createClient(t, port, options = {}) {
  const client = new AgentClient({
    url: `ws://127.0.0.1:${port}`,
    token: 'test-token',
    requestTimeoutMs: 1000,
    reconnectDelaysMs: [20],
    ...options,
  });
  t.after(() => client.stop());
  return client;
}

test('connects, says hello and reports the agent profiles', async (t) => {
  const { port } = await startAgent(t);
  const client = createClient(t, port);

  client.start();
  const [profiles] = await once(client, 'connected');

  assert.deepEqual(profiles, ['s1']);
  assert.equal(client.connected, true);
});

test('request resolves with the matching response', async (t) => {
  const { port } = await startAgent(t);
  const client = createClient(t, port);
  client.start();
  await once(client, 'connected');

  const [first, second] = await Promise.all([
    client.request('activate', { profileId: 's1' }),
    client.request('status'),
  ]);

  assert.deepEqual(first, { started: [{ name: 's1', pid: 1 }] });
  assert.deepEqual(second, { running: [] });
});

test('an agent error rejects the request with its message', async (t) => {
  const { port } = await startAgent(t);
  const client = createClient(t, port);
  client.start();
  await once(client, 'connected');

  await assert.rejects(client.request('nonsense'), /nonsense/);
});

test('request rejects after requestTimeoutMs', async (t) => {
  const { port } = await startAgent(t, { supervisor: new FakeSupervisor({ hang: true }) });
  const client = createClient(t, port, { requestTimeoutMs: 50 });
  client.start();
  await once(client, 'connected');

  await assert.rejects(client.request('activate', { profileId: 's1' }), /activate.*逾時/);
});

test('request rejects immediately while disconnected', async (t) => {
  const client = createClient(t, 1, { reconnectDelaysMs: [10000] });
  client.start();

  await assert.rejects(client.request('status'), /agent offline/);
});

test('the client reconnects and emits connected again after the agent restarts', async (t) => {
  const first = await startAgent(t);
  const client = createClient(t, first.port);
  client.start();
  await once(client, 'connected');

  const disconnected = once(client, 'disconnected');
  await first.agent.close();
  await disconnected;
  assert.equal(client.connected, false);

  await startAgent(t, { port: first.port });
  await once(client, 'connected');
  assert.equal(client.connected, true);
});

test('pending requests are rejected when the connection drops', async (t) => {
  const { agent, port } = await startAgent(t, { supervisor: new FakeSupervisor({ hang: true }) });
  const client = createClient(t, port, { requestTimeoutMs: 5000 });
  client.start();
  await once(client, 'connected');

  const pending = client.request('activate', { profileId: 's1' });
  await agent.close();

  await assert.rejects(pending, /agent offline/);
});

test('processExited events are re-emitted', async (t) => {
  const { port, supervisor } = await startAgent(t);
  const client = createClient(t, port);
  client.start();
  await once(client, 'connected');

  const exited = once(client, 'processExited');
  supervisor.emit('processExited', { profileId: 's1', name: 's1', pid: 3, code: 1 });

  assert.deepEqual((await exited)[0], { profileId: 's1', name: 's1', pid: 3, code: 1 });
});

test('a wrong token reports authFailed', async (t) => {
  const { port } = await startAgent(t);
  const client = createClient(t, port, { token: 'wrong', reconnectDelaysMs: [10000] });
  client.start();

  const [code] = await once(client, 'authFailed');
  assert.equal(code, 4401);
  assert.equal(client.connected, false);
});
