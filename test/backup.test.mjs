// Backup sources: if an association does not answer (MoBY in October 2026: HTTP 429 for a day), ÖBB and DB step in for its routes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build, createProviders, createTranslator, spotMatch, withBackup } from '../server/providers/index.mjs';
import { ProviderError } from '../server/providers/hafas.mjs';
import { SourcePause } from '../server/providers/pause.mjs';
import { createService } from '../server/service.mjs';
import { ProfileStore, addTours } from '../server/store/profile.mjs';
import { config } from '../server/config.mjs';

const fine = (body) => ({ ok: true, status: 200, json: async () => body });
const CLOSED = { ok: false, status: 429, headers: { get: (h) => (String(h).toLowerCase() === 'retry-after' ? '86400' : null) }, text: async () => 'This endpoint is not an open data endpoint. Please contact the portal owner' };
const closed = () => new ProviderError('moby: derzeit nicht erreichbar (zu viele Anfragen, Pause noch 24 Std.)', { status: 429, kind: 'network', source: 'moby' });
const trips = (name) => [{ legs: [{ line: { name } }] }];
const fake = (name, impl) => { const f = { name, calls: 0, journeys: async (a) => { f.calls++; return impl(a); } }; return f; };

// ---------- Names of stops across sources ----------

test('Names: what is special about a stop has to be in the other name – the place and "Bahnhof" do not count', () => {
  // the same place
  assert.equal(spotMatch('München, Neuperlach Süd', 'München Neuperlach Süd'), 0);
  assert.equal(spotMatch('München, Neuperlach Süd', 'Neuperlach Süd'), 0);
  assert.equal(spotMatch('Neuperlach Süd', 'München Neuperlach Süd'), 1);                   // the other adds only its place name
  assert.equal(spotMatch('Rosenheim, Rosenheim Bahnhof', 'Rosenheim Hbf'), 0);
  assert.equal(spotMatch('Lindau (Bodensee), Lindau Hbf', 'Lindau (Bodensee) Hbf'), 0);
  assert.equal(spotMatch('München, Hauptbahnhof', 'München Hbf'), 0);
  assert.equal(spotMatch('München, Ostbahnhof', 'München Ost'), 0);
  assert.equal(spotMatch('Freising', 'Freising'), 0);
  assert.equal(spotMatch('Freising, Bahnhof', 'Freising'), 0);
  assert.equal(spotMatch('Garching-Forschungszentrum', 'Garching, Forschungszentrum'), 0);
  assert.equal(spotMatch('Freilassing (Obb), Freilassing', 'Freilassing'), 0);
  assert.equal(spotMatch('Landshut(Bay)Hbf', 'Landshut (Bay) Hbf'), 0);
  // names as the sources really deliver them (MVV: "Ort, Haltestelle"; ÖBB: "Freising", "Neufahrn(b Freising)")
  assert.equal(spotMatch('Freising, Freising', 'Freising'), 0);
  assert.equal(spotMatch('München, München Hbf', 'München Hbf'), 0);
  assert.equal(spotMatch('München, Münchner Freiheit', 'München Münchner Freiheit'), 0);
  assert.equal(spotMatch('Freising, Flughafen München', 'Flughafen München'), 0);
  // not the same place: a bus stop is not the station next to it, a second station of the town is not the first
  assert.equal(spotMatch('Freising, Freising', 'Neufahrn(b Freising)'), -1);                // a single word next door is not the station
  assert.equal(spotMatch('Freising, Freising', 'Marienplatz'), -1);
  assert.equal(spotMatch('Freising, Freising', 'Flughafen Briefzentrum, Freising'), -1);
  assert.equal(spotMatch('München, Neuperlach Süd', 'München, Klinikum Neuperlach'), -1);
  assert.equal(spotMatch('Freising, Marienplatz', 'Freising'), -1);
  assert.equal(spotMatch('Freising', 'Freising, Marienplatz'), -1);
  assert.equal(spotMatch('Freising', 'Freising Süd'), -1);
  assert.equal(spotMatch('Rosenheim, Rosenheim Bahnhof', 'Rosenheim, Kaiserstraße'), -1);
  assert.equal(spotMatch('München, Ostbahnhof', 'München Hbf'), -1);
  assert.equal(spotMatch('München, Hauptbahnhof', 'München Ost'), -1);
  assert.equal(spotMatch('München, Neuperlach Süd', 'München, Neuperlach Zentrum'), -1);
});

