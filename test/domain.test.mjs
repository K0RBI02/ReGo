import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { classifyRemark, extractMinutes, extractSegment } from '../server/domain/classify.mjs';
import { regionOf } from '../server/lib/geo.mjs';
import { fromBerlin, berlin } from '../server/lib/time.mjs';
import { sampleStops } from '../server/domain/map.mjs';
import { TtlCache } from '../server/store/cache.mjs';
import { ProfileStore, addTours, deleteTour, setSettings } from '../server/store/profile.mjs';
import { createApp } from '../server/index.mjs';
import { config } from '../server/config.mjs';

test('Remarks are classified', () => {
  assert.equal(classifyRemark({ summary: 'Schienenersatzverkehr' }), 'replacement');
  assert.equal(classifyRemark({ text: 'Wegen Bauarbeiten Langsamfahrstelle' }), 'construction');
  assert.equal(classifyRemark({ summary: 'Stellwerksstörung' }), 'other');
  assert.equal(extractMinutes('Reisezeit ca. 25 Minuten länger'), 25);
  assert.deepEqual(extractSegment('zwischen Rosenheim und Prien Ersatzverkehr'), ['Rosenheim', 'Prien']);
});

test('Region by stop ID', () => {
  assert.equal(regionOf({ id: '8100002', lat: 47.8, lon: 13.0 }), 'AT');
  assert.equal(regionOf({ id: '8000261', lat: 48.14, lon: 11.56 }), 'BY');
  assert.equal(regionOf({ id: '8000105', lat: 53.5, lon: 10 }), 'DE');
});

test('Time: Berlin there and back (summer and winter time)', () => {
  for (const [d, t] of [['2026-07-01', '07:15'], ['2026-12-01', '07:15'], ['2026-10-25', '03:30']]) {
    const b = berlin(fromBerlin(d, t));
    assert.equal(b.date, d);
    if (d !== '2026-10-25') assert.equal(b.time, t);
  }
});

test('Map: at most 7 stations, mandatory stops stay', () => {
  const idx = sampleStops(Array.from({ length: 20 }, (_, i) => i), [5, 12]);
  assert.ok(idx.length <= 7);
  for (const k of [0, 19, 5, 12]) assert.ok(idx.includes(k));
});

test('Cache: last value on error', async () => {
  let t = 0; const c = new TtlCache(() => t);
  assert.equal((await c.get('k', 10, async () => 1)).value, 1);
  t = 20000;
  const r = await c.get('k', 10, async () => { throw new Error('x'); });
  assert.equal(r.value, 1); assert.equal(r.stale, true);
});

test('Profile: a new route that is a saved route backwards becomes its return trip, once, also when the stops come from another source', () => {
  const p = { tours: [], settings: { pushThresholdMin: 5, delayGraceMin: 10 } };
  const A = { id: '1', name: 'A' }, B = { id: '2', name: 'B' };
  const [out] = addTours(p, { from: A, to: B, schedule: { days: ['Mo'], departAfter: '06:00', departUntil: '08:00' } });
  const [back] = addTours(p, { from: B, to: A, schedule: { days: ['Mo'], departAfter: '16:30', departUntil: '17:30' } });
  assert.equal(back.returnOf, out.id); assert.equal(out.returnId, back.id);
  assert.equal(back.period, 'pm');
  // The outward route has its return trip: a second one backwards stays on its own, and so does an unrelated route
  const [again] = addTours(p, { from: B, to: A, schedule: { days: ['Di'], departAfter: '17:00' } });
  assert.equal(again.returnOf, undefined); assert.equal(out.returnId, back.id);
  const [other] = addTours(p, { from: A, to: { id: '3', name: 'C' } });
  assert.equal(other.returnOf, undefined); assert.equal(other.returnId, undefined);
  // The same stop under another ID (picked from another source) is matched by its name
  const [c2a] = addTours(p, { from: { id: '30', name: 'C' }, to: { id: '10', name: 'A' } });
  assert.equal(c2a.returnOf, other.id); assert.equal(other.returnId, c2a.id);
  // Deleting the return trip frees the outward route: the next one backwards is linked again
  deleteTour(p, back.id);
  assert.equal(out.returnId, undefined);
  const [back2] = addTours(p, { from: B, to: A, schedule: { days: ['Mi'], departAfter: '16:00' } });
  assert.equal(back2.returnOf, out.id); assert.equal(out.returnId, back2.id);
  // A pair created together stays as it is
  const [x, y] = addTours(p, { from: { id: '7', name: 'X' }, to: { id: '8', name: 'Y' }, roundTrip: true });
  assert.equal(x.returnId, y.id); assert.equal(y.returnOf, x.id);
});

