'use strict';

// 投影方案（projection profile）的純邏輯：設定驗證、狀態檔遷移、以及送給
// 控制台與 Unity 的兩種 view。這裡不碰網路與檔案，全部可以直接測試。

const {
  SEAT_COUNT,
  PROFILE_ID_PATTERN,
  normalizeGroundThemeId,
} = require('./control-model');
const { isValidSeatMode } = require('./interface/control-settings');
const { normalizeLogoSettings } = require('./logo-model');

const ROOM_ROLES = Object.freeze(['both', 'tables', 'ground']);
const SEAT_ORDERS = Object.freeze(['direct', 'reversed']);
// Unity 的 modeSceneNames 有 10 個場景（0 Mapping … 9 Black）。
const MAX_CONTENT_MODE = 9;
// 沒有 version 的狀態檔是 2026-07 版（九席、六區）的格式，屬於 s2。
const LEGACY_PROFILE_ID = 's2';
const DEFAULT_CONTENT_MODE = 1;

const DEFAULT_AUTO_CYCLE = Object.freeze({
  enabled: false,
  interval: 10,
  modes: [1, 2, 3, 4, 5],
  currentIndex: 0,
  remainingSeconds: 0,
});

function isPlainObject(value) {
  return value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value));
}

function fail(message) {
  throw new Error(`profiles.config.json: ${message}`);
}

function readContentModeList(value, field, profileId) {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)
    || !value.every((mode) => Number.isInteger(mode) && mode >= 0 && mode <= MAX_CONTENT_MODE)) {
    fail(`profile "${profileId}" ${field} must list content modes from 0 to ${MAX_CONTENT_MODE}`);
  }
  return [...value];
}

function readStringMap(value, field, profileId) {
  if (value === undefined) {
    return {};
  }
  if (!isPlainObject(value) || !Object.values(value).every((label) => typeof label === 'string')) {
    fail(`profile "${profileId}" ${field} must map numbers to labels`);
  }
  return { ...value };
}

function validateProfile(profileId, raw) {
  if (!isPlainObject(raw)) {
    fail(`profile "${profileId}" must be an object`);
  }

  if (typeof raw.label !== 'string' || raw.label.trim() === '') {
    fail(`profile "${profileId}" label must be a nonempty string`);
  }

  if (!Array.isArray(raw.rooms)
    || raw.rooms.length === 0
    || !raw.rooms.every((role) => ROOM_ROLES.includes(role))
    || new Set(raw.rooms).size !== raw.rooms.length) {
    fail(`profile "${profileId}" rooms must list distinct roles from ${ROOM_ROLES.join(', ')}`);
  }

  if (!Number.isInteger(raw.seatCount) || raw.seatCount < 1 || raw.seatCount > SEAT_COUNT) {
    fail(`profile "${profileId}" seatCount must be an integer from 1 to ${SEAT_COUNT}`);
  }

  if (!SEAT_ORDERS.includes(raw.seatOrder)) {
    fail(`profile "${profileId}" seatOrder must be one of ${SEAT_ORDERS.join(', ')}`);
  }

  if (!Array.isArray(raw.seatModes)
    || !raw.seatModes.every(isValidSeatMode)
    || new Set(raw.seatModes).size !== raw.seatModes.length) {
    fail(`profile "${profileId}" seatModes must list distinct known seat statuses`);
  }
  // 0 是座位的重置值；方案若沒有 0，重置與遷移時就沒有合法值可填。
  if (!raw.seatModes.includes(0)) {
    fail(`profile "${profileId}" seatModes must include 0`);
  }

  if (typeof raw.ground !== 'boolean') {
    fail(`profile "${profileId}" ground must be true or false`);
  }

  // 2026-10 起遮罩跟著方案走，不再由控制台切換；舊的 defaultMaskId 不再讀，避免兩版靜默用同一張遮罩。
  if (raw.defaultMaskId !== undefined && raw.maskId === undefined) {
    fail(`profile "${profileId}" defaultMaskId was replaced by maskId (the tracker mask this profile uses)`);
  }
  if (!Number.isInteger(raw.maskId) || raw.maskId < 1) {
    fail(`profile "${profileId}" maskId must be a positive integer (1 = the tracker's first mask)`);
  }

  if (typeof raw.readyTimeoutSec !== 'number' || !(raw.readyTimeoutSec > 0)) {
    fail(`profile "${profileId}" readyTimeoutSec must be a positive number`);
  }

  if (typeof raw.settleSec !== 'number' || !(raw.settleSec >= 0)) {
    fail(`profile "${profileId}" settleSec must be zero or more`);
  }

  return Object.freeze({
    id: profileId,
    label: raw.label,
    rooms: Object.freeze([...raw.rooms]),
    seatCount: raw.seatCount,
    seatOrder: raw.seatOrder,
    seatModes: Object.freeze([...raw.seatModes]),
    seatModeLabels: Object.freeze(readStringMap(raw.seatModeLabels, 'seatModeLabels', profileId)),
    seatOnlyInModes: Object.freeze(readContentModeList(raw.seatOnlyInModes, 'seatOnlyInModes', profileId)),
    seatLockedInModes: Object.freeze(readContentModeList(raw.seatLockedInModes, 'seatLockedInModes', profileId)),
    resetSeatsOnModes: Object.freeze(readContentModeList(raw.resetSeatsOnModes, 'resetSeatsOnModes', profileId)),
    ground: raw.ground,
    modeLabels: Object.freeze(readStringMap(raw.modeLabels, 'modeLabels', profileId)),
    maskId: raw.maskId,
    readyTimeoutMs: Math.round(raw.readyTimeoutSec * 1000),
    settleMs: Math.round(raw.settleSec * 1000),
  });
}

