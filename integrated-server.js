// server.js
// WebSocket + OSC 整合伺服器 (不含 HTTP，由 nginx 負責)

const WebSocket = require('ws');
const osc = require('osc');
const fs = require('fs');

// 設定
const WS_PORT = 3000;
const MODE_FILE = 'current_mode.json';

// OSC 設定
const OSC_CONFIG = {
    madmapperIp: '192.168.1.190',  // MadMapper 電腦的 IP (請修改)
    madmapperPort: 8010,          // MadMapper 預設 OSC 接收端口
    localPort: 9000               // 本地發送端口
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
});

udpPort.on('error', (error) => {
    console.error('❌ OSC 錯誤:', error);
});

// 載入或初始化當前模式
let currentMode = 1;
if (fs.existsSync(MODE_FILE)) {
    try {
        const data = fs.readFileSync(MODE_FILE, 'utf8');
        currentMode = JSON.parse(data).mode || 1;
        console.log(`📂 已載入儲存的模式: ${currentMode}`);
    } catch (error) {
        console.log('⚠️  無法讀取模式檔案，使用預設模式 1');
    }
}

// 儲存模式到檔案
function saveMode(mode) {
    try {
        fs.writeFileSync(MODE_FILE, JSON.stringify({ mode, timestamp: new Date().toISOString() }));
    } catch (error) {
        console.error('❌ 儲存模式失敗:', error);
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

    // 發送當前模式
    ws.send(JSON.stringify({
        type: 'modeUpdate',
        mode: currentMode,
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
            
            // 模式切換請求
            if (data.type === 'switchMode') {
                const oldMode = currentMode;
                currentMode = data.mode;
                saveMode(currentMode);
                
                console.log(`\n🔄 模式切換: ${oldMode} → ${currentMode}`);
                console.log(`   來源: ${ws.clientInfo.type} (${clientId})`);
                console.log(`   時間: ${new Date().toLocaleString('zh-TW')}`);
                
                // 廣播給所有客戶端
                broadcast({
                    type: 'modeUpdate',
                    mode: currentMode,
                    source: ws.clientInfo.type,
                    timestamp: Date.now()
                });
            }
            
            // 取得當前模式
            if (data.type === 'getMode') {
                ws.send(JSON.stringify({
                    type: 'modeUpdate',
                    mode: currentMode,
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
            
            // OSC 控制 MadMapper
            if (data.type === 'oscControl') {
                handleOSCControl(data);
                
                // 廣播給其他客戶端更新狀態
                broadcast({
                    type: 'oscStatusUpdate',
                    surface: data.surface,
                    parameter: data.parameter || 'opacity',
                    value: data.value !== undefined ? data.value : (data.enabled ? 1.0 : 0.0),
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

// 處理 OSC 控制
function handleOSCControl(data) {
    let oscAddress, oscValue;
    
    // 支援兩種格式
    if (data.parameter) {
        // 格式 1: 指定參數和值
        oscAddress = `/surfaces/${data.surface}/${data.parameter}`;
        oscValue = parseFloat(data.value);
    } else {
        // 格式 2: 簡單的開關 (enabled: true/false)
        oscAddress = `/surfaces/${data.surface}/opacity`;
        oscValue = data.enabled ? 1.0 : 0.0;
    }
    
    console.log(`\n🎵 發送 OSC 訊息:`);
    console.log(`   位址: ${oscAddress}`);
    console.log(`   值: ${oscValue}`);
    console.log(`   目標: ${OSC_CONFIG.madmapperIp}:${OSC_CONFIG.madmapperPort}`);
    
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

// 更新 OSC 設定
function updateOSCConfig(newConfig) {
    if (newConfig.madmapperIp) OSC_CONFIG.madmapperIp = newConfig.madmapperIp;
    if (newConfig.madmapperPort) OSC_CONFIG.madmapperPort = parseInt(newConfig.madmapperPort);
    
    console.log(`\n🔄 OSC 設定已更新:`);
    console.log(`   MadMapper IP: ${OSC_CONFIG.madmapperIp}`);
    console.log(`   MadMapper Port: ${OSC_CONFIG.madmapperPort}`);
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
    console.log(`   當前模式: ${currentMode}`);
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