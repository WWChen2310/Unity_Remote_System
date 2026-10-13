'use strict';

const { EventEmitter } = require('node:events');
const WebSocket = require('ws');

const AUTH_CLOSE_CODES = new Set([4401, 4403]);

/**
 * Node 端連到 room-agent 的 client。
 *
 * - 連上後先送 hello（帶 token），收到 agent 的 hello 才算 connected。
 * - request(type, payload) 以 id 對應回覆；離線時立刻以 "agent offline" 拒絕，
 *   不排隊等重連——切換方案時操作者需要馬上知道 agent 不在，而不是等逾時。
 * - 斷線後依 reconnectDelaysMs 重連，最後一個間隔之後固定使用它。
 *
 * 事件：connected(profiles)、disconnected、processExited(event)、authFailed(code)。
 */
class AgentClient extends EventEmitter {
  constructor({
    url,
    token,
    requestTimeoutMs = 60000,
    reconnectDelaysMs = [1000, 2000, 5000, 10000],
    reconnect = true,
    WebSocketImpl = WebSocket,
    log = () => {},
  }) {
    super();
    this.url = url;
    this.token = token;
    this.requestTimeoutMs = requestTimeoutMs;
    this.reconnectDelaysMs = reconnectDelaysMs;
    this.reconnect = reconnect;
    this.WebSocketImpl = WebSocketImpl;
    this.log = log;

    this.ws = null;
    this.isConnected = false;
    this.stopped = true;
    this.attempt = 0;
    this.reconnectTimer = null;
    this.nextId = 1;
    this.pending = new Map();
  }

  get connected() {
    return this.isConnected;
  }

  start() {
    if (!this.stopped) {
      return;
    }
    this.stopped = false;
    this.connect();
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.reconnectTimer);
    if (this.ws) {
      this.ws.removeAllListeners();
      this.ws.on('error', () => {});
      this.ws.terminate();
      this.ws = null;
    }
    this.handleDisconnect();
  }

  request(type, payload = {}) {
    if (!this.isConnected || !this.ws) {
      return Promise.reject(new Error('agent offline'));
    }

    const id = this.nextId;
    this.nextId += 1;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`agent ${type} 逾時（${this.requestTimeoutMs} ms）`));
      }, this.requestTimeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ ...payload, id, type }));
    });
  }

  connect() {
    if (this.stopped) {
      return;
    }

    const ws = new this.WebSocketImpl(this.url);
    this.ws = ws;

    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'hello', token: this.token }));
    });

    ws.on('message', (raw) => {
      let message;
      try {
        message = JSON.parse(raw);
      } catch {
        return;
      }

      if (message.event === 'hello') {
        this.isConnected = true;
        this.attempt = 0;
        this.log(`agent connected (${this.url})`);
        this.emit('connected', message.profiles || []);
        return;
      }

      if (message.event === 'processExited') {
        const { event, ...detail } = message;
        this.emit('processExited', detail);
        return;
      }

      const entry = this.pending.get(message.id);
      if (!entry) {
        return;
      }
      this.pending.delete(message.id);
      clearTimeout(entry.timer);
      if (message.ok) {
        entry.resolve(message.result);
      } else {
        entry.reject(new Error(message.error || 'agent request failed'));
      }
    });

    ws.on('error', (error) => {
      this.log(`agent connection error: ${error.message}`);
    });

    ws.on('close', (code) => {
      if (this.ws !== ws) {
        return;
      }
      this.ws = null;
      if (AUTH_CLOSE_CODES.has(code)) {
        this.log(`agent refused this server (close ${code}); check ROOM_AGENT_TOKEN and allowedRemotes`);
        this.emit('authFailed', code);
      }
      this.handleDisconnect();
      this.scheduleReconnect();
    });
  }

  handleDisconnect() {
    const wasConnected = this.isConnected;
    this.isConnected = false;

    for (const { reject, timer } of this.pending.values()) {
      clearTimeout(timer);
      reject(new Error('agent offline'));
    }
    this.pending.clear();

    if (wasConnected) {
      this.log('agent disconnected');
      this.emit('disconnected');
    }
  }

  scheduleReconnect() {
    if (this.stopped || !this.reconnect || this.reconnectDelaysMs.length === 0) {
      return;
    }
    const index = Math.min(this.attempt, this.reconnectDelaysMs.length - 1);
    const delay = this.reconnectDelaysMs[index];
    this.attempt += 1;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }
}

module.exports = { AgentClient };
