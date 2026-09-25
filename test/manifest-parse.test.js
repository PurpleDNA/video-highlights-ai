import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readCaption } from '../web/runtime/manifest-parse.js';

const MD = `# Why yields matter

**Speaker:** Taylor Quinn
**01:00:41–01:04:11** · Clearest explanation in the session

The caption body goes here.
`;

const LEGACY = `# Old title
# 00:39:44-00:41:07
# some rationale

Legacy body.
`;

test('parses the markdown caption', () => {
  const c = readCaption(MD);
  assert.equal(c.title, 'Why yields matter');
  assert.equal(c.speaker, 'Taylor Quinn');
  assert.equal(c.start, '01:00:41');
  assert.equal(c.end, '01:04:11');
  assert.equal(c.rationale, 'Clearest explanation in the session');
  assert.equal(c.body.trim(), 'The caption body goes here.');
});

test('parses the pre-markdown caption', () => {
  const c = readCaption(LEGACY);
  assert.equal(c.title, 'Old title');
  assert.equal(c.start, '00:39:44');
  assert.equal(c.rationale, 'some rationale');
  assert.equal(c.body.trim(), 'Legacy body.');
});

test('an unparseable caption yields nulls, never a throw', () => {
  const c = readCaption('just some text with no header at all');
  assert.equal(c.title, null);
  assert.equal(c.start, null);
  assert.equal(c.body, 'just some text with no header at all');
});
