// GF PBP Video Highlights — input, processing and review, one page.
//
// Three states, one at a time: the inputs, the run in progress, and the review
// desk. The desk is the point of the tool; the other two get you there.
//
// There is no server: every run's transcript and output live in OPFS
// (fsroot.js's getRoot() — no folder, no permission prompt), an optional
// real folder can be attached to additionally mirror an export, the
// recording is a plain <input type="file"> held only in memory for the
// session, and the pipeline itself runs in a Worker (run-worker.js), driven
// through api.js. api.js is still the only thing in this file that reaches
// any of that — nothing here calls fsroot, store or the worker directly.

import { api } from './api.js';
import {
  bytes, captionHtml, clock, el, esc, length, markdownHtml, speakerPalette, when,
} from './format.js';
import {
  getApiKey, getSettings, setSettings, getTranscriptionKey,
} from './runtime/store.js';
import { slug } from './runtime/slug.js';
import { toSeconds, formatWindowTime } from './runtime/transcript.js';
import { TRANSCRIPT_OFFSET_SEC } from './runtime/config.js';
import { wireSettings, renderSettings, renderMirrorMeta } from './settings.js';

const $ = (id) => document.getElementById(id);

// Mirrors pipeline/jobs.py's STAGES — same keys, in the same order — since
// runner.js emits stage events against these keys. The label shown never
// changes once seeded (only `detail`/`count` update per event), exactly as it
// worked against server.py.
const STAGES = [
  { key: 'transcript', label: 'Read transcript', note: 'Parse the timestamped cues' },
  { key: 'one-pager', label: 'Write one-pager', note: "Summary for people who won't watch" },
  { key: 'select', label: 'Select clips', note: 'Highlights and per-panelist moments, in one pass' },
  { key: 'clips', label: 'Write captions', note: 'A caption and time window per clip' },
  { key: 'targeted', label: 'Re-angle summaries', note: 'Researchers, industry, careers' },
];

const state = {
  recordingName: null,   // the webinar name derived from the picked recording file, or null
  mirrorReady: false,    // an optional "also save to a folder" mirror is attached this session
  runs: [],              // webinar folders under output/, for "earlier runs"
  runsExpanded: false,   // "earlier runs" showing the full, searchable history
  runQuery: '',          // that history's search text
  apiKey: '',            // cached Anthropic key, loaded from store or freshly typed
  transcriptionKey: '',  // cached AssemblyAI key — optional, see the source pane
  posterGen: 0,          // bumped on every recording pick, to cancel a stale preview
  defaults: { segments: 4, perPanelist: 3 },
  job: null,
  lastRunOpts: null,     // the exact opts a run started with, for retry
  stages: [],
  clipTotal: null,
  run: null,             // the manifest of the run being reviewed
  clips: [],             // every clip, flattened, in index order
  palette: new Map(),
  selected: null,        // {kind: 'clip'|'doc', id}
  detailUrls: [],        // object URLs backing the current detail pane
  timer: null,
  masterUrl: null,       // the current run's master recording, loaded once
  player: null,          // the one <video> element, reused across every clip
  playerNote: null,      // "nothing to play" placeholder, shown in its place
  stopAtHandler: null,   // the timeupdate listener that stops at a window's end
};

// ── boot ─────────────────────────────────────────────────────────────────

init();

async function init() {
  wireInput();
  wireKeys();
  wireExport();
  wireSettings({ onChange: onSettingsChange, toast });

  state.defaults = await getSettings();
  $('segments').value = state.defaults.segments;
  $('perpanelist').value = state.defaults.perPanelist;

  // Both keys now live only on the settings page (#/settings) — loaded here
  // into state so the run gate and the run itself can see them, with nothing
  // on this page to mark "saved".
  state.apiKey = (await getApiKey()) || '';
  state.transcriptionKey = (await getTranscriptionKey()) || '';

  // OPFS needs no folder and no permission prompt — ready as soon as this
  // resolves.
  try {
    await api.init();
  } catch (err) {
    toast(err.message || 'This browser could not open its storage.');
  }

  // The optional mirror folder DOES still need a remembered handle: if its
  // permission is still granted, restore it silently so the env chip and
  // the export buttons reflect reality instead of claiming "not attached"
  // when it plainly still is.
  try {
    state.mirrorReady = await api.restoreMirror();
  } catch { /* no remembered mirror, or permission lapsed — the button still works */ }
  renderMirrorMeta(state.mirrorReady);

  renderEnv();
  await refreshRuns();
  validate();
  route();
  addEventListener('hashchange', route);
}

/** The one callback settings.js calls back through after a key is saved or
 *  the mirror is (re)attached — see settings.js's module comment for why it
 *  never reaches into `state` directly. Reloads both keys from store.js
 *  (rather than trusting settings.js to report which one changed) and reads
 *  the mirror's own current truth from api.hasMirror(), then refreshes
 *  everything on this page that depends on them. */
async function onSettingsChange() {
  state.apiKey = (await getApiKey()) || '';
  state.transcriptionKey = (await getTranscriptionKey()) || '';
  state.mirrorReady = api.hasMirror();
  renderEnv();
  validate();
}

function route() {
  const m = location.hash.match(/^#\/run\/([^/]+)$/);
  if (m) return openRun(decodeURIComponent(m[1]));
  if (location.hash === '#/settings') {
    showView('settings');
    renderSettings(state.mirrorReady);
    return;
  }
  if (!state.job || ['done', 'error', 'cancelled'].includes(state.job.status)) {
    showView('input');
  }
}

function showView(name) {
  for (const v of ['input', 'run', 'results', 'settings']) {
    $(`view-${v}`).hidden = v !== name;
  }
  $('crumbs').hidden = name === 'input';
  const backBtn = document.querySelector('[data-go="input"]');
  if (backBtn) backBtn.textContent = name === 'settings' ? 'Back' : 'New run';
  document.title = name === 'results' && state.run
    ? `${state.run.name} · Video Highlights`
    : 'Video Highlights · GF PBP';
}

function renderEnv() {
  // Storage itself isn't a chip any more: OPFS is always ready, with nothing
  // for the reviewer to set up, so there's nothing useful to report on it.
  const chips = [
    ['Anthropic key', !!state.apiKey],
    ['AssemblyAI key', !!state.transcriptionKey],
  ];
  if (state.mirrorReady) chips.push(['mirror folder', true]);
  $('env').innerHTML = chips
    .map(([label, ok]) => `<span class="chip${ok ? '' : ' off'}">${label}${ok ? '' : ' not set'}</span>`)
    .join('');
}

function toast(message) {
  const t = $('toast');
  t.textContent = message;
  t.hidden = false;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => { t.hidden = true; }, 3200);
}

// ── input ────────────────────────────────────────────────────────────────

