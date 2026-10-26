import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  stripSpeaker, cuesForWindow, cueAt, wrapLines, metrics, toSrt, srtTime,
} from '../web/runtime/subtitles.js';
import { parse } from '../web/runtime/transcript.js';

const TRANSCRIPT = [
  '[00:00:10] A: Before the clip starts.',
  '[00:01:00] A: This one opens the clip.',
  '[00:01:04] B: And this is the reply.',
  '[00:01:08] B: Still talking here.',
  '[00:02:30] A: Long after the clip ends.',
].join('\n');

test('strips the diarization label, which is not a name', () => {
  assert.equal(stripSpeaker('A: This one opens the clip.'), 'This one opens the clip.');
  assert.equal(stripSpeaker('B: And this is the reply.'), 'And this is the reply.');
});

test('leaves ordinary text alone', () => {
  // A single capital followed by a colon is the label shape, but real prose
  // with a colon in it must survive untouched.
  assert.equal(stripSpeaker('The question is: what now?'), 'The question is: what now?');
  assert.equal(stripSpeaker('No prefix at all'), 'No prefix at all');
});

test('re-times cues so zero is the clip\'s first frame', () => {
  const entries = cuesForWindow(parse(TRANSCRIPT), 60, 70);
  assert.deepEqual(entries.map((e) => [e.start, e.text]), [
    [0, 'This one opens the clip.'],
    [4, 'And this is the reply.'],
    [8, 'Still talking here.'],
  ]);
});

test('a cue that began before the window still shows', () => {
  // Someone mid-sentence when the clip opens should have their words on
  // screen, not a blank plate until the next cue lands.
  const entries = cuesForWindow(parse(TRANSCRIPT), 62, 70);
  assert.equal(entries[0].text, 'This one opens the clip.');
  assert.equal(entries[0].start, 0);
});

test('drops cues wholly outside the window', () => {
  const texts = cuesForWindow(parse(TRANSCRIPT), 60, 70).map((e) => e.text);
  assert.ok(!texts.some((t) => t.includes('Before the clip')));
  assert.ok(!texts.some((t) => t.includes('Long after')));
});

test('the last cue runs to the end of the clip, not past it', () => {
  const entries = cuesForWindow(parse(TRANSCRIPT), 60, 70);
  assert.equal(entries.at(-1).end, 10);
});

test('cueAt picks the cue covering a moment, and nothing outside', () => {
  const entries = cuesForWindow(parse(TRANSCRIPT), 60, 70);
  assert.equal(cueAt(entries, 0).text, 'This one opens the clip.');
  assert.equal(cueAt(entries, 3.9).text, 'This one opens the clip.');
  assert.equal(cueAt(entries, 4).text, 'And this is the reply.');
  assert.equal(cueAt(entries, 9.9).text, 'Still talking here.');
  assert.equal(cueAt([], 1), null);
});

test('wraps to two lines and never drops a word', () => {
  // A crude measure: ten units per character.
  const measure = (s) => s.length * 10;
  const text = 'one two three four five six seven eight nine ten';
  const lines = wrapLines(measure, text, 200);
  assert.ok(lines.length <= 2);
  assert.equal(lines.join(' ').split(/\s+/).length, text.split(/\s+/).length,
    'every word must survive wrapping');
});

test('short text stays on one line', () => {
  assert.deepEqual(wrapLines((s) => s.length * 10, 'short line', 500), ['short line']);
});

test('type scale is a fraction of the frame, not fixed pixels', () => {
  const small = metrics(640, 360);
  const large = metrics(1920, 1080);
  assert.ok(large.font > small.font, 'a 1080p master gets larger type than a 360p one');
  assert.ok(small.font >= 16, 'never smaller than legible on a phone');
  assert.ok(small.baseline < 360 && small.baseline > 360 * 0.8, 'sits in the lower centre');
  assert.ok(small.maxWidth < 640, 'leaves a margin on both sides');
});

test('SRT timestamps are HH:MM:SS,mmm', () => {
  assert.equal(srtTime(0), '00:00:00,000');
  assert.equal(srtTime(4.2), '00:00:04,200');
  assert.equal(srtTime(3725.0456), '01:02:05,046');
});

test('SRT numbers each cue from 1, clip-relative, with a blank line between', () => {
  const entries = cuesForWindow(parse(TRANSCRIPT), 60, 70);
  assert.equal(toSrt(entries), [
    '1', '00:00:00,000 --> 00:00:04,000', 'This one opens the clip.', '',
    '2', '00:00:04,000 --> 00:00:08,000', 'And this is the reply.', '',
    '3', '00:00:08,000 --> 00:00:10,000', 'Still talking here.', '',
  ].join('\r\n'));
});

test('an empty window makes an empty SRT, not a malformed one', () => {
  assert.equal(toSrt([]), '');
});
