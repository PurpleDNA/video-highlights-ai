/** A per-run troubleshooting log: output/<slug>/run-log.txt.
 *
 * Everything a run emits for the screen is gone once the page moves on, and
 * the failure that prompted this — audio extraction silently keeping 25s of
 * a 96-minute recording — never showed on screen at all. So the run worker
 * (runner.js) and the export path (api.js) both append here as they go:
 * every progress event, every model call's timing and token use, the facts
 * about the recording, audio and transcript that would have caught that
 * failure, and full error stacks. Each attempt (a first run, a resume, an
 * export) adds to the same file under its own header, oldest first.
 *
 * Never logged: API keys and transcript text. The file sits in the run's
 * folder in OPFS beside run.json and, like it, is bookkeeping — zip.js
 * leaves it out of every download, and the review desk's "Download log"
 * button is the way to get at it.
 *
 * Logging must never break what it observes: every write is best-effort,
 * and a failed one is dropped rather than thrown.
 *
 * The formatting half is pure and tested (test/runlog.test.js); the writer
 * half needs OPFS.
 */

import { readText, writeText } from './fsroot.js';
import { OUTPUT_DIR } from './config.js';

export const LOG_FILE = 'run-log.txt';

export const logPath = (slugName) => `${OUTPUT_DIR}/${slugName}/${LOG_FILE}`;

/** `ISO-time LEVEL message`, the level padded so messages line up. */
export function formatLine(level, message, at = new Date()) {
  return `${at.toISOString()} ${level.toUpperCase().padEnd(5)} ${message}`;
}

/** One run event (runner.js / export.js's shapes) as one line of text. */
export function describeEvent(e) {
  switch (e.type) {
    case 'stage':
      return [`stage ${e.key} ${e.status}`, e.label, e.detail].filter(Boolean).join(' — ');
    case 'count':
      return `count ${e.key}: ${e.total}`;
    case 'clip':
      return [`clip ${e.status} ${e.base || ''}`.trim(), e.title, e.start, e.reason]
        .filter(Boolean).join(' — ');
    case 'note':
      return e.message;
    default:
      return JSON.stringify(e);
  }
}

export function levelOf(e) {
  if (e.type === 'note' && e.level === 'warn') return 'warn';
  if (e.type === 'clip' && e.status === 'skipped') return 'warn';
  if ((e.type === 'clip' && e.status === 'error') || (e.type === 'stage' && e.status === 'failed')) {
    return 'error';
  }
  return 'info';
}

function clock(seconds) {
  const s = Math.max(0, Math.round(seconds));
  const pad = (n) => String(n).padStart(2, '0');
  const h = Math.floor(s / 3600);
  const m = Math.floor(s / 60) % 60;
  return h ? `${h}:${pad(m)}:${pad(s % 60)}` : `${m}:${pad(s % 60)}`;
}

/** A warning when `gotSec` covers less than `min` of `expectedSec`, else
 *  null. The guard the truncated-audio failure needed: compare what came
 *  out against how long the recording actually is. `min` defaults to 75%
 *  so ordinary trailing silence after the last word never trips it. */
export function coverageWarning(label, gotSec, expectedSec, min = 0.75) {
  if (!(expectedSec > 0) || gotSec == null) return null;
  const ratio = gotSec / expectedSec;
  if (ratio >= min) return null;
  return `${label} covers ${clock(gotSec)} of ${clock(expectedSec)} (${Math.floor(ratio * 100)}%) `
    + '— most of the recording is missing. Check the recording file before trusting this run.';
}

/** A log for one run folder. Lines buffer in memory and are appended to the
 *  file on flush() — called by the caller at natural checkpoints (stage
 *  ends, warnings, the end of an attempt) rather than on every line, so a
 *  run of hundreds of events costs a handful of writes. Flushes are chained,
 *  so two never interleave. */
export function createRunLog(root, slugName) {
  const path = logPath(slugName);
  let pending = [];
  let chain = Promise.resolve();

  const add = (level, message) => { pending.push(formatLine(level, message)); };

  const flush = () => {
    chain = chain.then(async () => {
      if (!pending.length) return;
      const lines = pending;
      pending = [];
      const prior = (await readText(root, path)) || '';
      await writeText(root, path, `${prior}${lines.join('\n')}\n`);
    }).catch(() => { /* best-effort: a lost log line must never fail a run */ });
    return chain;
  };

  return {
    info: (m) => add('info', m),
    warn: (m) => add('warn', m),
    error: (m) => add('error', m),
    /** A blank line and a banner, so attempts are easy to tell apart. */
    header(title) { pending.push('', `==== ${title} ====`); },
    /** Log one emitted event, flushing on the ones worth keeping even if the
     *  tab dies a moment later. */
    event(e) {
      const level = levelOf(e);
      add(level, describeEvent(e));
      if (level !== 'info' || (e.type === 'stage' && e.status !== 'running')) flush();
    },
    flush,
  };
}
