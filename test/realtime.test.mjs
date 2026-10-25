// Real-time truth: ReGo only says "pünktlich" (on time) where the source actually has real-time data for the trip.
// Without it the 0 minutes of delay mean "nothing known", not "on time": the wording turns into "planmäßig" and the app shows it neutral.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { normLeg } from '../server/providers/hafas.mjs';
import { parseLeg, parseJourneys } from '../server/providers/efa.mjs';
import { buildTour, okState, okView } from '../server/domain/state.mjs';
import { buildTransferTour } from '../server/domain/transfer.mjs';

const MH = { id: '8000261', name: 'München Hbf' }, SZ = { id: '8100002', name: 'Salzburg Hbf' }, FS = { id: '8002078', name: 'Fiktivia' };
const MON = '2026-10-12';
const ms = (hm) => Date.parse(`${MON}T${hm}:00+02:00`);
const iso = (hm) => `${MON}T${hm}:00+02:00`;
const add = (hhmm, m) => { const [h, mi] = hhmm.split(':').map(Number); const x = h * 60 + mi + m; return `${String(Math.floor(x / 60)).padStart(2, '0')}:${String(x % 60).padStart(2, '0')}`; };

// ---------- the sources say whether they know real time ----------

test('DB/ÖBB: a departure delay (even 0) is real-time data, a missing one is not', () => {
  const raw = (extra) => ({ line: { name: 'RE 5', product: 'regionalExpress' }, origin: { id: '1', name: 'A' }, destination: { id: '2', name: 'B' },
    plannedDeparture: iso('07:05'), departure: iso('07:05'), plannedArrival: iso('08:00'), arrival: iso('08:00'), ...extra });
  assert.equal(normLeg(raw({ departureDelay: 0 })).rt, true);                           // 0 s: the source says "on time"
  assert.equal(normLeg(raw({ departureDelay: 120 })).rt, true);
  assert.equal(normLeg(raw({ departureDelay: 120 })).depDelay, 2);
  assert.equal(normLeg(raw({ departureDelay: null })).rt, false);                       // null: nothing known
  assert.equal(normLeg(raw({})).rt, false);                                             // not even a field
  assert.equal(normLeg(raw({})).depDelay, 0);                                           // ... and the 0 minutes stay for everything that counts
});

test('MVV/MoBY (EFA): an estimated time or the status "monitored" is real-time data', () => {
  const trip = JSON.parse(readFileSync(new URL('./fixtures/efa-trip.json', import.meta.url), 'utf8'));
  assert.ok(parseJourneys(trip, 'mvv').every((j) => j.legs.every((l) => l.rt === true)));        // all trips of the recording are monitored
  const base = trip.journeys[0].legs[0];
  const leg = (patch = {}, origin = {}) => parseLeg({ ...base, ...patch, origin: { ...base.origin, ...origin } }, 'mvv');
  assert.equal(leg().rt, true);
  assert.equal(leg({ realtimeStatus: [] }).rt, true);                                              // the estimated time is enough
  assert.equal(leg({ realtimeStatus: ['MONITORED'] }, { departureTimeEstimated: undefined }).rt, true);   // "monitored" is enough
  assert.equal(leg({ realtimeStatus: [] }, { departureTimeEstimated: undefined }).rt, false);
  assert.equal(leg({ realtimeStatus: undefined }, { departureTimeEstimated: undefined }).rt, false);
  const none = leg({ realtimeStatus: ['OUTSIDE_REALTIME_WINDOW'] }, { departureTimeEstimated: undefined });
  assert.equal(none.rt, false); assert.equal(none.depDelay, 0);
  assert.equal(leg({ realtimeStatus: ['NOT_MONITORED'] }, { departureTimeEstimated: undefined }).rt, false);   // "not monitored" is not "monitored"
});

// ---------- word and look ----------

test('okState: "pünktlich" needs a near departure with real-time data; unknown real time is "unconfirmed" only when near', () => {
  const now = ms('06:30');
  const L = (hm, o = {}) => ({ dep: iso(hm), ...o });
  assert.deepEqual(okState(now, L('07:05')), { word: 'pünktlich', plan: false, unconfirmed: false });
  assert.deepEqual(okState(now, L('07:05', { rt: true })), { word: 'pünktlich', plan: false, unconfirmed: false });
  assert.deepEqual(okState(now, L('07:05', { rt: false })), { word: 'planmäßig', plan: true, unconfirmed: true });      // near, but no real time
  assert.deepEqual(okState(now, L('08:00', { rt: false })), { word: 'planmäßig', plan: true, unconfirmed: false });     // far away: nobody expects real time yet
  assert.deepEqual(okState(now, L('08:00')), { word: 'planmäßig', plan: true, unconfirmed: false });
  // transfer: one trip without real time is enough
  assert.equal(okState(now, L('07:05', { rt: true }), L('07:40', { rt: false })).unconfirmed, true);
  assert.equal(okState(now, L('07:05', { rt: true }), L('07:40', { rt: true })).unconfirmed, false);
  // texts
  assert.deepEqual(okView(okState(now, L('07:05')), 'RE 5 ab 07:05', 'RE 5 Richtung Salzburg'), { head: 'Pünktlich · RE 5 ab 07:05', big: 'pünktlich', sub: 'RE 5 Richtung Salzburg' });
  assert.deepEqual(okView(okState(now, L('07:05', { rt: false })), 'RE 5 ab 07:05', 'RE 5 Richtung Salzburg'),
    { head: 'Ohne Echtzeit · RE 5 ab 07:05', big: 'planmäßig', sub: 'RE 5 Richtung Salzburg · Verspätungen unbekannt', noRt: true });
  assert.deepEqual(okView(okState(now, L('08:00', { rt: false })), 'RE 5 ab 08:00', 'x'), { head: 'Planmäßig · RE 5 ab 08:00', big: 'planmäßig', sub: 'x' });
});

