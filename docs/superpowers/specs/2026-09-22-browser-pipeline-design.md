# Browser pipeline: running the webinar pipeline with no backend

**Date:** 2026-09-22
**Branch:** `browser-pipeline`
**Status:** approved design, not yet implemented

## Why

`pipeline_one` currently runs as a local FastAPI server (`server.py`) over a Python
package (`pipeline/`), with `ffmpeg` and `yt-dlp` on PATH. That is fine for one
machine that has been set up by hand, and wrong for a team tool: every teammate has
to install Python, install ffmpeg, keep a key in a `.env`, and start a server before
they can do anything.

The requirement is a tool the team opens like a web page, that keeps the recording
and every output on the laptop, and that nobody has to host. Calling Anthropic over
the network is accepted — that is the substance of the product. Nothing else leaves
the machine.

## Constraints

- **No backend to operate.** No FastAPI, no uvicorn, no process to start.
- **The recording never leaves the laptop.** It is read as a local `File`; no upload.
- **Transcript text goes to Anthropic, and nothing else does.** This is the single
  accepted network dependency.
- **Chromium-family browsers only.** The File System Access API and WebCodecs are
  not in Firefox or Safari. This is an internal tool; that is acceptable.
- **Quality is not traded for locality.** The pipeline keeps calling Opus over the
  full transcript with prompt caching, structured output and adaptive thinking.

## Non-goals

- Multi-user state, accounts, or any shared server-side store.
- Running the pipeline on a machine that does not hold the master recording.
- Replacing the review desk's design. The existing front end is kept.
- In-browser speech-to-text. (Noted as a later option; see Deferred.)

## Distribution

The `web/` folder is published to GitHub Pages from this repo and installed as a PWA.
A service worker caches every asset on first load, so the tool runs offline after
that and updates when the repo is pushed.

GitHub Pages serves static assets only. It cannot see the recording, the output, or
the API key, and it cannot set COOP/COEP headers — which is why the design does not
depend on `SharedArrayBuffer` (see Cutting).

Each teammate stores their own Anthropic API key in their own browser's IndexedDB.
There is no shared secret, because there is no server to hold one. Separate
workspace keys per person are recommended so spend is attributable.

## Architecture

Three threads. The split follows what blocks: the main thread draws, the run worker
waits on the network, the cut worker saturates a core.

```
main thread      index.html · app.js · format.js · api.js
      |            (views, unchanged except api.js's transport)
      |  postMessage — the same event objects that are SSE today
      v
run worker       runner.js · steps.js · llm.js · prompts.js
      |          transcript.js · manifest.js · store.js
      |  postMessage
      v
cut worker       cut.js — WebCodecs encode, one clip at a time
```

### Why the front end survives

`runner.py` already pushes progress through an `emit(event)` callback of plain
dicts, precisely so the CLI and the web app could each render them without knowing
about the other. Those event shapes are unchanged:

```
{type:'stage', key, status:'running'|'done', label, detail}
{type:'clip',  status:'cut'|'caption'|'skipped', base, group, ...segment}
{type:'count', key:'clips', total}
{type:'note',  level:'info'|'warn', message}
```

`api.js` swaps `EventSource` for `worker.onmessage`; `app.js` and `format.js` are
untouched. The rule that a stage reports a count only once the count is known still
holds — the clip total still arrives with the selection result.

### Module map

| Today | Becomes | Note |
|---|---|---|
| `pipeline/runner.py` | `web/runtime/runner.js` | same stage order, same events |
| `pipeline/steps.py` | `web/runtime/steps.js` | one-pager, select_clips, caption, targeted |
| `pipeline/prompts.py` | `web/runtime/prompts.js` | still the tuning surface; `PREAMBLE` still byte-frozen |
| `pipeline/llm.py` | `web/runtime/llm.js` | `@anthropic-ai/sdk` in the browser |
| `pipeline/transcript.py` | `web/runtime/transcript.js` | cue parsing, time conversion, slicing |
| `pipeline/manifest.py` | `web/runtime/manifest.js` | walks a directory handle instead of a `Path` |
| `pipeline/media.py` | `web/runtime/cut.js` | WebCodecs instead of ffmpeg |
| `pipeline/config.py` | `web/runtime/store.js` | paths become handles; settings in IndexedDB |
| `pipeline/jobs.py` | folded into `runner.js` + the output folder | see Resume |
| `pipeline/bundle.py` | `web/runtime/zip.js` | scoped `all`/`clips`/`text`, unchanged semantics |
| `server.py` | deleted | |
| `run.py` | deleted | see Decisions |
| `pipeline/drive.py` | deferred | see Deferred |
| `read_transcript.py` | **kept as Python** | see Transcript ingest |

