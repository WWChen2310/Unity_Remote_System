'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const WebSocket = require('ws');

const { startServer, loadConfigs } = require('../server-app');
const { FakeSiteAgent } = require('../tools/fake-site-agent');

const configs = loadConfigs(path.join(__dirname, '..'), {});

function connectClient(t, url, hello) {
  const ws = new WebSocket(url);
  const inbox = [];
  const waiters = [];
  ws.on('message', (raw) => {
    const message = JSON.parse(raw);
    inbox.push(message);
    for (const waiter of [...waiters]) {
      if (waiter.match(message)) {
        waiters.splice(waiters.indexOf(waiter), 1);
        waiter.resolve(message);
      }
    }
  });
  t.after(() => ws.terminate());
  const opened = new Promise((resolve) => ws.once('open', () => {
    if (hello) ws.send(JSON.stringify(hello));
    resolve();
  }));
  return {
    inbox,
    opened,
    send: (message) => ws.send(JSON.stringify(message)),
    waitFor: (match, timeoutMs = 3000) => {
      const found = inbox.find(match);
      if (found) return Promise.resolve(found);
      return new Promise((resolve, reject) => {
        const waiter = { match, resolve };
        waiters.push(waiter);
        setTimeout(() => {
          const index = waiters.indexOf(waiter);
          if (index >= 0) {
            waiters.splice(index, 1);
            reject(new Error(`timed out; inbox types: ${inbox.map(({ type }) => type).join(', ')}`));
          }
        }, timeoutMs).unref();
      });
    },
    clear: () => { inbox.length = 0; },
  };
}