/**
 * 驗證 profiles.config.json。madmapper 是已驗證過的 MadMapper 設定，
 * 兩份檔案的方案 id 必須完全一致，否則某個方案切過去會沒有任何區域可開。
 */
function validateProfilesConfig(raw, madmapper, env = process.env) {
  if (!isPlainObject(raw)) {
    fail('must be a plain object');
  }

  const agent = raw.agent;
  if (!isPlainObject(agent)) {
    fail('agent must be an object');
  }
  if (typeof agent.url !== 'string' || !/^wss?:\/\/\S+$/.test(agent.url)) {
    fail('agent url must start with ws:// or wss://');
  }
  const token = (env && typeof env.ROOM_AGENT_TOKEN === 'string' && env.ROOM_AGENT_TOKEN !== '')
    ? env.ROOM_AGENT_TOKEN
    : agent.token;
  if (typeof token !== 'string' || token === '') {
    fail('agent token must be a nonempty string (or set ROOM_AGENT_TOKEN)');
  }
  if (typeof agent.requestTimeoutSec !== 'number' || !(agent.requestTimeoutSec > 0)) {
    fail('agent requestTimeoutSec must be a positive number');
  }

  if (!isPlainObject(raw.profiles) || Object.keys(raw.profiles).length === 0) {
    fail('profiles must define at least one profile');
  }

  const ids = Object.keys(raw.profiles);
  for (const profileId of ids) {
    if (!PROFILE_ID_PATTERN.test(profileId)) {
      fail(`profile id "${profileId}" must match ${PROFILE_ID_PATTERN}`);
    }
  }

  const madmapperIds = Object.keys(madmapper.profiles);
  for (const profileId of ids) {
    if (!madmapperIds.includes(profileId)) {
      fail(`profile "${profileId}" has no areas in madmapper.config.json`);
    }
  }
  for (const profileId of madmapperIds) {
    if (!ids.includes(profileId)) {
      fail(`madmapper.config.json defines profile "${profileId}" that is not listed here`);
    }
  }

  if (!ids.includes(raw.defaultProfile)) {
    fail(`defaultProfile "${raw.defaultProfile}" is not one of ${ids.join(', ')}`);
  }

  const byId = {};
  for (const profileId of ids) {
    byId[profileId] = validateProfile(profileId, raw.profiles[profileId]);
  }

  return Object.freeze({
    agent: Object.freeze({
      url: agent.url,
      token,
      requestTimeoutMs: Math.round(agent.requestTimeoutSec * 1000),
    }),
    defaultProfile: raw.defaultProfile,
    ids: Object.freeze(ids),
    byId: Object.freeze(byId),
  });
}

