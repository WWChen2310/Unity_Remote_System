'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  createSeatSettings,
  seatModesFor,
  isSeatPanelAvailable,
} = require('../interface/control-settings');

test('createSeatSettings returns seats zero through eight in display order', () => {
  assert.deepEqual(
    createSeatSettings().map(({ index }) => index),
    [0, 1, 2, 3, 4, 5, 6, 7, 8],
  );
});

test('createSeatSettings labels seats one through nine', () => {
  assert.deepEqual(
    createSeatSettings().map(({ label }) => label),
    ['座位 1', '座位 2', '座位 3', '座位 4', '座位 5', '座位 6', '座位 7', '座位 8', '座位 9'],
  );
});

test('createSeatSettings builds eight seats for an eight-seat profile', () => {
  assert.deepEqual(
    createSeatSettings(8).map(({ label }) => label),
    ['座位 1', '座位 2', '座位 3', '座位 4', '座位 5', '座位 6', '座位 7', '座位 8'],
  );
});

test('seatModesFor keeps canonical order and applies per-profile labels', () => {
  assert.deepEqual(
    seatModesFor([3, 0, 1, 2], { 0: '預設' }).map(({ value, label }) => [value, label]),
    [[0, '預設'], [1, '海洋'], [2, '森林'], [3, '液態食物']],
  );
});

test('seatModesFor without overrides uses the shared labels', () => {
  assert.deepEqual(
    seatModesFor([0, 1, 2, 3, 4]).map(({ label }) => label),
    ['關燈', '海洋', '森林', '液態食物', '開燈'],
  );
});

test('isSeatPanelAvailable honours only-in and locked-in mode lists', () => {
  const s1 = { seatOnlyInModes: [8], seatLockedInModes: [] };
  const s2 = { seatOnlyInModes: [], seatLockedInModes: [4, 5] };

  assert.equal(isSeatPanelAvailable(s1, 8), true);
  assert.equal(isSeatPanelAvailable(s1, 2), false);
  assert.equal(isSeatPanelAvailable(s2, 4), false);
  assert.equal(isSeatPanelAvailable(s2, 5), false);
  assert.equal(isSeatPanelAvailable(s2, 8), true);
  assert.equal(isSeatPanelAvailable(s2, 1), true);
});

test('README requires both browser files and no longer serves HTML for every request', () => {
  const readme = fs.readFileSync(path.join(__dirname, '..', 'Readme.md'), 'utf8');

  assert.match(readme, /`interface\/console\.html`/);
  assert.match(readme, /`interface\/control-settings\.js`/);
  assert.doesNotMatch(readme, /path\.join\(__dirname,\s*['"]index\.html['"]\)/);
  assert.doesNotMatch(readme, /只需將 HTML 放在網頁根目錄/);
});
