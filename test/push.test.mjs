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
