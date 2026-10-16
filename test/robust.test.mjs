// Error cases and edge conditions that came up during the big review (0.5.0).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TtlCache } from '../server/store/cache.mjs';
import { ProfileStore, ValidationError, addTours, replaceProfile, patchTour } from '../server/store/profile.mjs';
import { createNotifier, textFor } from '../server/notifier.mjs';
import { createService } from '../server/service.mjs';
import { buildTour } from '../server/domain/state.mjs';
import { createApp } from '../server/index.mjs';
import { config } from '../server/config.mjs';

const tmp = (n = 'rego-r-') => mkdtemp(join(tmpdir(), n));
const FS = { id: '8002078', name: 'Freising' }, MH = { id: '8000261', name: 'München Hbf' };

async function appOn(dir, cfg = {}) {
  const { server, store } = createApp({ cfg: { ...config, dataDir: dir, provider: 'mock', ...cfg } });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { server, store, base: `http://127.0.0.1:${server.address().port}` };
}
const hdr = (dev) => ({ 'x-device': dev, 'content-type': 'application/json' });

// ---------- Requests ----------

test('JSON "null", number or list instead of an object: 400 instead of a crash (500)', async () => {
  const { server, base } = await appOn(await tmp());
  const h = hdr('nulltestgeraet123456');
  try {
    for (const [method, path] of [['PUT', '/api/settings'], ['POST', '/api/transfer/claim'], ['PATCH', '/api/tours/tabc'], ['POST', '/api/tours'], ['PUT', '/api/profile']]) {
      for (const body of ['null', '5', '[]', '"x"']) {
        const r = await fetch(base + path, { method, headers: h, body });
        assert.equal(r.status, 400, `${method} ${path} ${body} -> ${r.status}`);
      }
    }
    assert.equal((await fetch(base + '/api/push/native', { method: 'PUT', headers: h, body: 'null' })).status, 200);   // native subscription path stays tolerant
  } finally { server.close(); }
});

test('Double tap: concurrent requests create the route only once', async () => {
  const { server, base } = await appOn(await tmp());
  const h = hdr('doppeltgeraet1234567');
  const body = JSON.stringify({ from: FS, to: MH, roundTrip: true, schedule: { days: ['Mo', 'Di'], departAfter: '07:00' }, returnAfter: '16:30' });
  try {
    const rs = await Promise.all([1, 2, 3].map(() => fetch(base + '/api/tours', { method: 'POST', headers: h, body })));
    assert.deepEqual(rs.map((r) => r.status), [201, 201, 201]);
    const p = await (await fetch(base + '/api/profile', { headers: h })).json();
    assert.equal(p.tours.length, 2);                                   // outward + return, once
    // another departure time is a new route
    await fetch(base + '/api/tours', { method: 'POST', headers: h, body: JSON.stringify({ from: FS, to: MH, schedule: { days: ['Mo', 'Di'], departAfter: '07:30' } }) });
    assert.equal((await (await fetch(base + '/api/profile', { headers: h })).json()).tours.length, 3);
  } finally { server.close(); }
});

test('Create route: checks and upper limit (outward + return counts twice)', () => {
  const p = { tours: [], settings: {} };
  assert.throws(() => addTours(p, { from: { id: 'x'.repeat(65), name: 'A' }, to: MH }), ValidationError);
  assert.throws(() => addTours(p, { from: { id: 'a\nb', name: 'A' }, to: MH }), ValidationError);
  assert.throws(() => addTours(p, { from: { id: '1', name: 'A'.repeat(121) }, to: MH }), ValidationError);
  const [t] = addTours(p, { from: { ...FS, lat: 999, lon: 11 }, to: { ...MH, lat: 48.14, lon: 11.56 }, schedule: { days: ['Fr', 'Mo', 'Mo', 'xx'], departAfter: '06:45' } });
  assert.equal(t.from.lat, undefined);                                  // invalid coordinate is discarded
  assert.equal(t.to.lat, 48.14);
  assert.deepEqual(t.schedule.days, ['Mo', 'Fr']);                      // without duplicates, in weekday order
  const q = { tours: Array.from({ length: 19 }, (_, i) => ({ id: `t${i}`, from: { id: `a${i}` }, to: { id: `b${i}` }, schedule: {} })), settings: {} };
  assert.throws(() => addTours(q, { from: FS, to: MH, roundTrip: true }), /Maximal 20/);
  assert.equal(addTours(q, { from: FS, to: MH }).length, 1);
  assert.throws(() => patchTour(q, 'nope', {}), (e) => e.status === 404);
});

