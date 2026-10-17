// New in 0.7.0: trips with one transfer ("Mit 1 Umstieg suchen"): connection on time / at risk / missed, replacement transport,
// cancelled connection, search and creation through the interface, push texts.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildTransferTour, previewRoute, transferVias } from '../server/domain/transfer.mjs';
import { addTours, replaceProfile, ValidationError } from '../server/store/profile.mjs';
import { relevant, textFor, changeOf } from '../server/notifier.mjs';
import { createApp } from '../server/index.mjs';
import { config } from '../server/config.mjs';

const tmp = (n = 'rego-x-') => mkdtemp(join(tmpdir(), n));
const FS = { id: '8002078', name: 'Freising' }, MH = { id: '8000261', name: 'München Hbf' }, SZ = { id: '8100002', name: 'Salzburg Hbf' };
const MO = { id: '8000902', name: 'Moosach' }, PA = { id: '8000298', name: 'Passau Hbf' }, WI = { id: '8100108', name: 'Wien Hbf' };
const NOW = Date.parse('2026-10-14T07:00:00+02:00');
const at = (hhmm) => `2026-10-14T${hhmm}:00+02:00`;
const add = (hhmm, m) => { const [h, mi] = hhmm.split(':').map(Number); const x = h * 60 + mi + m; return `${String(Math.floor(x / 60)).padStart(2, '0')}:${String(x % 60).padStart(2, '0')}`; };

// Feeder: S1 Freising → München Hbf (35 min); connection: RE 5 München Hbf → Salzburg Hbf (95 min)
const S1 = (dep, o = {}) => {
  const d = o.late || 0, arrLate = o.arrLate ?? d;
  return { line: { name: 'S1', product: 'suburban' }, direction: 'Ostbahnhof', origin: FS, destination: MH,
    plannedDep: at(dep), dep: at(add(dep, d)), depDelay: d, plannedArr: at(add(dep, 35)), arr: at(add(dep, 35 + arrLate)), arrDelay: arrLate,
    plannedPlatform: '3', platform: o.platform ?? '3', plannedArrPlatform: '2', arrPlatform: '2',
    stopovers: [FS, { id: 'a', name: 'Neufahrn' }, { id: 'b', name: 'Feldmoching' }, MO, MH], remarks: o.remarks || [], cancelled: !!o.cancelled };
};
const RE = (dep, o = {}) => {
  const d = o.late || 0;
  return { line: { name: 'RE 5', product: 'regionalExpress' }, direction: 'Salzburg Hbf', origin: MH, destination: SZ,
    plannedDep: at(dep), dep: at(add(dep, d)), depDelay: d, plannedArr: at(add(dep, 95)), arr: at(add(dep, 95 + d)), arrDelay: d,
    plannedPlatform: '14', platform: '14', stopovers: [MH, { id: 'c', name: 'Rosenheim' }, { id: 'd', name: 'Prien' }, { id: 'e', name: 'Traunstein' }, SZ],
    remarks: o.remarks || [], cancelled: !!o.cancelled };
};
const tour = { id: 'tu1', name: 'Freising → Salzburg Hbf', from: FS, to: SZ, active: true, transfers: 1 };
const ctx = (o = {}) => ({ now: NOW, minDelay: 3, linesAt: async () => [], lines: {}, ...o });
const J = (a, b) => ({ legs: b ? [a, b] : [a] });
const bl = (...bs) => new Map([['münchen hbf', bs]]);
const CONNECTIONS = bl(RE('07:16'), RE('07:46'), RE('08:16'), RE('08:46'));
const TRIPS = (a1 = {}) => [J(S1('07:02', a1), RE('07:46')), J(S1('07:22'), RE('08:16')), J(S1('07:42'), RE('08:46'))];
// The source's combined search already suggests the later connection for a delayed feeder (RE 08:16)
const LATE_TRIPS = (a1) => [J(S1('07:02', a1), RE('08:16')), J(S1('07:22'), RE('08:16')), J(S1('07:42'), RE('08:46'))];

// ---------- States ----------