Files live under `web/runtime/`; `web/vendor/` holds three vendored ESM bundles
(`@anthropic-ai/sdk`, `mp4box.js`, `mp4-muxer`). Vendored, not fetched from a CDN,
so the PWA works offline and so a CDN outage cannot break a run. There is still no
build step.

## Storage

`showDirectoryPicker()` is called once and returns a handle to a working folder
laid out exactly as the repo is today:

```
<working folder>/
  webinar recordings/<webinar>.mp4
  transcripts/<webinar>.txt
  output/<slug>/...
```

The handle is persisted in IndexedDB and re-verified with `queryPermission()` on
return, which costs the user one click per browser session.

**The folder remains the source of truth.** `manifest.js` reconstructs a run by
reading the folder, the same principle `manifest.py` documents: a hand-edited
caption window is reflected because the manifest is derived from the files, and
older runs (`.txt` captions, no `panelists/`) still open. `run.json` keeps carrying
only what the folder cannot know — the YouTube source, the original name, the
timestamps.

IndexedDB holds exactly three things: the API key, the directory handle, and the
settings (segment count, panelist clips). Nothing that belongs in the folder.

### Resume

A dedicated worker dies when the page reloads, so unlike `jobs.py` the run cannot be
resumed from in-memory history. It does not need to be: `runner.js` writes each
artifact as it is produced, so the output folder is the checkpoint. On reload, the
run is reconstructed with `manifest.js` and any completed step is skipped. This is
strictly better than today, where a server restart loses the event history.

Only one run at a time, as today. The run worker refuses a second start.

## LLM layer

`llm.js` uses the official TypeScript SDK in the browser:

```js
new Anthropic({ apiKey, dangerouslyAllowBrowser: true })
```

which sends `anthropic-dangerous-direct-browser-access: true`, the header that opts
a request into CORS on `api.anthropic.com`. Anthropic documents browser support on
the TypeScript SDK and names this case — an internal tool with trusted users
supplying their own keys — as the sanctioned one.

Everything else about the call shape is carried over verbatim from `llm.py`:

- `call_with_transcript()` keeps the frozen `PREAMBLE` plus the transcript in the
  system block behind one `cache_control` breakpoint, with the per-task instruction
  in the user turn. Caching is a request-side feature and works identically from a
  browser.
- `call()` stays the plain helper for captions and targeted summaries.
- Adaptive thinking stays on.
- Structured output stays `output_config.format` with a JSON schema.
- **Every call streams.** `messages.stream()` + `finalMessage()`. The reason is
  unchanged: the SDK refuses a non-streaming request whose `max_tokens` could outrun
  the HTTP timeout, and clip selection runs at 32k.
- The `_text()` guard is ported as-is — a truncated response can carry thinking
  blocks and no text block, and it must fail with the `stop_reason`, not a bare
  undefined.

Cache hit/miss is logged to the console as it is to stderr today.

The model stays `claude-opus-4-8` as `config.py` sets it. (`claude-opus-5` is
available at the same price and would be a separate, deliberate change.)

## Cutting

### Cut at export, not during the run

Today the pipeline cuts every selected clip during the run, and `--cut-only` exists
so a human can fix a bad window afterwards and re-cut just that one. That two-pass
flow exists because cutting is expensive and happens before review.

In the browser it does not have to. The master `.mp4` is a local `File`; the review
desk plays a clip by seeking a `<video>` between two timestamps. No file is produced
and nothing is encoded until the reviewer approves and exports.

This means:

- A run is text only: one-pager, selection, captions, targeted summaries. Minutes,
  no encoding.
- Re-windowing is a UI interaction, not a file edit plus a second pass.
- Only approved clips are ever encoded.
- `--no-clips` and `--cut-only` cease to be modes; the behaviour they provided is
  what the tool always does.

`caption_window` parsing is kept regardless, because the caption file's header is
still where a window lives on disk and a hand-edited header must still be honoured.

### The encoder

