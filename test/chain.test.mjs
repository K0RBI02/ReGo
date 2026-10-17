// New in 0.8.8: routes with transfers fall back to connections with up to two transfers when nothing with one is left (a closure forces a second change):
// chains of three trips – states, sections, map, incidents, preview when creating, interface (sample data).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildChainTour, previewChain, hasStart, chainsOf } from '../server/domain/chain.mjs';
import { buildTransferTour } from '../server/domain/transfer.mjs';
import { shortName } from '../server/domain/map.mjs';
import { createApp } from '../server/index.mjs';
import { config } from '../server/config.mjs';

const tmp = (n = 'rego-c-') => mkdtemp(join(tmpdir(), n));
const FS = { id: 'a1', name: 'Freising' }, MO = { id: 'a2', name: 'Moosach' }, OD = { id: 'a3', name: 'Odeonsplatz' }, NS = { id: 'a4', name: 'Neuperlach Süd' };
const NOW = Date.parse('2026-10-14T07:00:00+02:00');
const at = (hhmm) => `2026-10-14T${hhmm}:00+02:00`;
const add = (hhmm, m) => { const [h, mi] = hhmm.split(':').map(Number); const x = h * 60 + mi + m; return `${String(Math.floor(x / 60)).padStart(2, '0')}:${String(x % 60).padStart(2, '0')}`; };

/** One trip: dep = planned departure, mins = travel time; late = departure delay, arrLate = delay at the end (default: the same) */
const leg = (name, product, from, to, dep, mins, o = {}) => {
  const d = o.late || 0, a = o.arrLate ?? d;
  return { line: { name, product }, direction: to.name, origin: from, destination: to,
    plannedDep: at(dep), dep: at(add(dep, d)), depDelay: d, rt: o.rt ?? true, plannedArr: at(add(dep, mins)), arr: at(add(dep, mins + a)), arrDelay: a,
    plannedPlatform: '1', platform: o.platform ?? '1', plannedArrPlatform: '2', arrPlatform: '2',
    stopovers: o.stopovers || [from, to], remarks: o.remarks || [], cancelled: !!o.cancelled };
};
const S1 = (dep, o = {}) => leg('S1', 'suburban', FS, MO, dep, 27, { stopovers: [FS, { id: 'n', name: 'Neufahrn' }, { id: 'f', name: 'Feldmoching' }, MO], ...o });     // Freising → Moosach
const U3 = (dep, o = {}) => leg('U3', 'subway', MO, OD, dep, 14, o);                                                                                               // Moosach → Odeonsplatz
const U5 = (dep, o = {}) => leg('U5', 'subway', OD, NS, dep, 18, o);                                                                                               // Odeonsplatz → Neuperlach Süd
const chain = (...legs) => ({ legs });
// 07:02 → 07:29, U3 07:33 → 07:47, U5 07:51 → 08:09: four minutes at both transfers
const TRIPS = (a = {}, b = {}, c = {}) => [
  chain(S1('07:02', a), U3('07:33', b), U5('07:51', c)),
  chain(S1('07:22'), U3('07:53'), U5('08:11')),
  chain(S1('07:42'), U3('08:13'), U5('08:31')),
];
const tour = { id: 'tc1', name: 'Freising → Neuperlach Süd', from: FS, to: { id: 'a4', name: 'München, Neuperlach Süd' }, active: true, transfers: 1 };      // the route has the name the user picked; the trips name the stop shorter
const ctx = (o = {}) => ({ now: NOW, minDelay: 3, linesAt: async () => [], lines: {}, ...o });

// ---------- States ----------


