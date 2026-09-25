import { test } from 'node:test';
import assert from 'node:assert/strict';
import { members } from '../web/runtime/zip.js';

// A representative run folder's file list, relative to the run's own
// directory — the shape zip.js's walkFiles produces. Mirrors bundle.py's
// test fixtures in spirit: highlights, panelist clips, targeted summaries,
// the one-pager, and run.json (which walkFiles never includes in the first
// place, but is left out here too since members() never has to filter it).
const FILES = [
  'one-pager.md',
  'clips/highlight-01_host.mp4',
  'clips/highlight-01_host_caption.md',
  'panelists/jane-doe/clip-01.mp4',
  'panelists/jane-doe/clip-01_caption.md',
  'targeted/researchers.md',
  'targeted/industry.md',
  'targeted/careers.md',
];

test("scope 'all' returns every file untouched", () => {
  assert.deepEqual(members(FILES, 'all'), FILES);
});

test("scope 'clips' is clips/ and panelists/ only", () => {
  assert.deepEqual(members(FILES, 'clips'), [
    'clips/highlight-01_host.mp4',
    'clips/highlight-01_host_caption.md',
    'panelists/jane-doe/clip-01.mp4',
    'panelists/jane-doe/clip-01_caption.md',
  ]);
});

test("scope 'text' is targeted/ plus the one-pager, by stem", () => {
  assert.deepEqual(members(FILES, 'text'), [
    'one-pager.md',
    'targeted/researchers.md',
    'targeted/industry.md',
    'targeted/careers.md',
  ]);
});

test("scope 'text' matches the one-pager by stem, not just top-level name", () => {
  // bundle.py's rule is `f.stem == "one-pager"`, independent of extension —
  // an older run's .txt one-pager still counts.
  const withTxt = ['one-pager.txt', 'clips/highlight-01_host.mp4'];
  assert.deepEqual(members(withTxt, 'text'), ['one-pager.txt']);
});

test("scope 'clips' ignores a same-named file outside clips/ or panelists/", () => {
  const withDecoy = ['clips/highlight-01_host.mp4', 'notes/panelists-plan.md'];
  assert.deepEqual(members(withDecoy, 'clips'), ['clips/highlight-01_host.mp4']);
});
