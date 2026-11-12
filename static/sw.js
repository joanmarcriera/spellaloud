/* sw.js - offline shell for the browser-only (local) build (Vikunja #3532).
 * bin/build-local stamps __VERSION__ and __PRECACHE__ below; the source copy is inert (never registered by the family build).
 * Strategy: precache the app shell on install, serve same-origin GETs cache-first, fall back to the network and
 * cache what it returns; navigations fall back to the cached shell. Data lives in IndexedDB, never here.
 * Old caches are dropped on activate, so shipping a new build (new __VERSION__) replaces the shell. */
const VERSION = '__VERSION__';
const BASE = '__BASE__'; // '' at the site root, '/try' for the preloaded build under dist/try
const PRECACHE = __PRECACHE__;
const CACHE = `spellings-shell-${VERSION}`;

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(PRECACHE)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k.startsWith('spellings-shell-') && k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;
  e.respondWith((async () => {
    const hit = await caches.match(req, { ignoreSearch: req.mode === 'navigate' });
    if (hit) return hit;
    try {
      const res = await fetch(req);
      if (res.ok) (await caches.open(CACHE)).put(req, res.clone());
      return res;
    } catch (err) {
      if (req.mode === 'navigate') {
        const shell = await caches.match(url.pathname.startsWith(BASE + '/parent') ? BASE + '/parent/' : BASE + '/', { ignoreSearch: true });
        if (shell) return shell;
      }
      throw err;
    }
  })());
});
