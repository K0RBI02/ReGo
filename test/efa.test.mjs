import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { EfaClient, parseStops } from '../server/providers/efa.mjs';

const stops = JSON.parse(readFileSync(new URL('./fixtures/efa-stops.json', import.meta.url), 'utf8'));

test('EFA: stop search – best hit first, prefix, coordinates', () => {
  const r = parseStops(stops, 'mvv');
  assert.equal(r.length, 8);
  assert.equal(r[0].id, 'mvv|de:09162:2');
  assert.equal(r[0].name, 'München, Marienplatz');
  assert.equal(r[0].lat, 48.136436);
  assert.equal(r[0].lon, 11.577658);
});

test('EFA: client queries rapidJSON and knows its IDs', async () => {
  let url = '';
  const c = new EfaClient('https://example.test/mobile/', { key: 'mvv', fetchImpl: async (u) => { url = u; return { ok: true, json: async () => stops }; } });
  const r = await c.searchStops('Marienplatz');
  assert.match(url, /^https:\/\/example\.test\/mobile\/XML_STOPFINDER_REQUEST\?/);
  assert.match(url, /outputFormat=rapidJSON/);
  assert.match(url, /name_sf=Marienplatz/);
  assert.ok(c.owns(r[0].id)); assert.equal(c.raw(r[0].id), 'de:09162:2');
  assert.equal(c.owns('8000261'), false);
});

test('EFA: HTTP error 404 is not retried', async () => {
  let n = 0;
  const c = new EfaClient('https://example.test', { fetchImpl: async () => { n++; return { ok: false, status: 404 }; } });
  await assert.rejects(c.searchStops('x'), /HTTP 404/);
  assert.equal(n, 1);
});

import { parseJourneys, plain, infoRelevant } from '../server/providers/efa.mjs';
const trip = JSON.parse(readFileSync(new URL('./fixtures/efa-trip.json', import.meta.url), 'utf8'));

