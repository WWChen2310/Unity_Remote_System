// integrated-server.js
// WebSocket + OSC 整合伺服器

const WebSocket = require('ws');
const osc = require('osc');
const fs = require('fs');
const path = require('path');

// 設定
const WS_PORT = 3000;
const STATE_FILE = path.join(__dirname, 'system_state.json');

// OSC 設定
const OSC_CONFIG = {
    madmapperIp: '192.168.0.202',
    madmapperPort: 8010,
    localPort: 9000
};

// Surface 設定
const SURFACES_SETTINGS = {
    1: [
        { SurfaceName: 'Main-1', ShowName: 'Main' },
        { SurfaceName: 'T1-1', ShowName: 'T1' },
        { SurfaceName: 'T2-1', ShowName: 'T2' },
        { SurfaceName: 'T3-1', ShowName: 'T3' },
        { SurfaceName: 'T4-1', ShowName: 'T4' },
        { SurfaceName: 'T5-1', ShowName: 'T5' },
        { SurfaceName: 'T6-1', ShowName: 'T6' },
        { SurfaceName: 'T7-1', ShowName: 'T7' }
    ],
    2: [
        { SurfaceName: 'Main-2', ShowName: 'Main' },
        { SurfaceName: 'T2-2', ShowName: 'T2' },
        { SurfaceName: 'T3-2', ShowName: 'T3' },
        { SurfaceName: 'T4-2', ShowName: 'T4' },
        { SurfaceName: 'T5-2', ShowName: 'T5' },
        { SurfaceName: 'T6-2', ShowName: 'T6' },
        { SurfaceName: 'T7-2', ShowName: 'T7' }
    ]
};

// OSC 初始化
const udpPort = new osc.UDPPort({
    localAddress: '0.0.0.0',
    localPort: OSC_CONFIG.localPort,
    metadata: true
});
udpPort.open();
udpPort.on('ready', () => console.log(`\n🎵 OSC 已就緒: ${OSC_CONFIG.localPort} -> ${OSC_CONFIG.madmapperIp}:${OSC_CONFIG.madmapperPort}`));
udpPort.on('error', (err) => console.error('❌ OSC 錯誤:', err));

// 系統狀態
let systemState = {
    contentMode: 1,
    maskMode: 1,
    surfaceStates: {},
    // [新功能] 分割桌面模式：8個桌子 (索引0-7對應桌子1-8)，預設模式0
    tableModes: [0, 0, 0, 0, 0, 0, 0, 0], 
    autoCycle: {
        enabled: false,
        interval: 10,
        modes: [1, 2, 3, 4, 5],
        currentIndex: 0,
        remainingSeconds: 0
    }
};

let autoCycleIntervalId = null;

// 初始化 Surface 狀態
function initializeSurfaceStates() {
    [1, 2].forEach(mode => {
        SURFACES_SETTINGS[mode].forEach(s => systemState.surfaceStates[s.SurfaceName] = false);
    });
}

// 載入與儲存狀態 (增加 tableModes 的讀寫)
function loadSystemState() {
    if (fs.existsSync(STATE_FILE)) {
        try {
            const loaded = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
            if (loaded.contentMode !== undefined) systemState.contentMode = loaded.contentMode;
            if (loaded.maskMode !== undefined) systemState.maskMode = loaded.maskMode;
            if (loaded.surfaceStates) Object.assign(systemState.surfaceStates, loaded.surfaceStates);
            // 載入 Table Modes
            if (loaded.tableModes && Array.isArray(loaded.tableModes)) {
                systemState.tableModes = loaded.tableModes;
            }
            if (loaded.autoCycle) {
                systemState.autoCycle = { ...systemState.autoCycle, ...loaded.autoCycle, enabled: false, remainingSeconds: 0 };
            }
            console.log('📂 系統狀態已載入');
        } catch (e) { console.log('⚠️ 讀取狀態失敗，使用預設值'); }
    }
}

function saveSystemState() {
    try {
        const stateData = { ...systemState, timestamp: new Date().toISOString() };
        fs.writeFileSync(STATE_FILE, JSON.stringify(stateData, null, 2));
    } catch (e) { console.error('❌ 儲存失敗:', e.message); }
}

// WebSocket 伺服器
const wss = new WebSocket.Server({ port: WS_PORT });
const clients = new Set(); // 輔助用，主要還是依賴 wss.clients

// [強韌性] Heartbeat 機制
function noop() {}
function heartbeat() {
    this.isAlive = true;
}

// 每 30 秒檢查一次連線是否活著
const interval = setInterval(function ping() {
    wss.clients.forEach(function each(ws) {
        if (ws.isAlive === false) {
            console.log(`💀 清除無回應連線: ${ws.clientInfo?.id || 'Unknown'}`);
            return ws.terminate();
        }
        ws.isAlive = false;
        ws.ping(noop); // 發送 Ping
    });
}, 30000);

wss.on('close', function close() {
    clearInterval(interval);
});

initializeSurfaceStates();
loadSystemState();

