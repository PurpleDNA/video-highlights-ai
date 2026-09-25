import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  PREAMBLE, ONE_PAGER, CLIPS, CLIPS_SCHEMA, detectSpeakerLabels,
  CAPTION_SYSTEM, CAPTION_USER, TARGETED_SYSTEM, TARGETED_USER, AUDIENCES,
} from '../web/runtime/prompts.js';
import { wordsToCues, cuesToText } from '../web/runtime/transcribe.js';

// Resolved from this file's own location, not the process cwd — a cwd-relative
// path here would silently skip (and report success) if the suite is ever run
// from another directory, which defeats the point of a drift guard.
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PROMPTS_PY = join(REPO_ROOT, 'pipeline', 'prompts.py');
const PY_EXISTS = existsSync(PROMPTS_PY);

// Read explicitly as UTF-8: the prompts use em dashes, and any channel that
// mis-decodes them silently turns '—' into '?', which would make a real
// divergence look like a match (or a match look like a divergence).
// Normalize CRLF to LF once, here: readFileSync does not do this itself, and
// without it a CRLF checkout (this repo has core.autocrlf=true) would leave
// every embedded paragraph break as \r\n while both CPython and the JS
// template literal it's compared against normalize to \n, failing every
// triple-quote assertion that spans more than one line.
const py = PY_EXISTS ? readFileSync(PROMPTS_PY, 'utf8').replace(/\r\n/g, '\n') : null;

// Pulls NAME = """...""" out of a prompts.py-shaped source and applies
// Python's line-continuation rule: a trailing backslash joins the line to the
// next with no newline and no space (the space, if any, is already there
// before the `\`). `^` anchors on the name so it cannot match a NAME that
// merely appears in prose ahead of an unrelated ` = """`. The join tolerates
// both LF and CRLF: this repo has core.autocrlf=true, so a fresh checkout on
// Windows may hand this test a CRLF prompts.py even though the one committed
// here is LF, and `\\\n` alone would silently fail to strip a `\r\n` join.
function extractTripleQuoted(source, name) {
  const re = new RegExp('^' + name + ' = """([\\s\\S]*?)"""', 'm');
  const m = re.exec(source);
  assert.ok(m, `could not find ${name} in pipeline/prompts.py`);
  return m[1].replace(/\\\r?\n/g, '');
}

// AUDIENCES's dict values are Python's *other* line-continuation idiom:
// several adjacent double-quoted string literals with no operator between
// them, which Python concatenates implicitly. Collapse each key's run of
// literals into one string so it can be compared to the JS object's value.
//
// This deliberately does NOT use JSON.parse (or any other borrowed unescaper)
// to interpret a literal's contents. Python and JSON/JS do not agree on
// escape semantics — `\/` is the sharpest example: Python has no such escape
// and keeps both characters (`\` then `/`), while JSON and JS treat `\/` as
// an escape for a lone `/`. A literal containing `\/` would survive a
// mechanical Python->JS port as an already-corrupted JS string (the `\` is
// gone), and if this parser then ran the *same* literal through JSON.parse it
// would collapse the same way and land on the same wrong value — the guard
// would compare corrupted-to-corrupted, agree, and report a byte-identical
// prompt that is not. Rather than implement Python's escape rules (a bigger
// surface than this test needs) this only trusts a literal that contains no
// backslash at all — plain text is copied out verbatim, no unescaping
// required — and throws on anything else, naming the offending key, so a
// backslash showing up in a future AUDIENCES edit fails loudly instead of
// silently laundering a divergence.
function extractAudiences(source) {
  const block = /^AUDIENCES = \{([\s\S]*?)\n\}/m.exec(source);
  assert.ok(block, 'could not find AUDIENCES in pipeline/prompts.py');
  const body = block[1];
  const entryRe = /"(\w+)":\s*((?:"(?:\\.|[^"\\])*"\s*)+),/g;
  const result = {};
  let entry;
  while ((entry = entryRe.exec(body))) {
    const key = entry[1];
    const literalsRe = /"(?:\\.|[^"\\])*"/g;
    let joined = '';
    let literal;
    while ((literal = literalsRe.exec(entry[2]))) {
      if (literal[0].includes('\\')) {
        throw new Error(
          `AUDIENCES.${key} contains a backslash-escaped literal (${literal[0]}) — ` +
          'extractAudiences() only trusts plain literals with no escapes; extend the ' +
          'parser (it must not guess at Python escape semantics) before trusting this comparison.'
        );
      }
      joined += literal[0].slice(1, -1);
    }
    result[key] = joined;
  }
  return result;
}

test('PREAMBLE is byte-identical to prompts.py', { skip: !PY_EXISTS }, () => {
  assert.equal(PREAMBLE, extractTripleQuoted(py, 'PREAMBLE'));
});

test('ONE_PAGER is byte-identical to prompts.py', { skip: !PY_EXISTS }, () => {
  assert.equal(ONE_PAGER, extractTripleQuoted(py, 'ONE_PAGER'));
});

test('CAPTION_SYSTEM is byte-identical to prompts.py', { skip: !PY_EXISTS }, () => {
  assert.equal(CAPTION_SYSTEM, extractTripleQuoted(py, 'CAPTION_SYSTEM'));
});

test('TARGETED_SYSTEM is byte-identical to prompts.py', { skip: !PY_EXISTS }, () => {
  assert.equal(TARGETED_SYSTEM, extractTripleQuoted(py, 'TARGETED_SYSTEM'));
});