test('Undo: coordinates stay, settings and subscription stay untouched, loose links drop out', () => {
  const p = { tours: [], settings: { pushThresholdMin: 10, delayGraceMin: 10 }, push: { native: true } };
  const before = { tours: [{ id: 'tA', name: 'x', from: { ...FS, lat: 48.4, lon: 11.74 }, to: MH, active: false, schedule: { days: ['Mo'], departAfter: '07:00' }, returnId: 'tB', returnOf: 'tZ' }], settings: { pushThresholdMin: 3 } };
  replaceProfile(p, before);
  assert.equal(p.tours[0].from.lat, 48.4);
  assert.equal(p.tours[0].active, false);
  assert.equal(p.tours[0].returnId, undefined); assert.equal(p.tours[0].returnOf, undefined);   // tB/tZ do not exist
  assert.equal(p.settings.pushThresholdMin, 10); assert.deepEqual(p.push, { native: true });
  assert.throws(() => replaceProfile(p, { tours: [{ id: '../x', from: FS, to: MH }] }), ValidationError);
});

// ---------- Speicher ----------

test('A damaged profile is set aside, the device works again afterwards', async () => {
  const dir = await tmp();
  const store = new ProfileStore(dir);
  const dev = 'kaputtgeraet12345678';
  await store.update(dev, (p) => { addTours(p, { from: FS, to: MH }); });
  await writeFile(join(dir, 'profiles', `${dev}.json`), '{"tours": [');      // abgeschnitten
  const p = await store.load(dev);
  assert.deepEqual(p.tours, []);
  assert.ok((await readdir(join(dir, 'profiles'))).some((f) => f.startsWith(`${dev}.json.corrupt-`)));
  await store.update(dev, (x) => { addTours(x, { from: FS, to: MH }); });       // writing works again
  assert.equal((await store.load(dev)).tours.length, 1);
  await writeFile(join(dir, 'profiles', `${dev}.json`), 'null');
  assert.deepEqual((await store.load(dev)).tours, []);
});

test('Older profiles get missing settings added', async () => {
  const dir = await tmp(); const { mkdir } = await import('node:fs/promises');
  await mkdir(join(dir, 'profiles'), { recursive: true });
  await writeFile(join(dir, 'profiles', 'altesprofil1234567.json'), JSON.stringify({ tours: [], settings: { pushThresholdMin: 3 } }));
  const p = await new ProfileStore(dir).load('altesprofil1234567');
  assert.equal(p.settings.pushThresholdMin, 3);
  assert.equal(p.settings.delayGraceMin, 10);                           // otherwise delays would be invisible (NaN)
});

test('"Last seen": is set, but does not create a profile; upper limit for profiles', async () => {
  const dir = await tmp(); let t = Date.parse('2026-10-14T10:00:00Z');
  const store = new ProfileStore(dir, () => t, { maxProfiles: 2 });
  await store.seen('niegesehen12345678');
  assert.equal((await readdir(join(dir, 'profiles')).catch(() => [])).length, 0);
  await store.update('geraet-eins-123456', (p) => { p.lastSeen = 5; });
  t += 3 * 3600e3; await store.seen('geraet-eins-123456');
  assert.equal((await store.load('geraet-eins-123456')).lastSeen, t);
  await store.update('geraet-zwei-123456', () => {});
  await assert.rejects(store.update('geraet-drei-123456', () => {}), (e) => e.status === 503);
  await store.update('geraet-eins-123456', () => {});                    // existing ones keep working
  await store.remove('geraet-zwei-123456');
  await store.update('geraet-drei-123456', () => {});                    // room is free again
});