test('Transfer on time: two lines, transfer row, sections (trip – transfer – trip) and map', async () => {
  const r = await buildTransferTour(tour, TRIPS(), ctx({ bLists: CONNECTIONS }));
  assert.equal(r.tour.transfers, 1); assert.equal(r.tour.via, 'München Hbf'); assert.deepEqual(r.tour.lineIds, ['S1', 'RE5']);
  assert.deepEqual(r.incidents, []);
  assert.deepEqual(r.tour.departures.map((d) => d.expectedTime), ['07:02', '07:22', '07:42']);
  assert.deepEqual(r.tour.departures.map((d) => d.transfer.minutes), [9, 19, 29]);
  const d = r.tour.departures[0];
  assert.deepEqual(d.lineIds, ['S1', 'RE5']); assert.equal(d.arrTime, '09:21');
  assert.deepEqual(d.transfer, { station: 'München Hbf', minutes: 9, state: 'ok', text: 'Umstieg München Hbf · 9 Min.' });
  assert.equal(r.tour.view.kind, 'ok');                                  // without an incident the route shows the first departure
  const v = d.view;
  assert.equal(v.kind, 'ok'); assert.equal(v.big, 'pünktlich'); assert.equal(v.sub, 'Ankunft Salzburg Hbf 09:21 · 1 Umstieg');
  assert.deepEqual(v.sections.map((s) => s.type), ['leg', 'transfer', 'leg']);
  assert.deepEqual(v.sections[1], { type: 'transfer', state: 'ok', label: 'Umstieg', title: 'München Hbf', text: 'Gleis 2 → Gleis 14', minutes: 9 });
  assert.equal(v.sections[0].title, 'Freising → München Hbf'); assert.equal(v.sections[0].sub, '1. Fahrt · 35 Min.');
  assert.equal(v.sections[2].title, 'München Hbf → Salzburg Hbf'); assert.equal(v.sections[2].sub, '2. Fahrt · 1 Std. 35 Min.');
  assert.deepEqual(v.rows.map((x) => x.label), ['Abfahrt Freising', 'Ankunft München Hbf', 'Abfahrt München Hbf', 'Ankunft Salzburg Hbf']);   // flat list for older UIs
  assert.equal(v.alternative.title, 'Danach'); assert.match(v.alternative.line1, /S1 › RE 5 ab 07:22/);
  const m = v.map;
  assert.deepEqual(m.stations.map((s) => s.name), ['Freising', 'Neufahrn', 'Feldmoching', 'München Hbf', 'Rosenheim', 'Prien', 'Salzburg Hbf']);
  assert.equal(m.hubIndex, 3); assert.deepEqual(m.legs, [{ lineId: 'S1', from: 0, to: 3 }, { lineId: 'RE5', from: 3, to: 6 }]);
  assert.deepEqual(m.transfer, { stationIndex: 3, label: 'Umstieg 9 Min. · Gleis 14', state: 'ok' });
  assert.deepEqual(m.times, { dep: 'ab 07:02', arr: 'an 09:21', depLate: false, arrLate: false });
  assert.equal(m.haloIndex, -1); assert.equal(m.disrupted, null);
  assert.ok(r.tour.lineId && r.tour.lines === undefined);
});

test('Tight but on time: no alarm ("wackelt" only exists for a delayed feeder)', async () => {
  const r = await buildTransferTour(tour, [J(S1('07:02'), RE('07:39')), J(S1('07:22'), RE('08:16'))], ctx({ bLists: bl(RE('07:39'), RE('08:16')) }));
  assert.equal(r.tour.departures[0].transfer.state, 'ok'); assert.equal(r.tour.departures[0].transfer.minutes, 2);
  assert.deepEqual(r.incidents, []);
});

