/** All prompts live here — this is the file you tune.
 *
 * EDITABLE vs LOCKED. Every prompt is split in two. The editable half —
 * DEFAULT_PROMPTS below — is editorial judgment: who GFPBAP is, what a good
 * one-pager or clip or caption looks like, how each audience is framed. It
 * can be overridden per browser from the settings page (store.js's
 * getPrompts; settings.js), and a run uses whatever is saved there. The
 * locked half — the *_LOCKED strings — is what the code depends on: the
 * transcript's format, the never-invent-facts guard, the clip selection's
 * time format, output fields, speaker naming and limits (runner.js and
 * snap.js read those back), and "return only the text" (the reply is
 * written to disk verbatim). buildPrompts() always appends the locked half,
 * so no edit can remove it.
 *
 * Slots: an editable prompt that needs run data names it as {{slot}} — see
 * PROMPT_FIELDS for which prompt has which, and which are required.
 * validatePrompt() refuses a missing required slot (the model would silently
 * never see that data) or an unknown one (it would be sent literally).
 *
 * Design note on caching: the preamble is sent as a system block, with the
 * transcript cached immediately after it (see llm.callWithTranscript), so
 * editing the preamble costs one fresh cache write on the next run — cents,
 * at one webinar a month. The task prompts ride after the cache breakpoint.
 *
 * Measured 2026-09-22: a call that carries CLIPS_SCHEMA gets its OWN cache
 * entry and cannot read the plain calls' — the schema sits ahead of the cached
 * prefix. Repeated selection calls still hit their own entry.
 */

// ---------------------------------------------------------------------------
// Editable defaults — what the settings page starts from and resets to.
// ---------------------------------------------------------------------------
export const DEFAULT_PROMPTS = {
  preamble: `You are an editorial assistant for the Global Forum for Plant-Based and Alternative Proteins (GFPBAP), a nonprofit that democratizes knowledge about sustainable food systems and alternative proteins largely through a monthly webinar series.`,

  onePager: `Write a one-page summary of this webinar for someone who will not watch or listen to the recording.

Requirements:
- A few flowing paragraphs (roughly 300-450 words). No bullet lists.
- Open with what the webinar was about and why it matters.
- Cover the key points, arguments, and takeaways in the order they build.
- Name the topic and the substance of what panelists argued — but only what the transcript supports.
- Plain, engaging prose a busy professional can read in two minutes. No preamble like "This webinar..." as the first words; start with the substance.`,

  clipGuidance: `- Pick a self-contained moment: a sharp insight, a memorable framing, a surprising fact, or a compelling exchange. It should make sense without the surrounding context.
- Target 30-90 seconds of runtime.
- Write a short "title" (a few words) and a one-sentence "rationale".`,

  captionSystem: `You are a social media manager for GFPBAP. You write post captions that match the energy of short video clips and drive engagement, while staying accurate and credible (this is a knowledge nonprofit, not a hype account).`,

  caption: `Write a social media caption for a short video clip titled "{{title}}".

Here is the transcript of the clip:
---
{{clip_transcript}}
---

Requirements:
- Match the clip's energy: a strong hook in the first line.
- 2-4 short sentences, then 3-5 relevant hashtags.
- Credible and specific — reference the actual idea in the clip, don't be generic.`,

  targetedSystem: `You re-angle a webinar summary for a specific audience segment of GFPBAP's community, drawing out what is most relevant and actionable for them.`,

  targeted: `Here is the webinar one-pager summary:
---
{{one_pager}}
---

Rewrite this as a targeted summary for: {{audience}}.

Keep it to a few tight paragraphs. Lead with what this audience most needs to know.`,

  audienceResearchers: 'researchers, product developers, and scientists working on alternative proteins — emphasize technical substance, research directions, methods, and open questions',
  audienceIndustry: 'industry professionals such as service providers, vendors, and commercial operators — emphasize market signals, partnerships, business implications, and where the sector is heading',
  audienceCareers: 'high-impact career seekers looking to enter or grow in this field — emphasize where the opportunities are, what skills and roles matter, and how to position themselves',
};

// ---------------------------------------------------------------------------
// Locked — appended by buildPrompts(), never editable. See the module comment.
// ---------------------------------------------------------------------------
const PREAMBLE_LOCKED = `You are working from the transcript of one webinar, provided below. It is timestamped [HH:MM:SS] at each caption cue. The discussion is between a host and expert panelists, with audience Q&A. Your job is to turn this raw discussion into polished, accurate material for distribution. Never invent facts, statistics, names, or claims that are not supported by the transcript.`;

// Clip selection's fixed opening; the editable guidance follows it, then
// clipsTail()'s rules. Both are shown on the settings page around the box.
const CLIPS_HEAD = `Select the segments of this webinar worth clipping for social media, and attribute each to who is speaking — so we can feature the strongest moments overall and also offer every panelist a choice of their own clips.

First, identify the panelists. A panelist is an expert speaker — not the host/moderator and not an audience member. Refer to each panelist by their name as stated in the transcript (how the host introduces them, or how they introduce themselves). If a panelist's name is not discernible, use "Panelist 1", "Panelist 2", and so on.

For every segment you select:`;

