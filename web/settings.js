// The settings page (#/settings): the Anthropic key, the AssemblyAI key, and
// the optional "also save to a folder" mirror. All three used to sit on the
// front page's input console — a once-a-month operator doesn't need to see
// any of that before every run, only the rare time a key is set up or
// rotated. Both keys are stored exactly as before, via store.js; api.js still
// owns the one native folder picker.
//
// app.js owns `state` (state.apiKey, state.transcriptionKey, state.mirrorReady)
// and the run gate and header chips that read it. This module never reaches
// into that state directly — it calls back through `onChange` after a save or
// a folder pick, the same one-way-through-api.js/store.js discipline the rest
// of the page keeps, so app.js stays the one place the run gate's logic lives.

import { api } from './api.js';
import {
  getApiKey, setApiKey, getTranscriptionKey, setTranscriptionKey,
} from './runtime/store.js';

const $ = (id) => document.getElementById(id);

/** Wire the settings view's controls once, at boot. `onChange` runs after any
 *  key is saved or the mirror is (re)attached; `toast` is app.js's own toast,
 *  reused here rather than duplicated for the one error case (the folder
 *  picker dismissed or failing). */
export function wireSettings({ onChange, toast }) {
  $('s-apikey').onchange = async () => {
    const val = $('s-apikey').value.trim();
    if (!val) return;
    await setApiKey(val);
    $('s-apikey').value = '';
    markKeySaved(true);
    onChange();
  };

  $('s-transcriptionkey').onchange = async () => {
    const val = $('s-transcriptionkey').value.trim();
    if (!val) return;
    await setTranscriptionKey(val);
    $('s-transcriptionkey').value = '';
    markTranscriptionKeySaved(true);
    onChange();
  };

  $('pickmirror').onclick = () => pickMirror(onChange, toast);
}

/** Refresh the whole view from what's actually stored. Called every time the
 *  #/settings route is entered, so reopening settings never shows a stale
 *  "not attached" after the mirror was attached earlier, or an unsaved
 *  placeholder for a key that's actually already there. */
export async function renderSettings(mirrorReady) {
  markKeySaved(!!(await getApiKey()));
  markTranscriptionKeySaved(!!(await getTranscriptionKey()));
  renderMirrorMeta(mirrorReady);
}

/** Open the optional mirror folder with the native picker. Exported so
 *  app.js's boot path (restoring an already-granted mirror) and this view's
 *  own button share the one place that calls api.pickMirror(). */
export async function pickMirror(onChange, toast) {
  const btn = $('pickmirror');
  btn.disabled = true;
  try {
    await api.pickMirror();
    renderMirrorMeta(true);
    onChange();
  } catch (err) {
    if (err.name !== 'AbortError') toast(err.message || 'Could not open that folder.');
  } finally {
    btn.disabled = false;
  }
}

/** Also called from app.js after every export finishes: the results view's
 *  "Cut clips to folder" button depends on the same mirrorReady this page
 *  reports, so the one function drives both.
 *
 *  Hidden, not disabled, with no mirror: a greyed-out button implies the
 *  action exists and is momentarily unavailable, when in fact writing to a
 *  folder is not a thing this tool does until you attach one. The reviewer
 *  who never attaches a folder — the ordinary case, since the default
 *  destination is a zip download — should not see it at all. */
export function renderMirrorMeta(ready) {
  $('mirrormeta').textContent = ready
    ? 'Also saving cut clips to this folder.'
    : 'Optional — not attached.';
  const folderBtn = document.querySelector('#export-actions [data-export-folder]');
  if (folderBtn) folderBtn.hidden = !ready;
}

function markKeySaved(saved) {
  $('s-apikey').placeholder = saved
    ? '•••••••••• saved — enter a new key to replace it'
    : 'sk-ant-…';
  $('s-apikey-help').textContent = saved
    ? 'Key saved — about $2–4 a run. Enter a new key to replace it.'
    : 'Writes the one-pager, clip selection and captions. Stored only in this browser. About $2–4 a run.';
}

function markTranscriptionKeySaved(saved) {
  $('s-transcriptionkey').placeholder = saved
    ? '•••••••••• saved — enter a new key to replace it'
    : 'Required to run';
  $('s-transcriptionkey-help').textContent = saved
    ? 'Key saved — speaker labels and ~3s cues, about $0.37 a run. Enter a new key to replace it.'
    : 'Transcribes the recording directly, with speaker labels and ~3s cue timing. Stored only in this browser. About $0.37 a run.';
}
