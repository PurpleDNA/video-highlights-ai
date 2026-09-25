# Editable prompts, and re-running only what changed

Design note, 2026-09-25, `assemblyai-v2`. Expands `backlog.md` item 3 into
decisions. Not a task plan — no code has moved yet.

Two things are wanted: prompts editable as defaults (settings) and per-run
(the review page), and a rerun that regenerates **only what the edit actually
invalidated**.

---

## 1. The editable surface is not what `prompts.js` exports

This is the decision everything else follows from, so it goes first.

Four of the seven prompts are not strings. They are template **functions**
with interpolated JavaScript:

```js
export const CAPTION_USER = ({ title, slice }) => `... titled "${title}" ...
---
${slice}
---`;
```

A textarea cannot hold that. So the editable form is a **string with named
placeholders**, and the runtime substitutes:

```
Write a social media caption for a short video clip titled "{{title}}".

Here is the transcript of the clip:
---
{{slice}}
---
```

| Prompt | Placeholders it must contain |
|---|---|
| `PREAMBLE` | — |
| `ONE_PAGER` | — |
| `CLIPS` | `{{highlights}}`, `{{perPanelist}}`, `{{speaker_labels_note}}` |
| `CAPTION_SYSTEM` | — |
| `CAPTION_USER` | `{{title}}`, `{{slice}}` |
| `TARGETED_SYSTEM` | — |
| `TARGETED_USER` | `{{onePager}}`, `{{audience}}` |

`{{speaker_labels_note}}` deserves a word: today it is
`${speakerLabels ? SPEAKER_LABEL_NOTE : ''}` — a conditional the editor
exposes as a placeholder that resolves to the note or to nothing.
`detectSpeakerLabels()` stays code; only its insertion point is editable.

### Not editable, and why

- **`CLIPS_SCHEMA`.** Not prose. `runner.js` and `manifest.js` read
  `start`/`end`/`speaker`/`highlight` by name; renaming a field there breaks
  clip parsing with an error that points nowhere near the edit.
- **`AUDIENCES`.** It is the *content* of `{{audience}}`, not a prompt.
  Editable later, deliberately out of v1.
- **`detectSpeakerLabels`, `MIN_CLIP_SEC`, the window regexes.** Code.

### Placeholders are validated at save time, not at run time

A `CAPTION_USER` saved without `{{slice}}` produces a caption written with no
transcript at all — fluent, confident, and about nothing. It would not throw.
It would write eleven wrong files and look like a bad model day.

**Save is rejected when a required placeholder is missing, naming it.** This
is the single highest-value guard in the feature, and it is five lines.

---

## 2. Two scopes, resolved in one order

| Scope | Lives in | Applies to |
|---|---|---|
| Default | IndexedDB, via `store.js` | every future run |
| Per-run | `output/<slug>/prompts.json` | that run's reruns only |

Resolution, per prompt: **run override → settings default → built-in
`prompts.js`**.

Per-run overrides go in the run folder, not browser storage, for the reason
the whole project already runs on: the folder is the source of truth and a
run should be reproducible from it alone.

### Both stores are sparse — this is load-bearing

Store **only the prompts actually edited**. Never write all seven.

If opening the editor once froze the full set at today's text, a teammate who
peeked at `ONE_PAGER` in March would still be running March's `CLIPS` in
December, having never chosen that and having no way to notice. Sparse
storage means an untouched prompt keeps tracking `prompts.js`, and "reset to
default" is `delete overrides[key]` — not pasting the built-in text back in,
which would re-freeze it in place.

---

## 3. Detecting the change

Hash each **resolved** prompt at the moment it is used, and record it in
`run.json`:

```json
"prompts": { "ONE_PAGER": "a3f1…", "CLIPS": "9c02…", "CAPTION_USER": "…" }
```

On a rerun, resolve and re-hash; a stage whose hash differs is invalidated.
Hash the *resolved* text, so an edit to the settings default and an identical
per-run override are correctly the same thing.

SHA-256 via `crypto.subtle.digest`, truncated to 16 hex chars — bookkeeping,
not security. It is async, which is fine inside `runner.js`. `crypto.subtle`
needs a secure context, but so do OPFS and File System Access, so the app
already cannot run anywhere this would fail. No new constraint.

This also answers a question the folder currently cannot: which prompt
produced which artifact.

**Variable substitutions are excluded from the hash** — only the template is
hashed. Otherwise every clip's `CAPTION_USER` hashes differently (each has its
own `{{slice}}`) and the whole comparison is noise. Changing `segments` or
`perPanelist` is a settings change, already recorded in `run.json.settings`,
and is not a prompt edit.

---

## 4. What invalidates what

```
transcript ─┬─> ONE_PAGER ──> one-pager.md ──> TARGETED_* ──> targeted/*.md
            └─> CLIPS ─────> selection.json ─> CAPTION_* ──> *_caption.md ──> *.mp4
```

**Correction to `backlog.md`:** it says `PREAMBLE` "sits above all of them."
It does not. `steps.js` sends captions and targeted summaries through
`llm.call({system, user})`, which never receives `PREAMBLE` — only
`callWithTranscript` does, i.e. the one-pager and clip selection. Editing
`PREAMBLE` does end up invalidating everything, but *transitively*, through
those two. That matters because it means there is no special case:

> **One rule.** A stage re-runs if its own prompt hash changed, or if any
> stage it consumes re-ran.

Everything below is that rule applied, not a table to maintain separately:

| Edited | Re-runs | Cascades to |
|---|---|---|
| `PREAMBLE` | one-pager, selection | targeted, captions, cut `.mp4`s |
| `ONE_PAGER` | one-pager | targeted |
| `CLIPS` | selection | captions, cut `.mp4`s |
| `CAPTION_SYSTEM` / `CAPTION_USER` | captions | cut `.mp4`s |
| `TARGETED_SYSTEM` / `TARGETED_USER` | targeted | — |

---

## 5. The mechanism: delete, then resume

`runner.js` already resumes on file presence. So a rerun is:

1. Resolve prompts, hash, diff against `run.json.prompts`.
2. Walk the graph to the invalidated set.
3. **Delete exactly those files.**
4. Run `runPipeline` unchanged.

No second resume system, no new skip logic, no stage-state machine. The path
that runs is the one already proven in production.

It does create two hazards, and one of them is serious.

### 5a. Hand-edited clip windows would be destroyed — must fix

`captionText(seg, caption)` rebuilds the header from `selection.json`:

```js
`**${seg.start}–${seg.end}** · ${seg.rationale}\n\n`
```

CLAUDE.md is explicit that this header *is* the review surface — editing it
by hand is how a bad window gets fixed, and export always cuts from whatever
window is on disk. A `CAPTION_*` rerun as described would silently revert
every hand-edited window to what the selection call originally chose, and the
next export would cut the reverted windows.

**Required, not optional:** when re-running a caption for a clip whose file
exists, read the window off disk first (`readCaption`, already in
`manifest-parse.js`) and write the new body under the **existing** window.
`captionText` takes an optional window override. Small change; without it the
feature quietly destroys review work.

### 5b. Stale `.mp4`s — already handled

Rewriting a caption bumps its mtime past the mirrored `.mp4`, and
`encodeApprovedClips` already re-cuts on exactly that signal (plus
`cut-state.json`, from the export work). The cascade to video needs no new
code. Worth an assertion in a test rather than trust.

### 5c. The transcript is never deleted

The rerun must never touch `transcripts/<name>.txt` — that is what keeps
AssemblyAI out of a rerun (`runner.js`'s transcript precedence). Currently
true by construction; make it an explicit test, since the new code path is
one whose whole job is deleting files.

### 5d. No conflict with the existing `transcriptChanged` guard

That guard refuses when the transcript changed *and* derived output exists. A
prompt rerun deletes derived output and never touches the transcript, so
`transcriptUnchanged` stays true and it never fires. Worth noting that the
two policies differ on purpose: an unexpectedly changed transcript **refuses**
(the reviewer may not have meant it), an edited prompt **proceeds** (the edit
is the instruction). The difference is intent, and it is why the rerun shows
its work before running — see below.

---

## 6. UI

**Settings** — the seven prompts, each collapsed to its name, expanding to a
textarea. Per-prompt "Reset to default" (deletes the override). A placeholder
legend beside each. `PREAMBLE` carries a note that it is the prompt-cache
prefix, so editing it makes the next run's first call slower.

**Review page — "Re-run with changes"** — the same editor, scoped to this run,
plus a preview of **exactly what will be regenerated and what will be
deleted**, before anything happens. Given that the mechanism is
delete-then-resume, this is not a nicety; it is the confirmation step for a
destructive operation, and it is where the one-rule cascade becomes legible
("editing CLIPS will also discard 11 captions").

---

## 7. Shape

| File | Role |
|---|---|
| `web/runtime/prompts.js` | built-ins, converted to placeholder strings + `render()` |
| `web/runtime/prompt-store.js` | *new* — resolution, hashing, invalidation graph. Pure; unit-testable |
| `web/prompt-editor.js` | *new* — the editor, shared by settings and review |
| `web/runtime/runner.js` | hashes into `run.json`; otherwise unchanged |
| `web/runtime/captions.js` | `captionText` takes an optional window override (§5a) |

**The `prompts.js` refactor carries real risk** and gets a cheap, decisive
test: assert the rendered placeholder version is **byte-identical** to the
current function output for a fixed set of vars. Byte-identical matters beyond
tidiness — `PREAMBLE` is the cache prefix, and a stray whitespace change
silently invalidates every cached transcript entry.

Suggested order: settings scope first (it exercises resolution, hashing and
the graph end to end), per-run second, since it adds only a second store and
the preview UI.

---

## 8. Open — these change the work

1. **Promote a per-run override to the default?** "This rerun's CLIPS worked,
   keep it." One button, but it makes the run folder a write path into
   settings, which nothing else does.
2. **"Reset all" in settings**, or per-prompt only? Per-prompt alone is safer;
   an operator who has broken three prompts may want one click out.
3. **Is a rerun allowed to re-run a stage whose prompt did *not* change?** As
   specified, no — which means there is no "just do the whole thing again"
   button. Cheapest to add now if it is wanted.