test('Translation (strict): no guess without coordinates, a name that does not fit is no hit, a refused stop is left alone for a while', async () => {
  let t = 1000, asked = 0; const told = [];
  const target = { name: 'oebb', searchStops: async () => { asked++; return [{ id: '8000320', name: 'Rosenheim', lat: 47.8566, lon: 12.1190 }]; } };
  const tr = createTranslator({ stop: async () => { throw new Error('the closed association must not be asked for coordinates'); } }, { strict: true, now: () => t, log: (m) => told.push(m) });
  await assert.rejects(tr({ id: 'moby|a', name: 'Rosenheim' }, target), /Koordinaten/);
  assert.equal(asked, 0);
  const bus = { id: 'moby|b', name: 'Rosenheim, Salinplatz', lat: 47.8580, lon: 12.1200 };      // 150 m from the station, but not the station
  await assert.rejects(tr(bus, target), /nicht auffindbar/);
  const first = asked; assert.ok(first >= 1);
  await assert.rejects(tr(bus, target), /nicht auffindbar/);
  assert.equal(asked, first);                                                                  // asked again only after a quarter of an hour
  t += 16 * 60e3;
  await assert.rejects(tr(bus, target), /nicht auffindbar/);
  assert.ok(asked > first);
  // the operator can see what was refused and what was close by, once per stop
  assert.deepEqual(told, [
    'Ausweichquelle oebb: „Rosenheim“ hat keine gespeicherten Koordinaten',
    'Ausweichquelle oebb: „Rosenheim, Salinplatz“ ist keiner Haltestelle sicher zuzuordnen (in der Nähe: „Rosenheim“)',
  ]);
  assert.equal(await tr({ id: 'moby|c', name: 'Rosenheim', lat: 47.8565, lon: 12.1189 }, target), '8000320');
  // not strict (a route across the border): as before, the nearest stop counts, even without a matching name
  const loose = createTranslator({ stop: async () => ({}) });
  assert.equal(await loose(bus, target), '8000320');
});

test('Translation: the same name is preferred to a nearer stop with a different one', async () => {
  const target = { name: 'oebb', searchStops: async () => [{ id: 'near', name: 'Rosenheim, Kaiserstraße', lat: 47.8565, lon: 12.1189 }, { id: 'station', name: 'Rosenheim', lat: 47.8590, lon: 12.1210 }] };
  const tr = createTranslator({ stop: async () => ({}) }, { strict: true });
  assert.equal(await tr({ id: 'moby|c', name: 'Rosenheim', lat: 47.8565, lon: 12.1189 }, target), 'station');
});

test('Translation: routes that start at the same moment share one search per stop', async () => {
  let asked = 0;
  const target = { name: 'oebb', searchStops: async () => { asked++; await new Promise((r) => setTimeout(r, 20)); return [{ id: '8000320', name: 'Rosenheim', lat: 47.8566, lon: 12.1190 }]; } };
  const tr = createTranslator({ stop: async () => ({}) });
  const s = { id: 'moby|c', name: 'Rosenheim', lat: 47.8565, lon: 12.1189 };
  assert.deepEqual(await Promise.all([tr(s, target), tr(s, target), tr(s, target)]), ['8000320', '8000320', '8000320']);
  assert.equal(asked, 1);
});

// ---------- The backup itself ----------

test('Backup: the association answers – the backups stay out; it answers but does not know the route – nobody else guesses', async () => {
  const moby = fake('moby', () => trips('S1')), oebb = fake('oebb', () => trips('RB 54'));
  const w = withBackup(moby, [oebb]);
  assert.equal((await w.journeys({}))[0].legs[0].line.name, 'S1');
  assert.equal(oebb.calls, 0);
  moby.journeys = async () => { throw new ProviderError('moby: Haltestelle unbekannt', { kind: 'http' }); };
  await assert.rejects(w.journeys({}), /Haltestelle unbekannt/);
  assert.equal(oebb.calls, 0);
});

