// integrated-server.js
// WebSocket + OSC remote control server

'use strict';

const fs = require('fs');
const path = require('path');
const {
    SEAT_COUNT,
    normalizeTableModes,
    isValidTableIndex,
    validateMadmapperConfig,
    normalizeSurfaceStates,
    createMadmapperOscMessage,
    normalizeGroundThemeId,
    isValidGroundThemeId,
} = require('./control-model');

let madmapperConfig;
try {
    madmapperConfig = validateMadmapperConfig(require('./madmapper.config.json'));
} catch (error) {
    throw new Error(`Invalid MadMapper configuration: ${error.message}`, { cause: error });
}

const WebSocket = require('ws');
const osc = require('osc');

const WS_PORT = 3000;
const STATE_FILE = path.join(__dirname, 'system_state.json');

const udpPort = new osc.UDPPort({
    localAddress: '0.0.0.0',
    localPort: madmapperConfig.localPort,
    metadata: true
});
udpPort.open();
udpPort.on('ready', () => {
    console.log(
        `\nOSC ready ${madmapperConfig.localPort} -> `
        + `${madmapperConfig.ip}:${madmapperConfig.port}`
    );
});
udpPort.on('error', (error) => console.error('OSC error:', error));

let systemState = {
    contentMode: 1,
    maskMode: 1,
    // 地面內容與桌面背景互相獨立，各自保存。
    groundThemeId: 'none',
    surfaceStates: normalizeSurfaceStates({}, madmapperConfig.targetMap),
    tableModes: normalizeTableModes([]),
    autoCycle: {
        enabled: false,
        interval: 10,
        modes: [1, 2, 3, 4, 5],
        currentIndex: 0,
        remainingSeconds: 0
    }
};

let autoCycleIntervalId = null;

function initializeSurfaceStates() {
    systemState.surfaceStates = normalizeSurfaceStates(
        systemState.surfaceStates,
        madmapperConfig.targetMap
    );
}

function loadSystemState() {
    if (fs.existsSync(STATE_FILE)) {
        try {
            const loaded = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
            if (loaded.contentMode !== undefined) systemState.contentMode = loaded.contentMode;
            if (loaded.maskMode !== undefined) systemState.maskMode = loaded.maskMode;
            systemState.surfaceStates = normalizeSurfaceStates(
                loaded.surfaceStates,
                madmapperConfig.targetMap
            );
            systemState.tableModes = normalizeTableModes(loaded.tableModes);
            systemState.groundThemeId = normalizeGroundThemeId(loaded.groundThemeId);
            if (loaded.autoCycle) {
                systemState.autoCycle = {
                    ...systemState.autoCycle,
                    ...loaded.autoCycle,
                    enabled: false,
                    remainingSeconds: 0
                };
            }
            console.log('System state loaded');
        } catch (error) {
            console.log('Unable to load system state:', error.message);
        }
    }

    systemState.tableModes = normalizeTableModes(systemState.tableModes);
    systemState.surfaceStates = normalizeSurfaceStates(
        systemState.surfaceStates,
        madmapperConfig.targetMap
    );

    if (systemState.tableModes.length !== SEAT_COUNT) {
        throw new Error(`Expected ${SEAT_COUNT} normalized table modes`);
    }
}

function saveSystemState() {
    try {
        const stateData = { ...systemState, timestamp: new Date().toISOString() };
        fs.writeFileSync(STATE_FILE, JSON.stringify(stateData, null, 2));
    } catch (error) {
        console.error('Unable to save system state:', error.message);
    }
}

const wss = new WebSocket.Server({ port: WS_PORT });
const clients = new Set();

function noop() {}

function heartbeat() {
    this.isAlive = true;
}

const interval = setInterval(function ping() {
    wss.clients.forEach(function each(ws) {
        if (ws.isAlive === false) {
            console.log(`Terminating inactive client: ${ws.clientInfo?.id || 'Unknown'}`);
            return ws.terminate();
        }
        ws.isAlive = false;
        ws.ping(noop);
    });
}, 30000);

wss.on('close', function close() {
    clearInterval(interval);
});

initializeSurfaceStates();
loadSystemState();

function broadcast(data, excludeWs = null) {
    const message = JSON.stringify(data);
    wss.clients.forEach((client) => {
        if (client !== excludeWs && client.readyState === WebSocket.OPEN) {
            client.send(message);
        }
    });
}

function startAutoCycle() {
    stopAutoCycle();
    if (systemState.autoCycle.modes.length === 0) return;
    systemState.autoCycle.enabled = true;
    systemState.autoCycle.remainingSeconds = systemState.autoCycle.interval * 60;

    autoCycleIntervalId = setInterval(() => {
        if (systemState.autoCycle.remainingSeconds > 0) {
            systemState.autoCycle.remainingSeconds--;
            if (systemState.autoCycle.remainingSeconds % 10 === 0) {
                broadcastAutoCycleStatus();
            }
        } else {
            switchToNextCycleMode();
        }
    }, 1000);
    saveSystemState();
    broadcastAutoCycleStatus();
}