test('Cache: leave alone briefly after an error, do not show values that are too old, limited size', async () => {
  let t = 0; const c = new TtlCache(() => t, { max: 3, backoffSec: 10 });
  let calls = 0, fail = false;
  const load = async () => { calls++; if (fail) throw new Error('down'); return calls; };
  await c.get('k', 5, load);
  t = 6000; fail = true;
  const a = await c.get('k', 5, load, { maxStaleSec: 60 });
  assert.equal(a.stale, true); assert.equal(calls, 2);
  t = 9000;
  const b = await c.get('k', 5, load, { maxStaleSec: 60 });             // within the pause: no new request
  assert.equal(b.stale, true); assert.equal(calls, 2);
  t = 17000; fail = false;
  assert.equal((await c.get('k', 5, load, { maxStaleSec: 60 })).stale, false); assert.equal(calls, 3);
  // without an old value: error immediately from the remembered failure, do not wait again
  const d = await new TtlCache(() => t, { backoffSec: 10 });
  let n = 0; const boom = async () => { n++; throw new Error('weg'); };
  await assert.rejects(d.get('x', 5, boom)); await assert.rejects(d.get('x', 5, boom)); assert.equal(n, 1);
  // a value that is too old is no longer shown as a substitute
  t = 1e6; const e = new TtlCache(() => t); await e.get('y', 5, async () => 1); t = 1e6 + 3600e3;
  await assert.rejects(e.get('y', 5, async () => { throw new Error('x'); }, { maxStaleSec: 1800 }));
  // Obergrenze
  for (const k of ['a', 'b', 'c', 'd', 'e']) await c.get(k, 5, async () => k);
  assert.ok(c.map.size <= 3); assert.ok(!c.peek('a')); assert.ok(c.peek('e'));
});

// ---------- Fachlogik ----------

const leg = (dep, o = {}) => ({ line: { name: 'RE 5', product: 'regional' }, direction: 'Salzburg', origin: { id: '8000261', name: 'München Hbf' }, destination: { id: '8100002', name: 'Salzburg Hbf' },
  plannedDep: dep, dep, depDelay: 0, plannedArr: dep, arr: dep, arrDelay: 0, plannedPlatform: '13', platform: '13', stopovers: [], remarks: [], ...o });

test('Incident: train with a space in its name ("RE 5", "S 1") and the same train on another day', async () => {
  const tour = { id: 't1', name: 'x', from: MH, to: { id: '8100002', name: 'Salzburg Hbf' }, active: true };
  const delayed = (iso, min) => ({ legs: [leg(iso, { dep: new Date(Date.parse(iso) + min * 60000).toISOString(), depDelay: min })] });
  const ctx = (now) => ({ now, minDelay: 3, linesAt: async () => [], lines: {} });
  const mon = await buildTour(tour, [delayed('2026-10-12T07:20:00+02:00', 8)], ctx(Date.parse('2026-10-12T07:00:00+02:00')));
  const tue = await buildTour(tour, [delayed('2026-10-13T07:20:00+02:00', 8)], ctx(Date.parse('2026-10-13T07:00:00+02:00')));
  const i = mon.incidents[0];
  assert.equal(i.lineName, 'RE 5');
  assert.notEqual(i.id, tue.incidents[0].id);                            // same train, other day = new incident
  assert.deepEqual(textFor(i), { title: 'RE 5 +8 Min.', body: `München Hbf → Salzburg Hbf · ${i.summary}` });
  assert.equal(textFor({ ...i, kind: 'replacement' }).title, 'Ersatzverkehr · RE 5');
  assert.equal(textFor({ kind: 'delay', delayMin: 4, title: 'S1 A → B', summary: 'x' }).title, 'S1 +4 Min.');   // old incidents without lineName
});

