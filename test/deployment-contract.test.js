'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const repositoryRoot = path.join(__dirname, '..');

function readUtf8(relativePath) {
  return fs.readFileSync(path.join(repositoryRoot, relativePath), 'utf8');
}

test('deployment JSON files parse successfully', () => {
  for (const file of ['madmapper.config.json', 'profiles.config.json', 'system_state.json', 'agent/agent.config.json']) {
    assert.doesNotThrow(() => JSON.parse(readUtf8(file)), file);
  }
});

test('persisted state is v3 with one entry per projection profile', () => {
  const { validateMadmapperConfig } = require('../control-model');
  const { validateProfilesConfig } = require('../profile-model');
  const madmapper = validateMadmapperConfig(JSON.parse(readUtf8('madmapper.config.json')));
  const profiles = validateProfilesConfig(JSON.parse(readUtf8('profiles.config.json')), madmapper, {});
  const state = JSON.parse(readUtf8('system_state.json'));

  assert.equal(state.version, 3);
  assert.ok(profiles.ids.includes(state.activeProfile));
  assert.equal(state.switch.status, 'idle');
  assert.deepEqual(Object.keys(state.profiles), profiles.ids);

  for (const profileId of profiles.ids) {
    const profileState = state.profiles[profileId];
    const profile = profiles.byId[profileId];
    assert.equal(profileState.tableModes.length, 9, profileId);
    assert.ok(profileState.tableModes.every((value) => profile.seatModes.includes(value)), profileId);
    assert.deepEqual(
      Object.keys(profileState.surfaceStates),
      madmapper.profiles[profileId].areas.map(({ name }) => name),
      profileId,
    );
    assert.ok(Object.values(profileState.surfaceStates).every((value) => typeof value === 'boolean'));
    assert.deepEqual(
      Object.keys(profileState.lightStates),
      madmapper.profiles[profileId].lights.map(({ name }) => name),
      profileId,
    );
  }

  assert.equal('lightStates' in state, false);
});

test('README documents the complete current deployment contract', () => {
  const readme = readUtf8('Readme.md');

  for (const requiredText of [
    '目前部署設定',
    '`madmapper.config.json`',
    '`Node.js >= 18.1`',
    '`npm ci`',
    '`npm install`',
    '`npm start`',
    '`ip`',
    '`port`',
    '`localPort`',
    '`oscAddress`',
    '`/surfaces/S2/Main-s2/opacity`',
    '`/surfaces/S1/Main-s1/opacity`',
    '`/surfaces/S1/Light1-s1/opacity`',
    '`profiles.<id>.lights`',
    '`Main-s2`、`T1-s2`、`T2-s2`、`T3-s2`、`T4-s2`、`Ground-s2`',
    '`Main-s1`、`T1-s1`～`T5-s1`',
    '`pm2 restart',
    '`node integrated-server.js`',
    '`interface/console.html`',
    '`interface/control-settings.js`',
    '`Assets/Script/Singleton/UnityModeController.cs`',
    '`SeatCount = 9`',
    '`Seat1` → `0`',
    '`Seat2` → `1`',
    '`Seat3` → `2`',
    '`Seat4` → `3`',
    '`Seat5` → `4`',
    '`Seat6` → `5`',
    '`Seat7` → `6`',
    '`Seat8` → `7`',
    '`Seat9` → `8`',
    '`Region ID 8`',
    '`CloudMaterials[8]`',
    '`RegionVFX`',
    '`RegionId = 8`',
    '至少 9',
    '請依上方「目前部署設定」',
    '每個 `UnityModeController` 生命週期只顯示一次',
    '投影方案',
    '`profiles.config.json`',
    '`agent/agent.config.json`',
    '`ROOM_AGENT_TOKEN`',
    '`RoomS1.exe`',
    '`RoomS2.exe`',
    '`build-info.json`',
    '192.168.0.201',
    '192.168.0.202',
    '3100',
    '?server=',
    '`npm run agent:ping',
    '`npm run fake-site`',
    'schtasks',
    '`-roomServerUrl`',
    '`profiles.<id>.areas`',
  ]) {
    assert.ok(readme.includes(requiredText), `README must include ${requiredText}`);
  }

  assert.match(readme, /完整.*`oscAddress`.*可.*修改/s);
  assert.match(readme, /Node(?:\.js)?.*傳送 OSC/s);
  assert.match(readme, /Unity.*不.*傳送 OSC/s);
  assert.match(readme, /不需.*Unity.*OSC.*套件/s);
  assert.match(readme, /缺少.*index 8.*執行時.*安全.*第九.*不會.*視覺/s);
  assert.match(readme, /Node JSON.*修改.*`oscAddress`/s);
  assert.match(readme, /OSC Address 不在 Unity Inspector 編輯/);
  assert.doesNotMatch(readme, /可在 Unity Inspector.*(?:OSC Address|`oscAddress`)/s);
  assert.doesNotMatch(readme, /建立新的 C# 腳本 `UnityModeController\.cs`/);
  assert.doesNotMatch(readme, /將 `UnityModeController\.cs` 拖曳到/);
  assert.doesNotMatch(readme, /npm install ws/);
  assert.doesNotMatch(readme, /node server\.js/);
});
