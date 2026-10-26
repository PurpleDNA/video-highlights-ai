import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parse, formatTimestamp, formatWindowTime, toSeconds, sliceText, videoId,
} from '../web/runtime/transcript.js';

const RAW = [
  '[00:00:05] Welcome everyone.',
  'a line with no cue marker',
  '[00:01:00] First panelist speaking.',
  '[01:00:30] Much later in the webinar.',
].join('\n');

test('parses cues and skips non-matching lines', () => {
  const cues = parse(RAW);
  assert.equal(cues.length, 3);
  assert.deepEqual(cues[0], { seconds: 5, text: 'Welcome everyone.' });
  assert.equal(cues[2].seconds, 3630);
});

test('parse returns [] for text with no cues', () => {
  assert.deepEqual(parse('just prose\nno timestamps'), []);
});

test('formatTimestamp pads to HH:MM:SS', () => {
  assert.equal(formatTimestamp(3661), '01:01:01');
  assert.equal(formatTimestamp(0), '00:00:00');
});

test('toSeconds is the inverse', () => {
  assert.equal(toSeconds('01:12:30'), 4350);
  assert.equal(toSeconds(' 00:00:09 '), 9);
});

test('sliceText takes cues whose start falls inside the window, inclusive', () => {
  const cues = parse(RAW);
  assert.equal(sliceText(cues, 0, 60), 'Welcome everyone. First panelist speaking.');
  assert.equal(sliceText(cues, 6, 59), '');
});

test('videoId accepts every shape people paste', () => {
  assert.equal(videoId('IcUSXxnLGJU'), 'IcUSXxnLGJU');
  assert.equal(videoId('https://www.youtube.com/watch?v=IcUSXxnLGJU'), 'IcUSXxnLGJU');
  assert.equal(videoId('https://youtu.be/IcUSXxnLGJU?t=42'), 'IcUSXxnLGJU');
  assert.equal(videoId('https://www.youtube.com/live/IcUSXxnLGJU'), 'IcUSXxnLGJU');
  assert.equal(videoId('not a link'), null);
});

test('clip window times keep half seconds, and whole seconds look as before', () => {
  assert.equal(formatWindowTime(2477), '00:41:17');
  assert.equal(formatWindowTime(2477.5), '00:41:17.5');
  assert.equal(formatWindowTime(2477.04), '00:41:17'); // rounds to a tenth
  assert.equal(toSeconds('00:41:17.5'), 2477.5);
});