test('Map names: the place before the comma goes ("München, Moosach" → "Moosach"), the usual names stay', () => {
  assert.equal(shortName('München, Moosach'), 'Moosach');
  assert.equal(shortName('Lindau (Bodensee), Lindau Hbf'), 'Lindau Hbf');
  assert.equal(shortName('München Hbf'), 'München Hbf');
  assert.equal(shortName('München-Feldmoching'), 'Feldmoching');
  assert.equal(shortName('Freising'), 'Freising');
});
test('Two transfers on time: three lines, two transfer rows, sections (trip – transfer – trip – transfer – trip) and map', async () => {
  const r = await buildChainTour(tour, TRIPS(), ctx());
  const t = r.tour;
  assert.equal(t.transfers, 1); assert.equal(t.changes, 2); assert.equal(t.via, 'Moosach › Odeonsplatz'); assert.deepEqual(t.lineIds, ['S1', 'U3', 'U5']);
  assert.deepEqual(r.incidents, []);
  assert.deepEqual(t.departures.map((d) => d.expectedTime), ['07:02', '07:22', '07:42']);
  const d = t.departures[0];
  assert.deepEqual(d.lineIds, ['S1', 'U3', 'U5']); assert.equal(d.arrTime, '08:09');
  assert.deepEqual(d.transfer, { station: 'Moosach › Odeonsplatz', minutes: 4, state: 'ok', text: '2 Umstiege · 4 und 4 Min.', count: 2 });
  assert.equal(t.view.kind, 'ok');                                                // without an incident the route shows the first departure
  const v = d.view;
  assert.equal(v.kind, 'ok'); assert.equal(v.head, 'Pünktlich · S1 › U3 › U5 ab 07:02'); assert.equal(v.big, 'pünktlich'); assert.equal(v.sub, 'Ankunft München, Neuperlach Süd 08:09 · 2 Umstiege');
  assert.deepEqual(v.sections.map((s) => s.type), ['leg', 'transfer', 'leg', 'transfer', 'leg']);
  assert.deepEqual(v.sections.filter((s) => s.type === 'leg').map((s) => [s.title, s.sub]), [
    ['Freising → Moosach', '1. Fahrt · 27 Min.'], ['Moosach → Odeonsplatz', '2. Fahrt · 14 Min.'], ['Odeonsplatz → München, Neuperlach Süd', '3. Fahrt · 18 Min.']]);
  assert.deepEqual(v.sections[1], { type: 'transfer', state: 'ok', label: 'Umstieg', title: 'Moosach', text: 'Gleis 2 → Gleis 1', minutes: 4 });
  assert.deepEqual(v.sections[3], { type: 'transfer', state: 'ok', label: 'Umstieg', title: 'Odeonsplatz', text: 'Gleis 2 → Gleis 1', minutes: 4 });
  assert.deepEqual(v.rows.map((x) => x.label), ['Abfahrt Freising', 'Ankunft Moosach', 'Abfahrt Moosach', 'Ankunft Odeonsplatz', 'Abfahrt Odeonsplatz', 'Ankunft München, Neuperlach Süd']);   // flat list for older UIs
  assert.equal(v.alternative.title, 'Danach'); assert.equal(v.alternative.line1, 'S1 › U3 › U5 ab 07:22'); assert.equal(v.alternative.line2, 'An München, Neuperlach Süd 08:29'); assert.equal(v.alternative.departure, 1);
  const m = v.map;
  assert.deepEqual(m.stations.map((s) => s.name), ['Freising', 'Neufahrn', 'Feldmoching', 'Moosach', 'Odeonsplatz', 'Neuperlach Süd']);
  assert.equal(m.hubIndex, 3); assert.deepEqual(m.legs, [{ lineId: 'S1', from: 0, to: 3 }, { lineId: 'U3', from: 3, to: 4 }, { lineId: 'U5', from: 4, to: 5 }]);
  assert.deepEqual(m.changes, [{ stationIndex: 3, label: 'Umstieg 4 Min. · Gleis 1', state: 'ok' }, { stationIndex: 4, label: 'Umstieg 4 Min. · Gleis 1', state: 'ok' }]);
  assert.deepEqual(m.transfer, m.changes[0]);
  assert.deepEqual(m.times, { dep: 'ab 07:02', arr: 'an 08:09', depLate: false, arrLate: false });
  assert.equal(m.haloIndex, -1); assert.equal(m.disrupted, null);
  assert.ok(r.tour.lineId === 'S1');
});

test('One transfer inside the answer: the same rules, like a route with one transfer; direct trips without a transfer row', async () => {
  const js = [chain(S1('07:02'), U3('07:33')), { legs: [S1('07:22')] }, chain(S1('07:42'), U3('08:13'), U5('08:31'))];
  const r = await buildChainTour(tour, js, ctx());
  const [a, b, c] = r.tour.departures;
  assert.deepEqual(a.lineIds, ['S1', 'U3']); assert.deepEqual(a.transfer, { station: 'Moosach', minutes: 4, state: 'ok', text: 'Umstieg Moosach · 4 Min.', count: 1 });
  assert.deepEqual(a.view.sections.map((s) => s.type), ['leg', 'transfer', 'leg']); assert.equal(a.view.sub, 'Ankunft München, Neuperlach Süd 07:47 · 1 Umstieg');
  assert.equal(a.view.map.legs.length, 2); assert.equal(a.view.map.changes.length, 1);
  assert.deepEqual(b.lineIds, ['S1']); assert.equal(b.transfer, undefined); assert.equal(b.arrTime, '07:49'); assert.equal(b.view.sections, undefined);
  assert.deepEqual(c.lineIds, ['S1', 'U3', 'U5']);
  assert.equal(r.tour.changes, 1); assert.equal(r.tour.via, 'Moosach');                                // the transfers most chains make; on a tie the first one
});

