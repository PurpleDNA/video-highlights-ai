# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`pipeline_one` is the first stage of a pipeline for the **Global Forum for Plant-Based and Alternative Proteins (gfpbap)**. It turns a recorded monthly webinar into review-ready distribution material:

1. **One-pager** — a few-paragraph summary for people who won't watch the recording.
2. **Highlight clips** — the strongest moments overall, cut from the master video and ranked, each with a draft social caption.
3. **Per-panelist clips** — for each panelist, up to 3 candidate clips of their own best moments, so each can be offered a choice of clips to post on their own socials. Highlights and per-panelist clips are chosen in one pass and deduplicated: a panelist's moment that is also an overall highlight goes only to `clips/`, never cut twice.
4. **Targeted summaries** — the one-pager re-angled for three audiences: researchers/product developers, industry professionals, and high-impact career seekers.

All AI-generated text is written as markdown (`.md`).

All output is drafts for human review, written into a per-webinar folder tree under `output/`.

## Run

The tool is `web/`: a static site with no server, no build step, and no framework. Every teammate opens it in a Chromium-family browser (Chrome, Edge) — Firefox and Safari can't run it, because it depends on two APIs neither ships: File System Access, to read and write the work folder, and WebCodecs, to cut clips. That's an accepted trade for an internal tool.

On first open, a File System Access prompt asks for a work folder laid out exactly as the repo used to expect:

```
<work folder>/
  webinar recordings/<webinar>.mp4
  transcripts/<webinar>.txt
  output/<slug>/...
```

**The output folder remains the source of truth**, the same principle the old `manifest.py` documented: the review UI reconstructs a run by reading the folder, not from a database or an in-memory record, so a hand-edited caption window shows up and an older, Python-made run (`.txt` captions, no `panelists/`) still opens. The folder handle and the API key live in the browser's IndexedDB — nothing else does. Re-opening the tool costs one permission click to re-confirm folder access; that's the whole cost of there being no server to hold a session.

Paste or pick the transcript, choose the recording, paste your own Anthropic API key, and run. The rest — one-pager, clip selection, captions, targeted summaries — happens over the network against Anthropic only. Nothing else leaves the machine; the recording is read as a local `File` and never uploaded.

### The three threads

```
main thread      index.html · app.js · format.js · api.js      — draws, and owns the one native dialog (showDirectoryPicker)
run worker       runner.js · steps.js · llm.js · prompts.js …  — waits on the network
cut worker       cut.js                                        — saturates a core, one clip at a time
```

The split follows what blocks. The run worker can't call `showDirectoryPicker` or answer its permission prompt itself — those only work on the main thread — so the main thread does the picking and hands the already-granted directory handle over by `postMessage`. The run worker posts the same plain-dict progress events the old `emit()` callback produced (`{type: 'stage', ...}`, `{type: 'clip', ...}`, `{type: 'count', ...}`, `{type: 'note', ...}`), so `app.js` and `format.js` render a run exactly as before; only `api.js`'s transport changed, from `EventSource` to `worker.onmessage`. The cut worker is separate from the run worker because encoding is CPU-bound and would otherwise stall the run's own progress messages.

### Cut at export, not during the run

Previously, cutting was expensive enough that production runs went in two passes — a text-only pass to review clip windows, then a cutting pass once they looked right — which is why `--no-clips` and `--cut-only` existed as CLI flags.

In the browser, a clip plays by seeking the local master file between two timestamps, so re-windowing a clip is a UI interaction, not a file edit followed by a second pass. Nothing is encoded until export. That makes the two-pass flow unnecessary rather than merely faster: **`--no-clips` and `--cut-only` no longer exist as modes**, because a run is always text-only (one-pager, selection, captions, targeted summaries — minutes, no encoding) and cutting always happens once, on demand, at export.

**"Approved clips" means every clip in the run's manifest** — every `*_caption.md` the run wrote for a window that passed the length/range checks. There is no approve flag anywhere in the code or the UI. That follows directly from the folder being the source of truth: if the file's there, export cuts it, the same way editing a caption's header in place is what "fix this window" means.

**Deleting a caption file is not a durable reject — know this before relying on it as one.** It is undone the moment the run is resumed: `runner.js`'s clip stage iterates `selection.json`'s segments regardless of what's currently in `clips/`/`panelists/`, so a caption missing only because a reviewer deleted it looks identical to one never written, and it is quietly regenerated on the next resume. And even while the caption stays deleted, an already-exported `.mp4` for that clip is untouched — `export.js` only skips re-cutting a clip whose `.mp4` already exists; it never checks whether the caption that produced it is still there — and `zip.js` builds a `clips`/`all` zip by walking every file under `clips/`/`panelists/` on disk, not by the manifest, so that `.mp4` still ships. **The only way to actually drop a clip once it's been exported is to delete both its caption file and its `.mp4` (`clips/<base>.mp4` or `panelists/<slug>/<base>.mp4`), before the next resume regenerates the caption.** If a run hasn't been resumed and the clip was never exported, deleting just the caption is enough for that session — but it will not survive either event.

