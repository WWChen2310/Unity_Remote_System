'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { validateMadmapperConfig } = require('../control-model');
const {
  validateProfilesConfig,
  migrateSystemState,
} = require('../profile-model');

const madmapper = validateMadmapperConfig(require('../madmapper.config.json'));

function shippedProfiles() {
  return JSON.parse(JSON.stringify(require('../profiles.config.json')));
}

function context() {
  return { profiles: validateProfilesConfig(shippedProfiles(), madmapper, {}), madmapper };
}

// ---- validateProfilesConfig -------------------------------------------------

test('validateProfilesConfig accepts the shipped profiles and converts seconds to ms', () => {
  const profiles = validateProfilesConfig(shippedProfiles(), madmapper, {});

  assert.deepEqual(profiles.ids, ['s1', 's2']);
  assert.equal(profiles.defaultProfile, 's2');
  assert.equal(profiles.agent.url, 'ws://192.168.0.202:3100');
  assert.equal(profiles.agent.requestTimeoutMs, 60000);
  assert.equal(profiles.byId.s1.readyTimeoutMs, 90000);
  assert.equal(profiles.byId.s1.settleMs, 3000);
  assert.deepEqual(profiles.byId.s2.rooms, ['tables', 'ground']);
  assert.equal(profiles.byId.s1.id, 's1');
});

test('ROOM_AGENT_TOKEN overrides the token in the file', () => {
  const profiles = validateProfilesConfig(shippedProfiles(), madmapper, { ROOM_AGENT_TOKEN: 'site-secret' });

  assert.equal(profiles.agent.token, 'site-secret');
});

test('validateProfilesConfig fills optional lists with empty defaults', () => {
  const raw = shippedProfiles();
  delete raw.profiles.s2.seatModeLabels;
  delete raw.profiles.s2.seatOnlyInModes;
  delete raw.profiles.s2.resetSeatsOnModes;
  delete raw.profiles.s2.modeLabels;

  const { s2 } = validateProfilesConfig(raw, madmapper, {}).byId;
  assert.deepEqual(s2.seatModeLabels, {});
  assert.deepEqual(s2.seatOnlyInModes, []);
  assert.deepEqual(s2.resetSeatsOnModes, []);
  assert.deepEqual(s2.modeLabels, {});
});

for (const [description, mutate, pattern] of [
  ['an agent url that is not ws://', (raw) => { raw.agent.url = 'http://192.168.0.202:3100'; }, /agent.*url/i],
  ['an empty agent token', (raw) => { raw.agent.token = ''; }, /token/i],
  ['a profile id Unity cannot report', (raw) => { raw.profiles['S 1'] = raw.profiles.s1; delete raw.profiles.s1; }, /profile id/i],
  ['a seat order other than direct or reversed', (raw) => { raw.profiles.s1.seatOrder = 'backwards'; }, /seatOrder/],
  ['a seat count above nine', (raw) => { raw.profiles.s2.seatCount = 10; }, /seatCount/],
  ['a seat count of zero', (raw) => { raw.profiles.s2.seatCount = 0; }, /seatCount/],
  ['a seat mode that does not exist', (raw) => { raw.profiles.s1.seatModes = [0, 1, 7]; }, /seatModes/],
  ['seat modes without the reset value zero', (raw) => { raw.profiles.s1.seatModes = [1, 2, 3]; }, /seatModes.*0/],
  ['an empty room list', (raw) => { raw.profiles.s2.rooms = []; }, /rooms/],
  ['an unknown room role', (raw) => { raw.profiles.s2.rooms = ['tables', 'floor']; }, /rooms/],
  ['a duplicated room role', (raw) => { raw.profiles.s2.rooms = ['tables', 'tables']; }, /rooms/],
  ['a content mode outside zero through nine', (raw) => { raw.profiles.s1.seatOnlyInModes = [10]; }, /seatOnlyInModes/],
  ['a missing default profile', (raw) => { raw.defaultProfile = 's3'; }, /defaultProfile/],
  ['a ground flag that is not boolean', (raw) => { raw.profiles.s2.ground = 'yes'; }, /ground/],
  ['a negative settle time', (raw) => { raw.profiles.s2.settleSec = -1; }, /settleSec/],
  ['a zero ready timeout', (raw) => { raw.profiles.s2.readyTimeoutSec = 0; }, /readyTimeoutSec/],
  ['a profile missing from madmapper.config.json', (raw) => { raw.profiles.s3 = raw.profiles.s2; }, /madmapper\.config\.json.*s3|s3.*madmapper\.config\.json/],
]) {
  test(`validateProfilesConfig rejects ${description}`, () => {
    const raw = shippedProfiles();
    mutate(raw);
    assert.throws(() => validateProfilesConfig(raw, madmapper, {}), pattern);
  });
}

test('validateProfilesConfig rejects a profile that madmapper.config.json has but profiles.config.json lacks', () => {
  const raw = shippedProfiles();
  delete raw.profiles.s1;
  assert.throws(() => validateProfilesConfig(raw, madmapper, {}), /s1/);
});

