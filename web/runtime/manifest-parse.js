/** Parse one caption file into its parts.
 *
 * Understands both the current markdown header and the older `# `-comment
 * header, because runs from earlier versions of the pipeline are still sitting
 * in output/. Anything unparseable comes back as null on that field rather than
 * raising — a reviewer's edit should never take the whole results page down.
 *
 * The time window itself is owned by captions.js's matchWindow() — it already
 * has to read back a hand-edited window for the re-cut path, and a second copy
 * of that regex here is exactly how that repair path would break silently.
 * This module only adds what matchWindow() can't know: the title, the speaker,
 * and — for the pre-markdown format — the rationale that rides on its own
 * comment line rather than trailing the window.
 *
 * Ported from pipeline/manifest.py. Pure — no browser globals.
 */

import { matchWindow } from './captions.js';

// `# Title` — the first such line in the file, current and legacy alike.
const TITLE = /^#\s+(.*?)\s*$/m;
const SPEAKER = /^\*\*Speaker:\*\*\s*(.*?)\s*$/m;
// The pre-markdown window line is a `#` comment; matchWindow() knows that much
// but (rightly) not the standalone `# rationale` comment line that can follow
// it, since captionText() never wrote such a line for the current format.
const LEGACY_RATIONALE = /^\r?\n#\s*(.*?)\s*\r?\n/;

export function readCaption(text) {
  const titleMatch = TITLE.exec(text);
  const speakerMatch = SPEAKER.exec(text);
  const window = matchWindow(text);

  let title = titleMatch ? titleMatch[1].trim() : null;
  let rationale = window ? window.rationale : null;
  let bodyStart = 0;

  if (window) {
    bodyStart = window.index + window.length;
    if (text[window.index] === '#') {
      // Legacy header: strip a quoted title the old writer used to add, and
      // look for the third comment line carrying the rationale.
      title = title ? title.replace(/^"+|"+$/g, '') : title;
      const tail = LEGACY_RATIONALE.exec(text.slice(bodyStart));
      if (tail) {
        rationale = tail[1].trim() || null;
        bodyStart += tail[0].length;
      }
    }
  } else if (titleMatch) {
    bodyStart = titleMatch.index + titleMatch[0].length;
  }

  return {
    title,
    speaker: speakerMatch ? speakerMatch[1].trim() : null,
    start: window ? window.start : null,
    end: window ? window.end : null,
    rationale,
    body: text.slice(bodyStart),
  };
}
