/** Read an `output/<slug>/` folder back into the structure a reviewer needs.
 *
 * The folder on disk is the source of truth, not a record written at run time.
 * That matters because hand-editing a caption's time window is the documented
 * way to fix a bad clip — a manifest derived from the files always reflects what
 * a reviewer actually did. It also means runs from earlier versions of the
 * pipeline (`.txt` captions, no `panelists/`) still open.
 *
 * run.json, when present, carries only what the folder cannot know: the YouTube
 * source, the original webinar name, and when the run started.
 *
 * Ported from pipeline/manifest.py — matched field for field, since app.js
 * renders that shape today. Takes `root` as an argument rather than reaching
 * for fsroot.getRoot() itself, so this module doesn't care whether its
 * caller is running on the main thread or inside a worker.
 */

import { readCaption } from './manifest-parse.js';
import {
  listDir, readText, getFile, exists, recordingPath, transcriptPath,
} from './fsroot.js';
import { OUTPUT_DIR, RECORDINGS_DIR, TRANSCRIPTS_DIR } from './config.js';
import { parse as parseTranscript, toSeconds } from './transcript.js';
import { slug } from './slug.js';

export const AUDIENCE_LABELS = {
  researchers: 'Researchers & product developers',
  industry: 'Industry professionals',
  careers: 'Career seekers',
};

const CAPTION_NAME = /^(.*)_caption(\.[^.]+)$/;
const titleCase = (s) => s.replace(/\S+/g, (w) => w[0].toUpperCase() + w.slice(1).toLowerCase());