test('Connection at risk: feeder delayed, only 1 minute of buffer left – incident, follow-up connection, stable ID', async () => {
  const r = await buildTransferTour(tour, LATE_TRIPS({ late: 8 }), ctx({ bLists: CONNECTIONS }));
  const d = r.tour.departures[0];
  assert.equal(d.expectedTime, '07:10'); assert.equal(d.delayMin, 8);
  assert.deepEqual(d.transfer, { station: 'München Hbf', minutes: 1, state: 'tight', text: 'Umstieg nur noch 1 Min.' });
  assert.equal(d.arrTime, '09:21');                                         // the planned connection still applies
  assert.equal(d.view.kind, 'tight'); assert.equal(d.view.big, '+8 Min.'); assert.equal(d.view.sub, 'Anschluss in München Hbf wackelt');
  assert.deepEqual(d.view.sections[1], { type: 'transfer', state: 'tight', label: 'Anschluss wackelt', title: 'Umstieg München Hbf', text: 'S1 an 07:45 · RE 5 ab 07:46', minutes: 1 });
  assert.equal(d.view.alternative.title, 'Nächster Anschluss'); assert.equal(d.view.alternative.line1, 'RE 5 ab 08:16 · Gleis 14'); assert.equal(d.view.alternative.line2, 'An Salzburg Hbf 09:51');
  assert.equal(d.view.map.haloIndex, 3); assert.equal(d.view.map.transfer.label, 'Umstieg nur noch 1 Min.'); assert.equal(d.view.map.transfer.state, 'tight');
  assert.deepEqual([d.view.map.times.depLate, d.view.map.times.arrLate], [true, false]);
  assert.deepEqual(d.view.sections[0].rows[0], { label: 'Abfahrt Freising', sub: 'S1 Richtung Ostbahnhof · Gleis 3', value: '07:10', planned: '07:02' });
  // Incident: exactly one, related to the connection
  assert.equal(r.incidents.length, 1);
  const i = r.incidents[0];
  assert.equal(i.kind, 'tight'); assert.equal(i.severity, 2); assert.equal(i.lineName, 'RE 5'); assert.equal(i.delayMin, 8);
  assert.equal(i.title, 'RE 5 München Hbf → Salzburg Hbf'); assert.equal(i.summary, 'Umstieg nur noch 1 Min. (S1 an 07:45, RE 5 ab 07:46)');
  assert.equal(i.validity.until, '2026-10-14T07:46'); assert.equal(i.view, d.view);
  assert.equal(r.tour.view, undefined);                                    // the incident stands for the route
  // the same situation a minute later: the same incident (no second push); if it becomes a missed connection: new incident
  const later = await buildTransferTour(tour, LATE_TRIPS({ late: 8 }), ctx({ now: NOW + 60e3, bLists: CONNECTIONS }));
  assert.equal(later.incidents[0].id, i.id);
  const worse = await buildTransferTour(tour, LATE_TRIPS({ late: 12 }), ctx({ bLists: CONNECTIONS }));
  assert.equal(worse.incidents[0].kind, 'missed'); assert.notEqual(worse.incidents[0].id, i.id);
});

test('Connection missed: the next connection is shown, incident with the highest urgency', async () => {
  const r = await buildTransferTour(tour, LATE_TRIPS({ late: 12 }), ctx({ bLists: CONNECTIONS }));
  const d = r.tour.departures[0];
  assert.equal(d.expectedTime, '07:14');
  assert.deepEqual(d.transfer, { station: 'München Hbf', minutes: 27, state: 'missed', text: 'Anschluss verpasst' });   // 27 min until the next RE
  assert.equal(d.arrTime, '09:51');
  const v = d.view;
  assert.equal(v.kind, 'missed'); assert.equal(v.big, 'Verpasst'); assert.equal(v.head, 'Anschluss · RE 5 ab 07:46'); assert.equal(v.sub, 'Nächster RE 5 ab 08:16, Ankunft 09:51');
  assert.deepEqual(v.sections[1], { type: 'transfer', state: 'missed', label: 'Anschluss verpasst', title: 'Umstieg München Hbf', text: 'S1 an 07:49 · RE 5 07:46 weg', minutes: 27 });
  const b = v.sections[2].rows;                                              // the connection shown, with the planned one for comparison
  assert.deepEqual(b.map((x) => [x.label, x.value, x.planned, x.plannedLabel]), [['Abfahrt München Hbf', '08:16', '07:46', 'statt'], ['Ankunft Salzburg Hbf', '09:51', '09:21', 'statt']]);
  assert.equal(v.map.transfer.label, 'Anschluss verpasst'); assert.equal(v.map.haloIndex, 3);
  assert.deepEqual([v.map.times.depLate, v.map.times.arrLate], [true, true]); assert.equal(v.map.times.arr, 'an 09:51');
  const i = r.incidents[0];
  assert.equal(i.kind, 'missed'); assert.equal(i.severity, 3); assert.equal(i.lineName, 'RE 5');
  assert.equal(i.summary, 'S1 an 07:49, RE 5 07:46 weg. Nächster RE 5 ab 08:16'); assert.equal(i.validity.until, '2026-10-14T08:16');
});

