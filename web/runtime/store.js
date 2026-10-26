/** What the browser remembers between sessions: the user's two API keys
 *  (Anthropic, and the optional AssemblyAI one), the handle to their optional
 *  mirror folder, and the two run knobs. Nothing else — the actual run output
 *  lives in OPFS (see fsroot.js's getRoot()), which is the source of truth
 *  and needs nothing remembered here to reach it.
 *
 *  Neither key is ever logged or written anywhere but this IndexedDB store —
 *  in particular, never into OPFS, which is the folder a reviewer opens and
 *  exports; a key has no business ending up in a zip.
 *
 *  Directory handles are structured-cloneable, so IndexedDB can hold one across
 *  reloads; the permission it carries still has to be re-granted (see fsroot.js).
 */

import { NUM_SEGMENTS, CLIPS_PER_PANELIST } from './config.js';

const DB = 'pipeline-one';
const STORE = 'kv';

function open() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function get(key) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const req = db.transaction(STORE, 'readonly').objectStore(STORE).get(key);
    req.onsuccess = () => resolve(req.result ?? null);
    req.onerror = () => reject(req.error);
  });
}

async function put(key, value) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export const getApiKey = () => get('apiKey');
export const setApiKey = (key) => put('apiKey', key);

// The AssemblyAI key, same pattern as the Anthropic one above and stored
// under its own key so neither can clobber the other. Optional: with none
// set, the transcript stage falls back to the YouTube link (see runner.js).
export const getTranscriptionKey = () => get('transcriptionKey');
export const setTranscriptionKey = (key) => put('transcriptionKey', key);

// Named for what it now is — the optional "also save to a folder" mirror,
// not the primary root (OPFS no longer needs a remembered handle at all).
export const getMirrorHandle = () => get('mirrorHandle');
export const setMirrorHandle = (handle) => put('mirrorHandle', handle);

export async function getSettings() {
  const s = await get('settings');
  return {
    segments: s?.segments ?? NUM_SEGMENTS,
    perPanelist: s?.perPanelist ?? CLIPS_PER_PANELIST,
  };
}
export const setSettings = (s) => put('settings', s);

// Prompt edits from the settings page: only the prompts that differ from the
// built-in defaults, as `{ key: text }` (prompts.js's DEFAULT_PROMPTS keys).
// Storing only edits, not a full copy, means an improved default in a later
// release still reaches every prompt a reviewer never touched. Per browser:
// each person's edits stay in their own browser.
export const getPrompts = async () => (await get('prompts')) || {};
export const setPrompts = (edits) => put('prompts', edits);