test('Backup: ÖBB first, DB only if ÖBB fails; an answer without trips ends the search; without trips the error of the association stays', async () => {
  const lines = [];
  const moby = fake('moby', () => { throw closed(); }), oebb = fake('oebb', () => trips('RB 54')), db = fake('db', () => trips('RE 1'));
  const w = withBackup(moby, [oebb, db], (m) => lines.push(m));
  assert.equal((await w.journeys({}))[0].legs[0].line.name, 'RB 54');
  await w.journeys({});
  assert.equal(db.calls, 0);
  assert.equal(lines.length, 1); assert.match(lines[0], /oebb übernimmt/);                       // one line per outage, not one per request
  oebb.journeys = async () => { throw new ProviderError('oebb: Zeitüberschreitung', { kind: 'network' }); };
  assert.equal((await w.journeys({}))[0].legs[0].line.name, 'RE 1');
  oebb.journeys = async () => [];
  db.calls = 0;
  await assert.rejects(w.journeys({}), (e) => e.status === 429 && e.source === 'moby');          // the error says who is closed
  assert.equal(db.calls, 0);                                                                     // ÖBB knows the trains: DB would say the same
  oebb.journeys = async () => { throw new ProviderError('oebb: x', { kind: 'network' }); };
  db.journeys = async () => { throw new ProviderError('db: y', { kind: 'network' }); };
  await assert.rejects(w.journeys({}), (e) => e.status === 429 && e.source === 'moby');
  moby.journeys = async () => trips('S1');                                                       // the association is back
  assert.equal((await w.journeys({}))[0].legs[0].line.name, 'S1');
  assert.equal(lines.length, 2); assert.match(lines[1], /antwortet wieder/);
});

// ---------- Which routes get a backup ----------

const efaFake = (key, impl) => ({ key, name: key, owns: (id) => String(id).startsWith(`${key}|`), healthy: () => true, searchStops: async () => [], stop: async (id) => ({ id, lines: [] }), journeys: async (a) => impl(a) });
const ROSENHEIM = { id: 'moby|de:09163:9', name: 'Rosenheim', lat: 47.8565, lon: 12.1189 };
const TRAUNSTEIN = { id: 'moby|de:09189:3', name: 'Traunstein', lat: 47.8686, lon: 12.6436 };
const RAIL_STOPS = [
  { id: '8000320', name: 'Rosenheim', lat: 47.8566, lon: 12.1190 }, { id: '8099001', name: 'Rosenheim, Kaiserstraße', lat: 47.8570, lon: 12.1195 },
  { id: '8000051', name: 'Traunstein', lat: 47.8690, lon: 12.6430 }, { id: '8000152', name: 'Freising', lat: 48.4003, lon: 11.7367 },
];
const rail = (name, line) => {
  const r = { name, asked: [], searches: 0, journeys: async (a) => { r.asked.push([a.fromId, a.toId]); return trips(line); } };
  r.searchStops = async (q) => { r.searches++; const w = String(q).split(/[\s,]+/)[0].toLowerCase(); return RAIL_STOPS.filter((s) => s.name.toLowerCase().includes(w)); };
  return r;
};

test('Backup routes: stops of one association – ÖBB takes over with the translated stops; without coordinates or with a stop that does not fit nobody guesses', async () => {
  const moby = efaFake('moby', () => { throw closed(); });
  const oebb = rail('oebb', 'RB 54'), db = rail('db', 'RE 1');
  const p = build(db, oebb, false, [moby]);
  const ask = (from, to) => p.forTourSafe(from, to).journeys({ from, to, fromId: from.id, toId: to.id, when: new Date().toISOString(), results: 5 });
  assert.equal((await ask(ROSENHEIM, TRAUNSTEIN))[0].legs[0].line.name, 'RB 54');
  assert.deepEqual(oebb.asked, [['8000320', '8000051']]);
  assert.equal(db.asked.length, 0);
  // no coordinates: not a guess by name
  oebb.asked.length = 0;
  await assert.rejects(ask({ id: 'moby|de:09187:5', name: 'Prien am Chiemsee' }, TRAUNSTEIN), (e) => e.status === 429 && e.source === 'moby');
  // a bus stop with a station nearby: not the station
  await assert.rejects(ask({ id: 'moby|de:09163:77', name: 'Rosenheim, Salinplatz', lat: 47.8580, lon: 12.1200 }, TRAUNSTEIN), (e) => e.status === 429);
  assert.equal(oebb.asked.length, 0); assert.equal(db.asked.length, 0);
});

