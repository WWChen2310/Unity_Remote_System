'use strict';

const { EventEmitter } = require('node:events');

/**
 * 追蹤目前連在 Node 上的 Unity 內容主程式（clientType "room"）。
 *
 * 切換方案時，Node 要等新啟動的 build 的每個角色都連上（s1 為 both，s2 為 tables + ground）
 * 才恢復投影。只算 since 之後才登記的連線：重新啟動同一個方案時，舊連線可能還沒斷。
 */
class RoomPresence extends EventEmitter {
  constructor({ now = Date.now } = {}) {
    super();
    this.now = now;
    this.rooms = new Map();
    this.waiters = new Set();
  }

  register(key, { build, role }) {
    this.rooms.set(key, { build, role, registeredAt: this.now() });
    this.emit('change');
    this.checkWaiters();
  }

  unregister(key) {
    if (this.rooms.delete(key)) {
      this.emit('change');
    }
  }

  list() {
    return [...this.rooms.values()].map(({ build, role, registeredAt }) => ({ build, role, registeredAt }));
  }

  missingRoles(build, roles, since) {
    return roles.filter((role) => ![...this.rooms.values()].some((room) => (
      room.build === build && room.role === role && room.registeredAt >= since
    )));
  }

  waitFor(build, roles, { since = 0, timeoutMs }) {
    return new Promise((resolve, reject) => {
      if (this.missingRoles(build, roles, since).length === 0) {
        resolve();
        return;
      }

      const waiter = { build, roles, since, resolve, reject, timer: null };
      waiter.timer = setTimeout(() => {
        this.waiters.delete(waiter);
        const missing = this.missingRoles(build, roles, since);
        reject(new Error(`等待 ${build} 連線逾時，缺少 ${missing.join(', ')}`));
      }, timeoutMs);
      this.waiters.add(waiter);
    });
  }

  /** 伺服器關閉時取消所有等待，不留下會讓 process 無法結束的計時器。 */
  cancelAll(reason = 'cancelled') {
    for (const waiter of [...this.waiters]) {
      clearTimeout(waiter.timer);
      this.waiters.delete(waiter);
      waiter.reject(new Error(reason));
    }
  }

  checkWaiters() {
    for (const waiter of [...this.waiters]) {
      if (this.missingRoles(waiter.build, waiter.roles, waiter.since).length === 0) {
        clearTimeout(waiter.timer);
        this.waiters.delete(waiter);
        waiter.resolve();
      }
    }
  }
}

module.exports = { RoomPresence };
