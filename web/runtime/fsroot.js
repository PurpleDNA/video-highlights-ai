/** The tool's storage root, and every read and write inside it.
 *
 * This is what config.py's paths become, laid out exactly as the repo was:
 *     <root>/transcripts/<webinar>.txt
 *     <root>/output/<slug>/...
 * (there is no `webinar recordings/` under the root any more — see below).
 *
 * The root itself is OPFS (`navigator.storage.getDirectory()`), not a folder
 * the operator has to create and maintain: it needs no permission prompt, is
 * always there, and `manifest.js`/`runner.js`/`zip.js` need no changes at all
 * to use it, because OPFS hands back the same `FileSystemDirectoryHandle`
 * interface a real folder does — only where the handle comes from changes.
 *
 * The one thing that deliberately never lives under this root is the webinar
 * recording itself: at ~150MB, and one click to re-pick, it is held only as
 * an in-memory `File` for the session (see api.js) rather than copied in.
 *
 * A real folder is still available, but only as an *optional* mirror — "also
 * save to a folder" — picked with `pickMirror()` below and attached at
 * export time. It is never required to run the pipeline or review a run.
 */

import { getMirrorHandle, setMirrorHandle } from './store.js';
import { RECORDINGS_DIR, TRANSCRIPTS_DIR, OUTPUT_DIR } from './config.js';
import { slug } from './slug.js';

// navigator.storage.persist() only ever needs asking once per origin; guard
// against calling it again on every getRoot() (e.g. once per manifest read).
let persistRequested = false;

/** The tool's storage root: OPFS, always available, no permission prompt.
 *  Also requests persistence once per session so a long-running project
 *  isn't evicted under storage pressure — best-effort; nothing here depends
 *  on the browser actually granting it. */
export async function getRoot() {
  if (!persistRequested) {
    persistRequested = true;
    try { await navigator.storage.persist(); } catch { /* best-effort only */ }
  }
  return navigator.storage.getDirectory();
}

/** Open the optional mirror folder with the native picker — "also save to a
 *  folder". Never required: everything above already works against OPFS
 *  alone. The handle is remembered across reloads; the permission it carries
 *  is not (see getMirror() below). */
export async function pickMirror() {
  const handle = await showDirectoryPicker({ id: 'gfpbap-mirror', mode: 'readwrite' });
  await setMirrorHandle(handle);
  return handle;
}

/** The remembered mirror folder, or null if there is none or the user
 *  declines re-granting its permission. */
export async function getMirror() {
  const handle = await getMirrorHandle();
  if (!handle) return null;
  const opts = { mode: 'readwrite' };
  if (await handle.queryPermission(opts) === 'granted') return handle;
  if (await handle.requestPermission(opts) === 'granted') return handle;
  return null;
}

/** Walk (and optionally create) a '/'-separated path below the root. */
export async function dir(root, path, { create = false } = {}) {
  let h = root;
  for (const part of path.split('/').filter(Boolean)) {
    h = await h.getDirectoryHandle(part, { create });
  }
  return h;
}

async function fileHandle(root, path, { create = false } = {}) {
  const parts = path.split('/').filter(Boolean);
  const name = parts.pop();
  const parent = await dir(root, parts.join('/'), { create });
  return parent.getFileHandle(name, { create });
}

export async function getFile(root, path) {
  try {
    return await (await fileHandle(root, path)).getFile();
  } catch (e) {
    if (e.name === 'NotFoundError') return null;
    throw e;
  }
}

export async function readText(root, path) {
  const file = await getFile(root, path);
  return file ? file.text() : null;
}

export async function writeText(root, path, text) {
  const handle = await fileHandle(root, path, { create: true });
  const w = await handle.createWritable();
  await w.write(text);
  await w.close();
}

export async function writeBlob(root, path, blob) {
  const handle = await fileHandle(root, path, { create: true });
  const w = await handle.createWritable();
  await w.write(blob);
  await w.close();
}

export async function exists(root, path) {
  return (await getFile(root, path)) !== null;
}

/** Remove a file or a whole directory tree below the root. A path that is
 *  already gone is not an error — the end state is the same. */
export async function remove(root, path) {
  const parts = path.split('/').filter(Boolean);
  const name = parts.pop();
  try {
    const parent = await dir(root, parts.join('/'));
    await parent.removeEntry(name, { recursive: true });
  } catch (e) {
    if (e.name !== 'NotFoundError') throw e;
  }
}

/** Entries of a directory; [] if it is not there. */
export async function listDir(root, path) {
  let h;
  try {
    h = await dir(root, path);
  } catch (e) {
    if (e.name === 'NotFoundError') return [];
    throw e;
  }
  const out = [];
  for await (const [name, entry] of h.entries()) out.push({ name, kind: entry.kind });
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export const recordingPath = (name) => `${RECORDINGS_DIR}/${name}.mp4`;
export const transcriptPath = (name) => `${TRANSCRIPTS_DIR}/${name}.txt`;
// Word timings from AssemblyAI, beside the transcript they were built from.
// Optional everywhere: a pasted or YouTube-fetched transcript has none, and
// snap.js falls back to cue-level boundaries when it is absent.
export const wordsPath = (name) => `${TRANSCRIPTS_DIR}/${name}.words.json`;

/** Every path a run touches, derived from the webinar name. */
export function pathsFor(name) {
  const out = `${OUTPUT_DIR}/${slug(name)}`;
  return {
    out,
    clips: `${out}/clips`,
    panelists: `${out}/panelists`,
    targeted: `${out}/targeted`,
  };
}