test('Connection at risk at the second transfer: delayed trip before it, the buffer under three minutes – incident with a stable ID, escalates to missed', async () => {
  const mk = (late) => [chain(S1('07:02'), U3('07:33', { late }), U5('07:51')), chain(S1('07:22'), U3('07:53'), U5('08:11'))];
  const r = await buildChainTour(tour, mk(1), ctx());
  assert.equal(r.tour.departures[0].transfer.state, 'ok');                       // 3 minutes are still fine (the threshold is under 3, and only for a late trip)
  const tight = await buildChainTour(tour, mk(2), ctx());
  const d = tight.tour.departures[0];
  assert.deepEqual(d.transfer, { station: 'Moosach › Odeonsplatz', minutes: 2, state: 'tight', text: 'Umstieg nur noch 2 Min.', count: 2 });
  assert.equal(d.view.kind, 'tight'); assert.equal(d.view.sub, 'Anschluss in Odeonsplatz wackelt'); assert.equal(d.view.big, '+2 Min.');
  assert.deepEqual(d.view.sections[3], { type: 'transfer', state: 'tight', label: 'Anschluss wackelt', title: 'Umstieg Odeonsplatz', text: 'U3 an 07:49 · U5 ab 07:51', minutes: 2 });
  assert.equal(d.view.map.changes[1].state, 'tight'); assert.equal(d.view.map.changes[1].label, 'Umstieg nur noch 2 Min.'); assert.equal(d.view.map.haloIndex, 4);
  assert.equal(tight.incidents.length, 1);
  const i = tight.incidents[0];
  assert.equal(i.kind, 'tight'); assert.equal(i.severity, 2); assert.equal(i.lineName, 'U5'); assert.equal(i.title, 'U5 Odeonsplatz → Neuperlach Süd');
  assert.equal(i.summary, 'Umstieg nur noch 2 Min. (U3 an 07:49, U5 ab 07:51)'); assert.equal(i.validity.until, '2026-10-14T07:51'); assert.equal(i.view, d.view);
  assert.equal(tight.tour.view, undefined);                                      // the incident stands for the route
  const later = await buildChainTour(tour, mk(2), ctx({ now: NOW + 60e3 }));
  assert.equal(later.incidents[0].id, i.id);                                     // the same situation a minute later: the same incident (no second push)
  const worse = await buildChainTour(tour, mk(5), ctx());
  assert.equal(worse.incidents[0].kind, 'missed'); assert.notEqual(worse.incidents[0].id, i.id);
  assert.equal(worse.tour.departures[0].transfer.text, 'Anschluss verpasst'); assert.equal(worse.tour.departures[0].transfer.state, 'missed');
  assert.equal(worse.tour.departures[0].view.kind, 'missed'); assert.equal(worse.tour.departures[0].view.big, 'Verpasst');
  assert.equal(worse.incidents[0].summary, 'U3 an 07:52, U5 07:51 weg');
});

test('A cancelled trip in the chain: "Anschluss fällt aus" for that transfer', async () => {
  const js = [chain(S1('07:02'), U3('07:33'), U5('07:51', { cancelled: true })), chain(S1('07:22'), U3('07:53'), U5('08:11'))];
  const r = await buildChainTour(tour, js, ctx());
  const d = r.tour.departures[0];
  assert.deepEqual(d.transfer, { station: 'Moosach › Odeonsplatz', minutes: 0, state: 'missed', text: 'Anschluss fällt aus', count: 2 });
  assert.equal(d.view.kind, 'missed'); assert.equal(d.view.big, 'Fällt aus'); assert.equal(d.view.sub, 'Anschluss in Odeonsplatz fällt aus');
  assert.equal(d.view.sections[3].label, 'Anschluss fällt aus'); assert.equal(d.view.sections[3].text, 'U5 ab 07:51 fällt aus');
  assert.equal(r.incidents[0].kind, 'missed'); assert.equal(r.incidents[0].summary, 'U5 ab 07:51 fällt aus');
  assert.equal(r.tour.departures[1].transfer.state, 'ok');
});

