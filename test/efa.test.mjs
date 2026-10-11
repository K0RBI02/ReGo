import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { EfaClient, parseStops } from '../server/providers/efa.mjs';

const stops = JSON.parse(readFileSync(new URL('./fixtures/efa-stops.json', import.meta.url), 'utf8'));

test('EFA: Haltestellensuche – bester Treffer zuerst, Präfix, Koordinaten', () => {
  const r = parseStops(stops, 'mvv');
  assert.equal(r.length, 8);
  assert.equal(r[0].id, 'mvv|de:09162:2');
  assert.equal(r[0].name, 'München, Marienplatz');
  assert.equal(r[0].lat, 48.136436);
  assert.equal(r[0].lon, 11.577658);
});

test('EFA: Client fragt rapidJSON ab und kennt seine IDs', async () => {
  let url = '';
  const c = new EfaClient('https://example.test/mobile/', { key: 'mvv', fetchImpl: async (u) => { url = u; return { ok: true, json: async () => stops }; } });
  const r = await c.searchStops('Marienplatz');
  assert.match(url, /^https:\/\/example\.test\/mobile\/XML_STOPFINDER_REQUEST\?/);
  assert.match(url, /outputFormat=rapidJSON/);
  assert.match(url, /name_sf=Marienplatz/);
  assert.ok(c.owns(r[0].id)); assert.equal(c.raw(r[0].id), 'de:09162:2');
  assert.equal(c.owns('8000261'), false);
});

test('EFA: HTTP-Fehler 404 wird nicht wiederholt', async () => {
  let n = 0;
  const c = new EfaClient('https://example.test', { fetchImpl: async () => { n++; return { ok: false, status: 404 }; } });
  await assert.rejects(c.searchStops('x'), /HTTP 404/);
  assert.equal(n, 1);
});

import { parseJourneys, plain, infoRelevant } from '../server/providers/efa.mjs';
const trip = JSON.parse(readFileSync(new URL('./fixtures/efa-trip.json', import.meta.url), 'utf8'));

test('EFA: Verbindungen – Linie, Zeiten, Verspätung, Gleis, Zwischenhalte', () => {
  const js = parseJourneys(trip, 'mvv');
  assert.equal(js.length, 4);
  const [a, , c] = js.map((j) => j.legs[0]);
  assert.deepEqual(a.line, { name: 'S8', product: 'suburban' });
  assert.equal(a.direction, 'Leuchtenbergring');
  assert.equal(a.origin.id, 'mvv|de:09162:2'); assert.equal(a.origin.name, 'Marienplatz');
  assert.equal(a.destination.id, 'mvv|de:09162:5');
  assert.equal(a.depDelay, 0); assert.equal(a.arrDelay, 1);
  assert.equal(a.plannedPlatform, '1'); assert.equal(a.platform, '1');
  assert.equal(a.stopovers.length, 4);
  assert.deepEqual(a.stopovers.map((s) => s.name), ['Marienplatz', 'Isartor', 'Rosenheimer Platz', 'Ostbahnhof']);
  assert.equal(c.line.name, 'S3'); assert.equal(c.depDelay, 3); assert.equal(c.arrDelay, 4);
  assert.equal(c.cancelled, false);
});

test('EFA: Hinweise – Störungsgrund ja, Fahrradhinweise nein, fremde Streckeninfos nicht', () => {
  const js = parseJourneys(trip, 'mvv');
  const s8 = js[0].legs[0].remarks.map((r) => r.summary);
  assert.ok(s8.includes('Reparatur an einer Weiche'));
  assert.ok(!s8.some((x) => /Fahrrad|2\.Kl/.test(x)));
  assert.ok(!s8.some((x) => /Leuchtenbergring|Freising/.test(x)));              // Sperrung beginnt erst hinter dem Ostbahnhof
  assert.ok(!s8.some((x) => /Laim/.test(x)));                                   // Laim liegt nicht auf der Strecke
  const s4 = js[1].legs[0].remarks.map((r) => r.summary);
  assert.ok(!s4.some((x) => /Geltendorf|Puchheim/.test(x)));
  const s5 = js[3].legs[0].remarks.map((r) => r.summary);
  assert.ok(!s5.some((x) => /Aying/.test(x)));
});

