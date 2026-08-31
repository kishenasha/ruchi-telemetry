// Every filtered read builds its WHERE in one place and its values in
// another. When those two drifted, D1 bound the day bounds to the user hash
// and the query answered nothing at all rather than failing, so a cook's own
// page looked like a cook who had never imported. These pin the alignment.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { cook, cooks } from '../src/queries.js';

function recorder() {
  const seen = [];
  const result = { first: async () => null, all: async () => ({ results: [] }) };
  const env = {
    DB: {
      prepare: (sql) => ({
        bind: (...binds) => {
          seen.push({ sql, binds });
          return result;
        },
      }),
    },
  };
  return { env, seen };
}

// Every ? in the statement, in the order D1 will fill them.
function placeholders(sql) {
  return sql.split('?').slice(0, -1).map((part) => (
    part.match(/(\w+)\s*(?:=|>=|<=|LIKE)\s*$/i)?.[1] ?? part.trim().slice(-20)
  ));
}

test('a filtered read binds its values in the order its clauses ask for them', async () => {
  const { env, seen } = recorder();
  await cooks(env, { days: 30, plan: 'pro', search: 'abc' });

  const [{ sql, binds }] = seen;
  assert.deepEqual(placeholders(sql), ['plan', 'user_hash', 'day', 'day']);
  assert.equal(binds[0], 'pro');
  assert.equal(binds[1], 'abc%');
  assert.match(binds[2], /^\d{4}-\d{2}-\d{2}$/);
  assert.match(binds[3], /^\d{4}-\d{2}-\d{2}$/);
});

test('one cook is looked up by their own hash, not by a day that landed there', async () => {
  const hash = 'a'.repeat(64);
  const { env, seen } = recorder();
  await cook(env, hash, 30);

  assert.equal(seen.length, 3);
  for (const { sql, binds } of seen) {
    assert.deepEqual(placeholders(sql), ['user_hash', 'day', 'day'], sql);
    assert.equal(binds[0], hash);
  }
});

test('all time asks for no day bounds at all', async () => {
  const hash = 'b'.repeat(64);
  const { env, seen } = recorder();
  await cook(env, hash, null);

  for (const { sql, binds } of seen) {
    assert.deepEqual(binds, [hash]);
    assert.ok(!sql.includes('day >='), sql);
  }
});
