/** All prompts live here — this is the file you tune.
 *
 * Design note on caching: PREAMBLE is sent as a frozen system block, with the
 * transcript cached immediately after it (see llm.callWithTranscript). Keep
 * PREAMBLE byte-stable while iterating — edit the *task* prompts below, which
 * ride in the user turn after the cache breakpoint, so the transcript cache
 * survives your edits.
 *
 * Measured 2026-09-22: a call that carries CLIPS_SCHEMA gets its OWN cache
 * entry and cannot read the plain calls' — the schema sits ahead of the cached
 * prefix. Repeated selection calls still hit their own entry, which is the dev
 * loop this caching is for.
 */

// ---------------------------------------------------------------------------
// Shared system preamble — frozen. Sits before the cached transcript.
// ---------------------------------------------------------------------------
export const PREAMBLE = `You are an editorial assistant for the Global Forum for Plant-Based and Alternative Proteins (GFPBAP), a nonprofit that democratizes knowledge about sustainable food systems and alternative proteins largely through a monthly webinar series.

You are working from the transcript of one webinar, provided below. It is timestamped [HH:MM:SS] at each caption cue. The discussion is between a host and expert panelists, with audience Q&A. Your job is to turn this raw discussion into polished, accurate material for distribution. Never invent facts, statistics, names, or claims that are not supported by the transcript.`;

// ---------------------------------------------------------------------------
// 1. One-pager summary (uses the full transcript)
// ---------------------------------------------------------------------------
export const ONE_PAGER = `Write a one-page summary of this webinar for someone who will not watch or listen to the recording.

Requirements:
- A few flowing paragraphs (roughly 300-450 words). No bullet lists.
- Open with what the webinar was about and why it matters.
- Cover the key points, arguments, and takeaways in the order they build.
- Name the topic and the substance of what panelists argued — but only what the transcript supports.
- Plain, engaging prose a busy professional can read in two minutes. No preamble like "This webinar..." as the first words; start with the substance.

Return only the summary text.`;

// ---------------------------------------------------------------------------
// Speaker-label detection — pure, used below to decide whether CLIPS's
// diarization note applies. AssemblyAI cues look like `[HH:MM:SS] B: text` —
// a one- or two-letter diarization label, not a name, riding inside the
// cue's own text after the timestamp (transcript.js's parse() has no notion
// of "speaker" at all; see transcribe.js's module comment on wordsToCues()/
// cuesToText()). Neither of the other two transcript sources — an on-disk or
// pasted transcript, or the YouTube-link fetch (transcript-fetch.js) — ever
// produces this prefix, so this only ever fires for an AssemblyAI transcript.
//
// Not put in PREAMBLE: PREAMBLE is a frozen, shared system-block prefix used
// by every call that carries the transcript (one-pager and clip selection
// alike), and whether labels are present is a fact about *this run's*
// transcript, not about the assistant's job in general — conditionally
// varying a "frozen" block would undermine the one guarantee that comment
// relies on. It also buys nothing for caching here: the module comment on
// PREAMBLE already notes a schema-carrying call (selectClips, via
// CLIPS_SCHEMA) gets its own cache entry ahead of PREAMBLE's, not a
// continuation of it, so there is no shared cache to preserve either way.
// The one-pager has no reason to see this note — it never attributes
// individual moments to a speaker — so it belongs in CLIPS's own task text,
// scoped to the one call that actually attributes clips.
// ---------------------------------------------------------------------------
const SPEAKER_LABEL_LINE = /^\[\d{2}:\d{2}:\d{2}\]\s*([A-Z]{1,2}):\s/;

/** True when at least 90% of a transcript's non-blank lines carry a short
 *  (1-2 letter), consistent `X: ` label right after the timestamp, with a
 *  plausible number of distinct labels (1-12 — a real panel, not one label
 *  per line by coincidence). The 90% threshold tolerates the odd untagged
 *  cue without firing on ordinary prose that happens to start a sentence
 *  with a capital letter and a colon. Pure — no network, no browser globals —
 *  so it is unit-tested directly (see test/prompts.test.js). */
export function detectSpeakerLabels(transcript) {
  const lines = String(transcript || '').split(/\r?\n/).filter((l) => l.trim());
  if (!lines.length) return false;
  const labels = new Set();
  let matched = 0;
  for (const line of lines) {
    const m = SPEAKER_LABEL_LINE.exec(line);
    if (m) { matched += 1; labels.add(m[1]); }
  }
  return matched / lines.length >= 0.9 && labels.size >= 1 && labels.size <= 12;
}

/** Appended to CLIPS's task text only when detectSpeakerLabels() found them.
 *  Tells the model what the labels are (not names), that they're stable, and
 *  to use them — rather than guessing from context, which is where panelist
 *  attribution went wrong before this existed. */
