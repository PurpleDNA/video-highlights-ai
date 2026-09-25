# Browser Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the whole webinar pipeline into the browser — a PWA served from GitHub Pages, with the run in a Web Worker and clips cut with WebCodecs — so the team needs no Python, no ffmpeg, and no server.

**Architecture:** Three threads. The main thread keeps today's views. A run worker holds the ported `pipeline/` (runner, steps, prompts, llm, transcript, manifest) and talks to Anthropic directly over CORS. A cut worker re-encodes clips with WebCodecs, and only at export — the review desk plays windows off the local master instead. A user-picked working folder, reached through the File System Access API, replaces `config.py`'s paths and stays the source of truth.

**Tech Stack:** Plain ES modules, no build step. `@anthropic-ai/sdk` (browser mode), `mp4box.js`, `mp4-muxer`, `fflate` — all vendored into `web/vendor/`. Tests run on `node --test` (no dependencies).

**Spec:** `docs/superpowers/specs/2026-09-22-browser-pipeline-design.md` — read it before Task 1. Both of its spikes passed; the spike code is on disk in `spike/` (gitignored) and Tasks 4 and 11 are built from it.

## Global Constraints

- **No build step.** Plain `<script type="module">` and ES modules, exactly as `web/` works today. No bundler, no transpiler, no `npm run` in the serving path.
- **No runtime CDN.** Every third-party library is vendored into `web/vendor/`. A CDN outage must not break a run, and the PWA must work offline.
- **Chromium-family only.** File System Access and WebCodecs are required. Do not add fallbacks for other browsers.
- **Node 18+ for tests.** `node --test` runs ESM natively. Tests never import browser globals — that is why the pure logic lives in its own modules.
- **Pure modules stay pure.** `slug.js`, `transcript.js`, `captions.js`, `prompts.js`, `manifest-parse.js` must not reference `window`, `fetch`, `indexedDB`, or any `FileSystem*` type. They are the unit-tested core.
- **`PREAMBLE` is byte-frozen.** It is the prompt-cache prefix. Task 3 adds a test that fails if `prompts.js` and `prompts.py` drift.
- **Event shapes are unchanged** from `pipeline/runner.py`: `{type:'stage'|'clip'|'count'|'note'}` with the same keys. `app.js` and `format.js` already render them.
- **A stage reports a count only once the count is known.** The clip total arrives with the selection result, never before.
- **Model:** `claude-opus-4-8`. **`MIN_CLIP_SEC`:** 5. **`TRANSCRIPT_OFFSET_SEC`:** 0. **`NUM_SEGMENTS`:** 4. **`CLIPS_PER_PANELIST`:** 3.
- **Commit after every task.** Never add a `Co-Authored-By` line.

## File Structure

```
test/                          node --test, no dependencies
  slug.test.js
  transcript.test.js
  captions.test.js
  prompts.test.js              guards PREAMBLE against drift
  manifest-parse.test.js

web/
  index.html                   MODIFY: folder picker, key field, transcript input
  styles.css                   MODIFY: new input controls, trim handles
  app.js                       MODIFY: minimally — views are kept
  format.js                    unchanged
  api.js                       REWRITE: worker transport instead of fetch/SSE
  sw.js                        NEW: offline cache
  manifest.webmanifest         NEW: PWA install
  vendor/                      NEW: anthropic.js, mp4box.js, mp4-muxer.js, fflate.js
  runtime/
    slug.js                    PURE  slug()
    transcript.js              PURE  parse, formatTimestamp, toSeconds, sliceText
    captions.js                PURE  captionText(), captionWindow()
    prompts.js                 PURE  PREAMBLE + task prompts + CLIPS_SCHEMA
    manifest-parse.js          PURE  readCaption()
    config.js                  constants only
    llm.js                     Anthropic client, callWithTranscript(), call()
    steps.js                   onePager, selectClips, socialCaption, targetedSummary
    store.js                   IndexedDB: key, dir handle, settings
    fsroot.js                  File System Access: read/write inside the work folder
    manifest.js                walks a run folder into the review structure
    runner.js                  the run; emits events
    run-worker.js              worker entry: protocol, one-run rule, cancel
    cut.js                     WebCodecs cut(file, start, end) -> Blob
    cut-worker.js              worker entry for cutting
    zip.js                     bundle all / clips / text
```

Each `runtime/` module has one job, and the pure five are the ones that carry the behaviour worth testing. `runner.js` stays the single description of a run, exactly as `runner.py` is today.

---

### Task 1: Test harness, `slug.js`, `transcript.js`

The pure core, ported from `pipeline/runner.py:slug` and `pipeline/transcript.py`. Nothing else can be trusted until these are.

**Files:**
- Create: `test/slug.test.js`, `test/transcript.test.js`
- Create: `web/runtime/slug.js`, `web/runtime/transcript.js`
- Create: `package.json`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `slug(name: string) -> string`
  - `parse(raw: string) -> Array<{seconds: number, text: string}>`
  - `formatTimestamp(seconds: number) -> string` (`"HH:MM:SS"`)
  - `toSeconds(hhmmss: string) -> number`
  - `sliceText(cues, startSec: number, endSec: number) -> string`
  - `videoId(urlOrId: string) -> string | null`

- [ ] **Step 1: Create `package.json`**

Only so `node --test` treats `.js` as ESM. No dependencies, no build.

```json
{
  "name": "pipeline-one-web",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "node --test"
  }
}
```

- [ ] **Step 2: Write the failing tests**

`test/slug.test.js`:

```js
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
```

`test/transcript.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parse, formatTimestamp, toSeconds, sliceText, videoId,
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
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `node --test`
Expected: FAIL — `Cannot find module '../web/runtime/slug.js'`

- [ ] **Step 4: Write `web/runtime/slug.js`**

```js
/** `runner.py`'s slug(): lowercase, non-alphanumerics collapsed to hyphens. */
export function slug(name) {
  return String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}
```

- [ ] **Step 5: Write `web/runtime/transcript.js`**

```js
/** Parse the timestamped transcript and slice it by time.
 *
 * Transcript format, one caption cue per line, as read_transcript.py writes it:
 *     [HH:MM:SS] some text of the cue
 *
 * Ported from pipeline/transcript.py. Pure — no browser globals.
 */

const TS = /^\[(\d{2}):(\d{2}):(\d{2})\]\s*(.*)$/;

/** Raw transcript text -> cues. Non-matching lines are skipped. */
export function parse(raw) {
  const cues = [];
  for (const line of String(raw).split(/\r?\n/)) {
    const m = TS.exec(line);
    if (m) {
      const [, h, mn, s, text] = m;
      cues.push({ seconds: +h * 3600 + +mn * 60 + +s, text: text.trim() });
    }
  }
  return cues;
}

