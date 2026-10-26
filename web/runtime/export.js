/** Encode approved clips at export time — the browser counterpart to
 *  `pipeline/runner.py`'s old during-run cutting, moved to happen once,
 *  on demand, after review (see the design doc's "Cut at export, not
 *  during the run").
 *
 * "Approved" clips are simply every clip the run's manifest carries: every
 * `*_caption.md` the pipeline wrote for a window that passed the
 * MIN_CLIP_SEC / in-range checks in runner.js. There is no separate
 * approve/reject step in the review UI — a reviewer "approves" a clip by
 * leaving its caption file in place (optionally after re-windowing it in
 * place; see api.js's writeClipWindow) rather than deleting it.
 *
 * Walks the run exactly as manifest.js's readRun assembles it, sends each
 * clip's window to the cut worker one at a time (cut-worker.js only ever
 * runs one cut anyway — see its `busy` flag — but nothing here relies on
 * that; each cut is awaited before the next is requested).
 *
 * THE MASTER IS NO LONGER IN THE ROOT. `root` is OPFS now (see fsroot.js),
 * and the webinar recording is deliberately never copied into it — it is
 * held only as an in-memory `File` for the session (~150MB; one click to
 * re-pick). `master` is therefore taken as an argument rather than looked
 * up with `getFile(root, recordingPath(run.name))`. A missing/not-yet-picked
 * master is reported exactly as a missing-on-disk master always was: a
 * skipped clip with a reason, never a thrown error — one bad/absent master
 * shouldn't stop every other clip's caption from still being zippable.
 *
 * WHERE A CUT CLIP LANDS now depends on the destination, per the design
 * doc's "cut at export, not during the run" plus the OPFS move:
 *   - No mirror folder attached (the ordinary case: export's default is a
 *     zip download): the cut Blob is never written to OPFS at all — that
 *     would be wasted disk I/O for a destination that's a download a moment
 *     later. It is handed back in `blobs` and zip.js folds it straight into
 *     the archive.
 *   - A mirror folder attached ("also save to a folder"): the cut Blob is
 *     additionally written there with fsroot.writeBlob, at the same path
 *     pipeline/runner.py used — `clips/<base>.mp4` or
 *     `panelists/<slug>/<base>.mp4` (manifest.js's `clip.id` is already
 *     built from that same directory + base, so it doubles as the relative
 *     video path with `.mp4` appended) — so a mirrored folder is
 *     indistinguishable from one the Python pipeline made.
 *
 * Resumable, but only against the mirror: a clip whose .mp4 already exists
 * *there* is reported done without re-cutting it — the same "the output
 * folder is the checkpoint" rule runner.js uses for text — *unless* its
 * caption (always read from OPFS, the source of truth) has been edited
 * since: `.mp4` presence alone can't tell a clip that's genuinely done from
 * one whose window was re-cut in place after export already ran once. The
 * caption's `lastModified` against the mirrored `.mp4`'s is the signal used
 * to tell them apart — simpler than parsing and comparing the actual window
 * values, and right in the common case: both app.js's in-place window edit
 * and a hand edit in a text editor rewrite the caption file, which bumps its
 * mtime past the .mp4's the moment the window changes. A window edited and
 * then reverted back to the exact time it cut from would still trigger a
 * needless re-cut under this proxy — accepted, since that costs a few
 * seconds of re-encoding, not a wrong clip shipping silently. With no mirror
 * attached there is nothing durable to check at all, so every zip-only
 * export re-cuts every clip fresh — the deliberate cost of never persisting
 * video anywhere by default.
 */

import { OUTPUT_DIR, TRANSCRIPT_OFFSET_SEC } from './config.js';
import { getFile, writeBlob, readText, writeText, transcriptPath } from './fsroot.js';
import { parse } from './transcript.js';
import { cuesForWindow, toSrt } from './subtitles.js';
import { readRun } from './manifest.js';
import { zipRun } from './zip.js';

/** Every clip in a run manifest, flattened. manifest.js already groups them
 *  as `highlights` and `panelists[].clips`; export doesn't care which. */
function flattenClips(run) {
  const list = [...run.highlights];
  for (const panelist of run.panelists) list.push(...panelist.clips);
  return list;
}

/** Which subtitle mode each mirrored `.mp4` was cut with, keyed by
 *  `clip.id` — the app's own bookkeeping, next to `selection.json` in OPFS
 *  and excluded from every zip scope the same way (see zip.js's
 *  BOOKKEEPING_FILES).
 *
 *  It exists because subtitles are burned into the pixels, so a subtitled
 *  cut and a clean one are different artifacts sharing one filename, and the
 *  mirror's resume check — "this clip's .mp4 is already there, skip it" —
 *  cannot tell them apart from the file alone. Without this, asking for a
 *  clean download with a mirror attached would hand back whatever was cut
 *  last, which is precisely the resume-on-existence-instead-of-agreement
 *  trap this project has been bitten by before (see CLAUDE.md).
 *
 *  A missing file reads as every clip being `raw`, which is true by
 *  construction: burned-in subtitles did not exist before this file did. */