// ---- migrateSystemState -----------------------------------------------------

test('migrateSystemState moves a v2 file into profiles.s2 and seeds s1 defaults', () => {
  const v2 = {
    contentMode: 3,
    maskMode: 2,
    groundThemeId: 'crops',
    tableModes: [1, 0, 0, 0, 0, 0, 0, 0, 4],
    surfaceStates: {
      Main: true, T1: false, T2: false, T3: false, T4: false, Ground: true, Light1: true,
    },
    autoCycle: { enabled: true, interval: 5, modes: [2, 3], currentIndex: 1, remainingSeconds: 30 },
  };

  const state = migrateSystemState(v2, context());

  assert.equal(state.version, 3);
  assert.equal(state.activeProfile, 's2');
  assert.equal(state.switch.status, 'idle');
  assert.equal(state.profiles.s2.contentMode, 3);
  assert.equal(state.profiles.s2.maskMode, 2);
  assert.equal(state.profiles.s2.groundThemeId, 'crops');
  assert.deepEqual(state.profiles.s2.tableModes, [1, 0, 0, 0, 0, 0, 0, 0, 4]);
  assert.equal(state.profiles.s2.surfaceStates.Main, true);
  assert.equal(state.profiles.s2.surfaceStates.Ground, true);
  assert.equal('Light1' in state.profiles.s2.surfaceStates, false);
  assert.deepEqual(state.lightStates, { Light1: true, Light2: false, Light3: false });

  assert.equal(state.profiles.s1.maskMode, 1);
  assert.equal(state.profiles.s1.groundThemeId, 'none');
  assert.deepEqual(state.profiles.s1.tableModes, [0, 0, 0, 0, 0, 0, 0, 0, 0]);
  assert.equal(state.profiles.s1.surfaceStates['Main-1'], true);
  assert.equal(state.profiles.s1.surfaceStates['Main-2'], false);

  // 自動循環載入時一律停用，與原本伺服器的行為相同。
  assert.equal(state.autoCycle.enabled, false);
  assert.equal(state.autoCycle.remainingSeconds, 0);
  assert.equal(state.autoCycle.interval, 5);
  assert.deepEqual(state.autoCycle.modes, [2, 3]);
});

test('migrateSystemState pads an eight-seat legacy file', () => {
  const state = migrateSystemState({ tableModes: [3, 2, 1, 0, 3, 2, 1, 0] }, context());

  assert.deepEqual(state.profiles.s2.tableModes, [3, 2, 1, 0, 3, 2, 1, 0, 0]);
});

test('migrateSystemState keeps a v3 file as it is', () => {
  const ctx = context();
  const first = migrateSystemState({}, ctx);
  first.activeProfile = 's1';
  first.profiles.s1.contentMode = 8;
  first.profiles.s1.tableModes[2] = 3;
  first.profiles.s1.surfaceStates['Main-2'] = true;

  const again = migrateSystemState(JSON.parse(JSON.stringify(first)), ctx);

  assert.deepEqual(again, first);
});

test('migrateSystemState marks an interrupted switch as failed', () => {
  const state = migrateSystemState({
    version: 3,
    activeProfile: 's1',
    switch: { status: 'switching', from: 's2', to: 's1', step: 'starting', startedAt: 1, error: null },
  }, context());

  assert.equal(state.switch.status, 'failed');
  assert.equal(state.switch.from, 's2');
  assert.equal(state.switch.to, 's1');
  assert.equal(state.switch.step, 'starting');
  assert.match(state.switch.error, /重新啟動/);
});

test('migrateSystemState drops seat values the profile does not allow', () => {
  const state = migrateSystemState({
    version: 3,
    activeProfile: 's1',
    profiles: { s1: { tableModes: [4, 1, 0, 0, 0, 0, 0, 0, 2] } },
  }, context());

  // s1 沒有「開燈」，也只用前 8 席。
  assert.deepEqual(state.profiles.s1.tableModes, [0, 1, 0, 0, 0, 0, 0, 0, 0]);
});

test('migrateSystemState forces groundThemeId to none for profiles without ground', () => {
  const state = migrateSystemState({
    version: 3,
    profiles: { s1: { groundThemeId: 'crops' } },
  }, context());

  assert.equal(state.profiles.s1.groundThemeId, 'none');
});

test('an unknown persisted activeProfile falls back to defaultProfile', () => {
  const state = migrateSystemState({ version: 3, activeProfile: 's9' }, context());

  assert.equal(state.activeProfile, 's2');
});

test('surface keys that no longer exist are dropped and new ones get their default', () => {
  const state = migrateSystemState({
    version: 3,
    profiles: { s1: { surfaceStates: { 'Main-1': false, 'Old-9': true } } },
  }, context());

  assert.equal(state.profiles.s1.surfaceStates['Main-1'], false);
  assert.equal(state.profiles.s1.surfaceStates['T1-1'], true);
  assert.equal('Old-9' in state.profiles.s1.surfaceStates, false);
});
