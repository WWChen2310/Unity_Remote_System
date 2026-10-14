'use strict';

// 控制伺服器本體：WebSocket（控制台、Unity、追蹤端）、狀態保存、投影方案切換。
// 網路以外的依賴（OSC 送出、agent 連線、計時）都由參數注入，端對端測試可以直接啟動它。

const fs = require('node:fs');
const path = require('node:path');
const WebSocket = require('ws');

const {
  validateMadmapperConfig,
  createMadmapperOscMessage,
  isValidGroundThemeId,
} = require('./control-model');
const { isSeatPanelAvailable } = require('./interface/control-settings');
const {
  MAX_CONTENT_MODE,
  validateProfilesConfig,
  migrateSystemState,
  createConsoleState,
  createRoomState,
  toUnityTableModes,
  viewKindForClient,
  classifyClient,
} = require('./profile-model');
const {
  LOGO_FORMATS,
  applyLogoControl,
  parseLogoUpload,
  logoImageId,
  logoFileName,
  createLogoImageMessage,
} = require('./logo-model');
const { RoomPresence } = require('./room-presence');
const { ProfileSwitcher } = require('./profile-switcher');

// 切換中拒絕的指令。工作燈的 madmapperControl 另外放行（實體燈，與投影無關）。
const BLOCKED_WHILE_SWITCHING = new Set([
  'switchMode',
  'updateTableMode',
  'switchGroundTheme',
  'maskControl',
  'madmapperControl',
  'switchProfile',
  'restartProfile',
]);

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
}

function loadConfigs(configDir, env = process.env) {
  const madmapper = validateMadmapperConfig(readJson(path.join(configDir, 'madmapper.config.json')));
  const profiles = validateProfilesConfig(readJson(path.join(configDir, 'profiles.config.json')), madmapper, env);
  return { madmapper, profiles };
}

function readStateFile(stateFile, log) {
  if (!fs.existsSync(stateFile)) {
    return {};
  }
  try {
    return readJson(stateFile);
  } catch (error) {
    log(`Unable to load system state: ${error.message}`);
    return {};
  }
}

function loadLogoImage(directory, logo, log) {
  if (!logo.imageId) return null;
  const file = path.join(directory, logoFileName(logo.mime));
  try {
    const buffer = fs.readFileSync(file);
    if (logoImageId(buffer) === logo.imageId) return buffer;
    log(`Logo file ${file} does not match the saved state; the logo is cleared`);
  } catch (error) {
    log(`Unable to load logo: ${error.message}`);
  }
  return null;
}

function removeOtherLogoFiles(directory, keepFileName) {
  for (const mime of Object.keys(LOGO_FORMATS)) {
    const fileName = logoFileName(mime);
    if (fileName !== keepFileName) fs.rmSync(path.join(directory, fileName), { force: true });
  }
}

