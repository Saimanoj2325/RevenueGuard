// RevenueGuard offline shell. Pages and static assets are cached; API calls always go to the network
// (money numbers are never served stale from a cache).
const CACHE = 'rg-shell-v2';
const SHELL = ['./', './login/', './approvals/', './collect/', './ask/', './manifest.webmanifest', './icon-192.png'];
self.addEventListener('install', (e) => { e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL).catch(() => {})).then(() => self.skipWaiting())); });
self.addEventListener('activate', (e) => { e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // API / websocket on another origin: never cached
  if (req.mode === 'navigate') {
    e.respondWith(fetch(req).then((r) => { const copy = r.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); return r; }).catch(() => caches.match(req).then((r) => r || caches.match('./'))));
    return;
  }
  if (/\/_next\/static\/|\.(woff2|png|svg|css|js)$/.test(url.pathname)) {
    e.respondWith(caches.match(req).then((hit) => hit || fetch(req).then((r) => { const copy = r.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); return r; })));
  }
});
self.addEventListener('push', (e) => {
  let d = {}; try { d = e.data ? e.data.json() : {}; } catch { d = { title: 'RevenueGuard', body: e.data && e.data.text() }; }
  e.waitUntil(self.registration.showNotification(d.title || 'Approval needed', { body: d.body || 'Open RevenueGuard to review.', icon: 'icon-192.png', data: { url: d.url || './approvals/' } }));
});
self.addEventListener('notificationclick', (e) => { e.notification.close(); e.waitUntil(self.clients.openWindow(e.notification.data && e.notification.data.url || './')); });