test('EFA: HTML wird zu Text', () => {
  assert.equal(plain('<div>Auf Grund von Br&uuml;ckenarbeiten&nbsp;<b>zwei</b></div>'), 'Auf Grund von Brückenarbeiten zwei');
  assert.equal(infoRelevant({ subtitle: 'X', infoLinks: [{ content: 'Nur Bus 100 betroffen' }] }, []), true);
  const names = ['Marienplatz', 'Isartor', 'Rosenheimer Platz', 'Ostbahnhof'];
  const info = (c) => ({ subtitle: 'Hinweis', infoLinks: [{ content: c }] });
  assert.equal(infoRelevant(info('Ersatzverkehr zwischen Isartor und Johanneskirchen.'), names), true);
  assert.equal(infoRelevant(info('Ersatzverkehr zwischen Marienplatz und Ostbahnhof.'), names), true);
  assert.equal(infoRelevant(info('Ersatzverkehr zwischen Ostbahnhof und Johanneskirchen.'), names), false);
  assert.equal(infoRelevant(info('Bauarbeiten am Bahnhof Laim.'), names), false);
  assert.equal(infoRelevant(info('Stellwerksstörung am Ostbahnhof.'), names), true);
});

test('EFA: Anfrage mit Datum in Berliner Ortszeit und ohne Umstieg', async () => {
  let url = '';
  const c = new EfaClient('https://example.test/ng', { key: 'mvv', fetchImpl: async (u) => { url = u; return { ok: true, json: async () => trip }; } });
  const js = await c.journeys({ fromId: 'mvv|de:09162:2', toId: 'mvv|de:09162:5', when: '2026-10-11T08:55:00Z', results: 4 });
  assert.equal(js.length, 4);
  assert.match(url, /name_origin=de%3A09162%3A2/); assert.match(url, /itdDate=20261011/); assert.match(url, /itdTime=1055/);
  assert.match(url, /maxChanges=0/); assert.match(url, /calcNumberOfTrips=4/);
});

import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server/index.mjs';
import { config } from '../server/config.mjs';

test('Durchlauf: Suche und Abfahrten über den Verbund, während die Bahn nicht antwortet', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (u, o) => {
    const url = String(u);
    if (url.startsWith('http://127.0.0.1')) return realFetch(u, o);
    if (url.includes('efa.mvv-muenchen.de') && url.includes('XML_STOPFINDER_REQUEST')) return { ok: true, json: async () => stops };
    if (url.includes('efa.mvv-muenchen.de') && url.includes('XML_TRIP_REQUEST2')) return { ok: true, json: async () => trip };
    throw new Error('Bahn gesperrt');                                   // DB und ÖBB: kein Zugriff
  };
  const dir = await mkdtemp(join(tmpdir(), 'rego-efa-'));
  const cfg = { ...config, provider: 'transport-rest', dataDir: dir, upstream: { ...config.upstream, retries: 0 } };
  const { server } = createApp({ cfg });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const h = { 'x-device': 'testgeraet1234567', 'content-type': 'application/json' };
  try {
    const found = await (await fetch(`${base}/api/stations?q=Marienplatz`, { headers: h })).json();
    assert.equal(found.stations[0].id, 'mvv|de:09162:2');
    assert.equal(found.stations[0].region, 'BY');
    const c = await fetch(`${base}/api/tours`, { method: 'POST', headers: h, body: JSON.stringify({ from: { id: 'mvv|de:09162:2', name: 'Marienplatz', lat: 48.136, lon: 11.577 }, to: { id: 'mvv|de:09162:5', name: 'Ostbahnhof' } }) });
    assert.equal(c.status, 201);
    const s = await (await fetch(`${base}/api/state`, { headers: h })).json();
    assert.equal(s.connection.status, 'ok');
    assert.ok(s.tours[0].departures.length >= 3);
    assert.ok(s.lines.S8 || s.lines.S3);
  } finally { server.close(); globalThis.fetch = realFetch; }
});

import { withFallback } from '../server/providers/index.mjs';
test('Ausweichlogik: gesperrte Quellen werden pausiert und nicht erneut abgewartet', async () => {
  let a = 0, b = 0;
  const primary = { name: 'db', searchStops: async () => { a++; throw new Error('OPS_BLOCKED'); } };
  const fallback = { searchStops: async () => { b++; throw new Error('Zeitüberschreitung'); } };
  const f = withFallback(primary, fallback, { verbose: false });
  assert.equal(f.healthy(), true);
  await assert.rejects(f.searchStops('x'), /Zeitüberschreitung/);
  assert.equal(f.healthy(), false);
  const t0 = Date.now();
  await assert.rejects(f.searchStops('y'), /derzeit nicht erreichbar/);
  assert.ok(Date.now() - t0 < 50);
  assert.deepEqual([a, b], [1, 1]);                         // beim zweiten Mal wurde keine Quelle mehr gefragt
});