test('Source hangs or is down: route waits at most the deadline, old trips are marked, too old ones disappear', async () => {
  const dir = await tmp(); let t = Date.parse('2026-10-14T07:00:00+02:00'); const now = () => t;
  const store = new ProfileStore(dir, now); const dev = 'fristgeraet12345678';
  await store.update(dev, (p) => { addTours(p, { from: MH, to: { id: '8100002', name: 'Salzburg Hbf' } }); });
  let mode = 'ok';
  const client = { journeys: async () => { if (mode === 'hang') return new Promise(() => {}); if (mode === 'down') throw new Error('down'); return [{ legs: [leg('2026-10-14T07:20:00+02:00')] }]; }, stop: async () => ({ lines: [], lat: 48.14, lon: 11.56 }) };
  const providers = { forTour: () => client, forStop: () => client, searchStops: async () => [] };
  const service = createService({ config: { ...config, tourDeadlineMs: 80 }, store, now, providers });
  let s = await service.getState(dev);
  assert.equal(s.connection.status, 'ok'); assert.ok(!s.tours[0].stale); assert.equal(s.tours[0].departures.length, 1);
  t += 40e3; mode = 'hang';
  const t0 = Date.now(); s = await service.getState(dev);
  assert.ok(Date.now() - t0 < 2000, 'wartet nicht ewig');
  assert.equal(s.tours[0].stale, true); assert.equal(s.connection.status, 'error'); assert.equal(s.tours[0].departures.length, 1);
  // Source completely down, cache older than 30 minutes: show nothing old any more
  const s2 = createService({ config: { ...config, tourDeadlineMs: 80 }, store, now, providers: { ...providers, forTour: () => ({ ...client, journeys: async () => { if (mode === 'down') throw new Error('down'); return [{ legs: [leg('2026-10-14T08:20:00+02:00')] }]; } }) } });
  mode = 'ok'; await s2.getState(dev);
  t += 20 * 60e3; mode = 'down'; assert.equal((await s2.getState(dev)).tours[0].departures.length, 1);       // 20 min old: ok
  t += 20 * 60e3; const late = await s2.getState(dev);                                                         // 40 min old: too old
  assert.equal(late.tours[0].departures.length, 0); assert.equal(late.tours[0].stale, true);
  assert.equal(late.tours[0].view.kind, 'none'); assert.equal(late.tours[0].view.big, 'Keine Daten');          // honest instead of "pünktlich"
});

test('Route without a departure: own view "none", never "pünktlich" (no direct connection, cancellation, no data)', async () => {
  const tour = { id: 't1', name: 'München Hbf → Salzburg Hbf', from: MH, to: { id: '8100002', name: 'Salzburg Hbf' }, active: true };
  const now = Date.parse('2026-10-14T07:00:00+02:00');
  const ctx = (o = {}) => ({ now, minDelay: 3, linesAt: async () => [], lines: {}, ...o });
  // 1) Source answers, but there is no trip without a transfer
  let r = await buildTour(tour, [], ctx());
  assert.deepEqual(r.incidents, []);
  assert.equal(r.tour.lineId, ''); assert.deepEqual(r.tour.departures, []);
  assert.equal(r.tour.view.kind, 'none'); assert.equal(r.tour.view.big, 'Keine'); assert.match(r.tour.view.sub, /Direktverbindung/);
  assert.deepEqual(r.tour.view.rows, []); assert.equal(r.tour.view.alternative, null); assert.equal(r.tour.view.ticketHint, null);
  // the map shows start and destination with a dotted line so that the detail page is not empty
  assert.deepEqual(r.tour.view.map.stations.map((x) => x.name), ['München Hbf', 'Salzburg Hbf']);
  assert.deepEqual(r.tour.view.map.disrupted, { from: 0, to: 1 }); assert.deepEqual(r.tour.view.map.connections, []);
  // 2) all next trips are cancelled
  r = await buildTour(tour, [{ legs: [leg('2026-10-14T07:20:00+02:00', { cancelled: true })] }], ctx());
  assert.equal(r.tour.view.big, 'Fällt aus'); assert.deepEqual(r.tour.departures, []);
  // 3) old data (source disturbed): "Keine Daten" takes precedence
  r = await buildTour(tour, [], ctx({ stale: true }));
  assert.equal(r.tour.view.big, 'Keine Daten'); assert.match(r.tour.view.sub, /antwortet gerade nicht/);
  // 4) with a departure there is still the "pünktlich" view
  r = await buildTour(tour, [{ legs: [leg('2026-10-14T07:20:00+02:00')] }], ctx());
  assert.equal(r.tour.view.kind, 'ok');
  // The color of the view is part of the state
  const { THEME } = await import('../server/domain/state.mjs');
  assert.ok(THEME.kinds.none.bg && THEME.kinds.none.icon.length === 2);
});

