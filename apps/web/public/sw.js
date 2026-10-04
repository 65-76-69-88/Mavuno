/* The build replaces this array with every executable shell chunk, including the model worker. */
const SHELL_ASSETS = __SHELL_ASSETS__;
const SHELL_CACHE = 'coffee-shell-v2-__BUILD_ID__';
const MODEL_CACHE = 'coffee-model-v2';
self.addEventListener('install', event => { event.waitUntil(caches.open(SHELL_CACHE).then(cache => cache.addAll(SHELL_ASSETS)).then(() => self.skipWaiting())); });
self.addEventListener('activate', event => { event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key.startsWith('coffee-shell-') && key !== SHELL_CACHE).map(key => caches.delete(key)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/') || url.pathname === '/health' || url.pathname.startsWith('/packs/')) return;
  if (url.pathname.startsWith('/models/') || url.pathname.startsWith('/runtime/') || url.pathname === '/asset-registry.json') {
    // Installation explicitly requests fresh bytes after a failed hash check.
    // Normal inference stays cache-first, including after an offline reload.
    if (event.request.cache === 'no-store') { event.respondWith(fetch(event.request)); return; }
    event.respondWith(caches.open(MODEL_CACHE).then(async cache => (await cache.match(event.request)) || fetch(event.request))); return;
  }
  event.respondWith(caches.open(SHELL_CACHE).then(async cache => (await cache.match(event.request)) || fetch(event.request).catch(() => event.request.mode === 'navigate' ? cache.match('/') : Response.error())));
});
