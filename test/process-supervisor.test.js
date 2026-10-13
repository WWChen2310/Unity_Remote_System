'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const { ProcessSupervisor } = require('../agent/process-supervisor');

const PROFILES = {
  s1: {
    processes: [
      { name: 's1', exe: 'C:/Room/S1/RoomS1.exe', args: ['-roomServerUrl', 'ws://192.168.0.201:3000'] },
    ],
  },
  s2: {
    processes: [
      { name: 's2-tables', exe: 'C:/Room/S2/RoomS2.exe', args: ['-roomRole', 'tables'] },
      { name: 's2-ground', exe: 'C:/Room/S2/RoomS2.exe', args: ['-roomRole', 'ground', '-roomOscPort', '9001'] },
    ],
  },
};

class FakeChild extends EventEmitter {
  constructor(pid) {
    super();
    this.pid = pid;
  }
}

/**
 * calls 依序記錄每個外部動作；exitOnGracefulKill 決定 child 收到 taskkill /PID（不加 /F）時是否結束。
 */
function createHarness({ exitOnGracefulKill = true, buildInfo = (dir) => ({ build: dir.endsWith('S1') ? 's1' : 's2' }) } = {}) {
  const calls = [];
  const children = [];
  let nextPid = 100;

  const supervisor = new ProcessSupervisor({
    profiles: PROFILES,
    gracefulStopMs: 5000,
    startDelayMs: 2000,
    spawnFn: (exe, args, options) => {
      const child = new FakeChild(nextPid);
      nextPid += 1;
      calls.push({ kind: 'spawn', exe, args, options, pid: child.pid });
      children.push(child);
      return child;
    },
    execFn: async (file, args) => {
      calls.push({ kind: 'exec', detail: `${file} ${args.join(' ')}` });
      if (file === 'taskkill' && args[0] === '/PID') {
        const child = children.find(({ pid }) => String(pid) === args[1]);
        const forced = args.includes('/F');
        if (child && (forced || exitOnGracefulKill)) {
          child.emit('exit', forced ? 1 : 0);
        }
      }
      return { code: 0 };
    },
    delay: async (ms) => {
      calls.push({ kind: 'delay', detail: String(ms) });
    },
    readBuildInfo: buildInfo,
    fileExists: () => true,
  });

  return { supervisor, calls, children };
}

function summary(calls) {
  return calls.map(({ kind, detail, args }) => (kind === 'spawn' ? `spawn:${args.join(' ')}` : `${kind}:${detail}`));
}

test('activate kills every configured image before spawning the target profile', async () => {
  const { supervisor, calls } = createHarness();

  const result = await supervisor.activate('s2');

  assert.deepEqual(summary(calls), [
    'exec:taskkill /IM RoomS1.exe /T /F',
    'exec:taskkill /IM RoomS2.exe /T /F',
    'spawn:-roomRole tables',
    'delay:2000',
    'spawn:-roomRole ground -roomOscPort 9001',
  ]);
  assert.deepEqual(result.started.map(({ name }) => name), ['s2-tables', 's2-ground']);
});

test('spawn runs each exe from its own folder with a visible window', async () => {
  const { supervisor, calls } = createHarness();

  await supervisor.activate('s1');

  const spawn = calls.find(({ kind }) => kind === 'spawn');
  assert.equal(spawn.exe, 'C:/Room/S1/RoomS1.exe');
  assert.equal(spawn.options.cwd.replace(/\\/g, '/'), 'C:/Room/S1');
  assert.equal(spawn.options.windowsHide, false);
});

test('stopping asks politely first and does not force a child that exited', async () => {
  const { supervisor, calls } = createHarness({ exitOnGracefulKill: true });
  await supervisor.activate('s1');
  calls.length = 0;

  await supervisor.stop();

  // 已經結束就不用再等寬限時間。
  assert.deepEqual(summary(calls), [
    'exec:taskkill /PID 100',
    'exec:taskkill /IM RoomS1.exe /T /F',
    'exec:taskkill /IM RoomS2.exe /T /F',
  ]);
});