function wireInput() {
  $('recording').onchange = onRecordingChosen;
  wireDropzone();
  $('segments').onchange = persistSettings;
  $('perpanelist').onchange = persistSettings;
  $('run').onclick = startRun;
  $('clear-recording').onclick = clearRecording;
  $('rec-name').oninput = onRecordingRenamed;

  $('runs-more').onclick = () => {
    state.runsExpanded = !state.runsExpanded;
    if (!state.runsExpanded) { state.runQuery = ''; $('runsearch').value = ''; }
    renderRuns();
    if (state.runsExpanded) $('runsearch').focus();
  };
  $('runsearch').oninput = () => {
    state.runQuery = $('runsearch').value;
    renderRuns();
  };

  for (const b of document.querySelectorAll('[data-go="input"]')) {
    b.onclick = () => {
      state.player?.pause();
      revokeMaster();
      location.hash = ''; showView('input'); refreshRuns();
    };
  }
}

/** The hero slot accepts a drop as a second way onto the very same <input> a
 *  click already opens — not a parallel code path. A dropped file is
 *  assigned onto the real input's FileList, so onRecordingChosen() runs
 *  exactly once regardless of how the file arrived, and the input (reachable
 *  by Tab, openable with Enter or Space via its wrapping <label>) is still
 *  the only thing a keyboard or screen-reader user needs — a drop-only
 *  affordance would leave them with no way in at all. */
function wireDropzone() {
  const slot = $('slot');
  const input = $('recording');

  for (const evt of ['dragenter', 'dragover']) {
    slot.addEventListener(evt, (e) => {
      e.preventDefault();
      slot.classList.add('dragover');
    });
  }
  for (const evt of ['dragleave', 'drop']) {
    slot.addEventListener(evt, () => slot.classList.remove('dragover'));
  }
  slot.addEventListener('drop', (e) => {
    e.preventDefault();
    const file = e.dataTransfer?.files?.[0];
    if (!file) return;
    input.files = e.dataTransfer.files;
    onRecordingChosen();
  });

  // A drop anywhere else on the page shouldn't navigate away to the file.
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => e.preventDefault());
}

/** The recording is a plain file pick, held only in memory for this session
 *  — see fsroot.js's module comment for why it's never copied into OPFS.
 *  Deriving the webinar name from the file happens in api.js
 *  (pickRecording), so this only has to remember that name for validate()
 *  and checkExistingRun() — plus render a poster frame in the same slot, so
 *  picking a file gives more than just a filename. */
function onRecordingChosen() {
  const file = $('recording').files[0];
  if (!file) {
    state.recordingName = null;
    state.posterGen += 1; // cancel any in-flight preview for the file just cleared
    hidePosterPreview();
    hideRename();
    note(null);
    validate();
    return;
  }
  state.recordingName = api.pickRecording(file);
  $('rec-name').value = state.recordingName;
  $('rename').hidden = false;
  checkExistingRun();
  validate();
  renderPosterPreview(file);
}

/** The name field starts as the file-derived name and every edit rebinds the
 *  session's recording to what's typed (api.renameRecording), so the run, its
 *  output folder and later playback/export all agree on one name. Kept as
 *  typed in state — validate() decides whether it's usable — so a half-typed
 *  name never gets silently rewritten under the reviewer's cursor. */
function onRecordingRenamed() {
  const name = $('rec-name').value.trim();
  state.recordingName = name;
  api.renameRecording(name);
  checkExistingRun();
  validate();
}

function hideRename() {
  $('rename').hidden = true;
  $('rec-name').value = '';
}

function hidePosterPreview() {
  $('slot-empty').hidden = false;
  $('slot-filled').hidden = true;
  $('slot-filled').classList.remove('enter');
  $('slot-meta').hidden = true;
  $('rec-caption').textContent = '';
}

/** Clear the picked recording off the input view — the poster, the caption
 *  and the run gate — without unbinding it in api.js. The File is still the
 *  session's master afterwards, so an earlier run made from it keeps playing
 *  its clips; only picking a different recording replaces it. */
function clearRecording() {
  $('recording').value = '';
  state.recordingName = null;
  state.posterGen += 1; // cancel any preview still being drawn
  hidePosterPreview();
  hideRename();
  note(null);
  validate();
}

/** A poster frame in the slot the empty prompt just occupied, with
 *  `name · duration · resolution · size` as a quiet caption beneath it.
 *  Duration and dimensions come free from the <video> element's own
 *  metadata; no decoding library needed. Seeks a couple of seconds in before
 *  drawing, since frame 0 is often black on these masters (see CLAUDE.md's
 *  WebCodecs findings for the same class of container quirk elsewhere in
 *  this app). The <video> used to read the frame is never attached to the
 *  page — only the one frame drawn to the canvas survives — so its object
 *  URL is revoked the instant that draw is done, in `finally`, rather than
 *  held for the session the way the results view's master URL is (see
 *  revokeMaster). `posterGen` guards against a second, faster pick racing
 *  this one: each call captures its own generation and checks it after every
 *  await, so a stale preview from an already-superseded file can never
 *  clobber what the reviewer picked next. */
