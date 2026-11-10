const CACHE = 'gymcoach-v29';
const ASSETS = ['./', './index.html', './app.js', './exercises.json', './manifest.webmanifest',
  './icons/icon-192.png', './icons/icon-512.png', './icons/icon-192-maskable.png', './icons/icon-512-maskable.png',
  './audio/silence.wav', ...[420, 500, 700, 880, 1000, 1200, 1320].map(f => `./audio/beep${f}.wav`)];
// Precache the app shell plus every exercise image listed in exercises.json (~2.7 MB) for offline gym use.
self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(async c => {
    await c.addAll(ASSETS);
    try {
      const lib = await (await fetch('./exercises.json', {cache: 'no-cache'})).json();
      // img/ex/<slug>-start|end.webp is cached on first view, not precached.
      const imgs = [...new Set(lib.flatMap(x => x.image || []))].filter(p => !String(p).includes('img/ex/')).map(p => './' + p);
      await c.addAll(imgs);
    } catch (err) { /* images will still be cached at runtime */ }
  }));
  self.skipWaiting();
});
self.addEventListener('activate', e => {
  // Only this app's caches. gymcoach-her-* belongs to the other home-screen app.
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k.startsWith('gymcoach-v') && k !== CACHE).map(k => caches.delete(k)))));
  self.clients.claim();
});
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);
  // Cross-origin requests (YouTube demo videos etc.) are never cached or intercepted.
  if (url.origin !== self.location.origin) return;
  // Images never change for a given name: cache-first.
  if (url.pathname.includes('/img/')) {
    e.respondWith(caches.match(e.request).then(hit => hit || fetch(e.request).then(r => {
      const copy = r.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); return r;
    })));
    return;
  }
  // Everything else network-first so updates land; cache fallback offline.
  e.respondWith(fetch(e.request).then(r => {
    const copy = r.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); return r;
  }).catch(() => caches.match(e.request, {ignoreSearch: true})));
});