test('Connecting trip cancelled: "Anschluss fällt aus", even if the feeder is on time', async () => {
  const trips = [J(S1('07:02'), RE('07:46', { cancelled: true })), J(S1('07:22'), RE('08:16')), J(S1('07:42'), RE('08:46'))];
  const r = await buildTransferTour(tour, trips, ctx({ bLists: bl(RE('07:16'), RE('07:46', { cancelled: true }), RE('08:16'), RE('08:46')) }));
  const d = r.tour.departures[0];
  assert.deepEqual(d.transfer, { station: 'München Hbf', minutes: 39, state: 'missed', text: 'Anschluss fällt aus' });
  assert.equal(d.view.kind, 'missed'); assert.equal(d.view.big, 'Fällt aus'); assert.equal(d.view.sub, 'Nächster RE 5 ab 08:16, Ankunft 09:51');
  assert.equal(d.view.alternative.title, 'Danach · gleiche Ankunft');
  assert.equal(r.incidents[0].summary, 'RE 5 ab 07:46 fällt aus. Nächster RE 5 ab 08:16');
  assert.equal(d.view.map.transfer.label, 'Anschluss fällt aus');
});

test('Replacement transport on the feeder: the connection stays reachable, the incident says so', async () => {
  const bus = { type: 'status', code: 'x', summary: 'Ersatzbusse ab Moosach', text: 'Wegen Bauarbeiten zwischen Moosach und München Hbf Schienenersatzverkehr mit Bussen. Reisezeit verlängert sich um ca. 4 Minuten.', validFrom: at('00:00'), validUntil: '2026-10-14T23:00:00+02:00' };
  const r = await buildTransferTour(tour, TRIPS({ arrLate: 0, remarks: [bus] }), ctx({ bLists: CONNECTIONS }));
  const d = r.tour.departures[0];
  assert.equal(d.transfer.state, 'ok'); assert.equal(d.transfer.minutes, 5);                  // Bus an 07:41, RE 07:46
  assert.deepEqual(d.view.sections[1], { type: 'transfer', state: 'ok', label: 'Umstieg', title: 'München Hbf', text: 'Bus an 07:41 · RE 5 ab 07:46', minutes: 5 });
  assert.equal(r.incidents.length, 1);
  const i = r.incidents[0];
  assert.equal(i.kind, 'replacement'); assert.equal(i.lineName, 'S1'); assert.equal(i.delayMin, 4);
  assert.equal(i.view.sub, 'Statt S1 fährt Ersatzverkehr · Moosach → München Hbf · Anschluss bleibt erreichbar');
  assert.ok(i.view.map.disrupted && i.view.map.disrupted.to === i.view.map.hubIndex);        // the disrupted section ends at the transfer station
  // if the extra time is no longer enough: connection at risk/missed (bus 25 min later)
  const longRemark = { ...bus, text: bus.text.replace('ca. 4 Minuten', 'ca. 25 Minuten') };
  const r2 = await buildTransferTour(tour, LATE_TRIPS({ arrLate: 0, remarks: [longRemark] }), ctx({ bLists: CONNECTIONS }));
  assert.equal(r2.tour.departures[0].transfer.state, 'missed');
  assert.ok(r2.incidents.some((x) => x.kind === 'replacement' && /Anschluss verpasst$/.test(x.view.sub)));
});

test('Without a connections list ReGo trusts the source (no guessing): delayed feeder, suggested connection stays reachable', async () => {
  const r = await buildTransferTour(tour, [J(S1('07:02', { late: 12 }), RE('08:16')), J(S1('07:22'), RE('08:16'))], ctx());
  const d = r.tour.departures[0];
  assert.equal(d.transfer.state, 'ok'); assert.equal(d.view.kind, 'delay'); assert.equal(d.view.sub, 'Anschluss in München Hbf bleibt erreichbar');
  assert.equal(r.incidents.length, 1); assert.equal(r.incidents[0].kind, 'delay');
});

