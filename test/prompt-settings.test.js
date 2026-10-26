import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_PROMPTS, PROMPT_FIELDS, fill, validatePrompt, resolvePrompts, customizedKeys,
  buildPrompts, CLIPS_SCHEMA,
} from '../web/runtime/prompts.js';

test('every field has a default, and every default is valid', () => {
  for (const f of PROMPT_FIELDS) {
    assert.ok(DEFAULT_PROMPTS[f.key], `no default for ${f.key}`);
    assert.deepEqual(validatePrompt(f.key, DEFAULT_PROMPTS[f.key]), [], f.key);
  }
});

test('fill swaps every occurrence of a slot', () => {
  assert.equal(fill('{{a}} and {{a}} then {{b}}', { a: 'x', b: 'y' }), 'x and x then y');
});

test('a prompt missing a required slot is refused, naming the slot', () => {
  const problems = validatePrompt('caption', 'Write a caption titled "{{title}}".');
  assert.equal(problems.length, 1);
  assert.match(problems[0], /\{\{clip_transcript\}\}/);
});

test('a misspelt slot is refused rather than sent to the model literally', () => {
  const problems = validatePrompt('caption', '{{title}} {{clip_transcript}} {{titel}}');
  assert.match(problems.join(' '), /\{\{titel\}\}/);
});

test('an empty prompt is refused', () => {
  assert.equal(validatePrompt('onePager', '   ').length, 1);
});

test('saved edits override defaults; invalid or unknown ones fall back', () => {
  const p = resolvePrompts({
    onePager: 'Write it short.',
    caption: 'no slots at all',  // invalid — must not reach a run
    bogusKey: 'ignored',
  });
  assert.equal(p.onePager, 'Write it short.');
  assert.equal(p.caption, DEFAULT_PROMPTS.caption);
  assert.equal('bogusKey' in p, false);
  assert.deepEqual(customizedKeys(p), ['onePager']);
});

test('defaults reproduce the built-in prompts', () => {
  const b = buildPrompts(DEFAULT_PROMPTS);
  assert.match(b.preamble, /^You are an editorial assistant for the Global Forum/);
  assert.match(b.preamble, /Never invent facts/);
  assert.match(b.onePager, /Return only the summary text\.$/);
  assert.match(b.captionUser({ title: 'T', slice: 'S' }), /titled "T"[\s\S]*---\nS\n---/);
});

test('locked rules survive any edit to the editable part', () => {
  const b = buildPrompts(resolvePrompts({
    preamble: 'We are a cooking club.',
    clipGuidance: '- Only pick jokes.',
    onePager: 'Bullet points please.',
  }));
  assert.match(b.preamble, /^We are a cooking club\./);
  assert.match(b.preamble, /Never invent facts/);
  const clips = b.clips({ highlights: 4, perPanelist: 3, speakerLabels: true });
  assert.match(clips, /- Only pick jokes\./);
  assert.match(clips, /"HH:MM:SS"/);
  assert.match(clips, /at most 3 of their strongest moments/);
  assert.match(clips, /Mark the 4 strongest moments/);
  assert.match(clips, /Speaker labels:/);
  assert.match(b.onePager, /^Bullet points please\.[\s\S]*Return only the summary text\.$/);
  assert.ok(CLIPS_SCHEMA.properties.segments);
});

test('targeted summaries fill the one-pager and the edited audience description', () => {
  const b = buildPrompts(resolvePrompts({ audienceCareers: 'students choosing a first job' }));
  const text = b.targetedUser({ onePager: 'ONE PAGER', audienceKey: 'careers' });
  assert.match(text, /ONE PAGER/);
  assert.match(text, /for: students choosing a first job\./);
  assert.match(text, /Return only the rewritten summary\.$/);
});
