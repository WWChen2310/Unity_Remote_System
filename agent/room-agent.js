'use strict';

// room-agent：跑在 Unity 主機（現場 192.168.0.202），替 Node 啟停 Unity build。
// 必須在登入使用者的工作階段執行（工作排程器「登入時」），不可做成 Windows Service，
// 否則 Unity 沒有桌面可以開視窗。

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const WebSocket = require('ws');

const { validateAgentConfig, isAllowedRemote } = require('./agent-config');
const { ProcessSupervisor } = require('./process-supervisor');

const HELLO_TIMEOUT_MS = 5000;
const CLOSE_UNAUTHORIZED = 4401;
const CLOSE_FORBIDDEN = 4403;
const CLOSE_BAD_REQUEST = 4400;

function tokensMatch(expected, actual) {
  if (typeof actual !== 'string') {
    return false;
  }
  const expectedBuffer = Buffer.from(expected, 'utf8');
  const actualBuffer = Buffer.from(actual, 'utf8');
  return expectedBuffer.length === actualBuffer.length
    && crypto.timingSafeEqual(expectedBuffer, actualBuffer);
}

function send(ws, message) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(message));
  }
}

/**
 * 協定：連線後第一則訊息必須是 { type: "hello", token }，回 { event: "hello", profiles }。
 * 之後的請求 { id, type: activate|ensure|stop|status, profileId? } 回 { id, ok, result|error }。
 * process 非預期結束時推 { event: "processExited", ... } 給所有已驗證的連線。
 */
function createAgentServer({ config, supervisor, port = config.port, host = '0.0.0.0', log = () => {} }) {
  const wss = new WebSocket.Server({ port, host });
  const authenticated = new Set();

  wss.on('connection', (ws, req) => {
    const remote = req.socket.remoteAddress;
    if (!isAllowedRemote(remote, config.allowedRemotes)) {
      log(`refused ${remote}`);
      ws.close(CLOSE_FORBIDDEN, 'forbidden');
      return;
    }

    let isAuthenticated = false;
    const helloTimer = setTimeout(() => {
      if (!isAuthenticated) {
        ws.close(CLOSE_UNAUTHORIZED, 'hello required');
      }
    }, HELLO_TIMEOUT_MS);
    helloTimer.unref();

    ws.on('message', async (raw) => {
      let message;
      try {
        message = JSON.parse(raw);
      } catch {
        ws.close(CLOSE_BAD_REQUEST, 'invalid json');
        return;
      }

      if (!isAuthenticated) {
        if (message && message.type === 'hello' && tokensMatch(config.token, message.token)) {
          isAuthenticated = true;
          clearTimeout(helloTimer);
          authenticated.add(ws);
          log(`controller connected from ${remote}`);
          send(ws, { event: 'hello', profiles: Object.keys(config.profiles) });
        } else {
          log(`rejected ${remote}: bad hello`);
          ws.close(CLOSE_UNAUTHORIZED, 'unauthorized');
        }
        return;
      }

      const { id, type } = message || {};
      try {
        let result;
        switch (type) {
          case 'activate':
            log(`activate ${message.profileId}`);
            result = await supervisor.activate(message.profileId);
            break;
          case 'ensure':
            log(`ensure ${message.profileId}`);
            result = await supervisor.ensure(message.profileId);
            break;
          case 'stop':
            log('stop');
            result = await supervisor.stop();
            break;
          case 'status':
            result = supervisor.status();
            break;
          default:
            throw new Error(`未知的請求 "${type}"`);
        }
        send(ws, { id, ok: true, result });
      } catch (error) {
        log(`${type} failed: ${error.message}`);
        send(ws, { id, ok: false, error: error.message });
      }
    });

    ws.on('close', () => {
      clearTimeout(helloTimer);
      authenticated.delete(ws);
    });
  });

  const onExit = (event) => {
    for (const ws of authenticated) {
      send(ws, { event: 'processExited', ...event });
    }
  };
  supervisor.on('processExited', onExit);

  const ready = new Promise((resolve, reject) => {
    wss.once('listening', resolve);
    wss.once('error', reject);
  });

  return {
    ready,
    port: () => wss.address().port,
    close: () => new Promise((resolve) => {
      supervisor.off('processExited', onExit);
      for (const ws of wss.clients) {
        ws.terminate();
      }
      wss.close(() => resolve());
    }),
  };
}

function timestamped(message) {
  console.log(`[${new Date().toISOString()}] ${message}`);
}

if (require.main === module) {
  const configPath = process.env.ROOM_AGENT_CONFIG || path.join(__dirname, 'agent.config.json');
  const config = validateAgentConfig(JSON.parse(fs.readFileSync(configPath, 'utf8')), process.env);
  if (config.token === 'change-me') {
    console.warn('WARNING: agent token is still "change-me"; set ROOM_AGENT_TOKEN on site.');
  }

  const supervisor = new ProcessSupervisor({
    profiles: config.profiles,
    gracefulStopMs: config.gracefulStopMs,
    startDelayMs: config.startDelayMs,
    log: timestamped,
  });
  const agent = createAgentServer({ config, supervisor, log: timestamped });
  agent.ready.then(() => timestamped(`room agent listening on ${config.port} (config ${configPath})`));

  process.on('SIGINT', () => agent.close().then(() => process.exit(0)));
}

module.exports = { createAgentServer };