const CUT_STATE_FILE = 'cut-state.json';

async function readCutState(root, slugName) {
  const raw = await readText(root, `${OUTPUT_DIR}/${slugName}/${CUT_STATE_FILE}`);
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    // Corrupt bookkeeping re-cuts everything once; it never cuts wrongly.
    return {};
  }
}

// A cut of a 90-second window measures around 15s wall-clock (see cut.js's
// module comment for the underlying spike numbers) — minutes, not seconds,
// is generous headroom for a much longer clip or a slower machine, while
// still turning a silently-dead worker into a reported error instead of an
// infinite spinner. 5 minutes chosen as that generous-but-bounded timeout.
const CUT_TIMEOUT_MS = 5 * 60 * 1000;

let cutWorker = null;
let cutWorkerReady = null;
let nextCutId = 1;

/** Module-level cache for cut clips. Maps cache key (slug|clipId|startSec|endSec)
 *  to the cut Blob. Persists across calls within a session so repeated exports
 *  of the same unchanged clip reuse the cached video instead of re-encoding.
 *  Must not survive a reload (in-memory only) and must never be written to OPFS. */
const clipCache = new Map();

/** Constructs the worker at most once and resolves once it's confirmed
 *  alive — i.e. once it has posted the unprompted `{type:'ready'}` message
 *  cut-worker.js sends right after its module graph finishes evaluating.
 *  Waiting for this before posting the first `{type:'cut'}` is the
 *  belt-and-braces half of the top-level-await fix: even if some future
 *  change reintroduces asynchronous module evaluation in the worker's
 *  import graph, export.js will wait for proof the handler is registered
 *  instead of racing a message against it. */
function ensureCutWorker() {
  if (!cutWorker) {
    cutWorker = new Worker(new URL('./cut-worker.js', import.meta.url), { type: 'module' });
    cutWorkerReady = new Promise((resolve) => {
      const onReady = (e) => {
        if (e.data && e.data.type === 'ready') {
          cutWorker.removeEventListener('message', onReady);
          resolve();
        }
      };
      cutWorker.addEventListener('message', onReady);
    });
  }
  return { worker: cutWorker, ready: cutWorkerReady };
}

/** One request/response round trip against the cut worker, matched by id
 *  (cut-worker.js's `{type:'cut', id, ...}` / `{type:'cut-done'|'cut-error',
 *  id, ...}` protocol). The worker enforces one cut at a time itself (its
 *  `busy` flag rejects an overlapping request rather than queuing it), so
 *  the caller — encodeApprovedClips below — must still await each cut
 *  before sending the next; this only wires up that one pair.
 *
 *  Waits for the worker's `ready` handshake before posting, and races the
 *  reply against CUT_TIMEOUT_MS so a silent worker (the exact failure mode
 *  this fix addresses) surfaces as a rejected promise instead of a cut that
 *  never resolves. */
async function cutOnWorker(file, startSec, endSec, subtitles) {
  const { worker, ready } = ensureCutWorker();
  await ready;
  const id = nextCutId++;
  return new Promise((resolve, reject) => {
    let settled = false;
    const onMessage = (e) => {
      const msg = e.data;
      if (msg.id !== id) return;
      settled = true;
      clearTimeout(timer);
      worker.removeEventListener('message', onMessage);
      if (msg.type === 'cut-done') resolve(msg.blob);
      else reject(new Error((msg && msg.message) || 'The cut worker failed.'));
    };
    const timer = setTimeout(() => {
      if (settled) return;
      worker.removeEventListener('message', onMessage);
      reject(new Error(`The cut worker did not reply within ${CUT_TIMEOUT_MS / 1000}s.`));
    }, CUT_TIMEOUT_MS);
    worker.addEventListener('message', onMessage);
    worker.postMessage({ type: 'cut', id, file, startSec, endSec, subtitles });
  });
}

/** Encode every not-yet-cut clip in `slugName`'s run, one at a time.
 *  `master` is the webinar recording as an in-memory `File` (or null/
 *  undefined if none is loaded this session — see the module comment).
 *  `mirrorRoot`, if given, is an attached "also save to a folder" handle;
 *  cut clips are additionally written there. `emit`, if given, receives the
 *  same event shapes `runner.js` does — `{type:'count', key:'export',
 *  total}`, `{type:'stage', key:'export', status, label, detail}`,
 *  `{type:'clip', status:'cut'|'skipped'|'error', base, group, path, done,
 *  total}` — under the stage key `'export'`, so nothing new needs to be
 *  taught to code that already renders those events.
 *
 * Returns `{encoded, skipped, blobs}`: `encoded` counts clips now cut
 * (freshly, or already on the mirror); `skipped` lists `{base, reason}` for
 * clips that could not be cut (no master loaded, a caption with no readable
 * window, or a worker failure) — never thrown, so one bad clip doesn't stop
 * the rest; `blobs` is a `Map` of `clip.id -> Blob` for every clip this call
 * produced a video for — freshly cut, or read back from the mirror when
 * already there — for zip.js to fold straight into an archive without ever
 * needing OPFS to hold a copy itself. */
