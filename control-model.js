'use strict';

// 座位狀態清單由介面那份共用模組定義，這裡直接沿用，
// 免得新增狀態時瀏覽器認得、伺服器卻把它濾掉。
const { SEAT_MODES, isValidSeatMode } = require('./interface/control-settings');

const SEAT_COUNT = 9;
// 方案 id 就是 Unity build 回報的 BuildId，也會出現在 MadMapper 設定與狀態檔的鍵裡。
const PROFILE_ID_PATTERN = /^[a-z0-9_-]+$/;

function normalizeTableModes(value) {
  const source = Array.isArray(value) ? value : [];
  return Array.from({ length: SEAT_COUNT }, (_, index) => {
    const mode = source[index];
    return isValidSeatMode(mode) ? mode : 0;
  });
}

const GROUND_THEMES = ['none', 'crops', 'watergrass'];

/**
 * 地面內容與桌面背景各自獨立。未知值一律落回 'none'（地面不輸出內容），
 * 而不是沿用桌面的主題——兩區永遠不會因為對方而改變。
 */
function normalizeGroundThemeId(value) {
  return GROUND_THEMES.includes(value) ? value : 'none';
}

function isValidGroundThemeId(value) {
  return GROUND_THEMES.includes(value);
}

function isValidTableIndex(value) {
  return Number.isInteger(value) && value >= 0 && value < SEAT_COUNT;
}

function isPlainObject(value) {
  return value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value));
}

/**
 * 每個投影方案各有一組 MadMapper 區域（s1 為 15 個 surface、s2 為六區），工作燈則是全域共用。
 * 送 OSC 與保存開關時，每個方案用自己的 targetMap（該方案區域 + 全部工作燈）。
 */
function validateMadmapperConfig(config) {
  if (!isPlainObject(config)) {
    throw new TypeError('MadMapper config must be a plain object');
  }

  if (typeof config.ip !== 'string' || config.ip.trim() === '') {
    throw new TypeError('MadMapper ip must be a nonempty string');
  }

  validatePort(config.port, 'port');
  validatePort(config.localPort, 'localPort');

  // 舊格式的頂層 areas 不做靜默相容：那樣 s1 會少掉全部區域，現場只會看到「按了沒反應」。
  if (Object.prototype.hasOwnProperty.call(config, 'areas') || !isPlainObject(config.profiles)) {
    throw new Error(
      'MadMapper config must list areas under profiles.<id>.areas; '
      + 'migrate the old top-level areas list as described in the Readme',
    );
  }

  // 舊格式的頂層 lights（兩版共用）也不做靜默相容：工作燈現在每版各有自己的 OSC 位址。
  if (Object.prototype.hasOwnProperty.call(config, 'lights')) {
    throw new Error(
      'MadMapper config must list work lights under profiles.<id>.lights; '
      + 'the shared top-level lights list is no longer supported',
    );
  }

  // 名稱是狀態檔與控制台指令的 key，跨方案、跨區域與工作燈都不能重複。
  const usedNames = new Set();
  const profiles = {};
  for (const [profileId, profileConfig] of Object.entries(config.profiles)) {
    if (!PROFILE_ID_PATTERN.test(profileId)) {
      throw new Error(`MadMapper profile id "${profileId}" must match ${PROFILE_ID_PATTERN}`);
    }
    if (!isPlainObject(profileConfig) || !Array.isArray(profileConfig.areas)) {
      throw new TypeError(`MadMapper profile "${profileId}" must have an areas array`);
    }
    if (profileConfig.areas.length === 0) {
      throw new Error(`MadMapper profile "${profileId}" must have at least one area`);
    }
    if (profileConfig.lights !== undefined && !Array.isArray(profileConfig.lights)) {
      throw new TypeError(`MadMapper profile "${profileId}" lights must be an array`);
    }

    // 工作燈與投影區域對 MadMapper 來說都只是「一個 OSC address 收 0/1」，
    // 所以驗證、狀態保存、送 OSC 共用同一條路徑，只有介面分區顯示不同。
    const areas = profileConfig.areas.map((area, index) => (
      normalizeTarget(area, index, `area of profile "${profileId}"`, usedNames)
    ));
    const lights = (profileConfig.lights || []).map((light, index) => (
      normalizeTarget(light, index, `light of profile "${profileId}"`, usedNames)
    ));
    const areaMap = Object.fromEntries(areas.map((area) => [area.name, area]));
    const lightMap = Object.fromEntries(lights.map((light) => [light.name, light]));

    profiles[profileId] = {
      areas,
      areaMap,
      lights,
      lightMap,
      targetMap: { ...areaMap, ...lightMap },
    };
  }

  if (Object.keys(profiles).length === 0) {
    throw new Error('MadMapper config must define at least one profile');
  }

  return {
    ip: config.ip,
    port: config.port,
    localPort: config.localPort,
    profiles,
  };
}

