/** The webinar pipeline as a reusable function — the browser counterpart to
 *  `pipeline/runner.py`.
 *
 * Same stage keys, labels, order and event shapes as `runner.py:93-250`:
 *     transcript -> one-pager -> select -> clips -> targeted
 *
 * Event shapes (all carry "type"), unchanged from the Python side:
 *     {type: "stage", key, status: "running"|"done", label, detail}
 *     {type: "clip",  status: "caption"|"skipped", base, group, ...segment}
 *     {type: "count", key: "clips", total}   // once the total is known
 *     {type: "note",  level: "info"|"warn", message}
 *
 * Differences from `runner.py`, all from the browser spec:
 *   - `transcript` is optional, not required. Four sources, tried in this
 *     order, cheapest/most-trusted first:
 *       1. supplied — `transcript` was picked or pasted by the reviewer.
 *          Always wins; nothing below is even attempted.
 *       2. on disk — `transcripts/<name>.txt` already exists (an earlier
 *          run, or a hand-placed file). Wins over any network call, exactly
 *          the "folder is the checkpoint" rule every other stage follows.
 *       3. AssemblyAI — when `transcriptionKey` and `masterFile` are BOTH
 *          given: `extractAudio()` pulls the recording's audio track out of
 *          the local `File` (no upload of the video itself), then
 *          `transcribe()` uploads just that audio and polls AssemblyAI for
 *          the transcript. Costs real money and several minutes, but returns
 *          diarized `SPEAKER: text` cues at ~3s granularity (see
 *          transcribe.js). `note` events mark each phase (extracting,
 *          uploading, transcribing) since this can run for minutes with
 *          nothing else to show for it. Both calls honour `signal`.
 *       4. the YouTube link — `transcript-fetch.js`'s `fetchTranscript`, a
 *          plain `fetch` so it works from this worker. The free fallback for
 *          a reviewer with no AssemblyAI key: no speaker labels, ~31s cues.
 *       5. otherwise, the hard "no transcript" error below.
 *     Fetch/transcribe failures are reviewer-facing errors (see
 *     `transcript-fetch.js`, `transcribe.js`, `audio.js`), not crashes. Once
 *     resolved, the text is written to `transcripts/<name>.txt` before
 *     parsing — regardless of which of the four sources produced it — so the
 *     folder stays the source of truth and a second run costs nothing (steps
 *     2-4 are all skipped once step 2 finds the file step 3/4 just wrote).
 *     The cue check (no `[HH:MM:SS]` cues found) is still a hard error. A
 *     transcript that differs from what's already on disk overwrites it (a
 *     pasted correction must win, not be silently discarded) — *unless*
 *     the folder already has a one-pager, selection, captions or targeted summaries
 *     derived from the old transcript, in which case the whole run refuses
 *     outright rather than resume past them: those files were built from text
 *     that no longer matches what's on disk, and skipping them because they
 *     merely *exist* would leave the folder mixing old analysis with a new
 *     source with nothing on disk to say so.
 *   - No ffmpeg. `doClip` writes only the caption file and reports
 *     {type: "clip", status: "caption", ...} — never "cut". The degenerate
 *     window skip (under MIN_CLIP_SEC, out of range, or an empty transcript
 *     slice) is unchanged: still reported via a "skipped" clip event and never
 *     written.
 *   - Resume. `jobs.py` kept every event in memory so a browser reload mid-run
 *     could replay into the right state; a dedicated Worker has no such memory
 *     across a reload. Instead, before doing a stage's work this module checks
 *     whether that stage's own file already exists via `fsroot.exists` (which
 *     only ever resolves for a *file* — see below) and, if so, emits the
 *     stage's "done" event with `detail: "already written"` and skips the call
 *     that would have produced it. The output folder is the checkpoint.
 *       - transcript -> transcripts/<name>.txt
 *       - one-pager  -> output/<slug>/one-pager.md
 *       - select     -> output/<slug>/selection.json (see below)
 *       - clips      -> per clip, output/<slug>/<group>/<base>_caption.md
 *       - targeted   -> per audience, output/<slug>/targeted/<key>.md
 *     `selection.json` has no Python counterpart: `select_clips` never touched
 *     disk there, because `jobs.py`'s in-memory history made resuming
 *     mid-clips-stage unnecessary. Here, the clip stage's file names
 *     (`highlight-01_<speaker>`, `clip-01`, ...) are *derived from* the
 *     selection result, so resuming the clips stage without re-running the
 *     (expensive, 32k-token) selection call requires that result to be on
 *     disk. It is read back only to reconstruct `selected`; it is not part of
 *     the documented output tree a reviewer opens.
 *   - `run.json` — the one thing the output folder itself cannot record:
 *     the webinar name as given (not its slug), the YouTube source, the run's
 *     timestamps and its settings. `manifest.js` already reads this file (it
 *     has to, for Python-made runs — see below), so a run that never writes
 *     it silently loses that metadata forever, since the folder is the only
 *     record. Written once at the start (`created`, `status: "running"`),
 *     then finalized on every exit — `status: "done"` on success,
 *     `"cancelled"` on an AbortError, `"error"` on anything else, each with
 *     `finished` set — by wrapping the body in try/catch and re-throwing
 *     after writing, mirroring `jobs.py`'s `_run()`'s try/except/finally
 *     (which calls `write_meta()` on every exit path too). On resume, the
 *     original `created` is preserved, and so are `source`/`settings` when
 *     this call doesn't supply them (an empty YouTube field on a resume is
 *     "not supplied", not "forget the real one") — the folder is the only
 *     record of either, so silently rebuilding them from this run's
 *     arguments would erase a real source permanently. Shape matches `write_meta()` (minus
 *     `job`, which has no meaning without a job registry), so old
 *     Python-made runs and new browser-made runs parse identically:
 *     `{name, created, finished, status, source: {url, video_id}, settings:
 *     {segments, per_panelist}}`. Both `run.json` and `selection.json` are
 *     read back through `readLocalJson`, which deliberately does not let a
 *     corrupt local file surface as a `SyntaxError` — `run-worker.js`'s
 *     `describe()` treats an uncaught `SyntaxError` as an Anthropic response
 *     truncated mid-JSON, and a broken local file is a different problem
 *     that must not be blamed on the API.
 *   - `fsroot.exists()` resolves through `getFile()`, so it is false for a
 *     directory. Every resume check above is a file, on purpose — checking a
 *     stage's folder would always read as "not done".
 *   - Cancel is an AbortSignal instead of a `threading.Event`. It is checked
 *     at exactly the points `runner.py` calls `_check(cancelled)` — between
 *     steps, and once per clip / per audience — and throws
 *     `DOMException('Run cancelled', 'AbortError')`. Nothing here plumbs the
 *     signal into the Anthropic SDK call itself (there is no such hook in the
 *     SDK, same as the Python side's plain `threading.Event` check), so a
 *     cancel requested while a call is in flight — most importantly the 32k
 *     clip-selection call, which can run for tens of seconds — takes effect
 *     only when that call returns, not the instant it is requested.
 */

