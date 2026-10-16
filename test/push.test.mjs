import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { relevant, textFor, changeOf, createNotifier } from '../server/notifier.mjs';
import { ProfileStore, addTours } from '../server/store/profile.mjs';
import { createService } from '../server/service.mjs';
import { config } from '../server/config.mjs';

/** Firebase stand-in: counts the nudges and returns the desired result ('ok' | 'gone' | 'error'). */
const fcmStub = (result = 'ok') => { const c = { enabled: true, calls: [], result, async send(tok) { c.calls.push(tok); return typeof c.result === 'function' ? c.result() : c.result; } }; return c; };
const NATIVE = { native: true, fcm: 'fcm-token-0123456789abcdef' };

test('Relevance and text', () => {
  const d = { kind: 'delay', delayMin: 8, title: 'S1 Freising → München Hbf', summary: 'Gleiswechsel Gl. 2 → Gl. 3', validity: { activeNow: true } };
  assert.ok(relevant(d, 5)); assert.ok(!relevant({ ...d, delayMin: 3 }, 5));
  assert.deepEqual(textFor(d), { title: 'S1 +8 Min.', body: 'Freising → München Hbf · Gleiswechsel Gl. 2 → Gl. 3' });
  assert.ok(relevant({ kind: 'replacement', delayMin: 0, validity: { activeNow: false } }, 5) === false);
  // Cancellation and platform change are always worth a notification, regardless of the delay threshold
  assert.ok(relevant({ kind: 'cancelled', delayMin: 0, validity: { activeNow: true } }, 10));
  assert.ok(relevant({ kind: 'platform', delayMin: 0, validity: { activeNow: true } }, 10));
  assert.deepEqual(textFor({ kind: 'cancelled', lineName: 'RE 5', title: 'RE 5 München Hbf → Salzburg Hbf', summary: 'Fahrt um 07:20 fällt aus' }), { title: 'Ausfall · RE 5', body: 'München Hbf → Salzburg Hbf · Fahrt um 07:20 fällt aus' });
  assert.equal(textFor({ kind: 'platform', lineName: 'S 1', title: 'S 1 Freising → München Hbf', summary: '07:21 jetzt Gleis 3 statt Gleis 2' }).title, 'Gleiswechsel · S 1');
  // What may change about a known notification without it being new
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
  await store.update(dev, (p) => { tourId = addTours(p, { from: { id: '8002078', name: 'Freising' }, to: { id: '8000261', name: 'München Hbf' }, schedule: { days: ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'], departAfter: '11:30', departUntil: '12:30' }, ...(tours || {}) })[0].id; p.push = push; });   // commute time around the test clock: push is allowed
  const cur = { incidents };
  // Without incidents of its own: the mock returns a delay "now"
  const service = incidents ? { getState: async () => ({ connection: { status: 'ok' }, incidents: cur.incidents }) } : createService({ config: cfg, store, now });
  const n = createNotifier({ config: cfg, store, service, now, fcm });
  return { n, store, dev, clock, cur, fcm, tourId, cfg, now, dir };
}

test('Notification: once per incident, queue is emptied', async () => {
  const { n, store, dev, fcm } = await setup('rego-n-');
  // Sample data: S1 +8 min and – because the next train also runs on platform 3 instead of 2 – a platform change
  assert.equal(await n.checkDevice(dev), 2);
  assert.equal(fcm.calls.length, 1); assert.equal(fcm.calls[0], NATIVE.fcm);          // one nudge for both notifications
  assert.equal(await n.checkDevice(dev), 0);          // not twice
  const out = await n.takeOutbox(dev);
  assert.deepEqual(out.map((o) => o.kind).sort(), ['delay', 'platform']);
  assert.match(out.find((o) => o.kind === 'delay').title, /\+8 Min\./);
  assert.match(out.find((o) => o.kind === 'platform').title, /^Gleiswechsel · S1$/);
  assert.deepEqual(await n.takeOutbox(dev), []);
  // invalid Firebase token is forgotten, the device stays registered for the regular fetching
  fcm.result = 'gone';
  const r = await n.sendTest(dev);
  assert.equal(r.instant, false);
  assert.deepEqual((await store.load(dev)).push, { native: true });
});

test('Push service unreachable: notification is not lost, the next pass tries again', async () => {
  const { n, store, dev, fcm } = await setup('rego-n2-', { fcm: fcmStub('error') });
  assert.equal(await n.checkDevice(dev), 0);          // Zustellung scheitert
  assert.equal((await store.load(dev)).push.fcm, NATIVE.fcm);   // subscription stays
  fcm.result = 'ok';
  assert.equal(await n.checkDevice(dev), 2);          // zweiter Versuch klappt
  assert.equal(fcm.calls.length, 2);
  assert.equal((await n.takeOutbox(dev)).length, 2);  // each notification exactly once, none twice
});

test('Without Firebase: notification is ready for pickup (app asks every ~15 min)', async () => {
  const { n, dev } = await setup('rego-n5-', { push: { native: true }, fcm: null });
  assert.equal(await n.checkDevice(dev), 2);
  assert.equal((await n.takeOutbox(dev)).length, 2);
});

test('Notification: change of the delay updates, disappearance removes the notification', async () => {
  const inc = { id: 'a1', kind: 'delay', delayMin: 6, title: 'S5 Freising → München Hbf', summary: 'x', validity: { activeNow: true } };
  const { n, dev, cur } = await setup('rego-n3-', { incidents: [inc] });
  assert.equal(await n.checkDevice(dev), 1);
  let out = await n.takeOutbox(dev);
  assert.equal(out[0].tag, 'inc|a1'); assert.ok(!out[0].update);
  cur.incidents = [{ ...inc, delayMin: 9 }];
  assert.equal(await n.checkDevice(dev), 1);
  out = await n.takeOutbox(dev);
  assert.equal(out[0].update, true); assert.match(out[0].title, /\+9 Min\./);
  assert.equal(await n.checkDevice(dev), 0);          // unchanged: nothing
  cur.incidents = [];
  assert.equal(await n.checkDevice(dev), 0);          // first pass without the incident: wait and see
  assert.equal(await n.checkDevice(dev), 1);          // second: remove the notification
  out = await n.takeOutbox(dev);
  assert.deepEqual([out[0].clear, out[0].tag], [true, 'inc|a1']);
  assert.equal(await n.checkDevice(dev), 0);
});

test('Notification: cancellation and platform change come with their kind, later changes quietly', async () => {
  const cancelled = { id: 'c1', kind: 'cancelled', count: 1, delayMin: 0, lineName: 'RE 5', title: 'RE 5 München Hbf → Salzburg Hbf', summary: 'Fahrt um 07:20 fällt aus', validity: { activeNow: true } };
  const platform = { id: 'p1', kind: 'platform', platform: '3', delayMin: 0, lineName: 'S 1', title: 'S 1 Freising → München Hbf', summary: '07:21 jetzt Gleis 3 statt Gleis 2', validity: { activeNow: true } };
  const { n, dev, cur } = await setup('rego-n6-', { incidents: [cancelled, platform] });
  assert.equal(await n.checkDevice(dev), 2);
  let out = await n.takeOutbox(dev);
  assert.deepEqual(out.map((o) => o.kind).sort(), ['cancelled', 'platform']);
  assert.match(out.find((o) => o.kind === 'cancelled').title, /^Ausfall · RE 5$/);
  assert.deepEqual(out.map((o) => o.line).sort(), ['RE 5', 'S 1']);      // the app later writes "RE 5 · behoben"
  // another trip is cancelled, the platform changes again: existing notifications are updated (update), not reported anew
  cur.incidents = [{ ...cancelled, count: 2, summary: 'Fahrten um 07:20 und 07:40 fallen aus' }, { ...platform, platform: '5', summary: '07:21 jetzt Gleis 5 statt Gleis 2' }];
  assert.equal(await n.checkDevice(dev), 2);
  out = await n.takeOutbox(dev);
  assert.ok(out.every((o) => o.update === true));
  assert.equal(await n.checkDevice(dev), 0);
});

test('Test notification: immediately with Firebase, otherwise only at pickup; not possible without a subscription', async () => {
  const a = await setup('rego-t1-', { incidents: [] });
  const r1 = await a.n.sendTest(a.dev);
  assert.equal(r1.instant, true); assert.equal(a.fcm.calls.length, 1);
  const out = await a.n.takeOutbox(a.dev);
  assert.equal(out.length, 1); assert.equal(out[0].kind, 'test'); assert.equal(out[0].title, 'ReGo Testmeldung');
  const b = await setup('rego-t2-', { incidents: [], push: { native: true }, fcm: null });
  const r2 = await b.n.sendTest(b.dev);
  assert.equal(r2.instant, false); assert.equal((await b.n.takeOutbox(b.dev)).length, 1);
});

test('Push test without subscription gives 409, broken address 400, large request 413', async () => {
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

test('Push test with subscription: reports whether the notification is on its way immediately', async () => {
  const fcm = fcmStub();
  const { server } = await appOn(await mkdtemp(join(tmpdir(), 'rego-')), {}, fcm);
  const base = `http://127.0.0.1:${server.address().port}`;
  const h = { 'x-device': 'testdevice0123456789abcdef', 'content-type': 'application/json' };
  try {
    // app registers (with Firebase token): test goes out immediately
    const sub = await (await fetch(base + '/api/push/native', { method: 'PUT', headers: h, body: JSON.stringify({ token: 'x'.repeat(60) }) })).json();
    assert.equal(sub.instant, true);
    // status page: server has a key, one subscription with a Firebase token
    const st = await (await fetch(base + '/api/status')).json();
    assert.equal(st.instantPush, true); assert.equal(st.pushSubscriptions, 1); assert.equal(st.pushWithToken, 1);
    let r = await fetch(base + '/api/push/test', { method: 'POST', headers: h, body: '{}' });
    assert.equal(r.status, 200); assert.deepEqual(await r.json(), { ok: true, instant: true });
    assert.equal(fcm.calls.length, 1);
    // push service unreachable: 502 with explanation, the notification stays ready for pickup
    fcm.result = 'error';
    r = await fetch(base + '/api/push/test', { method: 'POST', headers: h, body: '{}' });
    assert.equal(r.status, 502); assert.match((await r.json()).error, /Push-Dienst/);
    // without token: no instant push, but accepted
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

test('Stop search needs a device ID, headers and status are in place', async () => {
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
    // Without a Firebase key the status page clearly says "Sofort-Push aus" (numbers only, nothing personal)
    assert.equal(st.instantPush, false); assert.equal(st.pushWithToken, 0);
    const page = await fetch(base + '/status'); assert.match(await page.text(), /ReGo Status/);
  } finally { server.close(); }
});

test('Browser version is gone: no service worker, no web app manifest, no web push interface', async () => {
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

test('Profiles without use are deleted, used ones stay', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'rego-'));
  const { utimes } = await import('node:fs/promises');
  const store = new ProfileStore(dir);
  await store.update('altesgeraet0123456789', (p) => { p.tours = []; p.lastSeen = Date.now() - 200 * 864e5; });   // nothing heard for 200 days
  await store.update('neuesgeraet0123456789', (p) => { p.tours = []; });
  await store.update('aeltlichgeraet012345678', (p) => { p.tours = []; });
  const old = new Date(Date.now() - 200 * 864e5);
  // profile from an older version without a "last seen" note: then the file time counts
  const { writeFile } = await import('node:fs/promises');
  await writeFile(join(dir, 'profiles', 'aeltlichgeraet012345678.json'), JSON.stringify({ tours: [], settings: {}, push: null, updatedAt: 1 }));
  await utimes(join(dir, 'profiles', 'aeltlichgeraet012345678.json'), old, old);
  assert.equal(await store.purge(180), 2);
  assert.equal((await store.load('neuesgeraet0123456789')).updatedAt > 0, true);
  assert.equal((await store.load('altesgeraet0123456789')).updatedAt, 0);
  assert.equal(await store.purge(0), 0);
});

test('The old switch "Nur rund um die Abfahrt" is accepted but has no effect any more', async () => {
  const { setSettings, defaultProfile } = await import('../server/store/profile.mjs');
  const p = defaultProfile();
  assert.equal('pushWindow' in p.settings, false);
  assert.deepEqual(setSettings(p, { pushWindow: true }), { pushThresholdMin: 5, delayGraceMin: 10 });      // older app: no error, nothing stored
  assert.throws(() => setSettings(p, { pushWindow: 'ja' }));
  assert.throws(() => setSettings(p, {}));
});

test('Push follows the commute time: from one hour before until 10 min after the window, only on route days', async () => {
  const inc = (tourId) => [{ id: 'w1', tourId, kind: 'delay', delayMin: 9, title: 'S1 Freising → München Hbf', summary: 'x', validity: { activeNow: true } }];
  const s = await setup('rego-n4-', { t: Date.parse('2026-10-12T12:00:00+02:00'), tours: { schedule: { days: ['Mo', 'Di'], departAfter: '07:00', departUntil: '08:00' } } });   // Montag, Mittag
  s.cur.incidents = inc(s.tourId);
  const n = createNotifier({ config: s.cfg, store: s.store, service: { getState: async () => ({ connection: { status: 'ok' }, incidents: s.cur.incidents }) }, now: s.now, fcm: s.fcm });
  const at = (hm, day = '12') => { s.clock.t = Date.parse(`2026-10-${day}T${hm}:00+02:00`); };
  const reset = () => s.store.update(s.dev, (p) => { p.notified = {}; p.shownDelay = {}; p.goneCount = {}; p.outbox = []; });
  assert.equal(await n.checkDevice(s.dev), 0);                       // 12:00: far after the window
  at('05:50'); assert.equal(await n.checkDevice(s.dev), 0);          // still more than an hour before the window
  at('06:00'); assert.equal(await n.checkDevice(s.dev), 1);          // exactly one hour before: the incident is reported
  await reset(); at('07:30'); assert.equal(await n.checkDevice(s.dev), 1);   // in the middle of the window
  await reset(); at('08:10'); assert.equal(await n.checkDevice(s.dev), 1);   // 10 min after the end
  await reset(); at('08:11'); assert.equal(await n.checkDevice(s.dev), 0);   // after that no more
  await reset(); at('07:30', '14'); assert.equal(await n.checkDevice(s.dev), 0);    // Wednesday: not a route day
});

test('Push: the end of the commute time does not remove a reported disruption as "behoben", its own end does', async () => {
  const s = await setup('rego-n5-', { t: Date.parse('2026-10-12T07:30:00+02:00'), tours: { schedule: { days: ['Mo'], departAfter: '07:00', departUntil: '08:00' } } });
  const construction = (tourId) => [{ id: 'b1', tourId, kind: 'construction', delayMin: 0, title: 'S1 Freising → München Hbf', summary: 'Baustelle', validity: { activeNow: true } }];
  s.cur.incidents = construction(s.tourId);
  const n = createNotifier({ config: s.cfg, store: s.store, service: { getState: async () => ({ connection: { status: 'ok' }, incidents: s.cur.incidents }) }, now: s.now, fcm: s.fcm });
  assert.equal(await n.checkDevice(s.dev), 1);                       // reported in the window
  await n.takeOutbox(s.dev);
  for (const hm of ['08:30', '08:31', '09:00']) { s.clock.t = Date.parse(`2026-10-12T${hm}:00+02:00`); assert.equal(await n.checkDevice(s.dev), 0); }   // window over, construction still there: nothing new, nothing gone
  assert.deepEqual(await n.takeOutbox(s.dev), []);
  s.cur.incidents = [];                                              // the construction is over
  s.clock.t = Date.parse('2026-10-12T09:10:00+02:00'); await n.checkDevice(s.dev);
  s.clock.t = Date.parse('2026-10-12T09:11:00+02:00');
  assert.equal(await n.checkDevice(s.dev), 1);                       // after two passes: "behoben"
  assert.deepEqual((await n.takeOutbox(s.dev)).map((o) => !!o.clear), [true]);
});

// ---------- Night quiet (23:00–04:00) and its exception for routes whose own push period reaches into the night ----------

const MON = '2026-10-12', TUE = '2026-10-13';                       // summer time (CEST)
const delayOf = (id, tourId, delayMin = 9) => ({ id, tourId, kind: 'delay', delayMin, title: 'S1 Freising → München Hbf', summary: 'x', validity: { activeNow: true } });
const FS = { id: '8002078', name: 'Freising' }, MH = { id: '8000261', name: 'München Hbf' };
const addRoute = (s, to, schedule, legacy = false) => s.store.update(s.dev, (p) => {
  const id = addTours(p, { from: FS, to, schedule })[0].id;
  if (legacy) delete p.tours.find((t) => t.id === id).schedule;      // older data: a route without commute times
  return id;
});
const atTime = (s, hm, day = TUE) => { s.clock.t = Date.parse(`${day}T${hm}:00+02:00`); };

test('Night quiet: a route with an early window still pushes (one hour before it), every other route stays quiet until morning', async () => {
  // A leaves Tuesdays at 04:20 (push period 03:20–05:30), B at 07:00, C is an older route without times
  const s = await setup('rego-nq1-', { incidents: [], t: Date.parse(`${MON}T12:00:00+02:00`), tours: { schedule: { days: ['Di'], departAfter: '04:20', departUntil: '05:20' } } });
  const A = s.tourId;
  const B = await addRoute(s, { id: '8000105', name: 'Frankfurt Hbf' }, { days: ['Di'], departAfter: '07:00', departUntil: '08:00' });
  const C = await addRoute(s, { id: '8100002', name: 'Salzburg Hbf' }, { days: ['Di'], departAfter: '09:00' }, true);
  s.cur.incidents = [delayOf('a1', A), delayOf('b1', B), delayOf('c1', C)];
  const tags = async () => ((await s.store.load(s.dev)).outbox || []).map((o) => o.tag);
  atTime(s, '02:30'); assert.equal(await s.n.checkDevice(s.dev), 0);          // night, A's period has not begun
  atTime(s, '03:19'); assert.equal(await s.n.checkDevice(s.dev), 0);
  assert.deepEqual(await tags(), []);
  atTime(s, '03:20'); assert.equal(await s.n.checkDevice(s.dev), 1);          // exactly one hour before A's window: only A, B and C stay silent
  assert.deepEqual(await tags(), ['inc|a1']);
  atTime(s, '03:21'); assert.equal(await s.n.checkDevice(s.dev), 0);          // not twice
  s.cur.incidents = [delayOf('a1', A, 12), delayOf('b1', B), delayOf('c1', C)];
  atTime(s, '03:40'); assert.equal(await s.n.checkDevice(s.dev), 1);          // a changed delay on A is still updated (silently) at night
  assert.deepEqual((await s.store.load(s.dev)).outbox.map((o) => [o.tag, !!o.update]), [['inc|a1', false], ['inc|a1', true]]);
  atTime(s, '04:00'); assert.equal(await s.n.checkDevice(s.dev), 1);          // morning: the older route C pushes as before, B's period (from 06:00) has not begun
  assert.deepEqual((await s.store.load(s.dev)).outbox.map((o) => o.tag).slice(-1), ['inc|c1']);
});

test('Night quiet: without a route in its exception the server does not even ask the source', async () => {
  const s = await setup('rego-nq2-', { incidents: [], t: Date.parse(`${MON}T12:00:00+02:00`), tours: { schedule: { days: ['Mo', 'Di'], departAfter: '07:00', departUntil: '08:00' } } });
  let asked = 0;
  const n = createNotifier({ config: s.cfg, store: s.store, service: { getState: async () => { asked++; return { connection: { status: 'ok' }, incidents: [delayOf('x1', s.tourId)] }; } }, now: s.now, fcm: s.fcm });
  for (const hm of ['23:00', '00:30', '03:59']) { atTime(s, hm, MON); assert.equal(await n.checkDevice(s.dev), 0); }
  assert.equal(asked, 0);
  atTime(s, '06:00'); assert.equal(await n.checkDevice(s.dev), 1); assert.equal(asked, 1);      // the morning period begins
});

test('Night quiet: a notification of another route is neither counted as gone nor cleared at night, in the morning it is', async () => {
  // E is the evening route (Mondays 21:00–22:00), its delay was announced at 21:30; A leaves Tuesdays at 04:20
  const s = await setup('rego-nq3-', { incidents: [], t: Date.parse(`${MON}T21:30:00+02:00`), tours: { schedule: { days: ['Mo'], departAfter: '21:00', departUntil: '22:00' } } });
  const E = s.tourId;
  const A = await addRoute(s, { id: '8000105', name: 'Frankfurt Hbf' }, { days: ['Di'], departAfter: '04:20', departUntil: '05:20' });
  s.cur.incidents = [delayOf('e1', E)];
  assert.equal(await s.n.checkDevice(s.dev), 1); await s.n.takeOutbox(s.dev);
  s.cur.incidents = [delayOf('a1', A)];                                       // E's delay is over, A's begins
  atTime(s, '03:20'); assert.equal(await s.n.checkDevice(s.dev), 1); await s.n.takeOutbox(s.dev);
  for (const hm of ['03:21', '03:22', '03:23']) { atTime(s, hm); assert.equal(await s.n.checkDevice(s.dev), 0); }
  assert.deepEqual((await s.store.load(s.dev)).goneCount, {});                  // nothing counted during the night
  atTime(s, '04:00'); assert.equal(await s.n.checkDevice(s.dev), 0);          // morning: the first pass counts …
  atTime(s, '04:01'); assert.equal(await s.n.checkDevice(s.dev), 1);          // … the second clears E's notification
  assert.deepEqual((await s.n.takeOutbox(s.dev)).map((o) => [!!o.clear, o.tag]), [[true, 'inc|e1']]);
});

test('Night quiet: a late window pushes past 23:00 until ten minutes after its end, and not on days off', async () => {
  const s = await setup('rego-nq4-', { incidents: [], t: Date.parse(`${MON}T12:00:00+02:00`), tours: { schedule: { days: ['Mo'], departAfter: '22:30', departUntil: '23:30' } } });
  s.cur.incidents = [delayOf('l1', s.tourId)];
  const reset = () => s.store.update(s.dev, (p) => { p.notified = {}; p.shownDelay = {}; p.goneCount = {}; p.outbox = []; });
  atTime(s, '23:20', MON); assert.equal(await s.n.checkDevice(s.dev), 1);
  await reset(); atTime(s, '23:40', MON); assert.equal(await s.n.checkDevice(s.dev), 1);     // ten minutes after the end, still in
  await reset(); atTime(s, '23:41', MON); assert.equal(await s.n.checkDevice(s.dev), 0);
  await reset(); atTime(s, '23:20', TUE); assert.equal(await s.n.checkDevice(s.dev), 0);     // Tuesday is not a day of this route
});

import { createFcm } from '../server/fcm.mjs';
import { generateKeyPairSync } from 'node:crypto';
test('FCM: off without key, with key it sends a nudge and recognizes invalid tokens', async () => {
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
  assert.equal(calls.filter((u) => u.includes('oauth2')).length, 1);   // access token is reused
});