test('API (sample data): an existing route without a direct connection stays in the list and has a view', async () => {
  const { server, store, base } = await appOn(await tmp());
  const h = hdr('leergeraet1234567890');
  try {
    const find = async (q) => (await (await fetch(`${base}/api/stations?q=${encodeURIComponent(q)}`, { headers: h })).json()).stations[0];
    const [fs, sa, muc] = [await find('Freising'), await find('Salzburg'), await find('München Hbf')];
    // Creating anew has not been possible since 0.6.0 (422). Routes from older versions or after a timetable change still exist, though.
    assert.equal((await fetch(`${base}/api/tours`, { method: 'POST', headers: h, body: JSON.stringify({ from: fs, to: sa }) })).status, 422);
    await store.update('leergeraet1234567890', (p) => { addTours(p, { from: fs, to: sa }); });
    await fetch(`${base}/api/tours`, { method: 'POST', headers: h, body: JSON.stringify({ from: fs, to: muc }) });
    const s = await (await fetch(`${base}/api/state`, { headers: h })).json();
    assert.equal(s.tours.length, 2);
    const empty = s.tours.find((t) => t.name.includes('Salzburg')), full = s.tours.find((t) => t.name.includes('München'));
    assert.equal(empty.departures.length, 0); assert.equal(empty.view.kind, 'none'); assert.equal(empty.view.big, 'Keine');
    assert.ok(full.departures.length > 0); assert.notEqual(full.view?.kind, 'none');
    assert.equal(s.connection.status, 'ok');                       // a route without a direct connection is no disruption
  } finally { server.close(); }
});

// ---------- Push ----------

