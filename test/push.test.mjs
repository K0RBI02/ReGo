import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { relevant, textFor, changeOf, createNotifier } from '../server/notifier.mjs';
import { ProfileStore, addTours } from '../server/store/profile.mjs';
import { createService } from '../server/service.mjs';
import { config } from '../server/config.mjs';

/** Firebase-Ersatz: zählt die Anstöße und liefert das gewünschte Ergebnis ('ok' | 'gone' | 'error'). */
const fcmStub = (result = 'ok') => { const c = { enabled: true, calls: [], result, async send(tok) { c.calls.push(tok); return typeof c.result === 'function' ? c.result() : c.result; } }; return c; };
const NATIVE = { native: true, fcm: 'fcm-token-0123456789abcdef' };

test('Relevanz und Text', () => {
  const d = { kind: 'delay', delayMin: 8, title: 'S1 Freising → München Hbf', summary: 'Gleiswechsel Gl. 2 → Gl. 3', validity: { activeNow: true } };
  assert.ok(relevant(d, 5)); assert.ok(!relevant({ ...d, delayMin: 3 }, 5));
  assert.deepEqual(textFor(d), { title: 'S1 +8 Min.', body: 'Freising → München Hbf · Gleiswechsel Gl. 2 → Gl. 3' });
  assert.ok(relevant({ kind: 'replacement', delayMin: 0, validity: { activeNow: false } }, 5) === false);
  // Ausfall und Gleiswechsel sind immer eine Meldung wert, unabhängig von der Verspätungs-Schwelle
  assert.ok(relevant({ kind: 'cancelled', delayMin: 0, validity: { activeNow: true } }, 10));
  assert.ok(relevant({ kind: 'platform', delayMin: 0, validity: { activeNow: true } }, 10));
  assert.deepEqual(textFor({ kind: 'cancelled', lineName: 'RE 5', title: 'RE 5 München Hbf → Salzburg Hbf', summary: 'Fahrt um 07:20 fällt aus' }), { title: 'Ausfall · RE 5', body: 'München Hbf → Salzburg Hbf · Fahrt um 07:20 fällt aus' });
  assert.equal(textFor({ kind: 'platform', lineName: 'S 1', title: 'S 1 Freising → München Hbf', summary: '07:21 jetzt Gleis 3 statt Gleis 2' }).title, 'Gleiswechsel · S 1');
  // Was sich an einer bekannten Meldung ändern darf, ohne dass sie neu ist
  assert.equal(changeOf({ kind: 'delay', delayMin: 6 }), 6); assert.equal(changeOf({ kind: 'cancelled', count: 2 }), 2);
  assert.equal(changeOf({ kind: 'platform', platform: '3' }), '3'); assert.equal(changeOf({ kind: 'construction' }), undefined);
});

async function setup(name, { push = NATIVE, incidents, fcm = fcmStub(), t = Date.parse('2026-10-10T12:00:00+02:00'), tours } = {}) {
  const dir = await mkdtemp(join(tmpdir(), name));
  const cfg = { ...config, provider: 'mock', dataDir: dir };
  const clock = { t }; const now = () => clock.t;
  const store = new ProfileStore(dir, now);
  const dev = `${name.replace(/[^a-z0-9]/gi, '')}geraet12345678`;
  let tourId;
  await store.update(dev, (p) => { tourId = addTours(p, { from: { id: '8002078', name: 'Freising' }, to: { id: '8000261', name: 'München Hbf' }, ...(tours || {}) })[0].id; p.push = push; });
  const cur = { incidents };
  // Ohne eigene Vorfälle: der Mock liefert „jetzt“ eine Verspätung
  const service = incidents ? { getState: async () => ({ connection: { status: 'ok' }, incidents: cur.incidents }) } : createService({ config: cfg, store, now });
  const n = createNotifier({ config: cfg, store, service, now, fcm });
  return { n, store, dev, clock, cur, fcm, tourId, cfg, now, dir };
}

