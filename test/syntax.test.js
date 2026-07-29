'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const repositoryRoot = path.join(__dirname, '..');

// integrated-server.js 開始監聽埠號，所以不能直接 require 進測試。
// 沒有任何測試載入它的結果是：它整支壞掉時 npm test 仍然全綠，
// 錯誤要到現場啟動伺服器才會出現。node --check 只做語法解析、不執行，
// 剛好補上這個缺口。
const SHIPPED_SOURCES = [
  'integrated-server.js',
  'control-model.js',
  'ecosystem.config.js',
  path.join('interface', 'control-settings.js'),
];

test('every shipped script parses, including the ones no test requires', () => {
  for (const relativePath of SHIPPED_SOURCES) {
    assert.doesNotThrow(
      () => execFileSync(
        process.execPath,
        ['--check', path.join(repositoryRoot, relativePath)],
        { stdio: 'pipe' },
      ),
      `${relativePath} failed to parse`,
    );
  }
});