test('Profile: outward and return trip, deleting unlinks cleanly', () => {
  const p = { tours: [], settings: { pushThresholdMin: 5, delayGraceMin: 10 } };
  const [a, b] = addTours(p, { from: { id: '1', name: 'A' }, to: { id: '2', name: 'B' }, roundTrip: true });
  assert.equal(a.returnId, b.id); assert.equal(b.returnOf, a.id);
  deleteTour(p, a.id);
  assert.equal(b.returnOf, undefined);
  assert.throws(() => setSettings(p, { pushThresholdMin: 7 }));
  assert.throws(() => addTours(p, { from: { id: '1', name: 'A' }, to: { id: '1', name: 'A' } }));
});

test('API (sample data): create route -> state in the expected shape', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'rego-'));
  const cfg = { ...config, provider: 'mock', dataDir: dir };
  const { server } = createApp({ cfg });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const h = { 'x-device': 'testgeraet1234567', 'content-type': 'application/json' };
  try {
    assert.equal((await fetch(`${base}/api/state`)).status, 400);
    const c = await fetch(`${base}/api/tours`, { method: 'POST', headers: h, body: JSON.stringify({ from: { id: '8002078', name: 'Fiktivia' }, to: { id: '8000261', name: 'München Hbf' } }) });
    assert.equal(c.status, 201);
    const s = await (await fetch(`${base}/api/state`, { headers: h })).json();
    assert.equal(s.schemaVersion, 1);
    assert.equal(s.connection.status, 'ok');
    assert.equal(s.tours.length, 1);
    assert.ok(s.tours[0].departures.length > 0);
    assert.ok(s.lines.S1);
    const inc = s.incidents[0];
    assert.equal(inc.kind, 'delay');
    assert.ok(inc.view.map.stations.length <= 7);
  } finally { server.close(); }
});

test('Library adapter: raw format -> normalized, missing stop() is no error', async () => {
  const { LibClient } = await import('../server/providers/lib.mjs');
  const fake = {
    locations: async () => [{ type: 'stop', id: '8002078', name: 'Fiktivia', location: { latitude: 48.4, longitude: 11.74 } }, { type: 'location', id: 'x', name: 'Straße' }],
    journeys: async (from, to, o) => { assert.equal(o.transfers, 0); return { journeys: [{ legs: [{ line: { name: 'S 1', product: 'suburban' }, direction: 'München Hbf', origin: { id: from, name: 'A' }, destination: { id: to, name: 'B' }, plannedDeparture: '2026-10-10T07:21:00+02:00', departure: '2026-10-10T07:27:00+02:00', departureDelay: 360, plannedArrival: '2026-10-10T08:00:00+02:00', arrival: '2026-10-10T08:06:00+02:00', arrivalDelay: 360, stopovers: [], remarks: [] }] }] }; },
  };
  const c = new LibClient(async () => fake);
  assert.equal((await c.searchStops('frei')).length, 1);
  const j = await c.journeys({ fromId: '1', toId: '2', when: new Date().toISOString() });
  assert.equal(j[0].legs[0].depDelay, 6);
  assert.deepEqual((await c.stop('1')).lines, []);
});

test('Real responses (recorded 10.10.2026): conversion and incidents', async () => {
  const { readFile } = await import('node:fs/promises');
  const { normJourney, cleanStopName } = await import('../server/providers/hafas.mjs');
  const { buildTour } = await import('../server/domain/state.mjs');
  const { lineLabel } = await import('../server/lib/lines.mjs');
  assert.equal(cleanStopName('München Hbf Gl.27-36'), 'München Hbf');
  assert.equal(cleanStopName('Wien Hbf (Bahnsteige 3-12)'), 'Wien Hbf');
  assert.equal(lineLabel('RJX19915'), 'RJX'); assert.equal(lineLabel('IC 745'), 'IC'); assert.equal(lineLabel('RE25'), 'RE25'); assert.equal(lineLabel('S 1'), 'S1');
  const load = async (n) => JSON.parse(await readFile(new URL(`./fixtures/${n}`, import.meta.url), 'utf8'));
  // db-journeys.json is already normalized (output of probe.mjs)
  const dbJ = await load('db-journeys.json'), oebbJ = await load('oebb-journeys.json');
  const ctx = (now) => ({ now, minDelay: 3, linesAt: async () => [], lines: {}, graceMin: 10 });
  const t1 = Date.parse('2026-10-10T16:45:00+02:00');
  const a = await buildTour({ id: 't1', name: 'Fiktivia → München Hbf', from: { id: '8002078', name: 'Fiktivia' }, to: { id: '8000261', name: 'München Hbf' } }, dbJ, ctx(t1));
  assert.equal(a.tour.departures[0].delayMin, 4);
  assert.equal(a.incidents[0].kind, 'delay');
  const s1 = dbJ[2].legs[0];
  const { buildMap } = await import('../server/domain/map.mjs');
  const map = await buildMap(s1, async () => [], {});
  assert.ok(map.stations.length <= 7);
  assert.equal(map.stations.at(-1).name, 'München Hbf');
  assert.equal(new Set(map.stations.map((x) => x.name)).size, map.stations.length);
  const b = await buildTour({ id: 't9', name: 'Salzburg → Wien', from: { id: '8100002', name: 'Salzburg Hbf' }, to: { id: '8103000', name: 'Wien Hbf' } }, oebbJ, ctx(Date.parse('2026-10-10T16:05:00+02:00')));
  assert.equal(b.tour.lineId, 'RJX');
  assert.equal(b.incidents[0].delayMin, 32);
  assert.equal(b.incidents[0].view.big, '+32 Min.');
});

