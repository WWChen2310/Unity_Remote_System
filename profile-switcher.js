'use strict';

const { createMadmapperOscMessage } = require('./control-model');

/** 切換步驟，依序執行；控制台用同一組名稱顯示進度。 */
const SWITCH_STEPS = Object.freeze(['blackout', 'starting', 'waitingForRooms', 'settling', 'restoring']);

/**
 * 投影方案切換的狀態機。所有外部依賴都由建構參數注入，可以直接測試。
 *
 * 流程：停自動循環 → activeProfile 改成目標 → 熄掉所有方案的區域、其他方案的工作燈 →
 * agent 啟動目標 build → 等該方案的每個角色都連上 → 等 Spout 建立 → 恢復目標方案的區域。
 * 任何一步失敗就停在 failed，區域維持 0，不自動重試：交給操作者決定重試或回到原方案。
 *
 * MadMapper 與方案綁定：只有目前方案的區域與工作燈會亮，其他方案一律關閉（控制台也鎖住）。
 * 目標方案的工作燈在熄燈時就照存檔恢復，切換途中現場仍有照明。
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
      this.applyMadmapper(to, { areasOn: false });

      enter('starting');
      const since = this.now();
      await this.agent.request('activate', { profileId: to });

      enter('waitingForRooms');
      await this.presence.waitFor(to, profile.rooms, { since, timeoutMs: profile.readyTimeoutMs });

      enter('settling');
      await this.delay(profile.settleMs);

      enter('restoring');
      this.applyMadmapper(to, { areasOn: true });

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
   * 對齊狀態。重開機後 MadMapper 可能留著上次專案存檔時的開關，所以其他方案一律關掉。
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
      this.applyMadmapper(active, { areasOn: true });
      return { ok: true, started };
    } catch (error) {
      this.log(`ensure ${active} failed: ${error.message}`);
      return { ok: false, reason: 'error', error: error.message };
    }
  }

  /**
   * 送出整套 MadMapper 開關：其他方案的區域與工作燈全關；目前方案的工作燈照存檔，
   * 區域在 areasOn 時照存檔、否則全關（切換中熄燈）。存檔本身不改。
   */
  applyMadmapper(activeProfileId, { areasOn }) {
    const saved = this.store.get().profiles[activeProfileId];
    const others = this.profiles.ids.filter((profileId) => profileId !== activeProfileId);
    this.log(`MadMapper: ${others.join(', ')} off; ${activeProfileId} areas ${areasOn ? 'as saved' : 'off'}, lights as saved`);
    for (const profileId of this.profiles.ids) {
      const { areas, lights, targetMap } = this.madmapper.profiles[profileId];
      const isActive = profileId === activeProfileId;
      for (const { name } of areas) {
        this.sendOsc(createMadmapperOscMessage(targetMap, name, isActive && areasOn && saved.surfaceStates[name] === true));
      }
      for (const { name } of lights) {
        this.sendOsc(createMadmapperOscMessage(targetMap, name, isActive && saved.lightStates[name] === true));
      }
    }
  }
}

module.exports = {
  SWITCH_STEPS,
  ProfileSwitcher,
};