/** 9 格、控制台順序（index 0 = 座位 1）；方案不允許的值與超出座位數的格子一律為 0。 */
function normalizeProfileTableModes(value, profile) {
  const source = Array.isArray(value) ? value : [];
  return Array.from({ length: SEAT_COUNT }, (_, index) => {
    const mode = source[index];
    return index < profile.seatCount && profile.seatModes.includes(mode) ? mode : 0;
  });
}

function createDefaultProfileState(profile, madmapperProfile) {
  return {
    contentMode: DEFAULT_CONTENT_MODE,
    groundThemeId: 'none',
    tableModes: new Array(SEAT_COUNT).fill(0),
    surfaceStates: Object.fromEntries(
      madmapperProfile.areas.map(({ name, defaultOn }) => [name, defaultOn]),
    ),
    lightStates: Object.fromEntries(
      madmapperProfile.lights.map(({ name, defaultOn }) => [name, defaultOn]),
    ),
  };
}

/** legacyLights：2026-10 以前兩版共用的工作燈開關（key 為 Light1…），沒有新 key 時沿用。 */
function normalizeProfileState(raw, profile, madmapperProfile, legacyLights = {}) {
  const defaults = createDefaultProfileState(profile, madmapperProfile);
  const source = isPlainObject(raw) ? raw : {};
  const surfaces = isPlainObject(source.surfaceStates) ? source.surfaceStates : {};
  const lights = isPlainObject(source.lightStates) ? source.lightStates : {};

  return {
    contentMode: Number.isInteger(source.contentMode)
      && source.contentMode >= 0
      && source.contentMode <= MAX_CONTENT_MODE
      ? source.contentMode
      : defaults.contentMode,
    groundThemeId: profile.ground ? normalizeGroundThemeId(source.groundThemeId) : 'none',
    tableModes: normalizeProfileTableModes(source.tableModes, profile),
    surfaceStates: Object.fromEntries(
      madmapperProfile.areas.map((area) => [area.name, readSurfaceState(surfaces, area)]),
    ),
    lightStates: Object.fromEntries(
      madmapperProfile.lights.map((light) => [light.name, readLightState(lights, legacyLights, light)]),
    ),
  };
}

/**
 * 工作燈原本兩版共用（Light1…），2026-10 起每版各自一組（Light1-s1、Light1-s2…）。
 * 沒有新 key 時，把共用時期同編號的開關帶到兩個版本。
 */
function readLightState(lights, legacyLights, { name, defaultOn }) {
  if (Object.prototype.hasOwnProperty.call(lights, name)) return lights[name] === true;
  const legacyName = name.replace(/-[^-]+$/, '');
  if (Object.prototype.hasOwnProperty.call(legacyLights, legacyName)) return legacyLights[legacyName] === true;
  return defaultOn;
}

/**
 * 2026-10 以前狀態檔用短名稱（Main、T1…）當 key，之後改用 MadMapper 的名稱（Main-s2…）。
 * 新名稱找不到時沿用與 label 同名的舊 key，現場更新後已保存的開關不會變回預設。
 */
function readSurfaceState(surfaces, { name, label, defaultOn }) {
  const has = (key) => Object.prototype.hasOwnProperty.call(surfaces, key);
  if (has(name)) return surfaces[name] === true;
  if (has(label)) return surfaces[label] === true;
  return defaultOn;
}

