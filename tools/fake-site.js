'use strict';

// 不接 Unity、MadMapper 與 room-agent，也能從控制台操作完整的投影方案切換：
//   npm run fake-site
// 再用靜態網站伺服器開 interface/，瀏覽器開 console.html?server=127.0.0.1。
// 假 Unity 會在切換後 1.5 秒連上，收到的狀態與 OSC 都印在這個視窗。
// 狀態檔寫在暫存資料夾，不會動到 repo 的 system_state.json。

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { loadConfigs, startServer } = require('../server-app');
const { FakeSiteAgent } = require('./fake-site-agent');

const port = Number(process.env.PORT || 3000);
const configs = loadConfigs(path.join(__dirname, '..'), process.env);
const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'room-fake-site-'));

function log(message) {
  console.log(`[${new Date().toISOString().slice(11, 23)}] ${message}`);
}

let url = null;
const agent = new FakeSiteAgent({
  url: () => url,
  profiles: configs.profiles,
  connectDelayMs: 1500,
  log,
});

startServer({
  wsPort: port,
  configs,
  stateFile: path.join(stateDir, 'system_state.json'),
  sendOsc: (message) => log(`OSC ${message.address} ${message.args[0].value}`),
  agent,
  log,
}).then((server) => {
  url = `ws://127.0.0.1:${server.port}`;
  log(`fake site ready on ${url}; state in ${stateDir}`);
  log('type "crash" + Enter to simulate a Unity crash, "offline"/"online" to toggle the agent');
  agent.start();

  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (line) => {
    const command = line.trim();
    if (command === 'crash') agent.crash(0);
    if (command === 'offline') agent.disconnect();
    if (command === 'online') agent.start();
  });

  process.on('SIGINT', () => {
    agent.stop();
    server.close().then(() => process.exit(0));
  });
});