function startServer({
  wsPort = 3000,
  host,
  configs,
  configDir = __dirname,
  stateFile = path.join(__dirname, 'system_state.json'),
  sendOsc,
  agent,
  env = process.env,
  delay,
  now = Date.now,
  heartbeatMs = 30000,
  log = console.log,
}) {
  const { madmapper, profiles } = configs || loadConfigs(configDir, env);
  const context = { profiles, madmapper };

  const state = migrateSystemState(readStateFile(stateFile, log), context);
  let lastExit = null;
  let autoCycleIntervalId = null;

  function saveState() {
    try {
      fs.writeFileSync(stateFile, JSON.stringify({ ...state, timestamp: new Date().toISOString() }, null, 2));
    } catch (error) {
      log(`Unable to save system state: ${error.message}`);
    }
  }

  // Logo 圖檔放在狀態檔旁邊；狀態檔只記 imageId，啟動時核對兩者一致。
  const logoDir = path.dirname(stateFile);
  let logoImage = loadLogoImage(logoDir, state.logo, log);
  if (!logoImage && state.logo.imageId) {
    state.logo = { ...state.logo, enabled: false, imageId: null, mime: null };
  }

  // 啟動時就寫一次：舊格式立刻變成 v3，切換途中重啟的 failed 也會落地。
  saveState();

  const presence = new RoomPresence({ now });
  const wss = new WebSocket.Server({ port: wsPort, host });

  const activeProfile = () => profiles.byId[state.activeProfile];
  const activeState = () => state.profiles[state.activeProfile];

  function consoleState() {
    return {
      ...createConsoleState(state, {
        profiles,
        madmapper,
        agentConnected: Boolean(agent && agent.connected),
        rooms: presence.list(),
      }),
      lastExit,
    };
  }

  function send(ws, message) {
    if (message && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(message));
    }
  }

  /** 依每個連線的類型決定送 console view、room view，或不送。 */
  function publish(buildMessage, { exclude = null } = {}) {
    for (const client of wss.clients) {
      if (client === exclude || client.readyState !== WebSocket.OPEN) continue;
      const kind = viewKindForClient(client.clientInfo, state.activeProfile);
      if (!kind) continue;
      send(client, buildMessage(kind));
    }
  }

  function publishToConsoles(message, options) {
    publish((kind) => (kind === 'console' ? message : null), options);
  }

  function fullStateMessage(kind) {
    return kind === 'room'
      ? { type: 'systemStateUpdate', state: createRoomState(state, activeProfile()) }
      : { type: 'systemStateUpdate', state: consoleState() };
  }

  function publishFullState({ consolesOnly = false } = {}) {
    publish((kind) => (consolesOnly && kind !== 'console' ? null : fullStateMessage(kind)));
  }

  function publishRoomStatus() {
    publishToConsoles({ type: 'roomStatusUpdate', rooms: presence.list(), lastExit });
  }

  function publishLogo() {
    publish(() => ({ type: 'logoUpdate', logo: { ...state.logo } }));
  }

  function sendLogoImage(ws) {
    if (logoImage) send(ws, createLogoImageMessage(state.logo, logoImage));
  }

  function reject(ws, command, reason, detail) {
    send(ws, { type: 'commandRejected', command, reason, ...(detail ? { detail } : {}) });
  }

  // ---- auto cycle（沿用原本的行為；控制台的 autoCycleControl 仍是保留未實作） ----

  function broadcastAutoCycleStatus() {
    publishToConsoles({ type: 'autoCycleUpdate', ...state.autoCycle });
  }

  function stopAutoCycle() {
    if (autoCycleIntervalId) clearInterval(autoCycleIntervalId);
    autoCycleIntervalId = null;
    if (state.autoCycle.enabled) {
      state.autoCycle.enabled = false;
      saveState();
      broadcastAutoCycleStatus();
    }
  }

  function switchToNextCycleMode() {
    const cycle = state.autoCycle;
    cycle.currentIndex = (cycle.currentIndex + 1) % cycle.modes.length;
    activeState().contentMode = cycle.modes[cycle.currentIndex];
    saveState();
    publishModeUpdate('autoCycle');
    cycle.remainingSeconds = cycle.interval * 60;
    broadcastAutoCycleStatus();
  }

  function startAutoCycle() {
    stopAutoCycle();
    if (state.autoCycle.modes.length === 0) return;
    state.autoCycle.enabled = true;
    state.autoCycle.remainingSeconds = state.autoCycle.interval * 60;
    autoCycleIntervalId = setInterval(() => {
      if (state.autoCycle.remainingSeconds > 0) {
        state.autoCycle.remainingSeconds -= 1;
        if (state.autoCycle.remainingSeconds % 10 === 0) broadcastAutoCycleStatus();
      } else {
        switchToNextCycleMode();
      }
    }, 1000);
    saveState();
    broadcastAutoCycleStatus();
  }

  // ---- 狀態廣播 ----

  function publishModeUpdate(source) {
    const profile = activeProfile();
    const profileState = activeState();
    publish((kind) => ({
      type: 'modeUpdate',
      mode: profileState.contentMode,
      tableModes: kind === 'room'
        ? toUnityTableModes(profile, profileState.tableModes)
        : [...profileState.tableModes],
      source,
    }));
  }

  function publishTableModes(updatedIndex) {
    const profile = activeProfile();
    const profileState = activeState();
    publish((kind) => ({
      type: 'tableModeUpdate',
      tableModes: kind === 'room'
        ? toUnityTableModes(profile, profileState.tableModes)
        : [...profileState.tableModes],
      updatedIndex,
      timestamp: Date.now(),
    }));
  }

  // ---- 切換 ----

  const switcher = new ProfileSwitcher({
    store: {
      get: () => state,
      update: (mutate) => {
        mutate(state);
        saveState();
      },
    },
    profiles,
    madmapper,
    sendOsc,
    agent,
    presence,
    ...(delay ? { delay } : {}),
    now,
    stopAutoCycle,
    log,
    events: {
      // 開始與失敗時送完整狀態（控制台要依新方案重畫，追蹤端要拿到新方案的遮罩）；
      // 中間步驟只送進度，避免追蹤端每一步都重套一次遮罩。
      switchChanged: () => {
        if (state.switch.status === 'failed' || state.switch.step === 'blackout') {
          publishFullState({ consolesOnly: true });
        } else {
          publishToConsoles({ type: 'profileSwitchUpdate', activeProfile: state.activeProfile, switch: { ...state.switch } });
        }
      },
      // 切換或重新啟動成功，代表目前方案的 Unity 都在線上，先前的當機警告可以清掉。
      switchCompleted: () => {
        lastExit = null;
        publishFullState();
      },
    },
  });

  if (agent) {
    agent.on('connected', () => {
      log('Room agent connected');
      publishToConsoles({ type: 'agentStatusUpdate', connected: true });
      if (state.switch.status === 'idle') {
        switcher.ensureActive().then((result) => {
          if (!result.ok) log(`ensure ${state.activeProfile}: ${result.error || result.reason}`);
        });
      }
    });
    agent.on('disconnected', () => {
      log('Room agent disconnected');
      publishToConsoles({ type: 'agentStatusUpdate', connected: false });
    });
    agent.on('processExited', (event) => {
      lastExit = { ...event, at: new Date().toISOString() };
      log(`Unity exited unexpectedly: ${event.name} (code ${event.code})`);
      publishRoomStatus();
    });
    agent.on('authFailed', (code) => log(`Room agent refused this server (close ${code})`));
  }

  presence.on('change', publishRoomStatus);

  // ---- 指令 ----

  const handlers = {
    unitySync(ws, data) {
      if (ws.clientInfo.kind !== 'room') {
        // 舊版 Unity 或其他工具：照原本行為回完整狀態。
        send(ws, { type: 'systemStateUpdate', state: consoleState() });
        return;
      }
      ws.clientInfo.build = data.build;
      ws.clientInfo.role = data.role;
      presence.register(ws, { build: data.build, role: data.role });
      log(`room ${data.build}/${data.role} connected (${ws.clientInfo.id})`);
      // Logo 不分方案：切換途中剛啟動、還不是目前方案的 build 也先拿到圖，恢復投影時就已經在畫面上。
      sendLogoImage(ws);
      send(ws, { type: 'logoUpdate', logo: { ...state.logo } });
      if (data.build === state.activeProfile) {
        send(ws, fullStateMessage('room'));
      } else {
        log(`room ${data.build} is not the active profile ${state.activeProfile}; it gets no state`);
      }
    },

    switchMode(ws, data) {
      if (!Number.isInteger(data.mode) || data.mode < 0 || data.mode > MAX_CONTENT_MODE) {
        reject(ws, 'switchMode', 'invalidMode');
        return;
      }
      const profileState = activeState();
      profileState.contentMode = data.mode;
      // s1（2026-03 版）進入分割內容時會把座位歸零，重現當時的行為。
      if (activeProfile().resetSeatsOnModes.includes(data.mode)) {
        profileState.tableModes = profileState.tableModes.map(() => 0);
      }
      if (data.manual && state.autoCycle.enabled) {
        state.autoCycle.currentIndex = -1;
      }
      saveState();
      publishModeUpdate(data.manual ? 'manual' : 'web');
    },

    updateTableMode(ws, data) {
      const profile = activeProfile();
      const profileState = activeState();
      const { tableIndex, mode } = data;
      if (!Number.isInteger(tableIndex) || tableIndex < 0 || tableIndex >= profile.seatCount
        || !profile.seatModes.includes(mode)) {
        reject(ws, 'updateTableMode', 'seatOutOfRange');
        return;
      }
      if (!isSeatPanelAvailable(profile, profileState.contentMode)) {
        reject(ws, 'updateTableMode', 'seatLocked');
        return;
      }
      profileState.tableModes[tableIndex] = mode;
      saveState();
      log(`${state.activeProfile} seat ${tableIndex + 1} -> ${mode}`);
      publishTableModes(tableIndex);
    },

    switchGroundTheme(ws, data) {
      if (!activeProfile().ground) {
        reject(ws, 'switchGroundTheme', 'groundUnsupported');
        return;
      }
      if (!isValidGroundThemeId(data.groundThemeId)) {
        reject(ws, 'switchGroundTheme', 'invalidGroundTheme');
        return;
      }
      activeState().groundThemeId = data.groundThemeId;
      saveState();
      log(`Ground theme updated to ${data.groundThemeId}`);
      // 只動地面，不動背景也不動座位。
      publish(() => ({ type: 'groundThemeUpdate', groundThemeId: data.groundThemeId, timestamp: Date.now() }));
    },

    madmapperControl(ws, data) {
      const enabled = data.enabled === true;
      const isLight = Object.prototype.hasOwnProperty.call(madmapper.lightMap, data.surface);
      const { areaMap, targetMap } = madmapper.profiles[state.activeProfile];
      const isArea = Object.prototype.hasOwnProperty.call(areaMap, data.surface);

      if (!isLight && !isArea) {
        reject(ws, 'madmapperControl', 'notInProfile');
        return;
      }
      if (!isLight && switcher.isSwitching()) {
        reject(ws, 'madmapperControl', 'switching');
        return;
      }

      if (isLight) {
        state.lightStates[data.surface] = enabled;
      } else {
        activeState().surfaceStates[data.surface] = enabled;
      }
      saveState();
      sendOsc(createMadmapperOscMessage(targetMap, data.surface, enabled));
      publishToConsoles({ type: 'madmapperStatusUpdate', surface: data.surface, enabled }, { exclude: ws });
    },

    maskControl(ws, data) {
      if (!Number.isInteger(data.maskId) || data.maskId < 0) {
        reject(ws, 'maskControl', 'invalidMask');
        return;
      }
      activeState().maskMode = data.maskId;
      saveState();
      publishToConsoles({ type: 'maskStatusUpdate', maskId: data.maskId }, { exclude: ws });
    },

    switchProfile(ws, data) {
      if (!agent || !agent.connected) {
        reject(ws, 'switchProfile', 'agentOffline');
        return;
      }
      switcher.switchTo(data.profileId).then((result) => {
        if (!result.ok && result.reason !== 'failed') reject(ws, 'switchProfile', result.reason);
      });
    },

    restartProfile(ws) {
      if (!agent || !agent.connected) {
        reject(ws, 'restartProfile', 'agentOffline');
        return;
      }
      switcher.restartActive().then((result) => {
        if (!result.ok && result.reason !== 'failed') reject(ws, 'restartProfile', result.reason);
      });
    },

    uploadLogo(ws, data) {
      const upload = parseLogoUpload(data.dataUrl);
      if (upload.error) {
        reject(ws, 'uploadLogo', upload.error);
        return;
      }
      const fileName = logoFileName(upload.mime);
      try {
        fs.writeFileSync(path.join(logoDir, fileName), upload.buffer);
        removeOtherLogoFiles(logoDir, fileName);
      } catch (error) {
        log(`Unable to save logo: ${error.message}`);
        reject(ws, 'uploadLogo', 'logoSaveFailed');
        return;
      }
      logoImage = upload.buffer;
      state.logo = { ...state.logo, imageId: upload.imageId, mime: upload.mime };
      saveState();
      log(`Logo uploaded (${upload.mime}, ${upload.buffer.length} bytes, ${upload.imageId})`);
      // 圖只送給需要畫它的 Unity 與控制台，追蹤端用不到。
      const imageMessage = createLogoImageMessage(state.logo, logoImage);
      for (const client of wss.clients) {
        if (['room', 'web'].includes(client.clientInfo.kind)) send(client, imageMessage);
      }
      publishLogo();
    },

    logoControl(ws, data) {
      const result = applyLogoControl(state.logo, data);
      if (result.error) {
        reject(ws, 'logoControl', result.error);
        return;
      }
      state.logo = result.logo;
      saveState();
      publishLogo();
    },

    removeLogo() {
      removeOtherLogoFiles(logoDir, null);
      logoImage = null;
      state.logo = { ...state.logo, enabled: false, imageId: null, mime: null };
      saveState();
      log('Logo removed');
      publishLogo();
    },

    requestLogoImage(ws) {
      sendLogoImage(ws);
    },

    autoCycleControl() {
      // Reserved for the existing protocol.
    },
  };

  // ---- 連線 ----

  function noop() {}

  function heartbeat() {
    this.isAlive = true;
  }

  const heartbeatInterval = setInterval(() => {
    for (const ws of wss.clients) {
      if (ws.isAlive === false) {
        log(`Terminating inactive client: ${ws.clientInfo ? ws.clientInfo.id : 'unknown'}`);
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      ws.ping(noop);
    }
  }, heartbeatMs);
  heartbeatInterval.unref();

  wss.on('connection', (ws, req) => {
    ws.isAlive = true;
    ws.on('pong', heartbeat);
    ws.clientInfo = {
      id: `${req.socket.remoteAddress}:${req.socket.remotePort}`,
      kind: 'unknown',
      build: null,
      role: null,
    };
    log(`Connected: ${ws.clientInfo.id}`);

    send(ws, { type: 'systemStateUpdate', state: consoleState() });

    ws.on('message', (raw) => {
      let data;
      try {
        data = JSON.parse(raw);
      } catch (error) {
        log(`Msg Error: ${error.message}`);
        return;
      }
      if (!data || typeof data !== 'object') return;

      if (data.clientType) {
        ws.clientInfo.kind = classifyClient(data);
      }

      const handler = Object.prototype.hasOwnProperty.call(handlers, data.type) ? handlers[data.type] : null;
      if (!handler) return;

      const isLightToggle = data.type === 'madmapperControl'
        && Object.prototype.hasOwnProperty.call(madmapper.lightMap, data.surface);
      if (BLOCKED_WHILE_SWITCHING.has(data.type) && !isLightToggle && switcher.isSwitching()) {
        reject(ws, data.type, 'switching');
        return;
      }

      try {
        handler(ws, data);
      } catch (error) {
        log(`Msg Error: ${error.message}`);
      }
    });

    ws.on('close', () => {
      if (ws.clientInfo.kind === 'room') {
        presence.unregister(ws);
        log(`room ${ws.clientInfo.build}/${ws.clientInfo.role} disconnected`);
      }
    });

    ws.on('error', (error) => log(`WS Error (${ws.clientInfo.id}): ${error.message}`));
  });

  return new Promise((resolve, reject) => {
    wss.once('error', reject);
    wss.once('listening', () => {
      wss.off('error', reject);
      log(`Control server listening on ${wss.address().port}; active profile ${state.activeProfile}`);
      resolve({
        port: wss.address().port,
        getState: () => state,
        getRooms: () => presence.list(),
        startAutoCycle,
        close: () => new Promise((done) => {
          clearInterval(heartbeatInterval);
          presence.cancelAll('control server closing');
          if (autoCycleIntervalId) clearInterval(autoCycleIntervalId);
          for (const ws of wss.clients) ws.terminate();
          wss.close(() => done());
        }),
      });
    });
  });
}

module.exports = {
  BLOCKED_WHILE_SWITCHING,
  loadConfigs,
  startServer,
};
