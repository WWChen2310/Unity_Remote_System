'use strict';

const { createMadmapperOscMessage } = require('./control-model');

/** 切換步驟，依序執行；控制台用同一組名稱顯示進度。 */
const SWITCH_STEPS = Object.freeze(['blackout', 'starting', 'waitingForRooms', 'settling', 'restoring']);

/**
 * 投影方案切換的狀態機。所有外部依賴都由建構參數注入，可以直接測試。
 *
 * 流程：停自動循環 → activeProfile 改成目標 → 全部方案的區域 opacity 0 →
 * agent 啟動目標 build → 等該方案的每個角色都連上 → 等 Spout 建立 → 恢復目標方案的區域。
 * 任何一步失敗就停在 failed，區域維持 0，不自動重試：交給操作者決定重試或回到原方案。
 *
 * activeProfile 在第一步就改成目標：新的 Unity 一連上就會收到狀態，那一刻必須已是目標方案的 view。
 */
class ProfileSwitcher {
  constructor({
    store,
    profiles,
    madmapper,
    sendOsc,
    agent,
    presence,
    delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now = Date.now,
    events = {},
    stopAutoCycle = () => {},
    log = () => {},
  }) {
    this.store = store;
    this.profiles = profiles;
    this.madmapper = madmapper;
    this.sendOsc = sendOsc;
    this.agent = agent;
    this.presence = presence;
    this.delay = delay;
    this.now = now;
    this.events = {
      switchChanged: () => {},
      switchCompleted: () => {},
      ...events,
    };
    this.stopAutoCycle = stopAutoCycle;
    this.log = log;
  }

  isSwitching() {
    return this.store.get().switch.status === 'switching';
  }

  restartActive() {
    return this.switchTo(this.store.get().activeProfile);
  }

  async switchTo(to) {
    if (this.isSwitching()) {
      return { ok: false, reason: 'switching' };
    }
    const profile = this.profiles.byId[to];
    if (!profile) {
      return { ok: false, reason: 'unknownProfile' };
    }

    this.stopAutoCycle();

    const from = this.store.get().activeProfile;
    const startedAt = this.now();
    let step = SWITCH_STEPS[0];

    this.store.update((state) => {
      state.activeProfile = to;
      state.switch = { status: 'switching', from, to, step, startedAt, error: null };
    });
    this.events.switchChanged();
    this.log(`switching ${from} -> ${to}`);

    const enter = (next) => {
      step = next;
      this.store.update((state) => {
        state.switch.step = next;
      });
      this.events.switchChanged();
    };

    try {
      this.blackoutAllProfiles();

      enter('starting');
      const since = this.now();
      await this.agent.request('activate', { profileId: to });

      enter('waitingForRooms');
      await this.presence.waitFor(to, profile.rooms, { since, timeoutMs: profile.readyTimeoutMs });

      enter('settling');
      await this.delay(profile.settleMs);

      enter('restoring');
      this.restoreProfileSurfaces(to);

      this.store.update((state) => {
        state.switch = { status: 'idle', from, to, step: null, startedAt, error: null };
      });
      this.log(`switched to ${to} in ${this.now() - startedAt} ms`);
      this.events.switchCompleted();
      return { ok: true };
    } catch (error) {
      this.store.update((state) => {
        state.switch = { status: 'failed', from, to, step, startedAt, error: error.message };
      });
      this.log(`switch to ${to} failed at ${step}: ${error.message}`);
      this.events.switchChanged();
      return { ok: false, reason: 'failed', error: error.message };
    }
  }

  /**
   * agent 每次連上時呼叫：確保目前方案在跑（現場重開機後會自動啟動），再把 MadMapper
   * 的區域對齊狀態。重開機後 MadMapper 可能留著上次專案存檔時的開關，所以其他方案一律關掉。
   */
  async ensureActive() {
    const state = this.store.get();
    if (state.switch.status !== 'idle') {
      return { ok: false, reason: state.switch.status };
    }

    const active = state.activeProfile;
    const profile = this.profiles.byId[active];
    try {
      const since = this.now();
      const result = await this.agent.request('ensure', { profileId: active });
      const started = Array.isArray(result && result.started) ? result.started.length : 0;
      if (started > 0) {
        await this.presence.waitFor(active, profile.rooms, { since, timeoutMs: profile.readyTimeoutMs });
        await this.delay(profile.settleMs);
      }
      this.blackoutOtherProfiles(active);
      this.restoreProfileSurfaces(active);
      return { ok: true, started };
    } catch (error) {
      this.log(`ensure ${active} failed: ${error.message}`);
      return { ok: false, reason: 'error', error: error.message };
    }
  }

  blackoutAllProfiles() {
    for (const profileId of this.profiles.ids) {
      this.sendProfileAreas(profileId, () => false);
    }
  }

  blackoutOtherProfiles(activeProfileId) {
    for (const profileId of this.profiles.ids) {
      if (profileId !== activeProfileId) {
        this.sendProfileAreas(profileId, () => false);
      }
    }
  }

  restoreProfileSurfaces(profileId) {
    const surfaceStates = this.store.get().profiles[profileId].surfaceStates;
    this.sendProfileAreas(profileId, (name) => surfaceStates[name] === true);
  }

  sendProfileAreas(profileId, isEnabled) {
    const { areas, targetMap } = this.madmapper.profiles[profileId];
    for (const { name } of areas) {
      this.sendOsc(createMadmapperOscMessage(targetMap, name, isEnabled(name)));
    }
  }
}

module.exports = {
  SWITCH_STEPS,
  ProfileSwitcher,
};