/**
 * name：狀態檔與控制台指令用的 key；label：按鈕上的字；oscAddress：實際送給 MadMapper 的位址。
 */
function normalizeTarget(entry, index, kind, usedNames) {
  const { name, oscAddress } = validateMadmapperTarget(entry, index, kind);
  if (usedNames.has(name)) {
    throw new Error(`MadMapper name "${name}" is duplicated`);
  }
  if (entry.group !== undefined && entry.group !== null && typeof entry.group !== 'string') {
    throw new TypeError(`MadMapper ${kind} "${name}" group must be a string`);
  }
  if (entry.label !== undefined && (typeof entry.label !== 'string' || entry.label === '')) {
    throw new TypeError(`MadMapper ${kind} "${name}" label must be a nonempty string`);
  }
  if (entry.defaultOn !== undefined && typeof entry.defaultOn !== 'boolean') {
    throw new TypeError(`MadMapper ${kind} "${name}" defaultOn must be true or false`);
  }

  usedNames.add(name);
  return {
    name,
    label: entry.label === undefined ? name : entry.label,
    oscAddress,
    group: typeof entry.group === 'string' ? entry.group : null,
    defaultOn: entry.defaultOn === true,
  };
}

function validateMadmapperTarget(entry, index, kind) {
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
    throw new TypeError(`MadMapper ${kind} at index ${index} must be an object`);
  }

  const { name, oscAddress } = entry;
  if (typeof name !== 'string' || name === '') {
    throw new TypeError(`MadMapper ${kind} at index ${index} must have a nonempty name`);
  }
  if (
    typeof oscAddress !== 'string'
    || oscAddress === ''
    || !oscAddress.startsWith('/')
  ) {
    throw new TypeError(
      `MadMapper ${kind} "${name}" oscAddress must be nonempty and start with a slash (/)`,
    );
  }

  return { name, oscAddress };
}

function validatePort(value, fieldName) {
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    throw new RangeError(`MadMapper ${fieldName} must be an integer from 1 to 65535`);
  }
}

function normalizeSurfaceStates(value, areaMap) {
  const source = value !== null && typeof value === 'object' ? value : {};
  return Object.fromEntries(
    Object.keys(areaMap).map((name) => [name, source[name] === true]),
  );
}

function createMadmapperOscMessage(areaMap, areaName, enabled) {
  if (!Object.prototype.hasOwnProperty.call(areaMap, areaName)) {
    return null;
  }

  const area = areaMap[areaName];

  return {
    address: area.oscAddress,
    args: [{ type: 'f', value: enabled ? 1.0 : 0.0 }],
  };
}

module.exports = {
  SEAT_COUNT,
  PROFILE_ID_PATTERN,
  SEAT_MODES,
  isValidSeatMode,
  GROUND_THEMES,
  normalizeGroundThemeId,
  isValidGroundThemeId,
  normalizeTableModes,
  isValidTableIndex,
  validateMadmapperConfig,
  normalizeSurfaceStates,
  createMadmapperOscMessage,
};