test('Benachrichtigung: einmal je Vorfall, Warteschlange wird geleert', async () => {
  const { n, store, dev, fcm } = await setup('rego-n-');
  // Beispieldaten: S1 +8 Min. und – weil der nächste Zug ebenfalls auf Gleis 3 statt 2 fährt – ein Gleiswechsel
  assert.equal(await n.checkDevice(dev), 2);
  assert.equal(fcm.calls.length, 1); assert.equal(fcm.calls[0], NATIVE.fcm);          // ein Anstoß für beide Meldungen
  assert.equal(await n.checkDevice(dev), 0);          // nicht doppelt
  const out = await n.takeOutbox(dev);
  assert.deepEqual(out.map((o) => o.kind).sort(), ['delay', 'platform']);
  assert.match(out.find((o) => o.kind === 'delay').title, /\+8 Min\./);
  assert.match(out.find((o) => o.kind === 'platform').title, /^Gleiswechsel · S1$/);
  assert.deepEqual(await n.takeOutbox(dev), []);
  // ungültiges Firebase-Token wird vergessen, das Gerät bleibt für das regelmäßige Abholen eingetragen
  fcm.result = 'gone';
  const r = await n.sendTest(dev);
  assert.equal(r.instant, false);
  assert.deepEqual((await store.load(dev)).push, { native: true });
});

test('Push-Dienst nicht erreichbar: Meldung geht nicht verloren, nächster Durchlauf versucht es erneut', async () => {
  const { n, store, dev, fcm } = await setup('rego-n2-', { fcm: fcmStub('error') });
  assert.equal(await n.checkDevice(dev), 0);          // Zustellung scheitert
  assert.equal((await store.load(dev)).push.fcm, NATIVE.fcm);   // Abo bleibt
  fcm.result = 'ok';
  assert.equal(await n.checkDevice(dev), 2);          // zweiter Versuch klappt
  assert.equal(fcm.calls.length, 2);
  assert.equal((await n.takeOutbox(dev)).length, 2);  // jede Meldung genau einmal, keine doppelte
});

test('Ohne Firebase: Meldung liegt zum Abholen bereit (App fragt alle ~15 Min.)', async () => {
  const { n, dev } = await setup('rego-n5-', { push: { native: true }, fcm: null });
  assert.equal(await n.checkDevice(dev), 2);
  assert.equal((await n.takeOutbox(dev)).length, 2);
});

test('Benachrichtigung: Änderung der Verspätung aktualisiert, Wegfall entfernt die Meldung', async () => {
  const inc = { id: 'a1', kind: 'delay', delayMin: 6, title: 'S5 Freising → München Hbf', summary: 'x', validity: { activeNow: true } };
  const { n, dev, cur } = await setup('rego-n3-', { incidents: [inc] });
  assert.equal(await n.checkDevice(dev), 1);
  let out = await n.takeOutbox(dev);
  assert.equal(out[0].tag, 'inc|a1'); assert.ok(!out[0].update);
  cur.incidents = [{ ...inc, delayMin: 9 }];
  assert.equal(await n.checkDevice(dev), 1);
  out = await n.takeOutbox(dev);
  assert.equal(out[0].update, true); assert.match(out[0].title, /\+9 Min\./);
  assert.equal(await n.checkDevice(dev), 0);          // unverändert: nichts
  cur.incidents = [];
  assert.equal(await n.checkDevice(dev), 0);          // erster Durchlauf ohne Vorfall: noch abwarten
  assert.equal(await n.checkDevice(dev), 1);          // zweiter: Meldung entfernen
  out = await n.takeOutbox(dev);
  assert.deepEqual([out[0].clear, out[0].tag], [true, 'inc|a1']);
  assert.equal(await n.checkDevice(dev), 0);
});