test('Backup routes: between two associations (MVV and MoBY) both stops are translated', async () => {
  const mvv = efaFake('mvv', () => trips('S1')), moby = efaFake('moby', () => { throw closed(); });
  moby.searchStops = async () => { throw closed(); };                                  // MoBY is closed: it cannot translate the MVV stop either
  const oebb = rail('oebb', 'RB 54'), db = rail('db', 'RE 1');
  const p = build(db, oebb, false, [mvv, moby]);
  const freising = { id: 'mvv|de:09178:1', name: 'Freising', lat: 48.4004, lon: 11.7366 };
  for (const [from, to] of [[freising, TRAUNSTEIN], [TRAUNSTEIN, freising]]) {
    const j = await p.forTourSafe(from, to).journeys({ from, to, fromId: from.id, toId: to.id, when: new Date().toISOString(), results: 5 });
    assert.equal(j[0].legs[0].line.name, 'RB 54');
  }
  assert.deepEqual(oebb.asked, [['8000152', '8000051'], ['8000051', '8000152']]);
  // MoBY is the one asked for such a route (it is the wider one); if it is open nothing changes
  moby.journeys = async () => trips('RE 5');
  moby.searchStops = async () => [{ id: 'moby|de:09178:1', name: 'Freising', lat: 48.4003, lon: 11.7367 }];
  const j2 = await p.forTourSafe(freising, TRAUNSTEIN).journeys({ from: freising, to: TRAUNSTEIN, fromId: freising.id, toId: TRAUNSTEIN.id, when: new Date().toISOString() });
  assert.equal(j2[0].legs[0].line.name, 'RE 5'); assert.equal(oebb.asked.length, 2);
});

test('Backup routes: everything else stays as it was', async () => {
  const moby = efaFake('moby', () => { throw closed(); });
  const p = build(rail('db', 'RE 1'), rail('oebb', 'RB 54'), false, [moby]);
  const munich = { id: '8000261', name: 'München Hbf', lat: 48.1402, lon: 11.5586 };
  assert.equal(p.forTourSafe(munich, { id: '8002078', name: 'Freising', lat: 48.4, lon: 11.7 }), p.db);                // no association: the railway source itself
  assert.equal(p.forTourSafe(ROSENHEIM, munich), p.forTour(ROSENHEIM, munich));                                       // one end in the association: translated stop, as before
});

// ---------- Run-through with the service ----------

const efaLeg = (from, to, dep, arr, number) => ({
  origin: { id: `${from}:1`, name: 'Von', type: 'platform', coord: [47.85, 12.12], parent: { id: from, name: 'Von', type: 'stop', coord: [47.85, 12.12] }, departureTimePlanned: dep, departureTimeEstimated: dep, properties: { platformName: '1', plannedPlatformName: '1' } },
  destination: { id: `${to}:1`, name: 'Nach', type: 'platform', coord: [47.87, 12.64], parent: { id: to, name: 'Nach', type: 'stop', coord: [47.87, 12.64] }, arrivalTimePlanned: arr, arrivalTimeEstimated: arr, properties: { platformName: '2', plannedPlatformName: '2' } },
  transportation: { id: 'x', name: number, number, product: { class: 0, name: 'Zug' }, destination: { name: 'Traunstein' } },
  realtimeStatus: ['MONITORED'], stopSequence: [],
});
const hafasStop = (s) => ({ type: 'stop', id: s.id, name: s.name, location: { latitude: s.lat, longitude: s.lon } });

