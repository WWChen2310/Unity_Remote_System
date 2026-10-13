'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const packageJson = require('../package.json');
const packageLock = require('../package-lock.json');

const {
  SEAT_COUNT,
  GROUND_THEMES,
  normalizeGroundThemeId,
  isValidGroundThemeId,
  normalizeTableModes,
  SEAT_MODES,
  isValidSeatMode,
  isValidTableIndex,
  validateMadmapperConfig,
  normalizeSurfaceStates,
  createMadmapperOscMessage,
} = require('../control-model');

test('package requires Node 18 or newer for the built-in test runner', () => {
  assert.equal(packageJson.engines.node, '>=18.1.0');
  assert.equal(packageLock.packages[''].engines.node, '>=18.1.0');
});

function createValidConfig() {
  return {
    ip: '127.0.0.1',
    port: 8010,
    localPort: 8011,
    profiles: {
      s1: {
        areas: [
          { name: 'Main-1', group: '模式一', oscAddress: '/surfaces/Main-1', defaultOn: true },
          { name: 'Main-2', group: '模式二', oscAddress: '/surfaces/Main-2' },
        ],
      },
      s2: {
        areas: [
          { name: 'Main', oscAddress: '/surfaces/Main' },
          { name: 'T1', oscAddress: '/surfaces/T1' },
          { name: 'T2', oscAddress: '/surfaces/T2' },
          { name: 'T3', oscAddress: '/surfaces/T3' },
          { name: 'T4', oscAddress: '/surfaces/T4' },
          { name: 'Ground', oscAddress: '/surfaces/Ground' },
        ],
      },
    },
    lights: [
      { name: 'Light1', oscAddress: '/surfaces/Light1' },
      { name: 'Light2', oscAddress: '/surfaces/Light2' },
      { name: 'Light3', oscAddress: '/surfaces/Light3' },
    ],
  };
}

test('SEAT_COUNT is nine', () => {
  assert.equal(SEAT_COUNT, 9);
});

test('normalizeTableModes pads eight valid seats with a trailing zero', () => {
  assert.deepEqual(
    normalizeTableModes([3, 2, 1, 0, 3, 2, 1, 0]),
    [3, 2, 1, 0, 3, 2, 1, 0, 0],
  );
});

test('normalizeTableModes truncates oversized input and replaces invalid values', () => {
  assert.deepEqual(
    normalizeTableModes([0, 1, 2, 3, -1, 4, '2', null, 3, 1]),
    [0, 1, 2, 3, 0, 4, 0, 0, 3],
  );
});

// 座位狀態的順序就是送給 Unity 的數值，也是 Unity StatusSetting.settings 的索引。
test('seat modes cover 關燈 through 開燈 in the order Unity expects', () => {
  assert.deepEqual(
    SEAT_MODES.map(({ value, label }) => [value, label]),
    [[0, '關燈'], [1, '海洋'], [2, '森林'], [3, '液態食物'], [4, '開燈']],
  );
  assert.equal(isValidSeatMode(4), true);
  assert.equal(isValidSeatMode(5), false);
  assert.equal(isValidSeatMode(-1), false);
  assert.equal(isValidSeatMode(1.5), false);
});

test('isValidTableIndex accepts only integer indexes from zero through eight', () => {
  assert.equal(isValidTableIndex(0), true);
  assert.equal(isValidTableIndex(8), true);
  assert.equal(isValidTableIndex(-1), false);
  assert.equal(isValidTableIndex(9), false);
  assert.equal(isValidTableIndex(1.5), false);
});

test('validateMadmapperConfig returns connection settings and per-profile lookups', () => {
  const config = createValidConfig();
  const result = validateMadmapperConfig(config);

  assert.equal(result.ip, config.ip);
  assert.equal(result.port, config.port);
  assert.equal(result.localPort, config.localPort);
  assert.deepEqual(Object.keys(result.profiles).sort(), ['s1', 's2']);
  assert.deepEqual(
    Object.keys(result.profiles.s2.areaMap).sort(),
    ['Ground', 'Main', 'T1', 'T2', 'T3', 'T4'].sort(),
  );
  assert.equal(result.profiles.s2.areaMap.Main.oscAddress, '/surfaces/Main');
});

test('validateMadmapperConfig builds one target map per profile with the lights in each', () => {
  const { profiles } = validateMadmapperConfig(createValidConfig());

  assert.ok(profiles.s1.targetMap['Main-1']);
  assert.ok(profiles.s1.targetMap.Light1, 'work lights are reachable from every profile');
  assert.ok(profiles.s2.targetMap.Light1);
  assert.equal(profiles.s2.targetMap['Main-1'], undefined);
  assert.equal(profiles.s1.targetMap.Main, undefined);
});

test('validateMadmapperConfig keeps optional group and defaultOn', () => {
  const { profiles } = validateMadmapperConfig(createValidConfig());

  assert.equal(profiles.s1.areaMap['Main-1'].group, '模式一');
  assert.equal(profiles.s1.areaMap['Main-1'].defaultOn, true);
  assert.equal(profiles.s1.areaMap['Main-2'].defaultOn, false);
  assert.equal(profiles.s2.areaMap.Main.group, null);
  assert.equal(profiles.s2.areaMap.Main.defaultOn, false);
});

test('normalizeSurfaceStates keeps configured names and accepts only literal true', () => {
  const { areaMap } = validateMadmapperConfig(createValidConfig()).profiles.s2;

  assert.deepEqual(
    normalizeSurfaceStates(
      {
        Main: true,
        T1: false,
        T2: 1,
        T3: 'true',
        T4: null,
        Ground: true,
        legacyMain: true,
        MainSurface: true,
      },
      areaMap,
    ),
    {
      Main: true,
      T1: false,
      T2: false,
      T3: false,
      T4: false,
      Ground: true,
    },
  );
});