test('Long wait at the transfer (planned over 30 min): only if there is nothing else', async () => {
  const longWait = J(S1('07:02'), RE('08:16')), shortWait = J(S1('07:22'), RE('08:16'));          // 39 and 19 min wait respectively
  const a = await buildTransferTour(tour, [longWait, shortWait], ctx());
  assert.deepEqual(a.tour.departures.map((d) => d.expectedTime), ['07:22']);
  const b = await buildTransferTour(tour, [longWait], ctx());
  assert.deepEqual(b.tour.departures.map((d) => [d.expectedTime, d.transfer.minutes]), [['07:02', 39]]);
});

test('The feeder is cancelled: cancellation incident as for a direct route, the trip does not appear in the list', async () => {
  const r = await buildTransferTour(tour, [J(S1('07:10', { cancelled: true }), RE('08:16')), J(S1('07:22'), RE('08:16')), J(S1('07:42'), RE('08:46'))], ctx({ bLists: CONNECTIONS }));
  assert.deepEqual(r.tour.departures.map((d) => d.expectedTime), ['07:22', '07:42']);
  const c = r.incidents.find((x) => x.kind === 'cancelled');
  assert.ok(c); assert.equal(c.lineName, 'S1'); assert.equal(c.summary, 'Fahrt um 07:10 fällt aus');
});

test('Only direct trips (the source no longer suggests a transfer): the usual rules with all incidents', async () => {
  const direct = { id: 'td', name: 'Freising → München Hbf', from: FS, to: MH, active: true, transfers: 1 };
  const r = await buildTransferTour(direct, [J(S1('07:02', { late: 8 })), J(S1('07:22'))], ctx());
  assert.equal(r.tour.transfers, undefined); assert.equal(r.tour.departures[0].transfer, undefined);
  assert.equal(r.tour.departures[0].view.kind, 'delay');
  assert.ok(r.incidents.some((x) => x.kind === 'delay'));
  // without any connection: honest explanation, no crash
  const empty = await buildTransferTour(tour, [], ctx());
  assert.equal(empty.tour.view.kind, 'none'); assert.match(empty.tour.view.sub, /Umstieg/); assert.deepEqual(empty.tour.departures, []);
});

test('Platform change at the transfer: the connecting trip gets its own, quiet incident', async () => {
  const b = RE('07:46'); b.platform = '9';
  const r = await buildTransferTour(tour, [J(S1('07:02'), b), J(S1('07:22'), RE('08:16'))], ctx({ bLists: bl(b, RE('08:16')) }));
  const p = r.incidents.find((x) => x.kind === 'platform');
  assert.ok(p); assert.equal(p.lineName, 'RE 5'); assert.equal(p.platform, '9'); assert.equal(p.summary, '07:46 in München Hbf jetzt Gleis 9 statt Gleis 14');
  assert.equal(r.tour.departures[0].view.sections[1].text, 'Gleis 2 → Gleis 9');
});

