'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const WebSocket = require('ws');

const { createAgentServer } = require('../agent/room-agent');
const { validateAgentConfig, isAllowedRemote } = require('../agent/agent-config');

function createConfig(overrides = {}) {
  return validateAgentConfig({
    port: 3100,
    token: 'test-token',
    allowedRemotes: ['127.0.0.1'],
    gracefulStopSec: 5,
    startDelaySec: 2,
    profiles: {
      s1: { processes: [{ name: 's1', exe: 'C:/Room/S1/RoomS1.exe', args: [] }] },
      s2: {
        processes: [
          { name: 's2-tables', exe: 'C:/Room/S2/RoomS2.exe', args: ['-roomRole', 'tables'] },
          { name: 's2-ground', exe: 'C:/Room/S2/RoomS2.exe', args: ['-roomRole', 'ground'] },
        ],
      },
    },
    ...overrides,
  }, {});
}

class FakeSupervisor extends EventEmitter {
  constructor() {
    super();
    this.calls = [];
  }

  async activate(profileId) {
    this.calls.push(['activate', profileId]);
    if (profileId === 'bad') throw new Error('build-info.json 的 build 是 s2，不是 bad');
    return { started: [{ name: profileId, pid: 42 }] };
  }

  async ensure(profileId) {
    this.calls.push(['ensure', profileId]);
    return { started: [] };
  }

  async stop() {
    this.calls.push(['stop']);
    return { stopped: true };
  }

  status() {
    return { running: [] };
  }
}

async function startAgent(t, config = createConfig()) {
  const supervisor = new FakeSupervisor();
  const agent = createAgentServer({ config, supervisor, port: 0, host: '127.0.0.1', log: () => {} });
  await agent.ready;
  t.after(() => agent.close());
  return { agent, supervisor, url: `ws://127.0.0.1:${agent.port()}` };
}

function connect(t, url) {
  const ws = new WebSocket(url);
  const inbox = [];
  const waiters = [];
  ws.on('message', (raw) => {
    const message = JSON.parse(raw);
    inbox.push(message);
    for (const waiter of [...waiters]) {
      if (waiter.match(message)) {
        waiters.splice(waiters.indexOf(waiter), 1);
        waiter.resolve(message);
      }
    }
  });
  t.after(() => ws.terminate());
  return {
    ws,
    opened: new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); }),
    closed: new Promise((resolve) => ws.once('close', (code) => resolve(code))),
    send: (message) => ws.send(JSON.stringify(message)),
    waitFor: (match) => {
      const found = inbox.find(match);
      if (found) return Promise.resolve(found);
      return new Promise((resolve) => waiters.push({ match, resolve }));
    },
  };
}

async function connectAuthenticated(t, url) {
  const client = connect(t, url);
  await client.opened;
  client.send({ type: 'hello', token: 'test-token' });
  await client.waitFor((m) => m.event === 'hello');
  return client;
}

test('a wrong token closes the connection with 4401', async (t) => {
  const { url } = await startAgent(t);
  const client = connect(t, url);
  await client.opened;

  client.send({ type: 'hello', token: 'nope' });

  assert.equal(await client.closed, 4401);
});

test('a request before hello closes the connection with 4401', async (t) => {
  const { url, supervisor } = await startAgent(t);
  const client = connect(t, url);
  await client.opened;

  client.send({ id: 1, type: 'activate', profileId: 's1' });

  assert.equal(await client.closed, 4401);
  assert.deepEqual(supervisor.calls, []);
});

test('hello is answered with the configured profile ids', async (t) => {
  const { url } = await startAgent(t);
  const client = await connectAuthenticated(t, url);

  const hello = await client.waitFor((m) => m.event === 'hello');
  assert.deepEqual(hello.profiles, ['s1', 's2']);
});

test('activate is forwarded to the supervisor and answered with the same id', async (t) => {
  const { url, supervisor } = await startAgent(t);
  const client = await connectAuthenticated(t, url);

  client.send({ id: 7, type: 'activate', profileId: 's1' });
  const reply = await client.waitFor((m) => m.id === 7);

  assert.deepEqual(reply, { id: 7, ok: true, result: { started: [{ name: 's1', pid: 42 }] } });
  assert.deepEqual(supervisor.calls, [['activate', 's1']]);
});

test('ensure, stop and status are forwarded too', async (t) => {
  const { url, supervisor } = await startAgent(t);
  const client = await connectAuthenticated(t, url);

  client.send({ id: 1, type: 'ensure', profileId: 's2' });
  client.send({ id: 2, type: 'stop' });
  client.send({ id: 3, type: 'status' });

  assert.equal((await client.waitFor((m) => m.id === 1)).ok, true);
  assert.equal((await client.waitFor((m) => m.id === 2)).ok, true);
  assert.deepEqual((await client.waitFor((m) => m.id === 3)).result, { running: [] });
  assert.deepEqual(supervisor.calls, [['ensure', 's2'], ['stop']]);
});

