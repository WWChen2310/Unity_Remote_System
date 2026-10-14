'use strict';

// 疊在桌面輸出最上層的 Logo：設定正規化與上傳圖檔的驗證。
// Logo 是全域的，不屬於任何投影方案：s1、s2 共用同一張圖與同一組設定，切換方案不會改變它。
// 這裡不碰網路與檔案，全部可以直接測試。

const crypto = require('node:crypto');

// Unity 的 Texture2D.LoadImage 只認 PNG 與 JPEG，其他格式在控制台就擋掉。
const LOGO_FORMATS = Object.freeze({
  'image/png': Object.freeze({ extension: 'png', magic: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] }),
  'image/jpeg': Object.freeze({ extension: 'jpg', magic: [0xff, 0xd8, 0xff] }),
});
// 圖會原樣經 WebSocket 送給每個 Unity 與控制台，太大會卡住其他指令。
const MAX_LOGO_BYTES = 4 * 1024 * 1024;

// scale：Logo 高度佔輸出高度的比例。x / y：Logo 中心，(0,0) 左上、(1,1) 右下，與追蹤 UV 相同。
// rotation：順時針角度。
const LOGO_LIMITS = Object.freeze({
  scale: Object.freeze({ min: 0.02, max: 1 }),
  rotation: Object.freeze({ min: -180, max: 180 }),
  x: Object.freeze({ min: 0, max: 1 }),
  y: Object.freeze({ min: 0, max: 1 }),
});

const DEFAULT_LOGO = Object.freeze({
  enabled: false,
  scale: 0.2,
  rotation: 0,
  x: 0.5,
  y: 0.5,
  imageId: null,
  mime: null,
});

const ADJUSTABLE_FIELDS = Object.freeze(Object.keys(LOGO_LIMITS));

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function clamp(value, { min, max }) {
  return Math.min(max, Math.max(min, value));
}

function readNumber(value, field, fallback) {
  return typeof value === 'number' && Number.isFinite(value) ? clamp(value, LOGO_LIMITS[field]) : fallback;
}

/** 狀態檔或舊版本讀進來的值：不合法的欄位回到預設，沒有圖就不能是開啟狀態。 */
function normalizeLogoSettings(raw) {
  const source = isPlainObject(raw) ? raw : {};
  const hasImage = typeof source.imageId === 'string'
    && source.imageId !== ''
    && Object.prototype.hasOwnProperty.call(LOGO_FORMATS, source.mime);

  const logo = {
    enabled: hasImage && source.enabled === true,
    imageId: hasImage ? source.imageId : null,
    mime: hasImage ? source.mime : null,
  };
  for (const field of ADJUSTABLE_FIELDS) {
    logo[field] = readNumber(source[field], field, DEFAULT_LOGO[field]);
  }
  return logo;
}

/**
 * 套用控制台送來的 logoControl。只改有帶的欄位；數值超出範圍就夾回範圍內，
 * 讓拖曳滑桿時不會因為一點誤差整筆被拒絕。型別錯誤或沒有圖還要開啟，回傳 error。
 */
function applyLogoControl(current, command) {
  const next = { ...current };
  let changed = false;

  if (command.enabled !== undefined) {
    if (typeof command.enabled !== 'boolean') {
      return { error: 'invalidLogoSettings' };
    }
    if (command.enabled && !current.imageId) {
      return { error: 'noLogoImage' };
    }
    next.enabled = command.enabled;
    changed = true;
  }

  for (const field of ADJUSTABLE_FIELDS) {
    if (command[field] === undefined) continue;
    if (typeof command[field] !== 'number' || !Number.isFinite(command[field])) {
      return { error: 'invalidLogoSettings' };
    }
    next[field] = clamp(command[field], LOGO_LIMITS[field]);
    changed = true;
  }

  if (!changed) {
    return { error: 'invalidLogoSettings' };
  }
  return { logo: next };
}

/**
 * 驗證控制台上傳的 data URL（data:image/png;base64,...）。
 * 宣告的格式要與檔頭一致，避免把別的檔案改名後送進 Unity。
 */
function parseLogoUpload(dataUrl) {
  if (typeof dataUrl !== 'string') {
    return { error: 'invalidLogoImage' };
  }
  const match = /^data:([a-z/]+);base64,([A-Za-z0-9+/=\s]+)$/.exec(dataUrl);
  if (!match || !Object.prototype.hasOwnProperty.call(LOGO_FORMATS, match[1])) {
    return { error: 'unsupportedLogoFormat' };
  }

  const mime = match[1];
  const buffer = Buffer.from(match[2], 'base64');
  if (buffer.length === 0) {
    return { error: 'invalidLogoImage' };
  }
  if (buffer.length > MAX_LOGO_BYTES) {
    return { error: 'logoTooLarge' };
  }
  const { magic } = LOGO_FORMATS[mime];
  if (buffer.length < magic.length || !magic.every((byte, index) => buffer[index] === byte)) {
    return { error: 'invalidLogoImage' };
  }

  return { mime, buffer, imageId: logoImageId(buffer) };
}

/** 圖的內容雜湊。Unity 與控制台用它判斷手上的圖是不是最新的。 */
function logoImageId(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex').slice(0, 16);
}

function logoFileName(mime) {
  return `room-logo.${LOGO_FORMATS[mime].extension}`;
}

/** 送給 Unity 與控制台的圖。data 是不含前綴的 base64，Unity 直接 Convert.FromBase64String。 */
function createLogoImageMessage(logo, buffer) {
  return {
    type: 'logoImage',
    imageId: logo.imageId,
    mime: logo.mime,
    data: buffer.toString('base64'),
  };
}

module.exports = {
  LOGO_FORMATS,
  MAX_LOGO_BYTES,
  LOGO_LIMITS,
  DEFAULT_LOGO,
  normalizeLogoSettings,
  applyLogoControl,
  parseLogoUpload,
  logoImageId,
  logoFileName,
  createLogoImageMessage,
};
