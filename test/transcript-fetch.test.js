import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalise, collapseRuns, dropOverlap } from '../web/runtime/transcript-fetch.js';
import { parse } from '../web/runtime/transcript.js';

// A real shape from youtube-transcript.ai: markdown preamble, unpadded
// timestamps, each caption line repeated 2-3 times, and the tail of one block
// reopening the next.
const SERVICE_OUTPUT = `# Transcript: Some Webinar

Source video: https://www.youtube.com/watch?v=R2x3carE1wI
Language: en (auto-generated) · Duration: 1:23:42 · Words: 38402

## Transcript
[0:02] welcome everybody. Uh, it's been a while welcome everybody. Uh, it's been a while since our last webinar. since our last webinar.

[0:33] since our last webinar. So it's it's great to So it's it's great to kickstart our our series. kickstart our our series.

[1:02:33] and that is the last word.
`;

test('strips the preamble and keeps only cue lines', () => {
  const out = normalise(SERVICE_OUTPUT);
  assert.ok(!out.includes('Source video'));
  assert.ok(!out.includes('## Transcript'));
  assert.equal(out.split('\n').filter(Boolean).length, 3);
});

test('zero-pads timestamps so transcript.js can parse them', () => {
  const out = normalise(SERVICE_OUTPUT);
  assert.match(out, /^\[00:00:02\] /m);
  assert.match(out, /^\[00:00:33\] /m);
  assert.match(out, /^\[01:02:33\] /m);
  // the real point: the existing parser accepts it
  const cues = parse(out);
  assert.equal(cues.length, 3);
  assert.deepEqual(cues.map((c) => c.seconds), [2, 33, 3753]);
});

test('collapses YouTube rolling-caption repeats', () => {
  const out = normalise(SERVICE_OUTPUT);
  const first = out.split('\n')[0];
  assert.equal(
    first,
    "[00:00:02] welcome everybody. Uh, it's been a while since our last webinar.");
});

test('keeps genuine speech stutters', () => {
  // "it's it's" and "our our" are things people say, not caption duplication.
  const out = normalise(SERVICE_OUTPUT);
  assert.ok(out.includes("it's it's great to"), 'two-word stutter must survive');
  assert.ok(out.includes('our our series'), 'two-word stutter must survive');
});

test('drops the overlap where one block reopens the next', () => {
  const out = normalise(SERVICE_OUTPUT);
  const second = out.split('\n')[1];
  assert.ok(!second.includes('since our last webinar'),
    'block 2 must not repeat the tail of block 1');
  assert.ok(second.startsWith("[00:00:33] So it's it's great to"));
});

test('decodes the HTML entities the service emits', () => {
  const out = normalise('## Transcript\n[0:01] &gt;&gt; Hey, Q&amp;A time &quot;now&quot;\n');
  assert.ok(out.includes('>> Hey, Q&A time "now"'));
});

test('returns empty string when there are no cues at all', () => {
  assert.equal(normalise('# Transcript: nothing\n\nno cues here\n'), '');
});

test('collapseRuns leaves text with no repeats untouched', () => {
  const words = 'one two three four five'.split(' ');
  assert.deepEqual(collapseRuns(words), words);
});

// The discriminator that separates caption noise from speech. Measured on a
// real webinar: 51 two-word fragments repeated three times were caption noise
// ("working. Uh," x3, ">> Yes." x3), while two-copy repeats are how people
// actually talk. Getting this backwards either leaves the transcript
// triplicated or silently edits the speaker's words.
test('a short fragment repeated THREE times is caption noise', () => {
  assert.deepEqual(
    collapseRuns('working. Uh, working. Uh, working. Uh, welcome'.split(' ')),
    'working. Uh, welcome'.split(' '));
  assert.deepEqual(
    collapseRuns('>> Yes. >> Yes. >> Yes. >> Okay.'.split(' ')),
    '>> Yes. >> Okay.'.split(' '));
});

test('a short fragment repeated TWICE is a speech stutter and is kept', () => {
  const stutter = "so it's it's great".split(' ');
  assert.deepEqual(collapseRuns(stutter), stutter);
  const doubled = 'we need our our series'.split(' ');
  assert.deepEqual(collapseRuns(doubled), doubled);
});

test('a long run collapses at only two copies', () => {
  assert.deepEqual(
    collapseRuns('alpha beta gamma delta alpha beta gamma delta end'.split(' ')),
    'alpha beta gamma delta end'.split(' '));
});

test('collapseRuns handles three consecutive copies', () => {
  const words = 'a b c d a b c d a b c d tail'.split(' ');
  assert.deepEqual(collapseRuns(words), 'a b c d tail'.split(' '));
});

test('dropOverlap returns the block unchanged when nothing overlaps', () => {
  assert.deepEqual(dropOverlap('a b c'.split(' '), 'x y z'.split(' ')), ['x', 'y', 'z']);
});