test('API: moving to the new phone with a one-time code', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'rego-'));
  const { server } = createApp({ cfg: { ...config, provider: 'mock', dataDir: dir } });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const oldPhone = { 'x-device': 'oldphone123456789', 'content-type': 'application/json' };
  const newPhone = { 'x-device': 'newphone123456789', 'content-type': 'application/json' };
  try {
    await fetch(`${base}/api/tours`, { method: 'POST', headers: oldPhone, body: JSON.stringify({ from: { id: '8002078', name: 'Fiktivia' }, to: { id: '8000261', name: 'München Hbf' } }) });
    const { code } = await (await fetch(`${base}/api/transfer`, { method: 'POST', headers: oldPhone, body: '{}' })).json();
    assert.match(code, /^[A-Z2-9]{6}$/);
    assert.equal((await fetch(`${base}/api/transfer/claim`, { method: 'POST', headers: oldPhone, body: JSON.stringify({ code }) })).status, 400);   // not on the same device
    assert.equal((await fetch(`${base}/api/transfer/claim`, { method: 'POST', headers: newPhone, body: JSON.stringify({ code: 'XXXXXX' }) })).status, 404);
    const r = await fetch(`${base}/api/transfer/claim`, { method: 'POST', headers: newPhone, body: JSON.stringify({ code: code.toLowerCase() }) });
    assert.equal(r.status, 200);
    assert.equal((await r.json()).tours, 1);
    assert.equal((await (await fetch(`${base}/api/state`, { headers: newPhone })).json()).tours.length, 1);
    assert.equal((await fetch(`${base}/api/transfer/claim`, { method: 'POST', headers: newPhone, body: JSON.stringify({ code }) })).status, 404);   // usable only once
  } finally { server.close(); }
});

test('Departures: past ones drop out, sorted, next day marked, matching app link', async () => {
  const { buildTour, tidyName } = await import('../server/domain/state.mjs');
  const now = Date.parse('2026-10-13T21:20:00Z');            // 23:20 Berlin
  const leg = (dep) => ({ line: { name: 'RE 5', product: 'regional' }, direction: 'Salzburg', origin: { id: '8000261', name: 'München Hbf' }, destination: { id: '8100002', name: 'Salzburg Hbf' },
    plannedDep: dep, dep, depDelay: 0, plannedArr: dep, arr: dep, arrDelay: 0, plannedPlatform: '13', platform: '13', stopovers: [], remarks: [] });
  const tour = { id: 't1', name: 'München, München Hbf → Salzburg Hbf', from: { id: '8000261', name: 'München Hbf' }, to: { id: '8100002', name: 'Salzburg Hbf' }, active: true };
  const journeys = ['2026-10-14T05:46:00+02:00', '2026-10-13T19:59:00+02:00', '2026-10-14T06:04:00+02:00'].map((d) => ({ legs: [leg(d)] }));
  const { tour: out } = await buildTour(tour, journeys, { now, minDelay: 3, linesAt: async () => [], lines: {} });
  assert.deepEqual(out.departures.map((d) => d.expectedTime), ['05:46', '06:04']);
  assert.ok(out.departures.every((d) => d.nextDay));
  assert.equal(out.name, 'München Hbf → Salzburg Hbf');
  assert.equal(out.appLink, null);                          // cross-border: only the ticket hint
  assert.equal(tidyName('Fiktivia → München, München Hbf'), 'Fiktivia → München Hbf');
});
