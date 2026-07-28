'use strict';

const SEAT_COUNT = 9;
const REQUIRED_AREA_NAMES = ['Main', 'T1', 'T2', 'T3', 'T4', 'Ground'];

function normalizeTableModes(value) {
  const source = Array.isArray(value) ? value : [];
  return Array.from({ length: SEAT_COUNT }, (_, index) => {
    const mode = source[index];
    return Number.isInteger(mode) && mode >= 0 && mode <= 3 ? mode : 0;
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

function validateMadmapperConfig(config) {
  if (
    config === null
    || typeof config !== 'object'
    || Array.isArray(config)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(config))
  ) {
    throw new TypeError('MadMapper config must be a plain object');
  }

  if (typeof config.ip !== 'string' || config.ip.trim() === '') {
    throw new TypeError('MadMapper ip must be a nonempty string');
  }

  validatePort(config.port, 'port');
  validatePort(config.localPort, 'localPort');

  if (!Array.isArray(config.areas)) {
    throw new TypeError('MadMapper areas must be an array');
  }

  const areaMap = {};
  const areas = config.areas.map((area, index) => {
    if (area === null || typeof area !== 'object' || Array.isArray(area)) {
      throw new TypeError(`MadMapper area at index ${index} must be an object`);
    }

    const { name, oscAddress } = area;
    if (typeof name !== 'string' || name === '') {
      throw new TypeError(`MadMapper area at index ${index} must have a nonempty name`);
    }
    if (Object.prototype.hasOwnProperty.call(areaMap, name)) {
      throw new Error(`MadMapper area name "${name}" is duplicated`);
    }
    if (!REQUIRED_AREA_NAMES.includes(name)) {
      throw new Error(`MadMapper area name "${name}" is not a required area`);
    }
    if (
      typeof oscAddress !== 'string'
      || oscAddress === ''
      || !oscAddress.startsWith('/')
    ) {
      throw new TypeError(
        `MadMapper area "${name}" oscAddress must be nonempty and start with a slash (/)`,
      );
    }

    const normalizedArea = { name, oscAddress };
    areaMap[name] = normalizedArea;
    return normalizedArea;
  });

  for (const requiredName of REQUIRED_AREA_NAMES) {
    if (!Object.prototype.hasOwnProperty.call(areaMap, requiredName)) {
      throw new Error(`MadMapper config is missing required area "${requiredName}"`);
    }
  }

  if (areas.length !== REQUIRED_AREA_NAMES.length) {
    throw new Error(
      `MadMapper config must contain exactly ${REQUIRED_AREA_NAMES.length} required areas`,
    );
  }

  return {
    ip: config.ip,
    port: config.port,
    localPort: config.localPort,
    areas,
    areaMap,
  };
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
  GROUND_THEMES,
  normalizeGroundThemeId,
  isValidGroundThemeId,
  normalizeTableModes,
  isValidTableIndex,
  validateMadmapperConfig,
  normalizeSurfaceStates,
  createMadmapperOscMessage,
};
