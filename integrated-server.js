// server.js
// WebSocket + OSC 整合伺服器 (不含 HTTP，由 nginx 負責)

const WebSocket = require('ws');
const osc = require('osc');
const fs = require('fs');
const path = require('path');

// 設定
const WS_PORT = 3000;
const STATE_FILE = path.join(__dirname, 'system_state.json'); // 完整狀態檔案

// OSC 設定
const OSC_CONFIG = {
    madmapperIp: '192.168.0.202',      // MadMapper 電腦的 IP
    madmapperPort: 8010,                // MadMapper OSC 接收端口
    
    objectTrackerIp: '192.168.0.201',  // Object Tracker 主機 IP
    objectTrackerPort: 8000,            // Object Tracker OSC 接收端口
    
    localPort: 9000                     // 本地發送端口
};

// Surface 設定（與前端保持一致）
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

// 建立 OSC UDP 端口
const udpPort = new osc.UDPPort({
    localAddress: '0.0.0.0',
    localPort: OSC_CONFIG.localPort,
    metadata: true
});

udpPort.open();

udpPort.on('ready', () => {
    console.log(`\n🎵 OSC 已就緒，監聽端口: ${OSC_CONFIG.localPort}`);
    console.log(`   MadMapper 目標: ${OSC_CONFIG.madmapperIp}:${OSC_CONFIG.madmapperPort}`);
    console.log(`   ObjectTracker 目標: ${OSC_CONFIG.objectTrackerIp}:${OSC_CONFIG.objectTrackerPort}`);
});

udpPort.on('error', (error) => {
    console.error('❌ OSC 錯誤:', error);
});

// 系統狀態
let systemState = {
    contentMode: 1,      // 內容模式
    maskMode: 1,         // 投影模式
    surfaceStates: {}    // Surface 開關狀態
};

// 初始化所有 Surface 狀態為開啟（使用實際的 Surface 名稱）
function initializeSurfaceStates() {
    // 初始化模式 1 的 Surfaces
    SURFACES_SETTINGS[1].forEach(surface => {
        systemState.surfaceStates[surface.SurfaceName] = false;
    });
    
    // 初始化模式 2 的 Surfaces
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
            
            // 合併載入的狀態
            if (loaded.contentMode !== undefined) systemState.contentMode = loaded.contentMode;
            if (loaded.maskMode !== undefined) systemState.maskMode = loaded.maskMode;
            
            // 正確處理 Surface 狀態
            if (loaded.surfaceStates) {
                // 遍歷載入的 Surface 狀態
                Object.keys(loaded.surfaceStates).forEach(surfaceName => {
                    // 只有在我們的設定中存在的 Surface 才載入
                    if (systemState.surfaceStates.hasOwnProperty(surfaceName)) {
                        systemState.surfaceStates[surfaceName] = loaded.surfaceStates[surfaceName];
                    }
                });
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
            timestamp: new Date().toISOString()
        };
        fs.writeFileSync(STATE_FILE, JSON.stringify(stateData, null, 2));
        console.log(`💾 系統狀態已儲存 (${new Date().toLocaleTimeString('zh-TW')})`);
    } catch (error) {
        console.error('❌ 儲存系統狀態失敗:', error.message);
    }
}

// WebSocket 伺服器
const wss = new WebSocket.Server({ port: WS_PORT });
const clients = new Set();
const unityClients = new Set();
const webClients = new Set();

console.log('╔════════════════════════════════════════╗');
console.log('║  Unity 遠端控制系統 - WebSocket+OSC   ║');
console.log('╚════════════════════════════════════════╝');
console.log(`\n🔌 WebSocket 伺服器: ws://0.0.0.0:${WS_PORT}`);
console.log(`📝 網頁由 nginx 提供`);

// 初始化並載入系統狀態
initializeSurfaceStates();
loadSystemState();

