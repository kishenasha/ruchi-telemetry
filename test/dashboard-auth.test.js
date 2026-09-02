// The dashboard's password is the only thing standing in front of the
// controls that decide what an AI call costs, and a browser resends it on
// every request. These pin the lockout that keeps it from being guessed at
// forever, and the fail-open posture that keeps the lockout from becoming a
// way to lock Kishen out.

import assert from 'node:assert/strict';
import test from 'node:test';

import worker from '../src/index.js';

const PASSWORD = 'a-long-random-password';

function env(overrides = {}) {
  return {
    DASHBOARD_PASSWORD: PASSWORD,
    UPSTASH_URL: 'https://upstash.test',
    UPSTASH_TOKEN: 'token',
    ...overrides,
  };
}

/** A stand-in Upstash that counts in memory, so no test touches the network. */
function fakeRedis() {
  const store = new Map();
  const calls = [];
  globalThis.fetch = async (_url, init) => {
    const [[command, key, value]] = JSON.parse(init.body);
    calls.push(command);
    if (command === 'INCR') store.set(key, (store.get(key) ?? 0) + 1);
    if (command === 'DEL') store.delete(key);
    const result = command === 'GET' ? store.get(key) ?? null : store.get(key) ?? 1;
    return { ok: true, json: async () => [{ result }] };
  };
  return { store, calls };
}

// An authenticated path that needs no database, so these test the gate
// rather than the page behind it. Getting through reads as 404, not 200.
const ask = (password, ip = '203.0.113.7') => worker.fetch(
  new Request('https://telemetry.test/nothing-here', {
    headers: {
      ...(password === null ? {} : { authorization: `Basic ${btoa(`x:${password}`)}` }),
      'cf-connecting-ip': ip,
    },
  }),
  env(),
);

test('the right password gets in', async () => {
  fakeRedis();
  assert.equal((await ask(PASSWORD)).status, 404);
});

test('five wrong tries, then the sixth is refused rather than checked', async () => {
  fakeRedis();
  for (let i = 0; i < 5; i += 1) {
    assert.equal((await ask('wrong')).status, 401, `try ${i + 1}`);
  }
  assert.equal((await ask('wrong')).status, 429);
  // And the right password is refused too, or the lockout would be pointless.
  assert.equal((await ask(PASSWORD)).status, 429);
});

test('one address locking itself out does not lock anyone else out', async () => {
  fakeRedis();
  for (let i = 0; i < 6; i += 1) await ask('wrong', '198.51.100.1');
  assert.equal((await ask(PASSWORD, '203.0.113.9')).status, 404);
});

test('getting it right clears the count', async () => {
  const { store } = fakeRedis();
  await ask('wrong');
  await ask(PASSWORD);
  assert.equal(store.size, 0);
});

test('a first visit with no password at all is not held against anyone', async () => {
  const { calls } = fakeRedis();
  assert.equal((await ask(null)).status, 401);
  assert.ok(!calls.includes('INCR'));
});

test('an unreachable counter never locks the dashboard', async () => {
  globalThis.fetch = async () => { throw new Error('upstash is down'); };
  assert.equal((await ask(PASSWORD)).status, 404);
  // And a wrong password is still a wrong password.
  assert.equal((await ask('wrong')).status, 401);
});
