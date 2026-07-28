'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const packageJson = require('../package.json');
const packageLock = require('../package-lock.json');

const {
  SEAT_COUNT,
  normalizeTableModes,
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
    areas: [
      { name: 'Main', oscAddress: '/surfaces/Main' },
      { name: 'T1', oscAddress: '/surfaces/T1' },
      { name: 'T2', oscAddress: '/surfaces/T2' },
      { name: 'T3', oscAddress: '/surfaces/T3' },
      { name: 'T4', oscAddress: '/surfaces/T4' },
      { name: 'Ground', oscAddress: '/surfaces/Ground' },
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
    [0, 1, 2, 3, 0, 0, 0, 0, 3],
  );
});

test('isValidTableIndex accepts only integer indexes from zero through eight', () => {
  assert.equal(isValidTableIndex(0), true);
  assert.equal(isValidTableIndex(8), true);
  assert.equal(isValidTableIndex(-1), false);
  assert.equal(isValidTableIndex(9), false);
  assert.equal(isValidTableIndex(1.5), false);
});

test('validateMadmapperConfig returns normalized connection and area lookups', () => {
  const config = createValidConfig();
  const result = validateMadmapperConfig(config);

  assert.equal(result.ip, config.ip);
  assert.equal(result.port, config.port);
  assert.equal(result.localPort, config.localPort);
  assert.deepEqual(result.areas, config.areas);
  assert.deepEqual(
    Object.keys(result.areaMap).sort(),
    ['Ground', 'Main', 'T1', 'T2', 'T3', 'T4'].sort(),
  );
  assert.equal(result.areaMap.Main.oscAddress, '/surfaces/Main');
});

test('normalizeSurfaceStates keeps configured names and accepts only literal true', () => {
  const { areaMap } = validateMadmapperConfig(createValidConfig());

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
  const { areaMap } = validateMadmapperConfig(createValidConfig());

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
  config.areas[1] = { name: 'Main', oscAddress: '/surfaces/OtherMain' };

  assert.throws(
    () => validateMadmapperConfig(config),
    /duplicate.*Main|Main.*duplicate/i,
  );
});

test('validateMadmapperConfig rejects a missing required area', () => {
  const config = createValidConfig();
  config.areas = config.areas.filter(({ name }) => name !== 'Ground');

  assert.throws(
    () => validateMadmapperConfig(config),
    /missing.*Ground|Ground.*required/i,
  );
});

test('validateMadmapperConfig rejects OSC addresses that do not start with a slash', () => {
  const config = createValidConfig();
  config.areas[2].oscAddress = 'surfaces/T2';

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