function normalizeSwitchState(raw) {
  const source = isPlainObject(raw) ? raw : {};
  const base = {
    status: 'idle',
    from: null,
    to: null,
    step: null,
    startedAt: null,
    error: null,
  };

  if (source.status === 'switching') {
    // Node 在切換途中重啟：不知道 Unity 停在哪一步，交給操作者決定重試或回到原方案。
    return {
      ...base,
      status: 'failed',
      from: source.from ?? null,
      to: source.to ?? null,
      step: source.step ?? null,
      startedAt: source.startedAt ?? null,
      error: 'Node 在切換途中重新啟動',
    };
  }

  if (source.status === 'failed') {
    return {
      ...base,
      status: 'failed',
      from: source.from ?? null,
      to: source.to ?? null,
      step: source.step ?? null,
      startedAt: source.startedAt ?? null,
      error: typeof source.error === 'string' ? source.error : '切換失敗',
    };
  }

  return base;
}

function normalizeAutoCycle(raw) {
  const source = isPlainObject(raw) ? raw : {};
  return {
    ...DEFAULT_AUTO_CYCLE,
    modes: [...DEFAULT_AUTO_CYCLE.modes],
    ...source,
    // 與原本的伺服器相同：載入時一律停用，避免重啟後自己開始切背景。
    enabled: false,
    remainingSeconds: 0,
  };
}

/**
 * 把磁碟上的狀態檔轉成 v3。沒有 version 的舊檔整份屬於 2026-07 版（s2），
 * 其他方案用預設值；工作燈的狀態從舊的共用欄位帶到每個方案自己的 lightStates。
 */
function migrateSystemState(raw, { profiles, madmapper }) {
  const source = isPlainObject(raw) ? raw : {};
  const isV3 = source.version === 3;

  let profileSources;
  let lightSource;
  let activeProfile;
  let switchSource;

  if (isV3) {
    profileSources = isPlainObject(source.profiles) ? source.profiles : {};
    lightSource = source.lightStates;
    activeProfile = source.activeProfile;
    switchSource = source.switch;
  } else {
    const legacyId = profiles.ids.includes(LEGACY_PROFILE_ID) ? LEGACY_PROFILE_ID : profiles.defaultProfile;
    profileSources = { [legacyId]: source };
    lightSource = source.surfaceStates;
    activeProfile = legacyId;
    switchSource = null;
  }

  const lights = isPlainObject(lightSource) ? lightSource : {};

  return {
    version: 3,
    activeProfile: profiles.ids.includes(activeProfile) ? activeProfile : profiles.defaultProfile,
    switch: normalizeSwitchState(switchSource),
    profiles: Object.fromEntries(profiles.ids.map((profileId) => [
      profileId,
      normalizeProfileState(
        profileSources[profileId],
        profiles.byId[profileId],
        madmapper.profiles[profileId],
        lights,
      ),
    ])),
    autoCycle: normalizeAutoCycle(source.autoCycle),
    // Logo 不屬於任何方案，切換方案也不會改變它。
    logo: normalizeLogoSettings(source.logo),
  };
}

// ---- views -----------------------------------------------------------------

/**
 * 把控制台順序的座位（index 0 = 座位 1）轉成這個 build 要的陣列。
 * 長度是 profile.seatCount；s1 的 Unity 接受 1–8 格，順序由 profile.seatOrder 決定：
 * direct 座位 1 → Region 0，reversed 座位 1 → Region seatCount - 1（2026-03 版的舊順序）。
 * s1 是 8 席 reversed（現場確認控制台座位 1 = Unity 座位 8）；控制台存的 9 格裡超出 seatCount 的部分不送。
 */
function toUnityTableModes(profile, stored) {
  const source = Array.isArray(stored) ? stored : [];
  const result = new Array(profile.seatCount).fill(0);
  for (let seat = 0; seat < profile.seatCount; seat += 1) {
    const value = profile.seatModes.includes(source[seat]) ? source[seat] : 0;
    const region = profile.seatOrder === 'reversed' ? profile.seatCount - 1 - seat : seat;
    result[region] = value;
  }
  return result;
}

