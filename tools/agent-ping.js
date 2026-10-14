'use strict';

// 從控制伺服器（現場 192.168.0.201）檢查 room-agent 是否可用：
//   npm run agent:ping -- ws://192.168.0.202:3100
// token 取自環境變數 ROOM_AGENT_TOKEN，沒有就用 profiles.config.json 的值。
// 成功時印出 agent 的方案清單與目前在跑的 process，exit code 0；失敗 exit code 1。

const path = require('node:path');
const { AgentClient } = require('../agent-client');

const CONNECT_TIMEOUT_MS = 8000;

function main() {
  const profilesConfig = require(path.join(__dirname, '..', 'profiles.config.json'));
  const url = process.argv[2] || profilesConfig.agent.url;
  const token = process.env.ROOM_AGENT_TOKEN || profilesConfig.agent.token;

  const client = new AgentClient({ url, token, requestTimeoutMs: 5000, reconnect: false });

  const finish = (code, message) => {
    clearTimeout(timer);
    client.stop();
    console.log(message);
    process.exit(code);
  };

  const timer = setTimeout(() => finish(1, `無法連線到 ${url}（${CONNECT_TIMEOUT_MS} ms 內沒有回應）`), CONNECT_TIMEOUT_MS);

  client.on('authFailed', (code) => finish(1, `${url} 拒絕連線（close ${code}）：檢查 ROOM_AGENT_TOKEN 與 agent 的 allowedRemotes`));

  client.on('connected', async (profiles) => {
    try {
      const status = await client.request('status');
      finish(0, JSON.stringify({ url, profiles, running: status.running }, null, 2));
    } catch (error) {
      finish(1, `已連線但 status 失敗：${error.message}`);
    }
  });

  client.start();
}

main();
