/*! coi-serviceworker — cross-origin isolation on a static host.
 * GitHub Pages can't send COOP/COEP response headers, which we need for
 * crossOriginIsolated === true → SharedArrayBuffer → duckdb-wasm's threaded COI
 * bundle, which range-reads HTTP Parquet instead of downloading whole files.
 * This SW re-serves every response with those headers injected.
 *
 * COEP is `credentialless` (not require-corp): cross-origin subresources (the R2
 * data host, extensions.duckdb.org) then load without needing a per-resource
 * Cross-Origin-Resource-Policy header — they're fetched without credentials, which
 * is fine for public, unauthenticated assets.
 *
 * Registration is done by an inline script in the app layout (which knows the
 * basePath); this file is the service-worker body only.
 * Adapted from gzuidhof/coi-serviceworker (MIT).
 */
/* eslint-disable */
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('fetch', (event) => {
  const r = event.request;
  // Leave `only-if-cached` cross-origin requests alone — rewrapping would strip the
  // 206/Content-Range that duckdb's range reads depend on.
  if (r.cache === 'only-if-cached' && r.mode !== 'same-origin') return;

  event.respondWith(
    fetch(r)
      .then((response) => {
        if (response.status === 0) return response; // opaque — can't rewrap
        const headers = new Headers(response.headers);
        headers.set('Cross-Origin-Embedder-Policy', 'credentialless');
        headers.set('Cross-Origin-Opener-Policy', 'same-origin');
        return new Response(response.body, {
          status: response.status,
          statusText: response.statusText,
          headers,
        });
      })
      .catch((e) => console.error('coi-sw fetch:', e)),
  );
});
