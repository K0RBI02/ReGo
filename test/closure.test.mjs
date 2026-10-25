// Days with closures (S-Bahn Stammstrecke closed, October 2026): EFA applies the limit on transfers only after it has picked its best trips. When the
// network is in a bad state those need more transfers than allowed, nothing is left, and the answer only holds earlier trips. The preview must not call
// such a trip "found", the route must show what really runs, creating a route must not depend on this one weekend, and an old answer is not "current".
// And when there is nothing with one transfer at all, the route shows what runs with two (fallback): S1, U3 and U5 instead of "Keine Daten".
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EfaClient } from '../server/providers/efa.mjs';
import { createProviders } from '../server/providers/index.mjs';
import { previewRoute } from '../server/domain/transfer.mjs';
import { createService } from '../server/service.mjs';
import { ProfileStore, addTours } from '../server/store/profile.mjs';
import { fromBerlin } from '../server/lib/time.mjs';
import { config } from '../server/config.mjs';

const trip = JSON.parse(readFileSync(new URL('./fixtures/efa-trip.json', import.meta.url), 'utf8'));      // four trips, 10:57–11:08 (Berlin) on 2026-10-11
const fine = (body) => ({ ok: true, status: 200, json: async () => body });
const NOTHING = { journeys: [], systemMessages: [{ type: 'warning', module: 'BROKER', code: -8011, text: 'no trips found' }] };
const BEFORE = '2026-10-11T08:55:00Z', AFTER = '2026-10-11T09:30:00Z', MIDDLE = '2026-10-11T09:05:00Z';      // before / after / between the trips of the test data
const ARGS = { fromId: 'mvv|de:09178:2', toId: 'mvv|de:09162:1180', results: 8, transfers: 1, from: { name: 'Fiktivia' }, to: { name: 'München, Neuperlach Süd' } };

/** EFA client with a fake source: answers(url) -> body, or a number for an HTTP error. */
function efa(answers, o = {}) {
  const urls = [], lines = [], clock = { t: 1_000_000 };
  const fetchImpl = async (u) => {
    const url = String(u); urls.push(url);
    const a = answers(url, urls.length);
    return typeof a === 'number' ? { ok: false, status: a } : fine(a);
  };
  const client = new EfaClient('https://mvv.test/ng', { key: 'mvv', fetchImpl, retries: 0, log: (m) => lines.push(m), now: () => clock.t, ...o });
  return { client, urls, lines, clock };
}
const strong = (url) => url.includes('ptOptionsActive=1');                       // the limit goes into the search
const lean = (url) => url.includes('routeType=LEASTINTERCHANGE');                // … and the fewest transfers come first
const early = { ...trip, journeys: trip.journeys.slice(0, 2) }, later = { ...trip, journeys: trip.journeys.slice(2) };      // 08:57 and 09:01 / 09:06 and 09:11 (UTC)

// ---------- The source ----------

test('EFA: a plain answer with a trip still to come is all it takes – one request, no route options, nothing in the log', async () => {
  const { client, urls, lines } = efa(() => trip);
  assert.equal((await client.journeys({ ...ARGS, when: BEFORE })).length, 4);
  assert.equal(urls.length, 1);
  assert.match(urls[0], /maxChanges=1/); assert.match(urls[0], /calcNumberOfTrips=8/); assert.ok(!strong(urls[0]));
  assert.deepEqual(lines, []);
});

