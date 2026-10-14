// integrated-server.js
// 控制伺服器的進入點：載入設定、建立 MadMapper OSC 與 room-agent 連線，再啟動 server-app。
// 現場跑在 192.168.0.201；設定檔目錄可用 ROOM_CONFIG_DIR 指定（辦公室演練用）。

'use strict';

const path = require('path');
const osc = require('osc');

const { loadConfigs, startServer } = require('./server-app');
const { AgentClient } = require('./agent-client');

const WS_PORT = 3000;
const configDir = process.env.ROOM_CONFIG_DIR || __dirname;

function timestamped(message) {
    console.log(`[${new Date().toISOString()}] ${message}`);
}

let configs;
try {
    configs = loadConfigs(configDir, process.env);
} catch (error) {
    throw new Error(`Invalid configuration in ${configDir}: ${error.message}`, { cause: error });
}
const { madmapper, profiles } = configs;

if (profiles.agent.token === 'change-me') {
    console.warn('WARNING: room agent token is still "change-me"; set ROOM_AGENT_TOKEN on site.');
}

const udpPort = new osc.UDPPort({
    localAddress: '0.0.0.0',
    localPort: madmapper.localPort,
    metadata: true
});
udpPort.open();
udpPort.on('ready', () => {
    timestamped(`OSC ready ${madmapper.localPort} -> ${madmapper.ip}:${madmapper.port}`);
});
udpPort.on('error', (error) => console.error('OSC error:', error));

function sendOsc(message) {
    try {
        udpPort.send(message, madmapper.ip, madmapper.port);
    } catch (error) {
        console.error('OSC Fail:', error.message);
    }
}

const agent = new AgentClient({
    url: profiles.agent.url,
    token: profiles.agent.token,
    requestTimeoutMs: profiles.agent.requestTimeoutMs,
    log: timestamped
});

startServer({
    wsPort: WS_PORT,
    configs,
    stateFile: path.join(configDir === __dirname ? __dirname : configDir, 'system_state.json'),
    sendOsc,
    agent,
    log: timestamped
}).then((server) => {
    agent.start();

    process.on('SIGINT', () => {
        agent.stop();
        udpPort.close();
        server.close().then(() => process.exit(0));
    });
}).catch((error) => {
    console.error('Unable to start the control server:', error.message);
    process.exit(1);
});
