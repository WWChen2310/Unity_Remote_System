'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  DEFAULT_LOGO,
  MAX_LOGO_BYTES,
  normalizeLogoSettings,
  applyLogoControl,
  parseLogoUpload,
} = require('../logo-model');

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]);
const dataUrl = (mime, buffer) => `data:${mime};base64,${buffer.toString('base64')}`;

test('a missing or broken logo state falls back to the defaults, switched off', () => {
  assert.deepEqual(normalizeLogoSettings(undefined), { ...DEFAULT_LOGO });
  const logo = normalizeLogoSettings({ enabled: true, scale: 'big', rotation: 500, x: -1, imageId: '' });
  assert.equal(logo.enabled, false, 'no image means it cannot be on');
  assert.equal(logo.scale, DEFAULT_LOGO.scale);
  assert.equal(logo.rotation, 180);
  assert.equal(logo.x, 0);
});

test('logoControl changes only the fields it carries and clamps them', () => {
  const current = { ...DEFAULT_LOGO, imageId: 'abc', mime: 'image/png' };
  const { logo } = applyLogoControl(current, { scale: 0, rotation: -270 });
  assert.equal(logo.scale, 0.02);
  assert.equal(logo.rotation, -180);
  assert.equal(logo.x, current.x);
  assert.equal(logo.enabled, false);
});

test('logoControl refuses to turn on without an image and rejects wrong types', () => {
  assert.equal(applyLogoControl({ ...DEFAULT_LOGO }, { enabled: true }).error, 'noLogoImage');
  assert.equal(applyLogoControl({ ...DEFAULT_LOGO }, { enabled: false }).logo.enabled, false);
  assert.equal(applyLogoControl({ ...DEFAULT_LOGO }, { scale: '0.5' }).error, 'invalidLogoSettings');
  assert.equal(applyLogoControl({ ...DEFAULT_LOGO }, { rotation: Number.NaN }).error, 'invalidLogoSettings');
  assert.equal(applyLogoControl({ ...DEFAULT_LOGO }, {}).error, 'invalidLogoSettings');
});

test('uploads accept PNG and JPEG whose bytes match the declared type', () => {
  const png = parseLogoUpload(dataUrl('image/png', PNG));
  assert.equal(png.mime, 'image/png');
  assert.deepEqual(png.buffer, PNG);
  assert.match(png.imageId, /^[0-9a-f]{16}$/);
  assert.equal(parseLogoUpload(dataUrl('image/jpeg', JPEG)).mime, 'image/jpeg');
});

test('uploads reject other formats, mismatched bytes and oversized files', () => {
  assert.equal(parseLogoUpload(dataUrl('image/gif', PNG)).error, 'unsupportedLogoFormat');
  assert.equal(parseLogoUpload(dataUrl('image/png', JPEG)).error, 'invalidLogoImage');
  assert.equal(parseLogoUpload('not a data url').error, 'unsupportedLogoFormat');
  assert.equal(parseLogoUpload(42).error, 'invalidLogoImage');
  const huge = Buffer.concat([PNG, Buffer.alloc(MAX_LOGO_BYTES)]);
  assert.equal(parseLogoUpload(dataUrl('image/png', huge)).error, 'logoTooLarge');
});
