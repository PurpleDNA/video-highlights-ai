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

// The window line, captured whole. The trailing group deliberately excludes
// newlines: an earlier version used `\s*` here, which crossed the blank line
// after the header and swallowed the first line of the body into the
// rationale, corrupting the index/length that manifest-parse.js slices on.
// Each time may carry a fraction (`01:04:11.5`): the review desk nudges a
// window by half a second (see transcript.js's formatWindowTime).
const WINDOW = /^\*\*(\d{1,2}:\d{2}:\d{2}(?:\.\d+)?)\s*[-–—]\s*(\d{1,2}:\d{2}:\d{2}(?:\.\d+)?)\*\*([^\r\n]*)/m;
// Captions written before the markdown switch put the window on a
// `# HH:MM:SS-...` comment line. Older runs in output/ must stay readable.
const WINDOW_LEGACY = /^#[ \t]*(\d{1,2}:\d{2}:\d{2}(?:\.\d+)?)[ \t]*[-–—][ \t]*(\d{1,2}:\d{2}:\d{2}(?:\.\d+)?)[ \t]*$/m;
// ` · rationale`, ` - rationale`, `. rationale`, or nothing at all — the
// separator and the rationale are both optional, because either can be
// edited away by hand without the window ceasing to be a window.
const RATIONALE = /^[ \t]*[·.\-]?[ \t]*(.*)$/;

/** The full window match: the times, the rationale that follows them on the
 *  same line, and where the matched line sits, so a caller can slice the body
 *  off after it. Returns null if there is no recognisable window.
 *  manifest-parse.js consumes this; captionWindow() is the narrow view. */
export function matchWindow(text) {
  const m = WINDOW.exec(text);
  if (m) {
    const tail = RATIONALE.exec(m[3]);
    const rationale = (tail ? tail[1] : '').trim();
    return {
      start: m[1], end: m[2], rationale: rationale || null,
      index: m.index, length: m[0].length,
    };
  }
  const legacy = WINDOW_LEGACY.exec(text);
  if (!legacy) return null;
  return {
    start: legacy[1], end: legacy[2], rationale: null,
    index: legacy.index, length: legacy[0].length,
  };
}

/** `text` with its caption body swapped for `caption`, the header — title,
 *  speaker, the window line and its rationale — kept byte-for-byte. This is
 *  what "regenerate captions" writes: the window may have been nudged by
 *  hand, and that edit lives only in this header, so rebuilding the file
 *  from selection.json (captionText) would silently undo it. null when
 *  there is no recognisable window to anchor on. */
export function replaceCaptionBody(text, caption) {
  const m = matchWindow(text);
  if (!m) return null;
  return `${text.slice(0, m.index + m.length)}\n\n${caption.trim()}\n`;
}

/** The window from a caption's header, or null if it is missing or malformed.
 *  Never throws: a reformatted header is reported and skipped, not fatal. */
export function captionWindow(text) {
  const m = matchWindow(text);
  return m ? { start: m.start, end: m.end } : null;
}

// Same patterns as above, plus the `d` flag so `.indices` gives the exact
// offsets of the two time groups — only rewriteWindow() needs that; adding
// it to WINDOW/WINDOW_LEGACY themselves would cost every matchWindow() call
// (every clip, every readRun) for a benefit only this one write path uses.
const WINDOW_D = new RegExp(WINDOW.source, `${WINDOW.flags}d`);
const WINDOW_LEGACY_D = new RegExp(WINDOW_LEGACY.source, `${WINDOW_LEGACY.flags}d`);

function spliceTimes(text, re, start, end) {
  const m = re.exec(text);
  if (!m || !m.indices) return null;

  // Only splice a window that is in the header region. The header ends at the
  // blank line (first \n\n sequence) that follows the title/speaker/window lines.
  // If a match falls after the header (in the body), fall through to insertWindowLine.
  // Search for two consecutive \n\n sequences: one after title, one after window.
  const headerBlockEnd = findHeaderEnd(text);
  if (m.index >= headerBlockEnd) return null;

  const [s1, e1] = m.indices[1];
  const [s2, e2] = m.indices[2];
  // Splice only the two time groups; everything between/around them —
  // the `**`/`–`/`##`s, the separator and rationale that may follow on the
  // same line, every other line in the file — passes through untouched.
  return text.slice(0, s1) + start + text.slice(e1, s2) + end + text.slice(e2);
}

function findHeaderEnd(text) {
  // A caption's header region is everything before the blank line that separates
  // the header (title, speaker, window) from the body. In a well-formed caption,
  // this is marked by a \n\n sequence. We look for the second \n\n (the first is
  // typically after the title); if it exists, the header ends there. Otherwise,
  // the header extends to the end of the text.
  const blank1 = text.indexOf('\n\n');
  if (blank1 === -1) return text.length;
  const blank2 = text.indexOf('\n\n', blank1 + 2);
  return blank2 === -1 ? text.length : blank2;
}

const SPEAKER_LINE = /^\*\*Speaker:\*\*.*$/m;
const TITLE_LINE = /^#[ \t]+.*$/m;

/** Insert a fresh window line into a caption that has none to rewrite — the
 *  one case rewriteWindow() below can't just splice in place, since there is
 *  no existing line to splice. Placed after the Speaker line (matching
 *  captionText()'s own layout), or after the title if there's no Speaker
 *  line, or at the very top if neither is there; everything else in the file
 *  is untouched either way. */
function insertWindowLine(text, start, end) {
  const line = `**${start}–${end}**\n`;
  const endOfLine = (m) => {
    const at = m.index + m[0].length;
    const nl = text.indexOf('\n', at);
    return nl === -1 ? text.length : nl + 1;
  };
  const speaker = SPEAKER_LINE.exec(text);
  if (speaker) {
    const at = endOfLine(speaker);
    return `${text.slice(0, at)}${line}\n${text.slice(at)}`;
  }
  const title = TITLE_LINE.exec(text);
  if (title) {
    const at = endOfLine(title);
    return `${text.slice(0, at)}\n${line}\n${text.slice(at)}`;
  }
  return `${line}\n${text}`;
}

/** Rewrite an existing caption's window in place, touching only the two time
 *  values — title, speaker, rationale (and its separator, even an already
 *  absent one), and anything a reviewer hand-added anywhere in the file stay
 *  byte-identical. Used by api.js's writeClipWindow in place of rebuilding
 *  the whole header from parsed fields via captionText(), which silently
 *  dropped hand-added content the parse didn't know about, rendered a
 *  missing rationale as a dangling "**…** · ", and — for a caption whose
 *  window couldn't be parsed at all — duplicated the "**Speaker:**" line,
 *  because the body it reused for reconstruction still contained the
 *  original one (readCaption falls back to slicing the body after the title
 *  when there's no window to slice after instead). Falls back to inserting a
 *  fresh window line only for that one case: a caption with no recognisable
 *  window to begin with, so there's nothing in place to splice. */
export function rewriteWindow(text, start, end) {
  const spliced = spliceTimes(text, WINDOW_D, start, end)
    ?? spliceTimes(text, WINDOW_LEGACY_D, start, end);
  return spliced ?? insertWindowLine(text, start, end);
}
