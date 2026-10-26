/** The four content-generation steps. Thin wrappers over llm + prompts. */

import * as llm from './llm.js';
import * as prompts from './prompts.js';

// The audience keys name the output files, so they are fixed; only their
// descriptions are editable (see prompts.js).
export const AUDIENCES = prompts.AUDIENCES;

// The prompts this worker's current run uses: the defaults, overlaid with the
// reviewer's saved edits by usePrompts() before each run — the same
// set-once-per-run pattern as llm.js's setApiKey (one run at a time per
// worker, so a module-level value is enough).
let resolved = prompts.resolvePrompts(null);
let active = prompts.buildPrompts(resolved);

/** Use `saved` (store.js's getPrompts — edits only, or null) for the calls
 *  that follow. Invalid edits fall back to their defaults. */
export function usePrompts(saved) {
  resolved = prompts.resolvePrompts(saved);
  active = prompts.buildPrompts(resolved);
}

/** Which prompts the current run is using, for its log and prompts-used.json. */
export function promptsInUse() {
  return { customized: prompts.customizedKeys(resolved), prompts: resolved };
}

export function onePager(transcript) {
  return llm.callWithTranscript({
    label: 'one-pager',
    preamble: active.preamble,
    transcript,
    task: active.onePager,
  });
}

/** One pass: a flat list of clips, each tagged with `speaker` and a `highlight`
 *  flag. Highlights are ranked first; the rest are grouped per panelist.
 *  `detectSpeakerLabels` tells the clip prompt whether this transcript
 *  carries AssemblyAI's diarization prefix (see prompts.js) — the other two
 *  transcript sources never do, so the note it adds is silently absent for
 *  them. */
export async function selectClips(transcript, highlights, perPanelist) {
  const result = await llm.callWithTranscript({
    label: 'clips',
    preamble: active.preamble,
    transcript,
    task: active.clips({
      highlights, perPanelist, speakerLabels: prompts.detectSpeakerLabels(transcript),
    }),
    schema: prompts.CLIPS_SCHEMA,
    // Biggest output in the pipeline: one row per clip for every panelist, plus
    // adaptive thinking over the whole transcript. At 16k this truncated
    // mid-run and came back with no text block at all.
    maxTokens: 32000,
  });
  return result.segments;
}

export function socialCaption(title, clipSlice) {
  return llm.call({
    label: 'caption',
    system: active.captionSystem,
    user: active.captionUser({ title, slice: clipSlice }),
  });
}

export function targetedSummary(onePagerText, audienceKey) {
  return llm.call({
    label: `targeted/${audienceKey}`,
    system: active.targetedSystem,
    user: active.targetedUser({ onePager: onePagerText, audienceKey }),
  });
}
