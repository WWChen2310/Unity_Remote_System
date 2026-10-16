'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { validateMadmapperConfig } = require('../control-model');

// 現場 MadMapper 的 surface 名稱以「-s1」「-s2」區分版本（2026-10 起）。
// name 必須與 MadMapper 完全一致，否則按了沒反應而且沒有錯誤；label 是控制台上顯示的短名稱。
const expectedAreas = (suffix, labels) => labels.map((label) => ({
  name: `${label}-${suffix}`,
  label,
  oscAddress: `/surfaces/${label}-${suffix}/opacity`,
}));

test('s1 has the six table surfaces Main and T1–T5, all on by default, ungrouped', () => {
  const validated = validateMadmapperConfig(require('../madmapper.config.json'));
  const { areas } = validated.profiles.s1;

  assert.deepEqual(
    areas.map(({ name, label, oscAddress }) => ({ name, label, oscAddress })),
    expectedAreas('s1', ['Main', 'T1', 'T2', 'T3', 'T4', 'T5']),
  );
  assert.ok(areas.every(({ defaultOn }) => defaultOn));
  assert.ok(areas.every(({ group }) => group === null));
});

test('s2 keeps its six surfaces under the -s2 MadMapper names', () => {
  const validated = validateMadmapperConfig(require('../madmapper.config.json'));

  assert.deepEqual(
    validated.profiles.s2.areas.map(({ name, label, oscAddress }) => ({ name, label, oscAddress })),
    expectedAreas('s2', ['Main', 'T1', 'T2', 'T3', 'T4', 'Ground']),
  );
});

test('an area without a label shows its name', () => {
  const config = JSON.parse(JSON.stringify(require('../madmapper.config.json')));
  delete config.profiles.s1.areas[0].label;
  assert.equal(validateMadmapperConfig(config).profiles.s1.areas[0].label, 'Main-s1');

  config.profiles.s1.areas[0].label = 3;
  assert.throws(() => validateMadmapperConfig(config), /label must be a nonempty string/);
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