Export writes clips into `output/<slug>/` at the same paths the Python pipeline used — `clips/<base>.mp4`, `panelists/<slug>/<base>.mp4` — so a folder this tool finishes is indistinguishable from one the old pipeline finished, and re-running export skips a clip whose `.mp4` is already on disk. A `.zip` download is the other export path, built from the folder on disk rather than from anything held in memory, so it matches exactly what a reviewer would see by opening the folder.

**`bundle.py`'s three zip scopes (`all` / `clips` / `text`) still exist in `zip.js`'s `members()`, but they are no longer a choice the reviewer makes.** They were a port of a CLI flag that existed because the CLI had no UI to choose in; the review desk offers one action, "Download zip folder", which always builds `all`. What the reviewer chooses instead is how subtitles ship: "Ready to post" burns them into the pixels; "Editable subtitles" leaves the video clean and adds a `<clip>.srt` beside each `.mp4` (`subtitles.js`'s `toSrt`, built from the same `cuesForWindow` cues the burn-in draws), so transcription mistakes — speaker names, British vs American spelling — can be fixed before remuxing. See below. `members()` stays because it is still how the archive is assembled, and because a `text` zip is what lets `exportRun` skip encoding entirely for a markdown-only bundle.

**Subtitles are burned into the pixels, which makes a subtitled cut and a clean one different artifacts sharing one filename.** That matters for resumability: the mirror's "this clip's `.mp4` is already there, skip it" check can't tell them apart from the file. `output/<slug>/cut-state.json` records `clip.id -> 'sub'|'raw'` for every clip written to the mirror, and the skip only fires when the recorded mode matches the one being asked for. A clip with no entry reads as `'raw'`, which is true by construction — burned-in subtitles did not exist before that file did. Like `selection.json` it is the app's own bookkeeping, not part of the output tree a reviewer opens, and `zip.js` excludes it from every scope.

### Clip windows are snapped to sentences in code, not by the prompt

`prompts.js`'s CLIPS has always said *"never cut mid-sentence. Use the cue timestamps to find clean boundaries."* **That instruction could not be satisfied**, which is why clips cut mid-sentence from the very first run:

- The transcript the model reads is `[HH:MM:SS] A: text` lines, and every timestamp in it is a **cue start**. `transcribe.js`'s `wordsToCues()` breaks a cue on a speaker change or after 3000ms — time slicing, with no relation to sentence structure.
- A cue start therefore lands on a sentence start only by luck (roughly half the time, since a speaker change usually is one). But a sentence's **end** is a word's end time, and no word end time appears anywhere in that document. Asking for a clean `end` was asking the model to copy a number that was not on the page.

This is structural, not a model failure, and no prompt wording fixes it. `snap.js` fixes it instead: the model picks the moment it means, and the window is then moved onto the nearest real boundary in code, deterministically, before `selection.json` is written — so the checkpoint, the caption header, the review desk's playback and the cut `.mp4` all agree on one window, and a resume never re-snaps.

Two tiers, because not every transcript has word timings:

| Source | Boundary accuracy |
|---|---|
| `transcripts/<name>.words.json` (AssemblyAI) | exact — real sentence starts and ends |
| cues alone (pasted, or the YouTube fetch) | one cue — "the start of a cue whose predecessor ended on a full stop" |

With neither, nothing moves and the model's own choice stands. Tolerance is 2.5s, deliberately under the ~3.2s median cue gap, so a snap can never slide a window past a whole cue into a different thought; a snap that would invert a window or take it under `MIN_CLIP_SEC` is refused. Rounding to the `HH:MM:SS` the rest of the pipeline stores goes **outward** — floor the start, ceil the end — because rounding the end down would clip the tail off the very word it just snapped to.

`transcripts/<name>.words.json` is written by `runner.js` (not `transcribe.js`, which stays free of `fsroot` so its tests need no filesystem) whenever AssemblyAI supplies words. It is free data already paid for, it is the only source of sentence-end times in the pipeline, and re-fetching it means paying again. It is optional everywhere: missing, empty or corrupt all degrade to the cue tier with a note, never a failed run. **Runs made before this existed have no sidecar** and fall back to the cue tier.

### `output/<slug>/selection.json`

This file has no Python counterpart. The old server kept a run's full event history in memory, so resuming mid-run after a reload just replayed that history. A dedicated Worker has no such memory across a reload — it dies with the page. Instead, `runner.js` treats the output folder itself as the checkpoint: before doing a stage's work it checks whether that stage's file already exists and skips the call that would have produced it. That works cleanly for one-pager, captions and targeted summaries, each of which is one file per unit of work — but the clip stage's file *names* (`highlight-01_<speaker>`, `clip-01`, ...) are derived from the 32k-token clip-selection call's result. Without `selection.json` on disk, resuming mid-clips would have to either re-run that selection call — and a fresh roll does not reproduce the windows an earlier pass already committed to disk — or leave the folder holding captions chosen by two different selections. `selection.json` exists purely so a reload mid-clips can pick up with the same selection instead of a new one; it is not part of the documented output tree a reviewer opens, and export and the zip both ignore it.

### `output/<slug>/run-log.txt` — the troubleshooting log

Every run, resume and export appends to this file under its own `====` header (`runtime/runlog.js`): each progress event, each model call's duration/stop reason/tokens (`llm.js`'s `setLogger`), which transcript source was used (and whether it was reused from disk), the recording's size and duration, audio extraction's expected vs. extracted samples, the AssemblyAI transcript id, and full error stacks. Two coverage checks also surface on screen as warnings: extracted audio under 98% of the audio track, and a transcript ending before 75% of the recording — the second runs on reused transcripts too, since a bad one saved by an earlier run is otherwise reused silently. **"Download log"** (failure card, results header) bundles the file with browser/app-version/storage details and this session's page errors. No API keys or transcript text are ever logged; like `run.json` it is bookkeeping, excluded from every zip.

