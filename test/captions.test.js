import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  captionText, captionWindow, matchWindow, rewriteWindow, replaceCaptionBody,
} from '../web/runtime/captions.js';

const SEG = {
  title: 'Why yields matter',
  speaker: 'Taylor Quinn',
  start: '01:00:41',
  end: '01:04:11',
  rationale: 'Clearest explanation in the session',
};

test('writes the markdown header the review desk expects', () => {
  const out = captionText(SEG, 'Body of the caption.');
  assert.match(out, /^# Why yields matter\n/);
  assert.match(out, /\*\*Speaker:\*\* Taylor Quinn {2}\n/);
  assert.match(out, /\*\*01:00:41–01:04:11\*\* · Clearest explanation in the session/);
  assert.ok(out.endsWith('Body of the caption.\n'));
});

test('round-trips its own window', () => {
  assert.deepEqual(captionWindow(captionText(SEG, 'x')),
    { start: '01:00:41', end: '01:04:11' });
});

test('reads a hand-edited window', () => {
  const edited = captionText(SEG, 'x').replace('01:00:41–01:04:11', '01:00:55–01:03:40');
  assert.deepEqual(captionWindow(edited), { start: '01:00:55', end: '01:03:40' });
});

test('accepts hyphen and em dash as the separator', () => {
  assert.deepEqual(captionWindow('**00:01:00-00:02:00** · why'),
    { start: '00:01:00', end: '00:02:00' });
  assert.deepEqual(captionWindow('**00:01:00—00:02:00** · why'),
    { start: '00:01:00', end: '00:02:00' });
});

test('reads the pre-markdown legacy header', () => {
  const legacy = '# Old title\n# 00:39:44-00:41:07\n# some rationale\n\nBody';
  assert.deepEqual(captionWindow(legacy), { start: '00:39:44', end: '00:41:07' });
});

test('returns null for a header reformatted past recognition', () => {
  assert.equal(captionWindow('# Title\n\nno window here at all\n'), null);
});

test('matchWindow carries the rationale and the match position', () => {
  const text = captionText(SEG, 'Body.');
  const m = matchWindow(text);
  assert.equal(m.rationale, 'Clearest explanation in the session');
  assert.equal(text.slice(m.index, m.index + m.length),
    '**01:00:41–01:04:11** · Clearest explanation in the session');
});

test('matchWindow on a legacy header has no rationale on the window line', () => {
  const m = matchWindow('# Old title\n# 00:39:44-00:41:07\n# some rationale\n\nBody');
  assert.equal(m.start, '00:39:44');
  assert.equal(m.rationale, null);
});

test('matchWindow returns null when there is no window', () => {
  assert.equal(matchWindow('# Title\n\nnothing here\n'), null);
});

test('reads back a window whose rationale was deleted, trailing space and all', () => {
  const text = '# T\n\n**Speaker:** S  \n**01:00:41–01:04:11** \n\nBody text.\n';
  assert.deepEqual(captionWindow(text), { start: '01:00:41', end: '01:04:11' });
});

test('an absent rationale never swallows the body', () => {
  const text = '**01:00:41–01:04:11**\n\n- First bullet in body\nmore\n';
  const m = matchWindow(text);
  assert.equal(m.rationale, null);
  assert.equal(text.slice(m.index, m.index + m.length), '**01:00:41–01:04:11**');
});

test('an empty rationale from captionText leaves the body intact', () => {
  const text = captionText(
    { title: 'T', speaker: 'S', start: '01:00:41', end: '01:04:11', rationale: '' }, 'Body.');
  const m = matchWindow(text);
  assert.equal(m.rationale, null);
  assert.equal(text.slice(m.index + m.length).trim(), 'Body.');
});

test('a legacy window with no rationale line does not over-run', () => {
  const text = '# Old title\n# 00:39:44-00:41:07\n\nLegacy body.\n';
  const m = matchWindow(text);
  assert.equal(text.slice(m.index, m.index + m.length), '# 00:39:44-00:41:07');
  assert.equal(text.slice(m.index + m.length).trim(), 'Legacy body.');
});

test('rewriteWindow does not corrupt body text when header window is unparseable', () => {
  // When a caption's header window is broken, rewriteWindow should insert a fresh
  // window line in the header, not splice a body line that happens to look like a window.
  const text = '# Why yields matter\n\n**Speaker:** Taylor Quinn  \n**BROKEN HEADER**\n\n**00:10:00–00:11:00** · my note about the other clip\nMore body prose.\n';
  const result = rewriteWindow(text, '01:00:00', '01:02:00');
  // The body line should be untouched
  assert.ok(result.includes('**00:10:00–00:11:00** · my note about the other clip'));
  // The window should be inserted in the header
  assert.ok(result.includes('**01:00:00–01:02:00**'));
  // The result should have the speaker line still
  assert.ok(result.includes('**Speaker:** Taylor Quinn'));
});

test('a window with half seconds reads back exactly', () => {
  const text = captionText({ ...SEG, start: '01:00:41.5', end: '01:04:11.5' }, 'Body.');
  assert.deepEqual(captionWindow(text), { start: '01:00:41.5', end: '01:04:11.5' });
});

test('rewriteWindow can move a whole-second window onto half seconds and back', () => {
  const half = rewriteWindow(captionText(SEG, 'Body.'), '01:00:41.5', '01:04:12.5');
  assert.deepEqual(captionWindow(half), { start: '01:00:41.5', end: '01:04:12.5' });
  const whole = rewriteWindow(half, '01:00:41', '01:04:11');
  assert.equal(whole, captionText(SEG, 'Body.'));
});

test('replaceCaptionBody keeps a hand-nudged header byte-for-byte', () => {
  const nudged = rewriteWindow(captionText(SEG, 'Old caption.\n#old'), '01:00:41.5', '01:04:12.5');
  const out = replaceCaptionBody(nudged, 'New caption.\n#new');
  const header = nudged.slice(0, nudged.indexOf('Old caption.'));
  assert.equal(out, `${header}New caption.\n#new\n`);
  assert.deepEqual(captionWindow(out), { start: '01:00:41.5', end: '01:04:12.5' });
});

test('replaceCaptionBody refuses a file with no window rather than guessing', () => {
  assert.equal(replaceCaptionBody('# Just a title\n\nBody', 'New'), null);
});
