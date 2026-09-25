/** The four content-generation steps. Thin wrappers over llm + prompts. */

import * as llm from './llm.js';
import * as prompts from './prompts.js';

export const AUDIENCES = prompts.AUDIENCES;

export function onePager(transcript) {
  return llm.callWithTranscript({
    label: 'one-pager',
    preamble: prompts.PREAMBLE,
    transcript,
    task: prompts.ONE_PAGER,
  });
}

/** One pass: a flat list of clips, each tagged with `speaker` and a `highlight`
 *  flag. Highlights are ranked first; the rest are grouped per panelist.
 *  `detectSpeakerLabels` tells CLIPS() whether this transcript carries
 *  AssemblyAI's diarization prefix (see prompts.js) — the other two
 *  transcript sources never do, so the note it adds is silently absent for
 *  them, exactly as before. */
export async function selectClips(transcript, highlights, perPanelist) {
  const result = await llm.callWithTranscript({
    label: 'clips',
    preamble: prompts.PREAMBLE,
    transcript,
    task: prompts.CLIPS({
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
    system: prompts.CAPTION_SYSTEM,
    user: prompts.CAPTION_USER({ title, slice: clipSlice }),
  });
}

export function targetedSummary(onePagerText, audienceKey) {
  return llm.call({
    label: `targeted/${audienceKey}`,
    system: prompts.TARGETED_SYSTEM,
    user: prompts.TARGETED_USER({
      onePager: onePagerText,
      audience: prompts.AUDIENCES[audienceKey],
    }),
  });
}
