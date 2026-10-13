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

test('Hinweise werden eingeordnet', () => {
  assert.equal(classifyRemark({ summary: 'Schienenersatzverkehr' }), 'replacement');
  assert.equal(classifyRemark({ text: 'Wegen Bauarbeiten Langsamfahrstelle' }), 'construction');
  assert.equal(classifyRemark({ summary: 'Stellwerksstörung' }), 'other');
  assert.equal(extractMinutes('Reisezeit ca. 25 Minuten länger'), 25);
  assert.deepEqual(extractSegment('zwischen Rosenheim und Prien Ersatzverkehr'), ['Rosenheim', 'Prien']);
});

test('Region nach Haltestellen-ID', () => {
  assert.equal(regionOf({ id: '8100002', lat: 47.8, lon: 13.0 }), 'AT');
  assert.equal(regionOf({ id: '8000261', lat: 48.14, lon: 11.56 }), 'BY');
  assert.equal(regionOf({ id: '8000105', lat: 53.5, lon: 10 }), 'DE');
});

test('Zeit: Berlin hin und zurück (Sommer- und Winterzeit)', () => {
  for (const [d, t] of [['2026-07-01', '07:15'], ['2026-12-01', '07:15'], ['2026-10-25', '03:30']]) {
    const b = berlin(fromBerlin(d, t));
    assert.equal(b.date, d);
    if (d !== '2026-10-25') assert.equal(b.time, t);
  }
});

test('Karte: höchstens 7 Stationen, Pflichtstopps bleiben', () => {
  const idx = sampleStops(Array.from({ length: 20 }, (_, i) => i), [5, 12]);
  assert.ok(idx.length <= 7);
  for (const k of [0, 19, 5, 12]) assert.ok(idx.includes(k));
});

test('Cache: bei Fehler letzter Wert', async () => {
  let t = 0; const c = new TtlCache(() => t);
  assert.equal((await c.get('k', 10, async () => 1)).value, 1);
  t = 20000;
  const r = await c.get('k', 10, async () => { throw new Error('x'); });
  assert.equal(r.value, 1); assert.equal(r.stale, true);
});

test('Profil: Hin- und Rückweg, Löschen verknüpft sauber', () => {
  const p = { tours: [], settings: { pushThresholdMin: 5, delayGraceMin: 10 } };
  const [a, b] = addTours(p, { from: { id: '1', name: 'A' }, to: { id: '2', name: 'B' }, roundTrip: true });
  assert.equal(a.returnId, b.id); assert.equal(b.returnOf, a.id);
  deleteTour(p, a.id);
  assert.equal(b.returnOf, undefined);
  assert.throws(() => setSettings(p, { pushThresholdMin: 7 }));
  assert.throws(() => addTours(p, { from: { id: '1', name: 'A' }, to: { id: '1', name: 'A' } }));
});

