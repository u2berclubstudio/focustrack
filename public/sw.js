/* FocusTrack service worker.
 *
 * Rules, in order of importance:
 *   1. Never cache /api/ — it's per-user, authenticated, and changes constantly.
 *   2. Pages are network-first, so a deploy is picked up on the next load.
 *   3. Static assets are stale-while-revalidate: instant from cache, refreshed
 *      in the background, so a CSS change lands on the load after next without
 *      anyone having to bump a version number.
 */

const CACHE = 'focustrack-v1';

const PRECACHE = [
  '/style.css',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/maskable-512.png',
  '/icons/apple-touch-icon.png',
  '/icons/favicon-64.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE)
      .then((c) => c.addAll(PRECACHE))
      .catch(() => {})       // a missing asset must not block installation
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

const isStatic = (url) =>
  url.pathname === '/style.css' ||
  url.pathname.startsWith('/icons/') ||
  url.pathname.endsWith('.png') ||
  url.pathname.endsWith('.css');

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/')) return;          // always straight to network
  if (url.pathname.endsWith('manifest.webmanifest')) return;

  // Pages: network first, fall back to the last copy we saw.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(request, copy)).catch(() => {});
          return res;
        })
        .catch(() => caches.match(request).then((hit) => hit || caches.match('/style.css')))
    );
    return;
  }

  // Static: serve immediately, refresh behind the scenes.
  if (isStatic(url)) {
    event.respondWith(
      caches.match(request).then((hit) => {
        const network = fetch(request)
          .then((res) => {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(request, copy)).catch(() => {});
            return res;
          })
          .catch(() => hit);
        return hit || network;
      })
    );
  }
});