export async function encodeApprovedClips(root, slugName, master, emit = () => {}, {
  mirrorRoot = null, subtitles = false, srt = false,
} = {}) {
  const run = await readRun(root, slugName);
  const clips = flattenClips(run);

  // Read the transcript once for the export, not once per clip: it is the same
  // file each time and a clip only needs the cues overlapping its own window.
  let allCues = null;
  if (subtitles || srt) {
    const raw = await readText(root, transcriptPath(run.name));
    allCues = raw ? parse(raw) : null;
    if (!allCues || !allCues.length) {
      emit({ type: 'note', level: 'warn',
        message: 'No transcript on disk for this run — exporting without subtitles.' });
    }
  }
  // One mode for the whole export: `subtitles` is a single choice per run
  // and `allCues` is read once above, so a clip cannot differ from its
  // neighbours here. Falling back to 'raw' when the transcript is missing
  // matches what actually gets cut, not what was asked for.
  const mode = subtitles && allCues && allCues.length ? 'sub' : 'raw';
  const cutState = mirrorRoot ? await readCutState(root, slugName) : {};
  let cutStateDirty = false;

  const total = clips.length;

  emit({ type: 'count', key: 'export', total });
  emit({ type: 'stage', key: 'export', status: 'running', label: 'Encoding clips' });

  if (!total) {
    emit({
      type: 'stage', key: 'export', status: 'done', label: 'Encoding clips',
      detail: 'no approved clips',
    });
    return { encoded: 0, skipped: [], blobs: new Map(), srts: new Map() };
  }

  let done = 0;
  const skipped = [];
  const blobs = new Map();
  // clip.id -> SRT text. Made for every clip with a window, whether or not
  // its video cuts: it is text from the transcript, needs no master, and is
  // the very file a reviewer wants to correct.
  const srts = new Map();

  for (const clip of clips) {
    if (srt && allCues && allCues.length && clip.start_sec != null && clip.end_sec != null) {
      srts.set(clip.id, toSrt(cuesForWindow(allCues, clip.start_sec, clip.end_sec)));
    }

    const relPath = `${OUTPUT_DIR}/${slugName}/${clip.id}.mp4`;
    const capPath = `${OUTPUT_DIR}/${slugName}/${clip.caption_file}`;

    // Resumability only ever checks the mirror now — OPFS never holds a
    // clip's .mp4 (see the module comment above).
    if (mirrorRoot) {
      const existingVideo = await getFile(mirrorRoot, relPath);
      // `?? 'raw'` and not `=== mode`: a clip with no recorded mode was cut
      // before this bookkeeping existed, which means it was cut clean.
      if (existingVideo && (cutState[clip.id] ?? 'raw') === mode) {
        const capFile = await getFile(root, capPath);
        // No caption on disk any more, or it's no newer than the mirrored
        // .mp4 it produced: nothing has changed since the last cut.
        if (!capFile || capFile.lastModified <= existingVideo.lastModified) {
          blobs.set(clip.id, existingVideo);
          done += 1;
          emit({
            type: 'clip', status: 'cut', base: clip.base, group: clip.group,
            path: clip.id, done, total, already: true,
          });
          continue;
        }
        // Else: the caption was edited after this .mp4 was cut — fall
        // through and re-cut from the window now on disk, overwriting the
        // stale mirrored file. (A subtitle-mode mismatch skips this block
        // entirely and falls through the same way.)
      }
    }

    if (clip.start_sec == null || clip.end_sec == null) {
      const reason = 'no readable time window';
      skipped.push({ base: clip.base, reason });
      emit({
        type: 'clip', status: 'skipped', base: clip.base, group: clip.group,
        reason, done, total,
      });
      continue;
    }

    if (!master) {
      const reason = `the recording for '${run.name}' isn't loaded this session — pick it again`;
      skipped.push({ base: clip.base, reason });
      emit({
        type: 'clip', status: 'skipped', base: clip.base, group: clip.group,
        reason, done, total,
      });
      continue;
    }

    try {
      // clip.start_sec/end_sec are transcript-relative (they come straight
      // from the caption header, parsed by manifest-parse.js); the master's
      // own timeline can be offset from the transcript's — see config.js's
      // TRANSCRIPT_OFFSET_SEC and app.js's playWindow, which applies the
      // same shift before seeking the same master.

      // Check cache first — a clip cut once in this session is reused on
      // subsequent exports of the same run without re-encoding. Cache key
      // includes the clip's time window, not just its id, so a reviewer
      // editing a window in the review desk re-exports a fresh cut.
      // Subtitles are burned into the pixels, so a clean cut and a subtitled
      // cut are different artifacts and must not share a cache entry.
      const burn = subtitles && allCues && allCues.length
        ? cuesForWindow(allCues, clip.start_sec, clip.end_sec)
        : null;
      const cacheKey = `${slugName}|${clip.id}|${clip.start_sec}|${clip.end_sec}|${burn ? 'sub' : 'raw'}`;
      let blob = clipCache.get(cacheKey);
      if (!blob) {
        blob = await cutOnWorker(
          master,
          clip.start_sec + TRANSCRIPT_OFFSET_SEC,
          clip.end_sec + TRANSCRIPT_OFFSET_SEC,
          burn,
        );
        clipCache.set(cacheKey, blob);
      }

      if (mirrorRoot) {
        await writeBlob(mirrorRoot, relPath, blob);
        cutState[clip.id] = mode;
        cutStateDirty = true;
      }
      blobs.set(clip.id, blob);
      done += 1;
      emit({
        type: 'clip', status: 'cut', base: clip.base, group: clip.group,
        path: clip.id, done, total,
      });
    } catch (err) {
      const reason = (err && err.message) || 'the cut failed';
      skipped.push({ base: clip.base, reason });
      emit({
        type: 'clip', status: 'error', base: clip.base, group: clip.group,
        reason, done, total,
      });
    }
  }

  // Written once at the end rather than per clip: nothing reads it mid-run,
  // and an export interrupted halfway simply re-cuts on the next attempt,
  // which is the same outcome as a partially-written file would give.
  if (cutStateDirty) {
    await writeText(root, `${OUTPUT_DIR}/${slugName}/${CUT_STATE_FILE}`,
      JSON.stringify(cutState, null, 2));
  }

  emit({
    type: 'stage', key: 'export', status: 'done', label: 'Encoding clips',
    detail: `${done} of ${total}` + (skipped.length ? ` · ${skipped.length} skipped` : ''),
  });

  return { encoded: done, skipped, blobs, srts };
}

