const CACHE = 'gymcoach-her-v5';
const PARENT = new URL('../', self.location);
const HERE = new URL('./', self.location);
const here = p => new URL(p, HERE).href;
const parent = p => new URL(p, PARENT).href;
const ASSETS = [HERE.href, here('index.html'), here('profile.js'), here('manifest.webmanifest'),
  parent('app.js'), parent('exercises.json'),
  parent('icons/icon-192.png'), parent('icons/icon-512.png'),
  parent('icons/icon-192-maskable.png'), parent('icons/icon-512-maskable.png'),
  parent('audio/silence.wav'), ...[420, 500, 700, 880, 1000, 1200, 1320].map(f => parent('audio/beep' + f + '.wav'))];
self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(async c => {
    await c.addAll(ASSETS);
    try {
      const lib = await (await fetch(parent('exercises.json'), { cache: 'no-cache' })).json();
      const imgs = [...new Set(lib.flatMap(x => x.image || []))].filter(p => !String(p).includes('img/ex/')).map(p => parent(p));
      await c.addAll(imgs);
    } catch (err) { /* images still cache at runtime */ }
  }));
  self.skipWaiting();
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k.startsWith('gymcoach-her-') && k !== CACHE).map(k => caches.delete(k)))));
  self.clients.claim();
});
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.includes('/img/')) {
    e.respondWith(caches.match(e.request).then(hit => hit || fetch(e.request).then(r => {
      const copy = r.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); return r;
    })));
    return;
  }
  e.respondWith(fetch(e.request).then(r => {
    const copy = r.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); return r;
  }).catch(() => caches.match(e.request, { ignoreSearch: true })));
});
