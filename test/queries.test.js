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

// A cook reads the name out of the app and it is typed in here, so the search
// has to accept one. A name is derived from the hash rather than stored, which
// is why it cannot be a LIKE and has to be resolved first.
test('a code is matched as a prefix of the hash', async () => {
  const { env, seen } = recorder();
  await cooks(env, { days: 30, search: 'a1b2c3' });
  const query = seen.find((q) => q.sql.includes('user_hash LIKE'));
  assert.ok(query, 'a hex search should still be a prefix match');
  assert.ok(query.binds.includes('a1b2c3%'));
});

test('a name is resolved to the hashes that carry it', async () => {
  const hash = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90';
  const seen = [];
  const env = {
    DB: {
      prepare: (sql) => ({
        bind: (...binds) => {
          seen.push({ sql, binds });
          return {
            first: async () => null,
            all: async () => ({
              results: sql.includes('GROUP BY user_hash LIMIT')
                ? [{ name: hash }, { name: 'f'.repeat(64) }]
                : [],
            }),
          };
        },
      }),
    },
  };

  await cooks(env, { days: 30, search: 'mellow-quail-70' });
  const query = seen.find((q) => q.sql.includes('user_hash IN'));
  assert.ok(query, 'a name should be turned into the hashes it belongs to');
  assert.deepEqual(query.binds.slice(0, 1), [hash]);
});

test('a name nobody has asks the database for nothing further', async () => {
  const { env, seen } = recorder();
  const { rows, more } = await cooks(env, { days: 30, search: 'warm-wren-01' });
  assert.deepEqual(rows, []);
  assert.equal(more, false);
  assert.equal(seen.filter((q) => q.sql.includes('user_hash IN')).length, 0);
});