async function startTestSite(t, { initialState, files = {}, hangActivate = false } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'room-server-'));
  const stateFile = path.join(directory, 'system_state.json');
  if (initialState) {
    fs.writeFileSync(stateFile, JSON.stringify(initialState));
  }
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(directory, name), content);
  }

  const oscLog = [];
  let url = null;
  const agent = new FakeSiteAgent({ url: () => url, profiles: configs.profiles, hangActivate });

  const server = await startServer({
    wsPort: 0,
    host: '127.0.0.1',
    configs,
    stateFile,
    sendOsc: (message) => oscLog.push(message),
    agent,
    delay: () => Promise.resolve(),
    log: () => {},
  });
  url = `ws://127.0.0.1:${server.port}`;

  t.after(async () => {
    agent.stop();
    await server.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  return {
    server,
    agent,
    oscLog,
    stateFile,
    url,
    async connectConsole() {
      const client = connectClient(t, url, { clientType: 'web' });
      await client.opened;
      await client.waitFor((m) => m.type === 'systemStateUpdate');
      return client;
    },
  };
}

async function startAndSettle(t, options) {
  const site = await startTestSite(t, options);
  site.agent.start();
  // agent 連上後伺服器會 ensure 目前方案（s2），等兩個假 room 都連上。
  await waitUntil(() => site.server.getRooms().length === 2);
  return site;
}

async function waitUntil(predicate, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function isIdleOn(profileId) {
  return (m) => m.type === 'systemStateUpdate'
    && m.state.activeProfile === profileId
    && m.state.switch.status === 'idle';
}

test('the agent connecting starts the active profile and its rooms get room views', async (t) => {
  const site = await startAndSettle(t);

  const tables = site.agent.rooms('s2').find(({ role }) => role === 'tables');
  // 連線當下會先收到一份 console view（握手前還不知道它是誰），握手後才是 room view。
  const first = await tables.waitFor((m) => m.type === 'systemStateUpdate');
  assert.equal(first.state.activeProfile, 's2');
  const roomState = await tables.waitFor((m) => m.type === 'systemStateUpdate' && !('activeProfile' in m.state));
  assert.equal(roomState.state.groundThemeId, 'none');
  assert.equal(roomState.state.tableModes.length, 9);
  assert.deepEqual(Object.keys(roomState.state).sort(), ['contentMode', 'groundThemeId', 'logo', 'maskMode', 'tableModes']);
});

test('switching to s1 gives the s1 room eight reversed seats and restores s1 areas', async (t) => {
  const site = await startAndSettle(t);
  const consoleClient = await site.connectConsole();

  consoleClient.send({ type: 'updateTableMode', tableIndex: 0, mode: 1 });
  await consoleClient.waitFor((m) => m.type === 'tableModeUpdate');
  site.oscLog.length = 0;
  consoleClient.send({ type: 'switchProfile', profileId: 's1' });

  const done = await consoleClient.waitFor(isIdleOn('s1'));
  assert.equal(done.state.profileCatalog.find(({ id }) => id === 's1').seatCount, 8);
  assert.equal(done.state.tableModes[0], 0, 'the s2 seat change does not leak into s1');

  const s1Room = site.agent.rooms('s1')[0];
  const roomState = await s1Room.waitFor((m) => m.type === 'systemStateUpdate' && m.state.tableModes.length === 8);
  assert.deepEqual(roomState.state.tableModes, [0, 0, 0, 0, 0, 0, 0, 0]);
  assert.equal('groundThemeId' in roomState.state, false);

  const firstOn = site.oscLog.findIndex(({ args }) => args[0].value === 1);
  assert.ok(firstOn > 0);
  assert.ok(site.oscLog.slice(0, firstOn).every(({ args }) => args[0].value === 0), 'blackout comes first');
  assert.ok(site.oscLog.some(({ address, args }) => address === '/surfaces/Main-1/opacity' && args[0].value === 1));
  assert.equal(site.server.getState().profiles.s2.tableModes[0], 1, 's2 keeps its own seats');
});

test('a seat change in s1 reaches the s1 room at the reversed index', async (t) => {
  const site = await startAndSettle(t);
  const consoleClient = await site.connectConsole();
  consoleClient.send({ type: 'switchProfile', profileId: 's1' });
  await consoleClient.waitFor(isIdleOn('s1'));
  const s1Room = site.agent.rooms('s1')[0];

  consoleClient.send({ type: 'switchMode', mode: 8, manual: true });
  await s1Room.waitFor((m) => m.type === 'modeUpdate' && m.mode === 8);
  consoleClient.send({ type: 'updateTableMode', tableIndex: 0, mode: 1 });

  const update = await s1Room.waitFor((m) => m.type === 'tableModeUpdate');
  assert.deepEqual(update.tableModes, [0, 0, 0, 0, 0, 0, 0, 1]);
  const consoleUpdate = await consoleClient.waitFor((m) => m.type === 'tableModeUpdate');
  assert.deepEqual(consoleUpdate.tableModes, [1, 0, 0, 0, 0, 0, 0, 0, 0]);
});

test('s1 rejects seats outside split mode, lights-on and ground themes', async (t) => {
  const site = await startAndSettle(t);
  const consoleClient = await site.connectConsole();
  consoleClient.send({ type: 'switchProfile', profileId: 's1' });
  await consoleClient.waitFor(isIdleOn('s1'));
  consoleClient.send({ type: 'switchMode', mode: 2, manual: true });
  await consoleClient.waitFor((m) => m.type === 'modeUpdate' && m.mode === 2);

  consoleClient.send({ type: 'updateTableMode', tableIndex: 0, mode: 1 });
  assert.equal((await consoleClient.waitFor((m) => m.type === 'commandRejected')).reason, 'seatLocked');

  consoleClient.clear();
  consoleClient.send({ type: 'switchMode', mode: 8, manual: true });
  await consoleClient.waitFor((m) => m.type === 'modeUpdate' && m.mode === 8);
  consoleClient.send({ type: 'updateTableMode', tableIndex: 0, mode: 4 });
  assert.equal((await consoleClient.waitFor((m) => m.type === 'commandRejected')).reason, 'seatOutOfRange');

  consoleClient.clear();
  consoleClient.send({ type: 'updateTableMode', tableIndex: 8, mode: 1 });
  assert.equal((await consoleClient.waitFor((m) => m.type === 'commandRejected')).reason, 'seatOutOfRange');

  consoleClient.clear();
  consoleClient.send({ type: 'switchGroundTheme', groundThemeId: 'crops' });
  assert.equal((await consoleClient.waitFor((m) => m.type === 'commandRejected')).reason, 'groundUnsupported');
});

test('entering split mode in s1 resets its seats like the 2026-03 server did', async (t) => {
  const site = await startAndSettle(t, {
    initialState: { version: 3, activeProfile: 's2', profiles: { s1: { contentMode: 8, tableModes: [1, 2, 3, 0, 0, 0, 0, 0, 0] } } },
  });
  const consoleClient = await site.connectConsole();
  consoleClient.send({ type: 'switchProfile', profileId: 's1' });
  await consoleClient.waitFor(isIdleOn('s1'));

  consoleClient.send({ type: 'switchMode', mode: 8, manual: true });

  const update = await consoleClient.waitFor((m) => m.type === 'modeUpdate');
  assert.deepEqual(update.tableModes, [0, 0, 0, 0, 0, 0, 0, 0, 0]);
});

test('commands other than work lights are rejected while switching', async (t) => {
  const site = await startTestSite(t, { hangActivate: true });
  site.agent.isConnected = true;
  const consoleClient = await site.connectConsole();

  consoleClient.send({ type: 'switchProfile', profileId: 's1' });
  await consoleClient.waitFor((m) => m.type === 'profileSwitchUpdate' && m.switch.step === 'starting');

  for (const command of [
    { type: 'switchMode', mode: 3, manual: true },
    { type: 'updateTableMode', tableIndex: 0, mode: 1 },
    { type: 'switchGroundTheme', groundThemeId: 'crops' },
    { type: 'maskControl', maskId: 2 },
    { type: 'madmapperControl', surface: 'Main-1', enabled: true },
    { type: 'switchProfile', profileId: 's2' },
    { type: 'restartProfile' },
  ]) {
    consoleClient.clear();
    consoleClient.send(command);
    const rejected = await consoleClient.waitFor((m) => m.type === 'commandRejected');
    assert.deepEqual([rejected.command, rejected.reason], [command.type, 'switching']);
  }

  site.oscLog.length = 0;
  consoleClient.send({ type: 'madmapperControl', surface: 'Light1', enabled: true });
  await waitUntil(() => site.oscLog.length === 1);
  assert.equal(site.oscLog[0].address, '/surfaces/Light1/opacity');
  assert.equal(site.server.getState().lightStates.Light1, true);
});

test('area toggles only reach areas of the active profile', async (t) => {
  const site = await startAndSettle(t);
  const consoleClient = await site.connectConsole();
  site.oscLog.length = 0;

  consoleClient.send({ type: 'madmapperControl', surface: 'Main-1', enabled: true });
  assert.equal((await consoleClient.waitFor((m) => m.type === 'commandRejected')).reason, 'notInProfile');

  consoleClient.send({ type: 'madmapperControl', surface: 'T3', enabled: true });
  await waitUntil(() => site.oscLog.length === 1);
  assert.equal(site.oscLog[0].address, '/surfaces/T3/opacity');
  assert.equal(site.server.getState().profiles.s2.surfaceStates.T3, true);
});

test('the tracker receives the maskMode of the new profile', async (t) => {
  const site = await startAndSettle(t, {
    initialState: { version: 3, activeProfile: 's2', profiles: { s1: { maskMode: 2 }, s2: { maskMode: 1 } } },
  });
  const tracker = connectClient(t, site.url, { clientType: 'unity' });
  await tracker.opened;
  const consoleClient = await site.connectConsole();

  consoleClient.send({ type: 'switchProfile', profileId: 's1' });

  const state = await tracker.waitFor((m) => m.type === 'systemStateUpdate' && m.state.activeProfile === 's1');
  assert.equal(state.state.maskMode, 2);
});

test('maskControl stores the mask in the active profile and reaches the tracker', async (t) => {
  const site = await startAndSettle(t);
  const tracker = connectClient(t, site.url, { clientType: 'unity' });
  await tracker.opened;
  const consoleClient = await site.connectConsole();

  consoleClient.send({ type: 'maskControl', maskId: 2 });

  assert.equal((await tracker.waitFor((m) => m.type === 'maskStatusUpdate')).maskId, 2);
  assert.equal(site.server.getState().profiles.s2.maskMode, 2);
});

test('a room of the inactive build receives nothing after its hello', async (t) => {
  const site = await startAndSettle(t);
  const stray = connectClient(t, site.url, { clientType: 'room', type: 'unitySync', build: 's1', role: 'both' });
  await stray.opened;
  await waitUntil(() => site.server.getRooms().length === 3);
  stray.clear();
  const consoleClient = await site.connectConsole();

  consoleClient.send({ type: 'switchMode', mode: 3, manual: true });
  await consoleClient.waitFor((m) => m.type === 'modeUpdate');
  await new Promise((resolve) => setTimeout(resolve, 50));

  assert.deepEqual(stray.inbox.filter(({ type }) => type !== 'roomStatusUpdate'), []);
});

test('switching is refused while the agent is offline', async (t) => {
  const site = await startTestSite(t);
  const consoleClient = await site.connectConsole();

  consoleClient.send({ type: 'switchProfile', profileId: 's1' });

  assert.equal((await consoleClient.waitFor((m) => m.type === 'commandRejected')).reason, 'agentOffline');
  assert.equal(site.server.getState().activeProfile, 's2');
});

test('an unexpected Unity exit reaches the console as a room status update', async (t) => {
  const site = await startAndSettle(t);
  const consoleClient = await site.connectConsole();

  site.agent.crash(0);

  const update = await consoleClient.waitFor((m) => m.type === 'roomStatusUpdate' && m.lastExit);
  assert.equal(update.lastExit.profileId, 's2');
});

test('restarting the profile after a crash clears the exit warning', async (t) => {
  const site = await startAndSettle(t);
  const consoleClient = await site.connectConsole();
  site.agent.crash(0);
  await consoleClient.waitFor((m) => m.type === 'roomStatusUpdate' && m.lastExit);
  consoleClient.clear();

  consoleClient.send({ type: 'restartProfile' });

  const done = await consoleClient.waitFor(isIdleOn('s2'));
  assert.equal(done.state.lastExit, null);
  assert.equal(done.state.rooms.length, 2);
});

test('a restart while switching is persisted as failed', async (t) => {
  const first = await startTestSite(t, { hangActivate: true });
  first.agent.isConnected = true;
  const consoleClient = await first.connectConsole();
  consoleClient.send({ type: 'switchProfile', profileId: 's1' });
  await consoleClient.waitFor((m) => m.type === 'profileSwitchUpdate' && m.switch.step === 'starting');
  const saved = JSON.parse(fs.readFileSync(first.stateFile, 'utf8'));
  assert.equal(saved.switch.status, 'switching');

  const second = await startServer({
    wsPort: 0,
    host: '127.0.0.1',
    configs,
    stateFile: first.stateFile,
    sendOsc: () => {},
    agent: new FakeSiteAgent({ url: () => '', profiles: configs.profiles }),
    log: () => {},
  });
  t.after(() => second.close());

  assert.equal(second.getState().switch.status, 'failed');
  assert.equal(second.getState().activeProfile, 's1');
});

test('a legacy state file is migrated and saved as v3 on start', async (t) => {
  const site = await startTestSite(t, {
    initialState: { contentMode: 5, maskMode: 2, tableModes: [1, 0, 0, 0, 0, 0, 0, 0], surfaceStates: { Main: true } },
  });

  const saved = JSON.parse(fs.readFileSync(site.stateFile, 'utf8'));
  assert.equal(saved.version, 3);
  assert.equal(saved.profiles.s2.contentMode, 5);
  assert.deepEqual(saved.profiles.s2.tableModes, [1, 0, 0, 0, 0, 0, 0, 0, 0]);
  assert.ok(saved.timestamp);
});

// ---- logo -------------------------------------------------------------------

const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const PNG_DATA_URL = `data:image/png;base64,${PNG_BYTES.toString('base64')}`;

test('an uploaded logo reaches the rooms and consoles, and its settings follow', async (t) => {
  const site = await startAndSettle(t);
  const consoleClient = await site.connectConsole();
  const tables = site.agent.rooms('s2').find(({ role }) => role === 'tables');

  consoleClient.send({ type: 'logoControl', enabled: true });
  assert.equal((await consoleClient.waitFor((m) => m.type === 'commandRejected')).reason, 'noLogoImage');

  consoleClient.send({ type: 'uploadLogo', dataUrl: PNG_DATA_URL });
  const roomImage = await tables.waitFor((m) => m.type === 'logoImage');
  assert.equal(roomImage.mime, 'image/png');
  assert.deepEqual(Buffer.from(roomImage.data, 'base64'), PNG_BYTES);
  const consoleImage = await consoleClient.waitFor((m) => m.type === 'logoImage');
  assert.equal(consoleImage.imageId, roomImage.imageId);

  consoleClient.send({ type: 'logoControl', enabled: true, scale: 5, rotation: 45 });
  const update = await tables.waitFor((m) => m.type === 'logoUpdate' && m.logo.enabled);
  assert.equal(update.logo.scale, 1, 'scale is clamped');
  assert.equal(update.logo.rotation, 45);
  assert.equal(update.logo.imageId, roomImage.imageId);
  assert.ok(fs.existsSync(path.join(path.dirname(site.stateFile), 'room-logo.png')));
});

test('the logo is shared by both profiles and survives a switch', async (t) => {
  const site = await startAndSettle(t);
  const consoleClient = await site.connectConsole();
  consoleClient.send({ type: 'uploadLogo', dataUrl: PNG_DATA_URL });
  await consoleClient.waitFor((m) => m.type === 'logoImage');
  consoleClient.send({ type: 'logoControl', enabled: true, rotation: -30 });
  await consoleClient.waitFor((m) => m.type === 'logoUpdate' && m.logo.enabled);

  consoleClient.send({ type: 'switchProfile', profileId: 's1' });
  await consoleClient.waitFor(isIdleOn('s1'));

  const s1Room = site.agent.rooms('s1')[0];
  const image = await s1Room.waitFor((m) => m.type === 'logoImage');
  assert.deepEqual(Buffer.from(image.data, 'base64'), PNG_BYTES);
  const roomState = await s1Room.waitFor((m) => m.type === 'systemStateUpdate' && !('activeProfile' in m.state));
  assert.equal(roomState.state.logo.enabled, true);
  assert.equal(roomState.state.logo.rotation, -30);
});

test('the logo is restored from disk after the server restarts', async (t) => {
  const first = await startTestSite(t);
  const consoleClient = await first.connectConsole();
  consoleClient.send({ type: 'uploadLogo', dataUrl: PNG_DATA_URL });
  await consoleClient.waitFor((m) => m.type === 'logoImage');
  consoleClient.send({ type: 'logoControl', enabled: true, x: 0.8 });
  await consoleClient.waitFor((m) => m.type === 'logoUpdate' && m.logo.enabled);
  const savedState = JSON.parse(fs.readFileSync(first.stateFile, 'utf8'));
  const savedImage = fs.readFileSync(path.join(path.dirname(first.stateFile), 'room-logo.png'));

  const restored = await startTestSite(t, { initialState: savedState, files: { 'room-logo.png': savedImage } });
  assert.equal(restored.server.getState().logo.enabled, true);
  assert.equal(restored.server.getState().logo.x, 0.8);
  const room = connectClient(t, restored.url, { clientType: 'room', type: 'unitySync', build: 's2', role: 'tables' });
  const image = await room.waitFor((m) => m.type === 'logoImage');
  assert.deepEqual(Buffer.from(image.data, 'base64'), PNG_BYTES);

  // 狀態檔有 imageId 但旁邊沒有圖：Logo 清掉並關閉，不留一個 Unity 拿不到圖的開啟狀態。
  const missing = await startTestSite(t, { initialState: savedState });
  assert.equal(missing.server.getState().logo.enabled, false);
  assert.equal(missing.server.getState().logo.imageId, null);
});

test('removing the logo turns it off and deletes the file', async (t) => {
  const site = await startTestSite(t);
  const consoleClient = await site.connectConsole();
  consoleClient.send({ type: 'uploadLogo', dataUrl: PNG_DATA_URL });
  await consoleClient.waitFor((m) => m.type === 'logoImage');
  consoleClient.send({ type: 'logoControl', enabled: true });
  await consoleClient.waitFor((m) => m.type === 'logoUpdate' && m.logo.enabled);

  consoleClient.send({ type: 'removeLogo' });
  const update = await consoleClient.waitFor((m) => m.type === 'logoUpdate' && m.logo.imageId === null);
  assert.equal(update.logo.enabled, false);
  assert.equal(fs.existsSync(path.join(path.dirname(site.stateFile), 'room-logo.png')), false);
});
