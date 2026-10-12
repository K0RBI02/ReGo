/* Service Worker: App-Gerüst offline verfügbar. Daten (/api) laufen immer übers Netz; die App hält ihren letzten Stand selbst. */
const CACHE = 'rego-v37';
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
    let list = [], fetched = false;
    try {
      const d = await deviceId();
      const res = await fetch('/api/notifications', { headers: { 'x-device': d }, signal: AbortSignal.timeout(8000) });
      list = (await res.json()).notifications || []; fetched = true;
    } catch (err) {}
    if (!list.length && !fetched) list = [{ title: 'ReGo', body: 'Neue Meldung auf deiner Strecke', url: '/Meldungen' }];
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const base = { icon: '/icons/icon-192.png', badge: '/icons/badge.png' };
    let shown = 0; const closing = [];
    for (const n of list) {
      if (n.clear) {
        // Vorfall vorbei: die vorhandene Meldung kurz zu "behoben" umschreiben (stumm) und dann schließen
        for (const x of await self.registration.getNotifications({ tag: n.tag })) {
          await self.registration.showNotification(String(x.title).split(' ')[0] + ' · behoben', { ...base, body: x.body, tag: n.tag, silent: true, data: x.data });
          closing.push(n.tag); shown++;
        }
        continue;
      }
      // Gleicher Vorfall = gleiche Kennung: Update ersetzt die Meldung leise, Neues meldet sich mit Ton
      await self.registration.showNotification(n.title, { ...base, body: n.body, tag: n.tag || ((n.url || 'rego') + '|' + (n.ts || Date.now())), renotify: !n.update, silent: !!n.update, data: { url: n.url || '/' } });
      shown++;
    }
    // Chrome verlangt zu jedem Push eine sichtbare Meldung: gab es nichts anzuzeigen, kurz eine stumme zeigen und wieder schließen
    if (!shown) { await self.registration.showNotification('ReGo', { ...base, tag: 'rego-cleanup', silent: true, body: 'Aktualisiert' }); closing.push('rego-cleanup'); }
    if (closing.length) {
      await sleep(closing.includes('rego-cleanup') ? 2500 : 6000);
      for (const tag of closing) for (const x of await self.registration.getNotifications({ tag })) x.close();
    }
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