## Architecture

Comments throughout `web/` (`captions.js`, `manifest-parse.js`, `manifest.js`, `transcript.js`, `runner.js`, `export.js`, `zip.js`, `llm.js`, `app.js`, `api.js`, and more) refer to `pipeline/*.py`, `server.py`, and `jobs.py` — files this branch deleted. That history is genuinely useful provenance for why a piece of code looks the way it does, not stale cruft, and is left in place on purpose. To read the Python itself, look at git history before commit `055c86c` (the commit that removed `pipeline/`, `server.py`, and `run.py`).

`web/runtime/` is the ported pipeline; every module in the old `pipeline/` package has a direct counterpart there (`runner.py` → `runner.js`, `steps.py` → `steps.js`, `prompts.py` → `prompts.js`, `llm.py` → `llm.js`, `transcript.py` → `transcript.js`, `manifest.py` → `manifest.js`, `media.py` → `cut.js`, `config.py` split across `config.js`/`store.js`, `bundle.py` → `zip.js`). `jobs.py`'s one-run-at-a-time rule and reviewer-facing error handling live in `runner.js` now; there is no separate job registry because there is no server process for one to belong to.

`web/vendor/` holds vendored, unmodified third-party bundles — `@anthropic-ai/sdk`, `mp4box.js`, `mp4-muxer`, `fflate` — not fetched from a CDN. That is what lets the PWA (see below) work fully offline and keeps a CDN outage from breaking a run.

### PWA and offline

`web/manifest.webmanifest` and `web/sw.js` make the tool installable and let it keep running with no network at all, except for the one call that needs it. The service worker caches every file under `web/` on install and serves cache-first. **One entry matters more than it looks:** `web/vendor/mp4box.js`. `mp4box-esm.js` always fetches that file itself at runtime — not as a fallback for an unusual browser, but on every load, because loading a classic UMD script as an ES module leaves its top-level `var`s scoped to the module and they never reach `self`, so `self.MP4Box` is undefined every time and the fetch-and-`new Function` path always runs. Miss that one file in the precache list and everything else about the app works offline except the one thing the tool is for.

### Releasing an update — read this before every push

**Bump `SW_VERSION` in `web/sw.js` every time anything under `web/` changes. This is the entire release step, and it is not optional.**

