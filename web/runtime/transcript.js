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
/** A clip window's edge, as written into a caption header. Whole seconds
 *  stay `HH:MM:SS` — byte-identical to every caption written before
 *  fractions existed — and anything else gets one decimal (`HH:MM:SS.5`), the
 *  review desk's half-second nudge being the reason. Transcript cue stamps
 *  stay on formatTimestamp(): they are whole seconds by construction. */
export function formatWindowTime(seconds) {
  const tenths = Math.round(Number(seconds) * 10);
  const whole = formatTimestamp(Math.floor(tenths / 10));
  return tenths % 10 ? `${whole}.${tenths % 10}` : whole;
}

/** `HH:MM:SS` or `HH:MM:SS.s` -> seconds (the fraction rides along in `+s`). */
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