test('API (Beispieldaten): Strecke anlegen -> Zustand im Vertragsformat', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'rego-'));
  const cfg = { ...config, provider: 'mock', dataDir: dir };
  const { server } = createApp({ cfg });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const h = { 'x-device': 'testgeraet1234567', 'content-type': 'application/json' };
  try {
    assert.equal((await fetch(`${base}/api/state`)).status, 400);
    const c = await fetch(`${base}/api/tours`, { method: 'POST', headers: h, body: JSON.stringify({ from: { id: '8002078', name: 'Freising' }, to: { id: '8000261', name: 'München Hbf' } }) });
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

test('Bibliotheks-Anbindung: Rohformat -> normalisiert, fehlende stop() ist kein Fehler', async () => {
  const { LibClient } = await import('../server/providers/lib.mjs');
  const fake = {
    locations: async () => [{ type: 'stop', id: '8002078', name: 'Freising', location: { latitude: 48.4, longitude: 11.74 } }, { type: 'location', id: 'x', name: 'Straße' }],
    journeys: async (from, to, o) => { assert.equal(o.transfers, 0); return { journeys: [{ legs: [{ line: { name: 'S 1', product: 'suburban' }, direction: 'München Hbf', origin: { id: from, name: 'A' }, destination: { id: to, name: 'B' }, plannedDeparture: '2026-10-10T07:21:00+02:00', departure: '2026-10-10T07:27:00+02:00', departureDelay: 360, plannedArrival: '2026-10-10T08:00:00+02:00', arrival: '2026-10-10T08:06:00+02:00', arrivalDelay: 360, stopovers: [], remarks: [] }] }] }; },
  };
  const c = new LibClient(async () => fake);
  assert.equal((await c.searchStops('frei')).length, 1);
  const j = await c.journeys({ fromId: '1', toId: '2', when: new Date().toISOString() });
  assert.equal(j[0].legs[0].depDelay, 6);
  assert.deepEqual((await c.stop('1')).lines, []);
});

test('Echte Antworten (Mitschnitt 10.10.2026): Umwandlung und Meldungen', async () => {
  const { readFile } = await import('node:fs/promises');
  const { normJourney, cleanStopName } = await import('../server/providers/hafas.mjs');
  const { buildTour } = await import('../server/domain/state.mjs');
  const { lineLabel } = await import('../server/lib/lines.mjs');
  assert.equal(cleanStopName('München Hbf Gl.27-36'), 'München Hbf');
  assert.equal(cleanStopName('Wien Hbf (Bahnsteige 3-12)'), 'Wien Hbf');
  assert.equal(lineLabel('RJX19915'), 'RJX'); assert.equal(lineLabel('IC 745'), 'IC'); assert.equal(lineLabel('RE25'), 'RE25'); assert.equal(lineLabel('S 1'), 'S1');
  const load = async (n) => JSON.parse(await readFile(new URL(`../fixtures/real/${n}`, import.meta.url), 'utf8'));
  // db-journeys.json ist schon normalisiert (Ausgabe von probe.mjs)
  const dbJ = await load('db-journeys.json'), oebbJ = await load('oebb-journeys.json');
  const ctx = (now) => ({ now, minDelay: 3, linesAt: async () => [], lines: {}, graceMin: 10 });
  const t1 = Date.parse('2026-10-10T16:45:00+02:00');
  const a = await buildTour({ id: 't1', name: 'Freising → München Hbf', from: { id: '8002078', name: 'Freising' }, to: { id: '8000261', name: 'München Hbf' } }, dbJ, ctx(t1));
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

test('API: Umzug aufs neue Handy per Einmal-Code', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'rego-'));
  const { server } = createApp({ cfg: { ...config, provider: 'mock', dataDir: dir } });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const alt = { 'x-device': 'altesgeraet123456', 'content-type': 'application/json' };
  const neu = { 'x-device': 'neuesgeraet123456', 'content-type': 'application/json' };
  try {
    await fetch(`${base}/api/tours`, { method: 'POST', headers: alt, body: JSON.stringify({ from: { id: '8002078', name: 'Freising' }, to: { id: '8000261', name: 'München Hbf' } }) });
    const { code } = await (await fetch(`${base}/api/transfer`, { method: 'POST', headers: alt, body: '{}' })).json();
    assert.match(code, /^[A-Z2-9]{6}$/);
    assert.equal((await fetch(`${base}/api/transfer/claim`, { method: 'POST', headers: alt, body: JSON.stringify({ code }) })).status, 400);   // nicht auf demselben Gerät
    assert.equal((await fetch(`${base}/api/transfer/claim`, { method: 'POST', headers: neu, body: JSON.stringify({ code: 'XXXXXX' }) })).status, 404);
    const r = await fetch(`${base}/api/transfer/claim`, { method: 'POST', headers: neu, body: JSON.stringify({ code: code.toLowerCase() }) });
    assert.equal(r.status, 200);
    assert.equal((await r.json()).tours, 1);
    assert.equal((await (await fetch(`${base}/api/state`, { headers: neu })).json()).tours.length, 1);
    assert.equal((await fetch(`${base}/api/transfer/claim`, { method: 'POST', headers: neu, body: JSON.stringify({ code }) })).status, 404);   // nur einmal nutzbar
  } finally { server.close(); }
});
