'use strict';

const path = require('node:path');

// 與 control-model.js 相同的規則；agent 部署在另一台機器，不依賴伺服器端的模組。
const PROFILE_ID_PATTERN = /^[a-z0-9_-]+$/;

function isPlainObject(value) {
  return value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value));
}

function fail(message) {
  throw new Error(`agent.config.json: ${message}`);
}

function readSeconds(value, field) {
  if (typeof value !== 'number' || !(value >= 0)) {
    fail(`${field} must be zero or more`);
  }
  return Math.round(value * 1000);
}

/**
 * agent 只會啟動這份設定裡列出的 exe；Node 只能說「啟動 s1」，不能指定任意執行檔。
 * ROOM_AGENT_TOKEN 優先於檔案中的 token，正式現場不把真實 token 提交進 git。
 */
function validateAgentConfig(raw, env = process.env) {
  if (!isPlainObject(raw)) {
    fail('must be a plain object');
  }

  if (!Number.isInteger(raw.port) || raw.port < 1 || raw.port > 65535) {
    fail('port must be an integer from 1 to 65535');
  }

  const token = (env && typeof env.ROOM_AGENT_TOKEN === 'string' && env.ROOM_AGENT_TOKEN !== '')
    ? env.ROOM_AGENT_TOKEN
    : raw.token;
  if (typeof token !== 'string' || token === '') {
    fail('token must be a nonempty string (or set ROOM_AGENT_TOKEN)');
  }

  if (!Array.isArray(raw.allowedRemotes)
    || raw.allowedRemotes.length === 0
    || !raw.allowedRemotes.every((address) => typeof address === 'string' && address !== '')) {
    fail('allowedRemotes must list at least one address');
  }

  if (!isPlainObject(raw.profiles) || Object.keys(raw.profiles).length === 0) {
    fail('profiles must define at least one profile');
  }

  const names = new Set();
  const profiles = {};
  for (const [profileId, profile] of Object.entries(raw.profiles)) {
    if (!PROFILE_ID_PATTERN.test(profileId)) {
      fail(`profile id "${profileId}" must match ${PROFILE_ID_PATTERN}`);
    }
    if (!isPlainObject(profile) || !Array.isArray(profile.processes) || profile.processes.length === 0) {
      fail(`profile "${profileId}" must list at least one entry in processes`);
    }

    profiles[profileId] = {
      processes: profile.processes.map((entry, index) => {
        if (!isPlainObject(entry)) {
          fail(`profile "${profileId}" process ${index} must be an object`);
        }
        const { name, exe, args = [] } = entry;
        if (typeof name !== 'string' || name === '') {
          fail(`profile "${profileId}" process ${index} needs a name`);
        }
        if (names.has(name)) {
          fail(`process name "${name}" is duplicated`);
        }
        names.add(name);
        if (typeof exe !== 'string' || !path.win32.isAbsolute(exe)) {
          fail(`process "${name}" exe must be an absolute path`);
        }
        if (!exe.toLowerCase().endsWith('.exe')) {
          fail(`process "${name}" exe must end with .exe`);
        }
        if (!Array.isArray(args) || !args.every((arg) => typeof arg === 'string')) {
          fail(`process "${name}" args must be a list of strings`);
        }
        return { name, exe, args: [...args] };
      }),
    };
  }

  return {
    port: raw.port,
    token,
    allowedRemotes: [...raw.allowedRemotes],
    gracefulStopMs: readSeconds(raw.gracefulStopSec ?? 5, 'gracefulStopSec'),
    startDelayMs: readSeconds(raw.startDelaySec ?? 2, 'startDelaySec'),
    profiles,
  };
}

/** 比對連線來源；IPv4-mapped（::ffff:x.x.x.x）與 IPv6 loopback 都正規化成 IPv4。 */
function isAllowedRemote(address, allowedRemotes) {
  if (typeof address !== 'string') {
    return false;
  }
  let normalized = address;
  if (normalized.startsWith('::ffff:')) {
    normalized = normalized.slice('::ffff:'.length);
  }
  if (normalized === '::1') {
    normalized = '127.0.0.1';
  }
  return allowedRemotes.includes(normalized);
}

module.exports = {
  PROFILE_ID_PATTERN,
  validateAgentConfig,
  isAllowedRemote,
};