/** 3661 -> '01:01:01'. */
export function formatTimestamp(seconds) {
  const total = Math.floor(Number(seconds));
  const s = total % 60;
  const m = Math.floor(total / 60) % 60;
  const h = Math.floor(total / 3600);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(h)}:${pad(m)}:${pad(s)}`;
}

/** '01:12:30' -> 4350. Accepts the HH:MM:SS strings the model returns. */
export function toSeconds(hhmmss) {
  const [h, m, s] = String(hhmmss).trim().split(':');
  return +h * 3600 + +m * 60 + +s;
}

/** Text of every cue whose start falls within [startSec, endSec]. */
export function sliceText(cues, startSec, endSec) {
  return cues.filter((c) => c.seconds >= startSec && c.seconds <= endSec)
    .map((c) => c.text).join(' ');
}

const YT_ID = /^[A-Za-z0-9_-]{11}$/;
const YT_URL = /(?:youtu\.be\/|youtube\.com\/(?:watch\?(?:.*&)?v=|embed\/|live\/|shorts\/|v\/))([A-Za-z0-9_-]{11})/;

/** The 11-character YouTube id from any shape people paste, or null. */
export function videoId(urlOrId) {
  const s = String(urlOrId || '').trim();
  if (YT_ID.test(s)) return s;
  const m = YT_URL.exec(s);
  return m ? m[1] : null;
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `node --test`
Expected: PASS, 9 tests.

- [ ] **Step 7: Commit**

```bash
git add package.json test/slug.test.js test/transcript.test.js web/runtime/slug.js web/runtime/transcript.js
git commit -m "Port slug and transcript parsing to JS, with tests"
```

---

### Task 2: `captions.js` — the review surface, round-tripped

A caption file's header carries the clip's time window, and a hand-edited window has to survive being read back. This is the pipeline's documented repair path, so it gets tested hardest. Ported from `runner.py:write_caption` and `runner.py:caption_window`.

**Files:**
- Create: `test/captions.test.js`, `web/runtime/captions.js`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `captionText(seg: {title, speaker, start, end, rationale}, caption: string) -> string`
  - `captionWindow(text: string) -> {start: string, end: string} | null`

- [ ] **Step 1: Write the failing tests**

`test/captions.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { captionText, captionWindow } from '../web/runtime/captions.js';

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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/captions.test.js`
Expected: FAIL — `Cannot find module '../web/runtime/captions.js'`

- [ ] **Step 3: Write `web/runtime/captions.js`**

Note the two trailing spaces after the speaker line — that is a markdown hard line break and the existing files have it.

```js
/** Caption files: the pipeline's review surface.
 *
 * The header carries the clip's time window, and editing that window by hand is
 * the documented way to fix a bad cut — so captionWindow() must read back what
 * captionText() writes, and must also tolerate an operator's edits.
 * Ported from pipeline/runner.py. Pure — no browser globals.
 */

/** Title heading, speaker, time window + rationale, then the caption body. */
export function captionText(seg, caption) {
  const header =
    `# ${seg.title}\n\n` +
    `**Speaker:** ${seg.speaker}  \n` +
    `**${seg.start}–${seg.end}** · ${seg.rationale}\n\n`;
  return `${header}${caption}\n`;
}

const WINDOW = /^\*\*(\d{1,2}:\d{2}:\d{2})\s*[-–—]\s*(\d{1,2}:\d{2}:\d{2})\*\*/m;
// Captions written before the markdown switch put the window on a
// `# HH:MM:SS-...` comment line. Older runs in output/ must stay readable.
const WINDOW_LEGACY = /^#\s*(\d{1,2}:\d{2}:\d{2})\s*[-–—]\s*(\d{1,2}:\d{2}:\d{2})\s*$/m;

/** The window from a caption's header, or null if it is missing or malformed.
 *  Never throws: a reformatted header is reported and skipped, not fatal. */
