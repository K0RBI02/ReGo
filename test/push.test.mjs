import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadVapid, vapidHeaders, verifyJwt } from '../server/push.mjs';
import { relevant, textFor, createNotifier } from '../server/notifier.mjs';
import { ProfileStore, addTours } from '../server/store/profile.mjs';
import { createService } from '../server/service.mjs';
import { pushEndpointOk } from '../server/index.mjs';
import { config } from '../server/config.mjs';

test('VAPID: Schlüssel bleibt gleich, Signatur ist gültig', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'rego-v-'));
  const v = await loadVapid(dir), v2 = await loadVapid(dir);
  assert.equal(v.publicKey, v2.publicKey);
  assert.equal(Buffer.from(v.publicKey, 'base64url').length, 65);
  const h = vapidHeaders(v, 'https://fcm.googleapis.com/fcm/send/abc', 'mailto:a@b.de', 1000);
  const m = /^vapid t=([^,]+), k=(.+)$/.exec(h.authorization);
  assert.ok(verifyJwt(m[1], m[2]));
  assert.equal(JSON.parse(Buffer.from(m[1].split('.')[1], 'base64url')).aud, 'https://fcm.googleapis.com');
});

test('Push-Endpunkte: nur bekannte Dienste', () => {
  assert.ok(pushEndpointOk('https://fcm.googleapis.com/fcm/send/x'));
  assert.ok(pushEndpointOk('https://updates.push.services.mozilla.com/wpush/v2/x'));
  assert.ok(!pushEndpointOk('http://fcm.googleapis.com/x'));
  assert.ok(!pushEndpointOk('https://evil.example.org/x'));
  assert.ok(!pushEndpointOk('https://fcm.googleapis.com.evil.org/x'));
});

test('Relevanz und Text', () => {
  const d = { kind: 'delay', delayMin: 8, title: 'S1 Freising → München Hbf', summary: 'Gleiswechsel Gl. 2 → Gl. 3', validity: { activeNow: true } };
  assert.ok(relevant(d, 5)); assert.ok(!relevant({ ...d, delayMin: 3 }, 5));
  assert.deepEqual(textFor(d), { title: 'S1 +8 Min.', body: 'Freising → München Hbf · Gleiswechsel Gl. 2 → Gl. 3' });
  assert.ok(relevant({ kind: 'replacement', delayMin: 0, validity: { activeNow: false } }, 5) === false);
});

test('Benachrichtigung: einmal je Vorfall, Warteschlange wird geleert', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'rego-n-'));
  const cfg = { ...config, provider: 'mock', dataDir: dir };
  // Mock-Verspätung liegt immer „jetzt“; Uhrzeit auf 12:00 Berlin festnageln, damit keine Nachtruhe greift
  const noon = Date.parse('2026-10-10T12:00:00+02:00');
  const now = () => noon;
  const store = new ProfileStore(dir, now);
  const service = createService({ config: cfg, store, now });
  const dev = 'notifygeraet123456';
  await store.update(dev, (p) => { addTours(p, { from: { id: '8002078', name: 'Freising' }, to: { id: '8000261', name: 'München Hbf' } }); p.push = { endpoint: 'https://fcm.googleapis.com/fcm/send/x' }; });
  const sent = [];
  const n = createNotifier({ config: cfg, store, service, vapid: await loadVapid(dir), now, send: async (v, s, sub) => { sent.push(sub.endpoint); return 'ok'; } });
  assert.equal(await n.checkDevice(dev), 1);
  assert.equal(sent.length, 1);
  assert.equal(await n.checkDevice(dev), 0);          // nicht doppelt
  const out = await n.takeOutbox(dev);
  assert.equal(out.length, 1); assert.match(out[0].title, /\+8 Min\./);
  assert.deepEqual(await n.takeOutbox(dev), []);
  // abgelaufenes Abo wird entfernt
  const n2 = createNotifier({ config: cfg, store, service, vapid: await loadVapid(dir), now, send: async () => 'gone' });
  await n2.sendTest(dev);
  assert.equal((await store.load(dev)).push, null);
});

test('Push-Dienst nicht erreichbar: Meldung geht nicht verloren, nächster Durchlauf versucht es erneut', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'rego-n2-'));
  const cfg = { ...config, provider: 'mock', dataDir: dir };
  const noon = Date.parse('2026-10-10T12:00:00+02:00');
  const now = () => noon;
  const store = new ProfileStore(dir, now);
  const service = createService({ config: cfg, store, now });
  const dev = 'notifygeraet654321';
  await store.update(dev, (p) => { addTours(p, { from: { id: '8002078', name: 'Freising' }, to: { id: '8000261', name: 'München Hbf' } }); p.push = { endpoint: 'https://fcm.googleapis.com/fcm/send/y' }; });
  let ok = false; const calls = [];
  const n = createNotifier({ config: cfg, store, service, vapid: await loadVapid(dir), now, send: async () => { calls.push(1); return ok ? 'ok' : 'error'; } });
  assert.equal(await n.checkDevice(dev), 0);          // Zustellung scheitert
  assert.equal((await store.load(dev)).push.endpoint.length > 0, true);   // Abo bleibt
  ok = true;
  assert.equal(await n.checkDevice(dev), 1);          // zweiter Versuch klappt
  assert.equal(calls.length, 2);
  assert.equal((await n.takeOutbox(dev)).length, 1);  // genau eine Meldung, keine doppelte
});