import {
  onePager, selectClips, socialCaption, targetedSummary, AUDIENCES,
} from './steps.js';
import { parse, toSeconds, sliceText, formatTimestamp, videoId } from './transcript.js';
import { boundariesFromWords, boundariesFromCues, snapWindow } from './snap.js';
import { fetchTranscript } from './transcript-fetch.js';
import { extractAudio } from './audio.js';
import { transcribe } from './transcribe.js';
import { captionText } from './captions.js';
import { writeText, readText, exists, listDir, pathsFor, transcriptPath, wordsPath } from './fsroot.js';
import { slug } from './slug.js';
import { MIN_CLIP_SEC } from './config.js';

function checkCancelled(signal) {
  if (signal && signal.aborted) {
    throw new DOMException('Run cancelled', 'AbortError');
  }
}

/** `media.text_to_markdown`: a level-1 heading, then the body verbatim. */
function toMarkdown(title, body) {
  return `# ${title}\n\n${body.trim()}\n`;
}

/** The inverse of `toMarkdown`, for reading a stage's own output back into
 *  memory on resume (the one-pager text feeds the targeted-summary calls).
 *  Mirrors manifest.js's readDocument, which does the same for the review UI. */
function fromMarkdown(text) {
  return text.replace(/^#[^\n]*\n+/, '').trim();
}

function wordCount(text) {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

/** Parse a local JSON file (run.json, selection.json), never as a bare
 *  SyntaxError: run-worker.js's describe() treats an uncaught SyntaxError as
 *  an Anthropic structured-output response cut off mid-JSON. A corrupt file
 *  on disk is a different failure and must not be attributed to the API. */
async function readLocalJson(root, path) {
  const text = await readText(root, path);
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new Error(`${path} is not valid JSON (${err.message}). Delete it to force a fresh run.`);
  }
}

const titleCase = (s) => s.charAt(0).toUpperCase() + s.slice(1);

/** listDir-based "is there at least one file under here", recursively —
 *  cheap early-out on the first file found. Used only by hasDerivedOutput
 *  below, on a handful of shallow directories (clips/, panelists/,
 *  targeted/). */
async function folderHasFiles(root, path) {
  for (const entry of await listDir(root, path)) {
    if (entry.kind === 'file') return true;
    if (await folderHasFiles(root, `${path}/${entry.name}`)) return true;
  }
  return false;
}

/** True if this run's folder already has anything derived from a transcript:
 *  the one-pager, the clip selection, any caption (clips/ or panelists/), or
 *  any targeted summary. Checked only when the transcript just changed (see
 *  runPipeline below) — a fresh run, with none of this on disk yet, always
 *  proceeds normally regardless of what this returns. */
async function hasDerivedOutput(root, paths, onePagerPath, selectionPath) {
  if (await exists(root, onePagerPath)) return true;
  if (await exists(root, selectionPath)) return true;
  for (const dir of [paths.clips, paths.panelists, paths.targeted]) {
    if (await folderHasFiles(root, dir)) return true;
  }
  return false;
}

/** Move each selected window onto the nearest sentence boundary.
 *
 *  Exact when `transcripts/<name>.words.json` is on disk (an AssemblyAI run);
 *  cue-accurate otherwise; a no-op when neither yields a boundary close
 *  enough. A segment whose timestamps don't parse is passed through
 *  untouched — runner's own MIN_CLIP_SEC/range checks below already report
 *  that case properly, and this is not the place to start failing on it.
 *
 *  Reports what it did as a note, because a silently rewritten window is
 *  exactly the kind of invisible change this project's output folder is
 *  supposed to make legible. */
async function snapSelection(root, name, cues, selected, emit) {
  let bounds = null;
  let source = null;
  const wp = wordsPath(name);
  if (await exists(root, wp)) {
    // Optional everywhere: a corrupt or truncated sidecar must degrade to the
    // cue fallback, never fail a run whose text output does not depend on it.
    // readLocalJson throws by design (see its comment), so it is caught here
    // rather than made lenient for every caller.
    try {
      const words = await readLocalJson(root, wp);
      if (Array.isArray(words) && words.length) {
        bounds = boundariesFromWords(words);
        source = 'word timings';
      }
    } catch {
      emit({
        type: 'note', level: 'warn',
        message: `${wp} could not be read — snapping clip windows from cue boundaries instead.`,
      });
    }
  }
  if (!bounds) {
    bounds = boundariesFromCues(cues);
    source = 'cue boundaries';
  }
  if (!bounds.starts.length && !bounds.ends.length) return selected;

  let moved = 0;
  const out = selected.map((seg) => {
    const start = toSeconds(seg.start);
    const end = toSeconds(seg.end);
    // toSeconds returns NaN, not null, for an unparseable stamp.
    if (!Number.isFinite(start) || !Number.isFinite(end)) return seg;
    const snapped = snapWindow(start, end, bounds, { minSec: MIN_CLIP_SEC });
    if (!snapped.snapped) return seg;
    moved += 1;
    // Windows are stored as HH:MM:SS everywhere downstream (caption headers,
    // manifest-parse, the cutter), so a sub-second boundary has to round.
    // Round OUTWARD — floor the start, ceil the end — because rounding the
    // end down by up to a second would clip the tail off the very word this
    // snapped to, which is the whole thing it is here to prevent.
    return {
      ...seg,
      start: formatTimestamp(Math.floor(snapped.start)),
      end: formatTimestamp(Math.ceil(snapped.end)),
    };
  });

  if (moved) {
    emit({
      type: 'note', level: 'info',
      message: `Snapped ${moved} of ${selected.length} clip windows to sentence boundaries (${source}).`,
    });
  }
  return out;
}

/** Process one webinar end to end, text only. Returns a summary. `transcript`
 *  is optional: leave it empty and supply a `youtube` link with a valid video
 *  id and the transcript stage fetches it itself. Output lands in
 *  `output/<slug>/` inside `root`. */
export async function runPipeline({
  root, name, youtube, transcript, segments, perPanelist, emit = () => {}, signal,
  masterFile = null, transcriptionKey = null,
}) {
  const paths = pathsFor(name);
  const tPath = transcriptPath(name);
  const onePagerPath = `${paths.out}/one-pager.md`;
  const selectionPath = `${paths.out}/selection.json`;
  const runMetaPath = `${paths.out}/run.json`;

  // run.json: written once up front (preserving `created` from a prior
  // attempt, if any) and finalized in the try/catch below, on every exit.
  // Not part of the stage/resume machinery above — every other resume check
  // gates a stage's *work*, but there is no work to skip here, just a record
  // to keep current on every run, resumed or not.
  const priorMeta = (await exists(root, runMetaPath))
    ? await readLocalJson(root, runMetaPath)
    : null;
  const createdAt = priorMeta?.created ?? Date.now() / 1000;
  // `''` (the YouTube field left blank on a resume) must not read as "this
  // run explicitly has no source" — that would overwrite a real one forever,
  // since run.json is the only record of it. Normalise to null so the two
  // cases ("not supplied this time" vs "supplied and empty") are the same
  // thing, and fall back to whatever the prior run already had on file. The
  // same applies to settings, on the off chance a caller doesn't have them
  // (the UI always does, but runPipeline's contract shouldn't assume that).
  const suppliedUrl = youtube ? youtube : null;
  const suppliedSettings = segments != null && perPanelist != null
    ? { segments, per_panelist: perPanelist }
    : null;
  const runMeta = (status, finished) => ({
    name,
    created: createdAt,
    finished,
    status,
    source: suppliedUrl
      ? { url: suppliedUrl, video_id: videoId(suppliedUrl) }
      : (priorMeta?.source ?? { url: null, video_id: null }),
    settings: suppliedSettings ?? (priorMeta?.settings ?? { segments: null, per_panelist: null }),
  });
  await writeText(root, runMetaPath, JSON.stringify(runMeta('running', null), null, 2));

  try {
  // 0. Transcript ---------------------------------------------------------
  emit({ type: 'stage', key: 'transcript', status: 'running', label: 'Reading transcript' });
  const onDiskTranscript = (await exists(root, tPath)) ? await readText(root, tPath) : null;
  // No transcript supplied (nothing picked, nothing pasted): the operator's
  // whole point on this branch is never dealing with a transcript at all, so
  // get one ourselves rather than treat this as an error. An on-disk file
  // wins over any network call even here — the same "the folder is the
  // checkpoint" rule every other stage follows — so a resume with a blank
  // argument reuses what's already there instead of hitting the network
  // again. Only when there's genuinely nothing on disk do we reach out:
  // AssemblyAI first when a key and the master File are both in hand (see
  // the module comment's ordering), the YouTube link otherwise.
  let effectiveTranscript = transcript && transcript.trim() ? transcript : null;
  if (effectiveTranscript === null) {
    if (onDiskTranscript !== null) {
      effectiveTranscript = onDiskTranscript;
    } else if (transcriptionKey && masterFile) {
      emit({ type: 'note', level: 'info', message: 'Extracting audio from the recording…' });
      const audioBlob = await extractAudio(masterFile, null, signal);
      checkCancelled(signal);
      const { text, words, warning } = await transcribe(audioBlob, transcriptionKey, {
        signal,
        // 'upload' and 'transcribing' are the only phases worth a note here —
        // 'done' fires an instant before this whole branch returns anyway,
        // so there is nothing useful to tell the reviewer at that point.
        onProgress: (phase) => {
          if (phase === 'upload') {
            emit({ type: 'note', level: 'info', message: 'Uploading audio to AssemblyAI…' });
          } else if (phase === 'transcribing') {
            emit({
              type: 'note', level: 'info',
              message: 'Transcribing with AssemblyAI — this can take several minutes for a long recording…',
            });
          }
        },
      });
      if (warning) emit({ type: 'note', level: 'warn', message: warning });
      effectiveTranscript = text;
      // Persist the word timings beside the transcript. They are the only
      // source of sentence-end times in the pipeline (snap.js explains why
      // the cue list cannot supply one), and re-fetching them would mean
      // paying AssemblyAI again. Written here rather than in transcribe.js
      // so that module stays free of fsroot, as its tests assume.
      if (words && words.length) {
        await writeText(root, wordsPath(name), JSON.stringify(words));
      }
    } else {
      const id = videoId(youtube);
      if (id) {
        emit({ type: 'note', level: 'info', message: 'Fetching the transcript from YouTube…' });
        effectiveTranscript = await fetchTranscript(id, { signal });
      } else {
        effectiveTranscript = '';
      }
    }
  }
  // Resume on *content*, not just presence: a pasted correction or a
  // different file chosen from the dropdown must overwrite the old text, not
  // run silently against it. Only an exact match with what's already on disk
  // counts as "already written".
  const transcriptUnchanged = onDiskTranscript !== null && onDiskTranscript === effectiveTranscript;
  const transcriptChanged = onDiskTranscript !== null && !transcriptUnchanged;

  // A changed transcript invalidates every stage below that resumes purely
  // on file *presence* — one-pager.md, selection.json, each clip's caption,
  // each targeted summary — because all of it was derived from the OLD text.
  // Silently resuming past them would leave a folder mixing a new source
  // with old analysis, with nothing on disk to say so. Refuse instead, and
  // leave every file exactly as it was (including the transcript itself,
  // not yet rewritten below) — the reviewer can clear output/<slug> to
  // regenerate from the new transcript, or paste the original text back to
  // resume it untouched.
  if (transcriptChanged && await hasDerivedOutput(root, paths, onePagerPath, selectionPath)) {
    throw new Error(
      `The transcript for "${name}" changed, but output/${slug(name)} already has ` +
      'a one-pager, clip selection, captions, or targeted summaries written from ' +
      'the old one. Resuming now would mix stale analysis with the new transcript. ' +
      `Delete output/${slug(name)} (or just its stale files) to start fresh from ` +
      'the new transcript, or paste the original transcript back in to resume as-is.',
    );
  }

  let raw;
  if (transcriptUnchanged) {
    raw = onDiskTranscript;
  } else {
    await writeText(root, tPath, effectiveTranscript);
    raw = effectiveTranscript;
  }
  const cues = parse(raw);
  if (!cues.length) {
    throw new Error(
      `No \`[HH:MM:SS] text\` cues found in ${name}.txt. The transcript is ` +
      'empty or in an unexpected format.');
  }
  const runtimeSec = cues[cues.length - 1].seconds;
  emit({
    type: 'stage', key: 'transcript', status: 'done', label: 'Reading transcript',
    detail: transcriptUnchanged
      ? 'already written'
      : `${cues.length} cues · ${formatTimestamp(runtimeSec)} of speech`,
  });
  checkCancelled(signal);

  // 1. One-pager ------------------------------------------------------------
  emit({ type: 'stage', key: 'one-pager', status: 'running', label: 'Writing the one-pager' });
  const onePagerAlready = await exists(root, onePagerPath);
  let onePagerText;
  if (onePagerAlready) {
    onePagerText = fromMarkdown(await readText(root, onePagerPath));
    emit({
      type: 'stage', key: 'one-pager', status: 'done', label: 'Writing the one-pager',
      detail: 'already written',
    });
  } else {
    onePagerText = await onePager(raw);
    await writeText(root, onePagerPath, toMarkdown(`${name} — One-Pager`, onePagerText));
    emit({
      type: 'stage', key: 'one-pager', status: 'done', label: 'Writing the one-pager',
      detail: `${wordCount(onePagerText)} words`,
    });
  }
  checkCancelled(signal);

  // 2. Clip selection — one pass over the whole transcript -----------------
  emit({
    type: 'stage', key: 'select', status: 'running', label: 'Selecting clips',
    detail: `${segments} highlights, up to ${perPanelist} per panelist`,
  });
  const selectionAlready = await exists(root, selectionPath);
  let selected;
  if (selectionAlready) {
    selected = await readLocalJson(root, selectionPath);
  } else {
    // The pipeline's biggest and slowest call (32k tokens, adaptive thinking
    // over the whole transcript) — see the module comment on cancellation.
    selected = await selectClips(raw, segments, perPanelist);
    // Snap every window to a sentence boundary BEFORE checkpointing it. The
    // model is asked not to cut mid-sentence but is shown only cue-start
    // timestamps, which are time slices — it cannot comply (see snap.js).
    // Snapping here, rather than at export, means selection.json, every
    // caption header, the review desk's playback and the cut .mp4 all agree
    // on one window, and a resume never re-snaps an already-snapped file.
    const adjusted = await snapSelection(root, name, cues, selected, emit);
    selected = adjusted;
    await writeText(root, selectionPath, JSON.stringify(selected));
  }
  const highlights = selected.filter((s) => s.highlight);
  const others = selected.filter((s) => !s.highlight && s.speaker !== 'host' && s.speaker !== 'panel');
  const speakers = [...new Set(others.map((s) => s.speaker))].sort();
  emit({
    type: 'stage', key: 'select', status: 'done', label: 'Selecting clips',
    detail: selectionAlready
      ? 'already written'
      : `${highlights.length} highlights · ${others.length} panelist clips ` +
        `across ${speakers.length} panelists`,
  });
  checkCancelled(signal);

  // 3. Captions (no cuts) ----------------------------------------------------
  const total = highlights.length + others.length;
  emit({ type: 'count', key: 'clips', total });
  emit({ type: 'stage', key: 'clips', status: 'running', label: 'Writing captions' });

  const made = [];
  const skipped = [];
  let resumed = 0;

  /** Caption for one segment, written as <relDir>/<base>_caption.md. Skips a
   *  degenerate window (zero/negative length, below the floor, out of range,
   *  or no transcript text) so it is reported rather than written. Resumes
   *  from a caption file already on disk without calling the LLM again. */
  async function doClip(seg, base, relDir, group) {
    checkCancelled(signal);
    const relPath = `${relDir}/${base}`;
    const capPath = `${paths.out}/${relPath}_caption.md`;

    if (await exists(root, capPath)) {
      made.push(base);
      resumed += 1;
      emit({
        type: 'clip', status: 'caption', base, group, path: relPath,
        done: made.length + skipped.length, total, ...seg,
      });
      return true;
    }

    const start = toSeconds(seg.start);
    const end = toSeconds(seg.end);
    const text = sliceText(cues, start, end);
    if (end - start < MIN_CLIP_SEC || start > runtimeSec || !text.trim()) {
      const reason = `window [${seg.start}–${seg.end}] is empty or under ${MIN_CLIP_SEC}s`;
      skipped.push({ base, reason });
      emit({ type: 'clip', status: 'skipped', base, group, reason, ...seg });
      return false;
    }

    const caption = await socialCaption(seg.title, text);
    await writeText(root, capPath, captionText(seg, caption));
    made.push(base);
    emit({
      type: 'clip', status: 'caption', base, group, path: relPath,
      done: made.length + skipped.length, total, ...seg,
    });
    return true;
  }

  // 3a. Highlights -> clips/highlight-NN_<speaker> (ranked, strongest first)
  let rank = 0;
  for (const seg of highlights) {
    const base = `highlight-${String(rank + 1).padStart(2, '0')}_${slug(seg.speaker)}`;
    if (await doClip(seg, base, 'clips', 'highlights')) rank += 1;
  }

  // 3b. The rest -> panelists/<speaker>/clip-NN (host/panel get no folder)
  const counts = {};
  for (const seg of others) {
    const speakerSlug = slug(seg.speaker);
    const i = (counts[seg.speaker] || 0) + 1;
    const base = `clip-${String(i).padStart(2, '0')}`;
    if (await doClip(seg, base, `panelists/${speakerSlug}`, speakerSlug)) counts[seg.speaker] = i;
  }

  emit({
    type: 'stage', key: 'clips', status: 'done', label: 'Writing captions',
    detail: total > 0 && resumed === made.length
      ? 'already written'
      : `${made.length} of ${total}` + (skipped.length ? ` · ${skipped.length} skipped` : ''),
  });
  checkCancelled(signal);

  // 4. Targeted summaries -----------------------------------------------------
  emit({ type: 'stage', key: 'targeted', status: 'running', label: 'Re-angling for each audience' });
  let targetedNew = false;
  for (const key of Object.keys(AUDIENCES)) {
    checkCancelled(signal);
    const path = `${paths.targeted}/${key}.md`;
    if (await exists(root, path)) continue;
    targetedNew = true;
    emit({ type: 'note', level: 'info', message: `Targeted summary: ${key}` });
    const text = await targetedSummary(onePagerText, key);
    await writeText(root, path, toMarkdown(`${name} — For ${titleCase(key)}`, text));
  }
  emit({
    type: 'stage', key: 'targeted', status: 'done', label: 'Re-angling for each audience',
    detail: targetedNew ? Object.keys(AUDIENCES).join(' · ') : 'already written',
  });

  await writeText(root, runMetaPath, JSON.stringify(runMeta('done', Date.now() / 1000), null, 2));

  return {
    name, slug: slug(name), out: paths.out, clipsWritten: made.length, skipped,
  };
  } catch (err) {
    // Finalize run.json on every exit, exactly as jobs.py's _run() does in
    // its try/except/finally — a cancelled run gets its own status rather
    // than being lumped in with a real error. The original error is
    // re-thrown untouched: run-worker.js's describe() needs it as-is (its
    // AbortError / SyntaxError / message checks all inspect the original).
    const status = err && err.name === 'AbortError' ? 'cancelled' : 'error';
    await writeText(root, runMetaPath, JSON.stringify(runMeta(status, Date.now() / 1000), null, 2));
    throw err;
  }
}
