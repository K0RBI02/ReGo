/* Service Worker: App-Gerüst offline verfügbar. Daten (/api) laufen immer übers Netz; die App hält ihren letzten Stand selbst. */
const CACHE = 'rego-v26';
const SHELL = ['/', '/index.html', '/manifest.webmanifest', '/js/rlog.js', '/js/dc-lite.js', '/js/rego-live.js', '/js/ticketcode.js', '/js/barcode-read.js', '/js/scan-client.js', '/js/scan-worker.js', '/js/app.js', '/icons/icon.svg', '/icons/icon-192.png', '/icons/badge.png',
  ...['Main', 'Meldungen', 'Detail', 'Ticket', 'Scan', 'Strecken', 'Onboarding1', 'Onboarding2', 'Onboarding3'].map((n) => `/screens/${n}.dc.html`)];

self.addEventListener('install', (e) => { e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener('activate', (e) => { e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', (e) => {
  const r = e.request, u = new URL(r.url);
  if (r.method !== 'GET' || u.origin !== location.origin || u.pathname.startsWith('/api/')) return;
  // Sofort aus dem Zwischenspeicher (App startet ohne Netzwerk-Wartezeit), im Hintergrund frisch nachladen.
  // Die neue Version erscheint beim nächsten Start. Erster Start ohne Zwischenspeicher: normal übers Netz.
  e.respondWith((async () => {
    const c = await caches.open(CACHE);
    const key = r.mode === 'navigate' ? '/index.html' : r;
    const hit = await c.match(key);
    const fresh = fetch(r).then((res) => { if (res.ok) c.put(key, res.clone()); return res; });
    if (hit) { e.waitUntil(fresh.catch(() => {})); return hit; }
    try { return await fresh; } catch (err) { return new Response('Offline', { status: 503 }); }
  })());
});

/* --- Push: der Push selbst ist leer, den Text holen wir vom Backend --- */
async function deviceId() {
  const c = await caches.open('rego-meta'); const r = await c.match('/__device');
  return r ? (await r.text()) : '';
}
self.addEventListener('push', (e) => {
  e.waitUntil((async () => {
    let list = [];
    try {
      const d = await deviceId();
      const res = await fetch('/api/notifications', { headers: { 'x-device': d }, signal: AbortSignal.timeout(8000) });
      list = (await res.json()).notifications || [];
    } catch (err) {}
    if (!list.length) list = [{ title: 'ReGo', body: 'Neue Meldung auf deiner Strecke', url: '/Meldungen' }];
    for (const n of list) await self.registration.showNotification(n.title, { body: n.body, icon: '/icons/icon-192.png', badge: '/icons/badge.png', tag: (n.url || 'rego') + '|' + (n.ts || Date.now()), renotify: true, data: { url: n.url || '/' } });
  })());
});
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || '/';
  e.waitUntil((async () => {
    const all = await clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of all) { if ('focus' in c) { await c.focus(); if ('navigate' in c) await c.navigate(url); return; } }
    await clients.openWindow(url);
  })());
});
