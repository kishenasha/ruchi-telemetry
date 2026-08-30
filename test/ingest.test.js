// The ingest validator is this service's privacy boundary: it decides what is
// allowed to be stored at all. These pin that it reads a fixed set of known
// fields and silently drops everything else, so a field that should never
// reach telemetry cannot arrive by being added upstream.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { readRecord, sameSecret } from '../src/index.js';

const valid = () => ({
  request_id: 'abc123',
  timestamp: 1788100000,
  feature_id: 'smart_import',
  plan: 'pro',
  user_hash: 'a'.repeat(64),
  input_tokens: 1200,
  output_tokens: 800,
  cost_usd_micros: 4200,
  cost_known: true,
  latency_ms: 5300,
  status: 'ok',
});

test('a well formed record is read into the columns the table holds', () => {
  const record = readRecord(valid());
  assert.equal(record.featureId, 'smart_import');
  assert.equal(record.plan, 'pro');
  assert.equal(record.userHash, 'a'.repeat(64));
  assert.equal(record.costMicros, 4200);
  assert.equal(record.costKnown, 1);
  assert.equal(record.errored, 0);
  assert.equal(record.day, '2026-08-30');
});

test('content that must never be stored is dropped rather than carried through', () => {
  const record = readRecord({
    ...valid(),
    prompt: 'You are Smart Import...',
    recipe_html: '<html>...</html>',
    app_user_id: 'the raw RevenueCat id',
    pantry: ['onion', 'garlic'],
  });
  const stored = JSON.stringify(record);
  for (const leak of ['Smart Import', 'html', 'RevenueCat', 'onion']) {
    assert.ok(!stored.includes(leak), `${leak} reached the stored record`);
  }
});

test('a raw identifier in user_hash is refused, not stored', () => {
  assert.equal(readRecord({ ...valid(), user_hash: '$RCAnonymousID:abc' }), null);
});

test('a missing identity still counts, under a name no real hash can collide with', () => {
  const record = readRecord({ ...valid(), user_hash: null });
  assert.equal(record.userHash, 'anonymous');
});

test('feature_id and plan must be plain slugs, since both become grouped keys', () => {
  assert.equal(readRecord({ ...valid(), feature_id: 'DROP TABLE usage_daily' }), null);
  assert.equal(readRecord({ ...valid(), plan: '../../etc' }), null);
});

test('an unknown cost adds nothing to spend rather than reading as zero spend', () => {
  const record = readRecord({ ...valid(), cost_known: false, cost_usd_micros: 4200 });
  assert.equal(record.costMicros, 0);
  assert.equal(record.costKnown, 0);
});

test('a failed call is counted as an error, and still counted as a call', () => {
  assert.equal(readRecord({ ...valid(), status: 'error' }).errored, 1);
});

test('a negative or absurd token count never becomes a negative total', () => {
  const record = readRecord({ ...valid(), input_tokens: -500, latency_ms: 'soon' });
  assert.equal(record.inputTokens, 0);
  assert.equal(record.latencyMs, 0);
});

test('the record decides its own day, so a call near midnight lands where it happened', () => {
  // 1788134400 is 2026-08-31T00:00:00Z exactly.
  assert.equal(readRecord({ ...valid(), timestamp: 1788134399 }).day, '2026-08-30');
  assert.equal(readRecord({ ...valid(), timestamp: 1788134400 }).day, '2026-08-31');
});

test('garbage is refused outright', () => {
  assert.equal(readRecord(null), null);
  assert.equal(readRecord('a string'), null);
  assert.equal(readRecord({}), null);
});

test('secret comparison accepts only an exact match, including length', () => {
  assert.ok(sameSecret('correct-horse', 'correct-horse'));
  assert.ok(!sameSecret('correct-horse', 'correct-horsey'));
  assert.ok(!sameSecret('', 'correct-horse'));
  assert.ok(!sameSecret(undefined, 'correct-horse'));
});
