'use strict';

const { EventEmitter } = require('node:events');
const { execFile, spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

// taskkill 找不到符合的 process 時回傳 128，對「清殘留」來說就是成功。
const TASKKILL_NOT_FOUND = 128;
const BUILD_INFO_FILE = 'build-info.json';

function defaultExec(file, args) {
  return new Promise((resolve) => {
    execFile(file, args, { windowsHide: true }, (error, stdout, stderr) => {
      const code = error ? (typeof error.code === 'number' ? error.code : 1) : 0;
      resolve({ code, stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
  });
}

function defaultDelay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function defaultReadBuildInfo(directory) {
  const file = path.join(directory, BUILD_INFO_FILE);
  if (!fs.existsSync(file)) {
    return null;
  }
  const text = fs.readFileSync(file, 'utf8').replace(/^﻿/, '');
  return JSON.parse(text);
}

/**
 * 啟停 Unity build。同一時間只處理一個請求（activate / ensure / stop 依到達順序排隊），
 * 避免兩次切換交錯，留下兩個方案的 process 同時搶 UDP 9000。
 *
 * 停止順序：先 taskkill /PID（送 WM_CLOSE，讓 Unity 正常關閉 WebSocket 與 Spout），
 * 等寬限時間後還沒結束才加 /F；最後對所有設定中的 exe 名稱清一次殘留，
 * 包括 agent 重啟前留下、它已經不認得的 process。
 */
class ProcessSupervisor extends EventEmitter {
  constructor({
    profiles,
    gracefulStopMs = 5000,
    startDelayMs = 2000,
    spawnFn = spawn,
    execFn = defaultExec,
    delay = defaultDelay,
    readBuildInfo = defaultReadBuildInfo,
    fileExists = fs.existsSync,
    log = () => {},
  }) {
    super();
    this.profiles = profiles;
    this.gracefulStopMs = gracefulStopMs;
    this.startDelayMs = startDelayMs;
    this.spawnFn = spawnFn;
    this.execFn = execFn;
    this.delay = delay;
    this.readBuildInfo = readBuildInfo;
    this.fileExists = fileExists;
    this.log = log;
    this.children = new Map();
    this.queue = Promise.resolve();
    this.imageNames = [...new Set(
      Object.values(profiles).flatMap(({ processes }) => processes.map(({ exe }) => path.win32.basename(exe))),
    )];
  }

  activate(profileId) {
    return this.enqueue(() => this.activateNow(profileId));
  }

  ensure(profileId) {
    return this.enqueue(async () => {
      if (this.isRunning(profileId)) {
        return { started: [] };
      }
      return this.activateNow(profileId);
    });
  }

  stop() {
    return this.enqueue(async () => {
      await this.stopAllNow();
      return { stopped: true };
    });
  }

  status() {
    return {
      running: [...this.children.values()].map(({ profileId, name, pid, startedAt }) => ({
        profileId, name, pid, startedAt,
      })),
    };
  }

  enqueue(task) {
    const result = this.queue.then(task, task);
    this.queue = result.catch(() => {});
    return result;
  }

  isRunning(profileId) {
    const profile = this.profiles[profileId];
    if (!profile) {
      return false;
    }
    const running = [...this.children.values()];
    return running.length === profile.processes.length
      && profile.processes.every(({ name }) => running.some((entry) => entry.name === name && entry.profileId === profileId));
  }

  /** 先檢查目標 build 正確才停舊的：放錯資料夾時，現場正在播的方案不會被關掉。 */
  verifyProfile(profileId) {
    const profile = this.profiles[profileId];
    if (!profile) {
      throw new Error(`未知的方案 "${profileId}"`);
    }

    for (const directory of new Set(profile.processes.map(({ exe }) => path.win32.dirname(exe)))) {
      let info;
      try {
        info = this.readBuildInfo(directory);
      } catch (error) {
        throw new Error(`${directory} 的 ${BUILD_INFO_FILE} 無法讀取：${error.message}`);
      }
      if (!info) {
        throw new Error(`找不到 ${directory}\\${BUILD_INFO_FILE}，請用 RoomPlayerBuild 重新建置`);
      }
      if (info.build !== profileId) {
        throw new Error(`${directory} 的 ${BUILD_INFO_FILE} 的 build 是 ${info.build}，不是 ${profileId}`);
      }
    }

    for (const { exe } of profile.processes) {
      if (!this.fileExists(exe)) {
        throw new Error(`找不到 ${exe}`);
      }
    }

    return profile;
  }

  async activateNow(profileId) {
    const profile = this.verifyProfile(profileId);
    await this.stopAllNow();

    const started = [];
    for (let index = 0; index < profile.processes.length; index += 1) {
      if (index > 0) {
        await this.delay(this.startDelayMs);
      }
      started.push(this.spawnProcess(profileId, profile.processes[index]));
    }
    this.log(`started ${profileId}: ${started.map(({ name, pid }) => `${name}(${pid})`).join(', ')}`);
    return { started };
  }

  spawnProcess(profileId, { name, exe, args }) {
    const child = this.spawnFn(exe, args, {
      cwd: path.win32.dirname(exe),
      stdio: 'ignore',
      windowsHide: false,
    });

    const entry = {
      profileId,
      name,
      child,
      pid: child.pid,
      startedAt: Date.now(),
      stopping: false,
      exited: false,
    };

    entry.exitPromise = new Promise((resolve) => {
      const finish = (code, error) => {
        if (entry.exited) {
          return;
        }
        entry.exited = true;
        if (this.children.get(name) === entry) {
          this.children.delete(name);
        }
        if (!entry.stopping) {
          const event = { profileId, name, pid: entry.pid, code: code ?? null };
          if (error) {
            event.error = error.message;
          }
          this.log(`${name} exited unexpectedly (code ${event.code})`);
          this.emit('processExited', event);
        }
        resolve();
      };
      child.on('exit', (code) => finish(code));
      // spawn 失敗（例如 exe 被刪掉）只會發 error，不一定會發 exit。
      child.on('error', (error) => finish(null, error));
    });

    this.children.set(name, entry);
    return { name, pid: entry.pid };
  }

  async stopAllNow() {
    const entries = [...this.children.values()];
    for (const entry of entries) {
      entry.stopping = true;
    }
    await Promise.all(entries.map((entry) => this.stopEntry(entry)));

    for (const image of this.imageNames) {
      const result = await this.execFn('taskkill', ['/IM', image, '/T', '/F']);
      if (result.code !== 0 && result.code !== TASKKILL_NOT_FOUND) {
        this.log(`taskkill /IM ${image} returned ${result.code}`);
      }
    }
  }

  async stopEntry(entry) {
    if (entry.exited) {
      return;
    }

    await this.execFn('taskkill', ['/PID', String(entry.pid), '/T']);
    if (entry.exited) {
      return;
    }

    const outcome = await Promise.race([
      entry.exitPromise.then(() => 'exited'),
      this.delay(this.gracefulStopMs).then(() => 'timeout'),
    ]);

    if (outcome === 'timeout' && !entry.exited) {
      this.log(`${entry.name} did not close within ${this.gracefulStopMs} ms, forcing`);
      await this.execFn('taskkill', ['/PID', String(entry.pid), '/T', '/F']);
    }
  }
}

module.exports = {
  ProcessSupervisor,
  BUILD_INFO_FILE,
};
