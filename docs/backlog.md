# Backlog

Changes wanted, captured 2026-09-25 on `assemblyai-v2`. Ordered roughly by size,
not by priority.

## 1. Export controls (small) — **done**

- ~~**Hide "Cut clips to folder" unless a folder mirror is attached**~~ — now
  `hidden`, not disabled (`settings.js`'s `renderMirrorMeta`).
- ~~**Drop "Zip: text" and "Zip: clips."**~~ — `zip.js`'s `members()` scoping
  stays; it just stopped being a user-facing choice.
- ~~**Rename "Zip: all" → "Download zip folder"**~~ — a `<details>` dropdown
  offering "With subtitles" / "Without subtitles", which threads `subtitles`
  through to `encodeApprovedClips`. The subtitled zip downloads as
  `<slug>-subtitled.zip` so the two flavours don't overwrite each other in
  Downloads.

**One thing this uncovered.** Making subtitles a per-export choice broke the
mirror's resume check: it skipped a clip whose `.mp4` was already on the
folder, with no way to tell a subtitled cut from a clean one, so "Without
subtitles" would have handed back whatever was cut last. Fixed with
`output/<slug>/cut-state.json` — `clip.id -> 'sub'|'raw'`, bookkeeping
alongside `selection.json` and excluded from every zip scope the same way. A
missing entry reads as `raw`, which is true by construction.

## 2. Burned-in subtitles (medium) — **done** (blocks tier)

Clips are for social, where they autoplay muted, so subtitles are the default
expectation rather than an extra.

**The data already exists — and is now kept.** AssemblyAI returns every word
with `start`, `end` and `speaker` — 12,211 of them for an 84-minute webinar.
`transcribe.js` used to map those into ~3.2s cues and discard the timings;
`runner.js` now writes them to `transcripts/<name>.words.json`, which shipped
for sentence snapping (see CLAUDE.md) and is what the word-level subtitle tier
would read.

Two tiers, and the cheap one needs no new data:

| Tier | Source | Gives |
|---|---|---|
| Blocks | the cues already stored | standard subtitles, ~3.2s per card |
| Word-level | `words.json` | highlight-as-spoken, which is what performs on social |

**Mechanism fits `cut.js` as it stands.** It already decodes each frame to a
`VideoFrame` and re-encodes. Subtitles are one step in the middle: draw the
frame to an `OffscreenCanvas`, draw the text over it, build a `VideoFrame` from
the canvas, encode that. No new dependency, no ffmpeg.

**Cost:** a canvas draw per frame. Currently ~9s per 60s clip; expect 20–40s
with subtitles, so eleven clips goes from ~2 min to ~6. Once a month.

**Constraint worth designing around:** the masters are 640×360. Text has to be
sized for a small frame that will be scaled up on a phone.

**Settled:** bold white, light outline, plain blocks, sentence case, lower
centre, no speaker labels on screen. Shipped as `runtime/subtitles.js` +
the compositing step in `cut.js`. The word-level tier is still open, and
still needs `words.json` to be kept.

## 3. Editable prompts, and re-running only what changed (large)

The big one. Two scopes and a dependency-aware rerun.

**Designed — see [`editable-prompts-design.md`](editable-prompts-design.md).**
That note supersedes this section where they disagree; in particular the
claim below that `PREAMBLE` "sits above all of them" is wrong, and the note
says why.

### Scopes

| Scope | Lives in | Applies to |
|---|---|---|
| Default | settings, IndexedDB | every future run |
| Per-run | the run's own folder | that run's reruns only |

Per-run overrides belong in the run folder, not in browser storage — the folder
is the source of truth, and a run should stay reproducible from it alone.
Something like `output/<slug>/prompts.json`.

### Only re-run what the edit actually invalidates

This is the part to get right, and the project has already been bitten twice by
resuming on a file's *existence* when it should have checked *agreement*
(C1 and C2 in the final review). The same trap applies here: the naive version
re-runs everything, the careless version re-runs nothing.

The stages are not independent — `targeted_summary` takes the one-pager's text
as input, and captions are written against the windows selection produced:

```
transcript ──┬──> one-pager ──> targeted summaries
             └──> selection ──> captions ──> (cut clips)
```

So the invalidation rules are:

| Prompt edited | Re-runs | Also invalidates |
|---|---|---|
| `ONE_PAGER` | one-pager | targeted summaries (they consume its text) |
| `CLIPS` | selection | captions, and any already-cut `.mp4` |
| `CAPTION_*` | captions | any already-cut `.mp4` for changed captions |
| `TARGETED_*` | targeted summaries | nothing |

`PREAMBLE` sits above all of them, so editing it invalidates everything.

### Detecting the change

Hash each prompt as it is used and record the hashes in `run.json`. On a rerun,
recompute and compare: a stage whose prompt hash differs re-runs, along with
everything downstream of it. Everything else is left alone.

This also gives the run a record of exactly which prompt produced which
artifact, which the folder currently cannot answer.

### Reruns skip AssemblyAI

Already true and for the right reason — `runner.js`'s transcript precedence
puts an on-disk `transcripts/<name>.txt` ahead of any network call. A rerun
never re-transcribes. Worth an explicit test rather than relying on it.

### Notes

- `PREAMBLE` is the prompt-cache prefix. A per-run edit to it means that run
  writes its own cache entry — acceptable, but worth surfacing so nobody edits
  it casually and wonders why the first call got slower.
- The drift test against `pipeline/prompts.py` is already skipped (that file is
  deleted), so `prompts.js` is free to change shape.
- Editable prompts need a reset-to-default affordance, or a bad edit leaves the
  tool broken with no way back.
