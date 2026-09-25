/** Fetch a webinar's transcript from its YouTube link, without a backend.
 *
 * Why a third-party service and not YouTube directly: YouTube's caption
 * endpoints send no CORS headers, so no browser script can read them. That is
 * the whole reason `read_transcript.py` survived the port. A proxy of our own
 * does not solve it either — YouTube answers datacenter IPs with
 * `RequestBlocked`, measured on a real Fly deploy (see `transcript-proxy/`).
 * youtube-transcript.ai already does that scraping and re-serves it with
 * `Access-Control-Allow-Origin: *`, which is the one thing that makes this
 * reachable from the page.
 *
 * WHAT IT COSTS, measured against a real webinar whose transcript we already
 * had on disk ("Unlocking the Future of Food in Africa", 1:23:42):
 *
 *   granularity   the service merges cues into ~31s blocks; the Python
 *                 fetcher produced ~3s cues. 162 lines where we had 1,911.
 *                 This is NOT recoverable — the service exposes no finer
 *                 format (json/srt/vtt all 404). It means a clip window is
 *                 anchored to a 31s grid, so a reviewer will nudge some
 *                 windows in the review desk. That is survivable only because
 *                 windows are now editable in place; in the old two-pass CLI
 *                 flow it would not have been.
 *
 *   duplication   YouTube's rolling captions repeat each caption LINE 2-3
 *                 times consecutively, and the last line of one block reopens
 *                 the next. Raw, that is 38,402 words where the real speech is
 *                 12,881 — you would pay Opus to read everything three times
 *                 and blunt its comprehension doing it. normalise() below
 *                 takes it to 13,124 (within 2% of the real figure).
 *
 * Output is `[HH:MM:SS] text`, one line per cue — exactly what transcript.js
 * parses and what `transcripts/*.txt` already holds, so nothing downstream
 * changes.
 */

const SERVICE = 'https://youtube-transcript.ai/transcript';

/** Blocks look like `[0:02] text` or `[1:02:33] text` — note the service does
 *  NOT zero-pad, so its output would not parse against transcript.js's
 *  `\[(\d{2}):(\d{2}):(\d{2})\]` without the padding done in normalise(). */
const BLOCK = /^\[(\d{1,2}:\d{2}(?::\d{2})?)\][ \t]*(.*)$/gm;

const ENTITIES = {
  '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"',
  '&#39;': "'", '&apos;': "'", '&nbsp;': ' ',
};

function decodeEntities(text) {
  return text.replace(/&(amp|lt|gt|quot|#39|apos|nbsp);/g, (m) => ENTITIES[m] ?? m);
}

/** '1:02:33' or '2:07' -> seconds. */
function toSeconds(stamp) {
  const parts = stamp.split(':').map(Number);
  return parts.length === 2
    ? parts[0] * 60 + parts[1]
    : parts[0] * 3600 + parts[1] * 60 + parts[2];
}

function pad(seconds) {
  const s = Math.floor(seconds);
  const two = (n) => String(n).padStart(2, '0');
  return `${two(Math.floor(s / 3600))}:${two(Math.floor(s / 60) % 60)}:${two(s % 60)}`;
}

/** Collapse consecutive repeated runs of words.
 *
 *  YouTube's rolling captions repeat each caption line 2-3 times in a row, so
 *  the repeats are always adjacent. The hard part is telling them from real
 *  speech: people genuinely say "it's it's" and "our our", and destroying
 *  those would be worse than leaving a duplicate in.
 *
 *  Run length alone does not separate them — measured on a real webinar, 51
 *  two-word fragments repeat as caption noise ("working. Uh, working. Uh,
 *  working. Uh,", ">> Yes. >> Yes. >> Yes."). What separates them is the
 *  COPY COUNT: a spoken stutter is two copies, caption duplication of a short
 *  fragment is three. So a long run (>= `longRun`) collapses at two copies,
 *  and anything shorter needs three before it is treated as noise.
 *
 *  Longest run wins, so a short accidental match inside a long repeated line
 *  cannot cut that line in half. */
export function collapseRuns(words, longRun = 3, maxRun = 40) {
  const out = [];
  let i = 0;
  const eq = (a, b, n) => {
    for (let k = 0; k < n; k++) if (words[a + k] !== words[b + k]) return false;
    return true;
  };
  const copiesAt = (start, n) => {
    let copies = 1;
    while (start + (copies + 1) * n <= words.length && eq(start, start + copies * n, n)) copies++;
    return copies;
  };

  while (i < words.length) {
    let run = 0;
    let copies = 1;
    const limit = Math.min(maxRun, Math.floor((words.length - i) / 2));
    for (let n = limit; n >= 1; n--) {
      if (!eq(i, i + n, n)) continue;
      const c = copiesAt(i, n);
      if (n >= longRun ? c >= 2 : c >= 3) { run = n; copies = c; break; }
    }
    if (run) {
      for (let k = 0; k < run; k++) out.push(words[i + k]);
      i += copies * run;
    } else {
      out.push(words[i]);
      i++;
    }
  }
  return out;
}

/** The rolling window spans block boundaries too: the tail of one block
 *  reappears as the head of the next. Drop the longest such repeat. */
export function dropOverlap(prev, cur, maxOverlap = 40, minOverlap = 3) {
  const limit = Math.min(maxOverlap, prev.length, cur.length);
  for (let n = limit; n >= minOverlap; n--) {
    let same = true;
    for (let k = 0; k < n; k++) {
      if (prev[prev.length - n + k] !== cur[k]) { same = false; break; }
    }
    if (same) return cur.slice(n);
  }
  return cur;
}

/** The service's markdown -> `[HH:MM:SS] text` lines, deduplicated.
 *  Pure: no network, no browser globals. */
export function normalise(markdown) {
  const split = markdown.split('## Transcript');
  const body = split.length > 1 ? split.slice(1).join('## Transcript') : markdown;

  const lines = [];
  let prev = [];
  for (const m of body.matchAll(BLOCK)) {
    const words = dropOverlap(prev, collapseRuns(decodeEntities(m[2]).split(/\s+/).filter(Boolean)));
    if (!words.length) continue;
    lines.push(`[${pad(toSeconds(m[1]))}] ${words.join(' ')}`);
    prev = words;
  }
  return lines.length ? lines.join('\n') + '\n' : '';
}

/** Fetch and normalise. Throws with a reviewer-facing message — this is one of
 *  the few places a run depends on somebody else's uptime, so the failure has
 *  to say so plainly and point at the paste box. */
export async function fetchTranscript(videoId, { signal } = {}) {
  let res;
  try {
    res = await fetch(`${SERVICE}/${encodeURIComponent(videoId)}.txt`, { signal });
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    throw new Error(
      'Could not reach the transcript service. Check the connection, or paste '
      + 'the transcript in instead.');
  }
  if (!res.ok) {
    throw new Error(
      res.status === 404
        ? 'No transcript for that video — YouTube may have captions disabled on it. '
          + 'Paste the transcript in instead.'
        : `The transcript service answered ${res.status}. Paste the transcript in instead.`);
  }

  const text = normalise(await res.text());
  if (!text) {
    throw new Error(
      'The transcript service returned nothing usable for that video. '
      + 'Paste the transcript in instead.');
  }
  return text;
}
