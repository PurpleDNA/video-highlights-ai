// Every call the page makes to run the pipeline lives here. Nothing else in
// the page talks to the run worker, the API-key store, OPFS or the mirror
// folder directly, so the shape of "the backend" — now a Worker plus the
// Origin Private File System, no server — is changeable in one file.

import * as fsroot from './runtime/fsroot.js';
import { readRun, listRuns } from './runtime/manifest.js';
import { rewriteWindow } from './runtime/captions.js';
import { formatWindowTime } from './runtime/transcript.js';
import { fetchTranscript as fetchFromYouTube } from './runtime/transcript-fetch.js';
import { setApiKey } from './runtime/store.js';
import { exportRun } from './runtime/export.js';
import { createRunLog, logPath } from './runtime/runlog.js';

let worker = null;
let root = null;        // OPFS — the source of truth, always available once fetched once
let mirror = null;      // the optional "also save to a folder" handle, or null
// The webinar recording, held only for this session — see fsroot.js's module
// comment: ~150MB, one click to re-pick, never worth copying into OPFS.
// `masterName` is whatever webinar name this File is currently bound to (the
// picked file's own name for a fresh run, or the run's own name when
// re-picked to unlock playback/export on a reopened run — see
// pickRecording()/attachMasterFor() below), so a File picked for one webinar
// is never silently used to cut clips for a different one.
let master = null;
let masterName = null;
// The master's duration in seconds, as the input view's poster preview read
// it from <video> metadata — null until then, or for a re-picked master.
let masterSec = null;

// Errors no run log can catch, kept for this session and put at the top of
// a downloaded log: uncaught page errors, and the run worker failing to load
// at all — which otherwise leaves the run view waiting on events that will
// never come.
const pageErrors = [];
const MAX_PAGE_ERRORS = 50;

function notePageError(text) {
  pageErrors.push(`${new Date().toISOString()} ${text}`);
  if (pageErrors.length > MAX_PAGE_ERRORS) pageErrors.shift();
}

addEventListener('error', (e) => {
  notePageError(`error: ${e.message} (${e.filename || '?'}:${e.lineno || '?'})`);
});
addEventListener('unhandledrejection', (e) => {
  notePageError(`unhandled rejection: ${(e.reason && e.reason.stack) || e.reason}`);
});

function ensureWorker() {
  if (!worker) {
    worker = new Worker(new URL('./runtime/run-worker.js', import.meta.url), { type: 'module' });
    worker.addEventListener('error', (e) => {
      notePageError(`run worker: ${e.message || 'failed to load'} (${e.filename || '?'}:${e.lineno || '?'})`);
    });
  }
  return worker;
}

async function ensureRoot() {
  if (!root) root = await fsroot.getRoot();
  return root;
}

const extOf = (ext) => (entry) => entry.kind === 'file' && entry.name.toLowerCase().endsWith(ext);
const stripExt = (ext) => (entry) => entry.name.slice(0, -ext.length);

