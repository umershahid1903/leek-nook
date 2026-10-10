// Leek Nook service worker: keeps the nook openable offline and shows the
// bell's pushes. Bump VERSION with every release (the app shows it too).
const VERSION = '1.1.0';
const SHELL = `ln-shell-${VERSION}`;
const DIARY = 'ln-diary';
const FILES = [
  './', 'index.html', 'app.css', 'app.js', 'config.js', 'mailbox.js', 'manifest.webmanifest',
  'fonts/source-serif.woff2', 'icons/leek.svg', 'icons/icon-192.png', 'icons/badge-96.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(FILES.map((f) => new Request(f, { cache: 'reload' })))).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k.startsWith('ln-shell-') && k !== SHELL) await caches.delete(k);
    await self.clients.claim();
  })());
});

// Same-origin files: answer from the cache at once, refresh it in the background.
// Market data (other origins) always goes straight to the network.
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  e.respondWith((async () => {
    const cache = await caches.open(SHELL);
    const key = req.mode === 'navigate' ? 'index.html' : req;
    const hit = await cache.match(key, { ignoreSearch: req.mode === 'navigate' });
    const fresh = fetch(req.mode === 'navigate' ? 'index.html' : req, { cache: 'no-cache' })
      .then((res) => { if (res.ok) cache.put(key, res.clone()); return res; });
    if (hit) { e.waitUntil(fresh.catch(() => {})); return hit; }
    return fresh;
  })());
});

async function writeDiary(p) {
  const c = await caches.open(DIARY);
  const old = await c.match('diary.json');
  const d = old ? await old.json() : {};
  d[p.kind] = { kind: p.kind, at: p.at || Date.now(), target: p.target, mc: p.mc };
  await c.put('diary.json', new Response(JSON.stringify(d), { headers: { 'content-type': 'application/json' } }));
}

// The goal is announced once: by a notification when the nook is closed, or on
// the open page itself (bloom + petals) when it's on screen. Chrome only insists
// on a notification for a push when none of the site's windows is visible.
self.addEventListener('push', (e) => {
  let p;
  try { p = e.data.json(); } catch { p = { title: 'Leek Nook', body: e.data ? e.data.text() : '' }; }
  const kind = p.kind || 'note';
  e.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const w of wins) w.postMessage({ type: 'push', payload: p });
    if (kind === 'ring') await writeDiary(p);
    if (wins.some((w) => w.visibilityState === 'visible')) return;
    await self.registration.showNotification(p.title || 'Leek Nook', {
      body: p.body || '',
      tag: kind === 'ring' ? `ring-${p.target}` : kind,
      renotify: kind === 'ring',
      silent: kind !== 'ring',
      icon: 'icons/icon-192.png',
      badge: 'icons/badge-96.png',
      vibrate: kind === 'ring' ? [200, 100, 200, 100, 400] : undefined,
      requireInteraction: kind === 'ring',
      timestamp: p.at || Date.now(),
      data: { kind, shownAt: Date.now() },
    });
  })());
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  e.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const w of wins) if ('focus' in w) return w.focus();
    return self.clients.openWindow('./');
  })());
});
