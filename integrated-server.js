// integrated-server.js
// 改進版本：加入 OSC 連線監控和更完善的錯誤處理

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

// 建立 OSC UDP 端口（帶錯誤處理）
let udpPort = null;
let oscReady = false;

function initializeOSC() {
    try {
        udpPort = new osc.UDPPort({
            localAddress: '0.0.0.0',
            localPort: OSC_CONFIG.localPort,
            metadata: true
        });

        udpPort.on('ready', () => {
            oscReady = true;
            console.log(`\n🎵 OSC 已就緒，監聽端口: ${OSC_CONFIG.localPort}`);
            console.log(`   MadMapper 目標: ${OSC_CONFIG.madmapperIp}:${OSC_CONFIG.madmapperPort}`);
        });

        udpPort.on('error', (error) => {
            oscReady = false;
            console.error('❌ OSC 錯誤:', error.message);
            console.log('⏰ 5 秒後嘗試重新初始化 OSC...');
            setTimeout(() => {
                console.log('🔄 重新初始化 OSC...');
                reinitializeOSC();
            }, 5000);
        });

        udpPort.on('close', () => {
            oscReady = false;
            console.log('⚠️  OSC 連線已關閉');
        });

        udpPort.open();
    } catch (error) {
        oscReady = false;
        console.error('❌ OSC 初始化失敗:', error.message);
        console.log('⏰ 5 秒後嘗試重新初始化...');
        setTimeout(reinitializeOSC, 5000);
    }
}

function reinitializeOSC() {
    try {
        if (udpPort) {
            try {
                udpPort.close();
            } catch (e) { }
            udpPort = null;
        }
    } catch (e) {
        console.error('清理舊 OSC 連線時發生錯誤:', e.message);
    }
    
    initializeOSC();
}

// 初始化 OSC
initializeOSC();

// 系統狀態
let systemState = {
    contentMode: 1,
    maskMode: 1,
    surfaceStates: {},
    autoCycle: {
        enabled: false,
        interval: 10,
        modes: [1, 2, 3, 4, 5],
        currentIndex: 0,
        remainingSeconds: 0
    }
};

// 自動循環計時器
let autoCycleTimer = null;
let autoCycleIntervalId = null;

// 初始化所有 Surface 狀態為關閉
function initializeSurfaceStates() {
    SURFACES_SETTINGS[1].forEach(surface => {
        systemState.surfaceStates[surface.SurfaceName] = false;
    });
    
    SURFACES_SETTINGS[2].forEach(surface => {
        systemState.surfaceStates[surface.SurfaceName] = false;
    });
}

// 載入系統狀態
function loadSystemState() {
    if (fs.existsSync(STATE_FILE)) {
        try {
            const data = fs.readFileSync(STATE_FILE, 'utf8');
            const loaded = JSON.parse(data);
            
            if (loaded.contentMode !== undefined) systemState.contentMode = loaded.contentMode;
            if (loaded.maskMode !== undefined) systemState.maskMode = loaded.maskMode;
            
            if (loaded.surfaceStates) {
                Object.keys(loaded.surfaceStates).forEach(surfaceName => {
                    if (systemState.surfaceStates.hasOwnProperty(surfaceName)) {
                        systemState.surfaceStates[surfaceName] = loaded.surfaceStates[surfaceName];
                    }
                });
            }

            if (loaded.autoCycle) {
                systemState.autoCycle = {
                    enabled: false, // 重啟後預設不啟用
                    interval: loaded.autoCycle.interval || 10,
                    modes: loaded.autoCycle.modes || [1, 2, 3, 4, 5],
                    currentIndex: loaded.autoCycle.currentIndex || 0,
                    remainingSeconds: 0
                };
            }
            
            console.log(`\n📂 已載入系統狀態:`);
            console.log(`   內容模式: ${systemState.contentMode}`);
            console.log(`   投影模式: ${systemState.maskMode}`);
            const activeSurfaces = Object.values(systemState.surfaceStates).filter(s => s).length;
            const totalSurfaces = Object.keys(systemState.surfaceStates).length;
            console.log(`   開啟的 Surface: ${activeSurfaces}/${totalSurfaces}`);
            return true;
        } catch (error) {
            console.log('⚠️  無法讀取狀態檔案:', error.message);
            console.log('   使用預設狀態');
            return false;
        }
    } else {
        console.log('📝 狀態檔案不存在，使用預設狀態');
        return false;
    }
}