export const api = {
  /** OPFS is always there — no folder to choose, no permission prompt.
   *  Called once at boot; returns the same shape listInputs() does, for the
   *  transcript picker (existing transcripts are whatever earlier runs
   *  already wrote into OPFS — see runner.js). */
  async init() {
    await ensureRoot();
    return api.listInputs();
  },

  /** Bind `file` as this session's master recording, naming it from the
   *  file's own name (stripped of its extension) — the same convention the
   *  old recordings-folder dropdown used. Used by the input view's file
   *  picker, before a run exists yet. Returns the derived webinar name. */
  pickRecording(file) {
    master = file;
    masterSec = null;
    masterName = file.name.replace(/\.[^./]+$/, '');
    return masterName;
  },

  /** Bind `file` as the master for an already-named run — used when
   *  reopening a finished run whose master isn't loaded this session (see
   *  app.js's "pick the recording again" control). Unlike pickRecording(),
   *  the name comes from the run, not the file, since a reviewer re-picking
   *  a file for a specific run is exactly the trust a folder-based lookup
   *  used to provide by path. */
  attachMasterFor(name, file) {
    master = file;
    masterSec = null;
    masterName = name;
  },

  /** The picked recording's duration, once the page has read it. Carried
   *  into the run so its log can compare the transcript against it. */
  noteRecordingDuration(seconds) {
    masterSec = Number.isFinite(seconds) ? seconds : null;
  },

  /** Rebind the picked recording to a name the reviewer typed in place of
   *  the one derived from its file name, before a run exists — so the run,
   *  its folder and masterUrl()/exportRun()'s name match all agree on it. */
  renameRecording(name) {
    if (master) masterName = name;
  },

  /** Whether a master recording is loaded this session, and (if so) which
   *  webinar name it's bound to — app.js uses this to decide whether to show
   *  a "pick the recording again" prompt instead of the player. */
  hasMaster: () => !!master,
  masterName: () => masterName,

  /** Open the optional mirror folder with the native picker — "also save to
   *  a folder." Never required: everything else already works against OPFS
   *  alone. */
  async pickMirror() {
    mirror = await fsroot.pickMirror();
    return true;
  },

  /** Reuse the remembered mirror folder if its permission is still granted,
   *  without ever falling back to the native picker — meant for boot, where
   *  there is no user gesture to show one anyway. Returns whether a mirror
   *  is now attached. */
  async restoreMirror() {
    mirror = await fsroot.getMirror();
    return !!mirror;
  },

  hasMirror: () => !!mirror,

  /** The transcripts already written into OPFS by earlier runs (runner.js
   *  writes transcripts/<name>.txt as it works — see runner.js's module
   *  comment), for the "existing transcript" picker. Recordings are never
   *  listed here any more — the master is a per-session file pick, not a
   *  folder entry (see pickRecording above); `recordings` is kept in the
   *  return shape only so callers that still destructure it don't break. */
  async listInputs() {
    await ensureRoot();
    const tDir = await fsroot.listDir(root, 'transcripts');
    return {
      recordings: [],
      transcripts: tDir.filter(extOf('.txt')).map(stripExt('.txt')).sort(),
    };
  },

  /** The webinar folders already under output/, for the "earlier runs" list.
   *  Returns full summaries (name, created, source, counts, bytes), newest first. */
  async listRuns() {
    await ensureRoot();
    return listRuns(root);
  },

  /** Delete one run's whole output folder (output/<slug>/) from OPFS. The
   *  transcript under transcripts/ is deliberately kept: it was paid for
   *  (AssemblyAI), and a re-run of the same recording reuses it instead of
   *  transcribing again. The optional mirror folder is never touched — what
   *  was exported there belongs to the reviewer now. */
  async deleteRun(slugName) {
    await ensureRoot();
    await fsroot.remove(root, `output/${slugName}`);
  },

  /** The text of an existing transcript file on disk, by webinar name. */
  readTranscript(name) {
    return fsroot.readText(root, fsroot.transcriptPath(name));
  },

  /** A transcript fetched from the YouTube link and normalised into the
   *  `[HH:MM:SS] text` form transcript.js parses. The one call in the app
   *  that depends on a third party being up, so its failures say so and
   *  point at the paste box. */
  fetchTranscript(id, opts) {
    return fetchFromYouTube(id, opts);
  },

  saveKey: (key) => setApiKey(key),

  /** Start a run in the worker. `opts` is `{name, youtube, transcript,
   *  segments, perPanelist, apiKey, transcriptionKey}` — the same shape
   *  run-worker.js's `start` message carries, minus `root` and `master`,
   *  which this module already holds (the session's in-memory recording
   *  `File` — see pickRecording()/attachMasterFor() above) and attaches
   *  itself so callers never have to pass it through by hand.
   *
   *  run-worker.js emits the run's own events verbatim, plus `{type:'done',
   *  summary}` and `{type:'error', kind, message, hint, traceback}` — not the
   *  `{type:'status', status}` shape app.js renders (server.py's SSE stream
   *  used to supply that; see jobs.py's `_run()`). Bridge it here so the
   *  finished/failed states still render:
   *    'done'                          -> {type:'status', status:'done', result}
   *    'error' (kind:'cancelled')      -> {type:'status', status:'cancelled'}
   *    'error' (anything else)         -> {type:'status', status:'error', error}
   */
  startRun(opts, onEvent) {
    if (!root) throw new Error('Storage isn\'t ready yet — reload and try again.');
    const w = ensureWorker();
    onEvent({ type: 'status', status: 'running' });

    const handle = (e) => {
      const event = e.data;
      if (event.type === 'done') {
        w.removeEventListener('message', handle);
        onEvent({ type: 'status', status: 'done', result: event.summary });
      } else if (event.type === 'error') {
        w.removeEventListener('message', handle);
        if (event.kind === 'cancelled') {
          onEvent({ type: 'status', status: 'cancelled' });
        } else {
          onEvent({
            type: 'status',
            status: 'error',
            error: { message: event.message, hint: event.hint, traceback: event.traceback },
          });
        }
      } else {
        onEvent(event);
      }
    };
    w.addEventListener('message', handle);
    // `master` rides in here rather than in `opts`: it's the same in-memory
    // File pickRecording()/attachMasterFor() already hold, bound to whichever
    // webinar name `opts.name` is — the run worker uses it (with
    // `opts.transcriptionKey`) for the AssemblyAI transcript source, ahead of
    // the YouTube-link fallback (see runner.js).
    w.postMessage({ type: 'start', root, ...opts, master, recordingSec: masterSec });
  },

  cancelRun() {
    if (worker) worker.postMessage({ type: 'cancel' });
  },

  /** Ruling R4: loadRun = getRoot() then manifest.readRun(root, slug). */
  async loadRun(slug) {
    await ensureRoot();
    return readRun(root, slug);
  },

  /** A file inside a finished run's output folder, as an object URL for a
   *  <video> src or a download link. null if it isn't there. The caller owns
   *  the URL and should revoke it once done (see app.js's revokeUrls). */
  async fileUrl(slug, rel) {
    const file = await fsroot.getFile(root, `output/${slug}/${rel}`);
    return file ? URL.createObjectURL(file) : null;
  },

  /** The webinar's master recording, as one object URL for the whole run.
   *  Every clip without its own cut file plays by seeking this — see
   *  app.js's playWindow() — rather than needing a per-clip file at all.
   *  null if no master is loaded this session, or the one that is loaded was
   *  bound to a different webinar (see pickRecording()/attachMasterFor()) —
   *  the recording is never in OPFS to fall back to reading (see fsroot.js's
   *  module comment), so a reopened run whose master isn't loaded genuinely
   *  has nothing to play until app.js asks the reviewer to pick it again.
   *  The caller owns the returned URL and should revoke it once done (see
   *  app.js's revokeMaster). */
  masterUrl(name) {
    if (!master || masterName !== name) return null;
    return URL.createObjectURL(master);
  },

  /** Everything worth sending someone troubleshooting a run, as one text
   *  file: this browser and session up top (app version, browser, storage,
   *  which recording is loaded, page errors), then the run's own
   *  run-log.txt. Read fresh each time, so it includes the attempt that just
   *  failed. Holds no API keys and no transcript text — see runlog.js. */
  async logBlob(slugName) {
    await ensureRoot();
    const runLog = await fsroot.readText(root, logPath(slugName));
    let version = 'unknown';
    try { version = (await caches.keys()).join(', ') || 'no service worker cache'; } catch { /* no Cache API */ }
    let storage = 'unknown';
    try {
      const { usage, quota } = await navigator.storage.estimate();
      storage = `${(usage / 1e6).toFixed(0)}MB used of ${(quota / 1e9).toFixed(1)}GB`;
    } catch { /* estimate unavailable */ }
    const lines = [
      'Video Highlights — troubleshooting log',
      `Run folder: output/${slugName}`,
      `Downloaded: ${new Date().toISOString()}`,
      `App: ${version}`,
      `Browser: ${navigator.userAgent}`,
      `Storage: ${storage}`,
      `Recording loaded: ${master
        ? `"${masterName}" · ${(master.size / 1e6).toFixed(1)}MB${masterSec ? ` · ${masterSec.toFixed(1)}s` : ''}`
        : 'none'}`,
      '',
      '---- page errors this session ----',
      ...(pageErrors.length ? pageErrors : ['none']),
      '',
      '---- run log ----',
      runLog || '(nothing logged yet — runs made before logging existed have no log)',
    ];
    return new Blob([lines.join('\n')], { type: 'text/plain' });
  },

  /** Rewrite a clip's time window in place on disk. Reads the caption file
   *  fresh and rewrites only the `**HH:MM:SS–HH:MM:SS**` line via
   *  captions.js's rewriteWindow() — title, speaker, rationale, and anything
   *  a reviewer hand-added anywhere in the file stay byte-identical, unlike
   *  reconstructing the whole header from parsed fields. This is the same
   *  file a hand edit would touch, so whichever happened last is what the
   *  next `manifest.readRun` sees. */
  async writeClipWindow(slugName, captionFile, startSec, endSec) {
    const path = `output/${slugName}/${captionFile}`;
    const raw = await fsroot.readText(root, path);
    if (raw == null) throw new Error(`Could not read ${captionFile}`);
    const start = formatWindowTime(startSec);
    const end = formatWindowTime(endSec);
    await fsroot.writeText(root, path, rewriteWindow(raw, start, end));
  },

  /** Encode this run's approved clips and, unless `toFolder`, zip them up.
   *  `runName` is the run's own webinar name (`state.run.name` in app.js) —
   *  needed here, not just `slugName`, so the session's master is only ever
   *  handed to export.js when it's actually bound to *this* run (see
   *  masterUrl()'s doc comment on why that match matters); a master picked
   *  for a different webinar is treated as no master at all, same as one
   *  never picked. `opts` is `{scope: 'all'|'clips'|'text', toFolder:
   *  boolean}` — see runtime/export.js's exportRun for what each combination
   *  does, and its module comment for why `toFolder` now only ever writes to
   *  the optional mirror, never to OPFS. `onEvent` gets the same per-clip
   *  progress events a run's own worker emits (`{type:'count'|'stage'|
   *  'clip'}`, stage key `'export'`). Resolves to a Blob (the zip) unless
   *  `toFolder` is true, in which case there is nothing to hand back. */
  async exportRun(slugName, runName, opts = {}, onEvent = () => {}) {
    await ensureRoot();
    // Exports log into the same run-log.txt the run itself wrote.
    const log = createRunLog(root, slugName);
    log.header(`export · ${new Date().toISOString()}`);
    log.info(`options: ${opts.toFolder ? 'to mirror folder' : 'zip'}`
      + ` · ${opts.subtitles ? 'burned-in subtitles' : opts.srt ? 'clean video + SRT' : 'clean video'}`
      + ` · mirror ${mirror ? 'attached' : 'not attached'}`
      + ` · recording ${master ? `"${masterName}" (${(master.size / 1e6).toFixed(1)}MB)` : 'not loaded'}`);
    const emit = (event) => { log.event(event); onEvent(event); };
    try {
      const result = await api._exportRun(slugName, runName, opts, emit);
      log.info('export finished');
      return result;
    } catch (err) {
      log.error(`export failed: ${(err && err.stack) || err}`);
      throw err;
    } finally {
      await log.flush();
    }
  },

  async _exportRun(slugName, runName, opts, onEvent) {
    let sessionMaster = null;
    if (master) {
      // Normalize names for comparison: trim and case-insensitive, so a
      // re-picked file whose name differs only by case or surrounding whitespace
      // is recognized as the same webinar instead of silently failing.
      const normalize = (name) => (name || '').trim().toLowerCase();
      if (normalize(masterName) === normalize(runName)) {
        sessionMaster = master;
      } else {
        // Master loaded for a different webinar — emit a diagnostic message
        // before treating it as if no master was loaded.
        onEvent({
          type: 'stage',
          key: 'export',
          status: 'error',
          label: 'Recording mismatch',
          detail: `Recording was loaded for '${masterName}' but this run is '${runName}' — pick the correct recording`,
        });
      }
    }
    return exportRun(root, slugName, {
      ...opts, master: sessionMaster, mirrorRoot: mirror, emit: onEvent,
    });
  },
};
