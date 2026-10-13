'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { validateMadmapperConfig } = require('../control-model');

const S1_AREA_NAMES = [
  'Main-1', 'T1-1', 'T2-1', 'T3-1', 'T4-1', 'T5-1', 'T6-1', 'T7-1',
  'Main-2', 'T2-2', 'T3-2', 'T4-2', 'T5-2', 'T6-2', 'T7-2',
];

test('MadMapper config keeps the six s2 surfaces at their existing addresses', () => {
  const validated = validateMadmapperConfig(require('../madmapper.config.json'));

  assert.deepEqual(
    validated.profiles.s2.areas.map(({ name, oscAddress }) => ({ name, oscAddress })),
    [
      { name: 'Main', oscAddress: '/surfaces/Main/opacity' },
      { name: 'T1', oscAddress: '/surfaces/T1/opacity' },
      { name: 'T2', oscAddress: '/surfaces/T2/opacity' },
      { name: 'T3', oscAddress: '/surfaces/T3/opacity' },
      { name: 'T4', oscAddress: '/surfaces/T4/opacity' },
      { name: 'Ground', oscAddress: '/surfaces/Ground/opacity' },
    ],
  );
});

// s1 的 15 個名稱來自 2026-03 版的 Node（SURFACES_SETTINGS），MadMapper 的 s1 拼接檔用的就是這組。
// 合併後的 MadMapper 專案必須用完全相同的名稱，否則按了沒反應而且沒有錯誤。
test('MadMapper config restores the fifteen s1 surfaces in two groups', () => {
  const validated = validateMadmapperConfig(require('../madmapper.config.json'));
  const { areas } = validated.profiles.s1;

  assert.deepEqual(areas.map(({ name }) => name), S1_AREA_NAMES);
  for (const { name, oscAddress } of areas) {
    assert.equal(oscAddress, `/surfaces/${name}/opacity`);
  }
  assert.deepEqual(
    areas.filter(({ defaultOn }) => defaultOn).map(({ name }) => name),
    S1_AREA_NAMES.filter((name) => name.endsWith('-1')),
  );
  assert.deepEqual(
    [...new Set(areas.map(({ group }) => group))],
    ['模式一', '模式二'],
  );
});

// 介面的燈名與 config 的燈名若不一致，按鈕會送出伺服器不認得的名字，
// 而伺服器只會 console.warn——現場看起來就是「按了沒反應」而且沒有錯誤。
// 這個測試把兩邊釘在一起，改了一邊沒改另一邊就會在這裡失敗。
test('work light names in the console match the shipped MadMapper config', () => {
  const validated = validateMadmapperConfig(require('../madmapper.config.json'));
  const { LIGHT_NAMES, LIGHT_LABELS } = require('../interface/control-settings');

  assert.deepEqual(validated.lights.map(({ name }) => name), [...LIGHT_NAMES]);

  for (const name of LIGHT_NAMES) {
    assert.equal(typeof LIGHT_LABELS[name], 'string', `${name} needs a display label`);
  }
});

test('every profile reaches its own areas and all work lights through one target map', () => {
  const validated = validateMadmapperConfig(require('../madmapper.config.json'));

  for (const profile of Object.values(validated.profiles)) {
    for (const { name } of [...profile.areas, ...validated.lights]) {
      assert.ok(
        Object.prototype.hasOwnProperty.call(profile.targetMap, name),
        `${name} must be reachable through targetMap`,
      );
    }
  }
});