test('createMadmapperOscMessage uses the configured address and float values', () => {
  const { areaMap } = validateMadmapperConfig(createValidConfig()).profiles.s2;

  assert.deepEqual(createMadmapperOscMessage(areaMap, 'T3', true), {
    address: '/surfaces/T3',
    args: [{ type: 'f', value: 1.0 }],
  });
  assert.deepEqual(createMadmapperOscMessage(areaMap, 'Ground', false), {
    address: '/surfaces/Ground',
    args: [{ type: 'f', value: 0.0 }],
  });
  assert.equal(createMadmapperOscMessage(areaMap, 'Unknown', true), null);
  assert.equal(createMadmapperOscMessage(areaMap, 'toString', true), null);
});

test('validateMadmapperConfig rejects duplicate area names', () => {
  const config = createValidConfig();
  config.profiles.s2.areas[1] = { name: 'Main', oscAddress: '/surfaces/OtherMain' };

  assert.throws(
    () => validateMadmapperConfig(config),
    /duplicate.*Main|Main.*duplicate/i,
  );
});

test('validateMadmapperConfig rejects an area name used by two profiles', () => {
  const config = createValidConfig();
  config.profiles.s1.areas.push({ name: 'Main', oscAddress: '/surfaces/Main' });

  assert.throws(
    () => validateMadmapperConfig(config),
    /duplicate.*Main|Main.*duplicate/i,
  );
});

test('validateMadmapperConfig rejects an area that reuses a work light name', () => {
  const config = createValidConfig();
  config.profiles.s2.areas.push({ name: 'Light1', oscAddress: '/surfaces/Light1b' });

  assert.throws(
    () => validateMadmapperConfig(config),
    /duplicate.*Light1|Light1.*duplicate/i,
  );
});

test('validateMadmapperConfig rejects a profile without areas', () => {
  const config = createValidConfig();
  config.profiles.s1.areas = [];

  assert.throws(() => validateMadmapperConfig(config), /s1.*at least one area/i);
});

test('validateMadmapperConfig rejects the legacy top-level areas list', () => {
  const config = createValidConfig();
  config.areas = config.profiles.s2.areas;
  delete config.profiles;

  assert.throws(() => validateMadmapperConfig(config), /profiles.*Readme/i);
});

test('validateMadmapperConfig rejects profile ids the Unity builds cannot report', () => {
  const config = createValidConfig();
  config.profiles['S 1'] = config.profiles.s1;
  delete config.profiles.s1;

  assert.throws(() => validateMadmapperConfig(config), /profile id/i);
});

test('validateMadmapperConfig rejects a non-string group and a non-boolean defaultOn', () => {
  const groupConfig = createValidConfig();
  groupConfig.profiles.s1.areas[0].group = 1;
  assert.throws(() => validateMadmapperConfig(groupConfig), /group/i);

  const defaultOnConfig = createValidConfig();
  defaultOnConfig.profiles.s1.areas[0].defaultOn = 'yes';
  assert.throws(() => validateMadmapperConfig(defaultOnConfig), /defaultOn/i);
});

test('validateMadmapperConfig rejects OSC addresses that do not start with a slash', () => {
  const config = createValidConfig();
  config.profiles.s2.areas[2].oscAddress = 'surfaces/T2';

  assert.throws(
    () => validateMadmapperConfig(config),
    /oscAddress.*slash|oscAddress.*\//i,
  );
});

test('validateMadmapperConfig rejects an empty IP address', () => {
  const config = createValidConfig();
  config.ip = '';

  assert.throws(() => validateMadmapperConfig(config), /ip.*nonempty|ip.*empty/i);
});

test('validateMadmapperConfig rejects invalid remote and local ports', () => {
  for (const [field, value] of [
    ['port', 0],
    ['port', 65536],
    ['port', 1.5],
    ['localPort', 0],
    ['localPort', 65536],
    ['localPort', '8011'],
  ]) {
    const config = createValidConfig();
    config[field] = value;
    assert.throws(
      () => validateMadmapperConfig(config),
      new RegExp(`${field}.*integer|${field}.*1.*65535`, 'i'),
    );
  }
});

test('ground theme ids are limited to the three the console offers', () => {
  assert.deepStrictEqual(GROUND_THEMES, ['none', 'crops', 'watergrass']);
});

test('unknown ground themes fall back to none rather than to a table theme', () => {
  // 地面與桌面互相獨立：無法辨識的值必須是「不輸出內容」，
  // 絕不能沿用桌面正在播的主題。
  assert.strictEqual(normalizeGroundThemeId('ocean'), 'none');
  assert.strictEqual(normalizeGroundThemeId(undefined), 'none');
  assert.strictEqual(normalizeGroundThemeId(null), 'none');
  assert.strictEqual(normalizeGroundThemeId(4), 'none');
  assert.strictEqual(normalizeGroundThemeId('crops'), 'crops');
  assert.strictEqual(normalizeGroundThemeId('watergrass'), 'watergrass');
});

test('ground theme validation rejects anything outside the supported set', () => {
  assert.strictEqual(isValidGroundThemeId('none'), true);
  assert.strictEqual(isValidGroundThemeId('crops'), true);
  assert.strictEqual(isValidGroundThemeId('watergrass'), true);
  assert.strictEqual(isValidGroundThemeId('starfield'), false);
  assert.strictEqual(isValidGroundThemeId(''), false);
});