WebCodecs, in `cut.js`:

1. `mp4box.js` demuxes the master, reading byte ranges lazily off the `File` — the
   1–2 GB recording is never read into memory whole.
2. `VideoDecoder` decodes from the keyframe at or before the in-point;
   `AudioDecoder` decodes the matching audio range.
3. Frames before the in-point are discarded, which is what makes the cut
   frame-accurate — the same reason `media.py` re-encodes rather than stream-copies.
4. `VideoEncoder` (H.264) and `AudioEncoder` (AAC) re-encode, hardware-accelerated.
5. `mp4-muxer` writes a faststart MP4, returned as a `Blob`.

Behind one interface — `cut(file, startSec, endSec) -> Blob` — so an ffmpeg.wasm
implementation can be added for a codec WebCodecs rejects, without touching callers.
The masters in use are H.264/AAC from YouTube and Zoom, which WebCodecs handles.

ffmpeg.wasm was rejected as the primary path: without cross-origin isolation (which
GitHub Pages cannot provide) it is single-threaded, putting a 60-second 1080p clip
in the minutes, against seconds for a hardware encode — and it ships 25 MB of WASM.

## Export

Unchanged in spirit: `all` / `clips` / `text`, as today's `bundle.py` scopes them.
Two destinations:

- Write the clips into `output/<slug>/` in the working folder, alongside the markdown
  the run already wrote. This is the default, and it makes the folder match exactly
  what the Python pipeline produced.
- A `.zip` download for handoff.

## Transcript ingest

`--video-id` cannot be ported. YouTube's caption endpoints do not send CORS headers,
so no browser can fetch them, and `yt-dlp` is a binary.

`read_transcript.py` therefore stays, as the one remaining Python script: a
standalone ingest tool, run occasionally, writing `transcripts/<webinar>.txt`. It is
already standalone today and imports nothing from `pipeline/`.

The web app's transcript input becomes: pick the `.txt` from the folder, or paste the
transcript into a textarea (it is written to `transcripts/<webinar>.txt` before the
run starts, so the folder stays the source of truth either way).

### The transcript-exists check goes away

`runner.py:114` and `server.py:258` currently branch on whether
`transcripts/<webinar>.txt` is already on disk, because a missing transcript meant
"fetch it from YouTube with this video id, or fail". With the YouTube path gone,
that branch has nothing left to decide.

The browser runner therefore takes the transcript as an input, not as something to
look up:

- The run cannot start until a transcript has been supplied — picked or pasted. This
  is enforced at the input view, alongside "choose a recording", the same way the
  run button is already gated there.
- `runner.js` reads the transcript it was handed and goes straight to parsing cues.
  No existence test, no fetch fallback, no "provide a YouTube link so it can be
  fetched" error.
- `transcript_on_disk` disappears from the file card, and with it `server.py`'s
  "that YouTube link doesn't contain a video id" rejection.
- The one check that stays is the *content* check: `T.parse()` finding no
  `[HH:MM:SS]` cues is still an error, because a transcript without timestamps
  cannot produce clip windows.

The YouTube link keeps its other job — it is recorded in `run.json` as the run's
source, and the review desk uses it for links back to the recording. It is no longer
an ingest mechanism.

## What is deleted

`server.py`, `run.py`, and the FastAPI, uvicorn and python-multipart dependencies go
without replacement — nothing in the browser build corresponds to them.

The rest of `pipeline/` is superseded rather than dropped: every module in the map
above has a `web/runtime/` counterpart that carries its behaviour over, including
`jobs.py` (its one-run-at-a-time rule and reviewer-facing error messages move into
`runner.js`) and `bundle.py` (its `all`/`clips`/`text` scoping moves into `zip.js`).
`pipeline/` itself is deleted only once `web/runtime/` reaches parity; until then it
stays on the branch as the reference implementation.

## Spike results (both run 2026-09-22, both passed)

Two throwaway spikes were run before planning. The code lives in `spike/`, which is
gitignored — it is reference material for the implementation, not shippable.

**Spike 1 — Anthropic from a browser page.** Real `PREAMBLE`, real transcript
(92,528 chars), `claude-opus-4-8`, streaming, from `http://127.0.0.1`:

