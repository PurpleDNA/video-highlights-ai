/** Transcribe a media Blob via AssemblyAI, returning `[HH:MM:SS] SPEAKER: text`
 *  cues — the same `[HH:MM:SS] text` shape transcript.js's parse() already
 *  reads, with the speaker label simply riding in the cue text after the
 *  timestamp.
 *
 * Three calls, in order:
 *   1. POST /v2/upload      — raw Blob body, `authorization: <key>` header,
 *                             returns { upload_url }.
 *   2. POST /v2/transcript  — { audio_url, speaker_labels: true }, returns { id }.
 *   3. GET  /v2/transcript/<id> — polled until status is 'completed' or 'error'.
 * There is no DELETE afterwards: it used to try one, it failed often enough
 * ("Failed to fetch") to be noise on every run, and leaving the transcript
 * on AssemblyAI's servers until it expires is acceptable for this tool.
 *
 * THE MAPPING — proven against a real 83-minute panel webinar (see
 * spike/assemblyai.html and spike/assemblyai-full.json). The response's
 * `utterances` array (one entry per unbroken speaker turn) was tried first
 * and rejected: a panel turn runs 60-90 seconds, and utterances gave a
 * useless 26.5s median gap between cues — far too coarse to anchor a clip
 * window. `words` (one entry per word, `{text, start, end, speaker}` in
 * milliseconds) has no such problem: grouping words into cues that break on
 * a speaker change or after MAX_CUE_MS of running time reproduced 1,500
 * cues at a 3.23s median gap on that same webinar — matching the ~3s
 * granularity the old Python route produced, while adding speaker labels
 * the Python route never had.
 */

const API = 'https://api.assemblyai.com/v2';

// A new cue starts when the speaker changes, or when the running cue has
// been open this long. Measured, not guessed — see the module comment.
export const MAX_CUE_MS = 3000;

// AssemblyAI's poll interval. Fast enough that a short recording doesn't
// wait needlessly, slow enough not to hammer the endpoint on a long one.
const POLL_MS = 3000;

function pad(n) {
  return String(n).padStart(2, '0');
}

/** Milliseconds -> zero-padded 'HH:MM:SS', matching transcript.js's format. */
function stamp(ms) {
  const s = Math.floor(ms / 1000);
  return `${pad(Math.floor(s / 3600))}:${pad(Math.floor(s / 60) % 60)}:${pad(s % 60)}`;
}

/** The pure mapping at the heart of this module: AssemblyAI's `words` array
 *  -> cue objects `{ ms, speaker, text }`. No network, no browser globals —
 *  unit-tested directly against a committed fixture (test/transcribe.test.js).
 *
 *  A new cue starts when the speaker changes, or when the current word's
 *  start time has drifted `maxMs` past the cue's own first word — exactly
 *  the rule the module comment above documents and measures. */
export function wordsToCues(words, maxMs = MAX_CUE_MS) {
  const cues = [];
  let cur = null;
  for (const w of words) {
    if (!cur || w.speaker !== cur.speaker || w.start - cur.start >= maxMs) {
      cur = { start: w.start, speaker: w.speaker, words: [w.text] };
      cues.push(cur);
    } else {
      cur.words.push(w.text);
    }
  }
  return cues.map((c) => ({ ms: c.start, speaker: c.speaker, text: c.words.join(' ') }));
}

/** Cue objects -> the `[HH:MM:SS] SPEAKER: text` lines transcript.js parses.
 *  Pure, exported alongside wordsToCues() so the full text shape can be
 *  asserted in tests without a network call. */
export function cuesToText(cues) {
  if (!cues.length) return '';
  return cues.map((c) => `[${stamp(c.ms)}] ${c.speaker}: ${c.text}`).join('\n') + '\n';
}

function abortError() {
  return new DOMException('Aborted', 'AbortError');
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(abortError()); return; }
    const t = setTimeout(resolve, ms);
    const onAbort = () => { clearTimeout(t); reject(abortError()); };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

async function uploadAudio(blob, apiKey, signal) {
  let res;
  try {
    res = await fetch(`${API}/upload`, {
      method: 'POST',
      headers: { authorization: apiKey },
      body: blob,
      signal,
    });
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    throw new Error(
      'Could not reach AssemblyAI to upload the recording. Check the connection and try again.');
  }
  if (!res.ok) {
    throw new Error(
      res.status === 401 || res.status === 403
        ? 'AssemblyAI rejected the API key. Check the key in settings and try again.'
        : `AssemblyAI upload failed (${res.status}). Try again.`);
  }
  const { upload_url } = await res.json();
  return upload_url;
}

async function requestTranscript(uploadUrl, apiKey, signal) {
  let res;
  try {
    res = await fetch(`${API}/transcript`, {
      method: 'POST',
      headers: { authorization: apiKey, 'content-type': 'application/json' },
      body: JSON.stringify({ audio_url: uploadUrl, speaker_labels: true }),
      signal,
    });
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    throw new Error('Could not reach AssemblyAI to start the transcription. Try again.');
  }
  if (!res.ok) {
    throw new Error(`AssemblyAI transcript request failed (${res.status}). Try again.`);
  }
  const { id } = await res.json();
  return id;
}

async function pollTranscript(id, apiKey, signal) {
  for (;;) {
    if (signal?.aborted) throw abortError();
    let res;
    try {
      res = await fetch(`${API}/transcript/${id}`, { headers: { authorization: apiKey }, signal });
    } catch (err) {
      if (err.name === 'AbortError') throw err;
      throw new Error('Lost connection to AssemblyAI while waiting for the transcript. Try again.');
    }
    if (!res.ok) {
      throw new Error(`AssemblyAI status check failed (${res.status}). Try again.`);
    }
    const data = await res.json();
    if (data.status === 'completed') return data;
    if (data.status === 'error') {
      throw new Error(`AssemblyAI could not transcribe this recording: ${data.error}`);
    }
    await sleep(POLL_MS, signal);
  }
}

/** Transcribe `blob` via AssemblyAI and return `{ text, words }`, where
 *  `text` is `[HH:MM:SS] SPEAKER: text` cues (parses with transcript.js's
 *  parse()) and `words` is AssemblyAI's own word timings.
 *
 *  `onProgress`, if given, is called with one of 'upload', 'transcribing',
 *  'done'. `signal`, if given, is honoured both during the upload and the
 *  polling loop — aborting either throws the fetch/timer's own AbortError. */
export async function transcribe(blob, apiKey, { onProgress, signal } = {}) {
  if (!apiKey) throw new Error('No AssemblyAI API key set. Add yours in settings.');

  onProgress?.('upload');
  const uploadUrl = await uploadAudio(blob, apiKey, signal);
  const id = await requestTranscript(uploadUrl, apiKey, signal);

  onProgress?.('transcribing');
  const data = await pollTranscript(id, apiKey, signal);

  const words = data.words || [];
  const cues = wordsToCues(words);
  const text = cuesToText(cues);

  onProgress?.('done');
  // `words` rides along rather than being dropped: it is the only source of
  // sentence-END times anywhere in the pipeline (see snap.js), and it is
  // data we have already paid for. runner.js persists it next to the
  // transcript; nothing else here keeps a reference.
  return { text, words };
}
