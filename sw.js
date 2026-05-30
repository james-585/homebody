// HomeBody Service Worker v7 - forces cache refresh
const CACHE = 'homebody-v8';
const ASSETS = ['manifest.json'];

self.addEventListener('install', event => {
  self.skipWaiting(); // v7 installs immediately
  event.waitUntil(
    caches.open(CACHE).then(cache => cache.addAll(ASSETS).catch(() => {}))
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  const isHTML = url.pathname.endsWith('.html') || url.pathname === '/' || url.pathname.endsWith('/');
  const isLocal = url.origin === self.location.origin;

  if (isHTML && isLocal) {
    // Always fetch fresh HTML, never serve from cache
    event.respondWith(
      fetch(event.request, { cache: 'no-store' })
        .catch(() => caches.match(event.request))
    );
  } else {
    event.respondWith(
      caches.match(event.request).then(cached => cached || fetch(event.request))
    );
  }
});

self.addEventListener('message', event => {
  if (event.data === 'skipWaiting') self.skipWaiting();
});