test('CLIPS matches prompts.py around its {highlights}/{per_panelist} placeholders', { skip: !PY_EXISTS }, () => {
  const raw = extractTripleQuoted(py, 'CLIPS');
  const highlights = '\u2039HIGHLIGHTS-SENTINEL\u203a';
  const perPanelist = '\u2039PER-PANELIST-SENTINEL\u203a';
  const expected = raw.split('{highlights}').join(highlights).split('{per_panelist}').join(perPanelist);
  assert.equal(CLIPS({ highlights, perPanelist }), expected);
});

test('CAPTION_USER matches prompts.py around its {title}/{slice} placeholders', { skip: !PY_EXISTS }, () => {
  const raw = extractTripleQuoted(py, 'CAPTION_USER');
  const title = '\u2039TITLE-SENTINEL\u203a';
  const slice = '\u2039SLICE-SENTINEL\u203a';
  const expected = raw.split('{title}').join(title).split('{slice}').join(slice);
  assert.equal(CAPTION_USER({ title, slice }), expected);
});

test('TARGETED_USER matches prompts.py around its {one_pager}/{audience} placeholders', { skip: !PY_EXISTS }, () => {
  const raw = extractTripleQuoted(py, 'TARGETED_USER');
  const onePager = '\u2039ONE-PAGER-SENTINEL\u203a';
  const audience = '\u2039AUDIENCE-SENTINEL\u203a';
  const expected = raw.split('{one_pager}').join(onePager).split('{audience}').join(audience);
  assert.equal(TARGETED_USER({ onePager, audience }), expected);
});

test('the three audiences are unchanged', () => {
  assert.deepEqual(Object.keys(AUDIENCES), ['researchers', 'industry', 'careers']);
});

test('AUDIENCES values are byte-identical to prompts.py', { skip: !PY_EXISTS }, () => {
  assert.deepEqual(AUDIENCES, extractAudiences(py));
});

// The guard above is only trustworthy if this failure path actually fires —
// prove it against a synthetic source rather than hoping today's prompts.py
// never grows a backslash. Not gated on PY_EXISTS: it never reads the real
// file, only the parser's own logic.
test('extractAudiences refuses to guess at a backslash-escaped literal', () => {
  const synthetic = 'AUDIENCES = {\n    "researchers": "path\\/to\\/thing",\n}\n';
  assert.throws(() => extractAudiences(synthetic), /backslash-escaped literal/);
});

test('CLIPS_SCHEMA requires every field runner.js routes on', () => {
  const item = CLIPS_SCHEMA.properties.segments.items;
  for (const field of ['title', 'start', 'end', 'rationale', 'speaker', 'highlight']) {
    assert.ok(item.required.includes(field), `${field} must be required`);
  }
  assert.equal(item.additionalProperties, false);
});

// ---------------------------------------------------------------------------
// Speaker-label detection and CLIPS's diarization note (AssemblyAI wiring).
// ---------------------------------------------------------------------------

const FIXTURE = new URL('./fixtures-assemblyai-words.json', import.meta.url);
const WORDS = JSON.parse(readFileSync(fileURLToPath(FIXTURE), 'utf8'));

// A real AssemblyAI-shaped transcript, built the same way runner.js's
// transcribe() path produces one — must be detected as labeled.
const ASSEMBLYAI_TRANSCRIPT = cuesToText(wordsToCues(WORDS));

// Shapes the other two transcript sources actually produce — a pasted/
// on-disk transcript and transcript-fetch.js's YouTube output — neither of
// which ever carries a speaker-label prefix. Must NOT be detected as labeled.
const PLAIN_TRANSCRIPT = [
  '[00:00:12] Welcome everyone to this month\'s webinar on alternative proteins.',
  '[00:00:47] Thanks for having me, excited to be here today.',
  '[00:01:30] Let\'s start with the state of the market this year.',
].join('\n') + '\n';

test('detectSpeakerLabels finds AssemblyAI\'s diarization prefix', () => {
  assert.equal(detectSpeakerLabels(ASSEMBLYAI_TRANSCRIPT), true);
});

test('detectSpeakerLabels is false for a plain (unlabeled) transcript', () => {
  assert.equal(detectSpeakerLabels(PLAIN_TRANSCRIPT), false);
});

test('detectSpeakerLabels is false for empty/blank input', () => {
  assert.equal(detectSpeakerLabels(''), false);
  assert.equal(detectSpeakerLabels('   \n  \n'), false);
});

test('CLIPS omits the speaker-label note by default (the other two sources)', () => {
  const task = CLIPS({ highlights: 4, perPanelist: 3 });
  assert.ok(!task.includes('Speaker labels:'));
});

test('CLIPS adds the speaker-label note when speakerLabels is true', () => {
  const task = CLIPS({ highlights: 4, perPanelist: 3, speakerLabels: true });
  assert.ok(task.includes('Speaker labels:'));
  assert.ok(task.includes('not names'));
  assert.ok(task.includes('introductions in the transcript'));
});

test('CLIPS with speakerLabels true is otherwise unchanged from the default', () => {
  const withoutNote = CLIPS({ highlights: 4, perPanelist: 3 });
  const withNote = CLIPS({ highlights: 4, perPanelist: 3, speakerLabels: true });
  assert.ok(withNote.startsWith(withoutNote));
});
