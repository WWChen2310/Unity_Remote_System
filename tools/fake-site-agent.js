'use strict';

// 模擬現場的 room-agent 與 Unity：收到 activate 時關掉上一組假 room，
// 再以 WebSocket 連回控制伺服器，送出與真 Unity 相同的 RoomHello。
// 端對端測試與 tools/fake-site.js 共用，讓不接 Unity 也能跑完整切換流程。

const { EventEmitter } = require('node:events');
const WebSocket = require('ws');

class FakeRoom {
  constructor({ url, build, role, log }) {
    this.build = build;
    this.role = role;
    this.log = log;
    this.inbox = [];
    this.waiters = [];
    this.ws = new WebSocket(url);
    this.ws.on('open', () => {
      this.ws.send(JSON.stringify({ clientType: 'room', type: 'unitySync', build, role }));
    });
    this.ws.on('message', (raw) => {
      const message = JSON.parse(raw);
      this.inbox.push(message);
      if (message.type === 'systemStateUpdate' || message.type === 'modeUpdate' || message.type === 'tableModeUpdate') {
        const state = message.state || message;
        this.log(`[${build}/${role}] ${message.type} mode=${state.contentMode ?? state.mode ?? '-'} tableModes=${JSON.stringify(state.tableModes)}`);
      }
      for (const waiter of [...this.waiters]) {
        if (waiter.match(message)) {
          this.waiters.splice(this.waiters.indexOf(waiter), 1);
          waiter.resolve(message);
        }
      }
    });
    this.ws.on('error', () => {});
  }

  waitFor(match) {
    const found = this.inbox.find(match);
    if (found) return Promise.resolve(found);
    return new Promise((resolve) => this.waiters.push({ match, resolve }));
  }

  close() {
    this.ws.close();
  }
}

class FakeSiteAgent extends EventEmitter {
  /**
   * @param {object} options
   * @param {() => string} options.url 控制伺服器的 WebSocket 位址（啟動後才知道埠號，所以是函式）
   * @param {object} options.profiles validateProfilesConfig 的結果
   * @param {number} [options.connectDelayMs] 假 Unity 啟動後多久連線
   * @param {boolean} [options.hangActivate] activate 永不回覆（測試切換中的行為）
   */
  constructor({ url, profiles, connectDelayMs = 0, hangActivate = false, log = () => {} }) {
    super();
    this.url = url;
    this.profiles = profiles;
    this.connectDelayMs = connectDelayMs;
    this.hangActivate = hangActivate;
    this.log = log;
    this.isConnected = false;
    this.activeProfile = null;
    this.roomList = [];
    this.timers = new Set();
    this.calls = [];
  }

  get connected() {
    return this.isConnected;
  }

  start() {
    this.isConnected = true;
    setImmediate(() => this.emit('connected', [...this.profiles.ids]));
  }

  stop() {
    this.isConnected = false;
    this.closeRooms();
  }

  /** 模擬 agent 斷線。 */
  disconnect() {
    this.isConnected = false;
    this.emit('disconnected');
  }

  /** 模擬某個 Unity 當掉。 */
  crash(index = 0) {
    const room = this.roomList[index];
    if (!room) return;
    this.roomList.splice(index, 1);
    room.close();
    this.emit('processExited', { profileId: room.build, name: `${room.build}-${room.role}`, pid: 1000 + index, code: -1 });
  }

  rooms(profileId) {
    return this.roomList.filter(({ build }) => build === profileId);
  }

  async request(type, payload = {}) {
    this.calls.push({ type, ...payload });
    if (!this.isConnected) {
      throw new Error('agent offline');
    }

    switch (type) {
      case 'activate':
        if (this.hangActivate) {
          return new Promise(() => {});
        }
        return this.activate(payload.profileId);
      case 'ensure':
        if (this.activeProfile === payload.profileId && this.roomList.length > 0) {
          return { started: [] };
        }
        return this.activate(payload.profileId);
      case 'stop':
        this.closeRooms();
        return { stopped: true };
      case 'status':
        return { running: this.roomList.map(({ build, role }) => ({ profileId: build, name: `${build}-${role}` })) };
      default:
        throw new Error(`未知的請求 "${type}"`);
    }
  }

  activate(profileId) {
    const profile = this.profiles.byId[profileId];
    if (!profile) {
      throw new Error(`未知的方案 "${profileId}"`);
    }
    this.closeRooms();
    this.activeProfile = profileId;
    const started = profile.rooms.map((role) => {
      const timer = setTimeout(() => {
        this.timers.delete(timer);
        this.roomList.push(new FakeRoom({ url: this.url(), build: profileId, role, log: this.log }));
      }, this.connectDelayMs);
      this.timers.add(timer);
      return { name: `${profileId}-${role}`, pid: 0 };
    });
    this.log(`[fake agent] started ${profileId} (${profile.rooms.join(', ')})`);
    return { started };
  }

  closeRooms() {
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    for (const room of this.roomList) room.close();
    this.roomList = [];
  }
}

module.exports = { FakeSiteAgent, FakeRoom };