test('Replacement transport on the middle trip: the incident names the trip, the chain stays reachable, the map marks the section', async () => {
  const bus = { type: 'status', code: 'x', summary: 'Ersatzbusse', text: 'Wegen Bauarbeiten zwischen Moosach und Odeonsplatz Schienenersatzverkehr mit Bussen. Reisezeit verlängert sich um ca. 1 Minute.', validFrom: at('00:00'), validUntil: '2026-10-14T23:00:00+02:00' };
  const r = await buildChainTour(tour, TRIPS({}, { remarks: [bus] }), ctx());
  assert.equal(r.tour.departures[0].transfer.state, 'ok');
  const i = r.incidents.find((x) => x.kind === 'replacement');
  assert.ok(i); assert.equal(i.lineName, 'U3'); assert.equal(i.view.sub, 'U3 ab 07:33 · mit Ersatzverkehr · Anschluss bleibt erreichbar');
  assert.equal(i.view.sections[2].rows[1].sub, 'U3 · Ersatzbusse');                // the arrival row of that trip carries the note
  assert.ok(i.view.map.disrupted); assert.equal(i.view.map.legs.length, 3);
  assert.equal(r.incidents.filter((x) => x.kind === 'replacement').length, 1);     // once per text, not once per chain
  // Replacement transport that takes longer than the buffer: the source's times do not hold any more
  const long = { ...bus, text: bus.text.replace('ca. 1 Minute', 'ca. 25 Minuten') };
  const r2 = await buildChainTour(tour, TRIPS({}, { remarks: [long] }), ctx());
  assert.equal(r2.tour.departures[0].transfer.state, 'missed');
  assert.ok(r2.incidents.some((x) => x.kind === 'replacement' && /Anschluss verpasst$/.test(x.view.sub)));
  assert.ok(r2.incidents.some((x) => x.kind === 'missed'));
});

test('Delay: of the first trip ("Anschlüsse bleiben erreichbar"), of a later trip (its own wording); one delay incident', async () => {
  const first = await buildChainTour(tour, [chain(S1('07:02', { late: 6 }), U3('07:41'), U5('07:59')), chain(S1('07:22'), U3('07:53'), U5('08:11'))], ctx());
  const d = first.tour.departures[0];
  assert.equal(d.view.kind, 'delay'); assert.equal(d.view.head, 'Verspätung · S1 ab 07:08'); assert.equal(d.view.big, '+6 Min.'); assert.equal(d.view.sub, 'Anschlüsse bleiben erreichbar');
  assert.equal(d.view.map.haloIndex, 0); assert.deepEqual(d.view.map.times, { dep: 'ab 07:08', arr: 'an 08:17', depLate: true, arrLate: false });
  assert.equal(first.incidents.length, 1); assert.equal(first.incidents[0].kind, 'delay'); assert.equal(first.incidents[0].lineName, 'S1'); assert.equal(first.incidents[0].delayMin, 6);
  const later = await buildChainTour(tour, TRIPS({}, {}, { late: 5 }), ctx());
  const v = later.tour.departures[0].view;
  assert.equal(v.kind, 'delay'); assert.equal(v.head, 'Verspätung · U5 ab 07:56'); assert.equal(v.sub, 'Umstieg Odeonsplatz · Ankunft 08:14'); assert.equal(v.map.haloIndex, 4);
  assert.equal(later.incidents[0].lineName, 'U5');
});

test('The first trip is cancelled: cancellation incident, the chain does not appear in the list', async () => {
  const js = [chain(S1('07:02', { cancelled: true }), U3('07:33'), U5('07:51')), ...TRIPS().slice(1)];
  const r = await buildChainTour(tour, js, ctx());
  assert.deepEqual(r.tour.departures.map((d) => d.expectedTime), ['07:22', '07:42']);
  const c = r.incidents.find((x) => x.kind === 'cancelled');
  assert.ok(c); assert.equal(c.lineName, 'S1'); assert.equal(c.summary, 'Fahrt um 07:02 fällt aus'); assert.equal(c.view.sub, 'Stattdessen: S1 › U3 › U5 ab 07:22');
  assert.equal(r.tour.view, undefined);
});

