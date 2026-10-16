'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { validateMadmapperConfig } = require('../control-model');
const { validateProfilesConfig, migrateSystemState } = require('../profile-model');
const { ProfileSwitcher } = require('../profile-switcher');

const madmapper = validateMadmapperConfig(require('../madmapper.config.json'));
const profiles = validateProfilesConfig(require('../profiles.config.json'), madmapper, {});

/**
 * log 依序記錄所有副作用。agentBehaviour / presenceBehaviour 讓個別測試決定失敗點。
 */
function createHarness({
  agentBehaviour = async (type, payload) => ({ started: [{ name: payload.profileId, pid: 1 }] }),
  presenceBehaviour = async () => {},
  initial = {},
} = {}) {
  const log = [];
  let state = migrateSystemState(initial, { profiles, madmapper });
  let clock = 1000;

  const switcher = new ProfileSwitcher({
    store: {
      get: () => state,
      update: (mutate) => {
        mutate(state);
        log.push({ kind: 'save', switchStatus: state.switch.status, step: state.switch.step });
      },
    },
    profiles,
    madmapper,
    sendOsc: (message) => log.push({ kind: 'osc', address: message.address, value: message.args[0].value }),
    agent: {
      request: async (type, payload) => {
        log.push({ kind: `agent-${type}`, payload, activeProfileAtCall: state.activeProfile });
        return agentBehaviour(type, payload);
      },
    },
    presence: {
      waitFor: async (build, roles, options) => {
        log.push({ kind: 'waitFor', args: [build, roles], options });
        return presenceBehaviour(build, roles, options);
      },
    },
    delay: async (ms) => {
      log.push({ kind: 'delay', ms });
    },
    now: () => {
      clock += 1;
      return clock;
    },
    events: {
      switchChanged: () => log.push({ kind: 'switchChanged', status: state.switch.status, step: state.switch.step }),
      switchCompleted: () => log.push({ kind: 'switchCompleted' }),
    },
    stopAutoCycle: () => log.push({ kind: 'stopAutoCycle' }),
  });

  return { switcher, log, getState: () => state };
}

function kinds(log, ignore = ['save', 'switchChanged']) {
  const result = [];
  for (const { kind } of log) {
    if (ignore.includes(kind)) continue;
    const label = kind === 'osc' ? 'osc' : kind;
    if (result[result.length - 1] !== label) result.push(label);
  }
  return result;
}

test('switchTo activates, waits and settles in that order', async () => {
  const { switcher, log, getState } = createHarness();

  const result = await switcher.switchTo('s1');

  assert.deepEqual(result, { ok: true });
  assert.deepEqual(kinds(log), [
    'stopAutoCycle', 'agent-activate', 'waitFor', 'delay', 'switchCompleted',
  ]);
  assert.deepEqual(log.find(({ kind }) => kind === 'waitFor').args, ['s1', ['both']]);
  assert.equal(log.find(({ kind }) => kind === 'delay').ms, 3000);
  assert.equal(getState().activeProfile, 's1');
  assert.equal(getState().switch.status, 'idle');
  assert.equal(getState().switch.from, 's2');
});

// MadMapper 與 Unity 脫鉤（2026-10）：切換只換 Unity，區域開關完全由控制台手動決定。
test('switching never sends anything to MadMapper and leaves the saved switches alone', async () => {
  const { switcher, log, getState } = createHarness();
  const before = JSON.stringify([getState().profiles.s1.surfaceStates, getState().profiles.s2.surfaceStates]);

  await switcher.switchTo('s1');
  await switcher.restartActive();

  assert.equal(log.some(({ kind }) => kind === 'osc'), false);
  assert.equal(JSON.stringify([getState().profiles.s1.surfaceStates, getState().profiles.s2.surfaceStates]), before);
});

// 新的 Unity 一連上就會收到狀態，那一刻必須已經是目標方案的 view。
test('activeProfile changes before the agent is asked to start Unity', async () => {
  const { switcher, log } = createHarness();

  await switcher.switchTo('s1');

  assert.equal(log.find(({ kind }) => kind === 'agent-activate').activeProfileAtCall, 's1');
});

test('every step is saved and announced', async () => {
  const { switcher, log } = createHarness();

  await switcher.switchTo('s1');

  assert.deepEqual(
    log.filter(({ kind }) => kind === 'switchChanged').map(({ step }) => step),
    ['starting', 'waitingForRooms', 'settling'],
  );
});