import { createProviders } from '../server/providers/index.mjs';
test('Grenzverkehr: MVV-Haltestelle wird für die ÖBB übersetzt, Österreich-Strecken laufen über die ÖBB', async () => {
  const realFetch = globalThis.fetch; const seen = [];
  const leg = { line: { name: 'RB 6', product: 'regional' }, direction: 'Innsbruck', origin: { id: '8002187', name: 'Garmisch-Partenkirchen' }, destination: { id: '8100108', name: 'Innsbruck Hbf' }, plannedDeparture: '2026-10-11T18:02:00+02:00', departure: '2026-10-11T18:02:00+02:00', plannedArrival: '2026-10-11T19:30:00+02:00', arrival: '2026-10-11T19:30:00+02:00', stopovers: [], remarks: [] };
  globalThis.fetch = async (u) => {
    const url = String(u); seen.push(url);
    if (url.includes('oebb.transport.rest/locations')) return { ok: true, json: async () => [
      { type: 'stop', id: '8002188', name: 'Garmisch-Partenkirchen Süd', location: { latitude: 47.45, longitude: 11.1 } },
      { type: 'stop', id: '8002187', name: 'Garmisch-Partenkirchen', location: { latitude: 47.4925, longitude: 11.0863 } }] };
    if (url.includes('oebb.transport.rest/journeys')) return { ok: true, json: async () => ({ journeys: [{ legs: [leg] }] }) };
    if (url.includes('XML_STOPFINDER_REQUEST')) return { ok: true, json: async () => ({ locations: [{ id: 'de:09180:30005', name: 'Garmisch-Partenkirchen, Garmisch-Partenkirchen', type: 'stop', coord: [47.4922, 11.086289], isBest: true }] }) };
    throw new Error('unerwartet ' + url);
  };
  try {
    const p = createProviders({ ...config, provider: 'transport-rest', upstream: { ...config.upstream, retries: 0 } });
    const garmisch = { id: 'mvv|de:09180:30005', name: 'Garmisch-Partenkirchen, Garmisch-Partenkirchen' };       // ohne Koordinaten gespeichert
    const innsbruck = { id: '8100108', name: 'Innsbruck Hbf' };
    const client = p.forTour(garmisch, innsbruck);
    const j = await client.journeys({ from: garmisch, to: innsbruck, fromId: garmisch.id, toId: innsbruck.id, when: new Date().toISOString(), results: 3 });
    assert.equal(j[0].legs[0].line.name, 'RB 6');
    const q = decodeURIComponent(seen.find((x) => x.includes('/journeys')));
    assert.match(q, /from=8002187/); assert.match(q, /to=8100108/);                      // nächstgelegene Haltestelle gewählt, nicht "Süd"
    // Strecke mit einem Ende in Österreich läuft über die ÖBB, rein deutsche über die DB
    assert.equal(p.forTour({ id: '8000261', lat: 48.14, lon: 11.56 }, innsbruck), p.oebb);
    assert.equal(p.forTour({ id: '8000261', lat: 48.14, lon: 11.56 }, { id: '8002078', lat: 48.4, lon: 11.7 }), p.db);
    // zwei verschiedene Verbünde: verständliche Meldung statt Absturz
    assert.equal(p.forTour({ id: 'mvv|de:09162:2', name: 'A' }, { id: 'mvv|de:09162:5', name: 'B' }), p.efas[0]);
  } finally { globalThis.fetch = realFetch; }
});

test('Suche wartet auf langsame Quelle (ÖBB) und markiert Unvollständiges', async () => {
  const { build } = await import('../server/providers/index.mjs');
  const src = (name, ms, list) => ({ name, searchStops: () => new Promise((r) => setTimeout(() => r(list), ms)) });
  const efa = { ...src('efa', 10, [{ id: 'mvv|de:09162:2', name: 'München, Hbf', lat: 48.14, lon: 11.56 }]), key: 'mvv', owns: (id) => String(id).startsWith('mvv|') };
  const oebbStop = { id: '8100002', name: 'Salzburg Hbf', lat: 47.81, lon: 13.04 };
  const p = build(src('db', 10, []), src('oebb', 1200, [oebbStop]), false, [efa]);
  const r = await p.searchStops('Salzburg');
  assert.ok(r.some((s) => s.id === '8100002'), 'ÖBB-Treffer nach 1,2 s muss dabei sein');
  assert.ok(!r.partial);
  const p2 = build(src('db', 10, []), src('oebb', 4000, [oebbStop]), false, [efa]);
  const r2 = await p2.searchStops('Salzburg');
  assert.equal(r2.length, 1);
  assert.equal(r2.partial, true);
});