test('Platform change at a transfer: its own, quiet incident (only shortly before departure)', async () => {
  const r = await buildChainTour(tour, TRIPS({}, { platform: '9' }), ctx());
  const p = r.incidents.find((x) => x.kind === 'platform');
  assert.ok(p); assert.equal(p.lineName, 'U3'); assert.equal(p.platform, '9'); assert.equal(p.summary, '07:33 in Moosach jetzt Gleis 9 statt Gleis 1');
  assert.equal(r.tour.departures[0].view.sections[1].text, 'Gleis 2 → Gleis 9');
});

test('Long wait at a transfer (planned over 30 min): only if there is nothing else', async () => {
  const long = chain(S1('07:02'), U3('07:33'), U5('08:31')), short = chain(S1('07:22'), U3('07:53'), U5('08:11'));        // 44 and 20 minutes at the last transfer
  const a = await buildChainTour(tour, [long, short], ctx());
  assert.deepEqual(a.tour.departures.map((d) => d.expectedTime), ['07:22']);
  const b = await buildChainTour(tour, [long], ctx());
  assert.deepEqual(b.tour.departures.map((d) => [d.expectedTime, d.transfer.minutes]), [['07:02', 4]]);
  assert.equal(b.tour.departures[0].transfer.text, '2 Umstiege · 4 und 44 Min.');
});

test('Several answers for the same first trip: the one that arrives first', async () => {
  const slow = chain(S1('07:02'), U3('07:33'), U5('08:11')), quick = chain(S1('07:02'), U3('07:33'), U5('07:51'));
  const r = await buildChainTour(tour, [slow, quick], ctx());
  assert.equal(r.tour.departures.length, 1); assert.equal(r.tour.departures[0].arrTime, '08:09');
});

test('No real-time data: "planmäßig" or neutral, as for every route', async () => {
  const js = [chain(S1('07:02', { rt: false }), U3('07:33'), U5('07:51'))];
  const r = await buildChainTour(tour, js, ctx());
  assert.equal(r.tour.departures[0].noRt, true); assert.equal(r.tour.departures[0].view.noRt, true);
  assert.equal(r.tour.departures[0].view.head.startsWith('Ohne Echtzeit'), true);
});

test('Nothing to show: honest texts for "no connection", "cancelled", "no data" – the text names the two transfers', async () => {
  const none = await buildChainTour(tour, [], ctx());
  assert.equal(none.tour.view.kind, 'none'); assert.equal(none.tour.view.big, 'Keine'); assert.equal(none.tour.view.sub, 'Keine Verbindung mit höchstens 2 Umstiegen gefunden.'); assert.deepEqual(none.tour.departures, []);
  const gone = await buildChainTour(tour, [chain(S1('06:30'), U3('07:00'), U5('07:20'))], ctx());       // has left already
  assert.equal(gone.tour.view.big, 'Keine');
  const cancelled = await buildChainTour(tour, [chain(S1('07:10', { cancelled: true }), U3('07:41'), U5('07:59'))], ctx());
  assert.equal(cancelled.tour.view.big, 'Fällt aus'); assert.ok(cancelled.incidents.some((x) => x.kind === 'cancelled'));
  const stale = await buildChainTour(tour, [], ctx({ stale: true }));
  assert.equal(stale.tour.view.big, 'Keine Daten');
  // the route with one transfer says "1 Umstieg" as before; with maxChanges 2 it names the two
  assert.equal((await buildTransferTour(tour, [], ctx())).tour.view.sub, 'Keine Verbindung mit höchstens 1 Umstieg gefunden.');
  assert.equal((await buildTransferTour(tour, [], ctx({ maxChanges: 2 }))).tour.view.sub, 'Keine Verbindung mit höchstens 2 Umstiegen gefunden.');
});

test('Commute time: before and during the window only the trips up to its end count', async () => {
  const win = { mode: 'now', endMs: Date.parse('2026-10-14T07:30:00+02:00'), from: '06:30', until: '07:30' };
  const r = await buildChainTour(tour, TRIPS(), ctx({ window: win }));
  assert.deepEqual(r.tour.departures.map((d) => d.expectedTime), ['07:02', '07:22']);
  assert.equal(r.tour.departures[1].view.alternative.line1, 'S1 › U3 › U5 ab 07:42');                    // "Danach" looks past the window
});