wss.on('connection', (ws, req) => {
    const clientIp = req.socket.remoteAddress;
    const clientPort = req.socket.remotePort;
    const clientId = `${clientIp}:${clientPort}`;
    
    console.log(`\n✅ 新連接: ${clientId}`);
    clients.add(ws);
    
    // 客戶端資訊
    ws.clientInfo = {
        id: clientId,
        type: 'unknown',
        connectedAt: new Date()
    };

    // 發送當前模式和系統狀態
    ws.send(JSON.stringify({
        type: 'modeUpdate',
        mode: systemState.contentMode,
        timestamp: Date.now()
    }));
    
    // 發送完整系統狀態
    ws.send(JSON.stringify({
        type: 'systemStateUpdate',
        state: systemState,
        timestamp: Date.now()
    }));

    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);
            
            // 客戶端識別
            if (data.clientType) {
                ws.clientInfo.type = data.clientType;
                if (data.clientType === 'unity') {
                    unityClients.add(ws);
                    console.log(`🎮 Unity 客戶端已識別: ${clientId}`);
                } else if (data.clientType === 'web') {
                    webClients.add(ws);
                    console.log(`🌐 網頁客戶端已識別: ${clientId}`);
                }
            }
            
            // Unity 狀態同步 - Unity 連接時發送它的當前狀態來同步整個系統
            if (data.type === 'unitySync') {
                console.log(`\n🔄 Unity 狀態同步請求`);
                console.log(`   來源: ${clientId}`);
                
                let stateChanged = false;
                
                // 同步內容模式
                if (data.contentMode !== undefined && data.contentMode !== systemState.contentMode) {
                    const oldMode = systemState.contentMode;
                    systemState.contentMode = data.contentMode;
                    console.log(`   內容模式: ${oldMode} → ${systemState.contentMode}`);
                    stateChanged = true;
                }
                
                if (stateChanged) {
                    // 儲存更新的狀態
                    saveSystemState();
                    
                    // 廣播完整系統狀態給所有客戶端（包括 Unity 自己，確保同步）
                    broadcast({
                        type: 'systemStateUpdate',
                        state: systemState,
                        source: 'unity',
                        timestamp: Date.now()
                    });
                    
                    console.log(`   ✅ 系統狀態已同步並廣播給所有客戶端`);
                } else {
                    console.log(`   ℹ️  狀態已是最新，無需更新`);
                }
            }

            // 模式切換請求
            if (data.type === 'switchMode') {
                const oldMode = systemState.contentMode;
                systemState.contentMode = data.mode;
                saveSystemState();
                
                console.log(`\n🔄 內容模式切換: ${oldMode} → ${systemState.contentMode}`);
                console.log(`   來源: ${ws.clientInfo.type} (${clientId})`);
                console.log(`   時間: ${new Date().toLocaleString('zh-TW')}`);
                
                // 廣播給所有客戶端
                broadcast({
                    type: 'modeUpdate',
                    mode: systemState.contentMode,
                    source: ws.clientInfo.type,
                    timestamp: Date.now()
                });
            }
            
            // 取得當前模式
            if (data.type === 'getMode') {
                ws.send(JSON.stringify({
                    type: 'modeUpdate',
                    mode: systemState.contentMode,
                    timestamp: Date.now()
                }));
            }
            
            // 取得系統狀態
            if (data.type === 'getSystemState') {
                ws.send(JSON.stringify({
                    type: 'systemStateUpdate',
                    state: systemState,
                    timestamp: Date.now()
                }));
            }
            
            // 心跳檢測
            if (data.type === 'ping') {
                ws.send(JSON.stringify({
                    type: 'pong',
                    timestamp: Date.now()
                }));
            }
            
            // OSC 設定查詢
            if (data.type === 'getOSCConfig') {
                ws.send(JSON.stringify({
                    type: 'oscConfig',
                    config: OSC_CONFIG,
                    timestamp: Date.now()
                }));
            }
            
            // OSC 設定更新
            if (data.type === 'updateOSCConfig') {
                updateOSCConfig(data.config);
                
                // 回傳更新結果
                ws.send(JSON.stringify({
                    type: 'oscConfigUpdated',
                    config: OSC_CONFIG,
                    success: true,
                    timestamp: Date.now()
                }));
                
                // 廣播給其他客戶端
                broadcast({
                    type: 'oscConfigUpdated',
                    config: OSC_CONFIG,
                    timestamp: Date.now()
                }, ws);
            }
            
            // MadMapper 控制
            if (data.type === 'madmapperControl') {
                const oldState = systemState.surfaceStates[data.surface];
                
                handleMadmapperControl(data);
                
                // 更新系統狀態
                systemState.surfaceStates[data.surface] = data.enabled;
                saveSystemState();
                
                console.log(`   Surface 狀態: ${data.surface} ${oldState ? '開啟' : '關閉'} → ${data.enabled ? '開啟' : '關閉'}`);
                
                // 廣播給其他客戶端更新狀態
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
                
                // 更新系統狀態
                systemState.maskMode = data.maskId;
                saveSystemState();
                
                console.log(`   投影模式: ${oldMode} → ${systemState.maskMode}`);
                
                // 廣播給其他客戶端更新狀態
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

// 廣播訊息
function broadcast(data, excludeWs = null) {
    const message = JSON.stringify(data);
    let sentCount = 0;
    
    clients.forEach(client => {
        if (client !== excludeWs && client.readyState === WebSocket.OPEN) {
            client.send(message);
            sentCount++;
        }
    });
    
    if (data.type === 'modeUpdate') {
        console.log(`   ✉️  已廣播給 ${sentCount} 個客戶端`);
    }
}

// MadMapper 控制
function handleMadmapperControl(data) {
    const oscAddress = `/surfaces/${data.surface}/opacity`;
    const oscValue = data.enabled ? 1.0 : 0.0;
    
    // console.log(`\n🎨 MadMapper 控制:`);
    console.log(`   surface: ${data.surface}`);
    console.log(`   address: ${oscAddress} value: ${oscValue} (${data.enabled ? 'open' : 'close'})`);
    console.log(`   url: ${OSC_CONFIG.madmapperIp}:${OSC_CONFIG.madmapperPort}`);
    
    try {
        udpPort.send({
            address: oscAddress,
            args: [
                {
                    type: 'f',  // float
                    value: oscValue
                }
            ]
        }, OSC_CONFIG.madmapperIp, OSC_CONFIG.madmapperPort);
        
        console.log(`   ✅ OSC 訊息已發送`);
    } catch (error) {
        console.error(`   ❌ OSC 發送失敗:`, error.message);
    }
}

// Mask 控制
function handleMaskControl(data) {
    const oscAddress = '/mask';
    const maskId = parseInt(data.maskId);
    
    // console.log(`\n🎭 Mask 控制:`);
    console.log(`   mask ID: ${maskId}`);
    console.log(`   address: ${oscAddress}`);
    console.log(`   url: ${OSC_CONFIG.objectTrackerIp}:${OSC_CONFIG.objectTrackerPort}`);
    
    try {
        udpPort.send({
            address: oscAddress,
            args: [
                {
                    type: 'i',  // integer
                    value: maskId
                }
            ]
        }, OSC_CONFIG.objectTrackerIp, OSC_CONFIG.objectTrackerPort);
        
        console.log(`   ✅ OSC 訊息已發送`);
    } catch (error) {
        console.error(`   ❌ OSC 發送失敗:`, error.message);
    }
}

// 更新 OSC 設定
function updateOSCConfig(newConfig) {
    if (newConfig.madmapperIp) OSC_CONFIG.madmapperIp = newConfig.madmapperIp;
    if (newConfig.madmapperPort) OSC_CONFIG.madmapperPort = parseInt(newConfig.madmapperPort);
    if (newConfig.objectTrackerIp) OSC_CONFIG.objectTrackerIp = newConfig.objectTrackerIp;
    if (newConfig.objectTrackerPort) OSC_CONFIG.objectTrackerPort = parseInt(newConfig.objectTrackerPort);
    
    console.log(`\n🔄 OSC 設定已更新:`);
    console.log(`   MadMapper IP: ${OSC_CONFIG.madmapperIp}:${OSC_CONFIG.madmapperPort}`);
    console.log(`   ObjectTracker IP: ${OSC_CONFIG.objectTrackerIp}:${OSC_CONFIG.objectTrackerPort}`);
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

// 顯示當前狀態
function printStatus() {
    console.log(`\n📊 連接狀態: 總計 ${clients.size} | Unity ${unityClients.size} | 網頁 ${webClients.size}`);
    console.log(`   內容模式: ${systemState.contentMode} | 投影模式: ${systemState.maskMode}`);
    const activeSurfaces = Object.keys(systemState.surfaceStates).filter(k => systemState.surfaceStates[k]).length;
    const totalSurfaces = Object.keys(systemState.surfaceStates).length;
    console.log(`   開啟的 Surface: ${activeSurfaces}/${totalSurfaces}`);
}

// 啟動後顯示資訊
printNetworkInfo();
console.log('\n按 Ctrl+C 停止伺服器\n');

// 定期狀態報告
setInterval(() => {
    if (clients.size > 0) {
        console.log(`\n⏰ [${new Date().toLocaleTimeString('zh-TW')}] 系統運行中`);
        printStatus();
    }
}, 60000); // 每 60 秒

// 清理資源
process.on('SIGINT', () => {
    console.log('\n\n⏹️  正在關閉伺服器...');
    
    // 通知所有客戶端
    broadcast({
        type: 'serverShutdown',
        message: '伺服器即將關閉'
    });
    
    // 關閉 OSC
    udpPort.close();
    console.log('✅ OSC 已關閉');
    
    wss.close(() => {
        console.log('✅ WebSocket 伺服器已關閉');
        process.exit(0);
    });
    
    // 強制退出
    setTimeout(() => {
        console.log('⚠️  強制退出');
        process.exit(1);
    }, 5000);
});

process.on('uncaughtException', (error) => {
    console.error('❌ 未捕獲的異常:', error);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('❌ 未處理的 Promise 拒絕:', reason);
});