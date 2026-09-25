import { test } from 'node:test';
import assert from 'node:assert/strict';
import { slug } from '../web/runtime/slug.js';

test('lowercases and hyphenates', () => {
  assert.equal(slug('Reflections on COP30'), 'reflections-on-cop30');
});

test('collapses runs of punctuation into one hyphen', () => {
  assert.equal(slug('The Future -- of Meat!'), 'the-future-of-meat');
});

test('trims leading and trailing hyphens', () => {
  assert.equal(slug('  "Unlocking" the Future  '), 'unlocking-the-future');
});
