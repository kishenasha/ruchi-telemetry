// Separate repos kept in step by hand, so the vocabularies are compared here.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  MODELS, RECORD_PREFIXES, RECORD_TABLES, RETIRED, TIERS, TRIAL_CLOCK,
  adjustCooks, hasOverrides, readCooks, saveSetting,
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

test('the trial dial writes the key the server reads', () => {
  assert.deepEqual(TRIAL_CLOCK.map((d) => d.key), ['trial:hours']);
  assert.deepEqual(TRIAL_CLOCK.map((d) => d.max), [24]);
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

/** `keys` answers each prefix scan in one page; `pages` replays a fixed sequence. */
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
  env.answer = (records) => {
    globalThis.fetch = async (_url, options) => {
      const commands = JSON.parse(options.body);
      env.sent.push(commands);
      return {
        ok: reachable,
        json: async () => commands.map(([, k]) => ({ result: records[k] ?? null })),
      };
    };
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

test('a scan that pages is followed to the end', async () => {
  const env = fakeEnv({ pages: [['12', ['use:a']], ['0', ['use:b']]] });
  assert.equal(await saveSetting(env, form({ records: '1' })), null);

  const removed = env.sent.flat().filter(([verb]) => verb === 'DEL').map(([, key]) => key);
  assert.ok(removed.includes('use:a') && removed.includes('use:b'));
});

test('a scan that never finishes gives up rather than spinning', async () => {
  const env = fakeEnv({ pages: [['7', ['use:a']]] });
  const failure = await saveSetting(env, form({ records: '1' }));
  assert.equal(failure, null);
  assert.ok(env.sent.flat().filter(([verb]) => verb === 'SCAN').length < 2000);
});

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

// -- one cook's own settings ------------------------------------------------

const HASH = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90';
const OTHER = 'f'.repeat(64);

const adjustment = (fields) => form({ ...fields });

test('an allowance left empty falls back to the membership rather than being set', async () => {
  const env = fakeEnv();
  assert.equal(await adjustCooks(env, [HASH], adjustment({
    max_smart_import: '', period_smart_import: 'day', max_text_import: '4', period_text_import: 'day',
  })), null);

  const written = JSON.parse(env.sent.at(-1)[0][2]);
  assert.deepEqual(written.limits, { text_import: '4:day' });
});

// Zero is how one cook is stopped from importing without being turned away
// outright, so it has to survive being written.
test('an allowance of zero is a real answer', async () => {
  const env = fakeEnv();
  await adjustCooks(env, [HASH], adjustment({ max_image_import: '0', period_image_import: 'month' }));
  assert.deepEqual(JSON.parse(env.sent.at(-1)[0][2]).limits, { image_import: '0:month' });
});

test('the same adjustment is written for every cook chosen', async () => {
  const env = fakeEnv();
  await adjustCooks(env, [HASH, OTHER, HASH], adjustment({ blocked: 'on' }));

  const commands = env.sent.at(-1);
  assert.deepEqual(commands.map(([verb, key]) => [verb, key]), [
    ['SET', `cook:${HASH}`], ['SET', `cook:${OTHER}`],
  ]);
  assert.equal(JSON.parse(commands[0][2]).blocked, true);
});

test('a number or a model that is not one is refused before anything is written', async () => {
  for (const bad of [
    { max_smart_import: '-1', period_smart_import: 'day' },
    { max_smart_import: '2.5', period_smart_import: 'day' },
    { max_smart_import: '5', period_smart_import: 'fortnight' },
    { model_smart_import: 'not a model' },
  ]) {
    const env = fakeEnv();
    assert.notEqual(await adjustCooks(env, [HASH], adjustment(bad)), null, JSON.stringify(bad));
    assert.equal(env.sent.length, 0);
  }
});

test('clearing removes the record rather than writing an empty one', async () => {
  const env = fakeEnv();
  assert.equal(await adjustCooks(env, [HASH], adjustment({ clear: '1' })), null);
  assert.deepEqual(env.sent.at(-1), [['DEL', `cook:${HASH}`]]);
});

test('starting a trial again forgets only when it began', async () => {
  const env = fakeEnv();
  assert.equal(await adjustCooks(env, [HASH], adjustment({ reset: '1' })), null);
  assert.deepEqual(env.sent.at(-1), [['DEL', `trial:start:${HASH}`]]);
});

test('nobody chosen is refused rather than written to everyone', async () => {
  const env = fakeEnv();
  assert.match(await adjustCooks(env, [], adjustment({ blocked: 'on' })), /nobody/);
  assert.equal(env.sent.length, 0);
});

test('a record is read back per cook, and junk is nobody having set anything', async () => {
  const env = fakeEnv();
  env.answer({ [`cook:${HASH}`]: '{"blocked":true}', [`cook:${OTHER}`]: 'not json' });
  const found = await readCooks(env, [HASH, OTHER]);
  assert.equal(found.get(HASH).blocked, true);
  assert.equal(found.has(OTHER), false);
});

// A cook is marked as adjusted on the list, so an empty record left behind must
// not read as one, or the mark would mean nothing.
test('an empty record is not an adjustment', () => {
  assert.equal(hasOverrides(undefined), false);
  assert.equal(hasOverrides({ limits: {}, models: {} }), false);
  assert.equal(hasOverrides({ limits: { smart_import: '1:day' } }), true);
  assert.equal(hasOverrides({ blocked: true }), true);
});
