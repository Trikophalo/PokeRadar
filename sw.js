/**
 * Service worker — app shell caching only.
 *
 * Deliberately conservative: the shell is cached so the app opens offline, but
 * map tiles are never cached (they are third-party, large, and go stale), and
 * navigation always tries the network first so a deploy is picked up on the
 * next load rather than after a hard refresh.
 */

const VERSION = 'pokeradar-v2';
const SHELL = [
  './',
  './index.html',
  './css/app.css',
  './manifest.webmanifest',
  './assets/icon.svg',
  './js/app.js',
  './js/config.js',
  './js/util.js',
  './js/db.js',
  './js/imagery.js',
  './js/seed.js',
  './js/map.js',
  './js/sheet.js',
  './js/compose.js',
  './js/ui.js',
  './js/flyers.js',
  './js/flyerview.js',
  './js/flyerart.js',
  './vendor/maplibre/maplibre-gl.js',
  './vendor/maplibre/maplibre-gl.css',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(VERSION)
      .then((cache) => cache.addAll(SHELL))
      .then(() => self.skipWaiting())
      .catch(() => { /* a missing asset must not block activation */ }),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;   // tiles and other hosts pass through

  // The flyer feed is rewritten daily — always try the network first, or the
  // tab would keep serving last week's flyers from the cache.
  if (url.pathname.includes('/data/')) {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response.ok) {
            const copy = response.clone();
            caches.open(VERSION).then((cache) => cache.put(request, copy));
          }
          return response;
        })
        .catch(() => caches.match(request)),
    );
    return;
  }

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone();
          caches.open(VERSION).then((cache) => cache.put('./index.html', copy));
          return response;
        })
        .catch(() => caches.match('./index.html').then((hit) => hit || caches.match('./'))),
    );
    return;
  }

  event.respondWith(
    caches.match(request).then((hit) => hit || fetch(request).then((response) => {
      if (response.ok) {
        const copy = response.clone();
        caches.open(VERSION).then((cache) => cache.put(request, copy));
      }
      return response;
    })),
  );
});