const ONE_PAGER_LOCKED = 'Return only the summary text.';
const CAPTION_LOCKED = 'Return only the caption text (including hashtags).';
const TARGETED_SYSTEM_LOCKED = 'Stay faithful to the source summary — re-frame and emphasize, do not add new facts.';
const TARGETED_LOCKED = 'Return only the rewritten summary.';

// The audience keys are fixed — they name the output files (targeted/<key>.md)
// — only each one's description is editable.
const AUDIENCE_FIELDS = {
  researchers: 'audienceResearchers',
  industry: 'audienceIndustry',
  careers: 'audienceCareers',
};

/** What the settings page shows, in order. `slots` lists the {{slots}} a
 *  prompt may use; `required` ones must appear. `lockedBefore` / `locked`
 *  are shown read-only above / below the box, as part of the same prompt,
 *  so it reads as the text the model actually gets. */
export const PROMPT_FIELDS = [
  {
    key: 'preamble', label: 'House context', rows: 4,
    help: 'Who GFPBAP is. Sent ahead of the transcript on the one-pager and clip-selection calls.',
    slots: [], locked: PREAMBLE_LOCKED,
  },
  {
    key: 'onePager', label: 'One-pager', rows: 10,
    help: 'Length, tone and structure of the summary.',
    slots: [], locked: ONE_PAGER_LOCKED,
  },
  {
    key: 'clipGuidance', label: 'Clip selection — what makes a good clip', rows: 5,
    help: 'Editorial judgment only. How many clips, the time format and speaker naming are fixed by the run settings and the rules around this box.',
    slots: [],
    lockedBefore: CLIPS_HEAD,
    locked: `${clipsTail({ highlights: '[highlight count]', perPanelist: '[clips per panelist]' })}\n\n`
      + '[When the transcript has speaker labels, a note on using them is added here.]',
  },
  {
    key: 'captionSystem', label: 'Caption — voice', rows: 3,
    help: 'Who writes the captions, and in what register.',
    slots: [], locked: '',
  },
  {
    key: 'caption', label: 'Caption — instructions', rows: 11,
    help: 'Written once per clip.',
    slots: [
      { name: 'title', required: false, meaning: "the clip's title" },
      { name: 'clip_transcript', required: true, meaning: "the transcript of the clip's window" },
    ],
    locked: CAPTION_LOCKED,
  },
  {
    key: 'targetedSystem', label: 'Audience summaries — voice', rows: 3,
    help: 'How the one-pager is re-angled.',
    slots: [], locked: TARGETED_SYSTEM_LOCKED,
  },
  {
    key: 'targeted', label: 'Audience summaries — instructions', rows: 8,
    help: 'Written once per audience below.',
    slots: [
      { name: 'one_pager', required: true, meaning: 'the one-pager text' },
      { name: 'audience', required: true, meaning: "that audience's description, below" },
    ],
    locked: TARGETED_LOCKED,
  },
  { key: 'audienceResearchers', label: 'Audience — researchers', rows: 3, help: 'targeted/researchers.md', slots: [], locked: '' },
  { key: 'audienceIndustry', label: 'Audience — industry', rows: 3, help: 'targeted/industry.md', slots: [], locked: '' },
  { key: 'audienceCareers', label: 'Audience — careers', rows: 3, help: 'targeted/careers.md', slots: [], locked: '' },
];

const FIELD_BY_KEY = Object.fromEntries(PROMPT_FIELDS.map((f) => [f.key, f]));

/** Replace every {{slot}} in `template` with `values[slot]`. */
export function fill(template, values) {
  return template.replace(/\{\{(\w+)\}\}/g, (m, name) => (name in values ? String(values[name]) : m));
}

/** Problems with an edited prompt, as reviewer-facing sentences; [] if fine. */
export function validatePrompt(key, text) {
  const field = FIELD_BY_KEY[key];
  if (!field) return [`Unknown prompt "${key}".`];
  if (!String(text || '').trim()) return ['This prompt is empty.'];
  const problems = [];
  const allowed = new Set(field.slots.map((s) => s.name));
  for (const s of field.slots) {
    if (s.required && !text.includes(`{{${s.name}}}`)) {
      problems.push(`Needs {{${s.name}}} — ${s.meaning}. Without it the model never sees that.`);
    }
  }
  const unknown = [...new Set([...text.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]))]
    .filter((name) => !allowed.has(name));
  for (const name of unknown) {
    problems.push(allowed.size
      ? `{{${name}}} isn't a slot here — use ${[...allowed].map((n) => `{{${n}}}`).join(' or ')}.`
      : `{{${name}}} isn't a slot — this prompt has none.`);
  }
  return problems;
}