test('Run-through: MoBY asks for a day of peace – routes with a fitting stop run on ÖBB, the closed source is asked once, the others say why they are dark', async () => {
  const realFetch = globalThis.fetch, realLog = console.log;
  const clock = { t: Date.parse('2026-10-12T07:00:00+02:00') }; const now = () => clock.t;
  let moby = 0, mobyOpen = false, searches = 0, dbJourneys = 0; const pairs = [], lines = [];
  const iso = (min) => new Date(clock.t + min * 60e3).toISOString();
  globalThis.fetch = async (u) => {
    const url = String(u), q = new URL(url).searchParams;
    if (url.includes('moby.test')) {
      moby++;
      return mobyOpen ? fine({ journeys: [8, 33].map((m) => ({ legs: [efaLeg('de:09163:9', 'de:09189:3', iso(m), iso(m + 30), 'RE5')] })) }) : CLOSED;
    }
    if (url.includes('transport.rest/locations')) {
      searches++;
      const w = String(q.get('query')).split(/[\s,]+/)[0].toLowerCase();
      return fine(RAIL_STOPS.filter((s) => s.name.toLowerCase().includes(w)).map(hafasStop));
    }
    if (url.includes('oebb.transport.rest/journeys')) {
      pairs.push(`${q.get('from')}>${q.get('to')}`);
      return fine({ journeys: [10, 35].map((m) => ({ legs: [{ line: { name: 'RB 54', product: 'regional' }, direction: 'Traunstein', origin: hafasStop(RAIL_STOPS[0]), destination: hafasStop(RAIL_STOPS[2]), plannedDeparture: iso(m), departure: iso(m), departureDelay: 0, plannedArrival: iso(m + 30), arrival: iso(m + 30), arrivalDelay: 0, departurePlatform: '2' }] })) });
    }
    if (url.includes('db.transport.rest/journeys')) { dbJourneys++; return fine({ journeys: [] }); }
    throw new Error(`unexpected ${url}`);
  };
  console.log = (...a) => { lines.push(a.join(' ')); };
  try {
    const dir = await mkdtemp(join(tmpdir(), 'rego-backup-'));
    const store = new ProfileStore(dir, now); const dev = 'ausweichquelle12345';
    const sched = { days: ['Mo', 'Di', 'Mi', 'Do', 'Fr'], departAfter: '06:30', departUntil: '09:00' };
    const bus = { id: 'moby|de:09163:77', name: 'Rosenheim, Salinplatz', lat: 47.8580, lon: 12.1200 };
    await store.update(dev, (p) => {
      addTours(p, { from: ROSENHEIM, to: TRAUNSTEIN, schedule: sched });                                       // fits: ÖBB knows both stations
      addTours(p, { from: bus, to: TRAUNSTEIN, schedule: sched });                                              // a bus stop next to the station: not the station
      addTours(p, { from: { id: 'moby|de:09187:5', name: 'Prien am Chiemsee' }, to: TRAUNSTEIN, schedule: sched });   // stored without coordinates
    });
    const [ok, busy, blind] = (await store.load(dev)).tours.map((x) => x.id);
    const cfg = { ...config, provider: 'transport-rest', verbose: true, tourDeadlineMs: 3000, upstream: { ...config.upstream, efa: [{ key: 'moby', url: 'https://moby.test/efa' }], retries: 0 } };
    const providers = createProviders(cfg, now);
    providers.efas[0].pause = new SourcePause({ now });
    const service = createService({ config: cfg, store, now, providers });
    const of = (s, id) => s.tours.find((x) => x.id === id);
    const note = 'MoBY lässt gerade keine Abfragen zu. ReGo fragt später wieder an.';

    let s = await service.getState(dev);
    assert.ok(of(s, ok).departures.length >= 1 && !of(s, ok).stale);
    assert.equal(of(s, ok).departures[0].lineId, 'RB54');                                                       // from ÖBB
    for (const id of [busy, blind]) { assert.equal(of(s, id).stale, true); assert.equal(of(s, id).view.big, 'Keine Daten'); assert.equal(of(s, id).view.sub, note); }
    assert.equal(s.connection.status, 'ok');                                                                    // one route with data: no banner
    const first = moby; assert.ok(first >= 1 && first <= 3);
    assert.deepEqual([...new Set(pairs)], ['8000320>8000051']);                                                 // the other two never reached the railway
    assert.equal(dbJourneys, 0);
    assert.equal(lines.filter((l) => /oebb übernimmt/.test(l)).length, 1);
    assert.equal(lines.filter((l) => /Abruf fehlgeschlagen/.test(l)).length, 0);
    assert.equal(await service.hasDirect(ROSENHEIM, TRAUNSTEIN), true);                                         // saving a route works the same way

    // half a minute later: the stops that did not fit are not searched again
    const searched = searches;
    clock.t += 40e3; s = await service.getState(dev);
    assert.equal(searches, searched);
    assert.equal(of(s, ok).departures[0].lineId, 'RB54');

    for (const hours of [1, 6, 12]) { clock.t += hours * 3600e3; s = await service.getState(dev); }
    assert.equal(moby, first);                                                                                  // 19 hours: not one request to the source that asked for a day
    assert.ok(of(s, ok).departures.length >= 1 && !of(s, ok).stale);
    clock.t += 6 * 3600e3 + 120e3; s = await service.getState(dev);                                            // 25 hours: one test request
    assert.equal(moby, first + 1);
    assert.ok(of(s, ok).departures.length >= 1 && !of(s, ok).stale);
    assert.equal(lines.filter((l) => /oebb übernimmt/.test(l)).length, 1);                                       // still the same outage: no second line

    // MoBY opens again: the test request works, the routes are served by the association again
    mobyOpen = true; clock.t += 25 * 3600e3; s = await service.getState(dev);
    assert.equal(of(s, ok).departures[0].lineId, 'RE5');
    assert.equal(lines.filter((l) => /antwortet wieder/.test(l)).length, 1);
    clock.t += 70e3; s = await service.getState(dev);                                                           // (the cache leaves a failed route alone for up to a minute)
    for (const id of [ok, busy, blind]) { assert.ok(of(s, id).departures.length >= 1 && !of(s, id).stale); assert.equal(of(s, id).departures[0].lineId, 'RE5'); }
  } finally { globalThis.fetch = realFetch; console.log = realLog; }
});