async function loadMeta(root, base) {
  let raw;
  try {
    raw = await readText(root, `${base}/run.json`);
  } catch {
    return {};
  }
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

/** meta.name if the web app wrote one, else the original casing recovered from
 *  a still-present recording or transcript file, else the slug prettied up. */
async function displayName(root, slugName, meta) {
  if (meta.name) return meta.name;
  for (const [dirPath, ext] of [[RECORDINGS_DIR, '.mp4'], [TRANSCRIPTS_DIR, '.txt']]) {
    for (const entry of await listDir(root, dirPath)) {
      if (entry.kind !== 'file' || !entry.name.endsWith(ext)) continue;
      const stem = entry.name.slice(0, -ext.length);
      if (slug(stem) === slugName) return stem;
    }
  }
  const words = slugName.replace(/-/g, ' ');
  return words ? words[0].toUpperCase() + words.slice(1).toLowerCase() : words;
}

/** `<stem>.md`, falling back to the `.txt` older runs wrote. Returns the path
 *  relative to `base`, or null. */
async function pick(root, base, relStem) {
  for (const ext of ['.md', '.txt']) {
    const rel = `${relStem}${ext}`;
    if (await exists(root, `${base}/${rel}`)) return rel;
  }
  return null;
}

async function readDocument(root, base, relPath, key, label) {
  const text = (await readText(root, `${base}/${relPath}`)) || '';
  const body = text.replace(/^#\s+.*?\n+/, ''); // drop the H1; the UI supplies its own
  const words = body.trim().split(/\s+/).filter(Boolean).length;
  return { key, label, file: relPath, words, body: body.trim() };
}

/** One clip: the parsed caption plus whatever video sits beside it. `capName`
 *  is the caption's filename (with extension); `dir` is its folder relative to
 *  the run's base, e.g. `clips` or `panelists/jane-doe`. */
async function readClip(root, base, dir, capName, group, index) {
  const m = CAPTION_NAME.exec(capName);
  const clipBase = m ? m[1] : capName;
  const captionFile = `${dir}/${capName}`;

  const text = (await readText(root, `${base}/${captionFile}`)) || '';
  const info = readCaption(text);

  let videoFile = null;
  let videoBytes = null;
  for (const ext of ['.mp4', '.mov', '.webm']) {
    const rel = `${dir}/${clipBase}${ext}`;
    const file = await getFile(root, `${base}/${rel}`);
    if (file) {
      videoFile = rel;
      videoBytes = file.size;
      break;
    }
  }

  const startSec = info.start ? toSeconds(info.start) : null;
  const endSec = info.end ? toSeconds(info.end) : null;
  const duration = startSec != null && endSec != null ? endSec - startSec : null;

  return {
    id: `${dir}/${clipBase}`,
    group,
    index,
    base: clipBase,
    title: info.title || clipBase,
    speaker: info.speaker,
    start: info.start,
    end: info.end,
    rationale: info.rationale,
    caption: info.body.trim(),
    start_sec: startSec,
    end_sec: endSec,
    duration,
    caption_file: captionFile,
    // A clip with no file of its own is the normal case, not a degraded one:
    // it plays by seeking the master between start_sec and end_sec (see
    // app.js's playWindow). video_file is set only for a run from before
    // that — one whose window was actually cut to its own .mp4/.mov/.webm —
    // and such a clip keeps playing from that file instead.
    video_file: videoFile,
    video_bytes: videoBytes,
  };
}

/** Every `*_caption.*` file directly inside `<base>/<dir>`, sorted — listDir
 *  already sorts, matching the Python side's `sorted(glob(...))`. */
async function captionEntries(root, base, dir) {
  const entries = await listDir(root, `${base}/${dir}`);
  return entries.filter((e) => e.kind === 'file' && /_caption\.[^./]+$/.test(e.name));
}

export async function readRun(root, slugName) {
  const base = `${OUTPUT_DIR}/${slugName}`;
  // exists() is file-only, so listDir is the only way to test for a folder.
  if ((await listDir(root, base)).length === 0) {
    throw new Error(`No output folder for '${slugName}'`);
  }

  const meta = await loadMeta(root, base);
  const name = await displayName(root, slugName, meta);

  const transcriptText = await readText(root, transcriptPath(name));
  const cues = transcriptText ? parseTranscript(transcriptText) : [];
  const runtime = cues.length ? cues[cues.length - 1].seconds : null;

  const videoFile = await getFile(root, recordingPath(name));

  const warnings = [];

  const highlightEntries = await captionEntries(root, base, 'clips');
  const highlights = [];
  for (let i = 0; i < highlightEntries.length; i++) {
    const clip = await readClip(root, base, 'clips', highlightEntries[i].name, 'highlights', i);
    if (clip.start === null) warnings.push(`${clip.caption_file}: no readable time window`);
    highlights.push(clip);
  }

  const panelists = [];
  const personEntries = (await listDir(root, `${base}/panelists`)).filter((e) => e.kind === 'directory');
  for (const person of personEntries) {
    const dir = `panelists/${person.name}`;
    const capEntries = await captionEntries(root, base, dir);
    const clips = [];
    for (let i = 0; i < capEntries.length; i++) {
      clips.push(await readClip(root, base, dir, capEntries[i].name, `panelist:${person.name}`, i));
    }
    if (!clips.length) continue;
    const named = clips.find((c) => c.speaker)?.speaker;
    panelists.push({
      slug: person.name,
      name: named || titleCase(person.name.replace(/-/g, ' ')),
      clips,
    });
  }

  const documents = [];
  const onePager = await pick(root, base, 'one-pager');
  if (onePager) documents.push(await readDocument(root, base, onePager, 'one-pager', 'One-pager'));
  for (const [key, label] of Object.entries(AUDIENCE_LABELS)) {
    const found = await pick(root, base, `targeted/${key}`);
    if (found) {
      documents.push(await readDocument(root, base, found, `targeted/${key}`, `For ${label.toLowerCase()}`));
    }
  }

  return {
    slug: slugName,
    name,
    created: meta.created ?? null,
    finished: meta.finished ?? null,
    source: meta.source ?? null, // {url, video_id}
    settings: meta.settings ?? null, // {segments, ...}
    master_video: {
      present: !!videoFile,
      bytes: videoFile ? videoFile.size : null,
      runtime,
    },
    transcript: { present: cues.length > 0, cues: cues.length },
    highlights,
    panelists,
    documents,
    counts: {
      highlights: highlights.length,
      panelist_clips: panelists.reduce((n, p) => n + p.clips.length, 0),
      panelists: panelists.length,
      documents: documents.length,
    },
    warnings,
  };
}

/** Recursively walk all files in a directory and return the maximum lastModified
 *  timestamp. Returns null if no files are found. */
async function findMaxModified(root, base) {
  let maxTime = null;

  async function walk(dirPath) {
    const entries = await listDir(root, dirPath);
    for (const entry of entries) {
      if (entry.kind === 'file') {
        const file = await getFile(root, `${dirPath}/${entry.name}`);
        if (file && file.lastModified) {
          if (maxTime === null || file.lastModified > maxTime) {
            maxTime = file.lastModified;
          }
        }
      } else if (entry.kind === 'directory') {
        await walk(`${dirPath}/${entry.name}`);
      }
    }
  }

  await walk(base);
  return maxTime;
}

/** A cheap row for the run list: no captions, no transcript slices. Returns the
 *  same shape as Python's summary() — name, created, modified, source, counts
 *  (highlights, panelist_clips, cut), and bytes. The `modified` field is derived
 *  from the newest file in the run folder, since File System Access API exposes
 *  lastModified only on files, not directory handles. */
async function summary(root, slugName) {
  const base = `${OUTPUT_DIR}/${slugName}`;
  const meta = await loadMeta(root, base);
  const name = await displayName(root, slugName, meta);

  const clipsDir = `${base}/clips`;
  const clipEntries = await captionEntries(root, base, 'clips');
  const panelDir = `${base}/panelists`;
  const panelEntries = (await listDir(root, panelDir)).filter((e) => e.kind === 'directory');

  let panelClipCount = 0;
  for (const person of panelEntries) {
    const capsInPerson = await captionEntries(root, base, `panelists/${person.name}`);
    panelClipCount += capsInPerson.length;
  }

  // Count the actual video files (mp4, mov, webm) in clips/ and panelists/*/
  let cutCount = 0;
  const videoExts = ['.mp4', '.mov', '.webm'];
  for (const entry of clipEntries) {
    const m = CAPTION_NAME.exec(entry.name);
    if (!m) continue;
    const clipBase = m[1];
    for (const ext of videoExts) {
      if (await exists(root, `${clipsDir}/${clipBase}${ext}`)) {
        cutCount++;
        break;
      }
    }
  }
  for (const person of panelEntries) {
    const capsInPerson = await captionEntries(root, base, `panelists/${person.name}`);
    for (const entry of capsInPerson) {
      const m = CAPTION_NAME.exec(entry.name);
      if (!m) continue;
      const clipBase = m[1];
      for (const ext of videoExts) {
        if (await exists(root, `${base}/panelists/${person.name}/${clipBase}${ext}`)) {
          cutCount++;
          break;
        }
      }
    }
  }

  // Calculate total bytes in the run folder
  let totalBytes = 0;
  async function sumBytes(dirPath) {
    const entries = await listDir(root, dirPath);
    for (const entry of entries) {
      if (entry.kind === 'file') {
        const file = await getFile(root, `${dirPath}/${entry.name}`);
        if (file) totalBytes += file.size;
      } else if (entry.kind === 'directory') {
        await sumBytes(`${dirPath}/${entry.name}`);
      }
    }
  }
  await sumBytes(base);

  // Derive modified from the newest file in the folder
  const modified = await findMaxModified(root, base);

  return {
    slug: slugName,
    name,
    created: meta.created ?? null,
    modified,
    source: meta.source ?? null,
    counts: {
      highlights: clipEntries.length,
      panelist_clips: panelClipCount,
      cut: cutCount,
    },
    bytes: totalBytes,
  };
}

/** Every run in output/, newest first, with summary data for each. Returns an
 *  empty array if output/ doesn't exist. */
export async function listRuns(root) {
  const entries = await listDir(root, OUTPUT_DIR);
  const dirEntries = entries.filter((e) => e.kind === 'directory');
  const runs = [];
  for (const dirEntry of dirEntries) {
    try {
      runs.push(await summary(root, dirEntry.name));
    } catch {
      // Skip folders that can't be read (e.g., permission denied)
    }
  }
  // Sort by created (or modified if created is null), newest first. `created`
  // is epoch *seconds* (run.json's own unit — see runner.js); `modified` is
  // `File.lastModified`, *milliseconds* (findMaxModified above). Comparing
  // them directly as if they shared a unit put every folder without a
  // run.json above every folder with one, seconds being three orders of
  // magnitude smaller. Scale `created` to milliseconds here, at the
  // comparison, rather than at the field itself — `created`'s own unit is
  // part of run.json's on-disk shape (`manifest.js`'s and `runner.js`'s
  // header comments both document it as seconds) and app.js already scales
  // each field independently for display, so nothing else needs to change.
  return runs.sort((a, b) => {
    const aTime = a.created !== null ? a.created * 1000 : a.modified;
    const bTime = b.created !== null ? b.created * 1000 : b.modified;
    // Handle null values (no created, no modified) - put them at the end
    if (aTime === null && bTime === null) return 0;
    if (aTime === null) return 1;
    if (bTime === null) return -1;
    return bTime - aTime; // Reverse sort (newest first)
  });
}
