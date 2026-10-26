/** Service worker: makes the tool installable and usable offline.
 *
 * Cache-first for everything this app ships. The only network dependency the
 * design accepts is the Anthropic call itself (see CLAUDE.md) — a run will
 * fail at the first API call when offline, which is correct; nothing else
 * here should need the network once installed.
 *
 * The precache list is enumerated by hand (no build step, no bundler
 * manifest to read it from). It must stay in sync with what ships in web/.
 *
 * Critical entry: './vendor/mp4box.js'. mp4box-esm.js always fetches this
 * file at runtime — not as a rare fallback, but because an ES module's
 * top-level `var`s never land on `self`, so `self.MP4Box` is undefined on
 * every load and the fetch-and-`new Function` path always runs (see the
 * comment at the top of vendor/mp4box-esm.js). Miss this one file in the
 * cache and clip cutting breaks the moment the app goes offline, even though
 * every other asset loaded fine.
 *
 * UPDATES — read this before shipping any change under web/:
 * The browser only re-fetches ASSETS in `install` below, and it only ever
 * runs `install` when THIS FILE'S BYTES differ from what an installed
 * client already has. `fetch` below is cache-first with no revalidation, so
 * a push that changes app.js, runner.js, prompts.js — anything — but leaves
 * this file byte-identical is invisible to every installed client, forever.
 * SW_VERSION exists solely to give this file a one-line, unmissable place to
 * change on every release, which is what actually triggers the browser's
 * update check. See CLAUDE.md's "Releasing an update" section — bumping it
 * is not optional, and nothing else automates it (no build step here).
 */

const SW_VERSION = 'v37'; // bump on every release that touches anything under web/
const CACHE_NAME = `video-highlights-${SW_VERSION}`;

const ASSETS = [
  './',
  './index.html',
  './manifest.webmanifest',
  './icon.svg',
  './styles.css',
  './app.js',
  './api.js',
  './format.js',
  './settings.js',

  // web/runtime/* — the ported pipeline, run inside the run worker and cut worker.
  './runtime/audio.js',
  './runtime/captions.js',
  './runtime/config.js',
  './runtime/cut-worker.js',
  './runtime/cut.js',
  './runtime/export.js',
  './runtime/fsroot.js',
  './runtime/llm.js',
  './runtime/manifest-parse.js',
  './runtime/manifest.js',
  './runtime/prompts.js',
  './runtime/run-worker.js',
  './runtime/runlog.js',
  './runtime/runner.js',
  './runtime/slug.js',
  './runtime/snap.js',
  './runtime/steps.js',
  './runtime/subtitles.js',
  './runtime/store.js',
  './runtime/transcribe.js',
  './runtime/transcript.js',
  './runtime/transcript-fetch.js',
  './runtime/zip.js',

  // web/vendor/* — vendored, not CDN, precisely so the PWA works offline.
  // All five files, including mp4box.js — see the module comment above.
  './vendor/anthropic.js',
  './vendor/fflate.js',
  './vendor/mp4-muxer.js',
  './vendor/mp4box-esm.js',
  './vendor/mp4box.js',

  // web/vendor/fonts/* — Archivo and Newsreader, vendored for the same
  // reason: the page used to pull these from Google Fonts, a cross-origin
  // request the offline promise couldn't actually keep.
  './vendor/fonts/archivo-variable.woff2',
  './vendor/fonts/newsreader-variable.woff2',

  // The PurpleDNA badge in the header. Small, but a missing image is a
  // visibly broken header offline, which is worse than it sounds for a tool
  // whose whole promise is that it keeps working without a network.
  './purple-dna.jpg',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      // `{cache: 'reload'}` bypasses the browser's ordinary HTTP cache for
      // this fetch — without it, a version bump can still precache stale
      // bytes: measured directly (see fix-wave-b-report.md) — a plain
      // `cache.addAll(ASSETS)` served an already-HTTP-cached copy of app.js
      // into a *new* CACHE_NAME even though sw.js's own byte change had
      // correctly triggered install. Bumping SW_VERSION is necessary but not
      // sufficient without this.
      .then((cache) => cache.addAll(ASSETS.map((url) => new Request(url, { cache: 'reload' }))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((names) => Promise.all(
        names.filter((name) => name !== CACHE_NAME).map((name) => caches.delete(name))
      ))
      .then(() => self.clients.claim())
  );
});

// Cache-first: serve the precached copy instantly and never touch the
// network for anything this app shipped. A same-origin request that misses
// the cache (a new asset added since install) falls back to the network and
// is cached for next time. Cross-origin requests (Anthropic's API, Google
// Fonts) are never intercepted by this handler's caching logic — they are
// still fetched, just not stored, so a run's only network dependency stays
// exactly the one the design calls out.
self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;

  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;

      return fetch(event.request).then((response) => {
        const url = new URL(event.request.url);
        if (response.ok && url.origin === self.location.origin) {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
        }
        return response;
      });
    })
  );
});