test('a supervisor error is returned as ok false with the message', async (t) => {
  const { url } = await startAgent(t);
  const client = await connectAuthenticated(t, url);

  client.send({ id: 9, type: 'activate', profileId: 'bad' });
  const reply = await client.waitFor((m) => m.id === 9);

  assert.equal(reply.ok, false);
  assert.match(reply.error, /build-info\.json/);
});

test('an unknown request type is rejected without touching the supervisor', async (t) => {
  const { url, supervisor } = await startAgent(t);
  const client = await connectAuthenticated(t, url);

  client.send({ id: 4, type: 'format-disk' });
  const reply = await client.waitFor((m) => m.id === 4);

  assert.equal(reply.ok, false);
  assert.deepEqual(supervisor.calls, []);
});

test('processExited is pushed to authenticated clients', async (t) => {
  const { url, supervisor } = await startAgent(t);
  const client = await connectAuthenticated(t, url);

  supervisor.emit('processExited', { profileId: 's2', name: 's2-ground', pid: 5, code: -1 });
  const event = await client.waitFor((m) => m.event === 'processExited');

  assert.deepEqual(event, { event: 'processExited', profileId: 's2', name: 's2-ground', pid: 5, code: -1 });
});

test('a remote outside allowedRemotes is refused with 4403', async (t) => {
  const { url } = await startAgent(t, createConfig({ allowedRemotes: ['192.168.0.201'] }));
  const client = connect(t, url);

  assert.equal(await client.closed, 4403);
});

test('isAllowedRemote accepts IPv4-mapped and IPv6 loopback addresses', () => {
  assert.equal(isAllowedRemote('::ffff:192.168.0.201', ['192.168.0.201']), true);
  assert.equal(isAllowedRemote('::1', ['127.0.0.1']), true);
  assert.equal(isAllowedRemote('192.168.0.50', ['192.168.0.201']), false);
  assert.equal(isAllowedRemote(undefined, ['192.168.0.201']), false);
});

test('validateAgentConfig converts seconds and lets ROOM_AGENT_TOKEN win', () => {
  const config = validateAgentConfig({
    port: 3100,
    token: 'file-token',
    allowedRemotes: ['192.168.0.201'],
    gracefulStopSec: 5,
    startDelaySec: 2,
    profiles: { s1: { processes: [{ name: 's1', exe: 'C:/Room/S1/RoomS1.exe', args: [] }] } },
  }, { ROOM_AGENT_TOKEN: 'env-token' });

  assert.equal(config.token, 'env-token');
  assert.equal(config.gracefulStopMs, 5000);
  assert.equal(config.startDelayMs, 2000);
});

for (const [description, mutate, pattern] of [
  ['a relative exe path', (raw) => { raw.profiles.s1.processes[0].exe = 'Room/S1/RoomS1.exe'; }, /absolute/],
  ['an exe that is not .exe', (raw) => { raw.profiles.s1.processes[0].exe = 'C:/Room/S1/run.bat'; }, /\.exe/],
  ['a duplicated process name', (raw) => { raw.profiles.s2.processes[1].name = 's2-tables'; }, /duplicated/],
  ['non-string args', (raw) => { raw.profiles.s1.processes[0].args = ['-a', 1]; }, /args/],
  ['an invalid port', (raw) => { raw.port = 70000; }, /port/],
  ['an empty allowedRemotes list', (raw) => { raw.allowedRemotes = []; }, /allowedRemotes/],
  ['a profile without processes', (raw) => { raw.profiles.s1.processes = []; }, /processes/],
  ['a profile id Unity cannot report', (raw) => { raw.profiles['S 1'] = raw.profiles.s1; delete raw.profiles.s1; }, /profile id/],
]) {
  test(`validateAgentConfig rejects ${description}`, () => {
    const raw = {
      port: 3100,
      token: 't',
      allowedRemotes: ['127.0.0.1'],
      gracefulStopSec: 5,
      startDelaySec: 2,
      profiles: {
        s1: { processes: [{ name: 's1', exe: 'C:/Room/S1/RoomS1.exe', args: [] }] },
        s2: {
          processes: [
            { name: 's2-tables', exe: 'C:/Room/S2/RoomS2.exe', args: [] },
            { name: 's2-ground', exe: 'C:/Room/S2/RoomS2.exe', args: [] },
          ],
        },
      },
    };
    mutate(raw);
    assert.throws(() => validateAgentConfig(raw, {}), pattern);
  });
}

test('the shipped agent config is valid', () => {
  const config = validateAgentConfig(require('../agent/agent.config.json'), {});

  assert.deepEqual(Object.keys(config.profiles), ['s1', 's2']);
  assert.deepEqual(config.allowedRemotes, ['192.168.0.201', '127.0.0.1']);
  for (const { args } of Object.values(config.profiles).flatMap(({ processes }) => processes)) {
    const url = args[args.indexOf('-roomServerUrl') + 1];
    assert.equal(url, 'ws://192.168.0.201:3000');
    assert.ok(args.includes('-screen-fullscreen'), 'Unity must not cover the projector outputs');
  }
});
