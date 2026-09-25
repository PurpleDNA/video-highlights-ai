/** Pipeline configuration. Paths are gone — the storage root is OPFS, always
 *  available at runtime (see fsroot.js) — so what is left is the model and
 *  the knobs. */

// Opus 4.8 is the editorial-judgment workhorse here. At one webinar a month,
// cost is a rounding error; optimize for quality, not price.
export const MODEL = 'claude-opus-4-8';

// Overall highlight clips per webinar (the ranked "best of" set in clips/).
export const NUM_SEGMENTS = 4;

// Max candidate clips per panelist, so each can be offered a choice.
export const CLIPS_PER_PANELIST = 3;

// Floor on clip length (seconds). A window shorter than this — or one that
// resolves to no transcript text — is degenerate and gets skipped.
export const MIN_CLIP_SEC = 5;

// If the transcript and the master .mp4 start at different points, set this to
// (master_time - transcript_time) in seconds.
export const TRANSCRIPT_OFFSET_SEC = 0;

// Folder layout inside the storage root (OPFS) / an attached mirror folder.
// RECORDINGS_DIR is never written into by this tool any more — the master
// recording lives only in memory for the session (see fsroot.js's module
// comment) — but stays here since manifest.js still checks it, matching the
// layout an old Python-made or pre-OPFS folder could still have.
export const RECORDINGS_DIR = 'webinar recordings';
export const TRANSCRIPTS_DIR = 'transcripts';
export const OUTPUT_DIR = 'output';
