// integrated-server.js
// 整合 WebSocket 和 HTTP 伺服器的完整解決方案

const WebSocket = require('ws');
const http = require('http');
const fs = require('fs');
const path = require('path');

// 設定
const WS_PORT = 3000;
const HTTP_PORT = 8080;
const MODE_FILE = 'current_mode.json';

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
console.log('║   Unity 遠端控制系統 - 整合伺服器     ║');
console.log('╚════════════════════════════════════════╝');
console.log(`\n🔌 WebSocket 伺服器: ws://0.0.0.0:${WS_PORT}`);

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

// HTTP 伺服器（提供網頁）
const httpServer = http.createServer((req, res) => {
    // API 端點
    if (req.url === '/api/status') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            currentMode,
            clients: clients.size,
            unityClients: unityClients.size,
            webClients: webClients.size,
            uptime: process.uptime(),
            timestamp: Date.now()
        }));
        return;
    }
    
    if (req.url === '/api/mode' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ mode: currentMode }));
        return;
    }
    
    // 提供 HTML 頁面
    const filePath = path.join(__dirname, 'index.html');
    
    fs.readFile(filePath, (err, content) => {
        if (err) {
            if (err.code === 'ENOENT') {
                res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
                res.end(`
                    <!DOCTYPE html>
                    <html>
                    <head>
                        <meta charset="utf-8">
                        <title>檔案未找到</title>
                        <style>
                            body { font-family: Arial; text-align: center; padding: 50px; }
                            h1 { color: #e74c3c; }
                        </style>
                    </head>
                    <body>
                        <h1>⚠️ index.html 檔案未找到</h1>
                        <p>請將 index.html 放在與 integrated-server.js 相同的目錄中</p>
                        <p>當前目錄: ${__dirname}</p>
                    </body>
                    </html>
                `);
            } else {
                res.writeHead(500);
                res.end('伺服器錯誤');
            }
        } else {
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(content);
        }
    });
});

httpServer.listen(HTTP_PORT, '0.0.0.0', () => {
    console.log(`🌐 HTTP 伺服器: http://0.0.0.0:${HTTP_PORT}`);
    console.log(`\n📱 請用手機/平板瀏覽器開啟上述網址`);
    printNetworkInfo();
    console.log('\n按 Ctrl+C 停止伺服器\n');
});

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
                console.log(`   網頁: http://${iface.address}:${HTTP_PORT}`);
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
    
    wss.close(() => {
        console.log('✅ WebSocket 伺服器已關閉');
    });
    
    httpServer.close(() => {
        console.log('✅ HTTP 伺服器已關閉');
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