test('Benachrichtigung: Ausfall und Gleiswechsel kommen mit ihrer Art, spätere Änderungen leise', async () => {
  const cancelled = { id: 'c1', kind: 'cancelled', count: 1, delayMin: 0, lineName: 'RE 5', title: 'RE 5 München Hbf → Salzburg Hbf', summary: 'Fahrt um 07:20 fällt aus', validity: { activeNow: true } };
  const platform = { id: 'p1', kind: 'platform', platform: '3', delayMin: 0, lineName: 'S 1', title: 'S 1 Freising → München Hbf', summary: '07:21 jetzt Gleis 3 statt Gleis 2', validity: { activeNow: true } };
  const { n, dev, cur } = await setup('rego-n6-', { incidents: [cancelled, platform] });
  assert.equal(await n.checkDevice(dev), 2);
  let out = await n.takeOutbox(dev);
  assert.deepEqual(out.map((o) => o.kind).sort(), ['cancelled', 'platform']);
  assert.match(out.find((o) => o.kind === 'cancelled').title, /^Ausfall · RE 5$/);
  assert.deepEqual(out.map((o) => o.line).sort(), ['RE 5', 'S 1']);      // die App schreibt später „RE 5 · behoben“
  // noch eine Fahrt fällt aus, das Gleis wechselt erneut: bestehende Meldungen werden aktualisiert (update), nicht neu gemeldet
  cur.incidents = [{ ...cancelled, count: 2, summary: 'Fahrten um 07:20 und 07:40 fallen aus' }, { ...platform, platform: '5', summary: '07:21 jetzt Gleis 5 statt Gleis 2' }];
  assert.equal(await n.checkDevice(dev), 2);
  out = await n.takeOutbox(dev);
  assert.ok(out.every((o) => o.update === true));
  assert.equal(await n.checkDevice(dev), 0);
});

test('Testmeldung: sofort bei Firebase, sonst erst beim Abholen; ohne Abo nicht möglich', async () => {
  const a = await setup('rego-t1-', { incidents: [] });
  const r1 = await a.n.sendTest(a.dev);
  assert.equal(r1.instant, true); assert.equal(a.fcm.calls.length, 1);
  const out = await a.n.takeOutbox(a.dev);
  assert.equal(out.length, 1); assert.equal(out[0].kind, 'test'); assert.equal(out[0].title, 'ReGo Testmeldung');
  const b = await setup('rego-t2-', { incidents: [], push: { native: true }, fcm: null });
  const r2 = await b.n.sendTest(b.dev);
  assert.equal(r2.instant, false); assert.equal((await b.n.takeOutbox(b.dev)).length, 1);
});

test('Push-Test ohne Abo gibt 409, kaputte Adresse 400, große Anfrage 413', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'rego-'));
  const { server } = await appOn(dir);
  const base = `http://127.0.0.1:${server.address().port}`;
  const h = { 'x-device': 'testdevice0123456789abcdef', 'content-type': 'application/json' };
  try {
    assert.equal((await fetch(base + '/api/push/test', { method: 'POST', headers: h })).status, 409);
    assert.equal((await fetch(base + '/%E0%A4%A')).status, 400);
    assert.equal((await fetch(base + '/api/tours', { method: 'POST', headers: h, body: 'a'.repeat(100000) })).status, 413);
  } finally { server.close(); }
});