| Call | Result |
|---|---|
| plain, streamed | 4.7 s, `cache_write=35701` — CORS works, stream drains to a final message |
| same prefix, different task | 3.3 s, `cache_read=35701` — **the transcript cache is shared and read** |
| structured output, `select_clips`-shaped schema | 9.0 s, parsed 2 clips with valid `HH:MM:SS` windows |

**Unexpected finding, and it applies to the Python pipeline today.** The structured
call reported `cache_read=0` and a *second* `cache_write` of 36,057 — the schema adds
~356 tokens ahead of the cached prefix, so a schema-bearing call gets its own cache
entry and cannot read the plain calls'. `llm.py`'s docstring claims the transcript
prefix is "shared by the one-pager and segment-selection calls"; it is not, and has
not been. Nothing breaks — repeated *selection* calls still hit their own entry,
which is the dev loop caching was for, exactly as `CLAUDE.md` says. The docstring is
what needs correcting, in both the Python and the ported version.

**Spike 2 — one WebCodecs cut.** 60-second window at 1800 s out of a 149 MB, 93-minute
master (640×360 H.264, mp4a.40.5 HE-AAC), demuxed with mp4box.js over HTTP ranges,
re-encoded, muxed with mp4-muxer:

- **12.3 s** wall clock, output 9.2 MB, **4.2 MB of the 149 MB source read**.
- Seeked to the keyframe at 1795.48 s, decoded 1637 frames, dropped 137 before the
  in-point, encoded **exactly 1500 = 60 s × 25 fps**.
- ffprobe: `duration=60.000363`, video 1500 frames `start_time=0`, audio 2584 AAC
  frames `start_time=0`. A full `ffmpeg -f null -` decode reports no errors.
- **Frame accuracy confirmed by PSNR** against the master: 47.25 dB at 1800 s versus
  32.14 dB at 1799 s and 33.09 dB at 1801 s. The peak is unambiguous.

**Two findings the implementation must carry:**

1. **`DataStream` is a separate global** in mp4box's UMD build, not `MP4Box.DataStream`.
   Trivial, but it is the first thing that fails.
2. **The container's audio sample rate lies.** These masters are HE-AAC (`mp4a.40.5`);
   mp4box reports 22050 Hz, SBR doubles it, and the decoder emits 44100 Hz. Configuring
   the `AudioEncoder` or the muxer's audio track from the container value throws
   *"Unsupported sample rate"*. `cut.js` must decode one frame first and take the real
   rate and channel count from it. Encoding always targets AAC-LC (`mp4a.40.2`).

One thing did **not** get verified: `<video>` playback of the result inside the page.
The element stayed at `readyState 0` — but so did the untouched master loaded as a
control, so it is the automated tab, not the file, and ffprobe/ffmpeg confirm the file
is sound. Worth a glance during implementation; not a risk to the design.

### Remaining risks, accepted

- **Chromium only.** Stated above; acceptable for an internal team.
- **Per-person API keys.** No server means no place to hide a shared key. Mitigated
  with per-person workspace keys.
- **The operator needs the master on disk.** Reviewers do not; they read the output
  folder, or the zip.

## Testing

The pipeline's logic — cue parsing, time conversion, transcript slicing, caption
header writing and re-parsing, manifest reconstruction — is pure and gets unit tests
that run headless. The two I/O boundaries (Anthropic, WebCodecs) are covered by the
spikes above and then by a single end-to-end run against a real short recording,
which is how the pipeline is verified today.

## Decisions taken under assumption

Both were flagged and left unanswered at approval. Either can be reversed cheaply.

1. **`run.py` is deleted.** Keeping it would mean `prompts.py` and `prompts.js`
   existing side by side and drifting, and the browser's text-only run is a faster
   tuning loop than the CLI was. If the CLI is wanted back, the honest way is to run
   `web/runtime/` under Node rather than to keep a second copy of the prompts.
2. **Drive upload is deferred, not deleted.** `drive.py` stays on the branch unported.
   The zip covers handoff for v1. A browser Drive upload (Google's JS client, OAuth
   popup) is a self-contained addition afterwards, and `drive.status()`'s pattern —
   name exactly what is missing, carry on — is what the UI should keep doing in the
   meantime.

## Deferred

- Browser Drive upload.
- In-browser speech-to-text (Whisper via WebGPU / transformers.js), which would remove
  the last Python script.
- An ffmpeg.wasm fallback behind the `cut()` interface, for unusual codecs.
