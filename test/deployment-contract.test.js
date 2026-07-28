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
  assert.doesNotThrow(() => JSON.parse(readUtf8('madmapper.config.json')));
  assert.doesNotThrow(() => JSON.parse(readUtf8('system_state.json')));
});

test('persisted state has the nine-seat and six-surface deployment shape', () => {
  const state = JSON.parse(readUtf8('system_state.json'));

  assert.ok(Array.isArray(state.tableModes));
  assert.equal(state.tableModes.length, 9);
  assert.ok(
    state.tableModes.every(
      (value) => Number.isInteger(value) && value >= 0 && value <= 3,
    ),
  );
  assert.deepEqual(Object.keys(state.surfaceStates), [
    'Main',
    'T1',
    'T2',
    'T3',
    'T4',
    'Ground',
  ]);
  assert.ok(
    Object.values(state.surfaceStates).every(
      (value) => typeof value === 'boolean',
    ),
  );
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
    '`/surfaces/Main/opacity`',
    '`/surfaces/T1/opacity`',
    '`/surfaces/T2/opacity`',
    '`/surfaces/T3/opacity`',
    '`/surfaces/T4/opacity`',
    '`/surfaces/Ground/opacity`',
    '`Main`、`T1`、`T2`、`T3`、`T4`、`Ground`',
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
