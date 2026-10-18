/*! coi-serviceworker — ROLLED BACK.
 * Cross-origin isolation did make SharedArrayBuffer available, but duckdb-wasm's
 * threaded (COI) bundle then failed to link the parquet extension
 * (LinkError: mismatch in shared state of memory) — the autoloaded wasm_threads
 * extension build is incompatible with the threaded engine in this duckdb-wasm
 * version. So isolation is abandoned; the single-threaded `eh` bundle (which
 * bundles parquet statically) is used again.
 *
 * This file is now a SELF-UNREGISTERING service worker: any browser that cached the
 * isolation-injecting version will, on its next update check, fetch this, unregister,
 * and reload into a non-isolated (working) state. It injects no headers.
 */
/* eslint-disable */
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => {
  event.waitUntil(
    self.registration
      .unregister()
      .then(() => self.clients.matchAll())
      .then((clients) => clients.forEach((client) => client.navigate(client.url)))
      .catch(() => {}),
  );
});
// No fetch handler → no COOP/COEP injection.