// 儲存系統狀態
function saveSystemState() {
    try {
        const stateData = {
            contentMode: systemState.contentMode,
            maskMode: systemState.maskMode,
            surfaceStates: systemState.surfaceStates,
            autoCycle: systemState.autoCycle,
            timestamp: new Date().toISOString()
        };
        fs.writeFileSync(STATE_FILE, JSON.stringify(stateData, null, 2));
        // console.log(`💾 系統狀態已儲存`);
    } catch (error) {
        console.error('❌ 儲存系統狀態失敗:', error.message);
    }
}

// WebSocket 伺服器
const wss = new WebSocket.Server({ 
    port: WS_PORT,
    // 添加心跳檢測
    clientTracking: true
});

const clients = new Set();
const unityClients = new Set();
const webClients = new Set();

console.log('╔════════════════════════════════════════╗');
console.log('║  Unity 遠端控制系統 - WebSocket+OSC   ║');
console.log('╚════════════════════════════════════════╝');
console.log(`\n🔌 WebSocket 伺服器: ws://0.0.0.0:${WS_PORT}`);

// 初始化並載入系統狀態
initializeSurfaceStates();
loadSystemState();

// ===== 自動循環功能 =====

function startAutoCycle() {
    stopAutoCycle();

    if (systemState.autoCycle.modes.length === 0) {
        console.log('⚠️  自動循環模式列表為空，無法啟動');
        return;
    }

    systemState.autoCycle.enabled = true;
    systemState.autoCycle.remainingSeconds = systemState.autoCycle.interval * 60;
    
    console.log(`\n🔄 自動循環已啟動`);
    console.log(`   循環間隔: ${systemState.autoCycle.interval} 分鐘`);
    console.log(`   循環模式: ${systemState.autoCycle.modes.join(', ')}`);

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
    if (autoCycleIntervalId) {
        clearInterval(autoCycleIntervalId);
        autoCycleIntervalId = null;
    }
    
    systemState.autoCycle.enabled = false;
    systemState.autoCycle.remainingSeconds = 0;
    
    console.log('\n⏸️  自動循環已停止');
    
    saveSystemState();
    broadcastAutoCycleStatus();
}

function resetAutoCycleTimer() {
    if (systemState.autoCycle.enabled) {
        systemState.autoCycle.remainingSeconds = systemState.autoCycle.interval * 60;
        console.log(`\n⏱️  自動循環計時器已重置`);
        broadcastAutoCycleStatus();
    }
}

function switchToNextCycleMode() {
    if (systemState.autoCycle.modes.length === 0) {
        console.log('⚠️  循環模式列表為空');
        stopAutoCycle();
        return;
    }

    systemState.autoCycle.currentIndex = 
        (systemState.autoCycle.currentIndex + 1) % systemState.autoCycle.modes.length;
    
    const nextMode = systemState.autoCycle.modes[systemState.autoCycle.currentIndex];
    
    console.log(`\n🔄 自動循環切換至: 模式 ${nextMode}`);
    
    systemState.contentMode = nextMode;
    systemState.autoCycle.remainingSeconds = systemState.autoCycle.interval * 60;
    
    saveSystemState();
    
    broadcast({
        type: 'modeUpdate',
        mode: nextMode,
        source: 'autoCycle',
        timestamp: Date.now()
    });
    
    broadcastAutoCycleStatus();
}

function broadcastAutoCycleStatus() {
    broadcast({
        type: 'autoCycleUpdate',
        enabled: systemState.autoCycle.enabled,
        interval: systemState.autoCycle.interval,
        modes: systemState.autoCycle.modes,
        currentIndex: systemState.autoCycle.currentIndex,
        remainingSeconds: systemState.autoCycle.remainingSeconds,
        timestamp: Date.now()
    });
}

// ===== WebSocket 連接處理 =====