test('EFA: nothing usable to come in the plain answer – asked again with the limit inside the search; that answer counts, and the next time it goes first', async () => {
  const r = efa((url) => (strong(url) ? later : early));
  const js = await r.client.journeys({ ...ARGS, when: MIDDLE });                  // 09:05: the two trips of the plain answer have left
  assert.deepEqual(js.map((j) => j.legs[0].line.name), ['S3', 'S5']);
  assert.equal(r.urls.length, 2);
  assert.ok(!strong(r.urls[0]) && strong(r.urls[1]) && !lean(r.urls[1]));
  assert.match(r.urls[1], /maxChanges=1/); assert.match(r.urls[1], /calcOneDirection=1/); assert.match(r.urls[1], /calcNumberOfTrips=8/);
  assert.equal(r.lines.length, 1);
  assert.match(r.lines[0], /mvv: Fiktivia → München, Neuperlach Süd \(1 Umstieg\) – die einfache Abfrage hat nichts Abfahrbares, mit „Umstiegslimit in der Suche“ schon/);
  assert.match(r.lines[0], /einfache Abfrage: 2 Fahrten \(10:57 bis 11:01; 0 nutzbar; Umstiege 0×2\)/);           // what the plain answer held, in Berlin time
  assert.match(r.lines[0], /Umstiegslimit in der Suche: 2 Fahrten \(11:06 bis 11:11; 2 nutzbar/);
  await r.client.journeys({ ...ARGS, when: MIDDLE });
  assert.equal(r.urls.length, 3); assert.ok(strong(r.urls[2]));                   // only the stronger query: the plain one would only fail again
  r.clock.t += 11 * 60e3;
  await r.client.journeys({ ...ARGS, when: MIDDLE });
  assert.ok(!strong(r.urls[3]) && strong(r.urls[4]));                             // after ten minutes the plain query gets its chance again
  assert.equal(r.lines.length, 2);
});

test('EFA: the fewest transfers is the last query before giving up – and goes first once it has helped', async () => {
  const r = efa((url) => (lean(url) ? later : NOTHING));
  const js = await r.client.journeys({ ...ARGS, when: MIDDLE });
  assert.equal(js.length, 2); assert.equal(r.urls.length, 3);
  assert.ok(!strong(r.urls[0]) && strong(r.urls[1]) && !lean(r.urls[1]) && lean(r.urls[2]));
  assert.match(r.lines[0], /mit „wenigste Umstiege“ schon/);
  await r.client.journeys({ ...ARGS, when: MIDDLE });
  assert.equal(r.urls.length, 4); assert.ok(lean(r.urls[3]));                     // not the query that failed before it is asked again
});

test('EFA: when nothing helps the first answer stands; the stronger queries are not repeated at once; the log speaks once per ten minutes and says what each brought', async () => {
  const warned = { ...early, systemMessages: [{ type: 'warning', module: 'BROKER', code: -10015, text: 'itp' }, { type: 'warning', module: 'BROKER', code: 404, text: 'Fahrplan geändert' }] };
  const r = efa((url) => (strong(url) ? NOTHING : warned));
  const js = await r.client.journeys({ ...ARGS, when: AFTER });                   // 09:30: everything has left
  assert.equal(js.length, 2); assert.equal(r.urls.length, 3);
  assert.equal(r.lines.length, 1);
  assert.match(r.lines[0], /mvv: Fiktivia → München, Neuperlach Süd \(1 Umstieg\) – ab So 11:30 keine Fahrt, die noch fährt/);
  assert.match(r.lines[0], /einfache Abfrage: 2 Fahrten \(10:57 bis 11:01; 0 nutzbar; Umstiege 0×2\); Umstiegslimit in der Suche: keine Fahrten; wenigste Umstiege: keine Fahrten/);
  assert.match(r.lines[0], /\(Meldungen der Quelle: warning 404 Fahrplan geändert\)$/);            // the message that is always there (-10015) is left out
  await r.client.journeys({ ...ARGS, when: AFTER });
  assert.equal(r.urls.length, 4);                                                 // only the plain query again
  r.clock.t += 6 * 60e3;
  await r.client.journeys({ ...ARGS, when: AFTER });
  assert.equal(r.urls.length, 7);                                                 // after five minutes the stronger ones are tried again …
  assert.equal(r.lines.length, 1);                                                // … but the log keeps quiet
  r.clock.t += 5 * 60e3;
  await r.client.journeys({ ...ARGS, when: AFTER });
  assert.equal(r.lines.length, 2);
});

test('EFA: a failing stronger query never turns an answer into an error; an error of the plain query stays one', async () => {
  const r = efa((url) => (strong(url) ? 500 : NOTHING));
  assert.deepEqual(await r.client.journeys({ ...ARGS, when: BEFORE }), []);
  assert.equal(r.urls.length, 3);
  assert.match(r.lines[0], /Umstiegslimit in der Suche: Fehler mvv: HTTP 500; wenigste Umstiege: Fehler mvv: HTTP 500/);
  const down = efa(() => 500);
  await assert.rejects(down.client.journeys({ ...ARGS, when: BEFORE }), /HTTP 500/);
  assert.equal(down.urls.length, 1);
  const said = efa(() => ({ journeys: [], systemMessages: [{ type: 'error', module: 'BROKER', code: -4000, text: 'Service nicht verfügbar' }] }));
  await assert.rejects(said.client.journeys({ ...ARGS, when: BEFORE }), /Service nicht verfügbar/);
  assert.equal(said.urls.length, 1);
});

test('EFA: a trip that is still to come but needs more transfers than allowed is not usable', async () => {
  const stop = (n) => ({ id: `de:${n}`, name: `Halt ${n}`, type: 'stop', coord: [48.1, 11.5] });
  const leg = (n, dep) => ({ origin: { ...stop(n), departureTimePlanned: dep, departureTimeEstimated: dep }, destination: { ...stop(n + 1), arrivalTimePlanned: dep, arrivalTimeEstimated: dep }, transportation: { number: `U${n}`, name: `U${n}`, product: { class: 2, name: 'U-Bahn' }, destination: { name: 'x' } } });
  const three = { journeys: [{ interchanges: 2, isAdditional: true, legs: [leg(1, '2026-10-11T09:10:00Z'), leg(2, '2026-10-11T09:20:00Z'), leg(3, '2026-10-11T09:30:00Z')] }] };
  const r = efa((url) => (strong(url) ? later : three));
  const js = await r.client.journeys({ ...ARGS, when: BEFORE });
  assert.equal(js.length, 2); assert.equal(r.urls.length, 2);                     // the 3-leg trip is ahead, but the stronger query asks for a better one
  const only = efa(() => three);
  await only.client.journeys({ ...ARGS, when: BEFORE });
  assert.match(only.lines[0], /einfache Abfrage: 1 Fahrt \(11:10 bis 11:10; 0 nutzbar; Umstiege 2×1; 1 Zusatzvorschläge\)/);
  const loose = efa(() => three);                                                 // with more transfers allowed it is fine
  assert.equal((await loose.client.journeys({ ...ARGS, transfers: 2, when: BEFORE })).length, 1);
  assert.equal(loose.urls.length, 1);
});

test('EFA: direct trips – the stronger query without the fewest transfers; a pair without a direct trip stays quiet in the log', async () => {
  const r = efa(() => NOTHING);
  assert.deepEqual(await r.client.journeys({ ...ARGS, transfers: 0, when: BEFORE }), []);
  assert.equal(r.urls.length, 2); assert.ok(strong(r.urls[1]) && !lean(r.urls[1])); assert.match(r.urls[1], /maxChanges=0/);
  assert.deepEqual(r.lines, []);                                                  // "no direct trip" is an answer, not a problem
  const gone = efa(() => early);                                                  // direct trips that have all left: that is worth a line
  await gone.client.journeys({ ...ARGS, transfers: 0, when: AFTER });
  assert.equal(gone.urls.length, 2); assert.match(gone.lines[0], /\(direkt\)/);
});

// ---------- A source that behaves like the real one on the closure weekend ----------

const MIN = 60e3;
const FS = { id: 'mvv|de:09178:2', name: 'Fiktivia', lat: 48.40, lon: 11.74 }, MH = { id: 'mvv|de:09162:6', name: 'München Hbf', lat: 48.14, lon: 11.56 }, NS = { id: 'mvv|de:09162:1180', name: 'München, Neuperlach Süd', lat: 48.09, lon: 11.65 };
const MO = { id: 'mvv|de:09162:700', name: 'München, Moosach' }, OD = { id: 'mvv|de:09162:30', name: 'München, Odeonsplatz' };
const iso = (ms) => new Date(ms).toISOString().replace('.000Z', 'Z');
const point = (s) => ({ isGlobalId: true, id: s.id.slice(4), name: s.name, type: 'platform', coord: [48.1, 11.5], parent: { id: s.id.slice(4), name: s.name, type: 'stop', coord: [48.1, 11.5] } });
const efaLeg = (line, from, to, dep, arr) => ({
  origin: { ...point(from), departureTimePlanned: iso(dep), departureTimeEstimated: iso(dep), properties: { plannedPlatformName: '1', platformName: '1' } },
  destination: { ...point(to), arrivalTimePlanned: iso(arr), arrivalTimeEstimated: iso(arr), properties: { plannedPlatformName: '2', platformName: '2' } },
  transportation: { id: `${line}-${dep}`, name: line, number: line, product: { class: line[0] === 'U' ? 2 : 1, name: line[0] === 'U' ? 'U-Bahn' : 'S-Bahn' }, destination: { name: to.name }, properties: { AVMSTripID: `${line}-${dep}` } },
  isRealtimeControlled: true, realtimeStatus: ['MONITORED'],
});
const efaTrip = (...legs) => ({ rating: 0, isAdditional: false, interchanges: legs.length - 1, legs });
const CLOSED_FROM = Date.parse('2026-10-16T22:20:00+02:00'), CLOSED_TO = Date.parse('2026-10-19T04:40:00+02:00');      // Stammstrecke Friday 22:20 until Monday 04:40
const slotOf = (ms) => Math.floor((ms - 2 * MIN) / (20 * MIN)) * 20 * MIN + 2 * MIN;                                // the S1 leaves Fiktivia at :02, :22 and :42

/**
 * Fiktivia → Neuperlach Süd. Normal: S1 + S5 with one transfer, the best trip. Closed: the best trip of every departure needs two transfers (S1, U3, U5);
 * the S1 + U5 trip with one transfer exists (if `u5`) but is two minutes slower. Without the route options EFA takes its best trips for the time asked for,
 * adds the last two trips from before it that satisfy the limit, and only then drops the ones with too many transfers.
 */
function world({ u5 = true, closedTo = CLOSED_TO, failMornings = false } = {}) {
  const asked = [];
  const closed = (ms) => ms >= CLOSED_FROM && ms < closedTo;
  const best = (ms) => (closed(ms)
    ? efaTrip(efaLeg('S1', FS, MO, ms, ms + 27 * MIN), efaLeg('U3', MO, OD, ms + 31 * MIN, ms + 45 * MIN), efaLeg('U5', OD, NS, ms + 49 * MIN, ms + 67 * MIN))
    : efaTrip(efaLeg('S1', FS, MH, ms, ms + 38 * MIN), efaLeg('S5', MH, NS, ms + 45 * MIN, ms + 67 * MIN)));
  const alternative = (ms) => (closed(ms) && u5 ? efaTrip(efaLeg('S1', FS, MH, ms, ms + 38 * MIN), efaLeg('U5', MH, NS, ms + 45 * MIN, ms + 69 * MIN)) : null);
  const slotsFrom = (at) => { const s = slotOf(at); return s < at ? s + 20 * MIN : s; };
  const answer = (url) => {
    const u = new URL(url), q = u.searchParams;
    if (u.pathname.endsWith('XML_STOPFINDER_REQUEST')) return { locations: [] };
    assert.ok(u.pathname.endsWith('XML_TRIP_REQUEST2'), `unexpected ${url}`);
    const d = q.get('itdDate'), tm = q.get('itdTime');
    const at = fromBerlin(`${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6)}`, `${tm.slice(0, 2)}:${tm.slice(2)}`);
    const max = Number(q.get('maxChanges')), n = Number(q.get('calcNumberOfTrips')), inSearch = q.get('ptOptionsActive') === '1', oneWay = q.get('calcOneDirection') === '1';
    const route = `${q.get('name_origin')}>${q.get('name_destination')}`;
    asked.push({ route, at, max, inSearch, oneWay, lean: q.get('routeType') === 'LEASTINTERCHANGE', url });
    const reply = (journeys) => ({ version: '11.0.6.72', systemMessages: [{ type: 'warning', module: 'BROKER', code: -10015, text: 'itp', subType: 'itp-monomodal' }], journeys });
    if (failMornings && d === '20261019') return 500;
    if (route === 'de:09162:6>de:09162:1180') {                                    // from the transfer station: the U5 runs directly, every ten minutes
      const first = Math.ceil(at / (10 * MIN)) * (10 * MIN);
      return reply(Array.from({ length: n }, (_, i) => efaTrip(efaLeg('U5', MH, NS, first + i * 10 * MIN, first + i * 10 * MIN + 24 * MIN))));
    }
    assert.equal(route, 'de:09178:2>de:09162:1180');
    const earlier = [];
    if (!oneWay) for (let ms = slotOf(at - 1); earlier.length < 2 && ms > at - 72 * 3600e3; ms -= 20 * MIN) if (best(ms).interchanges <= max) earlier.unshift(best(ms));
    const ahead = [];
    for (let ms = slotsFrom(at); ahead.length < n && ms < at + 36 * 3600e3; ms += 20 * MIN) {
      if (!inSearch) { ahead.push(best(ms)); continue; }                                  // its best trip, whatever the limit says
      const pick = best(ms).interchanges <= max ? best(ms) : alternative(ms);             // the best trip that satisfies the limit
      if (pick) ahead.push(pick);
    }
    return reply([...earlier, ...(inSearch ? ahead : ahead.filter((j) => j.interchanges <= max))]);
  };
  return { answer, asked, trips: (route = 'de:09178:2>de:09162:1180') => asked.filter((a) => a.route === route) };
}

const tmp = () => mkdtemp(join(tmpdir(), 'rego-closure-'));
const at = (iso8601) => Date.parse(iso8601);
const SATURDAY = at('2026-10-17T16:36:00+02:00');

/** Service on top of the real providers; the association is the fake world. */
async function live(w, { t = SATURDAY } = {}) {
  const realFetch = globalThis.fetch, realLog = console.log, lines = [], clock = { t };
  const now = () => clock.t;
  globalThis.fetch = async (u) => {
    const a = w.answer(String(u));
    return typeof a === 'number' ? { ok: false, status: a } : fine(a);
  };
  console.log = (...a) => { lines.push(a.join(' ')); };
  const store = new ProfileStore(await tmp(), now); const dev = 'sperrwoche123456';
  await store.update(dev, (p) => { addTours(p, { from: FS, to: NS, transfers: 1 }); });
  const cfg = { ...config, provider: 'transport-rest', verbose: true, tourDeadlineMs: 3000, upstream: { ...config.upstream, efa: [{ key: 'mvv', url: 'https://mvv.test/ng' }], retries: 0 } };
  const service = createService({ config: cfg, store, now, providers: createProviders(cfg, now) });
  return { service, dev, clock, lines, done: () => { console.log = realLog; globalThis.fetch = realFetch; } };
}

test('Closure weekend: the preview finds what really runs, and the route shows the same trips', async () => {
  const w = world(), s = await live(w);
  try {
    const found = await s.service.searchTransfer(FS, NS);                                                      // Saturday 16:36, the form
    assert.equal(found.found, true);
    assert.deepEqual(found.route.legs.map((l) => l.line), ['S1', 'U5']);
    assert.equal(found.route.legs[0].times, 'ab 16:42 · an 17:20');                                          // today: no weekday in front
    assert.equal(found.route.via, 'München Hbf');
    const asked = w.trips();
    assert.equal(asked.length, 2); assert.ok(!asked[0].inSearch && asked[1].inSearch);                       // plain, then with the limit inside the search

    const st = await s.service.getState(s.dev);                                                              // same query, same cache
    const tour = st.tours[0];
    assert.deepEqual(tour.departures.map((d) => d.expectedTime), ['16:42', '17:02', '17:22']);
    assert.equal(tour.departures[0].transfer.station, 'München Hbf');
    assert.notEqual(tour.view.kind, 'none'); assert.ok(!tour.stale);
    assert.equal(st.connection.status, 'ok');
    assert.equal(w.trips().length, 2);

    s.clock.t += 40e3;                                                                                       // the cache has expired: one request, the stronger one
    const again = await s.service.getState(s.dev);
    assert.equal(again.tours[0].departures[0].expectedTime, '16:42');
    assert.equal(w.trips().length, 3); assert.ok(w.trips()[2].inSearch);
    assert.equal(s.lines.filter((l) => /mvv: Fiktivia → München, Neuperlach Süd \(1 Umstieg\) – die einfache Abfrage hat nichts Abfahrbares, mit „Umstiegslimit in der Suche“ schon/.test(l)).length, 1);
    assert.ok(s.lines.some((l) => /einfache Abfrage: 2 Fahrten \(Fr 21:42 bis Fr 22:02; 0 nutzbar; Umstiege 1×2\)/.test(l)));      // the trips from Friday evening, in the log
  } finally { s.done(); }
});

test('Closure weekend without any trip with one transfer: creating the route works (a normal morning decides), the route shows what runs now – with two transfers', async () => {
  const w = world({ u5: false }), s = await live(w);
  try {
    const found = await s.service.searchTransfer(FS, NS);
    assert.equal(found.found, true);
    assert.deepEqual(found.route.legs.map((l) => l.line), ['S1', 'S5']);
    assert.equal(found.route.legs[0].times, 'Mo ab 07:42 · an 08:20');                                       // Monday morning, after the closure
    assert.equal(found.route.legs[1].times, 'ab 08:27 · an 08:49');
    const queried = w.trips();
    assert.equal(queried.length, 4);                                                                         // now: plain, limit, fewest transfers; Monday: plain – one transfer is enough there
    assert.deepEqual(queried.map((a) => [a.inSearch, a.lean, a.max]), [[false, false, 1], [true, false, 1], [true, true, 1], [false, false, 1]]);

    const st = await s.service.getState(s.dev);                                                              // right now nothing runs with one transfer: the answer with two counts
    const tour = st.tours[0];
    assert.deepEqual(tour.departures.map((d) => d.expectedTime), ['16:42', '17:02', '17:22']);
    assert.deepEqual(tour.departures[0].lineIds, ['S1', 'U3', 'U5']); assert.deepEqual(tour.lineIds, ['S1', 'U3', 'U5']);
    assert.equal(tour.transfers, 1); assert.equal(tour.changes, 2); assert.equal(tour.via, 'München, Moosach › München, Odeonsplatz');
    assert.equal(tour.departures[0].transfer.count, 2); assert.equal(tour.departures[0].transfer.state, 'ok'); assert.equal(tour.departures[0].transfer.text, '2 Umstiege · 4 und 4 Min.');
    assert.equal(tour.departures[0].arrTime, '17:49');                                                       // 16:42 + 67 minutes
    assert.notEqual(tour.view.kind, 'none'); assert.ok(!tour.stale);
    assert.equal(st.connection.status, 'ok');                                                                // no banner for this
    const two = w.trips().slice(4);
    assert.equal(two.length, 1); assert.equal(two[0].max, 2); assert.ok(!two[0].inSearch);                   // one plain request with two transfers allowed was enough
    assert.equal(s.lines.filter((l) => /ab Sa 16:36 keine Fahrt, die noch fährt \(einfache Abfrage: 2 Fahrten \(Fr 21:42 bis Fr 22:02; 0 nutzbar; Umstiege 1×2\); Umstiegslimit in der Suche: keine Fahrten; wenigste Umstiege: keine Fahrten\)/.test(l)).length, 1);
    assert.equal(s.lines.filter((l) => /^Strecke Fiktivia → München, Neuperlach Süd: nichts mit höchstens 1 Umstieg, es gelten die Verbindungen mit bis zu 2 Umstiegen \(8 Fahrten noch nicht abgefahren\)$/.test(l)).length, 1);

    // creating the route (the check at creation is the same call) does not ask the source again within the minute
    const before = w.asked.length;
    assert.equal((await s.service.searchTransfer(FS, NS)).found, true);
    assert.equal(w.asked.length, before);
  } finally { s.done(); }
});

test('Closure weekend with a trip with one transfer: two transfers are never asked for', async () => {
  const w = world({ u5: true }), s = await live(w);
  try {
    const st = await s.service.getState(s.dev);
    assert.deepEqual(st.tours[0].departures.map((d) => d.lineIds), [['S1', 'U5'], ['S1', 'U5'], ['S1', 'U5']]);
    assert.equal(st.tours[0].changes, undefined);
    assert.ok(w.trips().every((a) => a.max === 1));                                                        // the trips from Fiktivia: never with two transfers
    assert.equal(s.lines.filter((l) => /nichts mit höchstens 1 Umstieg/.test(l)).length, 0);
  } finally { s.done(); }
});

test('Closure weekend, the source fails for the answer with two transfers: not "no connection" but "Keine Daten"', async () => {
  const w = world({ u5: false }), s = await live(w);
  const answer = w.answer;
  w.answer = (url) => (new URL(url).searchParams.get('maxChanges') === '2' ? 500 : answer(url));
  try {
    const st = await s.service.getState(s.dev);
    const tour = st.tours[0];
    assert.deepEqual(tour.departures, []); assert.equal(tour.view.kind, 'none'); assert.equal(tour.view.big, 'Keine Daten'); assert.ok(tour.stale);
  } finally { s.done(); }
});

test('Closure for days: the pair is not connected with one transfer on a normal morning either – the connection with two is "found"; nothing at all is "nothing"; the source failing for the check is "unknown", not "nothing"', async () => {
  const long = world({ u5: false, closedTo: at('2026-11-30T04:00:00+01:00') }), s = await live(long);
  try {
    const r = await s.service.searchTransfer(FS, NS);
    assert.equal(r.found, true);
    assert.deepEqual(r.route.legs.map((l) => l.line), ['S1', 'U3', 'U5']);
    assert.deepEqual(r.route.legs.map((l) => l.times), ['ab 16:42 · an 17:09', 'ab 17:13 · an 17:27', 'ab 17:31 · an 17:49']);
    assert.equal(r.route.via, 'München, Moosach'); assert.equal(r.route.wait, 4);
    assert.deepEqual(r.route.changes, [{ via: 'München, Moosach', wait: 4 }, { via: 'München, Odeonsplatz', wait: 4 }]);
    assert.equal(r.route.duration, '1 Std. 7 Min.');
    assert.deepEqual(long.trips().map((a) => a.max), [1, 1, 1, 1, 2]);                                       // now: plain, limit, fewest transfers; Monday: plain (the stronger ones just found nothing); then the plain query with two transfers
  } finally { s.done(); }
  const none = world({ u5: false, closedTo: at('2026-11-30T04:00:00+01:00') }), n = await live(none);
  const asked = none.answer;
  none.answer = (url) => (new URL(url).searchParams.get('maxChanges') === '2' ? { journeys: [], systemMessages: [] } : asked(url));      // not even with two transfers
  try { const r = await n.service.searchTransfer(FS, NS); assert.equal(r.found, false); assert.equal(r.route, null); } finally { n.done(); }
  const sick = world({ u5: false, failMornings: true }), t = await live(sick);
  try { const r = await t.service.searchTransfer(FS, NS); assert.equal(r.found, null); assert.equal(r.route, null); } finally { t.done(); }
});

test('Normal weekday: the plain query is enough – one request, no route options, preview and route agree', async () => {
  const w = world(), s = await live(w, { t: at('2026-10-20T07:10:00+02:00') });                                // Tuesday after the closure
  try {
    const found = await s.service.searchTransfer(FS, NS);
    assert.equal(found.found, true); assert.deepEqual(found.route.legs.map((l) => l.line), ['S1', 'S5']);
    assert.equal(found.route.legs[0].times, 'ab 07:22 · an 08:00');
    assert.equal(w.trips().length, 1); assert.ok(!w.trips()[0].inSearch);
    const st = await s.service.getState(s.dev);
    assert.equal(st.tours[0].departures[0].expectedTime, '07:22');
    assert.equal(w.trips().length, 1);
    assert.deepEqual(s.lines.filter((l) => /mvv:/.test(l)), []);
  } finally { s.done(); }
});

// ---------- Preview and route ----------

const FSs = { id: 'mvv|de:09178:2', name: 'Fiktivia' }, MHs = { id: 'mvv|de:09162:6', name: 'München Hbf' }, NSs = { id: 'mvv|de:09162:1180', name: 'München, Neuperlach Süd' };
const NOW = Date.parse('2026-10-17T15:14:00+02:00');                                                         // Saturday, closure weekend
const atLocal = (day, hhmm) => `${day}T${hhmm}:00+02:00`;
const leg = (line, from, to, dep, arr, product = 'suburban', day = '2026-10-17') => ({
  line: { name: line, product }, direction: to.name, origin: from, destination: to, plannedDep: atLocal(day, dep), dep: atLocal(day, dep), depDelay: 0, rt: true,
  plannedArr: atLocal(day, arr), arr: atLocal(day, arr), arrDelay: 0, plannedPlatform: '1', platform: '1', plannedArrPlatform: '26', arrPlatform: '26', stopovers: [from, to], remarks: [], cancelled: false,
});
const RE3 = (dep, arr, day) => leg('RE3', FSs, MHs, dep, arr, 'regionalExpress', day), S5 = (dep, arr, day) => leg('S5', MHs, NSs, dep, arr, 'suburban', day);
const pair = (a, b) => ({ legs: [a, b] });
const SCHEDULE = { days: ['Mo', 'Di', 'Mi', 'Do', 'Fr'], departAfter: '06:30', departUntil: '08:00' };

/** Service with a source that answers by `mode`: full | empty | past */
async function setup(mk, { transfers = 1, to = NSs } = {}) {
  const clock = { t: NOW }; const now = () => clock.t;
  const store = new ProfileStore(await tmp(), now); const dev = 'sperrgeraet1234567';
  await store.update(dev, (p) => { addTours(p, { from: FSs, to, schedule: SCHEDULE, ...(transfers ? { transfers } : {}) }); });
  const src = { mode: 'full', args: [] };
  const client = { journeys: async (a) => { src.args.push(a); return src.mode === 'empty' ? [] : mk(src.mode, a); }, stop: async () => ({ lines: [], lat: 48.14, lon: 11.56 }) };
  const providers = { forTour: () => client, forStop: () => client, searchStops: async () => [] };
  const lines = [], realLog = console.log;
  console.log = (...a) => { lines.push(a.join(' ')); };
  const service = createService({ config: { ...config, verbose: true, tourDeadlineMs: 500 }, store, now, providers });
  return { clock, service, dev, src, lines, done: () => { console.log = realLog; } };
}

test('Preview and route see the same trips: an empty answer after a good one does not turn "Gefunden" into "Keine Verbindung"', async () => {
  const s = await setup((mode) => (mode === 'past' ? [pair(RE3('12:10', '12:37'), S5('12:45', '13:07'))] : [pair(RE3('19:10', '19:37'), S5('19:45', '20:07'))]));
  try {
    const found = await s.service.searchTransfer(FSs, NSs);                                                  // 15:14, preview in the form
    assert.equal(found.found, true);
    assert.deepEqual(found.route.legs.map((l) => l.line), ['RE3', 'S5']);
    s.clock.t += 45e3; s.src.mode = 'empty';                                                                  // the route asks again, the source says nothing
    let st = await s.service.getState(s.dev);
    let tour = st.tours[0];
    assert.equal(s.src.args.filter((a) => a.transfers === 1).length, 2);                                      // the source really was asked again
    assert.equal(tour.departures.length, 1); assert.equal(tour.departures[0].expectedTime, '19:10');
    assert.equal(tour.view.kind, 'ok');                                                                        // a normal view, no "Keine"

    assert.ok(!tour.stale); assert.equal(st.connection.status, 'ok');                                         // no banner for this
    assert.equal(s.lines.filter((l) => /die letzte gute Antwort von 15:14 bleibt/.test(l)).length, 1);

    s.clock.t += 5 * 60e3; st = await s.service.getState(s.dev);                                              // nearly six minutes later: still
    assert.equal(st.tours[0].departures.length, 1);
    assert.equal(s.lines.filter((l) => /die letzte gute Antwort/.test(l)).length, 1);                         // one log line, not one per request

    s.clock.t += 5 * 60e3; st = await s.service.getState(s.dev);                                              // more than ten minutes: now the honest answer
    tour = st.tours[0];
    assert.equal(tour.departures.length, 0); assert.equal(tour.view.kind, 'none'); assert.equal(tour.view.big, 'Keine');
    assert.match(tour.view.sub, /Keine Verbindung mit höchstens 2 Umstiegen/);                                 // the answer with two transfers was asked for as well – and is empty
    assert.equal(st.connection.status, 'ok');
    assert.equal(s.lines.filter((l) => /Strecke ohne Abfahrt: Fiktivia → München, Neuperlach Süd \(1 Umstieg\) – die Quelle lieferte 0 Fahrten, 0 davon noch nicht abgefahren; mit 2 Umstiegen 0 Fahrten, 0 davon noch nicht abgefahren$/.test(l)).length, 1);

    s.clock.t += 40e3; s.src.mode = 'full'; st = await s.service.getState(s.dev);                              // the source answers again
    assert.equal(st.tours[0].departures.length, 1);
  } finally { s.done(); }
});

test('Kept trips: only those that have not left, for a direct route as well; an empty answer without a good one before stays empty', async () => {
  const S1 = (dep, arr) => leg('S1', FSs, MHs, dep, arr);
  const s = await setup(() => [{ legs: [S1('15:20', '15:55')] }, { legs: [S1('16:10', '16:45')] }], { transfers: 0, to: MHs });
  try {
    assert.equal(await s.service.hasDirect(FSs, MHs), true);
    let st = await s.service.getState(s.dev);                                                                 // 15:14
    assert.deepEqual(st.tours[0].departures.map((d) => d.expectedTime), ['15:20', '16:10']);
    s.clock.t += 9 * 60e3; s.src.mode = 'empty';                                                              // 15:23, the source says nothing
    st = await s.service.getState(s.dev);
    assert.deepEqual(st.tours[0].departures.map((d) => d.expectedTime), ['16:10']);                           // the 15:20 has left, it is not kept
    assert.ok(!st.tours[0].stale); assert.equal(st.connection.status, 'ok');
    // a route that never had a good answer: nothing to keep
    const t = await setup(() => [], { transfers: 0, to: MHs }); t.src.mode = 'empty';
    try { assert.equal(await t.service.hasDirect(FSs, MHs), false); assert.equal((await t.service.getState(t.dev)).tours[0].departures.length, 0); } finally { t.done(); }
  } finally { s.done(); }
});

test('Preview: a trip that has left is no sample – a normal morning is looked at instead, with its weekday; nothing there either is "none"', async () => {
  // the source only knows trips from Friday evening (they have left) and, on Monday morning, a connection
  const trips = (mode, a) => (Date.parse(a.when) >= at('2026-10-19T00:00:00+02:00') ? [pair(RE3('07:34', '08:01', '2026-10-19'), S5('08:09', '08:31', '2026-10-19'))] : [pair(RE3('19:10', '19:37', '2026-10-16'), S5('19:45', '20:07', '2026-10-16'))]);
  const s = await setup(trips);
  try {
    const r = await s.service.searchTransfer(FSs, NSs);
    assert.equal(r.found, true);
    assert.deepEqual(r.route.legs.map((l) => l.times), ['Mo ab 07:34 · an 08:01', 'ab 08:09 · an 08:31']);
    assert.deepEqual(s.src.args.map((a) => a.when), ['2026-10-17T13:14:00.000Z', '2026-10-19T05:30:00.000Z']);      // now, then Monday 07:30
  } finally { s.done(); }
  const n = await setup(() => [pair(RE3('19:10', '19:37', '2026-10-16'), S5('19:45', '20:07', '2026-10-16'))]);
  try { const r = await n.service.searchTransfer(FSs, NSs); assert.equal(r.found, false); assert.equal(r.route, null); } finally { n.done(); }

  const journeys = [pair(RE3('12:10', '12:37'), S5('12:45', '13:07')), pair(RE3('19:10', '19:37'), S5('19:45', '20:07'))];
  assert.equal(previewRoute(journeys).legs[0].times, 'ab 12:10 · an 12:37');                                   // without `now` as before
  assert.equal(previewRoute(journeys, NOW).legs[0].times, 'ab 19:10 · an 19:37');
  assert.equal(previewRoute(journeys.slice(0, 1), NOW), null);
  assert.equal(previewRoute([pair(RE3('15:13', '15:40'), S5('15:48', '16:10'))], NOW).via, 'München Hbf');    // a minute ago still counts, like on the route
});

test('Sample morning: the next weekday at 07:30, at least two hours ahead', async () => {
  const days = async (t) => {
    const s = await setup(() => [], {}); s.clock.t = t; await s.service.searchTransfer(FSs, NSs); s.done();
    const asked = s.src.args.map((a) => [a.transfers, new Date(a.when).toISOString()]);
    assert.deepEqual(asked.filter(([n]) => n === 2).map(([, w]) => w), asked.filter(([n]) => n === 1).map(([, w]) => w));      // nothing with one transfer: the same two moments again with two
    return asked.filter(([n]) => n === 1).map(([, w]) => w);
  };
  assert.deepEqual(await days(at('2026-10-17T16:36:00+02:00')), ['2026-10-17T14:36:00.000Z', '2026-10-19T05:30:00.000Z']);       // Saturday -> Monday
  assert.deepEqual(await days(at('2026-10-20T03:00:00+02:00')), ['2026-10-20T01:00:00.000Z', '2026-10-20T05:30:00.000Z']);       // Tuesday night -> the same morning
  assert.deepEqual(await days(at('2026-10-20T06:00:00+02:00')), ['2026-10-20T04:00:00.000Z', '2026-10-21T05:30:00.000Z']);       // too close: the next day
  assert.deepEqual(await days(at('2026-10-30T20:00:00+01:00')), ['2026-10-30T19:00:00.000Z', '2026-11-02T06:30:00.000Z']);       // Friday evening -> Monday (winter time)
});