test('Preview when creating and transfer stations', () => {
  const js = [J(S1('07:02'), RE('08:16')), J(S1('07:22'), RE('08:16')), J(S1('07:42'), RE('08:46'))];
  const p = previewRoute(js);                                                // the first with a reasonable wait (07:02 waits 39 min)
  assert.equal(p.via, 'München Hbf'); assert.equal(p.wait, 19); assert.equal(p.duration, '2 Std. 29 Min.');
  assert.deepEqual(p.legs.map((l) => [l.line, l.lineId, l.title, l.times]), [['S1', 'S1', 'Freising → München Hbf', 'ab 07:22 · an 07:57'], ['RE 5', 'RE5', 'München Hbf → Salzburg Hbf', 'ab 08:16 · an 09:51']]);
  assert.ok(/^#[0-9a-f]{6}$/i.test(p.legs[0].color));
  assert.equal(previewRoute([]), null);
  assert.equal(previewRoute([J(S1('07:02', { cancelled: true }), RE('07:46'))]), null);
  const direct = previewRoute([J(S1('07:02'))]);
  assert.equal(direct.legs.length, 1); assert.equal(direct.via, undefined);
  const v = transferVias(js);
  assert.equal(v.length, 1); assert.equal(v[0].name, 'München Hbf'); assert.equal(v[0].count, 3); assert.equal(v[0].stop.id, MH.id);
});

// ---------- Saving routes ----------

test('Routes: transfers 1 applies to outward and return trip, is kept on replacing, other values are an error', () => {
  const p = { tours: [], settings: {} };
  const [outbound, inbound] = addTours(p, { from: FS, to: SZ, roundTrip: true, transfers: 1 });
  assert.equal(outbound.transfers, 1); assert.equal(inbound.transfers, 1); assert.equal(inbound.returnOf, outbound.id);
  const [direct] = addTours(p, { from: MH, to: FS });
  assert.equal(direct.transfers, undefined);
  assert.throws(() => addTours(p, { from: FS, to: MH, transfers: 2 }), (e) => e instanceof ValidationError && e.status === 400 && /transfers/.test(e.message));
  assert.throws(() => addTours(p, { from: FS, to: MH, transfers: 'ja' }), ValidationError);
  assert.equal(addTours({ tours: [], settings: {} }, { from: FS, to: MH, transfers: 0 })[0].transfers, undefined);
  const back = replaceProfile({ tours: [], settings: {} }, { tours: JSON.parse(JSON.stringify(p.tours)) });
  assert.deepEqual(back.tours.map((t) => t.transfers), [1, 1, undefined]);
});

test('Route without a direct connection from older versions: created with a transfer, it is switched over (no duplicate)', () => {
  const p = { tours: [], settings: {} };
  const [legacy, legacyBack] = addTours(p, { from: FS, to: SZ, roundTrip: true });             // like from an older version
  assert.equal(legacy.transfers, undefined);
  const again = addTours(p, { from: FS, to: SZ, roundTrip: true, transfers: 1 });
  assert.deepEqual(again.map((t) => t.id), [legacy.id, legacyBack.id]);                         // the same routes, not duplicated
  assert.deepEqual(p.tours.map((t) => t.transfers), [1, 1]);
  addTours(p, { from: FS, to: SZ, roundTrip: true });                                     // once more without a transfer: stays as it is
  assert.deepEqual(p.tours.map((t) => t.transfers), [1, 1]); assert.equal(p.tours.length, 2);
});

// ---------- Schnittstelle (Beispieldaten) ----------

async function appOn(dir, cfg = {}, extra = {}) {
  const { server, store, service } = createApp({ cfg: { ...config, dataDir: dir, provider: 'mock', ...cfg }, ...extra });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { server, store, service, base: `http://127.0.0.1:${server.address().port}` };
}
const hdr = (dev) => ({ 'x-device': dev, 'content-type': 'application/json' });
const poster = (base, h) => async (p, b) => { const r = await fetch(`${base}${p}`, { method: 'POST', headers: h, body: JSON.stringify(b) }); return { status: r.status, body: await r.json() }; };

test('Search with 1 transfer: preview, direct connection, nothing found, source does not answer', async () => {
  const { server, base, service } = await appOn(await tmp(), {}, { now: () => NOW });
  const post = poster(base, hdr('umstiegssuche123456'));
  try {
    let r = await post('/api/connections/search', { from: FS, to: SZ });
    assert.equal(r.status, 200); assert.equal(r.body.found, true); assert.equal(r.body.transfers, 1);
    assert.equal(r.body.route.via, 'München Hbf'); assert.equal(r.body.route.legs.length, 2); assert.equal(typeof r.body.route.wait, 'number');
    assert.deepEqual(r.body.route.legs.map((l) => l.line), ['S1', 'RE 5']);
    assert.deepEqual(r.body.route.legs.map((l) => l.title), ['Freising → München Hbf', 'München Hbf → Salzburg Hbf']);
    assert.match(r.body.route.legs[0].times, /^ab \d\d:\d\d · an \d\d:\d\d$/); assert.match(r.body.route.duration, /Std\./);
    r = await post('/api/connections/search', { from: MH, to: FS });                      // exists directly: one trip, no transfer
    assert.equal(r.body.found, true); assert.equal(r.body.route.legs.length, 1); assert.equal(r.body.route.via, undefined);
    r = await post('/api/connections/search', { from: PA, to: WI });                      // in the sample data there is nothing in between
    assert.equal(r.status, 200); assert.equal(r.body.found, false); assert.equal(r.body.route, undefined);
    const orig = service.searchTransfer; service.searchTransfer = async () => ({ found: null });
    r = await post('/api/connections/search', { from: FS, to: SZ }); assert.equal(r.status, 200); assert.equal(r.body.found, null);   // "don't know right now"
    service.searchTransfer = orig;
    assert.equal((await post('/api/connections/search', { from: FS, to: FS })).status, 400);
    assert.equal((await post('/api/connections/search', {})).status, 400);
    assert.equal((await fetch(`${base}/api/connections/search`, { headers: hdr('umstiegssuche123456') })).status, 404);   // POST only
  } finally { server.close(); }
});

test('Create route with transfer: first without a direct connection (422 no-direct), then with transfers 1; without a connection 422 no-connection', async () => {
  const { server, base, service } = await appOn(await tmp(), {}, { now: () => NOW });
  const h = hdr('umstiegsanlegen1234'), post = poster(base, h);
  try {
    let r = await post('/api/tours', { from: FS, to: SZ });
    assert.equal(r.status, 422); assert.equal(r.body.code, 'no-direct'); assert.equal(r.body.error, 'Zwischen Freising und Salzburg Hbf habe ich keine Direktverbindung gefunden.');
    r = await post('/api/tours', { from: PA, to: WI, transfers: 1 });
    assert.equal(r.status, 422); assert.equal(r.body.code, 'no-connection'); assert.equal(r.body.error, 'Auch mit 1 Umstieg habe ich zwischen Passau Hbf und Wien Hbf nichts gefunden.');
    assert.equal((await post('/api/tours', { from: FS, to: SZ, transfers: 2 })).status, 400);
    assert.equal((await (await fetch(`${base}/api/profile`, { headers: h })).json()).tours.length, 0);       // none of it was stored
    r = await post('/api/tours', { from: FS, to: SZ, roundTrip: true, transfers: 1 });
    assert.equal(r.status, 201); assert.deepEqual(r.body.tours.map((t) => t.transfers), [1, 1]);
    r = await post('/api/tours', { from: MH, to: FS }); assert.equal(r.status, 201); assert.equal(r.body.tours[0].transfers, undefined);
    const prof = (await (await fetch(`${base}/api/profile`, { headers: h })).json()).tours;
    assert.deepEqual(prof.map((t) => t.transfers), [1, 1, undefined]);
    // if the source does not know, the route is created when in doubt (the user must not be locked out)
    service.searchTransfer = async () => ({ found: null });
    r = await post('/api/tours', { from: WI, to: PA, transfers: 1 }); assert.equal(r.status, 201);
  } finally { server.close(); }
});

test('Old route without a direct connection is switched with "Mit 1 Umstieg" instead of being created twice; without a connection it stays as it is', async () => {
  const dev = 'umstiegsumstellen1';
  const { server, store, base } = await appOn(await tmp(), {}, { now: () => NOW });
  const h = hdr(dev), post = poster(base, h);
  const tours = async () => (await (await fetch(`${base}/api/profile`, { headers: h })).json()).tours;
  try {
    await store.update(dev, (p) => { addTours(p, { from: FS, to: SZ }); addTours(p, { from: PA, to: WI }); });   // like from an older version: the server now rejects creating it anew
    assert.deepEqual((await tours()).map((t) => t.transfers), [undefined, undefined]);
    let r = await post('/api/tours', { from: FS, to: SZ });                                                    // once more without a transfer: not silently "saved", the hint comes again
    assert.equal(r.status, 422); assert.equal(r.body.code, 'no-direct');
    r = await post('/api/tours', { from: FS, to: SZ, transfers: 1 });
    assert.equal(r.status, 201); assert.equal(r.body.tours.length, 1); assert.equal(r.body.tours[0].transfers, 1);
    assert.deepEqual((await tours()).map((t) => t.transfers), [1, undefined]);                                 // switched, not duplicated
    r = await post('/api/tours', { from: PA, to: WI, transfers: 1 });                                          // with a transfer nothing either: 422, the route stays unchanged
    assert.equal(r.status, 422); assert.equal(r.body.code, 'no-connection');
    assert.deepEqual((await tours()).map((t) => t.transfers), [1, undefined]);
    r = await post('/api/tours', { from: FS, to: SZ, transfers: 1 });                                          // once more with a transfer (double tap): nothing new
    assert.equal(r.status, 201); assert.equal((await tours()).length, 2);
  } finally { server.close(); }
});

test('Route with transfer in the state (sample data, fixed clock): two lines, transfer per departure, incidents', async () => {
  const now = Date.parse('2026-10-14T06:50:00+02:00');
  const { server, base } = await appOn(await tmp(), {}, { now: () => now });
  const h = hdr('umstiegszustand1234'), post = poster(base, h);
  try {
    assert.equal((await post('/api/tours', { from: FS, to: SZ, roundTrip: true, transfers: 1 })).status, 201);
    const st = await (await fetch(`${base}/api/state`, { headers: h })).json();
    const outbound = st.tours.find((t) => !t.returnOf), inbound = st.tours.find((t) => t.returnOf);
    assert.equal(outbound.transfers, 1); assert.equal(outbound.via, 'München Hbf'); assert.deepEqual(outbound.lineIds, ['S1', 'RE5']);
    assert.ok(st.lines.S1 && st.lines.RE5);                                              // both lines are in the registry (color, short name)
    assert.deepEqual(outbound.departures.map((d) => d.expectedTime), ['07:08', '07:24', '07:40']);
    assert.deepEqual(outbound.departures.map((d) => d.transfer.state), ['ok', 'ok', 'ok']);
    assert.equal(outbound.departures[0].view.kind, 'delay'); assert.equal(outbound.departures[0].view.sub, 'Anschluss in München Hbf bleibt erreichbar');
    assert.equal(outbound.departures[2].view.kind, 'ok'); assert.equal(outbound.departures[2].transfer.text, 'Umstieg München Hbf · 4 Min.');
    // Return trip: the first RE 5 has replacement transport and a delay, the connection is gone
    assert.deepEqual(inbound.departures.map((d) => d.transfer.state), ['missed', 'missed', 'ok']);
    assert.equal(inbound.departures[0].view.kind, 'missed');
    const kinds = st.incidents.map((i) => i.kind);
    for (const k of ['missed', 'replacement', 'delay', 'platform']) assert.ok(kinds.includes(k), k);
    assert.ok(st.incidents.filter((i) => i.kind === 'missed').every((i) => i.tourId === inbound.id));
    assert.ok(st.incidents.every((i) => st.tours.some((t) => t.id === i.tourId)));
    // every incident knows its view (color and symbol come from the registry of kinds)
    for (const i of st.incidents) assert.ok(st.theme.kinds[i.kind], `Art ${i.kind} fehlt im Verzeichnis`);
  } finally { server.close(); }
});

test('Route with transfer, paused: stays recognizable as a transfer route', async () => {
  const { server, base } = await appOn(await tmp(), {}, { now: () => NOW });
  const h = hdr('umstiegspause12345'), post = poster(base, h);
  try {
    const { body } = await post('/api/tours', { from: FS, to: SZ, transfers: 1 });
    const id = body.tours[0].id;
    assert.equal((await fetch(`${base}/api/tours/${id}`, { method: 'PATCH', headers: h, body: JSON.stringify({ active: false }) })).status, 200);
    const t = (await (await fetch(`${base}/api/state`, { headers: h })).json()).tours.find((x) => x.id === id);
    assert.equal(t.active, false); assert.equal(t.transfers, 1); assert.deepEqual(t.departures, []);
  } finally { server.close(); }
});

// ---------- Push ----------

test('Push: "Anschluss wackelt" and "Anschluss verpasst" always come (as long as current), with their own title', () => {
  const inc = (kind, extra = {}) => ({ kind, delayMin: 8, lineName: 'RE 5', title: 'RE 5 München Hbf → Salzburg Hbf', summary: 'Umstieg nur noch 1 Min. (S1 an 07:45, RE 5 ab 07:46)', validity: { activeNow: true }, ...extra });
  for (const k of ['tight', 'missed']) { assert.ok(relevant(inc(k), 10), k); assert.ok(!relevant(inc(k, { validity: { activeNow: false } }), 3), k); }   // independent of the delay threshold
  assert.deepEqual(textFor(inc('tight')), { title: 'Anschluss wackelt · RE 5', body: 'München Hbf → Salzburg Hbf · Umstieg nur noch 1 Min. (S1 an 07:45, RE 5 ab 07:46)' });
  assert.equal(textFor(inc('missed')).title, 'Anschluss verpasst · RE 5');
  assert.equal(changeOf(inc('tight')), undefined); assert.equal(changeOf(inc('missed')), undefined);        // no silent updates: a new state is a new incident
});