wss.on('connection', (ws, req) => {
    const clientId = req.socket.remoteAddress + ':' + req.socket.remotePort;
    
    // 添加心跳檢測
    ws.isAlive = true;
    ws.on('pong', () => {
        ws.isAlive = true;
    });
    
    clients.add(ws);
    ws.clientInfo = { type: 'unknown', id: clientId, connectedAt: new Date() };
    
    console.log(`\n✅ 新連接: ${clientId}`);
    
    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);
            
            // 客戶端識別
            if (data.clientType) {
                ws.clientInfo.type = data.clientType;
                
                if (data.clientType === 'unity') {
                    unityClients.add(ws);
                } else if (data.clientType === 'web') {
                    webClients.add(ws);
                }
                
                console.log(`   識別為: ${data.clientType}`);
            }
            
            // 狀態查詢
            if (data.type === 'getState') {
                ws.send(JSON.stringify({
                    type: 'systemStateUpdate',
                    state: {
                        contentMode: systemState.contentMode,
                        maskMode: systemState.maskMode,
                        surfaceStates: systemState.surfaceStates,
                        autoCycle: systemState.autoCycle
                    },
                    timestamp: Date.now()
                }));
                console.log(`   📤 已發送完整系統狀態給 ${clientId}`);
            }
            
            // 模式切換
            if (data.type === 'modeChange') {
                const oldMode = systemState.contentMode;
                systemState.contentMode = data.mode;
                
                // 手動切換時，將 currentIndex 設為 -1 表示非自動循環狀態
                if (systemState.autoCycle.enabled) {
                    systemState.autoCycle.currentIndex = -1;
                    resetAutoCycleTimer();
                }
                
                saveSystemState();
                
                console.log(`\n🎬 內容模式: ${oldMode} → ${systemState.contentMode}`);
                
                broadcast({
                    type: 'modeUpdate',
                    mode: data.mode,
                    source: 'manual',
                    timestamp: Date.now()
                }, ws);
            }
            
            // 自動循環控制
            if (data.type === 'autoCycleControl') {
                if (data.enabled) {
                    systemState.autoCycle.interval = data.interval;
                    systemState.autoCycle.modes = data.modes;
                    
                    // 重新計算 currentIndex
                    const currentModeIndex = data.modes.indexOf(systemState.contentMode);
                    systemState.autoCycle.currentIndex = currentModeIndex !== -1 ? currentModeIndex : 0;
                    
                    startAutoCycle();
                } else {
                    stopAutoCycle();
                }
            }
            
            // 更新循環設定
            if (data.type === 'updateCycleSettings') {
                systemState.autoCycle.interval = data.interval;
                systemState.autoCycle.modes = data.modes;
                
                if (systemState.autoCycle.enabled) {
                    if (systemState.autoCycle.currentIndex !== -1) {
                        const currentModeIndex = data.modes.indexOf(systemState.contentMode);
                        if (currentModeIndex !== -1) {
                            systemState.autoCycle.currentIndex = currentModeIndex;
                        } else {
                            systemState.autoCycle.currentIndex = 0;
                        }
                    }
                    
                    resetAutoCycleTimer();
                }

                saveSystemState();
                broadcastAutoCycleStatus();
            }
            
            // MadMapper 控制
            if (data.type === 'madmapperControl') {
                const oldState = systemState.surfaceStates[data.surface];
                
                handleMadmapperControl(data);
                
                systemState.surfaceStates[data.surface] = data.enabled;
                saveSystemState();
                
                console.log(`   Surface: ${data.surface} ${oldState ? '開' : '關'} → ${data.enabled ? '開' : '關'}`);
                
                broadcast({
                    type: 'madmapperStatusUpdate',
                    surface: data.surface,
                    enabled: data.enabled,
                    timestamp: Date.now()
                }, ws);
            }

            // Mask 控制
            if (data.type === 'maskControl') {
                const oldMode = systemState.maskMode;
                
                handleMaskControl(data);
                
                systemState.maskMode = data.maskId;
                saveSystemState();
                
                console.log(`   投影模式: ${oldMode} → ${systemState.maskMode}`);
                
                broadcast({
                    type: 'maskStatusUpdate',
                    maskId: data.maskId,
                    timestamp: Date.now()
                }, ws);
            }
            
        } catch (error) {
            console.error('❌ 解析訊息錯誤:', error.message);
        }
    });

    ws.on('close', () => {
        clients.delete(ws);
        unityClients.delete(ws);
        webClients.delete(ws);
        console.log(`\n❌ 連接關閉: ${ws.clientInfo.type} (${clientId})`);
        printStatus();
    });

    ws.on('error', (error) => {
        console.error(`❌ WebSocket 錯誤 (${clientId}):`, error.message);
    });
    
    printStatus();
});

