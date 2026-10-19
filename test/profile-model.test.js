'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { validateMadmapperConfig } = require('../control-model');
const {
  validateProfilesConfig,
  migrateSystemState,
  toUnityTableModes,
  createConsoleState,
  createRoomState,
  viewKindForClient,
  classifyClient,
} = require('../profile-model');
const { DEFAULT_LOGO } = require('../logo-model');

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

test('each shipped profile uses its own tracker mask', () => {
  const profiles = validateProfilesConfig(shippedProfiles(), madmapper, {});
  assert.equal(profiles.byId.s1.maskId, 1);
  assert.equal(profiles.byId.s2.maskId, 2);
});

test('validateProfilesConfig refuses the old defaultMaskId and a mask id below 1', () => {
  const legacy = shippedProfiles();
  delete legacy.profiles.s1.maskId;
  legacy.profiles.s1.defaultMaskId = 1;
  assert.throws(() => validateProfilesConfig(legacy, madmapper, {}), /defaultMaskId was replaced by maskId/);

  const zero = shippedProfiles();
  zero.profiles.s2.maskId = 0;
  assert.throws(() => validateProfilesConfig(zero, madmapper, {}), /maskId must be a positive integer/);
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
  assert.equal('maskMode' in state.profiles.s2, false, 'the mask follows the profile and is not saved');
  assert.equal(state.profiles.s2.groundThemeId, 'crops');
  assert.deepEqual(state.profiles.s2.tableModes, [1, 0, 0, 0, 0, 0, 0, 0, 4]);
  assert.equal(state.profiles.s2.surfaceStates['Main-s2'], true);
  assert.equal(state.profiles.s2.surfaceStates['T1-s2'], false);
  assert.equal(state.profiles.s2.surfaceStates['Ground-s2'], true);
  assert.equal('Light1' in state.profiles.s2.surfaceStates, false);
  // 舊版工作燈兩版共用；現在每版各自一組，舊的開關帶到兩版同編號的燈。
  assert.deepEqual(state.profiles.s2.lightStates, { 'Light1-s2': true, 'Light2-s2': false, 'Light3-s2': false });
  assert.deepEqual(state.profiles.s1.lightStates, { 'Light1-s1': true, 'Light2-s1': false, 'Light3-s1': false });
  assert.equal('lightStates' in state, false, 'no shared light state is kept');

  assert.equal(state.profiles.s1.groundThemeId, 'none');
  assert.deepEqual(state.profiles.s1.tableModes, [0, 0, 0, 0, 0, 0, 0, 0, 0]);
  assert.equal(state.profiles.s1.surfaceStates['Main-s1'], true);
  assert.equal(state.profiles.s1.surfaceStates['T5-s1'], true);

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
  first.profiles.s1.surfaceStates['T5-s1'] = false;

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
    profiles: { s1: { surfaceStates: { 'Main-s1': false, 'Old-9': true } } },
  }, context());

  assert.equal(state.profiles.s1.surfaceStates['Main-s1'], false);
  assert.equal(state.profiles.s1.surfaceStates['T1-s1'], true);
  assert.equal('Old-9' in state.profiles.s1.surfaceStates, false);
});

// 2026-10 以前的狀態檔用短名稱（Main、T1…）當 key。改成 MadMapper 的 -s2 名稱後，
// 現場已保存的開關要沿用，否則更新完第二版的區域會全部變回預設（關閉）。
test('a saved state keyed by the old short names keeps its switches under the new names', () => {
  const state = migrateSystemState({
    version: 3,
    profiles: {
      s1: { surfaceStates: { 'Main-1': false, 'T7-1': true } },
      s2: { surfaceStates: { Main: true, T1: false, T2: true, T3: true, T4: false, Ground: true } },
    },
  }, context());

  assert.deepEqual(state.profiles.s2.surfaceStates, {
    'Main-s2': true, 'T1-s2': false, 'T2-s2': true, 'T3-s2': true, 'T4-s2': false, 'Ground-s2': true,
  });
  // 第一版的舊名稱（Main-1…）與新的短名稱不同，無從對應，回到預設的開啟。
  assert.ok(Object.values(state.profiles.s1.surfaceStates).every((value) => value === true));
  assert.deepEqual(Object.keys(state.profiles.s1.surfaceStates), ['Main-s1', 'T1-s1', 'T2-s1', 'T3-s1', 'T4-s1', 'T5-s1']);
});

test('the new name wins over the old short name when a state has both', () => {
  const state = migrateSystemState({
    version: 3,
    profiles: { s2: { surfaceStates: { Main: true, 'Main-s2': false } } },
  }, context());

  assert.equal(state.profiles.s2.surfaceStates['Main-s2'], false);
});

// ---- views ------------------------------------------------------------------

function viewContext() {
  const ctx = context();
  const state = migrateSystemState({}, ctx);
  return { ...ctx, state, byId: ctx.profiles.byId };
}

test('toUnityTableModes passes nine direct seats through for s2', () => {
  const { byId } = viewContext();

  assert.deepEqual(toUnityTableModes(byId.s2, [1, 2, 3, 4, 0, 0, 0, 0, 1]), [1, 2, 3, 4, 0, 0, 0, 0, 1]);
});