// 廣播函數
function broadcast(data, excludeWs = null) {
    const msg = JSON.stringify(data);
    wss.clients.forEach(client => {
        if (client !== excludeWs && client.readyState === WebSocket.OPEN) {
            client.send(msg);
        }
    });
}

// 自動循環邏輯 (部分簡化顯示，邏輯不變)
function startAutoCycle() {
    stopAutoCycle();
    if (systemState.autoCycle.modes.length === 0) return;
    systemState.autoCycle.enabled = true;
    systemState.autoCycle.remainingSeconds = systemState.autoCycle.interval * 60;
    
    autoCycleIntervalId = setInterval(() => {
        if (systemState.autoCycle.remainingSeconds > 0) {
            systemState.autoCycle.remainingSeconds--;
            if (systemState.autoCycle.remainingSeconds % 10 === 0) broadcastAutoCycleStatus();
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
    // ... (維持原有的循環邏輯) ...
    // 切換模式時，需包含 tableModes
    systemState.autoCycle.currentIndex = (systemState.autoCycle.currentIndex + 1) % systemState.autoCycle.modes.length;
    systemState.contentMode = systemState.autoCycle.modes[systemState.autoCycle.currentIndex];
    saveSystemState();

    broadcast({
        type: 'modeUpdate',
        mode: systemState.contentMode,
        tableModes: systemState.tableModes, // 廣播時帶上桌子狀態
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

// WebSocket 連接處理
wss.on('connection', (ws, req) => {
    ws.isAlive = true;
    ws.on('pong', heartbeat); // 收到 Pong 回應

    const clientId = `${req.socket.remoteAddress}:${req.socket.remotePort}`;
    console.log(`✅ 新連接: ${clientId}`);

    ws.clientInfo = { id: clientId, type: 'unknown' };

    // 連線時發送完整狀態 (包含 tableModes)
    ws.send(JSON.stringify({
        type: 'systemStateUpdate',
        state: systemState
    }));

    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);
            
            if (data.clientType) ws.clientInfo.type = data.clientType;

            // 1. 模式切換
            if (data.type === 'switchMode') {
                systemState.contentMode = data.mode;

                if (data.mode === 8) {
                    systemState.tableModes = [0, 0, 0, 0, 0, 0, 0, 0];
                }

                if (data.manual && systemState.autoCycle.enabled) {
                    systemState.autoCycle.currentIndex = -1; 
                }
                saveSystemState();
                
                // 廣播給所有端
                broadcast({
                    type: 'modeUpdate',
                    mode: systemState.contentMode,
                    tableModes: systemState.tableModes, // 同步發送桌子狀態
                    source: data.manual ? 'manual' : 'web'
                });
            }

            // 2. [新功能] 單一桌子模式更新
            if (data.type === 'updateTableMode') {
                const tableIndex = data.tableIndex; // 0-7
                const modeVal = data.mode;          // 0-3
                
                if (tableIndex >= 0 && tableIndex < 8) {
                    systemState.tableModes[tableIndex] = modeVal;
                    saveSystemState();
                    
                    console.log(`🪑 桌子 ${tableIndex + 1} 切換至模式 ${modeVal}`);

                    // 廣播新的桌子狀態給 Unity
                    broadcast({
                        type: 'tableModeUpdate',
                        tableModes: systemState.tableModes,
                        updatedIndex: tableIndex,
                        timestamp: Date.now()
                    });
                }
            }

            // 3. Unity 同步
            if (data.type === 'unitySync') {
                // Unity 重連時會請求同步
                ws.send(JSON.stringify({
                    type: 'systemStateUpdate',
                    state: systemState
                }));
            }

            // ... (MadMapper 與 Mask 控制維持原樣) ...
            if (data.type === 'madmapperControl') {
                systemState.surfaceStates[data.surface] = data.enabled;
                saveSystemState();
                handleMadmapperControl(data); // 發送 OSC
                broadcast({ type: 'madmapperStatusUpdate', surface: data.surface, enabled: data.enabled }, ws);
            }

            if (data.type === 'maskControl') {
                systemState.maskMode = data.maskId;
                saveSystemState();
                broadcast({ type: 'maskStatusUpdate', maskId: data.maskId }, ws);
            }

            // ... (AutoCycle 控制維持原樣) ...
            if (data.type === 'autoCycleControl') { /* ... */ }

        } catch (e) { console.error('Msg Error:', e.message); }
    });

    ws.on('error', (e) => console.error(`WS Error (${clientId}):`, e.message));
});

// OSC 發送函數 (維持原樣)
function handleMadmapperControl(data) {
    try {
        udpPort.send({
            address: `/surfaces/${data.surface}/opacity`,
            args: [{ type: 'f', value: data.enabled ? 1.0 : 0.0 }]
        }, OSC_CONFIG.madmapperIp, OSC_CONFIG.madmapperPort);
    } catch (e) { console.error('OSC Fail:', e.message); }
}

process.on('SIGINT', () => {
    udpPort.close();
    wss.close(() => process.exit(0));
});