The service worker is cache-first with no revalidation (see `web/sw.js`'s own comment). It only ever re-fetches the precached files in its `install` handler, and the browser only ever runs `install` when `sw.js`'s own bytes differ from what an installed client already has. So: change `app.js`, `runner.js`, `prompts.js`, any `runtime/*` or `vendor/*` file — anything — without also touching `sw.js`, and the byte-for-byte-identical `sw.js` gives every installed client no signal that anything changed. They keep running the old code forever, even though the repo, and every other file in it, has moved on. There is no build step here to catch this for you; a person has to.

The fix is one line: `SW_VERSION` at the top of `web/sw.js` (it composes `CACHE_NAME`, so nothing else needs editing). Increment it as the last step before shipping any change that touches `web/`. If you forget, the push did not ship — it only looks like it did.

### Two measured WebCodecs findings

Both came out of a throwaway spike (`spike/`, gitignored) before `cut.js` was written, and both are load-bearing enough that `cut.js` carries a comment at the point each one is worked around:

1. **`DataStream` is a separate global**, not `MP4Box.DataStream`, in mp4box's UMD build. It's the first thing that fails without knowing this.
2. **The container's audio sample rate lies.** These masters are HE-AAC (`mp4a.40.5`); mp4box reports 22050 Hz, SBR doubles it on decode, and the decoder actually emits 44100 Hz. Configuring the `AudioEncoder` or the muxer's audio track from the container's declared rate throws *"Unsupported sample rate"* — it has to be read back from the first decoded audio frame instead, never trusted from the container.

The cut itself is otherwise what `media.py` did: decode from the keyframe at or before the in-point, discard frames before it (that's what makes the cut frame-accurate, the same reason the old pipeline re-encoded rather than stream-copied), then re-encode with `VideoEncoder`/`AudioEncoder` and mux a faststart MP4 with `mp4-muxer`. The spike measured 12.3s wall clock and 4.2 MB read to cut a 60-second window out of a 149 MB master, confirmed frame-accurate by PSNR.

## Key facts

- **Model:** Opus 4.8. At one webinar/month, API cost is a rounding error — optimize for quality. Prompt caching is for dev-loop speed, not savings.
- **The transcript cache is not shared the way it was believed to be.** The old `llm.py` docstring claimed the cached transcript prefix was shared by the one-pager and clip-selection calls. Measured twice, it is not: a call carrying `CLIPS_SCHEMA` for structured output gets its own separate cache entry, because the schema is inserted ahead of the cached prefix rather than after it — 36,081 tokens written fresh versus 35,701 for the plain calls. Nothing breaks from this — repeated *selection* calls still hit their own entry on the next run, which is the dev-loop speedup caching was for — but the shared-prefix claim itself was wrong and this file is the corrected version of it.
- **Every call streams**, with no exception, including the small ones. The clip-selection call is the pipeline's largest output and runs at 32k tokens for headroom — it was silently failing at 16k, because a truncated response can carry thinking blocks and no text block at all, and `_text()`/`textOf()` raises with the `stop_reason` rather than return `undefined` when that happens. Because that ceiling exists, every call goes out via `messages.stream()` + the final-message helper: the SDK refuses a non-streaming request whose `max_tokens` could outrun the **10-minute HTTP timeout**. Streaming here is only about the timeout — callers still get back the whole assembled message.
- **Per-person API key.** Each teammate pastes their own Anthropic key, held only in their own browser's IndexedDB. There is no server to hide a shared one in, so there is no shared one — separate workspace keys per person are recommended so spend is attributable.
- **Chromium-family only**, and specifically because of File System Access (the work-folder handle, re-verified with `queryPermission()` each session) and WebCodecs (the cut path). Neither ships in Firefox or Safari. Acceptable for an internal team tool; not acceptable if this ever needs to reach reviewers directly rather than through the exported folder or zip.
- **Transcript ↔ video alignment:** clip timestamps are transcript-relative and fed straight to the cutter. If a master `.mp4` starts at a different point than its transcript, set `TRANSCRIPT_OFFSET_SEC` in `config.js`. For "Reflections on COP30" they align (offset 0).
- **Clip windows are still the review surface.** Each `_caption.md` header still carries `**HH:MM:SS–HH:MM:SS**` — optionally `HH:MM:SS.5`, since the review desk nudges a window by ±0.5s (`transcript.js`'s `formatWindowTime` writes a tenth only when there is one, so whole-second headers are unchanged); editing it by hand and leaving the file in place is still how a bad window gets fixed, because export always cuts from whatever window is on disk at export time, not from whatever the selection call originally chose.

## What remains Python

**`read_transcript.py` only** — the standalone YouTube-transcript ingest tool, run occasionally to produce a transcript file for `transcripts/`. It stays because it has to: YouTube's caption endpoints send no CORS headers, so no browser script can fetch them, and the alternative (`yt-dlp`) is a binary, not something a static site can call. It already imported nothing from `pipeline/`, so deleting that package left it untouched. It takes the video id and webinar name as arguments and writes `transcripts/<webinar>.txt`:

```powershell
pip install -r requirements.txt
python read_transcript.py --video-id 8UPCTR7Ma7I --webinar "Reflections on COP30"
```

Everything else that used to be Python — the FastAPI server, the CLI, `ffmpeg` and `yt-dlp` on PATH, the `pipeline/` package — is gone. `web/runtime/` is not a second copy running alongside a first; it is the only copy now.

## Dependencies

- `youtube-transcript-api` — the one dependency `read_transcript.py` needs.
- The front end has no install step at all: `web/vendor/` vendors its three JavaScript dependencies (`@anthropic-ai/sdk`, `mp4box.js`, `mp4-muxer`) plus `fflate` for zipping, checked into the repo rather than pulled from a CDN, so the PWA works offline and a CDN outage can't break a run.

Text deliverables are written as plain markdown, so there is no document-library dependency on either side.
