// The settings page (#/settings): the Anthropic key, the AssemblyAI key, the
// optional "also save to a folder" mirror, and the prompt editor. All three used to sit on the
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
  getApiKey, setApiKey, getTranscriptionKey, setTranscriptionKey, getPrompts, setPrompts,
} from './runtime/store.js';
import { DEFAULT_PROMPTS, PROMPT_FIELDS, validatePrompt } from './runtime/prompts.js';
import { esc } from './format.js';

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
  wirePrompts(toast);
}

/** Refresh the whole view from what's actually stored. Called every time the
 *  #/settings route is entered, so reopening settings never shows a stale
 *  "not attached" after the mirror was attached earlier, or an unsaved
 *  placeholder for a key that's actually already there. */
export async function renderSettings(mirrorReady) {
  markKeySaved(!!(await getApiKey()));
  markTranscriptionKeySaved(!!(await getTranscriptionKey()));
  renderMirrorMeta(mirrorReady);
  await renderPrompts();
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

// ── prompts ─────────────────────────────────────────────────────────────
// One box per editable prompt (prompts.js's PROMPT_FIELDS), saved to
// store.js as edits-only. The locked rules each prompt always carries are
// drawn inside the same frame as its box, so nobody wonders where they went
// or tries to re-add them. An edit is checked as it is typed but saved only
// on leaving the box, and only if it is valid — an invalid one stays visibly
// unsaved rather than ever reaching a run.

async function renderPrompts() {
  const edits = await getPrompts();
  $('prompt-list').innerHTML = PROMPT_FIELDS.map((f) => {
    const slots = f.slots.length
      ? `<p class="prompt-slots">Slots: ${f.slots.map((sl) =>
          `<code>{{${esc(sl.name)}}}</code> ${esc(sl.meaning)}${sl.required ? ' <b>(required)</b>' : ''}`).join(' · ')}</p>`
      : '';
    return `<div class="prompt-field" data-key="${esc(f.key)}">
      <div class="prompt-head">
        <label class="field-label" for="p-${esc(f.key)}">${esc(f.label)}</label>
        <span class="prompt-badge" hidden>Edited</span>
        <button type="button" class="linkish prompt-reset" hidden>Reset to default</button>
      </div>
      <p class="field-help">${esc(f.help)}</p>
      ${slots}
      <div class="prompt-doc">
        ${lockedPart(f.lockedBefore, 'before')}
        <textarea id="p-${esc(f.key)}" rows="${f.rows}" spellcheck="true">${esc(edits[f.key] ?? DEFAULT_PROMPTS[f.key])}</textarea>
        ${lockedPart(f.locked, 'after')}
      </div>
      <p class="field-help bad prompt-error" hidden></p>
    </div>`;
  }).join('');

  for (const row of $('prompt-list').querySelectorAll('.prompt-field')) {
    markEdited(row, row.dataset.key in edits);
  }
}

const LOCK_ICON = '<svg viewBox="0 0 16 16" width="11" height="11" aria-hidden="true"><path fill="currentColor" d="M5 7V5a3 3 0 0 1 6 0v2h.5A1.5 1.5 0 0 1 13 8.5v5a1.5 1.5 0 0 1-1.5 1.5h-7A1.5 1.5 0 0 1 3 13.5v-5A1.5 1.5 0 0 1 4.5 7H5Zm1.5 0h3V5a1.5 1.5 0 0 0-3 0v2Z"/></svg>';

/** A prompt's fixed text, drawn inside the same frame as its box — above it
 *  (`before`) or below it (`after`) — so the editable part and what the app
 *  adds read as one prompt, the way the model receives it. Plain text, not a
 *  control: it can be read and copied, never typed into. */
function lockedPart(text, where) {
  if (!text) return '';
  // One line on purpose: the part is white-space: pre-wrap (the fixed text's
  // own line breaks matter), so any whitespace in this markup would render.
  const title = "Added automatically — the app relies on this, so it can't be edited";
  return `<div class="prompt-locked-part ${where}" title="${title}"><span class="prompt-lock-tag">${LOCK_ICON} fixed</span>${esc(text)}</div>`;
}

function markEdited(row, edited) {
  row.querySelector('.prompt-badge').hidden = !edited;
  row.querySelector('.prompt-reset').hidden = !edited;
}

function showProblems(row, problems, saved) {
  const el = row.querySelector('.prompt-error');
  el.hidden = !problems.length;
  el.textContent = problems.length ? `${saved ? '' : 'Not saved — '}${problems.join(' ')}` : '';
  row.classList.toggle('invalid', problems.length > 0);
}

/** Save one prompt's text: an edit if it differs from the default, nothing
 *  (the default) if it matches. Re-reads the store first, so two boxes saved
 *  in quick succession can't drop each other's edit. */
async function savePrompt(key, text) {
  const edits = await getPrompts();
  if (text === DEFAULT_PROMPTS[key]) delete edits[key];
  else edits[key] = text;
  await setPrompts(edits);
  return key in edits;
}

function wirePrompts(toast) {
  const list = $('prompt-list');

  list.addEventListener('input', (e) => {
    const row = e.target.closest('.prompt-field');
    if (!row || e.target.tagName !== 'TEXTAREA') return;
    showProblems(row, validatePrompt(row.dataset.key, e.target.value), true);
  });

  list.addEventListener('change', async (e) => {
    const row = e.target.closest('.prompt-field');
    if (!row || e.target.tagName !== 'TEXTAREA') return;
    const key = row.dataset.key;
    const problems = validatePrompt(key, e.target.value);
    showProblems(row, problems, false);
    if (problems.length) return;
    try {
      markEdited(row, await savePrompt(key, e.target.value));
      toast('Prompt saved — used from the next run or Regenerate.');
    } catch (err) {
      toast(`Could not save that prompt: ${err.message}`);
    }
  });

  list.addEventListener('click', async (e) => {
    if (!e.target.classList.contains('prompt-reset')) return;
    const row = e.target.closest('.prompt-field');
    const key = row.dataset.key;
    row.querySelector('textarea').value = DEFAULT_PROMPTS[key];
    showProblems(row, [], true);
    markEdited(row, await savePrompt(key, DEFAULT_PROMPTS[key]));
    toast('Back to the default.');
  });

  // Two clicks, like deleting a run: it throws away every edit at once.
  const resetAll = $('prompts-reset-all');
  let armed = null;
  resetAll.onclick = async () => {
    if (!armed) {
      resetAll.textContent = 'Click again to reset every prompt';
      armed = setTimeout(() => { armed = null; resetAll.textContent = 'Reset all to defaults'; }, 4000);
      return;
    }
    clearTimeout(armed);
    armed = null;
    resetAll.textContent = 'Reset all to defaults';
    await setPrompts({});
    await renderPrompts();
    toast('Every prompt is back to its default.');
  };
}