export function captionWindow(text) {
  const m = WINDOW.exec(text) || WINDOW_LEGACY.exec(text);
  return m ? { start: m[1], end: m[2] } : null;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/captions.test.js`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add test/captions.test.js web/runtime/captions.js
git commit -m "Port caption header writing and window parsing, with round-trip tests"
```

---

### Task 3: `prompts.js` and `config.js`, with a drift guard

`prompts.py` is the tuning surface and `PREAMBLE` is the prompt-cache prefix — a single changed byte costs a cache write. While `pipeline/` still exists on the branch, a test keeps the two copies identical.

**Files:**
- Create: `web/runtime/prompts.js`, `web/runtime/config.js`, `test/prompts.test.js`
- Read: `pipeline/prompts.py` (the source of truth for this task)

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `PREAMBLE`, `ONE_PAGER`, `CLIPS`, `CLIPS_SCHEMA`, `CAPTION_SYSTEM`, `CAPTION_USER`, `TARGETED_SYSTEM`, `TARGETED_USER`, `AUDIENCES` from `prompts.js`
  - `MODEL`, `NUM_SEGMENTS`, `CLIPS_PER_PANELIST`, `MIN_CLIP_SEC`, `TRANSCRIPT_OFFSET_SEC` from `config.js`

- [ ] **Step 1: Write the drift test**

`test/prompts.test.js`. It extracts `PREAMBLE` from the Python file with a regex and compares it to the JS constant.

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { PREAMBLE, AUDIENCES, CLIPS_SCHEMA } from '../web/runtime/prompts.js';

test('PREAMBLE is byte-identical to prompts.py', { skip: !existsSync('pipeline/prompts.py') }, () => {
  const py = readFileSync('pipeline/prompts.py', 'utf8');
  const m = /^PREAMBLE = """([\s\S]*?)"""/m.exec(py);
  assert.ok(m, 'could not find PREAMBLE in pipeline/prompts.py');
  // Python's trailing backslash joins the line without a newline.
  const fromPy = m[1].replace(/\\\n/g, '');
  assert.equal(PREAMBLE, fromPy);
});

test('the three audiences are unchanged', () => {
  assert.deepEqual(Object.keys(AUDIENCES), ['researchers', 'industry', 'careers']);
});

test('CLIPS_SCHEMA requires every field runner.js routes on', () => {
  const item = CLIPS_SCHEMA.properties.segments.items;
  for (const field of ['title', 'start', 'end', 'rationale', 'speaker', 'highlight']) {
    assert.ok(item.required.includes(field), `${field} must be required`);
  }
  assert.equal(item.additionalProperties, false);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test test/prompts.test.js`
Expected: FAIL — `Cannot find module '../web/runtime/prompts.js'`

- [ ] **Step 3: Write `web/runtime/prompts.js`**

Open `pipeline/prompts.py` and copy every string across verbatim. Two mechanical rules, no rewording:

- A Python `"""..."""` becomes a JS backtick template literal.
- Python's line-continuation backslash at end of line (`\` then newline) joins the line with **no newline and no space** — delete both the backslash and the newline. Getting this wrong is what the drift test catches.
- `str.format()` placeholders `{highlights}`, `{per_panelist}`, `{title}`, `{slice}`, `{one_pager}`, `{audience}` become `${...}` template substitutions — so export the parameterised prompts as functions:

```js
export const CLIPS = ({ highlights, perPanelist }) => `...`;
export const CAPTION_USER = ({ title, slice }) => `...`;
export const TARGETED_USER = ({ onePager, audience }) => `...`;
```

while `PREAMBLE`, `ONE_PAGER`, `CAPTION_SYSTEM` and `TARGETED_SYSTEM` stay plain strings. Copy `AUDIENCES` and `CLIPS_SCHEMA` across as a plain object literal.

Start the file with the design note from `prompts.py`:

```js
/** All prompts live here — this is the file you tune.
 *
 * Design note on caching: PREAMBLE is sent as a frozen system block, with the
 * transcript cached immediately after it (see llm.callWithTranscript). Keep
 * PREAMBLE byte-stable while iterating — edit the *task* prompts below, which
 * ride in the user turn after the cache breakpoint, so the transcript cache
 * survives your edits.
 *
 * Measured 2026-09-22: a call that carries CLIPS_SCHEMA gets its OWN cache
 * entry and cannot read the plain calls' — the schema sits ahead of the cached
 * prefix. Repeated selection calls still hit their own entry, which is the dev
 * loop this caching is for.
 */
```

- [ ] **Step 4: Write `web/runtime/config.js`**

```js
/** Pipeline configuration. Paths are gone — the work folder is chosen at
 *  runtime (see fsroot.js) — so what is left is the model and the knobs. */

// Opus 4.8 is the editorial-judgment workhorse here. At one webinar a month,
// cost is a rounding error; optimize for quality, not price.
export const MODEL = 'claude-opus-4-8';

// Overall highlight clips per webinar (the ranked "best of" set in clips/).
export const NUM_SEGMENTS = 4;

// Max candidate clips per panelist, so each can be offered a choice.
export const CLIPS_PER_PANELIST = 3;

// Floor on clip length (seconds). A window shorter than this — or one that
// resolves to no transcript text — is degenerate and gets skipped.
export const MIN_CLIP_SEC = 5;

// If the transcript and the master .mp4 start at different points, set this to
// (master_time - transcript_time) in seconds.
export const TRANSCRIPT_OFFSET_SEC = 0;

// Folder layout inside the user's chosen work folder.
export const RECORDINGS_DIR = 'webinar recordings';
export const TRANSCRIPTS_DIR = 'transcripts';
export const OUTPUT_DIR = 'output';
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node --test`
Expected: PASS, all tasks' tests green. If the PREAMBLE test fails, the line-continuation handling in Step 3 is wrong — fix `prompts.js`, not the test.

- [ ] **Step 6: Commit**

```bash
git add web/runtime/prompts.js web/runtime/config.js test/prompts.test.js
git commit -m "Port prompts and config to JS, with a drift guard against prompts.py"
```

---

### Task 4: `llm.js` — Anthropic from the browser

Built from `spike/llm.html`, which proved all of this works. Ported from `pipeline/llm.py`.

**Files:**
- Create: `web/runtime/llm.js`
- Create: `web/vendor/anthropic.js` (vendored)

**Interfaces:**
- Consumes: `MODEL` from `config.js`.
- Produces:
  - `setApiKey(key: string) -> void`
  - `callWithTranscript({label, preamble, transcript, task, schema?, maxTokens?}) -> Promise<string|object>`
  - `call({label, system, user, schema?, maxTokens?}) -> Promise<string|object>`

- [ ] **Step 1: Vendor the SDK**

```bash
mkdir -p web/vendor
curl -L "https://cdn.jsdelivr.net/npm/@anthropic-ai/sdk@0.71.0/+esm" -o web/vendor/anthropic.js
head -c 200 web/vendor/anthropic.js
```

Expected: JavaScript, not an HTML error page. If jsdelivr's `+esm` build pulls further imports at runtime, instead run `npm pack @anthropic-ai/sdk@0.71.0`, unpack it, and copy the browser ESM bundle into `web/vendor/anthropic.js`. The constraint that matters: **nothing may be fetched from the network at runtime.** Verify by loading a page with DevTools offline mode on.

- [ ] **Step 2: Write `web/runtime/llm.js`**

```js
/** Anthropic client and call helpers.
 *
 * Two entry points, as in pipeline/llm.py:
 *   - callWithTranscript() caches the (large) transcript as a shared prefix.
 *     The frozen preamble + transcript sit in the system block behind one cache
 *     breakpoint; the per-task instruction rides in the user turn after it.
 *   - call() is a plain call for the small steps (captions, targeted summaries).
 *
 * Both default to adaptive thinking. Pass a JSON schema to get a parsed object
 * back instead of text.
 *
 * Browser note: the SDK sends `anthropic-dangerous-direct-browser-access`, which
 * is what opts the request into CORS. The key is the user's own, held in
 * IndexedDB — see store.js. Verified working 2026-09-22.
 */

import Anthropic from '../vendor/anthropic.js';
import { MODEL } from './config.js';

let client = null;

export function setApiKey(key) {
  client = new Anthropic({ apiKey: key, dangerouslyAllowBrowser: true });
}

function getClient() {
  if (!client) throw new Error('No Anthropic API key set. Add yours in settings.');
  return client;
}

/** The first text block, skipping thinking blocks.
 *
 * A truncated response (stop_reason "max_tokens") can carry thinking blocks and
 * no text block at all — adaptive thinking spent the whole budget. Fail with the
 * reason rather than returning undefined. */
function textOf(msg) {
  const block = msg.content.find((b) => b.type === 'text');
  if (block) return block.text;
  throw new Error(
    `No text block in response (stop_reason=${msg.stop_reason}, ` +
    `output_tokens=${msg.usage.output_tokens}). If this is 'max_tokens', ` +
    'raise maxTokens for this call.');
}

function logCache(label, msg) {
  const u = msg.usage;
  console.log(`  [${label}] in=${u.input_tokens} ` +
    `cache_write=${u.cache_creation_input_tokens ?? 0} ` +
    `cache_read=${u.cache_read_input_tokens ?? 0} out=${u.output_tokens}`);
}

async function request(label, system, messages, schema, maxTokens) {
  const params = {
    model: MODEL,
    max_tokens: maxTokens,
    thinking: { type: 'adaptive' },
    system,
    messages,
  };
  if (schema) params.output_config = { format: { type: 'json_schema', schema } };
  // Always stream. The SDK refuses a non-streaming request whose max_tokens
  // could take it past the HTTP timeout, and clip selection runs at 32k. We
  // want the whole message, so drain it with finalMessage().
  const stream = await getClient().messages.stream(params);
  const msg = await stream.finalMessage();
  logCache(label, msg);
  const text = textOf(msg);
  return schema ? JSON.parse(text) : text;
}

/** Run a task against the cached transcript prefix. */
export function callWithTranscript({ label, preamble, transcript, task, schema = null, maxTokens = 16000 }) {
  const system = [
    { type: 'text', text: preamble },
    { type: 'text', text: transcript, cache_control: { type: 'ephemeral' } },
  ];
  return request(label, system, [{ role: 'user', content: task }], schema, maxTokens);
}

/** Plain call for the small steps (no transcript). */
export function call({ label, system, user, schema = null, maxTokens = 4000 }) {
  return request(label, system, [{ role: 'user', content: user }], schema, maxTokens);
}
```

- [ ] **Step 3: Verify against the live API**

This cannot be unit tested — it is a network boundary. Reuse the spike harness, which already does exactly this and passed:

```bash
python spike/server.py 8123
```

Open `http://127.0.0.1:8123/spike/llm.html`, edit its import to `'/web/vendor/anthropic.js'` and its call sites to use `web/runtime/llm.js`. Expected in the log, matching the spike's recorded run:

- call 1: `cache_write` around 35,000, `cache_read=0`
- call 2: `cache_read` equal to call 1's `cache_write` — **the cache is shared**
- call 3: parses into clips with valid `HH:MM:SS` windows

Stop the server when done. Do not commit `spike/` — it is gitignored.

- [ ] **Step 4: Commit**

```bash
git add web/runtime/llm.js web/vendor/anthropic.js
git commit -m "Port the Anthropic call helpers to the browser SDK"
```

---

### Task 5: `steps.js` — the four content steps

Thin wrappers over `llm` + `prompts`, ported from `pipeline/steps.py`.

**Files:**
- Create: `web/runtime/steps.js`

**Interfaces:**
- Consumes: `llm.callWithTranscript`, `llm.call`, everything from `prompts.js`.
- Produces:
  - `onePager(transcript: string) -> Promise<string>`
  - `selectClips(transcript: string, highlights: number, perPanelist: number) -> Promise<Array<{title,start,end,rationale,speaker,highlight}>>`
  - `socialCaption(title: string, clipSlice: string) -> Promise<string>`
  - `targetedSummary(onePagerText: string, audienceKey: string) -> Promise<string>`
  - `AUDIENCES` re-exported

- [ ] **Step 1: Write `web/runtime/steps.js`**

```js
/** The four content-generation steps. Thin wrappers over llm + prompts. */

import * as llm from './llm.js';
import * as prompts from './prompts.js';

export const AUDIENCES = prompts.AUDIENCES;

export function onePager(transcript) {
  return llm.callWithTranscript({
    label: 'one-pager',
    preamble: prompts.PREAMBLE,
    transcript,
    task: prompts.ONE_PAGER,
  });
}

/** One pass: a flat list of clips, each tagged with `speaker` and a `highlight`
 *  flag. Highlights are ranked first; the rest are grouped per panelist. */
export async function selectClips(transcript, highlights, perPanelist) {
  const result = await llm.callWithTranscript({
    label: 'clips',
    preamble: prompts.PREAMBLE,
    transcript,
    task: prompts.CLIPS({ highlights, perPanelist }),
    schema: prompts.CLIPS_SCHEMA,
    // Biggest output in the pipeline: one row per clip for every panelist, plus
    // adaptive thinking over the whole transcript. At 16k this truncated
    // mid-run and came back with no text block at all.
    maxTokens: 32000,
  });
  return result.segments;
}

export function socialCaption(title, clipSlice) {
  return llm.call({
    label: 'caption',
    system: prompts.CAPTION_SYSTEM,
    user: prompts.CAPTION_USER({ title, slice: clipSlice }),
  });
}

export function targetedSummary(onePagerText, audienceKey) {
  return llm.call({
    label: `targeted/${audienceKey}`,
    system: prompts.TARGETED_SYSTEM,
    user: prompts.TARGETED_USER({
      onePager: onePagerText,
      audience: prompts.AUDIENCES[audienceKey],
    }),
  });
}
```

- [ ] **Step 2: Verify it loads**

There is no unit test here — every function is a network call, and mocking the SDK would test the mock. Check only that the module graph resolves:

Run: `node --input-type=module -e "import('./web/runtime/steps.js').then(m => console.log(Object.keys(m)))"`
Expected: it fails on `import Anthropic from '../vendor/anthropic.js'` only if the vendored bundle is not valid ESM — which would mean Task 4 Step 1 needs the `npm pack` route. Otherwise it prints the four function names plus `AUDIENCES`.

- [ ] **Step 3: Commit**

```bash
git add web/runtime/steps.js
git commit -m "Port the four content steps"
```

---

### Task 6: `store.js` — key, folder handle, settings

Three things in IndexedDB, and nothing that belongs in the work folder.

**Files:**
- Create: `web/runtime/store.js`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `getApiKey() -> Promise<string|null>` / `setApiKey(key: string) -> Promise<void>`
  - `getRootHandle() -> Promise<FileSystemDirectoryHandle|null>` / `setRootHandle(h) -> Promise<void>`
  - `getSettings() -> Promise<{segments: number, perPanelist: number}>` / `setSettings(s) -> Promise<void>`

- [ ] **Step 1: Write `web/runtime/store.js`**

```js
/** What the browser remembers between sessions: the user's API key, the handle
 *  to their work folder, and the two run knobs. Nothing else — anything that
 *  belongs to a run belongs in the output folder, which is the source of truth.
 *
 *  Directory handles are structured-cloneable, so IndexedDB can hold one across
 *  reloads; the permission it carries still has to be re-granted (see fsroot.js).
 */

import { NUM_SEGMENTS, CLIPS_PER_PANELIST } from './config.js';

const DB = 'pipeline-one';
const STORE = 'kv';

function open() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function get(key) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const req = db.transaction(STORE, 'readonly').objectStore(STORE).get(key);
    req.onsuccess = () => resolve(req.result ?? null);
    req.onerror = () => reject(req.error);
  });
}

async function put(key, value) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export const getApiKey = () => get('apiKey');
export const setApiKey = (key) => put('apiKey', key);

export const getRootHandle = () => get('rootHandle');
export const setRootHandle = (handle) => put('rootHandle', handle);

export async function getSettings() {
  const s = await get('settings');
  return {
    segments: s?.segments ?? NUM_SEGMENTS,
    perPanelist: s?.perPanelist ?? CLIPS_PER_PANELIST,
  };
}
export const setSettings = (s) => put('settings', s);
```

- [ ] **Step 2: Verify in the browser**

Serve `web/` and run in DevTools console:

```js
const s = await import('/runtime/store.js');
await s.setApiKey('test-key');
console.log(await s.getApiKey());              // 'test-key'
console.log(await s.getSettings());            // { segments: 4, perPanelist: 3 }
await s.setApiKey('');
```

Expected: the logged values above, and the `pipeline-one` database visible under Application → IndexedDB.

- [ ] **Step 3: Commit**

```bash
git add web/runtime/store.js
git commit -m "Remember the API key, work folder and settings in IndexedDB"
```

---

### Task 7: `fsroot.js` — the work folder

Replaces `config.py`'s paths. Everything a run reads or writes goes through here.

**Files:**
- Create: `web/runtime/fsroot.js`

**Interfaces:**
- Consumes: `store.getRootHandle`/`setRootHandle`, the `*_DIR` constants from `config.js`.
- Produces:
  - `pickRoot() -> Promise<FileSystemDirectoryHandle>` (shows the picker, persists the handle)
  - `getRoot() -> Promise<FileSystemDirectoryHandle|null>` (remembered handle, permission re-verified)
  - `dir(root, path: string, {create?: boolean}) -> Promise<FileSystemDirectoryHandle>` — `path` is `'output/my-slug/clips'`
  - `readText(root, path) -> Promise<string|null>`
  - `writeText(root, path, text) -> Promise<void>`
  - `writeBlob(root, path, blob) -> Promise<void>`
  - `getFile(root, path) -> Promise<File|null>`
  - `exists(root, path) -> Promise<boolean>`
  - `listDir(root, path) -> Promise<Array<{name: string, kind: 'file'|'directory'}>>`
  - `recordingPath(name) -> string`, `transcriptPath(name) -> string`, `pathsFor(name) -> {out, clips, panelists, targeted}`

- [ ] **Step 1: Write `web/runtime/fsroot.js`**

```js
/** The user's work folder, and every read and write inside it.
 *
 * This is what config.py's paths become. The folder is laid out exactly as the
 * repo is:
 *     <work folder>/webinar recordings/<webinar>.mp4
 *     <work folder>/transcripts/<webinar>.txt
 *     <work folder>/output/<slug>/...
 *
 * The handle is remembered across reloads, but the permission it carries is not
 * — getRoot() re-requests it, which costs the user one click per session.
 */

import { getRootHandle, setRootHandle } from './store.js';
import { RECORDINGS_DIR, TRANSCRIPTS_DIR, OUTPUT_DIR } from './config.js';
import { slug } from './slug.js';

export async function pickRoot() {
  const handle = await showDirectoryPicker({ id: 'gfpbap-work', mode: 'readwrite' });
  await setRootHandle(handle);
  return handle;
}

/** The remembered folder, or null if there is none or the user declines. */
export async function getRoot() {
  const handle = await getRootHandle();
  if (!handle) return null;
  const opts = { mode: 'readwrite' };
  if (await handle.queryPermission(opts) === 'granted') return handle;
  if (await handle.requestPermission(opts) === 'granted') return handle;
  return null;
}

/** Walk (and optionally create) a '/'-separated path below the root. */
export async function dir(root, path, { create = false } = {}) {
  let h = root;
  for (const part of path.split('/').filter(Boolean)) {
    h = await h.getDirectoryHandle(part, { create });
  }
  return h;
}

async function fileHandle(root, path, { create = false } = {}) {
  const parts = path.split('/').filter(Boolean);
  const name = parts.pop();
  const parent = await dir(root, parts.join('/'), { create });
  return parent.getFileHandle(name, { create });
}

export async function getFile(root, path) {
  try {
    return await (await fileHandle(root, path)).getFile();
  } catch (e) {
    if (e.name === 'NotFoundError') return null;
    throw e;
  }
}

export async function readText(root, path) {
  const file = await getFile(root, path);
  return file ? file.text() : null;
}

export async function writeText(root, path, text) {
  const handle = await fileHandle(root, path, { create: true });
  const w = await handle.createWritable();
  await w.write(text);
  await w.close();
}

export async function writeBlob(root, path, blob) {
  const handle = await fileHandle(root, path, { create: true });
  const w = await handle.createWritable();
  await w.write(blob);
  await w.close();
}

export async function exists(root, path) {
  return (await getFile(root, path)) !== null;
}

/** Entries of a directory; [] if it is not there. */
export async function listDir(root, path) {
  let h;
  try {
    h = await dir(root, path);
  } catch (e) {
    if (e.name === 'NotFoundError') return [];
    throw e;
  }
  const out = [];
  for await (const [name, entry] of h.entries()) out.push({ name, kind: entry.kind });
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export const recordingPath = (name) => `${RECORDINGS_DIR}/${name}.mp4`;
export const transcriptPath = (name) => `${TRANSCRIPTS_DIR}/${name}.txt`;

/** Every path a run touches, derived from the webinar name. */
export function pathsFor(name) {
  const out = `${OUTPUT_DIR}/${slug(name)}`;
  return {
    out,
    clips: `${out}/clips`,
    panelists: `${out}/panelists`,
    targeted: `${out}/targeted`,
  };
}
```

- [ ] **Step 2: Verify in the browser**

Serve `web/`, then in the DevTools console (the picker needs a user gesture, so run this from a click — paste it into a button's handler, or call `pickRoot()` alone first and click through the picker):

```js
const fs = await import('/runtime/fsroot.js');
const root = await fs.pickRoot();                       // choose pipeline_one/
console.log(await fs.listDir(root, 'transcripts'));     // the five .txt files
console.log((await fs.readText(root, 'transcripts/Reflections on COP30.txt')).slice(0, 60));
await fs.writeText(root, 'output/_probe/hello.txt', 'ok');
console.log(await fs.exists(root, 'output/_probe/hello.txt'));  // true
```

Expected: the transcript list, the first line of a real transcript, and `true`. Delete `output/_probe/` afterwards. Reload the page and run `await (await import('/runtime/fsroot.js')).getRoot()` — expect one permission prompt, then a handle.

- [ ] **Step 3: Commit**

```bash
git add web/runtime/fsroot.js
git commit -m "Reach the work folder through the File System Access API"
```

---

### Task 8: `manifest-parse.js` and `manifest.js`

Reads a run folder back into what the review desk needs. The folder is the source of truth — not a record written at run time — which is why a hand-edited window shows up and why pre-markdown runs still open. Ported from `pipeline/manifest.py`.

**Files:**
- Create: `test/manifest-parse.test.js`, `web/runtime/manifest-parse.js`, `web/runtime/manifest.js`
- Read: `pipeline/manifest.py` (the source of truth for the shape it returns)

**Interfaces:**
- Consumes: `captionWindow` from `captions.js`; `fsroot` for the walking half.
- Produces:
  - `readCaption(text: string) -> {title, speaker, start, end, rationale, body}` — any field may be `null`
  - `readRun(root, slugName: string) -> Promise<object>` — the structure `app.js` renders today

- [ ] **Step 1: Write the failing tests**

`test/manifest-parse.test.js`:

```js
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/manifest-parse.test.js`
Expected: FAIL — `Cannot find module '../web/runtime/manifest-parse.js'`

- [ ] **Step 3: Write `web/runtime/manifest-parse.js`**

```js
/** Parse one caption file into its parts.
 *
 * Understands both the current markdown header and the older `# `-comment
 * header, because runs from earlier versions of the pipeline are still sitting
 * in output/. Anything unparseable comes back as null on that field rather than
 * raising — a reviewer's edit should never take the whole results page down.
 * Ported from pipeline/manifest.py. Pure — no browser globals.
 */

const MD_TITLE = /^#\s+(.*?)\s*$/m;
const MD_SPEAKER = /^\*\*Speaker:\*\*\s*(.*?)\s*$/m;
const MD_WINDOW = /^\*\*(\d{1,2}:\d{2}:\d{2})\s*[-–—]\s*(\d{1,2}:\d{2}:\d{2})\*\*(?:\s*[·.\-]\s*(.*?))?\s*$/m;
// Pre-markdown captions: three `# ` comment lines (title / window / rationale).
const TXT_HEADER = /^#\s*(.*?)\n#\s*(\d{1,2}:\d{2}:\d{2})\s*[-–—]\s*(\d{1,2}:\d{2}:\d{2})\s*\n(?:#\s*(.*?)\n)?/;

export function readCaption(text) {
  const legacy = TXT_HEADER.exec(text);
  if (legacy) {
    return {
      title: legacy[1].trim().replace(/^"|"$/g, ''),
      speaker: null,
      start: legacy[2],
      end: legacy[3],
      rationale: (legacy[4] || '').trim() || null,
      body: text.slice(legacy[0].length),
    };
  }

  const title = MD_TITLE.exec(text);
  const speaker = MD_SPEAKER.exec(text);
  const window = MD_WINDOW.exec(text);
  let body = text;
  if (window) body = text.slice(window.index + window[0].length);
  else if (title) body = text.slice(title.index + title[0].length);

  return {
    title: title ? title[1].trim() : null,
    speaker: speaker ? speaker[1].trim() : null,
    start: window ? window[1] : null,
    end: window ? window[2] : null,
    rationale: window && window[3] ? window[3].trim() : null,
    body,
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/manifest-parse.test.js`
Expected: PASS, 3 tests.

- [ ] **Step 5: Write `web/runtime/manifest.js`**

Open `pipeline/manifest.py` and match the object it returns field for field — `app.js` renders that shape today and must keep working. The walk is:

```js
/** Read an `output/<slug>/` folder back into the structure a reviewer needs.
 *
 * The folder on disk is the source of truth, not a record written at run time.
 * That matters because hand-editing a caption's time window is the documented
 * way to fix a bad clip — a manifest derived from the files always reflects what
 * a reviewer actually did. It also means runs from earlier versions of the
 * pipeline (.txt captions, no panelists/) still open.
 *
 * run.json, when present, carries only what the folder cannot know: the YouTube
 * source, the original webinar name, and when the run started.
 */

import { readCaption } from './manifest-parse.js';
import { listDir, readText, exists } from './fsroot.js';
import { OUTPUT_DIR } from './config.js';

export async function readRun(root, slugName) {
  const base = `${OUTPUT_DIR}/${slugName}`;
  const meta = JSON.parse((await readText(root, `${base}/run.json`)) || '{}');
  // ... walk clips/, panelists/<name>/, targeted/, and the one-pager, pairing
  // each `<base>_caption.md` with its `<base>.mp4` when one exists.
}
```

Fill in the walk so the result carries, for each clip: `base`, `group` (`'highlights'` or the panelist slug), the parsed caption fields, `hasVideo`, and the path of the caption and video relative to the run folder. Read `one-pager.md` (falling back to `one-pager.txt`) and each `targeted/<audience>.md`. Use `AUDIENCE_LABELS` from `manifest.py` verbatim.

- [ ] **Step 6: Verify against a real run folder**

Serve `web/`, pick `pipeline_one/` as the work folder, then:

```js
const m = await import('/runtime/manifest.js');
const fs = await import('/runtime/fsroot.js');
const root = await fs.getRoot();
console.log(await m.readRun(root, 'unlocking-the-future-of-food-in-africa'));
console.log(await m.readRun(root, 'the-future-of-meat'));   // pre-markdown run
```

Expected: the first returns clips with parsed windows and panelist groups; the second — a `.txt`-caption run with no `panelists/` — opens without throwing, which is the compatibility the module exists for.

- [ ] **Step 7: Commit**

```bash
git add test/manifest-parse.test.js web/runtime/manifest-parse.js web/runtime/manifest.js
git commit -m "Read a run folder back into the review structure"
```

---

### Task 9: `runner.js` and `run-worker.js`

The run itself, and the worker that hosts it. Ported from `pipeline/runner.py` and the parts of `pipeline/jobs.py` worth keeping. **Clips are not cut here** — the run is text only, per the spec.

**Files:**
- Create: `web/runtime/runner.js`, `web/runtime/run-worker.js`
- Read: `pipeline/runner.py:93-250`, `pipeline/jobs.py`

**Interfaces:**
- Consumes: `steps`, `transcript`, `captions.captionText`, `fsroot`, `slug`, `config`.
- Produces:
  - `runPipeline({root, name, youtube, transcript, segments, perPanelist, emit, signal}) -> Promise<{name, slug, out, clipsWritten, skipped}>`
  - Worker protocol: main thread posts `{type:'start', ...}` / `{type:'cancel'}`; worker posts the run's events verbatim, plus `{type:'done', summary}` and `{type:'error', message, hint, traceback}`.

- [ ] **Step 1: Write `web/runtime/runner.js`**

Follow `runner.py`'s stage order and emit the identical events. The differences from the Python, all from the spec:

- **No transcript lookup.** `transcript` is a required argument. Write it to `transcripts/<name>.txt` before parsing, so the folder stays the source of truth, then parse. Keep the cue check: no `[HH:MM:SS]` cues is still an error.
- **No ffmpeg.** `doClip` writes the caption only, and emits `{type:'clip', status:'caption', ...}`. The `MIN_CLIP_SEC` / out-of-range / empty-text skip stays exactly as it is — a degenerate window is still reported and skipped.
- **Resume.** Before each step, check whether its output already exists via `fsroot.exists`; if it does, emit the `done` stage with a `detail` of `'already written'` and skip the call. This is what replaces `jobs.py`'s in-memory history.
- **Cancel** is an `AbortSignal` instead of a `threading.Event`. Check it where `_check(cancelled)` is called and throw a `DOMException('Run cancelled', 'AbortError')`.

The stage keys, labels and order are unchanged: `transcript` → `one-pager` → `select` → `clips` → `targeted`, with `{type:'count', key:'clips', total}` emitted only once selection has returned.

- [ ] **Step 2: Write `web/runtime/run-worker.js`**

```js
/** The run worker: one run at a time, with the run's events forwarded to the
 *  page as they happen.
 *
 *  jobs.py kept a full event history so a browser reload mid-run could replay
 *  into the right state. A dedicated worker dies on reload, so that trick is
 *  gone — instead runner.js writes each artifact as it is produced and skips
 *  what already exists, which makes the output folder the checkpoint.
 */

import { runPipeline } from './runner.js';
import { setApiKey } from './llm.js';

let active = null;

self.onmessage = async (e) => {
  const msg = e.data;

  if (msg.type === 'cancel') {
    if (active) active.abort();
    return;
  }

  if (msg.type !== 'start') return;
  if (active) {
    self.postMessage({ type: 'error', message: 'A run is already going.',
                       hint: 'Wait for it to finish, or cancel it first.' });
    return;
  }

  active = new AbortController();
  setApiKey(msg.apiKey);
  try {
    const summary = await runPipeline({
      root: msg.root,
      name: msg.name,
      youtube: msg.youtube,
      transcript: msg.transcript,
      segments: msg.segments,
      perPanelist: msg.perPanelist,
      emit: (event) => self.postMessage(event),
      signal: active.signal,
    });
    self.postMessage({ type: 'done', summary });
  } catch (err) {
    self.postMessage({ type: 'error', ...describe(err) });
  } finally {
    active = null;
  }
};

/** jobs.py turned exceptions into a reviewer-facing message plus a hint, and
 *  kept the traceback for the collapsed developer view. Same job here. */
function describe(err) {
  const traceback = String(err && err.stack || err);
  if (err.name === 'AbortError') {
    return { message: 'Run cancelled.', hint: null, traceback };
  }
  if (/401|authentication/i.test(err.message)) {
    return { message: 'Anthropic rejected the API key.',
             hint: 'Check the key in settings.', traceback };
  }
  if (/429|rate limit/i.test(err.message)) {
    return { message: 'Anthropic rate-limited the run.',
             hint: 'Wait a minute and run again — finished steps are skipped.',
             traceback };
  }
  if (/No `\[HH:MM:SS\]`/.test(err.message)) {
    return { message: err.message,
             hint: 'The transcript needs one `[HH:MM:SS] text` line per cue.',
             traceback };
  }
  return { message: err.message || 'The run failed.', hint: null, traceback };
}
```

- [ ] **Step 3: Verify end to end against a real transcript**

Serve `web/`. In the console, start a run with a real transcript and watch the events:

```js
const fs = await import('/runtime/fsroot.js');
const root = await fs.getRoot();
const text = await fs.readText(root, 'transcripts/Reflections on COP30.txt');
const w = new Worker('/runtime/run-worker.js', { type: 'module' });
w.onmessage = (e) => console.log(e.data);
w.postMessage({ type: 'start', root, name: 'Reflections on COP30',
                transcript: text, segments: 4, perPanelist: 3,
                apiKey: await (await import('/runtime/store.js')).getApiKey() });
```

Expected: stage events in the order `transcript`, `one-pager`, `select`, `clips`, `targeted`; a `count` event carrying the clip total, arriving only after `select` finishes; one `clip` event per caption; then `done`. Afterwards `output/reflections-on-cop30/` holds `one-pager.md`, `clips/*_caption.md`, `panelists/*/`, `targeted/*.md` and no `.mp4` files.

Then post the same `start` message again. Expected: every stage reports `already written` and no API calls are made — that is the resume path.

- [ ] **Step 4: Commit**

```bash
git add web/runtime/runner.js web/runtime/run-worker.js
git commit -m "Run the pipeline in a worker, text-only, resuming from the output folder"
```

---

### Task 10: `api.js` and the input view — the first real end-to-end run

The front end starts driving the worker. This is the task that makes the tool usable.

**Files:**
- Rewrite: `web/api.js`
- Modify: `web/index.html`, `web/app.js`, `web/styles.css`

**Interfaces:**
- Consumes: `run-worker.js`'s protocol, `store`, `fsroot`.
- Produces: `api.startRun(opts, onEvent)`, `api.cancelRun()`, `api.pickFolder()`, `api.saveKey(key)`, `api.loadRun(slug)` — the same call sites `app.js` uses today.

- [ ] **Step 1: Rewrite `web/api.js`**

Keep the module's job exactly as its header states — the only thing that knows how the views reach the pipeline. Replace `fetch` and `EventSource` with a worker. `startRun` takes the same options and an `onEvent` callback, and the events arriving are the ones `app.js` already renders.

- [ ] **Step 2: Change the input view in `index.html`**

Three replacements, no new view:

- The upload control becomes a **"Choose work folder"** button plus a recording `<select>` filled from `listDir(root, 'webinar recordings')`. Nothing is uploaded or copied.
- A **transcript** control: a file `<select>` filled from `listDir(root, 'transcripts')`, plus a `<textarea>` to paste one. The run button stays disabled until a recording and a transcript are both chosen — this is where the removed existence check now lives.
- An **API key** field, written through `store.setApiKey`, shown masked once set.

The YouTube field stays, but its label changes: it is recorded in `run.json` and used for links back to the recording. It no longer fetches anything.

- [ ] **Step 3: Delete the upload and rename code from `app.js`**

`upload()`, `retitle()` and `showRecording()` exist because the server stored the recording under its title. There is no server and no copy now — the recording is chosen where it already lives. Remove all three and the `uploadbar` element; keep `note()` and `validate()`.

- [ ] **Step 4: Verify a full run through the UI**

Serve `web/`, open it, choose the work folder, pick `Unlocking the Future of Food in Africa` and its transcript, paste the API key, run.

Expected: the stage list advances exactly as it does against `server.py` today, the clip count appears only after selection, and the review desk opens on the finished run. Compare the generated `output/<slug>/one-pager.md` against a Python-generated one for shape — heading, then prose.

- [ ] **Step 5: Commit**

```bash
git add web/api.js web/index.html web/app.js web/styles.css
git commit -m "Drive the run from the page through the worker; choose inputs in place"
```

---

### Task 11: `cut.js` and `cut-worker.js`

The WebCodecs cut, built from `spike/cut.js`, which cut a verified frame-accurate 60-second clip in 12.3 seconds reading 4.2 MB of a 149 MB master.

**Files:**
- Create: `web/runtime/cut.js`, `web/runtime/cut-worker.js`
- Create: `web/vendor/mp4box.js`, `web/vendor/mp4-muxer.js`
- Read: `spike/cut.js` — the working reference

**Interfaces:**
- Consumes: a `File` (from `fsroot.getFile`).
- Produces:
  - `cut(file: File, startSec: number, endSec: number, onProgress?) -> Promise<Blob>`
  - Worker protocol: `{type:'cut', id, file, startSec, endSec}` in; `{type:'cut-done', id, blob}` or `{type:'cut-error', id, message}` out.

- [ ] **Step 1: Vendor the two libraries**

```bash
curl -L "https://cdn.jsdelivr.net/npm/mp4box@0.5.2/dist/mp4box.all.min.js" -o web/vendor/mp4box.js
curl -L "https://cdn.jsdelivr.net/npm/mp4-muxer@5.1.5/build/mp4-muxer.min.js" -o web/vendor/mp4-muxer.js
```

Both are UMD. In a module worker, load them with `importScripts`-free interop: `await import('../vendor/mp4-muxer.js')` will not give you the globals, so instead fetch and evaluate them at worker start, or switch to the packages' ESM builds if they resolve cleanly. Whichever route, the requirement is unchanged: **no network at runtime**.

- [ ] **Step 2: Port `spike/cut.js` into `web/runtime/cut.js`**

Take the spike file as the base and make three changes:

- Read from a `File` (byte ranges via `file.slice(start, end).arrayBuffer()`) instead of HTTP `Range` requests. The `fileStart` property on each buffer is what mp4box needs, unchanged.
- Drop the DOM logging; take an optional `onProgress(fraction)` callback instead.
- Keep **both spike findings**, each with the comment explaining it:
  - `const DS = MP4Box.DataStream || self.DataStream;` — the UMD build exports `DataStream` as its own global.
  - The audio probe. The container reports the AAC-LC core rate (22050 Hz in these masters); HE-AAC's SBR doubles it to 44100 Hz. Decode one frame, take `sampleRate` and `numberOfChannels` from the decoded `AudioData`, and configure **both** the `AudioEncoder` and the muxer's audio track from that. Configuring either from the container value throws *"Unsupported sample rate"*. Always encode to AAC-LC (`mp4a.40.2`).

- [ ] **Step 3: Write `web/runtime/cut-worker.js`**

A thin dispatcher: one cut at a time, reply with the `Blob` keyed by the request's `id`, and turn a throw into `{type:'cut-error', id, message}` rather than letting the worker die.

- [ ] **Step 4: Verify against the spike's recorded numbers**

Serve `web/`, pick the work folder, then:

```js
const fs = await import('/runtime/fsroot.js');
const root = await fs.getRoot();
const file = await fs.getFile(root, 'webinar recordings/Unlocking the Future of Food in Africa.mp4');
const { cut } = await import('/runtime/cut.js');
const t0 = performance.now();
const blob = await cut(file, 1800, 1860);
console.log((performance.now() - t0) / 1000, 'seconds,', blob.size, 'bytes');
await fs.writeBlob(root, 'output/_probe/cut.mp4', blob);
```

Expected: roughly 12 seconds and roughly 9.2 MB. Then confirm the file on disk:

```bash
ffprobe -v error -show_entries stream=codec_name,nb_frames,start_time -of default=nw=1 output/_probe/cut.mp4
ffmpeg -hide_banner -ss 1800 -t 2 -i "webinar recordings/Unlocking the Future of Food in Africa.mp4" -t 2 -i output/_probe/cut.mp4 -lavfi "[0:v][1:v]psnr=stats_file=-" -f null - 2>&1 | grep -o "average:[0-9.]*" | tail -1
```

Expected: 1500 video frames, 2584 audio frames, both `start_time=0`, and a PSNR around 47 dB — the spike's measured figures. A PSNR near 32 dB means the in-point is a second out and the frame-dropping logic is wrong. Delete `output/_probe/` afterwards.

- [ ] **Step 5: Commit**

```bash
git add web/runtime/cut.js web/runtime/cut-worker.js web/vendor/mp4box.js web/vendor/mp4-muxer.js
git commit -m "Cut clips with WebCodecs, frame-accurate, off the local master"
```

---

### Task 12: The review desk plays windows off the master

No file is produced until export. A clip is a seek, so re-windowing becomes instant — which is what replaces the `--no-clips` / `--cut-only` two-pass flow.

**Files:**
- Modify: `web/app.js`, `web/index.html`, `web/styles.css`
- Modify: `web/runtime/manifest.js` (a run with no `.mp4` files is now the normal case, not a degraded one)

**Interfaces:**
- Consumes: `fsroot.getFile`, `manifest.readRun`, `captions.captionText`.
- Produces: `playWindow(startSec, endSec)` inside `app.js`; an `onWindowChange(base, start, end)` path that rewrites the caption file's header.

- [ ] **Step 1: Point the player at the master**

Load the master once with `fsroot.getFile` and `URL.createObjectURL`. For a clip, set `currentTime = start + TRANSCRIPT_OFFSET_SEC` and stop at `end` with a `timeupdate` listener. One `<video>` element serves every clip; the timeline of the whole webinar that the review desk already draws is now literally the same media.

- [ ] **Step 2: Make the window editable**

Add start/end inputs (or drag handles on the existing timeline) per clip. On change: update the player immediately, and rewrite that caption file's header through `captions.captionText` + `fsroot.writeText`, preserving the body. The header is still where a window lives on disk, so a window edited in the UI and a window edited in a text editor are the same thing.

- [ ] **Step 3: Verify**

Open a finished run. Expected: every clip plays from the right moment with no `.mp4` on disk; nudging a window moves playback at once; the caption file's `**HH:MM:SS–HH:MM:SS**` line on disk carries the new window; reloading the page shows the edited window, because the manifest is read from the folder.

- [ ] **Step 4: Commit**

```bash
git add web/app.js web/index.html web/styles.css web/runtime/manifest.js
git commit -m "Play clip windows off the local master; make windows editable in place"
```

---

### Task 13: Export, PWA, and removing the Python

The last task: approved clips get encoded, the tool installs and runs offline, and the backend goes.

**Files:**
- Create: `web/runtime/zip.js`, `web/vendor/fflate.js`, `web/sw.js`, `web/manifest.webmanifest`
- Modify: `web/app.js`, `web/index.html`
- Delete: `server.py`, `run.py`, `pipeline/`
- Modify: `requirements.txt`, `CLAUDE.md`

**Interfaces:**
- Consumes: `cut-worker`, `fsroot`, `manifest`.
- Produces: `exportRun(root, slugName, {scope: 'all'|'clips'|'text', toFolder: boolean}) -> Promise<Blob|void>`

- [ ] **Step 1: Encode approved clips on export**

Walk the run's clips, send each window to the cut worker one at a time, and write the result with `fsroot.writeBlob` to `clips/<base>.mp4` or `panelists/<slug>/<base>.mp4` — the same paths the Python pipeline wrote, so the finished folder is indistinguishable. Emit progress per clip so the existing progress UI can render it.

- [ ] **Step 2: Write `web/runtime/zip.js`**

```bash
curl -L "https://cdn.jsdelivr.net/npm/fflate@0.8.2/esm/browser.js" -o web/vendor/fflate.js
```

Keep `bundle.py`'s three scopes exactly: `all` is the whole run folder, `clips` is the `.mp4` files, `text` is the markdown. Build the archive from the folder, not from memory, so what ships is what a reviewer sees.

- [ ] **Step 3: Add the PWA shell**

`web/manifest.webmanifest` with a name, `display: "standalone"` and an icon. `web/sw.js` caching every asset in `web/` on install and serving cache-first. Register it from `index.html`.

- [ ] **Step 4: Verify offline**

Load the page, install it, then turn on DevTools → Network → Offline and reload. Expected: the app loads fully and the work folder is still reachable after the one permission click. A run will fail at the first Anthropic call, which is correct — that is the one thing that needs the network.

- [ ] **Step 5: Delete the backend**

```bash
git rm -r pipeline server.py run.py
```

Keep `read_transcript.py` — it is the one remaining Python script, the standalone YouTube ingest, and it imports nothing from `pipeline/`. Cut `requirements.txt` down to what it needs: `youtube-transcript-api`. Note that the `prompts.py` drift test in Task 3 skips itself once the file is gone, by design.

- [ ] **Step 6: Rewrite `CLAUDE.md`**

It currently describes a FastAPI server, a CLI, ffmpeg and yt-dlp on PATH, and a two-pass production flow. All four are gone. The new version documents: the work folder, the three threads, cut-at-export, the two spike findings that the code depends on (the `DataStream` global and the HE-AAC sample-rate probe), the per-person API key, and the corrected note about the structured-output call not sharing the transcript cache.

- [ ] **Step 7: Run the full test suite and commit**

```bash
node --test
git add -A
git commit -m "Export cut clips and zips, install as a PWA, remove the Python backend"
```

---

## Self-Review

**Spec coverage.** Distribution → Task 13. Architecture/module map → Tasks 1–11. Storage → Tasks 6, 7. Resume → Task 9. LLM layer → Tasks 4, 5. Cut at export → Tasks 11, 12, 13. Export → Task 13. Transcript ingest and the removed existence check → Tasks 9, 10. What is deleted → Task 13. Spike findings → Tasks 4, 11. Testing → Tasks 1, 2, 3, 8 for the pure logic; named manual verifications elsewhere.

**Known soft spots, flagged rather than hidden.** Three steps describe shape and requirements instead of carrying complete code: Task 8 Step 5 (`manifest.js`'s walk), Task 10 Steps 1–3 (the view changes), Task 12 (the player). Each of those is a transcription of a file that is open in front of the implementer — `manifest.py`, `app.js` — and writing a second copy of several hundred lines here would go stale against the original. Every one names the exact source file and the exact behaviour to preserve. If an executing agent is working without those files, it should read them first, not improvise.

**Type consistency.** `slug()`, `parse()`, `toSeconds()`, `sliceText()`, `formatTimestamp()`, `captionText()`, `captionWindow()`, `readCaption()`, `readRun()`, `cut()`, `runPipeline()` are each defined once and referenced under that name throughout. `emit` takes the event objects listed in Global Constraints. The cut worker's `id`-keyed request/response pairing is used consistently in Tasks 11 and 13.
