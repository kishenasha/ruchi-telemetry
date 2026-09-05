// The one place a cook's own typing reaches this service. The list is
// bounded, deduplicated and lowercased here, not trusted from the client:
// this is the actual privacy boundary for plan/14 section 14.4, and the app
// sending well-formed data is not a substitute for it being checked again.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { validNames } from '../src/index.js';

test('names are trimmed, lowercased and deduplicated', () => {
  assert.deepEqual(validNames([' Elaichi ', 'elaichi', 'Toor Dal']), ['elaichi', 'toor dal']);
});

test('anything that is not a short real string is dropped', () => {
  const long = 'x'.repeat(81);
  assert.deepEqual(validNames(['', '   ', long, 42, null, { toString: () => 'x' }]), []);
});

test('the list is capped rather than growing without bound', () => {
  const many = Array.from({ length: 50 }, (_, i) => `ingredient-${i}`);
  assert.equal(validNames(many).length, 20);
});
