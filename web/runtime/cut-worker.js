/** The cut worker: one cut at a time, replying with the Blob keyed by the
 *  request's id. A throw becomes a `cut-error` message rather than letting
 *  the worker die.
 *
 *  Protocol: `{type:'cut', id, file, startSec, endSec}` in;
 *  `{type:'cut-done', id, blob}` or `{type:'cut-error', id, message}` out.
 *  Also, once — right after this module finishes evaluating —
 *  `{type:'ready'}` out, unprompted, with no `id`.
 *
 *  That `ready` message is belt-and-braces against a bug that shipped once
 *  already: cut.js used to import a wrapper (mp4box-esm.js) that did a
 *  top-level `await import(...)`. That made this whole module's evaluation
 *  asynchronous, so `self.onmessage = ...` below wasn't assigned until after
 *  the await resolved. export.js constructs this worker and posts the first
 *  `{type:'cut'}` immediately, with no delay — that message arrived before
 *  any handler existed and was silently dropped: no error, no queueing,
 *  just export.js awaiting a reply that never came, which is indistinguishable
 *  from a hang. mp4box-esm.js's loader is lazy now (see its own comment), so
 *  this module's graph evaluates synchronously and `self.onmessage` really is
 *  in place before any message can arrive — but `ready` costs one message and
 *  means a future regression of the same kind surfaces immediately as
 *  "export.js never saw ready" instead of silently hanging again.
 */

import { cut } from './cut.js';

let busy = false;

self.onmessage = async (e) => {
  const msg = e.data;
  if (msg.type !== 'cut') return;

  if (busy) {
    self.postMessage({ type: 'cut-error', id: msg.id, message: 'A cut is already in progress.' });
    return;
  }

  busy = true;
  try {
    const blob = await cut(msg.file, msg.startSec, msg.endSec, null, msg.subtitles);
    self.postMessage({ type: 'cut-done', id: msg.id, blob });
  } catch (err) {
    self.postMessage({ type: 'cut-error', id: msg.id, message: (err && err.message) || String(err) });
  } finally {
    busy = false;
  }
};

// Posted synchronously during this module's initial evaluation, after
// self.onmessage is assigned above — see the protocol comment for why this
// exists and what it guards against.
self.postMessage({ type: 'ready' });