test('s1 sends six seats in console order', () => {
  const { byId } = viewContext();

  // s1 的席位重做成 6 席，座位 1 = Region 0，不再反轉；第 7 格以後不送。
  assert.deepEqual(toUnityTableModes(byId.s1, [1, 2, 3, 0, 1, 2, 0, 0, 0]), [1, 2, 3, 0, 1, 2]);
});

test('toUnityTableModes drops lights-on for s1', () => {
  const { byId } = viewContext();

  // s1 沒有開燈（4），不認得的值一律當 0。
  assert.deepEqual(toUnityTableModes(byId.s1, [1, 4, 3, 4, 0, 2, 0, 0, 4]), [1, 0, 3, 0, 0, 2]);
});

test('toUnityTableModes still reverses when a profile asks for the reversed order', () => {
  const { byId } = viewContext();
  const reversedEight = { ...byId.s1, seatCount: 8, seatOrder: 'reversed' };

  // 反轉順序仍是設定檔的合法選項（2026-03 版）：座位 1 → Region 7、座位 2 → Region 6 …
  assert.deepEqual(toUnityTableModes(reversedEight, [1, 2, 3, 0, 0, 0, 0, 0, 2]), [0, 0, 0, 0, 0, 3, 2, 1]);
});

test('toUnityTableModes treats a missing array as all zeros', () => {
  const { byId } = viewContext();

  assert.deepEqual(toUnityTableModes(byId.s1, undefined), [0, 0, 0, 0, 0, 0]);
});

test('createRoomState sends s1 six console-order seats and no ground theme', () => {
  const { state, byId } = viewContext();
  state.profiles.s1.contentMode = 8;
  state.profiles.s1.tableModes[0] = 1;

  const room = createRoomState(state, byId.s1);

  assert.deepEqual(room, {
    contentMode: 8,
    maskMode: 1,
    tableModes: [1, 0, 0, 0, 0, 0],
    logo: { ...DEFAULT_LOGO },
  });
});

test('createRoomState sends s2 nine direct seats and its ground theme', () => {
  const { state, byId } = viewContext();
  state.profiles.s2.groundThemeId = 'watergrass';
  state.profiles.s2.tableModes[8] = 4;

  const room = createRoomState(state, byId.s2);

  assert.equal(room.groundThemeId, 'watergrass');
  assert.deepEqual(room.tableModes, [0, 0, 0, 0, 0, 0, 0, 0, 4]);
});

test('createConsoleState exposes the areas of every profile plus the work lights', () => {
  const ctx = viewContext();
  const state = { ...ctx.state, activeProfile: 's1' };

  const view = createConsoleState(state, { ...ctx, agentConnected: true, rooms: [{ build: 's1', role: 'both' }] });

  assert.equal(view.activeProfile, 's1');
  assert.ok('Main-s1' in view.surfaceStates);
  assert.ok('Light1-s1' in view.surfaceStates);
  assert.ok('Light1-s2' in view.surfaceStates);
  assert.ok('Main-s2' in view.surfaceStates, 'the console controls both profiles');
  assert.equal(view.tableModes.length, 9);
  assert.equal(view.groundThemeId, 'none');
  assert.deepEqual(view.agent, { connected: true });
  assert.deepEqual(view.rooms, [{ build: 's1', role: 'both' }]);
  assert.equal(view.switch.status, 'idle');
  assert.deepEqual(view.profileCatalog.map(({ id }) => id), ['s1', 's2']);
  assert.deepEqual(view.profileCatalog[0].areas[0], { name: 'Main-s1', label: 'Main', group: null });
  assert.equal(view.profileCatalog[0].seatCount, 6);
  assert.deepEqual(view.profileCatalog[0].seatModeLabels, { 0: '預設' });
  assert.equal(view.profileCatalog[1].ground, true);
});

test('createConsoleState does not leak mutable references into the persisted state', () => {
  const ctx = viewContext();
  const view = createConsoleState(ctx.state, ctx);

  view.tableModes[0] = 3;
  view.surfaceStates['Main-s2'] = true;

  assert.equal(ctx.state.profiles.s2.tableModes[0], 0);
  assert.equal(ctx.state.profiles.s2.surfaceStates['Main-s2'], false);
});

test('viewKindForClient routes rooms by build and everyone else to the console view', () => {
  assert.equal(viewKindForClient({ kind: 'room', build: 's1' }, 's1'), 'room');
  assert.equal(viewKindForClient({ kind: 'room', build: 's2' }, 's1'), null);
  assert.equal(viewKindForClient({ kind: 'web' }, 's1'), 'console');
  assert.equal(viewKindForClient({ kind: 'tracker' }, 's1'), 'console');
  assert.equal(viewKindForClient({ kind: 'unknown' }, 's1'), 'console');
});

test('classifyClient maps the legacy unity name to the tracker and room to Unity content', () => {
  assert.equal(classifyClient({ clientType: 'unity' }), 'tracker');
  assert.equal(classifyClient({ clientType: 'room' }), 'room');
  assert.equal(classifyClient({ clientType: 'web' }), 'web');
  assert.equal(classifyClient({ clientType: 'something' }), 'unknown');
  assert.equal(classifyClient({}), 'unknown');
});