/** 控制台渲染各卡片所需的方案描述。 */
function createProfileCatalog(profiles, madmapper) {
  return profiles.ids.map((profileId) => {
    const profile = profiles.byId[profileId];
    return {
      id: profile.id,
      label: profile.label,
      rooms: [...profile.rooms],
      seatCount: profile.seatCount,
      seatModes: [...profile.seatModes],
      seatModeLabels: { ...profile.seatModeLabels },
      seatOnlyInModes: [...profile.seatOnlyInModes],
      seatLockedInModes: [...profile.seatLockedInModes],
      ground: profile.ground,
      modeLabels: { ...profile.modeLabels },
      areas: madmapper.profiles[profileId].areas.map(({ name, label, group }) => ({ name, label, group })),
      lights: madmapper.profiles[profileId].lights.map(({ name, label }) => ({ name, label })),
    };
  });
}

/**
 * 送給控制台、追蹤端與尚未表明身分的連線。tableModes 固定 9 格、控制台順序：
 * s1 Unity 若在握手前先收到這份，會因長度不是 8 而忽略座位，不會以錯誤順序閃一下。
 */
function createConsoleState(state, { profiles, madmapper, agentConnected = false, rooms = [] }) {
  const active = state.profiles[state.activeProfile];
  return {
    activeProfile: state.activeProfile,
    switch: { ...state.switch },
    agent: { connected: agentConnected },
    rooms: rooms.map(({ build, role }) => ({ build, role })),
    contentMode: active.contentMode,
    // 追蹤端用這個欄位選遮罩；遮罩固定跟著方案，不存在狀態檔。
    maskMode: profiles.byId[state.activeProfile].maskId,
    groundThemeId: active.groundThemeId,
    tableModes: [...active.tableModes],
    // 控制台顯示每個方案的區域（非目前方案的鎖住，MadMapper 上是關的）；名稱不重複，可直接合併。
    surfaceStates: Object.assign(
      {},
      ...Object.values(state.profiles).flatMap((profile) => [profile.surfaceStates, profile.lightStates]),
    ),
    autoCycle: { ...state.autoCycle, modes: [...(state.autoCycle.modes || [])] },
    logo: { ...state.logo },
    profileCatalog: createProfileCatalog(profiles, madmapper),
  };
}

/** 送給 build 與目前方案相同的 Unity。沒有地面內容的方案不帶 groundThemeId。 */
function createRoomState(state, profile) {
  const profileState = state.profiles[profile.id];
  const room = {
    contentMode: profileState.contentMode,
    maskMode: profile.maskId,
    tableModes: toUnityTableModes(profile, profileState.tableModes),
    // 圖本身另外用 logoImage 送，這裡只有設定與 imageId。
    logo: { ...state.logo },
  };
  if (profile.ground) {
    room.groundThemeId = profileState.groundThemeId;
  }
  return room;
}

/**
 * 這個連線該收哪一種 view。非目前方案的 Unity 什麼都不送：
 * 它正在被關掉，或是有人手動開錯了 build，送過去只會讓它切到別的方案的背景。
 */
function viewKindForClient(clientInfo, activeProfile) {
  if (clientInfo && clientInfo.kind === 'room') {
    return clientInfo.build === activeProfile ? 'room' : null;
  }
  return 'console';
}

/**
 * 依 clientType 分類。追蹤端（OrbbecObjectTracking）歷來自稱 "unity"，
 * 內容主程式改用 "room"，兩者才分得開。
 */
function classifyClient(message) {
  switch (message && message.clientType) {
    case 'room':
      return 'room';
    case 'web':
      return 'web';
    case 'unity':
      return 'tracker';
    default:
      return 'unknown';
  }
}

module.exports = {
  ROOM_ROLES,
  SEAT_ORDERS,
  MAX_CONTENT_MODE,
  LEGACY_PROFILE_ID,
  validateProfilesConfig,
  normalizeProfileTableModes,
  createDefaultProfileState,
  normalizeProfileState,
  migrateSystemState,
  toUnityTableModes,
  createProfileCatalog,
  createConsoleState,
  createRoomState,
  viewKindForClient,
  classifyClient,
};