const COMMUTE = { days: ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'], departAfter: '11:30', departUntil: '12:30' };      // commute time around the test clock (12:00): push is allowed
const incident = (o = {}) => ({ id: 'a1', tourId: 'T', kind: 'delay', delayMin: 7, title: 'RE 5 München Hbf → Salzburg Hbf', lineName: 'RE 5', summary: 'x', validity: { activeNow: true }, ...o });
async function notifierFor(state, { push = { native: true, fcm: 'fcm-token-0123456789abcdef' }, lastSeen, t = Date.parse('2026-10-12T12:00:00+02:00'), tours } = {}) {
  const dir = await tmp('rego-pn-'); const clock = { t }; const now = () => clock.t;
  const store = new ProfileStore(dir, now); const dev = 'pushgeraet123456789';
  await store.update(dev, (p) => { p.tours = tours || [{ id: 'T', name: 'x', from: MH, to: FS, active: true, schedule: COMMUTE }, { id: 'U', name: 'y', from: FS, to: MH, active: true, schedule: COMMUTE }]; p.push = push; if (lastSeen !== undefined) p.lastSeen = lastSeen; });
  const sent = [];
  const n = createNotifier({ config: { ...config, dataDir: dir }, store, service: { getState: async () => state.current() }, now, fcm: { enabled: true, send: async () => { sent.push(1); return 'ok'; } } });
  return { n, store, dev, clock, sent };
}

test('Push: a route without fresh data does not block the others and deletes nothing', async () => {
  const st = { incidents: [incident({ id: 'a1', tourId: 'T' })], tours: [{ id: 'T' }, { id: 'U' }], current() { return { connection: { status: 'ok' }, incidents: this.incidents, tours: this.tours }; } };
  const { n, store, dev } = await notifierFor(st);
  assert.equal(await n.checkDevice(dev), 1);
  // Route T is disturbed now (old data, incident apparently gone), U reports something new
  st.tours = [{ id: 'T', stale: true }, { id: 'U' }]; st.incidents = [incident({ id: 'b2', tourId: 'U' })];
  for (let k = 0; k < 3; k++) await n.checkDevice(dev);
  let out = await n.takeOutbox(dev);
  assert.ok(out.some((o) => o.tag === 'inc|b2'), 'Meldung der gesunden Strecke kommt an');
  assert.ok(!out.some((o) => o.clear), 'Meldung der gestörten Strecke wird nicht fälschlich entfernt');
  assert.ok((await store.load(dev)).notified.a1);
  // Incidents from old data of a disturbed route do not report anything new either
  st.incidents = [incident({ id: 'c3', tourId: 'T' })];
  await n.checkDevice(dev); out = await n.takeOutbox(dev);
  assert.ok(!out.some((o) => o.tag === 'inc|c3'));
});

test('Push: app devices without a sign of life are no longer checked, old web-push subscriptions skipped', async () => {
  const st = { current: () => ({ connection: { status: 'ok' }, incidents: [incident()], tours: [{ id: 'T' }] }) };
  const t = Date.parse('2026-10-12T12:00:00+02:00');
  const idle = t - 30 * 864e5;
  const a = await notifierFor(st, { push: { native: true }, lastSeen: idle, t });
  assert.equal(await a.n.checkDevice(a.dev), 0);                         // app silent for 30 days: skipped
  await a.store.update(a.dev, (p) => { p.lastSeen = t - 3600e3; });
  assert.equal(await a.n.checkDevice(a.dev), 1);                         // reports in again: checked
  // There is no web push any more: a profile from the old days is not checked (otherwise the server would query the sources forever for a dead subscription)
  const w = await notifierFor(st, { push: { endpoint: 'https://fcm.googleapis.com/fcm/send/w' }, t });
  assert.equal(await w.n.checkDevice(w.dev), 0);
});

test('Push: a long construction site is not reported anew every 3 days', async () => {
  const construction = incident({ id: 'bau', kind: 'construction', delayMin: 0 });
  const st = { incidents: [construction], current() { return { connection: { status: 'ok' }, incidents: this.incidents, tours: [{ id: 'T' }] }; } };
  const { n, dev, clock, sent } = await notifierFor(st);
  assert.equal(await n.checkDevice(dev), 1);
  for (const d of [1, 2, 3]) { clock.t += 24 * 3600e3; assert.equal(await n.checkDevice(dev), 0, `Tag ${d}`); }
  clock.t += 24 * 3600e3;                                                // day 4: another incident triggers a write (clean-up of the remembered list)
  st.incidents = [construction, incident({ id: 'x2' })];
  assert.equal(await n.checkDevice(dev), 1);
  assert.equal(await n.checkDevice(dev), 0, 'Baustelle nicht erneut melden');
  assert.equal(sent.length, 2);
});

test('Push: two passes at the same time do not run into each other', async () => {
  let running = 0, peak = 0;
  const st = { current: async () => { running++; peak = Math.max(peak, running); await new Promise((r) => setTimeout(r, 60)); running--; return { connection: { status: 'ok' }, incidents: [], tours: [] }; } };
  const { n } = await notifierFor(st);
  await Promise.all([n.tick(), n.tick(), n.tick()]);
  assert.equal(peak, 1);
});