test('Push-Test mit Abo: meldet, ob die Meldung sofort unterwegs ist', async () => {
  const fcm = fcmStub();
  const { server } = await appOn(await mkdtemp(join(tmpdir(), 'rego-')), {}, fcm);
  const base = `http://127.0.0.1:${server.address().port}`;
  const h = { 'x-device': 'testdevice0123456789abcdef', 'content-type': 'application/json' };
  try {
    // App meldet sich an (mit Firebase-Token): Test geht sofort raus
    const sub = await (await fetch(base + '/api/push/native', { method: 'PUT', headers: h, body: JSON.stringify({ token: 'x'.repeat(60) }) })).json();
    assert.equal(sub.instant, true);
    // Statusseite: Server hat einen Schlüssel, ein Abo mit Firebase-Kennung
    const st = await (await fetch(base + '/api/status')).json();
    assert.equal(st.instantPush, true); assert.equal(st.pushSubscriptions, 1); assert.equal(st.pushWithToken, 1);
    let r = await fetch(base + '/api/push/test', { method: 'POST', headers: h, body: '{}' });
    assert.equal(r.status, 200); assert.deepEqual(await r.json(), { ok: true, instant: true });
    assert.equal(fcm.calls.length, 1);
    // Push-Dienst nicht erreichbar: 502 mit Erklärung, die Meldung bleibt zum Abholen liegen
    fcm.result = 'error';
    r = await fetch(base + '/api/push/test', { method: 'POST', headers: h, body: '{}' });
    assert.equal(r.status, 502); assert.match((await r.json()).error, /Push-Dienst/);
    // ohne Token: kein Sofort-Push, aber angenommen
    await fetch(base + '/api/push/native', { method: 'PUT', headers: h, body: '{}' });
    r = await fetch(base + '/api/push/test', { method: 'POST', headers: h, body: '{}' });
    assert.deepEqual(await r.json(), { ok: true, instant: false });
    const got = await (await fetch(base + '/api/notifications', { headers: h })).json();
    assert.ok(got.notifications.length >= 2 && got.notifications.every((x) => x.kind === 'test'));
  } finally { server.close(); }
});

async function appOn(dir, extra = {}, fcmClient) {
  const { createApp } = await import('../server/index.mjs');
  const { server, store } = createApp({ cfg: { ...config, dataDir: dir, provider: 'mock', ...extra }, ...(fcmClient ? { fcmClient } : {}) });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { server, store, base: `http://127.0.0.1:${server.address().port}` };
}
const H = { 'x-device': 'testdevice0123456789abcdef', 'content-type': 'application/json' };

test('Haltestellensuche braucht Geräte-ID, Header und Status stehen', async () => {
  const { server, base } = await appOn(await mkdtemp(join(tmpdir(), 'rego-')));
  try {
    assert.equal((await fetch(base + '/api/stations?q=Freising')).status, 400);
    const ok = await fetch(base + '/api/stations?q=Freising', { headers: H });
    assert.equal(ok.status, 200);
    assert.match(ok.headers.get('content-security-policy'), /default-src 'self'/);
    assert.equal(ok.headers.get('x-content-type-options'), 'nosniff');
    const html = await fetch(base + '/');
    assert.match(html.headers.get('content-security-policy'), /frame-ancestors 'none'/);
    assert.doesNotMatch(html.headers.get('content-security-policy'), /manifest-src/);
    const st = await (await fetch(base + '/api/status')).json();
    assert.equal(st.provider, 'mock'); assert.match(st.version, /\d/); assert.equal(typeof st.devices, 'number');
    // Ohne Firebase-Schlüssel sagt die Statusseite klar „Sofort-Push aus“ (nur Zahlen, nichts Persönliches)
    assert.equal(st.instantPush, false); assert.equal(st.pushWithToken, 0);
    const page = await fetch(base + '/status'); assert.match(await page.text(), /ReGo Status/);
  } finally { server.close(); }
});

test('Browser-Version ist weg: kein Service Worker, kein Web-App-Manifest, keine Web-Push-Schnittstelle', async () => {
  const { server, base } = await appOn(await mkdtemp(join(tmpdir(), 'rego-')));
  try {
    assert.equal((await fetch(base + '/sw.js')).status, 404);
    assert.equal((await fetch(base + '/manifest.webmanifest')).status, 404);
    assert.equal((await fetch(base + '/api/push/key', { headers: H })).status, 404);
    assert.equal((await fetch(base + '/api/push', { method: 'PUT', headers: H, body: '{"endpoint":"https://fcm.googleapis.com/x"}' })).status, 404);
    const html = await (await fetch(base + '/')).text();
    assert.doesNotMatch(html, /manifest|serviceWorker|apple-touch/i);
  } finally { server.close(); }
});

