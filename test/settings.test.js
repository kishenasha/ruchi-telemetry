// The dashboard and ruchi-ai have to name the same memberships, features and
// keys. They are separate repos kept in step by hand, and when they went out of
// step the free tier's rows were still being offered for a plan the server had
// stopped having.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  MODELS, RECORD_PREFIXES, RECORD_TABLES, RETIRED, TIERS, TRIAL_CLOCK, saveSetting,
} from '../src/settings.js';

// server/lib/quota.py's PLANS.
const PLANS = ['trial', 'pro'];
// server/lib/quota.py's DEFAULT_LIMITS and models.py's DEFAULT_MODELS.
const FEATURES = ['smart_import', 'text_import', 'image_import'];

test('the only memberships offered are the ones the server has', () => {
  for (const row of [...TIERS, ...MODELS]) {
    assert.ok(PLANS.includes(row.plan), `${row.feature} offers plan ${row.plan}`);
    assert.ok(FEATURES.includes(row.feature), `${row.feature} is not a feature any more`);
  }
});

test('every combination the server can ask about has a row, and no row is spare', () => {
  const wanted = FEATURES.flatMap((f) => PLANS.map((p) => `${f}:${p}`)).sort();
  assert.deepEqual(TIERS.map((t) => `${t.feature}:${t.plan}`).sort(), wanted);
  assert.deepEqual(MODELS.map((m) => `${m.feature}:${m.plan}`).sort(), wanted);
});

// The shipped defaults are the fallback when a key is missing, so a dashboard
// showing a different number would be describing a state nothing is in.
test('the numbers shown match what the server ships', () => {
  const shipped = {
    'smart_import:trial': [40, 'day'],
    'text_import:trial': [20, 'day'],
    'image_import:trial': [15, 'day'],
    'smart_import:pro': [6000, 'month'],
    'text_import:pro': [6000, 'month'],
    'image_import:pro': [6000, 'month'],
  };
  for (const t of TIERS) {
    assert.deepEqual([t.max, t.period], shipped[`${t.feature}:${t.plan}`], `${t.feature}:${t.plan}`);
  }
});

test('the trial dials write the keys the server reads', () => {
  assert.deepEqual(TRIAL_CLOCK.map((d) => d.key), ['trial:hours', 'trial:warn_hours']);
  assert.deepEqual(TRIAL_CLOCK.map((d) => d.max), [24, 6]);
});

test('nothing retired is still on offer', () => {
  const offered = [...TIERS, ...MODELS];
  for (const feature of RETIRED.features) {
    assert.equal(offered.some((r) => r.feature === feature), false, feature);
  }
  for (const plan of RETIRED.plans) {
    assert.equal(offered.some((r) => r.plan === plan), false, plan);
  }
});

// Zero is how trials are switched off, and how the warning is silenced. Every
// other allowance on the page refuses it, so this one is worth pinning.
test('a trial of no hours at all is a real answer', async () => {
  const env = fakeEnv();
  assert.equal(await saveSetting(env, form({ trial: 'hours', max: '0' })), null);
  assert.deepEqual(env.sent.at(-1), [['SET', 'trial:hours', '0']]);
});

test('an hour count that is not one is refused before it is pushed', async () => {
  const env = fakeEnv();
  for (const bad of ['-1', '2.5', 'soon', '99999']) {
    assert.notEqual(await saveSetting(env, form({ trial: 'hours', max: bad })), null, bad);
  }
  assert.equal(env.sent.length, 0);
});

test('a dial the page does not have cannot be written', async () => {
  const env = fakeEnv();
  assert.notEqual(await saveSetting(env, form({ trial: 'made_up', max: '5' })), null);
  assert.equal(env.sent.length, 0);
});

// Deleting rather than writing defaults: ruchi-ai then reads nothing and falls
// back to its own shipped values, so one number lives in one place.
test('a reset clears every key, live and retired, and stores nothing in their place', async () => {
  const env = fakeEnv();
  assert.equal(await saveSetting(env, form({ reset: '1' })), null);

  const commands = env.sent.at(-1);
  assert.ok(commands.every(([verb]) => verb === 'DEL'), 'a reset only ever deletes');
  const cleared = commands.map(([, key]) => key);
  for (const key of RETIRED.keys) assert.ok(cleared.includes(key), key);
  for (const t of TIERS) assert.ok(cleared.includes(`limit:${t.feature}:${t.plan}`));
  for (const m of MODELS) assert.ok(cleared.includes(`model:${m.feature}:${m.plan}`));
  for (const d of TRIAL_CLOCK) assert.ok(cleared.includes(d.key));
  assert.ok(cleared.includes('limit:burst'));
  assert.equal(new Set(cleared).size, cleared.length, 'no key is deleted twice');

  assert.deepEqual(env.ran, ['DELETE FROM limits', 'DELETE FROM models']);
});