/** Defaults overlaid with whatever valid edits `saved` holds. An invalid
 *  edit falls back to its default rather than reaching a run; unknown keys
 *  (an import from a newer version, say) are dropped. */
export function resolvePrompts(saved) {
  const out = { ...DEFAULT_PROMPTS };
  for (const [key, text] of Object.entries(saved || {})) {
    if (key in DEFAULT_PROMPTS && typeof text === 'string' && !validatePrompt(key, text).length) {
      out[key] = text;
    }
  }
  return out;
}

/** The keys whose text differs from the default — for the run log. */
export function customizedKeys(p) {
  return Object.keys(DEFAULT_PROMPTS).filter((k) => p[k] !== DEFAULT_PROMPTS[k]);
}

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
// Not put in the preamble: whether labels are present is a fact about *this
// run's* transcript, not about the assistant's job in general, and the
// one-pager has no reason to see it — it never attributes individual moments
// to a speaker — so it belongs in CLIPS's own task text, scoped to the one
// call that actually attributes clips.
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
// Clip selection — one pass that both ranks the overall highlights and
// attributes every clip to a speaker (full transcript; structured JSON).
// Doing this in a single call means each moment is chosen once, so a panelist
// highlight is never also cut as a separate per-panelist clip. Only
// `guidance` is editable; everything around it is what runner.js relies on.
// ---------------------------------------------------------------------------

function clipsTask(guidance, { highlights, perPanelist, speakerLabels = false }) {
  return `${CLIPS_HEAD}
${guidance.trim()}

${clipsTail({ highlights, perPanelist })}${speakerLabels ? SPEAKER_LABEL_NOTE : ''}`;
}

function clipsTail({ highlights, perPanelist }) {
  return `Rules for every segment:
- Snap "start" and "end" to complete thoughts — never cut mid-sentence. Use the cue timestamps to find clean boundaries, and copy them verbatim as "HH:MM:SS" strings.
- Set "speaker" to the panelist's name when a single panelist is speaking; use "host" for the moderator and "panel" for a multi-speaker exchange.

Coverage and limits:
- For each panelist, include at most ${perPanelist} of their strongest moments where that panelist is the one speaking — fewer is fine if they don't have that many, but never more.
- Mark the ${highlights} strongest moments of the whole webinar as highlights by setting "highlight" to true (every other segment is false). A highlight may belong to a panelist, the host, or the panel. A panelist's highlighted moments count toward their ${perPanelist} limit.

Ordering: list the highlights first, strongest to weakest, then the remaining clips grouped by panelist (each panelist's clips strongest first).`;
}

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

/** Every prompt a run sends, built from resolved prompts (`resolvePrompts`):
 *  each editable part with its locked part appended. steps.js calls these. */
export function buildPrompts(p) {
  const audiences = Object.fromEntries(
    Object.entries(AUDIENCE_FIELDS).map(([audienceKey, field]) => [audienceKey, p[field]]));
  return {
    preamble: `${p.preamble.trim()}\n\n${PREAMBLE_LOCKED}`,
    onePager: `${p.onePager.trim()}\n\n${ONE_PAGER_LOCKED}`,
    clips: (opts) => clipsTask(p.clipGuidance, opts),
    captionSystem: p.captionSystem.trim(),
    captionUser: ({ title, slice }) =>
      `${fill(p.caption.trim(), { title, clip_transcript: slice })}\n\n${CAPTION_LOCKED}`,
    targetedSystem: `${p.targetedSystem.trim()} ${TARGETED_SYSTEM_LOCKED}`,
    targetedUser: ({ onePager, audienceKey }) =>
      `${fill(p.targeted.trim(), { one_pager: onePager, audience: audiences[audienceKey] })}\n\n${TARGETED_LOCKED}`,
    audiences,
  };
}

// ---------------------------------------------------------------------------
// The built-in prompts under their original names, for anything that wants
// the defaults directly (test/prompts.test.js; steps.js's audience keys).
// ---------------------------------------------------------------------------
const DEFAULTS_BUILT = buildPrompts(DEFAULT_PROMPTS);
export const PREAMBLE = DEFAULTS_BUILT.preamble;
export const ONE_PAGER = DEFAULTS_BUILT.onePager;
export const CLIPS = DEFAULTS_BUILT.clips;
export const CAPTION_SYSTEM = DEFAULTS_BUILT.captionSystem;
export const CAPTION_USER = DEFAULTS_BUILT.captionUser;
export const TARGETED_SYSTEM = DEFAULTS_BUILT.targetedSystem;
export const AUDIENCES = DEFAULTS_BUILT.audiences;
export const TARGETED_USER = ({ onePager, audience }) =>
  `${fill(DEFAULT_PROMPTS.targeted.trim(), { one_pager: onePager, audience })}\n\n${TARGETED_LOCKED}`;
