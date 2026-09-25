# Video Highlights AI

Turn a recorded webinar into review-ready distribution material — **entirely in the browser.** No server, no build step, no framework, no upload of your recording.

Point it at a local `.mp4` and it produces:

- **A one-pager** — a few paragraphs for people who won't watch the recording.
- **Highlight clips** — the strongest moments, ranked, cut from the master, each with a draft social caption and optional burned-in subtitles.
- **Per-panelist clips** — up to three of each speaker's own best moments, so every panelist can be offered a choice to post themselves.
- **Targeted summaries** — the one-pager re-angled for researchers, industry, and career seekers.

Everything is drafts for human review, written as markdown into a per-webinar folder.

## How it works

```
main thread   index.html · app.js · api.js        draws; owns the one native dialog
run worker    runner.js · steps.js · llm.js …     waits on the network
cut worker    cut.js                              saturates a core, one clip at a time
```

The split follows what blocks. Clips are cut with **WebCodecs** — decode from the keyframe at or before the in-point, drop frames before it, re-encode, and mux a faststart MP4. That makes the cut frame-accurate rather than keyframe-aligned, confirmed by PSNR against a reference. Cutting a 60-second window out of a 149 MB master measures ~12s wall clock and reads 4.2 MB.

Output lives in **OPFS**, which the browser exposes through the same `FileSystemDirectoryHandle` interface as a real folder — so the same code writes to either, and "also save to a folder" is one optional handle away.

**The output folder is the source of truth.** The review UI reconstructs a run by reading the folder, not a database, so a hand-edited caption window shows up and an older run still opens.

### The network boundary

Two calls leave the machine, both to APIs you hold the key for:

| Service | For | Roughly |
|---|---|---|
| Anthropic | the writing and clip selection | $2–4 per webinar |
| AssemblyAI | transcription, with speaker labels and ~3.2s cues | $0.37 per webinar |

**The recording itself is never uploaded** — it is read as a local `File`. Only extracted audio goes to AssemblyAI, and only transcript text to Anthropic. Keys are stored in your own browser's IndexedDB; there is no server to hold a shared one.

### Clip windows are snapped in code

The model is asked not to cut mid-sentence, but the transcript it reads contains only **cue start** timestamps — time slices, broken on a speaker change or every 3 seconds. A sentence's *end* is a word's end time, which appears nowhere in that document, so a clean end was never something it could pick.

`runtime/snap.js` fixes that after the fact: the model chooses the moment it means, and the window is moved onto the nearest real sentence boundary — exactly, using AssemblyAI's word timings, or to within one cue without them.

## Running it

It is a static site. Serve `web/` and open it in a Chromium-family browser:

```bash
cd web && python -m http.server 8000
```

Chromium-family only, and deliberately: it needs **WebCodecs** to cut and **File System Access / OPFS** to store. Neither ships in Firefox or Safari. It installs as a PWA and works offline apart from the two API calls above — `web/vendor/` vendors every dependency rather than pulling from a CDN.

Add your two API keys in Settings, pick a recording, and run.

```bash
npm test    # 92 tests, no dependencies — node --test
```

## Layout

| Path | |
|---|---|
| `web/` | the whole app |
| `web/runtime/` | the pipeline: runner, steps, prompts, cutting, zipping |
| `web/vendor/` | vendored deps — Anthropic SDK, mp4box, mp4-muxer, fflate |
| `test/` | `node --test`, no test framework |
| `docs/` | design notes and backlog |
| `CLAUDE.md` | architecture and the reasoning behind it — start here |

`read_transcript.py` is the one piece of Python left: YouTube's caption endpoints send no CORS headers, so a browser script cannot fetch them.

---

Made by [PurpleDNA](https://github.com/PurpleDNA).