test('waitFor receives the since captured before activate', async () => {
  let activatedAt = null;
  const harness = createHarness({
    agentBehaviour: async () => {
      activatedAt = true;
      return { started: [] };
    },
  });

  await harness.switcher.switchTo('s2');

  const waitFor = harness.log.find(({ kind }) => kind === 'waitFor');
  assert.ok(activatedAt);
  assert.ok(Number.isFinite(waitFor.options.since));
  assert.equal(waitFor.options.timeoutMs, 120000);
});

test('a second switch while switching is rejected without side effects', async () => {
  let release;
  const { switcher, log } = createHarness({
    agentBehaviour: () => new Promise((resolve) => { release = () => resolve({ started: [] }); }),
  });

  const first = switcher.switchTo('s1');
  await new Promise((resolve) => setImmediate(resolve));
  const before = log.length;

  const second = await switcher.switchTo('s2');

  assert.deepEqual(second, { ok: false, reason: 'switching' });
  assert.equal(log.length, before);
  assert.equal(switcher.isSwitching(), true);
  release();
  await first;
});

test('an unknown profile is rejected without side effects', async () => {
  const { switcher, log } = createHarness();

  const result = await switcher.switchTo('s9');

  assert.deepEqual(result, { ok: false, reason: 'unknownProfile' });
  assert.deepEqual(log, []);
});

test('an agent failure leaves status failed at step starting', async () => {
  const { switcher, log, getState } = createHarness({
    agentBehaviour: async () => { throw new Error('agent offline'); },
  });

  const result = await switcher.switchTo('s1');

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'failed');
  assert.deepEqual(getState().switch, {
    status: 'failed', from: 's2', to: 's1', step: 'starting', startedAt: getState().switch.startedAt, error: 'agent offline',
  });
  assert.equal(log.at(-1).kind, 'switchChanged');
});

test('a readiness timeout leaves status failed at step waitingForRooms', async () => {
  const { switcher, getState } = createHarness({
    presenceBehaviour: async () => { throw new Error('等待 s1 連線逾時，缺少 both'); },
  });

  await switcher.switchTo('s1');

  assert.equal(getState().switch.status, 'failed');
  assert.equal(getState().switch.step, 'waitingForRooms');
  assert.match(getState().switch.error, /逾時/);
  assert.equal(getState().activeProfile, 's1');
});

test('switching back to from after a failure succeeds', async () => {
  let fail = true;
  const { switcher, getState } = createHarness({
    agentBehaviour: async () => {
      if (fail) throw new Error('boom');
      return { started: [] };
    },
  });
  await switcher.switchTo('s1');
  fail = false;

  const result = await switcher.switchTo(getState().switch.from);

  assert.deepEqual(result, { ok: true });
  assert.equal(getState().activeProfile, 's2');
  assert.equal(getState().switch.status, 'idle');
});

test('restartActive switches to the active profile again', async () => {
  const { switcher, log, getState } = createHarness();

  const result = await switcher.restartActive();

  assert.deepEqual(result, { ok: true });
  assert.equal(log.find(({ kind }) => kind === 'agent-activate').payload.profileId, 's2');
  assert.equal(getState().switch.from, 's2');
  assert.equal(getState().switch.to, 's2');
});

test('ensureActive only asks the agent to keep the active profile running', async () => {
  const { switcher, log } = createHarness();

  const result = await switcher.ensureActive();

  assert.deepEqual(result, { ok: true, started: 1 });
  assert.deepEqual(kinds(log), ['agent-ensure']);
  assert.equal(log.find(({ kind }) => kind === 'agent-ensure').payload.profileId, 's2');
});

test('ensureActive does nothing while a switch is in progress or has failed', async () => {
  const failed = createHarness({ agentBehaviour: async () => { throw new Error('boom'); } });
  await failed.switcher.switchTo('s1');
  failed.log.length = 0;

  assert.deepEqual(await failed.switcher.ensureActive(), { ok: false, reason: 'failed' });
  assert.deepEqual(failed.log, []);
});

test('stopAutoCycle runs before anything is switched', async () => {
  const { switcher, log } = createHarness();

  await switcher.switchTo('s1');

  assert.equal(log[0].kind, 'stopAutoCycle');
});
