/** Burned-in subtitles for exported clips.
 *
 * Clips go to social, where they autoplay muted, so subtitles are the default
 * expectation rather than an extra. Burning them into the pixels is the only
 * option that survives being re-uploaded to LinkedIn, X or Instagram, none of
 * which carry a sidecar track.
 *
 * Plain blocks, not word-level highlight: the cues the pipeline already stores
 * are ~3.2s apart, which is close to a natural subtitle's length, so a block
 * per cue needs no extra data. AssemblyAI's per-word timings would allow
 * highlight-as-spoken later — see docs/backlog.md — but that is a different
 * feature, not a better version of this one.
 *
 * The pure half of this module (window slicing, prefix stripping, wrapping)
 * is separated from the drawing so it can be tested without a canvas.
 */

/** AssemblyAI cues carry a diarization label — `A: `, `B: ` — because
 *  select_clips uses it to attribute a clip to a panelist. On screen it is
 *  noise: a clip is one person talking and the label is not their name. */
const SPEAKER_PREFIX = /^[A-Z]:\s+/;

export function stripSpeaker(text) {
  return text.replace(SPEAKER_PREFIX, '');
}

/** The cues that overlap [startSec, endSec], re-timed so 0 is the clip's first
 *  frame. Each runs until the next one starts, or to the end of the clip.
 *
 *  A cue that began before the window still shows: someone mid-sentence when
 *  the clip opens should have their words on screen, not a blank plate until
 *  the next cue lands. */
export function cuesForWindow(cues, startSec, endSec) {
  const out = [];
  for (let i = 0; i < cues.length; i++) {
    const begins = cues[i].seconds;
    const ends = i + 1 < cues.length ? cues[i + 1].seconds : endSec;
    if (ends <= startSec || begins >= endSec) continue;
    const text = stripSpeaker(cues[i].text).trim();
    if (!text) continue;
    out.push({
      start: Math.max(0, begins - startSec),
      end: Math.min(endSec, ends) - startSec,
      text,
    });
  }
  return out;
}

/** The cue covering `t` seconds into the clip, or null. Linear because a clip
 *  holds a few dozen cues at most and the caller asks once per frame. */
export function cueAt(entries, t) {
  for (const e of entries) if (t >= e.start && t < e.end) return e;
  return null;
}

/** Break `text` into at most `maxLines` lines that each fit `maxWidth`,
 *  measured with the caller's context. The last line absorbs any overflow
 *  rather than dropping words — a clipped word is worse than a long line. */
export function wrapLines(measure, text, maxWidth, maxLines = 2) {
  const words = text.split(/\s+/).filter(Boolean);
  const lines = [];
  let line = '';

  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (line && measure(candidate) > maxWidth) {
      lines.push(line);
      line = word;
      if (lines.length === maxLines - 1) {
        // Everything left goes on the final line.
        const rest = words.slice(words.indexOf(word) + 1);
        lines.push(rest.length ? `${word} ${rest.join(' ')}` : word);
        return lines;
      }
    } else {
      line = candidate;
    }
  }
  if (line) lines.push(line);
  return lines.slice(0, maxLines);
}

/** Type scale for a frame of this height. The masters are 640x360 and the
 *  result is watched on a phone at 2-3x that, so the size is set as a
 *  fraction of the frame rather than in absolute pixels. */
export function metrics(width, height) {
  // Tuned down twice by eye: 0.075 -> 0.072 -> 0.055. On a 360p master that
  // is 27 -> 26 -> 20px. The earlier values read as oversized once burned in
  // and scaled up on a phone; ~5.5% of frame height is roughly where social
  // captions sit. The 16px floor is legibility, not taste — below a ~290px
  // frame the fraction would go under it.
  const font = Math.max(16, Math.round(height * 0.055));
  return {
    font,
    // "Bold white, heavy — but not too much outline." A stroke at ~12% of the
    // cap height reads as a clean edge against video; heavier starts to look
    // like a cartoon.
    stroke: Math.max(2, font * 0.12),
    lineHeight: Math.round(font * 1.22),
    maxWidth: width * 0.86,
    // Lowered twice as well: 0.88 -> 0.91 -> 0.94. With the smaller type the
    // last line's descenders now land around 95% of frame height, so there
    // is still a margin, but this is close to the floor — these clips are
    // 16:9, and a vertical crop for Reels/TikTok would put platform UI over
    // the bottom of the frame and start hiding text.
    baseline: Math.round(height * 0.94),
  };
}

/** Draw one cue's text onto a 2D context sized to the frame. */
export function drawCue(ctx, text, width, height, fontFamily) {
  const m = metrics(width, height);
  ctx.save();
  ctx.font = `700 ${m.font}px ${fontFamily}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  ctx.lineJoin = 'round';
  ctx.miterLimit = 2;

  const lines = wrapLines((s) => ctx.measureText(s).width, text, m.maxWidth);
  const top = m.baseline - (lines.length - 1) * m.lineHeight;

  lines.forEach((line, i) => {
    const y = top + i * m.lineHeight;
    ctx.lineWidth = m.stroke;
    ctx.strokeStyle = 'rgba(0, 0, 0, .85)';
    ctx.strokeText(line, width / 2, y);
    ctx.fillStyle = '#FFFFFF';
    ctx.fillText(line, width / 2, y);
  });

  ctx.restore();
}
