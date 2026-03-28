'use strict';

const CACHE_NAME = 'dunedin-euchre-v1';

// App shell — static assets that can be served offline
const APP_SHELL = [
  '/css/styles.css',
  '/js/rsvp.js',
  '/js/admin.js',
  '/manifest.json'
];

// ── Install: cache the app shell ──────────────────────────
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(APP_SHELL))
  );
  self.skipWaiting();
});

// ── Activate: remove old caches ───────────────────────────
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))
      )
    )
  );
  self.clients.claim();
});

// ── Fetch: cache-first for app shell, network-first for pages ─
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // Only handle same-origin GET requests
  if (event.request.method !== 'GET' || url.origin !== self.location.origin) return;

  // App shell assets: cache-first
  if (APP_SHELL.includes(url.pathname)) {
    event.respondWith(
      caches.match(event.request).then(cached => cached || fetch(event.request))
    );
    return;
  }

  // HTML pages and API: network-first, no offline fallback (data must be fresh)
  event.respondWith(
    fetch(event.request).catch(() => caches.match(event.request))
  );
});