// ---------- direct trips ----------

const tour = { id: 't1', name: 'München Hbf → Salzburg Hbf', from: MH, to: SZ, active: true };
const leg = (dep, o = {}) => ({ line: { name: 'RE 5', product: 'regional' }, direction: 'Salzburg', origin: MH, destination: SZ,
  plannedDep: dep, dep, depDelay: 0, plannedArr: dep, arr: dep, arrDelay: 0, plannedPlatform: '13', platform: '13', stopovers: [], remarks: [], ...o });
const J = (...legs) => legs.map((l) => ({ legs: [l] }));
const ctx = (now, o = {}) => ({ now, minDelay: 3, linesAt: async () => [], lines: {}, ...o });

test('A near trip without real-time data is "planmäßig", marked "Ohne Echtzeit", and the app gets the neutral flag', async () => {
  const now = ms('06:45');                                                      // both trips are within 45 minutes
  const r = await buildTour(tour, J(leg(iso('07:05'), { rt: false }), leg(iso('07:25'), { rt: true })), ctx(now));
  const v = r.tour.view;
  assert.deepEqual(r.incidents, []);
  assert.equal(v.kind, 'ok');                                                   // old apps know nothing else and keep their look
  assert.equal(v.big, 'planmäßig'); assert.equal(v.head, 'Ohne Echtzeit · RE 5 ab 07:05');
  assert.equal(v.sub, 'RE 5 Richtung Salzburg · Verspätungen unbekannt'); assert.equal(v.noRt, true);
  const [d0, d1] = r.tour.departures;
  assert.equal(d0.far, true);                                                   // old apps show "planmäßig" in the row because of this
  assert.equal(d0.noRt, true);
  assert.ok(!('far' in d1)); assert.ok(!('noRt' in d1));                        // the next one is monitored: unchanged
  assert.equal(d0.view.big, 'planmäßig'); assert.equal(d0.view.head, 'Ohne Echtzeit · RE 5 ab 07:05'); assert.equal(d0.view.noRt, true);
  assert.equal(d1.view.big, 'pünktlich'); assert.equal(d1.view.head, 'Pünktlich · RE 5 ab 07:25'); assert.ok(!('noRt' in d1.view));
  assert.equal(v.alternative.badge, 'pünktlich');                               // "Danach" is monitored
});

test('"Danach" card and later trips follow their own real-time state', async () => {
  const now = ms('06:45');
  const r = await buildTour(tour, J(leg(iso('07:05'), { rt: true }), leg(iso('07:25'), { rt: false })), ctx(now));
  assert.equal(r.tour.view.big, 'pünktlich'); assert.ok(!('noRt' in r.tour.view));
  assert.equal(r.tour.view.alternative.badge, 'planmäßig');
});

test('Far away without real-time data is just "planmäßig" – nobody expects real time yet, so no warning', async () => {
  const now = ms('05:30');
  const r = await buildTour(tour, J(leg(iso('07:05'), { rt: false })), ctx(now));
  assert.equal(r.tour.view.big, 'planmäßig'); assert.equal(r.tour.view.head, 'Planmäßig · RE 5 ab 07:05');
  assert.equal(r.tour.view.sub, 'RE 5 Richtung Salzburg'); assert.ok(!('noRt' in r.tour.view));
  assert.equal(r.tour.departures[0].far, true); assert.ok(!('noRt' in r.tour.departures[0]));
});

test('Sources without the field (rt missing) behave as before: "pünktlich" when near', async () => {
  const now = ms('06:30');
  const r = await buildTour(tour, J(leg(iso('07:05'))), ctx(now));
  assert.equal(r.tour.view.big, 'pünktlich'); assert.equal(r.tour.view.head, 'Pünktlich · RE 5 ab 07:05');
  assert.ok(!('far' in r.tour.departures[0])); assert.ok(!('noRt' in r.tour.departures[0]));
});

test('A known delay is always named, whatever the flag says; a cancellation too', async () => {
  const now = ms('06:30');
  let r = await buildTour(tour, J(leg(iso('07:05'), { dep: iso('07:13'), depDelay: 8, rt: true })), ctx(now));
  assert.equal(r.incidents[0].view.kind, 'delay'); assert.equal(r.incidents[0].view.big, '+8 Min.'); assert.ok(!('noRt' in r.incidents[0].view));
  r = await buildTour(tour, J(leg(iso('07:05'), { cancelled: true, rt: false }), leg(iso('07:25'), { rt: true })), ctx(now));
  assert.equal(r.incidents.length, 1); assert.equal(r.incidents[0].view.kind, 'cancelled');
});

