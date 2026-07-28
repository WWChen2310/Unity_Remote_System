'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  AREA_NAMES,
  createSeatSettings,
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

test('AREA_NAMES contains the six control areas in display order', () => {
  assert.deepEqual(
    AREA_NAMES,
    ['Main', 'T1', 'T2', 'T3', 'T4', 'Ground'],
  );
});

test('README requires both browser files and no longer serves HTML for every request', () => {
  const readme = fs.readFileSync(path.join(__dirname, '..', 'Readme.md'), 'utf8');

  assert.match(readme, /`interface\/console\.html`/);
  assert.match(readme, /`interface\/control-settings\.js`/);
  assert.doesNotMatch(readme, /path\.join\(__dirname,\s*['"]index\.html['"]\)/);
  assert.doesNotMatch(readme, /只需將 HTML 放在網頁根目錄/);
});
