/** Zip a run's output folder for handoff — the browser port of
 *  `pipeline/bundle.py`, scoped identically:
 *    - `all`   — the whole run folder.
 *    - `clips` — the `.mp4` files and their captions (`clips/` +
 *      `panelists/`).
 *    - `text`  — the markdown (`targeted/` plus the one-pager).
 *  `run.json`, `selection.json` and `cut-state.json` are never included, in
 *  any scope — all three are the app's own bookkeeping (see runner.js's
 *  module comment on `selection.json`, and export.js's on `cut-state.json`),
 *  not part of what a reviewer opens, the same rule `bundle.py` followed.
 *
 * Text and caption members are built from the folder on disk (via fsroot),
 * not from anything already held in memory, so they always match what a
 * reviewer would see by opening the folder themselves, including a caption
 * whose window was hand-edited after the run finished.
 *
 * A clip's `.mp4` is different: since the OPFS root the rest of this walks
 * never holds one (see export.js's module comment — cutting straight into
 * the zip is the point, precisely to avoid writing video to OPFS that's
 * about to be downloaded anyway), `clipBlobs` carries them in from
 * export.js's `encodeApprovedClips` instead — a `Map` of the same `clip.id`
 * (relative path, no extension) to a `Blob`, folded in here alongside
 * whatever `walkFiles` found on disk.
 *
 * fflate (vendored into web/vendor/, no runtime CDN) does the deflate;
 * `zipSync`'s synchronous, whole-archive-in-memory API is fine here — a
 * run's whole output tree runs to tens of megabytes, not a video library.
 */

import { zipSync } from '../vendor/fflate.js';
import { listDir, getFile } from './fsroot.js';
import { OUTPUT_DIR } from './config.js';

export const SCOPES = {
  all: 'Everything',
  clips: 'Clips and captions',
  text: 'One-pager and summaries',
};

const BOOKKEEPING_FILES = new Set(['run.json', 'selection.json', 'cut-state.json']);

/** Every file (not directory) under `<base>/<prefix>`, as paths relative to
 *  `base`, recursively — mirrors bundle.py's `sorted(out.rglob("*"))`
 *  filtered to files, minus the app's own bookkeeping. listDir already sorts
 *  each directory's own entries, matching Python's `sorted(glob(...))`. */
async function walkFiles(root, base, prefix = '') {
  const out = [];
  for (const entry of await listDir(root, prefix ? `${base}/${prefix}` : base)) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.kind === 'file') {
      if (BOOKKEEPING_FILES.has(entry.name)) continue;
      out.push(rel);
    } else {
      out.push(...await walkFiles(root, base, rel));
    }
  }
  return out;
}

/** bundle.py's `_members`: which of a run's files belong to a given scope.
 *  `files` are paths relative to the run's own folder, e.g.
 *  `clips/highlight-01_host.mp4` or `targeted/researchers.md`. Exported
 *  (unlike `walkFiles`) because it is pure — no fsroot, no browser globals —
 *  and is exactly the logic worth unit-testing; the disk walk around it
 *  isn't. */
export function members(files, scope) {
  if (scope === 'clips') {
    return files.filter((f) => {
      const top = f.split('/')[0];
      return top === 'clips' || top === 'panelists';
    });
  }
  if (scope === 'text') {
    return files.filter((f) => {
      const top = f.split('/')[0];
      const name = f.split('/').pop();
      const stem = name.slice(0, name.lastIndexOf('.') === -1 ? name.length : name.lastIndexOf('.'));
      return top === 'targeted' || stem === 'one-pager';
    });
  }
  return files;
}

/** Zip `output/<slugName>` for `scope` ('all' | 'clips' | 'text', default
 *  'all'). `clipBlobs` (default empty) is the `Map` of `clip.id -> Blob`
 *  export.js's `encodeApprovedClips` returns — see the module comment above
 *  for why a clip's video comes from there rather than from disk. Returns
 *  `{blob, filename}` — `filename` matches bundle.py's `zip_run` naming:
 *  `<slug>.zip` for 'all', `<slug>-<scope>.zip` otherwise. Throws for an
 *  unknown scope or one with nothing to bundle, exactly as bundle.py does
 *  (there via ValueError / FileNotFoundError). */
export async function zipRun(root, slugName, scope = 'all', clipBlobs = new Map()) {
  if (!(scope in SCOPES)) throw new Error(`Unknown scope '${scope}'`);

  const base = `${OUTPUT_DIR}/${slugName}`;
  const picked = members(await walkFiles(root, base), scope);

  const archive = {};
  for (const rel of picked) {
    const file = await getFile(root, `${base}/${rel}`);
    if (!file) continue; // vanished between listing and reading — skip it, don't fail the whole zip
    archive[`${slugName}/${rel}`] = new Uint8Array(await file.arrayBuffer());
  }

  // Clips never live in `root` (OPFS) — see the module comment — so they
  // never show up in `picked` above. `scope: 'text'` never wants one, and
  // the caller (export.js) never passes any in that case; every other scope
  // wants every clip it's handed.
  for (const [clipId, blob] of clipBlobs) {
    archive[`${slugName}/${clipId}.mp4`] = new Uint8Array(await blob.arrayBuffer());
  }

  if (!Object.keys(archive).length) throw new Error(`Nothing to bundle for scope '${scope}'`);

  const bytes = zipSync(archive, { level: 6 }); // level 6: bundle.py's zipfile.ZipFile(..., compresslevel=6)
  const suffix = scope === 'all' ? '' : `-${scope}`;
  return {
    blob: new Blob([bytes], { type: 'application/zip' }),
    filename: `${slugName}${suffix}.zip`,
  };
}
