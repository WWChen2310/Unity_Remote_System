'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { validateMadmapperConfig } = require('../control-model');

test('MadMapper config defines the required surface name and address mapping', () => {
  const config = require('../madmapper.config.json');
  const validated = validateMadmapperConfig(config);

  assert.deepEqual(
    validated.areas.map(({ name, oscAddress }) => ({ name, oscAddress })),
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

test('work lights and areas share one OSC target map', () => {
  const validated = validateMadmapperConfig(require('../madmapper.config.json'));

  for (const { name } of [...validated.areas, ...validated.lights]) {
    assert.ok(
      Object.prototype.hasOwnProperty.call(validated.targetMap, name),
      `${name} must be reachable through targetMap`,
    );
  }
});
