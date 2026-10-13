'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { RoomPresence } = require('../room-presence');

function createPresence() {
  const clock = { value: 0 };
  const presence = new RoomPresence({ now: () => clock.value });
  return { presence, clock };
}

test('waitFor resolves once every role of the build has registered after since', async () => {
  const { presence, clock } = createPresence();
  const pending = presence.waitFor('s2', ['tables', 'ground'], { since: 100, timeoutMs: 1000 });

  clock.value = 150;
  presence.register('a', { build: 's2', role: 'ground' });
  clock.value = 160;
  presence.register('b', { build: 's2', role: 'tables' });

  await pending;
});

test('waitFor resolves immediately when the rooms are already there', async () => {
  const { presence, clock } = createPresence();
  clock.value = 10;
  presence.register('a', { build: 's1', role: 'both' });

  await presence.waitFor('s1', ['both'], { since: 5, timeoutMs: 1000 });
});

// 重新啟動同一個方案時，舊連線還沒斷，不可以讓等待提早結束。
test('waitFor ignores rooms that registered before since', async () => {
  const { presence, clock } = createPresence();
  clock.value = 50;
  presence.register('old', { build: 's2', role: 'tables' });
  presence.register('old-ground', { build: 's2', role: 'ground' });

  let settled = false;
  const pending = presence.waitFor('s2', ['tables', 'ground'], { since: 100, timeoutMs: 1000 })
    .then(() => { settled = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false);

  clock.value = 120;
  presence.register('new-tables', { build: 's2', role: 'tables' });
  presence.register('new-ground', { build: 's2', role: 'ground' });
  await pending;
  assert.equal(settled, true);
});

test('waitFor ignores rooms of another build', async () => {
  const { presence, clock } = createPresence();
  clock.value = 10;
  presence.register('a', { build: 's2', role: 'both' });

  await assert.rejects(
    presence.waitFor('s1', ['both'], { since: 0, timeoutMs: 20 }),
    /s1.*both/,
  );
});

test('waitFor rejects with the missing roles on timeout', async () => {
  const { presence, clock } = createPresence();
  clock.value = 10;
  presence.register('a', { build: 's2', role: 'tables' });

  await assert.rejects(
    presence.waitFor('s2', ['tables', 'ground'], { since: 0, timeoutMs: 20 }),
    (error) => /s2/.test(error.message) && /ground/.test(error.message) && !/tables,/.test(error.message),
  );
});

test('unregister removes the room from list() and emits change', () => {
  const { presence } = createPresence();
  const changes = [];
  presence.on('change', () => changes.push(presence.list().length));

  presence.register('a', { build: 's1', role: 'both' });
  presence.unregister('a');
  presence.unregister('a');

  assert.deepEqual(presence.list(), []);
  assert.deepEqual(changes, [1, 0]);
});

test('registering the same connection again replaces its build and role', () => {
  const { presence } = createPresence();
  presence.register('a', { build: 's1', role: 'both' });
  presence.register('a', { build: 's2', role: 'tables' });

  assert.deepEqual(presence.list().map(({ build, role }) => ({ build, role })), [{ build: 's2', role: 'tables' }]);
});
