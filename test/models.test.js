// The model setting decides which model every import runs on, so it decides
// what an import costs. A value that reaches Upstash unchecked would be sent
// to OpenRouter as-is, so the shape is refused here as well as server side.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { MODEL_ID } from '../src/index.js';

test('the models actually shipped are accepted', () => {
  for (const id of ['google/gemini-2.5-flash-lite', 'openai/gpt-5.6-luna']) {
    assert.ok(MODEL_ID.test(id), id);
  }
});

test('a variant tag is part of a model id', () => {
  assert.ok(MODEL_ID.test('z-ai/glm-5.2:free'));
});

test('anything that is not a vendor/model is refused', () => {
  for (const bad of [
    '', 'no-slash', '/leading', 'trailing/', 'UPPER/CASE',
    'two//slashes', 'has space/model', 'vendor/model extra',
  ]) {
    assert.equal(MODEL_ID.test(bad), false, bad);
  }
});

test('a value that would break out of the Redis key is refused', () => {
  // The saved value becomes model:<plan> in Upstash and is sent to OpenRouter.
  for (const bad of ['openai/luna\nSET evil 1', 'openai/luna"', "openai/luna'"]) {
    assert.equal(MODEL_ID.test(bad), false, bad);
  }
});