async function renderPosterPreview(file) {
  const gen = ++state.posterGen;
  const url = URL.createObjectURL(file);
  const video = document.createElement('video');
  video.muted = true;
  video.preload = 'metadata';
  video.src = url;
  try {
    await new Promise((resolve, reject) => {
      video.onloadedmetadata = resolve;
      video.onerror = () => reject(new Error('Could not read that as a video file.'));
    });
    if (gen !== state.posterGen) return;
    api.noteRecordingDuration(video.duration);

    await new Promise((resolve) => {
      video.onseeked = resolve;
      video.currentTime = Math.min(2, (video.duration || 0) / 2);
    });
    if (gen !== state.posterGen) return;

    const w = video.videoWidth;
    const h = video.videoHeight;
    const canvas = $('rec-poster');
    canvas.width = w || 320;
    canvas.height = h || 180;
    canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);

    $('rec-caption').textContent = [
      file.name,
      clock(video.duration),
      w && h ? `${w}×${h}` : '—',
      bytes(file.size),
    ].join(' · ');
    $('slot-meta').hidden = false;

    $('slot-empty').hidden = true;
    const filled = $('slot-filled');
    filled.hidden = false;
    filled.classList.remove('enter');
    void filled.offsetWidth; // restart the arrival animation on a second drop
    filled.classList.add('enter');
  } catch (err) {
    if (gen === state.posterGen) {
      hidePosterPreview();
      toast(err.message || 'Could not preview that video file.');
    }
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** One line under the recording picker: what to know before running. Pass
 *  null to clear it. */
function note(message) {
  $('fileerror').hidden = !message;
  $('fileerror').textContent = message || '';
}

/** A previous run under this recording's name resumes rather than starts
 *  fresh — finished stages are skipped, not redone (see runner.js). */
function checkExistingRun() {
  const name = state.recordingName;
  if (!name) { note(null); return; }
  const runSlug = slug(name);
  const existing = state.runs.find((run) => run.slug === runSlug);
  note(existing
    ? `”${name}” already has output. Running again resumes it — finished steps are skipped, not redone.`
    : null);
}

async function persistSettings() {
  try {
    await setSettings({
      segments: Number($('segments').value) || state.defaults.segments,
      perPanelist: Number($('perpanelist').value) || state.defaults.perPanelist,
    });
  } catch { /* best-effort */ }
}

/** The run gate: a recording, and an AssemblyAI key saved in settings — that
 *  key is what lets the run worker transcribe the recording itself (see
 *  runner.js's transcript precedence; transcript-fetch.js and a manually
 *  supplied transcript still exist as fallbacks in the runner, just with
 *  nothing on this page to reach them any more). Missing the key is never a
 *  silent disable — the button-adjacent message says so and links to
 *  settings, same treatment as the missing-recording case. */
function validate() {
  const blockers = [];
  const picked = !!$('recording').files[0];
  // The name becomes a path segment (transcripts/<name>.txt) and a folder
  // slug (output/<slug>/), so it can't hold a separator or slug to nothing.
  if (!picked) blockers.push({ text: 'Choose a recording to get started.' });
  else if (!state.recordingName) blockers.push({ text: 'Give the webinar a name.' });
  else if (/[/\\]/.test(state.recordingName)) blockers.push({ text: 'The name can’t contain / or \\.' });
  else if (!slug(state.recordingName)) blockers.push({ text: 'The name needs at least one letter or number.' });
  if (!state.transcriptionKey) {
    blockers.push({
      text: 'Add an AssemblyAI key to transcribe it.',
      link: { href: '#/settings', label: 'Open settings' },
    });
  }

  $('run').disabled = blockers.length > 0;
  renderBlocker(blockers[0]);
}

function renderBlocker(blocker) {
  const el_ = $('launch-block');
  el_.hidden = !blocker;
  if (!blocker) { el_.textContent = ''; return; }
  el_.innerHTML = blocker.link
    ? `${esc(blocker.text)} <a href="${esc(blocker.link.href)}" class="linkish">${esc(blocker.link.label)}</a>`
    : esc(blocker.text);
}

async function startRun() {
  $('run').disabled = true;
  $('launch-block').hidden = true;
  try {
    const name = state.recordingName;
    if (!name) throw new Error('Choose a recording first.');
    // Bind once more at launch, so the File the worker gets is the one named
    // in the field even if an edit and a click raced each other.
    api.renameRecording(name);
    if (!state.transcriptionKey) throw new Error('Add an AssemblyAI key in settings first.');
    const segments = Number($('segments').value) || state.defaults.segments;
    const perPanelist = Number($('perpanelist').value) || state.defaults.perPanelist;
    launchRun({
      name, youtube: '', transcript: null, segments, perPanelist,
      transcriptionKey: state.transcriptionKey,
    });
  } catch (err) {
    renderBlocker({ text: err.message });
    $('run').disabled = false;
  }
}

/** Start (or restart, on retry) a run from a fixed set of options, so a retry
 *  reuses exactly what the first attempt used rather than re-reading form
 *  fields that may have changed since. There is no YouTube link on this page
 *  any more, so a run's `source` is always empty at launch — a webinar's
 *  moment-on-YouTube link is no longer something this tool records. */
function launchRun(opts) {
  const job = {
    slug: slug(opts.name),
    name: opts.name,
    source: { url: null, video_id: null },
    settings: { segments: opts.segments, per_panelist: opts.perPanelist },
    created: Date.now() / 1000,
    stages: STAGES,
  };
  adoptJob(job, opts);
  api.startRun({ ...opts, apiKey: state.apiKey || '' }, onEvent);
}

async function refreshRuns() {
  try {
    state.runs = await api.listRuns();
    renderRuns();
  } catch { /* the list is a convenience; leave the last one up */ }
}

// How many runs "earlier runs" shows before "See all" expands it, in place,
// into the full history with a search box.
const RECENT_RUNS = 5;

function renderRuns() {
  const runs = state.runs || [];
  $('earlier').hidden = runs.length === 0;
  $('earlier-count').textContent = runs.length
    ? `${runs.length} webinar${runs.length === 1 ? '' : 's'} processed`
    : '';

  // Nothing to expand into once the list fits — collapse back on its own,
  // e.g. after deleting down to RECENT_RUNS or fewer.
  if (runs.length <= RECENT_RUNS) state.runsExpanded = false;
  const query = state.runQuery.trim().toLowerCase();
  const shown = !state.runsExpanded
    ? runs.slice(0, RECENT_RUNS)
    : runs.filter((run) => !query
        || run.name.toLowerCase().includes(query)
        || run.slug.toLowerCase().includes(query));

  $('runsearch').hidden = !state.runsExpanded;
  $('runlist-empty').hidden = shown.length > 0 || runs.length === 0;
  $('runs-more').hidden = runs.length <= RECENT_RUNS;
  $('runs-more').textContent = state.runsExpanded ? 'Show fewer' : `See all ${runs.length} runs`;

  $('runlist').innerHTML = shown.map((run) => {
    const createdDate = run.created
      ? new Date(run.created * 1000).toLocaleDateString()
      : (run.modified ? new Date(run.modified).toLocaleDateString() : 'unknown');
    const countsText = `${run.counts.highlights} highlights, ${run.counts.panelist_clips} panelist clips, ${run.counts.cut} cut`;
    return `
      <div class="runrow" data-slug="${esc(run.slug)}">
        <button class="runrow-open">
          <span class="runrow-name">${esc(run.name)}</span>
          <span class="runrow-meta">${esc(createdDate)} · ${esc(countsText)}</span>
        </button>
        <button class="runrow-del" aria-label="Delete ${esc(run.name)}">Delete</button>
      </div>`;
  }).join('');
  for (const row of $('runlist').querySelectorAll('.runrow')) {
    const slugName = row.dataset.slug;
    row.querySelector('.runrow-open').onclick = () => {
      location.hash = `#/run/${encodeURIComponent(slugName)}`;
    };
    wireRunDelete(row.querySelector('.runrow-del'), slugName);
  }
}

/** Two clicks, no browser confirm() (a native dialog would block the page):
 *  the first arms the button, the second deletes. Arming lapses on its own
 *  after a few seconds or when focus leaves, so a stray click never sits
 *  one click away from losing a run. */
function wireRunDelete(btn, slugName) {
  let timer = null;
  const disarm = () => {
    clearTimeout(timer);
    btn.classList.remove('armed');
    btn.textContent = 'Delete';
  };
  btn.onblur = disarm;
  btn.onclick = async () => {
    if (!btn.classList.contains('armed')) {
      btn.classList.add('armed');
      btn.textContent = 'Confirm delete';
      timer = setTimeout(disarm, 4000);
      return;
    }
    clearTimeout(timer);
    btn.disabled = true;
    await deleteRun(slugName);
  };
}

async function deleteRun(slugName) {
  const run = state.runs.find((r) => r.slug === slugName);
  if (state.job?.slug === slugName && !['done', 'error', 'cancelled'].includes(state.job.status)) {
    toast('That run is still processing — stop it first.');
    renderRuns();
    return;
  }
  try {
    await api.deleteRun(slugName);
    if (state.run?.slug === slugName) state.run = null;
    toast(`Deleted “${run?.name || slugName}”.`);
  } catch (err) {
    toast(`Could not delete that run: ${err.message}`);
  }
  await refreshRuns();
  checkExistingRun();
}

// ── processing ───────────────────────────────────────────────────────────

function adoptJob(job, opts) {
  state.job = job;
  state.lastRunOpts = opts;
  state.clipTotal = null;
  state.stages = STAGES.map((s) => ({ ...s, status: 'waiting' }));
  $('run-title').textContent = job.name;
  $('run-sub').textContent = [
    `${job.settings.segments} highlights`,
    `up to ${job.settings.per_panelist} per panelist`,
  ].join(' · ');
  $('ticklog').innerHTML = '';
  $('tick').hidden = true;
  $('failure').hidden = true;
  $('runfoot').hidden = false;
  $('stop').disabled = false;
  $('stop').textContent = 'Stop run';
  $('run-state').classList.remove('bad');
  $('retry').hidden = true;
  $('retry').disabled = false;
  setRunState('Processing', true);
  renderStages();
  showView('run');

  clearInterval(state.timer);
  const began = job.created * 1000;
  state.timer = setInterval(() => {
    $('elapsed').textContent = clock((Date.now() - began) / 1000);
  }, 1000);
  $('elapsed').textContent = clock((Date.now() - began) / 1000);

  $('stop').onclick = () => {
    $('stop').disabled = true;
    $('stop').textContent = 'Stopping…';
    api.cancelRun();
  };
  $('retry').onclick = () => {
    $('retry').disabled = true;
    try {
      launchRun(state.lastRunOpts);
    } catch (err) {
      $('retry').disabled = false;
      toast(err.message);
    }
  };
}

function setRunState(text, live) {
  $('run-state').textContent = text;
  $('run-state').classList.toggle('live', !!live);
}

function renderStages() {
  $('stages').innerHTML = state.stages.map((s) => `
    <li class="stage ${s.status}">
      <span class="stage-mark"></span>
      <span>
        <span class="stage-label">${esc(s.label)}</span>
        <span class="stage-note">${esc(s.detail || s.note)}</span>
      </span>
      <span class="stage-count tnum">${esc(s.count || '')}</span>
    </li>`).join('');
}

// run-worker.js emits the run's own events verbatim (stage/count/clip/note),
// plus api.js's bridge of its done/error messages into the {type:'status'}
// shape below — see api.js's startRun for exactly what that bridge does.
function onEvent(event) {
  const stage = state.stages.find((s) => s.key === event.key);

  if (event.type === 'stage') {
    if (stage) {
      stage.status = event.status;
      if (event.detail) stage.detail = event.detail;
      // Anything above the running stage is finished, even if its event was
      // missed on a reconnect.
      const at = state.stages.indexOf(stage);
      state.stages.slice(0, at).forEach((s) => { if (s.status === 'waiting') s.status = 'done'; });
      renderStages();
    }
  } else if (event.type === 'count' && event.key === 'clips') {
    state.clipTotal = event.total;
    const clips = state.stages.find((s) => s.key === 'clips');
    if (clips) { clips.count = `0 / ${event.total}`; renderStages(); }
  } else if (event.type === 'clip') {
    const clips = state.stages.find((s) => s.key === 'clips');
    if (clips && event.done && state.clipTotal) {
      clips.count = `${event.done} / ${state.clipTotal}`;
      renderStages();
    }
    logClip(event);
  } else if (event.type === 'note' && event.level === 'warn') {
    logLine('', event.message, true);
  } else if (event.type === 'status') {
    onStatus(event);
  }
}

function logClip(event) {
  const window_ = event.start ? `${event.start}` : '';
  if (event.status === 'skipped') {
    logLine(window_, `Skipped ${event.base} — ${event.reason}`, true);
  } else {
    logLine(window_, event.title || event.base, false);
  }
}

function logLine(time, text, warn) {
  $('tick').hidden = false;
  const row = el(`<p class="tickrow${warn ? ' skip' : ''}">
    <time>${esc(time)}</time><span>${esc(text)}</span></p>`);
  $('ticklog').append(row);
  $('ticklog').scrollTop = $('ticklog').scrollHeight;
}

function onStatus(event) {
  if (event.status === 'running') return;
  clearInterval(state.timer);
  state.job.status = event.status;
  $('runfoot').hidden = true;

  if (event.status === 'done') {
    state.stages.forEach((s) => { if (s.status !== 'done') s.status = 'done'; });
    renderStages();
    setRunState('Finished', false);
    refreshRuns();
    location.hash = `#/run/${encodeURIComponent(state.job.slug)}`;
    openRun(state.job.slug);
  } else if (event.status === 'cancelled') {
    setRunState('Stopped', false);
    showFailure({
      title: 'Run stopped',
      message: 'The run was stopped before it finished.',
      hint: 'Whatever was written before it stopped is still in the output folder.',
    });
  } else if (event.error) {
    showFailure(event.error);
  }
}

function showFailure(err) {
  $('failure').hidden = false;
  $('failure-title').textContent = err.title || 'The run stopped';
  $('failure-message').textContent = err.message || 'Something went wrong.';
  $('failure-hint').hidden = !err.hint;
  $('failure-hint').textContent = err.hint || '';
  $('trace').hidden = !err.traceback;
  $('tracebody').textContent = err.traceback || '';
  $('retry').hidden = false;
  $('runfoot').hidden = true;
  const stopped = err.title === 'Run stopped';
  setRunState(stopped ? 'Stopped' : 'Failed', false);
  $('run-state').classList.toggle('bad', !stopped);
  state.stages.forEach((s) => { if (s.status === 'running') s.status = 'failed'; });
  renderStages();
}

// ── results ──────────────────────────────────────────────────────────────

async function openRun(slugName) {
  let run;
  try {
    run = await api.loadRun(slugName);
  } catch (err) {
    toast(`Could not open that run: ${err.message}`);
    showView('input');
    return;
  }
  revokeMaster();
  state.run = run;
  // Loaded once per run: every clip without its own cut file plays by
  // seeking this, so re-windowing is instant and no per-clip file is needed.
  state.masterUrl = await api.masterUrl(run.name);

  const speakers = new Set();
  for (const c of run.highlights) if (c.speaker) speakers.add(c.speaker);
  for (const p of run.panelists) speakers.add(p.name);
  state.palette = speakerPalette([...speakers]);

  state.clips = [
    ...run.highlights.map((c) => ({ ...c, highlight: true, groupLabel: 'Highlights' })),
    ...run.panelists.flatMap((p) => p.clips.map((c) => ({
      ...c, highlight: false, speaker: c.speaker || p.name, groupLabel: p.name,
    }))),
  ];

  renderResultHead();
  renderRibbon();
  renderIndex();

  const first = state.clips[0];
  select(first ? { kind: 'clip', id: first.id }
               : { kind: 'doc', id: run.documents[0]?.key });
  showView('results');
}

function colorFor(clip) {
  return state.palette.get(clip.speaker) || 'var(--teal)';
}

function youtubeAt(seconds) {
  const id = state.run.source?.video_id;
  if (!id || seconds == null) return null;
  return `https://www.youtube.com/watch?v=${id}&t=${Math.max(0, seconds)}s`;
}

function renderResultHead() {
  const run = state.run;
  $('r-title').textContent = run.name;

  const bits = [
    `${run.counts.highlights} highlight${run.counts.highlights === 1 ? '' : 's'}`,
    `${run.counts.panelist_clips} clips across ${run.counts.panelists} panelists`,
    `${run.counts.documents} documents`,
  ];
  if (run.master_video.runtime) bits.push(`${clock(run.master_video.runtime)} source`);
  const link = run.source?.url
    ? ` · <a href="${esc(run.source.url)}" target="_blank" rel="noopener">YouTube source</a>`
    : '';
  $('r-meta').innerHTML = esc(bits.join(' · ')) + link
    + (run.created ? ` · ${esc(when(run.created))}` : '');

  $('export-status').textContent = '';
  setExportBusy(false);
}

// ── export ───────────────────────────────────────────────────────────────
// Cutting only ever happens here, on demand — the run itself is text-only
// (see runner.js). api.exportRun does the work (encode, then optionally
// zip); this just wires the buttons, disables them for the duration, shows
// per-clip progress as it comes in, and triggers the download when a zip
// comes back.

function wireExport() {
  $('results-log').onclick = () => { if (state.run) downloadLog(state.run.slug); };
  $('failure-log').onclick = () => { if (state.job) downloadLog(state.job.slug); };
  const folderBtn = $('export-actions').querySelector('[data-export-folder]');
  folderBtn.onclick = () => runExport({ toFolder: true, subtitles: true });

  const menu = $('download-menu');
  for (const btn of menu.querySelectorAll('[data-export-zip]')) {
    btn.onclick = () => {
      // Close before the export starts, not after: the menu is inside the
      // element setExportBusy makes inert, and an open panel that can't be
      // clicked away reads as a frozen UI.
      menu.open = false;
      runExport({
        scope: btn.dataset.exportZip,
        toFolder: false,
        subtitles: btn.dataset.subtitles === '1',
        srt: btn.dataset.srt === '1',
      });
    };
  }

  // Clicking anywhere else dismisses it, the way every other menu on the
  // web does. <details> has no such behaviour of its own.
  document.addEventListener('click', (e) => {
    if (menu.open && !menu.contains(e.target)) menu.open = false;
  });
}

/** "Cut clips to folder" only means anything with a mirror attached (see
 *  fsroot.js/api.js's pickMirror) — with none, `toFolder: true` would just
 *  encode into memory and discard the result, which is why it is hidden
 *  rather than merely disabled without one. Re-applied after every export
 *  finishes, since setExportBusy(false) would otherwise blindly re-show
 *  every control including that one. */
function setExportBusy(busy) {
  for (const btn of $('export-actions').querySelectorAll('button')) btn.disabled = busy;
  const menu = $('download-menu');
  menu.classList.toggle('is-busy', busy);
  if (busy) menu.open = false;
  if (!busy) renderMirrorMeta(state.mirrorReady);
}

/** One clip-encode/zip event, in the same shape runner.js's own progress
 *  events use ({type:'count'|'stage'|'clip'}, stage key 'export' — see
 *  runtime/export.js). There's no dedicated stage list for this the way the
 *  run view has STAGES; a single status line is enough for something that
 *  finishes in minutes, not the run's several distinct phases. */
function onExportEvent(event) {
  if (event.type === 'clip' && event.total) {
    $('export-status').textContent = event.status === 'skipped'
      ? `Skipped ${event.base} (${event.reason})`
      : `Encoding clip ${event.done} / ${event.total}…`;
  } else if (event.type === 'stage' && event.key === 'export' && event.status === 'done') {
    $('export-status').textContent = event.detail || '';
  }
}

async function runExport(opts) {
  const run = state.run;
  if (!run) return;
  setExportBusy(true);
  $('export-status').textContent = 'Encoding clips…';
  try {
    const blob = await api.exportRun(run.slug, run.name, opts, onExportEvent);
    if (opts.toFolder) {
      toast(`Clips written into the attached folder's ${run.slug}/clips and panelists/.`);
    } else if (blob) {
      // zip.js still scopes archives three ways and that is still how one is
      // built — it just stopped being a choice the reviewer makes, so the
      // only thing left to name a download after is the subtitle flavour.
      const suffix = opts.scope && opts.scope !== 'all' ? `-${opts.scope}`
        : (opts.subtitles ? '-subtitled' : opts.srt ? '-srt' : '');
      downloadBlob(blob, `${run.slug}${suffix}.zip`);
      toast('Zip downloaded.');
    }
  } catch (err) {
    toast(err.message || 'Export failed.');
  } finally {
    setExportBusy(false);
  }
}

/** The run's troubleshooting log (api.logBlob — runlog.js has what's in it),
 *  as a .txt to send to whoever is helping. Read fresh on every click, so it
 *  includes whatever just went wrong. */
async function downloadLog(slugName) {
  try {
    downloadBlob(await api.logBlob(slugName), `${slugName}-log.txt`);
  } catch (err) {
    toast(`Could not build the log: ${err.message}`);
  }
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  // Not a synchronous revoke: Chromium can still be reading the object URL
  // to start a large `all` zip's download well after click() returns, and
  // revoking it immediately is a known-flaky way to truncate that download.
  // A few seconds is long enough for the browser to have opened the stream;
  // the URL only has to outlive that, not the download itself.
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

/** The whole webinar on one axis: highlights above the line, each panelist's
 *  own clips below it. Where the pipeline found nothing is as readable as
 *  where it found something. */
function renderRibbon() {
  const run = state.run;
  const ends = state.clips.map((c) => c.end_sec).filter((n) => n != null);
  const total = run.master_video.runtime || (ends.length ? Math.max(...ends) * 1.03 : 0);
  if (!total) { $('ribbon').innerHTML = ''; return; }

  const pct = (s) => `${(s / total) * 100}%`;
  const step = total > 3600 ? 600 : 300;
  const labelEvery = total > 3600 ? 1800 : 900;

  const ticks = [];
  for (let t = step; t < total; t += step) {
    ticks.push(`<span class="ribbon-tick" style="left:${pct(t)}"></span>`);
    // Labels stay clear of the two fixed ones at either end.
    if (t % labelEvery === 0 && t / total > 0.06 && t / total < 0.9) {
      ticks.push(`<span class="ribbon-time" style="left:${pct(t)}">${clock(t)}</span>`);
    }
  }

  const marks = state.clips
    .filter((c) => c.start_sec != null && c.duration)
    .map((c, i) => `<button class="mark ${c.highlight ? 'up' : 'down'}"
        data-id="${esc(c.id)}"
        style="left:${pct(c.start_sec)};width:${pct(c.duration)};--speaker:${colorFor(c)};animation-delay:${i * 18}ms"
        title="${esc(c.title)} — ${esc(c.speaker || '')} ${esc(c.start || '')}"
        aria-label="${esc(c.title)}"></button>`).join('');

  $('ribbon').innerHTML = `
    <div class="ribbon-track">
      <span class="ribbon-axis"></span>
      ${ticks.join('')}
      ${marks}
      <span class="ribbon-time start" style="left:0">0:00</span>
      <span class="ribbon-time end" style="left:100%">${clock(total)}</span>
    </div>
    <div class="ribbon-legend">
      <span class="legend-hi"><i></i>Highlights</span>
      ${run.panelists.map((p) => `<span style="color:${state.palette.get(p.name)}">
         <i></i>${esc(p.name)}</span>`).join('')}
    </div>`;

  for (const m of $('ribbon').querySelectorAll('.mark')) {
    m.onclick = () => select({ kind: 'clip', id: m.dataset.id });
  }
  $('ribbon').classList.add('enter');
  setTimeout(() => $('ribbon').classList.remove('enter'), 900);
}

function renderIndex() {
  const run = state.run;
  const groups = [];

  if (run.highlights.length) {
    groups.push({ label: 'Highlights', note: 'strongest first', clips: state.clips.filter((c) => c.highlight) });
  }
  for (const p of run.panelists) {
    groups.push({
      label: p.name,
      note: `${p.clips.length} clip${p.clips.length === 1 ? '' : 's'}`,
      clips: state.clips.filter((c) => c.group === `panelist:${p.slug}`),
    });
  }

  const clipHtml = (c) => `
    <button class="item" data-kind="clip" data-id="${esc(c.id)}" style="--speaker:${colorFor(c)}">
      <span class="item-title">${esc(c.title)}</span>
      <span class="item-meta">
        ${c.speaker ? `<span class="who">${esc(c.speaker)}</span>` : ''}
        <span class="tnum">${esc(c.start || '—')}</span>
        <span class="tnum">${esc(length(c.duration))}</span>
      </span>
    </button>`;

  const docHtml = (d) => `
    <button class="item" data-kind="doc" data-id="${esc(d.key)}">
      <span class="item-title">${esc(d.label)}</span>
      <span class="item-meta"><span>${d.words} words</span></span>
    </button>`;

  $('index').innerHTML = groups.map((g) => `
    <div class="group-head">${esc(g.label)}<span>${esc(g.note)}</span></div>
    ${g.clips.map(clipHtml).join('')}`).join('')
    + (run.documents.length ? `
      <div class="group-head">Documents<span>for review</span></div>
      ${run.documents.map(docHtml).join('')}` : '');

  for (const item of $('index').querySelectorAll('.item')) {
    item.onclick = () => select({ kind: item.dataset.kind, id: item.dataset.id });
  }
}

function select(sel) {
  if (!sel || !sel.id) return;
  state.selected = sel;
  highlightSelection();

  if (sel.kind === 'doc') renderDocument(sel.id);
  else renderClip(state.clips.find((c) => c.id === sel.id));
}

/** Mark the current selection in the index and the ribbon without touching
 *  the detail pane — used both by select() and after an in-place window
 *  edit moves a clip's mark on the ribbon. */
function highlightSelection() {
  const sel = state.selected;
  if (!sel) return;
  for (const item of $('index').querySelectorAll('.item')) {
    item.classList.toggle('on', item.dataset.kind === sel.kind && item.dataset.id === sel.id);
  }
  for (const m of $('ribbon').querySelectorAll('.mark')) {
    m.classList.toggle('on', sel.kind === 'clip' && m.dataset.id === sel.id);
  }
  const active = $('index').querySelector('.item.on');
  active?.scrollIntoView({ block: 'nearest' });
}

function warningsHtml() {
  const w = state.run.warnings || [];
  return w.length ? `<div class="notice"><span>${w.map(esc).join(' · ')}</span></div>` : '';
}

/** The detail pane's video/download links are local files, opened through
 *  OPFS and handed back as object URLs (api.fileUrl) — there is no server to
 *  serve them from. Revoked here before the next one is made, since nothing
 *  else will ever free them. */
function revokeDetailUrls() {
  for (const u of state.detailUrls) URL.revokeObjectURL(u);
  state.detailUrls = [];
}

/** The single <video> that plays every clip. Created once and moved into
 *  each fresh detail render rather than recreated, so switching clips that
 *  share the master (the common case now) is a seek, not a reload. */
function getPlayer() {
  if (!state.player) {
    const v = document.createElement('video');
    v.className = 'player';
    v.id = 'player';
    v.controls = true;
    v.preload = 'metadata';
    state.player = v;
  }
  return state.player;
}

/** Shown in the player's place when there is nothing to play — the master
 *  isn't loaded this session, or this caption has no time window yet. Reused
 *  across renders exactly like the player itself, for the same reason. The
 *  hidden file input + button let a reviewer re-pick the recording without
 *  leaving the results view — see wireRepickMaster(). */
function getPlayerNote() {
  if (!state.playerNote) {
    const d = document.createElement('div');
    d.className = 'player-missing';
    d.innerHTML = `<p></p>
      <button type="button" class="ghost" id="repick-master-btn" hidden>Pick the recording again</button>
      <input type="file" id="repick-master" accept="video/mp4,video/*" hidden>`;
    state.playerNote = d;
  }
  return state.playerNote;
}

function setPlayerNote(text) {
  getPlayerNote().querySelector('p').textContent = text;
}

/** Wire the "pick the recording again" control once per note element (it's
 *  reused across renders, so guard against re-wiring). Re-binds the picked
 *  file to *this run's* name (api.attachMasterFor), unlike the input view's
 *  file picker, which derives the name from the file itself — a reviewer
 *  re-attaching a recording here is explicitly vouching that it belongs to
 *  the run they're looking at. */
function wireRepickMaster() {
  const note = getPlayerNote();
  const btn = note.querySelector('#repick-master-btn');
  const input = note.querySelector('#repick-master');
  btn.hidden = false;
  if (btn.dataset.wired) return;
  btn.dataset.wired = '1';
  btn.onclick = () => input.click();
  input.onchange = async () => {
    const file = input.files[0];
    input.value = '';
    if (!file || !state.run) return;
    api.attachMasterFor(state.run.name, file);
    revokeMaster();
    state.masterUrl = api.masterUrl(state.run.name);
    if (state.selected) select(state.selected);
  };
}

/** Point the player at a file, touching `src` only when it actually changes —
 *  re-assigning the same object URL would restart playback from 0. */
function setPlayerSource(url) {
  const player = getPlayer();
  if (player.dataset.srcUrl !== url) {
    player.src = url;
    player.dataset.srcUrl = url;
  }
  return player;
}

/** Play a clip by seeking the master between two transcript-relative
 *  timestamps: jump to `startSec` (offset to the master's own clock) and
 *  stop at `endSec` via `timeupdate`, since a plain <video> has no "play
 *  until" primitive. Re-windowing a clip already playing the master is just
 *  calling this again — no file to wait on, since the master is loaded once
 *  per run and never touched again. */
function playWindow(startSec, endSec) {
  const player = getPlayer();
  if (state.stopAtHandler) player.removeEventListener('timeupdate', state.stopAtHandler);

  const stopAt = endSec + TRANSCRIPT_OFFSET_SEC;
  const handler = () => { if (player.currentTime >= stopAt) player.pause(); };
  state.stopAtHandler = handler;
  player.addEventListener('timeupdate', handler);

  const seekTo = startSec + TRANSCRIPT_OFFSET_SEC;
  const seek = () => { player.currentTime = seekTo; };
  if (player.readyState >= 1) seek();
  else player.addEventListener('loadedmetadata', seek, { once: true });
}

/** Wire the persistent player (and its "nothing to play" note) into a fresh
 *  detail render. `legacyUrl` is a clip's own cut file — some runs still
 *  have one, and those must keep playing from it, not the master. Every
 *  other clip — the normal case now — plays by seeking `state.masterUrl`. */
function mountPlayer(clip, legacyUrl) {
  const wrap = $('player-wrap');
  if (!wrap) return;
  const player = getPlayer();
  const note = getPlayerNote();
  player.pause();
  wrap.append(player, note);

  // Both .player and .player-missing set their own `display`, which beats
  // the UA stylesheet's `[hidden]` rule regardless of specificity — an
  // author stylesheet always wins over the UA one. Toggle the inline style
  // directly instead of the `hidden` property, which would silently no-op.
  const show = (playerVisible) => {
    player.style.display = playerVisible ? '' : 'none';
    note.style.display = playerVisible ? 'none' : '';
  };

  if (legacyUrl) {
    setPlayerSource(legacyUrl);
    show(true);
    note.querySelector('#repick-master-btn').hidden = true;
  } else if (state.masterUrl && clip.start_sec != null && clip.end_sec != null) {
    setPlayerSource(state.masterUrl);
    playWindow(clip.start_sec, clip.end_sec);
    show(true);
    note.querySelector('#repick-master-btn').hidden = true;
  } else if (state.masterUrl) {
    show(false);
    setPlayerNote('This caption has no time window to play yet.');
    note.querySelector('#repick-master-btn').hidden = true;
  } else {
    show(false);
    setPlayerNote("The recording isn't loaded this session — pick it again to play clips.");
    wireRepickMaster();
  }
}

/** The master object URL is loaded once per run (see openRun) and shared by
 *  every clip; revoke it only when leaving that run, never per-clip. */
function revokeMaster() {
  if (state.masterUrl) { URL.revokeObjectURL(state.masterUrl); state.masterUrl = null; }
}

async function renderClip(clip) {
  if (!clip) return;
  const run = state.run;
  const yt = youtubeAt(clip.start_sec);

  const [legacyUrl, captionUrl] = await Promise.all([
    clip.video_file ? api.fileUrl(run.slug, clip.video_file) : Promise.resolve(null),
    api.fileUrl(run.slug, clip.caption_file),
  ]);
  // A newer selection may have already won the race; don't clobber it.
  if (state.selected?.kind !== 'clip' || state.selected.id !== clip.id) return;
  revokeDetailUrls();
  for (const u of [legacyUrl, captionUrl]) if (u) state.detailUrls.push(u);

  const actions = [
    legacyUrl
      ? `<a class="ghost" href="${legacyUrl}" download="${esc(clip.base)}.mp4">Download clip</a>`
      : '',
    captionUrl
      ? `<a class="ghost" href="${captionUrl}" download="${esc(clip.base)}_caption.md">Download caption</a>`
      : '',
    yt ? `<a class="ghost" href="${yt}" target="_blank" rel="noopener">Open on YouTube</a>` : '',
    clip.caption ? '<button class="ghost" id="copycap">Copy caption</button>' : '',
  ].filter(Boolean).join('');

  $('detail').innerHTML = `<div class="detail-inner" style="--speaker:${colorFor(clip)}">
    ${warningsHtml()}
    <div class="clip-head">
      <h3>${esc(clip.title)}</h3>
      <div class="clip-facts">
        ${clip.speaker ? `<span class="who">${esc(clip.speaker)}</span>` : ''}
        <span class="tnum" id="clip-duration-display">${esc(length(clip.duration))}</span>
        ${clip.highlight ? '<span class="flag">Highlight</span>' : ''}
        ${clip.video_bytes ? `<span class="tnum">${bytes(clip.video_bytes)}</span>` : ''}
      </div>
      <div class="window-bar" id="window-edit">
        ${stepperHtml('start', 'Start', clip.start)}
        <span class="win-arrow" aria-hidden="true">→</span>
        ${stepperHtml('end', 'End', clip.end)}
        <span class="win-hint">±0.5s per click</span>
      </div>
    </div>
    <div class="player-wrap" id="player-wrap"></div>
    <div class="clip-actions">${actions}</div>

    ${clip.rationale ? `<div class="block">
      <div class="block-head"><h4>Why it was picked</h4></div>
      <p class="reason">${esc(clip.rationale)}</p>
    </div>` : ''}

    ${clip.caption ? `<div class="block">
      <div class="block-head"><h4>Draft caption</h4>
        <span class="muted">${esc(clip.caption_file)}</span></div>
      <div class="caption-body">${captionHtml(clip.caption)}</div>
    </div>` : ''}
  </div>`;

  mountPlayer(clip, legacyUrl);
  wireWindowInputs(clip);
  revealDetail();
  wireClipDetail(clip);
}

const MINUS_ICON = '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M3.5 8h9" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>';
const PLUS_ICON = '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M3.5 8h9M8 3.5v9" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>';

/** One edge of the clip window: a label over a joined [− time +] box. The
 *  input keeps its `win-<edge>` id, which wireWindowInputs/resetWindowInputs
 *  look it up by. */
function stepperHtml(edge, label, value) {
  const lower = label.toLowerCase();
  // A div, not a <label>: clicking a label's text activates its first
  // control, which here would be the − button.
  return `<div class="stepper" role="group" aria-label="Clip ${lower}">
    <span class="stepper-label" aria-hidden="true">${label}</span>
    <span class="stepper-box">
      <button type="button" class="win-nudge" data-edge="${edge}" data-by="-0.5"
              aria-label="${label} half a second earlier" title="${label} 0.5s earlier">${MINUS_ICON}</button>
      <input type="text" class="win-input" id="win-${edge}" value="${esc(value || '')}"
             inputmode="numeric" autocomplete="off" placeholder="HH:MM:SS" aria-label="Clip ${lower}">
      <button type="button" class="win-nudge" data-edge="${edge}" data-by="0.5"
              aria-label="${label} half a second later" title="${label} 0.5s later">${PLUS_ICON}</button>
    </span>
  </div>`;
}

// A tenth of a second at most — what formatWindowTime() writes back.
const HHMMSS = /^\d{1,2}:\d{2}:\d{2}(?:\.\d)?$/;

function wireWindowInputs(clip) {
  const startEl = $('win-start');
  const endEl = $('win-end');
  if (!startEl || !endEl) return;
  const commit = () => onWindowChange(clip, startEl.value.trim(), endEl.value.trim());
  startEl.onchange = commit;
  endEl.onchange = commit;

  for (const btn of document.querySelectorAll('#window-edit .win-nudge')) {
    btn.onclick = () => nudgeWindow(clip, btn.dataset.edge, Number(btn.dataset.by));
    // A mouse click mustn't leave focus on the button: the next Space, meant
    // to pause the preview, would press it and nudge again. Keyboard focus
    // (Tab) still lands on it normally.
    btn.onmousedown = (e) => e.preventDefault();
  }
}

// How far back from a nudged end the preview starts: long enough to hear
// the sentence land, short enough not to sit through the whole clip again.
const END_PREVIEW_SEC = 3;

/** Move one edge of the window by `by` seconds (±0.5 from the buttons; the
 *  caption header keeps a tenth — see formatWindowTime) through the same
 *  onWindowChange a typed edit uses, so validation and the disk write are
 *  shared. Then preview the edge that moved: from the new start, or from a
 *  few seconds before the new end, so each nudge is heard where it matters. */
function nudgeWindow(clip, edge, by) {
  if (clip.start_sec == null || clip.end_sec == null) return;
  let start = clip.start_sec;
  let end = clip.end_sec;
  if (edge === 'start') start = Math.max(0, start + by);
  else end += by;
  if (!(end > start)) { toast('End must be after start.'); return; }

  onWindowChange(clip, formatWindowTime(start), formatWindowTime(end));

  const player = state.player;
  if (!player || player.style.display === 'none') return;
  const from = edge === 'start' ? start : Math.max(start, end - END_PREVIEW_SEC);
  const go = () => {
    player.currentTime = from + TRANSCRIPT_OFFSET_SEC;
    player.play().catch(() => { /* autoplay refused — the seek still landed */ });
  };
  if (player.readyState >= 1) go();
  else player.addEventListener('loadedmetadata', go, { once: true });
}

function resetWindowInputs(clip) {
  if ($('win-start')) $('win-start').value = clip.start || '';
  if ($('win-end')) $('win-end').value = clip.end || '';
}

/** A window edited here and one edited by hand in a text editor are the same
 *  file: this writes the header captionText() always writes, so whichever
 *  edit happened last is what the next reload (which re-reads the folder)
 *  shows. Moves the player immediately; the disk write happens alongside
 *  that, not instead of it. */
async function onWindowChange(clip, startStr, endStr) {
  if (!HHMMSS.test(startStr) || !HHMMSS.test(endStr)) {
    toast('Enter both times as HH:MM:SS, or HH:MM:SS.5 for a half second.');
    resetWindowInputs(clip);
    return;
  }
  const startSec = toSeconds(startStr);
  const endSec = toSeconds(endStr);
  if (!(endSec > startSec)) {
    toast('End must be after start.');
    resetWindowInputs(clip);
    return;
  }

  clip.start_sec = startSec;
  clip.end_sec = endSec;
  clip.start = formatWindowTime(startSec);
  clip.end = formatWindowTime(endSec);
  clip.duration = endSec - startSec;
  resetWindowInputs(clip);

  const durationEl = $('clip-duration-display');
  if (durationEl) durationEl.textContent = length(clip.duration);

  // A clip with its own cut file switches to previewing the master too: that
  // file no longer matches a window that was just edited.
  mountPlayer(clip, null);

  renderRibbon();
  renderIndex();
  highlightSelection();

  try {
    await api.writeClipWindow(state.run.slug, clip.caption_file, startSec, endSec);
  } catch (err) {
    toast(err.message || 'Could not save that window to disk.');
  }
}

function wireClipDetail(clip) {
  const copy = $('copycap');
  if (!copy) return;
  copy.onclick = async () => {
    try {
      await navigator.clipboard.writeText(clip.caption);
      toast('Caption copied.');
    } catch {
      toast('Could not reach the clipboard — select the text instead.');
    }
  };
}

/** The page is the scroll container now. Bring the workspace back under the
 *  header if the reader has scrolled past it; otherwise leave them where they
 *  are, so picking the next clip doesn't yank the view around. */
function revealDetail() {
  const desk = document.querySelector('.desk');
  if (!desk) return;
  const chrome = document.querySelector('.chrome').offsetHeight;
  const top = desk.getBoundingClientRect().top;
  if (top < chrome) window.scrollBy({ top: top - chrome, behavior: 'auto' });
}

async function renderDocument(key) {
  const doc = state.run.documents.find((d) => d.key === key);
  if (!doc) return;
  state.player?.pause();
  const fileUrl = await api.fileUrl(state.run.slug, doc.file);
  if (state.selected?.kind !== 'doc' || state.selected.id !== key) return;
  revokeDetailUrls();
  if (fileUrl) state.detailUrls.push(fileUrl);

  $('detail').innerHTML = `<div class="detail-inner">
    ${warningsHtml()}
    <article class="doc">
      <h3>${esc(doc.label)}</h3>
      <p class="doc-meta">${doc.words} words ·
        ${fileUrl
          ? `<a href="${fileUrl}" download="${esc(doc.file.split('/').pop())}">${esc(doc.file)}</a>`
          : esc(doc.file)}</p>
      ${markdownHtml(doc.body)}
    </article>
  </div>`;
  revealDetail();
}

// ── keyboard ─────────────────────────────────────────────────────────────

function wireKeys() {
  addEventListener('keydown', (e) => {
    if ($('view-results').hidden) return;
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
    // Space on a focused button presses that button; it mustn't also
    // toggle the player.
    if (e.key === ' ' && e.target.tagName === 'BUTTON') return;

    const items = [...$('index').querySelectorAll('.item')];
    const at = items.findIndex((i) => i.classList.contains('on'));
    let next = null;
    if (e.key === 'j' || e.key === 'ArrowDown') next = items[at + 1];
    else if (e.key === 'k' || e.key === 'ArrowUp') next = items[at - 1];
    else if (e.key === ' ' && $('player') && $('player').style.display !== 'none') {
      e.preventDefault();
      $('player').paused ? $('player').play() : $('player').pause();
      return;
    }
    if (next) {
      e.preventDefault();
      select({ kind: next.dataset.kind, id: next.dataset.id });
    }
  });
}