test('Profile ohne Nutzung werden gelöscht, benutzte bleiben', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'rego-'));
  const { utimes } = await import('node:fs/promises');
  const store = new ProfileStore(dir);
  await store.update('altesgeraet0123456789', (p) => { p.tours = []; p.lastSeen = Date.now() - 200 * 864e5; });   // seit 200 Tagen nichts gehört
  await store.update('neuesgeraet0123456789', (p) => { p.tours = []; });
  await store.update('aeltlichgeraet012345678', (p) => { p.tours = []; });
  const old = new Date(Date.now() - 200 * 864e5);
  // Profil aus älterer Version ohne Vermerk „zuletzt gesehen“: dann zählt die Dateizeit
  const { writeFile } = await import('node:fs/promises');
  await writeFile(join(dir, 'profiles', 'aeltlichgeraet012345678.json'), JSON.stringify({ tours: [], settings: {}, push: null, updatedAt: 1 }));
  await utimes(join(dir, 'profiles', 'aeltlichgeraet012345678.json'), old, old);
  assert.equal(await store.purge(180), 2);
  assert.equal((await store.load('neuesgeraet0123456789')).updatedAt > 0, true);
  assert.equal((await store.load('altesgeraet0123456789')).updatedAt, 0);
  assert.equal(await store.purge(0), 0);
});

test('Push-Zeitfenster: nur ±20 Min. um die Abfahrt an den Strecken-Tagen', async () => {
  const { setSettings } = await import('../server/store/profile.mjs');
  const p = { settings: { pushThresholdMin: 5 } };
  setSettings(p, { pushWindow: true }); assert.equal(p.settings.pushWindow, true);
  assert.throws(() => setSettings(p, { pushWindow: 'ja' }));
  assert.throws(() => setSettings(p, {}));
});

test('Push-Zeitfenster greift: nur ±20 Min. um die Abfahrt, nur an Strecken-Tagen', async () => {
  const inc = (tourId) => [{ id: 'w1', tourId, kind: 'delay', delayMin: 9, title: 'S1 Freising → München Hbf', summary: 'x', validity: { activeNow: true } }];
  const s = await setup('rego-n4-', { t: Date.parse('2026-10-12T12:00:00+02:00'), tours: { schedule: { days: ['Mo', 'Di'], departAfter: '07:00' } } });   // Montag, Mittag
  s.cur.incidents = inc(s.tourId);
  const n = createNotifier({ config: s.cfg, store: s.store, service: { getState: async () => ({ connection: { status: 'ok' }, incidents: s.cur.incidents }) }, now: s.now, fcm: s.fcm });
  await s.store.update(s.dev, (p) => { p.settings.pushWindow = true; });
  assert.equal(await n.checkDevice(s.dev), 0);           // 12:00, weit weg von 07:00
  s.clock.t = Date.parse('2026-10-12T07:15:00+02:00');
  assert.equal(await n.checkDevice(s.dev), 1);           // 15 Min. nach Abfahrtszeit
  await s.store.update(s.dev, (p) => { p.notified = {}; p.shownDelay = {}; });
  s.clock.t = Date.parse('2026-10-14T07:00:00+02:00');   // Mittwoch, kein Strecken-Tag
  assert.equal(await n.checkDevice(s.dev), 0);
});

import { createFcm } from '../server/fcm.mjs';
import { generateKeyPairSync } from 'node:crypto';
test('FCM: ohne Schlüssel aus, mit Schlüssel sendet Anstoß und erkennt ungültige Token', async () => {
  assert.equal(createFcm(null).enabled, false);
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const key = { project_id: 'p', client_email: 'x@p.iam.gserviceaccount.com', private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }) };
  const calls = [];
  let status = 200;
  const fetchFn = async (url, o) => {
    calls.push(url);
    if (url.includes('oauth2')) return { ok: true, json: async () => ({ access_token: 'T', expires_in: 3600 }) };
    return { ok: status === 200, status, text: async () => '{"error":{"status":"UNREGISTERED"}}' };
  };
  const f = createFcm(key, { fetchFn });
  assert.equal(f.enabled, true);
  assert.equal(await f.send('tok'), 'ok');
  status = 404;
  assert.equal(await f.send('tok'), 'gone');
  assert.equal(calls.filter((u) => u.includes('oauth2')).length, 1);   // Zugangstoken wird wiederverwendet
});