const SPEAKER_LABEL_NOTE = `

Speaker labels: each cue below is prefixed with a speaker label ("A:", "B:", etc.) identifying a distinct voice. These labels are stable across the whole transcript, but they are not names — map each one to a real name using the introductions in the transcript (panelists routinely introduce themselves and each other, and the host often introduces panelists too). Use the labels, not guesses from content or context, to decide who is speaking when you set "speaker".`;

// ---------------------------------------------------------------------------
// 2. Clip selection — one pass that both ranks the overall highlights and
//    attributes every clip to a speaker (full transcript; structured JSON).
//    Doing this in a single call means each moment is chosen once, so a panelist
//    highlight is never also cut as a separate per-panelist clip.
// ---------------------------------------------------------------------------
export const CLIPS = ({ highlights, perPanelist, speakerLabels = false }) => `Select the segments of this webinar worth clipping for social media, and attribute each to who is speaking — so we can feature the strongest moments overall and also offer every panelist a choice of their own clips.

First, identify the panelists. A panelist is an expert speaker — not the host/moderator and not an audience member. Refer to each panelist by their name as stated in the transcript (how the host introduces them, or how they introduce themselves). If a panelist's name is not discernible, use "Panelist 1", "Panelist 2", and so on.

For every segment you select:
- Pick a self-contained moment: a sharp insight, a memorable framing, a surprising fact, or a compelling exchange. It should make sense without the surrounding context.
- Snap "start" and "end" to complete thoughts — never cut mid-sentence. Use the cue timestamps to find clean boundaries, and copy them verbatim as "HH:MM:SS" strings.
- Target 30-90 seconds of runtime.
- Write a short "title" (a few words) and a one-sentence "rationale".
- Set "speaker" to the panelist's name when a single panelist is speaking; use "host" for the moderator and "panel" for a multi-speaker exchange.

Coverage and limits:
- For each panelist, include at most ${perPanelist} of their strongest moments where that panelist is the one speaking — fewer is fine if they don't have that many, but never more.
- Mark the ${highlights} strongest moments of the whole webinar as highlights by setting "highlight" to true (every other segment is false). A highlight may belong to a panelist, the host, or the panel. A panelist's highlighted moments count toward their ${perPanelist} limit.

Ordering: list the highlights first, strongest to weakest, then the remaining clips grouped by panelist (each panelist's clips strongest first).${speakerLabels ? SPEAKER_LABEL_NOTE : ''}`;

export const CLIPS_SCHEMA = {
  type: 'object',
  properties: {
    segments: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          start: { type: 'string' },
          end: { type: 'string' },
          rationale: { type: 'string' },
          speaker: { type: 'string' },
          highlight: { type: 'boolean' },
        },
        required: ['title', 'start', 'end', 'rationale', 'speaker', 'highlight'],
        additionalProperties: false,
      },
    },
  },
  required: ['segments'],
  additionalProperties: false,
};

// ---------------------------------------------------------------------------
// 3. Social caption per clip (uses only the clip's transcript slice)
// ---------------------------------------------------------------------------
export const CAPTION_SYSTEM = `You are a social media manager for GFPBAP. You write post captions that match the energy of short video clips and drive engagement, while staying accurate and credible (this is a knowledge nonprofit, not a hype account).`;

export const CAPTION_USER = ({ title, slice }) => `Write a social media caption for a short video clip titled "${title}".

Here is the transcript of the clip:
---
${slice}
---

Requirements:
- Match the clip's energy: a strong hook in the first line.
- 2-4 short sentences, then 3-5 relevant hashtags.
- Credible and specific — reference the actual idea in the clip, don't be generic.

Return only the caption text (including hashtags).`;

// ---------------------------------------------------------------------------
// 4. Targeted summaries (uses the one-pager, re-angled per audience)
// ---------------------------------------------------------------------------
export const TARGETED_SYSTEM = `You re-angle a webinar summary for a specific audience segment of GFPBAP's community, drawing out what is most relevant and actionable for them. Stay faithful to the source summary — re-frame and emphasize, do not add new facts.`;

export const AUDIENCES = {
  researchers: 'researchers, product developers, and scientists working on alternative proteins — emphasize technical substance, research directions, methods, and open questions',
  industry: 'industry professionals such as service providers, vendors, and commercial operators — emphasize market signals, partnerships, business implications, and where the sector is heading',
  careers: 'high-impact career seekers looking to enter or grow in this field — emphasize where the opportunities are, what skills and roles matter, and how to position themselves',
};

export const TARGETED_USER = ({ onePager, audience }) => `Here is the webinar one-pager summary:
---
${onePager}
---

Rewrite this as a targeted summary for: ${audience}.

Keep it to a few tight paragraphs. Lead with what this audience most needs to know. Return only the rewritten summary.`;