// ---------- Helpers ----------

test('Chains of the answer, "is there a trip to come", preview when creating', () => {
  const js = [chain(S1('06:30'), U3('06:50')), chain(S1('07:02'), U3('07:33'), U5('07:51')), { legs: [S1('07:22')] }, { legs: [S1('07:30'), U3('07:40'), U5('07:50'), U5('08:00')] }];
  assert.deepEqual(chainsOf(js).map((c) => c.length), [2, 3, 1]);                                          // four trips in a row are too many
  assert.equal(hasStart(js, NOW), true);
  assert.equal(hasStart([chain(S1('06:30'), U3('06:50'))], NOW), false);                                   // has left
  assert.equal(hasStart([chain(S1('06:59'), U3('07:20'))], NOW), true);                                    // a minute ago still counts, like on the route
  assert.equal(hasStart([chain(S1('07:02', { cancelled: true }), U3('07:33'))], NOW), false);
  assert.equal(hasStart(js, NOW, 2), true); assert.equal(hasStart([chain(S1('07:02'), U3('07:33'), U5('07:51'))], NOW, 2), false);
  const p = previewChain(TRIPS(), NOW);
  assert.equal(p.via, 'Moosach'); assert.equal(p.wait, 4); assert.equal(p.duration, '1 Std. 7 Min.');
  assert.deepEqual(p.changes, [{ via: 'Moosach', wait: 4 }, { via: 'Odeonsplatz', wait: 4 }]);
  assert.deepEqual(p.legs.map((l) => [l.line, l.lineId, l.title, l.times]), [
    ['S1', 'S1', 'Freising → Moosach', 'ab 07:02 · an 07:29'], ['U3', 'U3', 'Moosach → Odeonsplatz', 'ab 07:33 · an 07:47'], ['U5', 'U5', 'Odeonsplatz → Neuperlach Süd', 'ab 07:51 · an 08:09']]);
  assert.ok(p.legs.every((l) => /^#[0-9a-f]{6}$/i.test(l.color)));
  assert.equal(previewChain([], NOW), null);
  assert.equal(previewChain([chain(S1('07:02', { cancelled: true }), U3('07:33'), U5('07:51'))], NOW), null);
  assert.equal(previewChain([chain(S1('06:00'), U3('06:31'), U5('06:49'))], NOW), null);                    // has left
  const waits = previewChain([chain(S1('07:02'), U3('07:33'), U5('08:31')), chain(S1('07:22'), U3('07:53'), U5('08:11'))], NOW);
  assert.equal(waits.legs[0].times, 'ab 07:22 · an 07:49');                                                // the first with a reasonable wait
  const one = previewChain([chain(S1('07:02'), U3('07:33'))], NOW);
  assert.equal(one.legs.length, 2); assert.equal(one.changes, undefined); assert.equal(one.via, 'Moosach');
  assert.equal(previewChain([{ legs: [S1('07:02')] }], NOW).via, undefined);
});

// ---------- Interface (sample data) ----------

async function appOn(dir, cfg = {}, extra = {}) {
  const { server, store, service } = createApp({ cfg: { ...config, dataDir: dir, provider: 'mock', ...cfg }, ...extra });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { server, store, service, base: `http://127.0.0.1:${server.address().port}` };
}
const hdr = (dev) => ({ 'x-device': dev, 'content-type': 'application/json' });
const poster = (base, h) => async (p, b) => { const r = await fetch(`${base}${p}`, { method: 'POST', headers: h, body: JSON.stringify(b) }); return { status: r.status, body: await r.json() }; };
const MFS = { id: '8002078', name: 'Freising' }, MNS = { id: '8000908', name: 'München-Neuperlach Süd' }, MSZ = { id: '8100002', name: 'Salzburg Hbf' }, MPA = { id: '8000298', name: 'Passau Hbf' }, MWI = { id: '8100108', name: 'Wien Hbf' };

test('Sample data: a pair that needs two transfers is "found" with three trips; one transfer stays one transfer', async () => {
  const { server, base } = await appOn(await tmp(), {}, { now: () => Date.parse('2026-10-14T06:50:00+02:00') });
  const post = poster(base, hdr('zweiumstiege12345678'));
  try {
    let r = await post('/api/connections/search', { from: MFS, to: MNS });
    assert.equal(r.status, 200); assert.equal(r.body.direct, false); assert.equal(r.body.found, true); assert.equal(r.body.transfers, 2);
    assert.equal(r.body.maxTransfers, 2);                                              // what the search goes up to (the app words its hints with it)
    assert.deepEqual(r.body.route.legs.map((l) => l.line), ['S1', 'S4', 'U5']);
    assert.equal(r.body.route.via, 'München Hbf'); assert.equal(typeof r.body.route.wait, 'number');
    assert.deepEqual(r.body.route.changes.map((c) => c.via), ['München Hbf', 'München Ost']);
    assert.deepEqual(r.body.route.legs.map((l) => l.title), ['Freising → München Hbf', 'München Hbf → München Ost', 'München Ost → München-Neuperlach Süd']);
    r = await post('/api/connections/search', { from: MFS, to: MSZ });
    assert.equal(r.body.found, true); assert.equal(r.body.transfers, 1); assert.equal(r.body.route.legs.length, 2); assert.equal(r.body.route.changes, undefined);
    r = await post('/api/connections/search', { from: MPA, to: MWI });                 // not even with two transfers
    assert.equal(r.body.found, false); assert.equal(r.body.transfers, 1); assert.equal(r.body.maxTransfers, 2); assert.equal(r.body.route, undefined);
  } finally { server.close(); }
});

test('Sample data: create the route (also with the return trip), see the three trips in the state, the old pairs keep their view', async () => {
  const now = Date.parse('2026-10-14T06:50:00+02:00');
  const { server, base } = await appOn(await tmp(), {}, { now: () => now });
  const h = hdr('zweiumstiegezustand'), post = poster(base, h);
  try {
    let r = await post('/api/tours', { from: MFS, to: MNS });
    assert.equal(r.status, 422); assert.equal(r.body.code, 'no-direct');
    r = await post('/api/tours', { from: MPA, to: MWI, transfers: 1 });
    assert.equal(r.status, 422); assert.equal(r.body.code, 'no-connection'); assert.equal(r.body.error, 'Passau Hbf → Wien Hbf: Mit weniger als 3 Umstiegen nicht erreichbar.');
    r = await post('/api/tours', { from: MFS, to: MNS, roundTrip: true, transfers: 1 });
    assert.equal(r.status, 201); assert.deepEqual(r.body.tours.map((t) => t.transfers), [1, 1]);        // stays 1: the route says "with transfers", the state decides how many
    assert.equal((await post('/api/tours', { from: MFS, to: MSZ, transfers: 1 })).status, 201);
    assert.equal((await post('/api/tours', { from: MFS, to: MNS, transfers: 2 })).status, 400);       // the profile only knows 1
    const st = await (await fetch(`${base}/api/state`, { headers: h })).json();
    const out = st.tours.find((t) => t.name.startsWith('Freising →') && t.name.includes('Neuperlach') && !t.returnOf), back = st.tours.find((t) => t.returnOf);
    assert.equal(out.transfers, 1); assert.equal(out.changes, 2); assert.deepEqual(out.lineIds, ['S1', 'S4', 'U5']); assert.equal(out.via, 'München Hbf › München Ost');
    assert.equal(out.departures.length, 3);
    for (const d of out.departures) { assert.deepEqual(d.lineIds, ['S1', 'S4', 'U5']); assert.equal(d.transfer.count, 2); assert.equal(d.transfer.state, 'ok'); assert.match(d.transfer.text, /^2 Umstiege · \d+ und \d+ Min\.$/); assert.deepEqual(d.view.sections.map((s) => s.type), ['leg', 'transfer', 'leg', 'transfer', 'leg']); }
    assert.ok(st.lines.S1 && st.lines.S4 && st.lines.U5);                                              // all lines are in the registry (color, short name)
    assert.equal(out.departures[0].view.kind, 'delay');                                                // the first S1 is late in the sample data
    assert.equal(back.changes, 2); assert.deepEqual(back.lineIds, ['U5', 'S4', 'S1']);
    const salzburg = st.tours.find((t) => t.name.includes('Salzburg'));
    assert.equal(salzburg.changes, undefined); assert.deepEqual(salzburg.lineIds, ['S1', 'RE5']);        // with one transfer nothing changes
    for (const i of st.incidents) assert.ok(st.theme.kinds[i.kind], `Art ${i.kind} fehlt im Verzeichnis`);
    assert.ok(st.incidents.every((i) => st.tours.some((t) => t.id === i.tourId)));
  } finally { server.close(); }
});