test('Benachrichtigung: Änderung der Verspätung aktualisiert, Wegfall entfernt die Meldung', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'rego-n3-'));
  const cfg = { ...config, provider: 'mock', dataDir: dir };
  let t = Date.parse('2026-10-10T12:00:00+02:00');
  const now = () => t;
  const store = new ProfileStore(dir, now);
  const dev = 'notifygeraet777777';
  await store.update(dev, (p) => { addTours(p, { from: { id: '8002078', name: 'Freising' }, to: { id: '8000261', name: 'München Hbf' } }); p.push = { endpoint: 'https://fcm.googleapis.com/fcm/send/z' }; });
  let incidents = [{ id: 'a1', kind: 'delay', delayMin: 6, title: 'S5 Freising → München Hbf', summary: 'x', validity: { activeNow: true } }];
  const service = { getState: async () => ({ connection: { status: 'ok' }, incidents }) };
  const n = createNotifier({ config: cfg, store, service, vapid: await loadVapid(dir), now, send: async () => 'ok' });
  assert.equal(await n.checkDevice(dev), 1);
  let out = await n.takeOutbox(dev);
  assert.equal(out[0].tag, 'inc|a1'); assert.ok(!out[0].update);
  incidents = [{ ...incidents[0], delayMin: 9 }];
  assert.equal(await n.checkDevice(dev), 1);
  out = await n.takeOutbox(dev);
  assert.equal(out[0].update, true); assert.match(out[0].title, /\+9 Min\./);
  assert.equal(await n.checkDevice(dev), 0);          // unverändert: nichts
  incidents = [];
  assert.equal(await n.checkDevice(dev), 0);          // erster Durchlauf ohne Vorfall: noch abwarten
  assert.equal(await n.checkDevice(dev), 1);          // zweiter: Meldung entfernen
  out = await n.takeOutbox(dev);
  assert.deepEqual([out[0].clear, out[0].tag], [true, 'inc|a1']);
  assert.equal(await n.checkDevice(dev), 0);
});

test('Push-Test ohne Abo gibt 409, kaputte Adresse 400, große Anfrage 413', async () => {
  const { mkdtemp } = await import('node:fs/promises'); const { tmpdir } = await import('node:os'); const { join } = await import('node:path');
  const { createApp } = await import('../server/index.mjs');
  const dir = await mkdtemp(join(tmpdir(), 'rego-'));
  const { server } = createApp({ cfg: { ...(await import('../server/config.mjs')).config, dataDir: dir, provider: 'mock' } });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const h = { 'x-device': 'testdevice0123456789abcdef', 'content-type': 'application/json' };
  try {
    assert.equal((await fetch(base + '/api/push/test', { method: 'POST', headers: h })).status, 409);
    assert.equal((await fetch(base + '/%E0%A4%A')).status, 400);
    assert.equal((await fetch(base + '/api/tours', { method: 'POST', headers: h, body: 'a'.repeat(100000) })).status, 413);
  } finally { server.close(); }
});

async function appOn(dir) {
  const { createApp } = await import('../server/index.mjs');
  const { server, store } = createApp({ cfg: { ...config, dataDir: dir, provider: 'mock' } });
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
    const st = await (await fetch(base + '/api/status')).json();
    assert.equal(st.provider, 'mock'); assert.match(st.version, /\d/); assert.equal(typeof st.devices, 'number');
    const page = await fetch(base + '/status'); assert.match(await page.text(), /ReGo Status/);
  } finally { server.close(); }
});

test('Profile ohne Nutzung werden gelöscht, benutzte bleiben', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'rego-'));
  const { utimes } = await import('node:fs/promises');
  const store = new ProfileStore(dir);
  await store.update('altesgeraet0123456789', (p) => { p.tours = []; });
  await store.update('neuesgeraet0123456789', (p) => { p.tours = []; });
  const old = new Date(Date.now() - 200 * 864e5);
  await utimes(join(dir, 'profiles', 'altesgeraet0123456789.json'), old, old);
  assert.equal(await store.purge(180), 1);
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
  const dir = await mkdtemp(join(tmpdir(), 'rego-n4-'));
  const cfg = { ...config, provider: 'mock', dataDir: dir };
  let t = Date.parse('2026-10-12T12:00:00+02:00');     // Montag, Mittag
  const now = () => t;
  const store = new ProfileStore(dir, now);
  const dev = 'notifygeraet888888';
  let tourId;
  await store.update(dev, (p) => { tourId = addTours(p, { from: { id: '8002078', name: 'Freising' }, to: { id: '8000261', name: 'München Hbf' }, schedule: { days: ['Mo', 'Di'], departAfter: '07:00' } })[0].id; p.push = { endpoint: 'https://fcm.googleapis.com/fcm/send/w' }; p.settings.pushWindow = true; });
  const incidents = [{ id: 'w1', tourId, kind: 'delay', delayMin: 9, title: 'S1 Freising → München Hbf', summary: 'x', validity: { activeNow: true } }];
  const service = { getState: async () => ({ connection: { status: 'ok' }, incidents }) };
  const n = createNotifier({ config: cfg, store, service, vapid: await loadVapid(dir), now, send: async () => 'ok' });
  assert.equal(await n.checkDevice(dev), 0);           // 12:00, weit weg von 07:00
  t = Date.parse('2026-10-12T07:15:00+02:00');
  assert.equal(await n.checkDevice(dev), 1);           // 15 Min. nach Abfahrtszeit
  await store.update(dev, (p) => { p.notified = {}; p.shownDelay = {}; });
  t = Date.parse('2026-10-14T07:00:00+02:00');         // Mittwoch, kein Strecken-Tag
  assert.equal(await n.checkDevice(dev), 0);
});