test('EFA: connections – line, times, delay, platform, intermediate stops', () => {
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

test('EFA: remarks – disruption reason yes, bicycle notes no, line info of other routes no', () => {
  const js = parseJourneys(trip, 'mvv');
  const s8 = js[0].legs[0].remarks.map((r) => r.summary);
  assert.ok(s8.includes('Reparatur an einer Weiche'));
  assert.ok(!s8.some((x) => /Fahrrad|2\.Kl/.test(x)));
  assert.ok(!s8.some((x) => /Leuchtenbergring|Freising/.test(x)));              // closure only begins beyond Ostbahnhof
  assert.ok(!s8.some((x) => /Laim/.test(x)));                                   // Laim is not on the route
  const s4 = js[1].legs[0].remarks.map((r) => r.summary);
  assert.ok(!s4.some((x) => /Geltendorf|Puchheim/.test(x)));
  const s5 = js[3].legs[0].remarks.map((r) => r.summary);
  assert.ok(!s5.some((x) => /Aying/.test(x)));
});

test('EFA: HTML becomes text', () => {
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

test('EFA: request with date in Berlin local time and without transfer', async () => {
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

test('Run-through: search and departures via the association while the railway does not answer', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (u, o) => {
    const url = String(u);
    if (url.startsWith('http://127.0.0.1')) return realFetch(u, o);
    if (url.includes('efa.mvv-muenchen.de') && url.includes('XML_STOPFINDER_REQUEST')) return { ok: true, json: async () => stops };
    if (url.includes('efa.mvv-muenchen.de') && url.includes('XML_TRIP_REQUEST2')) return { ok: true, json: async () => trip };
    throw new Error('railway blocked');                                   // DB and ÖBB: no access
  };
  const dir = await mkdtemp(join(tmpdir(), 'rego-efa-'));
  const cfg = { ...config, provider: 'transport-rest', dataDir: dir, upstream: { ...config.upstream, retries: 0 } };
  const { server } = createApp({ cfg, now: () => Date.parse('2026-10-11T08:55:00Z') });   // fixed point in time before the trips of the test data
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
test('Fallback logic: blocked sources are paused and not waited for again', async () => {
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
  assert.deepEqual([a, b], [1, 1]);                         // the second time no source was asked any more
});

import { createProviders } from '../server/providers/index.mjs';
test('Cross-border: MVV stop is translated for ÖBB, Austria routes run via ÖBB', async () => {
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
    const garmisch = { id: 'mvv|de:09180:30005', name: 'Garmisch-Partenkirchen, Garmisch-Partenkirchen' };       // stored without coordinates
    const innsbruck = { id: '8100108', name: 'Innsbruck Hbf' };
    const client = p.forTour(garmisch, innsbruck);
    const j = await client.journeys({ from: garmisch, to: innsbruck, fromId: garmisch.id, toId: innsbruck.id, when: new Date().toISOString(), results: 3 });
    assert.equal(j[0].legs[0].line.name, 'RB 6');
    const q = decodeURIComponent(seen.find((x) => x.includes('/journeys')));
    assert.match(q, /from=8002187/); assert.match(q, /to=8100108/);                      // nearest stop chosen, not "Süd"
    // A route with one end in Austria runs via ÖBB, purely German ones via DB
    assert.equal(p.forTour({ id: '8000261', lat: 48.14, lon: 11.56 }, innsbruck), p.oebb);
    assert.equal(p.forTour({ id: '8000261', lat: 48.14, lon: 11.56 }, { id: '8002078', lat: 48.4, lon: 11.7 }), p.db);
    // two different associations: understandable message instead of a crash
    assert.equal(p.forTour({ id: 'mvv|de:09162:2', name: 'A' }, { id: 'mvv|de:09162:5', name: 'B' }), p.efas[0]);
  } finally { globalThis.fetch = realFetch; }
});

test('Search waits for a slow source (ÖBB) and marks incomplete results', async () => {
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

test('regionOf: unknown ID with coordinates in Austria -> AT', async () => {
  const { regionOf } = await import('../server/lib/geo.mjs');
  assert.equal(regionOf({ id: '455000', lat: 47.81, lon: 13.04 }), 'AT');
  assert.equal(regionOf({ id: '8000261', lat: 48.14, lon: 11.56 }), 'BY');
  assert.equal(regionOf({ id: 'xyz' }), '');
});

test('summaryOf: truncated subtitle -> first whole sentence; line label without parenthetical', async () => {
  const { summaryOf } = await import('../server/providers/efa.mjs');
  const { lineLabel } = await import('../server/lib/lines.mjs');
  const full = 'Auf Grund von Brückenbauarbeiten in Großhelfendorf kommt es von Freitag, 24. Juli 2026 ab 20:50 Uhr durchgehend bis Freitag, 16. Oktober 2026 zu Ersatzverkehr. Bitte beachten Sie die Aushänge.';
  assert.equal(summaryOf('Auf Grund von Brückenbauarbeiten in Großhelfendorf kommt es von Freitag, 24. Juli 2026 ab 20:50 Uhr durchgehend bis Frei', full), full.split('. Bitte')[0] + '.');
  assert.equal(summaryOf('Kurzer Hinweis.', 'Kurzer Hinweis. Mehr Text hier.'), 'Kurzer Hinweis.');
  assert.equal(lineLabel('RE5(Zug-Nr.79030)'), 'RE5');
  assert.equal(lineLabel('S 1'), 'S1');
});

test('Ranking of the stop search: exact name and station first', async () => {
  const { parseStops } = await import('../server/providers/efa.mjs');
  const data = { locations: [
    { id: 'at:42:6231', name: 'Rosenheim (Baldramsdorf), Rosenheim', type: 'stop', isBest: true, coord: [46.8, 13.4] },
    { id: 'de:09163:9', name: 'Rosenheim', type: 'stop', coord: [47.85, 12.12] },
    { id: 'de:09163:376', name: 'Rosenheim, WEKO', type: 'stop', coord: [47.86, 12.1] }] };
  assert.equal(parseStops(data, 'moby', 'Rosenheim')[0].id, 'moby|de:09163:9');
  const d2 = { locations: [{ id: 'a', name: 'Berchtesgaden, Erika', type: 'stop' }, { id: 'b', name: 'Berchtesgaden Hbf', type: 'stop' }] };
  assert.equal(parseStops(d2, 'moby', 'Berchtesgaden')[0].id, 'moby|b');
});

test('two associations: connection via moby with translated MVV stop; Austrian end with ÖBB fallback', async () => {
  const { build } = await import('../server/providers/index.mjs');
  const mk = (key, stopsReturn, journeysReturn) => ({ key, name: key, owns: (id) => String(id).startsWith(key + '|'), searchStops: async () => stopsReturn, stop: async (id) => ({ id, lat: 48.14, lon: 11.56, lines: [] }), journeys: async (a) => { mk.calls.push([key, a.fromId, a.toId]); return journeysReturn; } });
  mk.calls = [];
  const mvv = mk('mvv', [], []);
  const moby = mk('moby', [{ id: 'moby|de:09162:2', name: 'München Hbf', lat: 48.14, lon: 11.56 }], [{ legs: [{ line: { name: 'RE 5' } }] }]);
  const oebb = { name: 'oebb', searchStops: async () => [], stop: async (id) => ({ id, lines: [] }), journeys: async (a) => { mk.calls.push(['oebb', a.fromId, a.toId]); return [{ legs: [{ line: { name: 'RJX' } }] }]; } };
  const p = build({ name: 'db' }, oebb, false, [mvv, moby]);
  const c = p.forTour({ id: 'mvv|de:09162:2', name: 'München Hbf', lat: 48.14, lon: 11.56 }, { id: 'moby|de:09163:9', name: 'Rosenheim', lat: 47.85, lon: 12.12 });
  const j = await c.journeys({ from: { id: 'mvv|de:09162:2', name: 'München Hbf', lat: 48.14, lon: 11.56 }, to: { id: 'moby|de:09163:9' }, fromId: 'mvv|de:09162:2', toId: 'moby|de:09163:9', when: new Date().toISOString() });
  assert.equal(j[0].legs[0].line.name, 'RE 5');
  assert.deepEqual(mk.calls[0], ['moby', 'moby|de:09162:2', 'moby|de:09163:9']);
  // moby does not know the route to Austria -> ÖBB
  moby.journeys = async () => [];
  const sbg = { id: 'moby|at:45:50002', name: 'Salzburg Hbf', lat: 47.81, lon: 13.04 };
  oebb.searchStops = async () => [{ id: '8100002', name: 'Salzburg Hbf', lat: 47.8128, lon: 13.0457 }, { id: '8000261', name: 'München Hbf', lat: 48.1402, lon: 11.5586 }];
  const mobyStop = { id: 'moby|de:09162:2', name: 'München Hbf', lat: 48.14, lon: 11.56 };
  const c2 = p.forTourSafe(mobyStop, sbg);
  const j2 = await c2.journeys({ from: mobyStop, to: sbg, fromId: mobyStop.id, toId: sbg.id, when: new Date().toISOString() });
  assert.equal(j2[0].legs[0].line.name, 'RJX');
});

test('Overall ranking: station before side stops; ÖBB names without train-number suffix', async () => {
  const { build } = await import('../server/providers/index.mjs');
  const { normJourney } = await import('../server/providers/hafas.mjs');
  const efa = { key: 'moby', name: 'moby', owns: (id) => String(id).startsWith('moby|'), searchStops: async () => [{ id: 'moby|a', name: 'Kempten (Allgäu) Ost', lat: 47.72, lon: 10.33 }, { id: 'moby|b', name: 'Kempten (Bingen)', lat: 50, lon: 7 }] };
  const oebb = { name: 'oebb', searchStops: async () => [{ id: '8000189', name: 'Kempten (Allgäu) Hbf', lat: 47.7233, lon: 10.3167 }] };
  const r = await build({ name: 'db', healthy: () => false, searchStops: async () => [] }, oebb, false, [efa]).searchStops('Kempten');
  assert.equal(r[0].id, '8000189');
  const j = normJourney({ legs: [{ line: { name: 'RE5 (Zug-Nr. 79037)', product: 'regional' }, origin: { id: '1', name: 'A' }, destination: { id: '2', name: 'B' }, departure: '2026-10-11T19:36:00+02:00', plannedDeparture: '2026-10-11T19:36:00+02:00', arrival: '2026-10-11T19:46:00+02:00', plannedArrival: '2026-10-11T19:46:00+02:00' }] });
  assert.equal(j.legs[0].line.name, 'RE5');
});

test('Search: "Lindau Hb" finds Lindau Hbf via the search for the first word', async () => {
  const { EfaClient, rankOf } = await import('../server/providers/efa.mjs');
  const seen = [];
  const fetchImpl = async (url) => {
    const q = new URL(url).searchParams.get('name_sf'); seen.push(q);
    const locations = q === 'Lindau Hb' ? [{ id: 'h', name: 'Lindau (Bodensee), Hochbuch', type: 'stop' }]
      : [{ id: 'h', name: 'Lindau (Bodensee), Hochbuch', type: 'stop' }, { id: 'b', name: 'Lindau (Bodensee) Hbf', type: 'stop' }];
    return { ok: true, json: async () => ({ locations }) };
  };
  const c = new EfaClient('https://x.test/efa', { key: 'moby', fetchImpl, retries: 0, timeoutMs: 1000, userAgent: 't' });
  const r = await c.searchStops('Lindau Hb');
  assert.deepEqual(seen.sort(), ['Lindau', 'Lindau Hb']);
  assert.equal(r[0].id, 'moby|b');
  assert.ok(rankOf('Lindau (Bodensee) Hbf', 'Lindau Hb') < rankOf('Lindau (Bodensee), Hochbuch', 'Lindau Hb'));
});

test('Search: railway sources only from 4 characters and only if the association does not know an exact station', async () => {
  const { build } = await import('../server/providers/index.mjs');
  let asked = 0;
  const rail = { name: 'oebb', searchStops: async () => { asked++; return [{ id: '8100002', name: 'Salzburg Hbf', lat: 47.81, lon: 13.04 }]; } };
  const efa = (list) => ({ key: 'moby', name: 'moby', owns: (id) => String(id).startsWith('moby|'), searchStops: async () => list });
  const db = { name: 'db', healthy: () => false, searchStops: async () => [] };
  await build(db, rail, false, [efa([{ id: 'moby|x', name: 'Salzburg Hbf', lat: 47.81, lon: 13.04 }])]).searchStops('Salzburg');
  assert.equal(asked, 0, 'Verbund kennt den Hbf -> ÖBB nicht fragen');
  await build(db, rail, false, [efa([])]).searchStops('Sal');
  assert.equal(asked, 0, 'unter 4 Zeichen -> ÖBB nicht fragen');
  const r = await build(db, rail, false, [efa([{ id: 'moby|y', name: 'Lindau, Hochbuch', lat: 47.5, lon: 9.7 }])]).searchStops('Lindau Hbf');
  assert.ok(asked >= 1);
  assert.ok(r.some((s) => s.id === '8100002'));
});

test('Translation: "Freilassing (Obb), Freilassing" is found via a simpler spelling', async () => {
  const { createTranslator } = await import('../server/providers/index.mjs');
  const qs = [];
  const target = { name: 'oebb', searchStops: async (q) => { qs.push(q); return q === 'Freilassing' ? [{ id: '8100050', name: 'Freilassing', lat: 47.8394, lon: 12.9777 }] : []; } };
  const tr = createTranslator({ stop: async () => ({}) });
  const id = await tr({ id: 'moby|de:09189:1', name: 'Freilassing (Obb), Freilassing', lat: 47.8395, lon: 12.9778 }, target);
  assert.equal(id, '8100050');
  assert.ok(qs.length >= 2);
});

test('Search: "Lindau Hbf" shows the island station as Hbf', async () => {
  const { build } = await import('../server/providers/index.mjs');
  const efa = { key: 'moby', name: 'moby', owns: (id) => String(id).startsWith('moby|'), searchStops: async (q) => (/insel/i.test(q) ? [{ id: 'moby|de:09776:1546', name: 'Lindau (Bodensee), Lindau Inselbahnhof', lat: 47.5447, lon: 9.6813 }] : [{ id: 'moby|at:43:4806', name: 'Sommerein, Lindau', lat: 48, lon: 16 }]) };
  const oebb = { name: 'oebb', searchStops: async () => [] };
  const p = build({ name: 'db', healthy: () => false, searchStops: async () => [] }, oebb, false, [efa]);
  const r = await p.searchStops('Lindau Hbf');
  assert.equal(r[0].id, 'moby|de:09776:1546');
  assert.equal(r[0].name, 'Lindau (Bodensee), Lindau Hbf');
  const r2 = await p.searchStops('Lindau');
  assert.ok(r2.every((x) => x.id !== 'moby|de:09776:1546'), 'ohne Hbf-Wunsch keine Sonderbehandlung');
});
