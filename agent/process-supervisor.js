'use strict';

const { EventEmitter } = require('node:events');
const { execFile, spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

// taskkill 找不到符合的 process 時回傳 128，對「清殘留」來說就是成功。
const TASKKILL_NOT_FOUND = 128;
const BUILD_INFO_FILE = 'build-info.json';
const SAFE_IMAGE_NAME = /^[A-Za-z0-9_.-]+$/;
const ADOPTED_POLL_STEP_MS = 250;

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

/** 列出指定 image 名稱的 process 與命令列（用 CIM；tasklist 拿不到命令列）。 */
function defaultListProcesses(imageNames) {
  const names = imageNames.filter((name) => SAFE_IMAGE_NAME.test(name));
  if (names.length === 0) {
    return Promise.resolve([]);
  }
  const filter = names.map((name) => `Name='${name}'`).join(' OR ');
  const command = `Get-CimInstance Win32_Process -Filter "${filter}" | Select-Object ProcessId,Name,CommandLine | ConvertTo-Json -Compress`;
  return new Promise((resolve, reject) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { windowsHide: true }, (error, stdout) => {
      if (error) {
        reject(error);
        return;
      }
      const text = String(stdout || '').trim();
      if (text === '') {
        resolve([]);
        return;
      }
      const parsed = JSON.parse(text);
      resolve((Array.isArray(parsed) ? parsed : [parsed]).map((entry) => ({
        pid: entry.ProcessId,
        image: entry.Name,
        commandLine: entry.CommandLine || '',
      })));
    });
  });
}

function defaultIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

function sameImage(left, right) {
  return String(left).toLowerCase() === String(right).toLowerCase();
}

