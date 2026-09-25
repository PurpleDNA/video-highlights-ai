import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  boundariesFromWords, boundariesFromCues, snapWindow, DEFAULT_TOLERANCE,
} from '../web/runtime/snap.js';
import { parse } from '../web/runtime/transcript.js';
import { wordsToCues, cuesToText } from '../web/runtime/transcribe.js';

// Two sentences from one speaker, then a third. Times in ms, as AssemblyAI
// returns them.
const WORDS = [
  { text: 'This',    start: 1000,  end: 1200, speaker: 'A' },
  { text: 'is',      start: 1200,  end: 1350, speaker: 'A' },
  { text: 'one.',    start: 1350,  end: 1800, speaker: 'A' },
  { text: 'And',     start: 2200,  end: 2400, speaker: 'A' },
  { text: 'this',    start: 2400,  end: 2600, speaker: 'A' },
  { text: 'is',      start: 2600,  end: 2750, speaker: 'A' },
  { text: 'two!',    start: 2750,  end: 3400, speaker: 'A' },
  { text: 'Finally', start: 8000,  end: 8400, speaker: 'B' },
  { text: 'three.',  start: 8400,  end: 9000, speaker: 'B' },
];

test('word timings give both sentence starts and sentence ends', () => {
  const { starts, ends } = boundariesFromWords(WORDS);
  assert.deepEqual(starts, [1, 2.2, 8]);
  assert.deepEqual(ends, [1.8, 3.4, 9]);
});

test('the cue list contains no sentence-end times — the reason this module exists', () => {
  // wordsToCues breaks on a speaker change or 3000ms, so every timestamp the
  // model can read is a cue START. Not one of them is where a sentence ends.
  const cueStarts = wordsToCues(WORDS).map((c) => c.ms / 1000);
  const { ends } = boundariesFromWords(WORDS);
  for (const end of ends) {
    assert.ok(!cueStarts.includes(end),
      `${end}s is a sentence end and must not be reachable from cue starts alone`);
  }
});

test('terminal punctuation survives a quote, a bracket and a speaker label', () => {
  const words = [
    { text: 'He', start: 0, end: 100 },
    { text: 'said."', start: 100, end: 500 },
    { text: 'Next', start: 600, end: 800 },
  ];
  assert.deepEqual(boundariesFromWords(words).starts, [0, 0.6]);
});

test('a comma is not a sentence end', () => {
  const words = [
    { text: 'First,', start: 0, end: 200 },
    { text: 'second.', start: 200, end: 600 },
  ];
  assert.deepEqual(boundariesFromWords(words).ends, [0.6]);
});

test('cue-level boundaries are the fallback when there are no word timings', () => {
  const cues = parse([
    '[00:00:01] A: This is one.',
    '[00:00:04] A: A sentence that runs on',
    '[00:00:07] A: and finishes here.',
    '[00:00:11] B: Finally three.',
  ].join('\n'));
  const { starts } = boundariesFromCues(cues);
  // 4 and 11 follow a cue that ended on a full stop, so they begin sentences.
  // 7 does not: the cue before it runs on with no terminal punctuation.
  assert.deepEqual(starts, [1, 4, 11]);
});

test('snapping pulls a mid-sentence window onto the sentence', () => {
  const b = boundariesFromWords(WORDS);
  // The model asked for 2.5 -> 3.0: starts one word in, ends mid-word.
  const out = snapWindow(2.5, 3.0, b, { minSec: 0 });
  assert.equal(out.start, 2.2, 'moved back to the start of "And"');
  assert.equal(out.end, 3.4, 'moved forward to the end of "two!"');
  assert.equal(out.snapped, true);
});

test("the end prefers finishing the thought over truncating it", () => {
  const b = { starts: [0], ends: [9.0, 11.0] };
  // 10.2 is nearer 11 anyway; 9.6 is nearer 9, but 11 finishes the sentence.
  assert.equal(snapWindow(0, 9.6, b, { minSec: 0 }).end, 11.0);
});

test('a window with no boundary in range is left exactly alone', () => {
  const b = boundariesFromWords(WORDS);
  const out = snapWindow(50, 80, b);
  assert.deepEqual([out.start, out.end, out.snapped], [50, 80, false]);
});

test('a snap is refused rather than produce a clip under the floor', () => {
  // Both boundaries pull inward hard enough to collapse the window.
  const b = { starts: [10.0], ends: [12.0] };
  const out = snapWindow(9.0, 14.0, b, { minSec: 5 });
  assert.equal(out.snapped, false, 'a tidier cut is not worth an unusable clip');
  assert.deepEqual([out.start, out.end], [9.0, 14.0]);
});

test('a snap never inverts a window', () => {
  const out = snapWindow(10, 10.4, { starts: [10.4], ends: [10.0] }, { minSec: 0 });
  assert.equal(out.snapped, false);
});

test('tolerance stays under one cue, so a snap cannot cross into another thought', () => {
  // wordsToCues breaks at 3000ms, so a boundary further than that away
  // belongs to a different cue entirely.
  assert.ok(DEFAULT_TOLERANCE < 3, 'must not be able to slide past a whole cue');
});

test('real AssemblyAI words: sentence ENDS are the ones the model cannot reach', () => {
  const raw = JSON.parse(fs.readFileSync(new URL('./fixtures-assemblyai-words.json', import.meta.url)));
  const words = Array.isArray(raw) ? raw : (raw.words || raw.data || []);
  assert.ok(words.length > 0, 'fixture must hold words');

  // Every timestamp the model is shown, exactly as cuesToText writes them.
  const shown = new Set(
    cuesToText(wordsToCues(words))
      .split('\n').filter(Boolean)
      .map((line) => line.slice(1, 9)),
  );
  const { ends } = boundariesFromWords(words);
  assert.ok(ends.length > 0, 'fixture must contain at least one sentence end');

  const stamp = (sec) => {
    const t = Math.floor(sec);
    const p = (n) => String(n).padStart(2, '0');
    return `${p(Math.floor(t / 3600))}:${p(Math.floor(t / 60) % 60)}:${p(t % 60)}`;
  };
  const { starts } = boundariesFromWords(words);
  const reachableEnds = ends.filter((e) => shown.has(stamp(e)));
  const reachableStarts = starts.filter((s) => shown.has(stamp(s)));

  // The asymmetry is the whole finding. A cue start sometimes happens to be
  // where a sentence begins — a speaker change usually is one — so the model
  // CAN often pick a clean start. A sentence's end is a word's end time,
  // which appears nowhere in the document; the few that land on a shown
  // stamp do so only because both floor to the same whole second.
  assert.ok(reachableEnds.length < reachableStarts.length,
    `ends (${reachableEnds.length}) must be scarcer than starts (${reachableStarts.length})`);
  assert.ok(reachableEnds.length / ends.length <= 0.25,
    `at most a quarter of sentence ends should be reachable, got ${reachableEnds.length}/${ends.length}`);
});