function stopAutoCycle() {
    if (autoCycleIntervalId) clearInterval(autoCycleIntervalId);
    systemState.autoCycle.enabled = false;
    saveSystemState();
    broadcastAutoCycleStatus();
}

function switchToNextCycleMode() {
    systemState.autoCycle.currentIndex =
        (systemState.autoCycle.currentIndex + 1) % systemState.autoCycle.modes.length;
    systemState.contentMode =
        systemState.autoCycle.modes[systemState.autoCycle.currentIndex];
    saveSystemState();

    broadcast({
        type: 'modeUpdate',
        mode: systemState.contentMode,
        tableModes: systemState.tableModes,
        source: 'autoCycle'
    });

    systemState.autoCycle.remainingSeconds = systemState.autoCycle.interval * 60;
    broadcastAutoCycleStatus();
}

function broadcastAutoCycleStatus() {
    broadcast({
        type: 'autoCycleUpdate',
        ...systemState.autoCycle
    });
}

wss.on('connection', (ws, req) => {
    ws.isAlive = true;
    ws.on('pong', heartbeat);

    const clientId = `${req.socket.remoteAddress}:${req.socket.remotePort}`;
    console.log(`Connected: ${clientId}`);

    ws.clientInfo = { id: clientId, type: 'unknown' };

    ws.send(JSON.stringify({
        type: 'systemStateUpdate',
        state: systemState
    }));

    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);

            if (data.clientType) ws.clientInfo.type = data.clientType;

            if (data.type === 'switchMode') {
                systemState.contentMode = data.mode;

                // 席位狀態不再隨背景重置。9 席在所有桌面背景下都有效，
                // 切到星空時清空會讓操作者已經設好的席位無故消失。

                if (data.manual && systemState.autoCycle.enabled) {
                    systemState.autoCycle.currentIndex = -1;
                }
                saveSystemState();

                broadcast({
                    type: 'modeUpdate',
                    mode: systemState.contentMode,
                    tableModes: systemState.tableModes,
                    source: data.manual ? 'manual' : 'web'
                });
            }

            if (data.type === 'updateTableMode') {
                const tableIndex = data.tableIndex;
                const modeValue = data.mode;

                if (
                    isValidTableIndex(tableIndex)
                    && Number.isInteger(modeValue)
                    && modeValue >= 0
                    && modeValue <= 3
                ) {
                    systemState.tableModes[tableIndex] = modeValue;
                    saveSystemState();

                    console.log(`Table ${tableIndex + 1} mode updated to ${modeValue}`);

                    broadcast({
                        type: 'tableModeUpdate',
                        tableModes: systemState.tableModes,
                        updatedIndex: tableIndex,
                        timestamp: Date.now()
                    });
                }
            }

            if (data.type === 'switchGroundTheme') {
                if (!isValidGroundThemeId(data.groundThemeId)) {
                    console.warn(`Unknown ground theme: ${String(data.groundThemeId)}`);
                    return;
                }

                systemState.groundThemeId = data.groundThemeId;
                saveSystemState();

                console.log(`Ground theme updated to ${systemState.groundThemeId}`);

                // 只廣播地面狀態，不動 contentMode 也不動 tableModes。
                broadcast({
                    type: 'groundThemeUpdate',
                    groundThemeId: systemState.groundThemeId,
                    timestamp: Date.now()
                });
            }

            if (data.type === 'unitySync') {
                ws.send(JSON.stringify({
                    type: 'systemStateUpdate',
                    state: systemState
                }));
            }

            if (data.type === 'madmapperControl') {
                const enabled = data.enabled === true;
                const oscMessage = createMadmapperOscMessage(
                    madmapperConfig.targetMap,
                    data.surface,
                    enabled
                );

                if (oscMessage === null) {
                    console.warn(`Unknown MadMapper area: ${String(data.surface)}`);
                    return;
                }

                systemState.surfaceStates[data.surface] = enabled;
                saveSystemState();
                handleMadmapperControl(data, oscMessage);
                broadcast({
                    type: 'madmapperStatusUpdate',
                    surface: data.surface,
                    enabled
                }, ws);
            }

            if (data.type === 'maskControl') {
                systemState.maskMode = data.maskId;
                saveSystemState();
                broadcast({ type: 'maskStatusUpdate', maskId: data.maskId }, ws);
            }

            if (data.type === 'autoCycleControl') {
                // Reserved for the existing protocol.
            }
        } catch (error) {
            console.error('Msg Error:', error.message);
        }
    });

    ws.on('error', (error) => console.error(`WS Error (${clientId}):`, error.message));
});

function handleMadmapperControl(
    data,
    oscMessage = createMadmapperOscMessage(
        madmapperConfig.targetMap,
        data.surface,
        data.enabled === true
    )
) {
    if (oscMessage === null) {
        console.warn(`Unknown MadMapper area: ${String(data.surface)}`);
        return;
    }

    try {
        udpPort.send(oscMessage, madmapperConfig.ip, madmapperConfig.port);
    } catch (error) {
        console.error('OSC Fail:', error.message);
    }
}

process.on('SIGINT', () => {
    udpPort.close();
    wss.close(() => process.exit(0));
});