// 溫和關閉不可加 /T：Unity 的子程序 UnityCrashHandler64 只能強制結束，
// 加了 /T 會讓 taskkill 整棵樹都拒絕處理，Unity 根本收不到關閉訊號（2026-10-13 實測）。
test('the polite request targets only the Unity process, not its crash handler child', async () => {
  const { supervisor, calls } = createHarness();
  await supervisor.activate('s1');
  calls.length = 0;

  await supervisor.stop();

  const polite = calls.find(({ detail }) => detail && detail.startsWith('taskkill /PID'));
  assert.equal(polite.detail, 'taskkill /PID 100');
});

test('stopping forces a child that ignored the polite request', async () => {
  const { supervisor, calls } = createHarness({ exitOnGracefulKill: false });
  await supervisor.activate('s1');
  calls.length = 0;

  await supervisor.stop();

  assert.deepEqual(summary(calls), [
    'exec:taskkill /PID 100',
    'delay:5000',
    'exec:taskkill /PID 100 /T /F',
    'exec:taskkill /IM RoomS1.exe /T /F',
    'exec:taskkill /IM RoomS2.exe /T /F',
  ]);
});

test('a child that exits on its own emits processExited', async () => {
  const { supervisor, children } = createHarness();
  const exits = [];
  supervisor.on('processExited', (event) => exits.push(event));
  await supervisor.activate('s2');

  children[1].emit('exit', -1);

  assert.deepEqual(exits, [{ profileId: 's2', name: 's2-ground', pid: 101, code: -1 }]);
  assert.deepEqual(supervisor.status().running.map(({ name }) => name), ['s2-tables']);
});

test('a child that exits because the agent stopped it does not emit processExited', async () => {
  const { supervisor } = createHarness();
  const exits = [];
  supervisor.on('processExited', (event) => exits.push(event));
  await supervisor.activate('s2');

  await supervisor.activate('s1');

  assert.deepEqual(exits, []);
  assert.deepEqual(supervisor.status().running.map(({ name }) => name), ['s1']);
});

test('ensure is a no-op when every process of the profile is alive', async () => {
  const { supervisor, calls } = createHarness();
  await supervisor.activate('s2');
  calls.length = 0;

  const result = await supervisor.ensure('s2');

  assert.deepEqual(result, { started: [] });
  assert.deepEqual(calls, []);
});

test('ensure re-activates when one of two s2 processes has died', async () => {
  const { supervisor, calls, children } = createHarness();
  await supervisor.activate('s2');
  children[0].emit('exit', -1);
  calls.length = 0;

  const result = await supervisor.ensure('s2');

  assert.deepEqual(result.started.map(({ name }) => name), ['s2-tables', 's2-ground']);
  assert.ok(summary(calls).includes('exec:taskkill /PID 101'), 'the survivor is stopped first');
});

test('ensure starts a profile when nothing is running', async () => {
  const { supervisor } = createHarness();

  const result = await supervisor.ensure('s1');

  assert.deepEqual(result.started.map(({ name }) => name), ['s1']);
});

test('activate refuses a folder whose build-info.json names another build and leaves the show running', async () => {
  const { supervisor, calls } = createHarness({ buildInfo: () => ({ build: 's2' }) });
  await supervisor.activate('s2');
  calls.length = 0;

  await assert.rejects(supervisor.activate('s1'), /build-info\.json.*s2.*s1/);
  assert.deepEqual(calls, [], 'nothing is stopped when the target build is wrong');
});

test('activate refuses a folder without build-info.json', async () => {
  const { supervisor } = createHarness({ buildInfo: () => null });

  await assert.rejects(supervisor.activate('s1'), /build-info\.json/);
});

test('activate rejects an unknown profile', async () => {
  const { supervisor } = createHarness();

  await assert.rejects(supervisor.activate('s9'), /s9/);
});

test('requests are handled one at a time in arrival order', async () => {
  const { supervisor, calls } = createHarness();

  await Promise.all([supervisor.activate('s1'), supervisor.activate('s2')]);

  const spawns = calls.filter(({ kind }) => kind === 'spawn').map(({ exe }) => exe);
  assert.deepEqual(spawns, ['C:/Room/S1/RoomS1.exe', 'C:/Room/S2/RoomS2.exe', 'C:/Room/S2/RoomS2.exe']);
  assert.deepEqual(supervisor.status().running.map(({ profileId }) => profileId), ['s2', 's2']);
});

test('a failed request does not block the next one', async () => {
  const { supervisor } = createHarness();

  await assert.rejects(supervisor.activate('s9'));
  const result = await supervisor.activate('s1');

  assert.equal(result.started.length, 1);
});
