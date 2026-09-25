/** ESM interop for `mp4box.js` (vendored, unmodified UMD build).
 *
 * mp4box.js is a classic script: `MP4Box`, `DataStream` and friends are
 * top-level `var`s, and the file never assigns them onto `self`/`window`
 * itself — that only happens because a classic `<script>` tag runs its
 * top-level `var`s into the global object. Loading it with a plain ESM
 * `import` parses it as a *module* instead, where top-level `var` stays
 * scoped to that module and never reaches `self`. So the straightforward
 * route below routinely leaves `self.MP4Box` undefined even in a real
 * browser/worker — that's expected, not a failure, and the fallback exists
 * for exactly this case.
 *
 * Fallback: fetch this same vendored file's own source (a local, same-origin
 * asset shipped with the app — not a CDN, not a network call in the "hits
 * the internet" sense) and evaluate it with `new Function`, which gives the
 * script's top-level `var`s a fresh function-scope we can read back out via
 * an explicit `return`. No global pollution, no CDN, works offline.
 *
 * loadMP4Box() below is deliberately an async function called *lazily*, not
 * a top-level `await`. A top-level `await import(...)` here used to make
 * this whole module's evaluation asynchronous — and since cut.js imports
 * this module and cut-worker.js imports cut.js, that asynchrony propagated
 * all the way up through cut-worker.js's module graph, delaying
 * `self.onmessage = ...` until after the awaited import/fetch resolved. A
 * message posted to the worker before that (which is exactly what
 * export.js does — it constructs the worker and posts immediately) arrived
 * with no handler registered yet and was silently dropped: no error, no
 * queueing, just a caller awaiting a reply that never comes. Keeping this
 * loader as a plain function called from inside cut()'s body means
 * cut-worker.js's module graph evaluates synchronously and `self.onmessage`
 * is registered before any message can arrive.
 *
 * The `typeof self !== 'undefined'` guard below is not part of the runtime
 * contract (a browser window and a Worker both always have `self`) — it
 * exists so this module still *imports* cleanly under plain Node (no `self`,
 * no `fetch` for `file:` URLs), which is how the test suite's import/parse
 * check exercises it. cut.js and cut-worker.js only ever call into MP4Box at
 * call time, inside functions Node's import check never invokes.
 */

let cached = null;

/** Async, memoised: the first call does the real work (plain import, then
 *  the fetch + `new Function` fallback); every later call returns the same
 *  resolved `{ MP4Box, DataStream }` immediately. Never called at module
 *  scope — see the comment above for why that matters. */
export function loadMP4Box() {
  if (cached) return cached;

  cached = (async () => {
    if (typeof self === 'undefined') {
      // Plain Node import/parse check (see module comment) — no self, no
      // fetch for file: URLs, and nothing here is ever called from that path.
      return { MP4Box: undefined, DataStream: undefined };
    }

    await import('./mp4box.js');
    let MP4Box = self.MP4Box;
    let DataStream = self.DataStream;

    if (!MP4Box) {
      const url = new URL('./mp4box.js', import.meta.url);
      const source = await (await fetch(url)).text();
      const factory = new Function(
        `${source}\n;return { MP4Box: typeof MP4Box !== 'undefined' ? MP4Box : undefined, ` +
        `DataStream: typeof DataStream !== 'undefined' ? DataStream : undefined };`
      );
      ({ MP4Box, DataStream } = factory());
    }

    if (!MP4Box) throw new Error('mp4box-esm: could not load MP4Box from vendor/mp4box.js');
    if (!DataStream) throw new Error('mp4box-esm: could not load DataStream from vendor/mp4box.js');

    return { MP4Box, DataStream };
  })();

  return cached;
}