// ===== 心跳檢測 =====
const heartbeatInterval = setInterval(() => {
    wss.clients.forEach((ws) => {
        if (ws.isAlive === false) {
            console.log('💔 客戶端心跳超時，終止連接');
            return ws.terminate();
        }
        
        ws.isAlive = false;
        ws.ping();
    });
}, 30000); // 每 30 秒檢查一次

wss.on('close', () => {
    clearInterval(heartbeatInterval);
});

// 廣播訊息
function broadcast(data, excludeWs = null) {
    const message = JSON.stringify(data);
    let sentCount = 0;
    
    clients.forEach(client => {
        if (client !== excludeWs && client.readyState === WebSocket.OPEN) {
            try {
                client.send(message);
                sentCount++;
            } catch (error) {
                console.error('廣播訊息失敗:', error.message);
            }
        }
    });
    
    if (data.type === 'modeUpdate' || data.type === 'autoCycleUpdate') {
        console.log(`   ✉️  已廣播給 ${sentCount} 個客戶端`);
    }
}

// MadMapper 控制
function handleMadmapperControl(data) {
    if (!oscReady) {
        console.warn('⚠️  OSC 未就緒，無法發送訊息');
        return;
    }

    const oscAddress = `/surfaces/${data.surface}/opacity`;
    const oscValue = data.enabled ? 1.0 : 0.0;
    
    console.log(`   OSC: ${oscAddress} = ${oscValue}`);
    
    try {
        udpPort.send({
            address: oscAddress,
            args: [{ type: 'f', value: oscValue }]
        }, OSC_CONFIG.madmapperIp, OSC_CONFIG.madmapperPort);
        
        console.log(`   ✅ OSC 訊息已發送`);
    } catch (error) {
        console.error(`   ❌ OSC 發送失敗:`, error.message);
    }
}

// Mask 控制
function handleMaskControl(data) {
    const maskId = parseInt(data.maskId);
    console.log(`   Mask ID: ${maskId}`);
}

// 顯示當前狀態
function printStatus() {
    console.log(`\n📊 連接: 總計 ${clients.size} | Unity ${unityClients.size} | 網頁 ${webClients.size}`);
    console.log(`   模式: 內容=${systemState.contentMode} 投影=${systemState.maskMode}`);
    console.log(`   OSC: ${oscReady ? '✅ 就緒' : '❌ 未就緒'}`);
}

// 顯示網路資訊
function printNetworkInfo() {
    const os = require('os');
    const interfaces = os.networkInterfaces();
    
    console.log('\n╔════════════════════════════════════════╗');
    console.log('║         可用的網路位址                 ║');
    console.log('╚════════════════════════════════════════╝');
    
    Object.keys(interfaces).forEach(ifname => {
        interfaces[ifname].forEach(iface => {
            if (iface.family === 'IPv4' && !iface.internal) {
                console.log(`\n📍 ${ifname}:`);
                console.log(`   WebSocket: ws://${iface.address}:${WS_PORT}`);
            }
        });
    });
}

// 啟動後顯示資訊
printNetworkInfo();
console.log('\n按 Ctrl+C 停止伺服器\n');

// 定期狀態報告
setInterval(() => {
    if (clients.size > 0) {
        console.log(`\n⏰ [${new Date().toLocaleTimeString('zh-TW')}]`);
        printStatus();
    }
}, 60000); // 每 60 秒

// 清理資源
process.on('SIGINT', () => {
    console.log('\n\n⏹️  正在關閉伺服器...');
    
    stopAutoCycle();
    
    broadcast({
        type: 'serverShutdown',
        message: '伺服器即將關閉'
    });
    
    if (udpPort) {
        try {
            udpPort.close();
            console.log('✅ OSC 已關閉');
        } catch (e) {
            console.error('關閉 OSC 時發生錯誤:', e.message);
        }
    }
    
    wss.close(() => {
        console.log('✅ WebSocket 伺服器已關閉');
        process.exit(0);
    });
    
    setTimeout(() => {
        console.log('⚠️  強制退出');
        process.exit(1);
    }, 5000);
});

process.on('uncaughtException', (error) => {
    console.error('❌ 未捕獲的異常:', error.message);
    console.error(error.stack);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('❌ 未處理的 Promise 拒絕:', reason);
});