test('a reset that cannot reach the store says so rather than claiming success', async () => {
  const env = fakeEnv({ reachable: false });
  assert.match(await saveSetting(env, form({ reset: '1' })), /could not be reached/);
});

function form(fields) {
  const data = new Map(Object.entries(fields).map(([k, v]) => [k, v]));
  return { get: (key) => (data.has(key) ? data.get(key) : null) };
}

/**
 * `keys` answers a scan of each prefix in one page. `pages` answers every scan
 * with the same fixed sequence, for testing paging and a cursor that never
 * comes home.
 */
function fakeEnv({ reachable = true, keys = null, pages = null } = {}) {
  const env = {
    UPSTASH_URL: 'https://upstash.test',
    UPSTASH_TOKEN: 'token',
    sent: [],
    ran: [],
  };
  let page = 0;
  globalThis.fetch = async (_url, options) => {
    const commands = JSON.parse(options.body);
    env.sent.push(commands);
    if (!reachable) return { ok: false };
    const scan = commands[0][0] === 'SCAN' ? commands[0] : null;
    if (!scan) return { ok: true };
    if (pages) {
      const answer = pages[Math.min(page, pages.length - 1)];
      page += 1;
      return { ok: true, json: async () => [{ result: answer }] };
    }
    const prefix = String(scan[3]).replace(/\*$/, '');
    return { ok: true, json: async () => [{ result: ['0', keys?.[prefix] ?? []] }] };
  };
  env.DB = {
    prepare(sql) {
      const statement = {
        bind: () => statement,
        run: async () => { env.ran.push(sql.trim()); },
        all: async () => ({ results: [] }),
        first: async () => null,
      };
      return statement;
    },
  };
  return env;
}

// -- forgetting the records -------------------------------------------------

test('every counter the servers keep is scanned for, trial starts included', async () => {
  const env = fakeEnv({ keys: {} });
  assert.equal(await saveSetting(env, form({ records: '1' })), null);

  const scanned = env.sent.flat().filter(([verb]) => verb === 'SCAN').map((c) => c[3]);
  assert.deepEqual(scanned, RECORD_PREFIXES.map((p) => `${p}*`));
  assert.ok(RECORD_PREFIXES.includes('trial:start:'), 'a spent trial has to be forgettable');
});

test('what the scan finds is what gets removed, once each', async () => {
  const env = fakeEnv({
    keys: {
      'use:': ['use:smart_import:trial:2026-09-05:abc'],
      'ai:req:': ['ai:req:user:abc:2026-09-05'],
      'trial:start:': ['trial:start:dev1', 'trial:start:dev2'],
    },
  });
  assert.equal(await saveSetting(env, form({ records: '1' })), null);

  const removed = env.sent.flat().filter(([verb]) => verb === 'DEL').map(([, key]) => key);
  assert.deepEqual(removed.sort(), [
    'ai:req:user:abc:2026-09-05', 'trial:start:dev1', 'trial:start:dev2',
    'use:smart_import:trial:2026-09-05:abc',
  ]);
  assert.deepEqual(env.ran, RECORD_TABLES.map((t) => `DELETE FROM ${t}`));
});

// A scan comes back a page at a time, and stopping at the first page would
// leave counters behind that nothing on the dashboard would show.
test('a scan that pages is followed to the end', async () => {
  const env = fakeEnv({ pages: [['12', ['use:a']], ['0', ['use:b']]] });
  assert.equal(await saveSetting(env, form({ records: '1' })), null);

  const removed = env.sent.flat().filter(([verb]) => verb === 'DEL').map(([, key]) => key);
  assert.ok(removed.includes('use:a') && removed.includes('use:b'));
});

// A cursor that never returns to zero would otherwise spin until the worker is
// killed, which reads to the person waiting as the page having hung.
test('a scan that never finishes gives up rather than spinning', async () => {
  const env = fakeEnv({ pages: [['7', ['use:a']]] });
  const failure = await saveSetting(env, form({ records: '1' }));
  assert.equal(failure, null);
  assert.ok(env.sent.flat().filter(([verb]) => verb === 'SCAN').length < 2000);
});

// Half cleared is the worst outcome: a test then starts from a state nobody
// can describe, and the numbers on the page cannot be trusted either.
test('a store that cannot be read clears nothing and says so', async () => {
  const env = fakeEnv({ reachable: false });
  assert.match(await saveSetting(env, form({ records: '1' })), /nothing was cleared/);
  assert.deepEqual(env.ran, []);
});

test('forgetting the records leaves the settings alone', async () => {
  const env = fakeEnv({ keys: { 'use:': ['use:x'] } });
  await saveSetting(env, form({ records: '1' }));

  const touched = env.sent.flat().map(([, key]) => key);
  assert.equal(touched.some((k) => String(k).startsWith('limit:')), false);
  assert.equal(touched.some((k) => String(k).startsWith('model:')), false);
  assert.equal(touched.includes('trial:hours'), false);
  assert.equal(env.ran.includes('DELETE FROM limits'), false);
});
