/** The run worker: one run at a time, with the run's events forwarded to the
 *  page as they happen.
 *
 *  jobs.py kept a full event history so a browser reload mid-run could replay
 *  into the right state. A dedicated worker dies on reload, so that trick is
 *  gone — instead runner.js writes each artifact as it is produced and skips
 *  what already exists, which makes the output folder the checkpoint.
 *
 *  The worker never calls fsroot.getRoot() itself — not because it couldn't
 *  (OPFS needs no permission prompt and is reachable from a worker too), but
 *  because api.js already holds the one root the whole session shares; the
 *  main thread just posts that handle in over `postMessage` rather than
 *  having the worker fetch its own separate one.
 */

import { runPipeline } from './runner.js';
import { setApiKey } from './llm.js';

let active = null;

self.onmessage = async (e) => {
  const msg = e.data;

  if (msg.type === 'cancel') {
    if (active) active.abort();
    return;
  }

  if (msg.type !== 'start') return;
  if (active) {
    self.postMessage({ type: 'error', message: 'A run is already going.',
                       hint: 'Wait for it to finish, or cancel it first.' });
    return;
  }

  active = new AbortController();
  setApiKey(msg.apiKey);
  try {
    const summary = await runPipeline({
      root: msg.root,
      name: msg.name,
      youtube: msg.youtube,
      transcript: msg.transcript,
      segments: msg.segments,
      perPanelist: msg.perPanelist,
      // The master recording File and the AssemblyAI key, both optional —
      // see runner.js's module comment for the transcript source ordering
      // that puts AssemblyAI ahead of the YouTube-link fallback when both
      // are present. api.js posts `master` in over this same message.
      masterFile: msg.master ?? null,
      transcriptionKey: msg.transcriptionKey ?? null,
      // The recording's length as the page's <video> read it, for the run
      // log's "transcript covers only N% of the recording" check.
      recordingSec: msg.recordingSec ?? null,
      emit: (event) => self.postMessage(event),
      signal: active.signal,
    });
    self.postMessage({ type: 'done', summary });
  } catch (err) {
    self.postMessage({ type: 'error', ...describe(err) });
  } finally {
    active = null;
  }
};

/** jobs.py turned exceptions into a reviewer-facing message plus a hint, and
 *  kept the traceback for the collapsed developer view. Same job here. Each error
 *  is tagged with a `kind` field to avoid brittle string matching on the message. */
function describe(err) {
  const traceback = String(err && err.stack || err);
  if (err.name === 'AbortError') {
    return { kind: 'cancelled', message: 'Run cancelled.', hint: null, traceback };
  }
  // llm.js's textOf() only guards the case where a truncated response carries
  // no text block at all (it raises with the stop_reason then). A response
  // that got cut off *inside* a structured-output JSON body still has a text
  // block — it's just not valid JSON — so it sails past that guard and dies
  // in `JSON.parse` with a bare "Unexpected end of JSON input": no
  // stop_reason, no indication anything was even truncated. Give the reviewer
  // that context here, since nothing upstream has it to give.
  if (err instanceof SyntaxError && /json/i.test(err.message)) {
    return {
      kind: 'truncated',
      message: 'Anthropic\'s response was cut off in the middle of its JSON output '
        + 'and could not be parsed.',
      hint: 'Almost certainly max_tokens truncation on the clip-selection call. '
        + 'Nothing was written for this step, so it is safe to just run again — '
        + 'finished steps are skipped.',
      traceback,
    };
  }
  if (/401|authentication/i.test(err.message)) {
    return { kind: 'auth', message: 'Anthropic rejected the API key.',
             hint: 'Check the key in settings.', traceback };
  }
  if (/429|rate limit/i.test(err.message)) {
    return { kind: 'rate_limit', message: 'Anthropic rate-limited the run.',
             hint: 'Wait a minute and run again — finished steps are skipped.',
             traceback };
  }
  if (/No `\[HH:MM:SS\]`/.test(err.message)) {
    return { kind: 'bad_transcript', message: err.message,
             hint: 'The transcript needs one `[HH:MM:SS] text` line per cue.',
             traceback };
  }
  // transcript-fetch.js's fetchTranscript() (called from runner.js's
  // transcript stage when no transcript was supplied) always ends its
  // reviewer-facing messages this way — tag it so it doesn't fall through to
  // 'unknown'.
  if (/Paste the transcript in instead\.$/.test(err.message)) {
    return { kind: 'transcript_fetch', message: err.message,
             hint: 'Paste the transcript in yourself and run again — finished steps are skipped.',
             traceback };
  }
  return { kind: 'unknown', message: err.message || 'The run failed.', hint: null, traceback };
}
