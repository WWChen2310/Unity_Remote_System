'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { validateMadmapperConfig } = require('../control-model');

// 現場 MadMapper 的 OSC 位址是 /surfaces/<版本>/<名稱>-<版本>/opacity（2026-10 起），
// 資料夾那層的版本是大寫（S1），名稱尾碼的版本是小寫（s1），例如 /surfaces/S1/Main-s1/opacity
// （d997551 把尾碼改成小寫，現場負責人確認小寫才對）。位址必須一字不差，否則按了沒反應而且沒有錯誤。
// name 是狀態檔與控制台指令用的 key（小寫版本代號），label 是按鈕上的字。
const expectedTargets = (profileId, labels) => labels.map((label) => {
  const tag = profileId.toUpperCase();
  return { name: `${label}-${profileId}`, label, oscAddress: `/surfaces/${tag}/${label}-${profileId}/opacity` };
});
const lightTargets = (profileId) => [1, 2, 3].map((n) => {
  const tag = profileId.toUpperCase();
  return { name: `Light${n}-${profileId}`, label: `工作燈 ${n}`, oscAddress: `/surfaces/${tag}/Light${n}-${profileId}/opacity` };
});
const pick = (targets) => targets.map(({ name, label, oscAddress }) => ({ name, label, oscAddress }));

test('s1 has the six table surfaces Main and T1–T5, all on by default, ungrouped', () => {
  const validated = validateMadmapperConfig(require('../madmapper.config.json'));
  const { areas } = validated.profiles.s1;

  assert.deepEqual(pick(areas), expectedTargets('s1', ['Main', 'T1', 'T2', 'T3', 'T4', 'T5']));
  assert.ok(areas.every(({ defaultOn }) => defaultOn));
  assert.ok(areas.every(({ group }) => group === null));
});

test('s2 has its six surfaces under the /surfaces/S2/ addresses', () => {
  const validated = validateMadmapperConfig(require('../madmapper.config.json'));

  assert.deepEqual(pick(validated.profiles.s2.areas), expectedTargets('s2', ['Main', 'T1', 'T2', 'T3', 'T4', 'Ground']));
});

test('each profile has its own three work lights, off by default', () => {
  const validated = validateMadmapperConfig(require('../madmapper.config.json'));

  for (const profileId of ['s1', 's2']) {
    const { lights } = validated.profiles[profileId];
    assert.deepEqual(pick(lights), lightTargets(profileId), profileId);
    assert.ok(lights.every(({ defaultOn }) => defaultOn === false), profileId);
  }
});

test('an area without a label shows its name', () => {
  const config = JSON.parse(JSON.stringify(require('../madmapper.config.json')));
  delete config.profiles.s1.areas[0].label;
  assert.equal(validateMadmapperConfig(config).profiles.s1.areas[0].label, 'Main-s1');

  config.profiles.s1.areas[0].label = 3;
  assert.throws(() => validateMadmapperConfig(config), /label must be a nonempty string/);
});

test('every profile reaches its own areas and work lights through one target map', () => {
  const validated = validateMadmapperConfig(require('../madmapper.config.json'));

  for (const [profileId, profile] of Object.entries(validated.profiles)) {
    for (const { name } of [...profile.areas, ...profile.lights]) {
      assert.ok(Object.prototype.hasOwnProperty.call(profile.targetMap, name), `${profileId}: ${name}`);
    }
  }
  assert.equal(validated.profiles.s1.targetMap['Light1-s2'], undefined, 'lights are not shared between profiles');
});