/**
 * 啟停 Unity build。同一時間只處理一個請求（activate / ensure / stop 依到達順序排隊），
 * 避免兩次切換交錯，留下兩個方案的 process 同時搶 UDP 9000。
 *
 * Unity 以 detached 啟動：否則 Node 會把它放進「父程序結束就終止」的 job object，
 * agent 當機或更新重啟會讓現場整個黑掉。agent 重啟後的 ensure 會先接管仍在跑的 Unity
 * （數量與啟動參數都符合目標方案才接管），不重啟、不黑場；接管的 process 以輪詢偵測結束。
 *
 * 停止順序：先 taskkill /PID（送 WM_CLOSE，讓 Unity 正常關閉 WebSocket 與 Spout），
 * 等寬限時間後還沒結束才用 /T /F 連同子程序強制結束；最後對所有設定中的 exe 名稱清一次殘留。
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
    listProcesses = defaultListProcesses,
    isAlive = defaultIsAlive,
    pollIntervalMs = 1000,
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
    this.listProcesses = listProcesses;
    this.isAlive = isAlive;
    this.pollIntervalMs = pollIntervalMs;
    this.log = log;
    this.children = new Map();
    this.queue = Promise.resolve();
    this.pollTimer = null;
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
      if (this.children.size === 0) {
        const adopted = await this.tryAdopt(profileId);
        if (adopted) {
          return { started: [], adopted };
        }
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
      running: [...this.children.values()].map(({ profileId, name, pid, startedAt, adopted }) => ({
        profileId, name, pid, startedAt, adopted: adopted === true,
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

  /**
   * agent 重啟後接管仍在跑的 Unity。只在「目標方案的每個 process 都恰好在跑、
   * 且沒有其他方案的 process」時接管；其餘情況回傳 null，交給 activate 重新啟動。
   */
  async tryAdopt(profileId) {
    const profile = this.profiles[profileId];
    if (!profile) {
      return null;
    }

    let running;
    try {
      running = await this.listProcesses(this.imageNames);
    } catch (error) {
      this.log(`cannot list running processes: ${error.message}`);
      return null;
    }

    const profileImages = profile.processes.map(({ exe }) => path.win32.basename(exe));
    const ours = running.filter(({ image }) => profileImages.some((name) => sameImage(name, image)));
    if (ours.length !== running.length || ours.length !== profile.processes.length) {
      return null;
    }

    const remaining = [...ours];
    const matches = [];
    for (const definition of profile.processes) {
      const image = path.win32.basename(definition.exe);
      const index = remaining.findIndex(({ image: runningImage, commandLine }) => (
        sameImage(runningImage, image) && definition.args.every((arg) => commandLine.includes(arg))
      ));
      if (index < 0) {
        return null;
      }
      matches.push({ definition, process: remaining.splice(index, 1)[0] });
    }

    for (const { definition, process: runningProcess } of matches) {
      this.adoptProcess(profileId, definition.name, runningProcess.pid);
    }
    this.startPolling();

    const adopted = matches.map(({ definition, process: runningProcess }) => ({
      name: definition.name,
      pid: runningProcess.pid,
    }));
    this.log(`adopted ${profileId}: ${adopted.map(({ name, pid }) => `${name}(${pid})`).join(', ')}`);
    return adopted;
  }

  createEntry(profileId, name, pid, child) {
    const entry = {
      profileId,
      name,
      child,
      pid,
      startedAt: child ? Date.now() : null,
      adopted: !child,
      stopping: false,
      exited: false,
    };
    entry.exitPromise = new Promise((resolve) => {
      entry.resolveExit = resolve;
    });
    this.children.set(name, entry);
    return entry;
  }

  markExited(entry, code, error) {
    if (entry.exited) {
      return;
    }
    entry.exited = true;
    if (this.children.get(entry.name) === entry) {
      this.children.delete(entry.name);
    }
    if (!entry.stopping) {
      const event = { profileId: entry.profileId, name: entry.name, pid: entry.pid, code: code ?? null };
      if (error) {
        event.error = error.message;
      }
      this.log(`${entry.name} exited unexpectedly (code ${event.code})`);
      this.emit('processExited', event);
    }
    entry.resolveExit();
  }

  adoptProcess(profileId, name, pid) {
    return this.createEntry(profileId, name, pid, null);
  }

  spawnProcess(profileId, { name, exe, args }) {
    const child = this.spawnFn(exe, args, {
      cwd: path.win32.dirname(exe),
      stdio: 'ignore',
      windowsHide: false,
      detached: true,
    });

    const entry = this.createEntry(profileId, name, child.pid, child);
    child.on('exit', (code) => this.markExited(entry, code));
    // spawn 失敗（例如 exe 被刪掉）只會發 error，不一定會發 exit。
    child.on('error', (error) => this.markExited(entry, null, error));
    return { name, pid: entry.pid };
  }

  /** 接管的 process 沒有 handle，只能輪詢。公開給測試直接呼叫。 */
  pollAdopted() {
    let anyAdopted = false;
    for (const entry of [...this.children.values()]) {
      if (!entry.adopted || entry.exited) continue;
      anyAdopted = true;
      if (!this.isAlive(entry.pid)) {
        this.markExited(entry, null);
      }
    }
    if (!anyAdopted || ![...this.children.values()].some(({ adopted }) => adopted)) {
      this.stopPolling();
    }
  }

  startPolling() {
    if (this.pollTimer) return;
    this.pollTimer = setInterval(() => this.pollAdopted(), this.pollIntervalMs);
    if (this.pollTimer.unref) this.pollTimer.unref();
  }

  stopPolling() {
    if (!this.pollTimer) return;
    clearInterval(this.pollTimer);
    this.pollTimer = null;
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

  async waitForExit(entry) {
    if (!entry.adopted) {
      return Promise.race([
        entry.exitPromise.then(() => 'exited'),
        this.delay(this.gracefulStopMs).then(() => 'timeout'),
      ]);
    }

    const steps = Math.max(1, Math.ceil(this.gracefulStopMs / ADOPTED_POLL_STEP_MS));
    for (let step = 0; step <= steps; step += 1) {
      if (entry.exited || !this.isAlive(entry.pid)) {
        this.markExited(entry, null);
        return 'exited';
      }
      if (step < steps) {
        await this.delay(ADOPTED_POLL_STEP_MS);
      }
    }
    return 'timeout';
  }

  async stopEntry(entry) {
    if (entry.exited) {
      return;
    }

    // 只送給 Unity 本身，不加 /T：子程序 UnityCrashHandler64 只能強制結束，
    // 加了 /T 會讓 taskkill 整棵樹都拒絕處理，Unity 收不到關閉訊號（實測不加 /T 約 2.6 秒正常關閉）。
    await this.execFn('taskkill', ['/PID', String(entry.pid)]);
    if (entry.exited) {
      return;
    }

    const outcome = await this.waitForExit(entry);
    if (outcome === 'timeout' && !entry.exited) {
      this.log(`${entry.name} did not close within ${this.gracefulStopMs} ms, forcing`);
      await this.execFn('taskkill', ['/PID', String(entry.pid), '/T', '/F']);
      if (entry.adopted) {
        this.markExited(entry, null);
      }
    }
  }
}

module.exports = {
  ProcessSupervisor,
  BUILD_INFO_FILE,
};