/** The one entry point the UI calls. Export's default destination is now a
 *  zip download, not a folder — the work folder that used to be `root` is
 *  gone; `root` is OPFS, which nobody browses directly. Two destinations for
 *  the same encoded clips:
 *
 *   - `toFolder: true` — meaningful only with `mirrorRoot` attached ("also
 *     save to a folder"): cut clips land there (see `encodeApprovedClips`)
 *     and nothing else happens; resolves to `undefined`. With no
 *     `mirrorRoot`, this is a no-op beyond encoding into memory and
 *     discarding the result — callers should gate the "cut to folder" UI on
 *     a mirror being attached rather than relying on that.
 *   - `toFolder: false` (default here) — builds a `scope`-d zip and resolves
 *     to that Blob for the caller to download. Text/caption members still
 *     come from OPFS on disk (see zip.js's `zipRun`), but a clip's `.mp4` is
 *     never read back from anywhere: it is cut straight into the archive
 *     from the `blobs` map `encodeApprovedClips` just produced, exactly
 *     because the default destination is a download and writing it to OPFS
 *     first would be pure waste (see the module comment above).
 *
 *  Either way, encoding happens first via `encodeApprovedClips` — except for
 *  a `text` zip, which never includes a clip (see zip.js's `members`) and so
 *  has no use for one: encoding every clip first would spend minutes of GPU
 *  time for a markdown-only bundle. `emit`, if given, sees the same per-clip
 *  events `encodeApprovedClips` documents above; zipping itself has no
 *  comparable per-file progress to report (fflate's `zipSync` is
 *  synchronous).
 *
 *  `subtitles` burns cues into the pixels; `srt` instead leaves the video
 *  clean and adds a `<clip>.srt` beside each one in the zip (see
 *  subtitles.js's toSrt) — the editable route, for fixing names and
 *  spelling before remuxing. The UI asks for one or the other. */
export async function exportRun(root, slugName, {
  scope = 'all', toFolder = false, master = null, mirrorRoot = null, emit = () => {},
  subtitles = false, srt = false,
} = {}) {
  let blobs = new Map();
  let srts = new Map();
  if (scope !== 'text') {
    ({ blobs, srts } = await encodeApprovedClips(root, slugName, master, emit, { mirrorRoot, subtitles, srt }));
  }
  if (toFolder) return undefined;
  const { blob } = await zipRun(root, slugName, scope, blobs, srts);
  return blob;
}
