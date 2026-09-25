/** Snap selected clip windows to sentence boundaries.
 *
 * WHY THIS EXISTS. `prompts.js`'s CLIPS asks the model to "snap start and end
 * to complete thoughts — never cut mid-sentence. Use the cue timestamps to
 * find clean boundaries." That instruction cannot be satisfied with the data
 * the model is given, which is why clips have always cut mid-sentence:
 *
 *   - The transcript it reads is `[HH:MM:SS] A: text` lines. Every timestamp
 *     in it is a CUE START, and `transcribe.js`'s wordsToCues() breaks a cue
 *     on a speaker change or after 3000ms — pure time slicing, with no
 *     relationship to where a sentence begins or ends.
 *   - So the set of timestamps the model may "copy verbatim" mostly does not
 *     contain sentence starts, and — this is the sharper half — it contains
 *     essentially no sentence ENDS at all. A sentence's end time is a word's
 *     end time, and no word end time appears anywhere in that document.
 *
 * No amount of prompt work fixes that; the value simply is not on the page.
 * The fix is to let the model choose the moment it means, then move the
 * window to the nearest real boundary here, in code, deterministically.
 *
 * TWO TIERS, because not every transcript has word timings:
 *
 *   - AssemblyAI runs: `transcripts/<name>.words.json` holds every word with
 *     `start`/`end` in ms and AssemblyAI punctuates by default, so boundaries
 *     are exact.
 *   - A pasted transcript or the YouTube fetch: only cue starts exist, so a
 *     boundary is "the start of a cue whose previous cue ended on terminal
 *     punctuation" — accurate to one cue, and biased toward including a beat
 *     of silence rather than clipping a word.
 *
 * With neither available, nothing is snapped and the model's own choice
 * stands, exactly as before this module existed.
 *
 * Pure — no fsroot, no network, no browser globals — so all of it is unit
 * tested directly (see test/snap.test.js).
 */

/** Terminal punctuation, allowing a trailing quote or bracket: `end."` and
 *  `end.)` are sentence ends too. A comma or a dash is not. */
const TERMINAL = /[.?!]["'”’)\]]*$/;

/** The diarization label AssemblyAI cues carry (`A: `, `B: `). Stripped
 *  before testing punctuation so a label never hides the previous cue's
 *  final stop. Same shape subtitles.js strips, kept separate because this
 *  module must not depend on the burn-in path. */
const SPEAKER_PREFIX = /^[A-Z]{1,2}:\s+/;

function endsSentence(text) {
  return TERMINAL.test(String(text || '').replace(SPEAKER_PREFIX, '').trim());
}

/** Exact sentence boundaries, in seconds, from AssemblyAI word timings.
 *  `starts` are the first word of each sentence; `ends` are the last word's
 *  end, which is the value the cue list can never supply. */
export function boundariesFromWords(words) {
  const starts = [];
  const ends = [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (w.start == null || w.end == null) continue;
    if (i === 0 || endsSentence(words[i - 1].text)) starts.push(w.start / 1000);
    if (i === words.length - 1 || endsSentence(w.text)) ends.push(w.end / 1000);
  }
  return { starts, ends };
}

/** Approximate boundaries from cues alone, for a transcript with no word
 *  timings. `cues` are transcript.js's `{seconds, text}`.
 *
 *  A cue that follows a cue ending in terminal punctuation begins a new
 *  sentence, so its start is both a sentence start and — near enough — the
 *  end of the one before it. Using the NEXT cue's start as the previous
 *  sentence's end deliberately overshoots by up to a cue: it ends the clip
 *  on a beat of silence rather than a syllable early. */
export function boundariesFromCues(cues) {
  const starts = [];
  const ends = [];
  for (let i = 0; i < cues.length; i++) {
    if (i === 0) { starts.push(cues[i].seconds); continue; }
    if (endsSentence(cues[i - 1].text)) {
      starts.push(cues[i].seconds);
      ends.push(cues[i].seconds);
    }
  }
  const last = cues[cues.length - 1];
  if (last && !ends.includes(last.seconds)) ends.push(last.seconds);
  return { starts, ends };
}

/** The boundary nearest `t` within `tolerance`, or null. `preferAfter` breaks
 *  the choice in favour of a boundary at or after `t` when both sides are in
 *  range — used for a clip's end, so a thought still in progress is finished
 *  rather than truncated a word early. */
function nearest(list, t, tolerance, preferAfter = false) {
  const inRange = list.filter((b) => Math.abs(b - t) <= tolerance);
  if (!inRange.length) return null;
  if (preferAfter) {
    const after = inRange.filter((b) => b >= t);
    if (after.length) return Math.min(...after);
  }
  return inRange.reduce((a, b) => (Math.abs(b - t) < Math.abs(a - t) ? b : a));
}

/** Default: 2.5s, comfortably under the ~3.2s median cue gap, so a snap can
 *  never slide a window past a whole cue into a different thought. */
export const DEFAULT_TOLERANCE = 2.5;

/** Move one `{start, end}` (seconds) onto sentence boundaries. Returns the
 *  window unchanged when no boundary is close enough, and refuses any snap
 *  that would invert the window or take it under `minSec` — a tidier cut is
 *  not worth turning a valid clip into one runner.js then skips. */
export function snapWindow(start, end, bounds, { tolerance = DEFAULT_TOLERANCE, minSec = 5 } = {}) {
  const s = nearest(bounds.starts, start, tolerance);
  const e = nearest(bounds.ends, end, tolerance, true);
  const newStart = s === null ? start : s;
  const newEnd = e === null ? end : e;
  if (newEnd - newStart < minSec || newEnd <= newStart) {
    return { start, end, snapped: false };
  }
  return { start: newStart, end: newEnd, snapped: newStart !== start || newEnd !== end };
}