// ---------- trips with a transfer ----------

const FSS = { id: '8002078', name: 'Fiktivia' };
const S1 = (dep, o = {}) => ({ line: { name: 'S1', product: 'suburban' }, direction: 'Ostbahnhof', origin: FSS, destination: MH,
  plannedDep: iso(dep), dep: iso(dep), depDelay: 0, plannedArr: iso(add(dep, 35)), arr: iso(add(dep, 35)), arrDelay: 0,
  plannedPlatform: '3', platform: '3', plannedArrPlatform: '2', arrPlatform: '2',
  stopovers: [FSS, { id: 'a', name: 'Musterhof' }, { id: 'b', name: 'Feldmoching' }, MH], remarks: [], cancelled: false, ...o });
const RE = (dep, o = {}) => ({ line: { name: 'RE 5', product: 'regionalExpress' }, direction: 'Salzburg Hbf', origin: MH, destination: SZ,
  plannedDep: iso(dep), dep: iso(dep), depDelay: 0, plannedArr: iso(add(dep, 95)), arr: iso(add(dep, 95)), arrDelay: 0,
  plannedPlatform: '14', platform: '14', stopovers: [MH, { id: 'c', name: 'Rosenheim' }, SZ], remarks: [], cancelled: false, ...o });
const ttour = { id: 'tu1', name: 'Fiktivia → Salzburg Hbf', from: FSS, to: SZ, active: true, transfers: 1 };
const tctx = (o = {}) => ({ now: ms('06:30'), minDelay: 3, linesAt: async () => [], lines: {}, ...o });
const TJ = (a, b) => ({ legs: b ? [a, b] : [a] });
const bl = (...bs) => new Map([['münchen hbf', bs]]);

test('Transfer: "pünktlich" only if both trips have real-time data', async () => {
  const conns = bl(RE('07:16'), RE('07:46'), RE('08:16'));
  const trips = (rt1, rt2) => [TJ(S1('07:02', { rt: rt1 }), RE('07:46', { rt: rt2 })), TJ(S1('07:22', { rt: true }), RE('08:16', { rt: true }))];
  // both monitored
  let r = await buildTransferTour(ttour, trips(true, true), tctx({ bLists: conns }));
  assert.equal(r.tour.view.big, 'pünktlich'); assert.equal(r.tour.view.head, 'Pünktlich · S1 › RE 5 ab 07:02'); assert.ok(!('noRt' in r.tour.view));
  assert.ok(!('far' in r.tour.departures[0])); assert.ok(!('noRt' in r.tour.departures[0]));
  // first trip without real-time data
  r = await buildTransferTour(ttour, trips(false, true), tctx({ bLists: conns }));
  assert.equal(r.tour.view.big, 'planmäßig'); assert.equal(r.tour.view.head, 'Ohne Echtzeit · S1 › RE 5 ab 07:02'); assert.equal(r.tour.view.noRt, true);
  assert.equal(r.tour.view.sub, 'Ankunft Salzburg Hbf 09:21 · 1 Umstieg · Verspätungen unbekannt');
  assert.equal(r.tour.departures[0].far, true); assert.equal(r.tour.departures[0].noRt, true);
  assert.equal(r.tour.departures[0].view.noRt, true);
  assert.ok(!('noRt' in r.tour.departures[1]));
  // connection without real-time data
  r = await buildTransferTour(ttour, trips(true, false), tctx({ bLists: conns }));
  assert.equal(r.tour.view.big, 'planmäßig'); assert.equal(r.tour.view.noRt, true);
  assert.equal(r.tour.departures[0].noRt, true);
});

test('Transfer far away without real-time data: "planmäßig" without the warning', async () => {
  const conns = bl(RE('07:16'), RE('07:46'));
  const r = await buildTransferTour(ttour, [TJ(S1('07:02', { rt: false }), RE('07:46', { rt: false }))], tctx({ now: ms('05:00'), bLists: conns }));
  assert.equal(r.tour.view.big, 'planmäßig'); assert.equal(r.tour.view.head, 'Planmäßig · S1 › RE 5 ab 07:02'); assert.ok(!('noRt' in r.tour.view));
  assert.equal(r.tour.departures[0].far, true); assert.ok(!('noRt' in r.tour.departures[0]));
});

test('Transfer: a delay still wins over a missing flag', async () => {
  const conns = bl(RE('07:16'), RE('07:46'), RE('08:16'));
  const r = await buildTransferTour(ttour, [TJ(S1('07:02', { dep: iso('07:10'), depDelay: 8, arr: iso('07:45'), arrDelay: 8, rt: true }), RE('08:16', { rt: false }))], tctx({ bLists: conns }));
  assert.ok(r.incidents.length >= 1);
  assert.ok(r.incidents.every((i) => i.view.kind !== 'ok'));
});
