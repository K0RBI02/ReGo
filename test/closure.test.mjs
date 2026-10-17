// Days with closures (S-Bahn Stammstrecke, October 2026): EFA answers a query for "at most 1 transfer" differently from one minute to the next –
// it first calculates a few candidate trips and only then drops the ones with too many transfers. The preview must not find a connection that the saved
// route then denies, and a route must not call old data "current".
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
import { config } from '../server/config.mjs';

const trip = JSON.parse(readFileSync(new URL('./fixtures/efa-trip.json', import.meta.url), 'utf8'));      // four trips, 10:57–11:08 (Berlin) on 2026-10-11
const fine = (body) => ({ ok: true, status: 200, json: async () => body });
const NOTHING = { journeys: [], systemMessages: [{ type: 'warning', module: 'BROKER', code: -8011, text: 'no trips found' }] };
const BEFORE = '2026-10-11T08:55:00Z', AFTER = '2026-10-11T09:30:00Z';                                      // before / after all trips of the test data
const ARGS = { fromId: 'mvv|de:09178:2', toId: 'mvv|de:09162:1180', results: 8, transfers: 1, from: { name: 'Freising' }, to: { name: 'München, Neuperlach Süd' } };

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
const lean = (url) => url.includes('routeType=LEASTINTERCHANGE');

// ---------- The source ----------

test('EFA: a query for at most 1 transfer that comes back empty is asked once more for the fewest transfers – and the log says what the source said', async () => {
  const { client, urls, lines } = efa((url) => (lean(url) ? trip : NOTHING));
  const js = await client.journeys({ ...ARGS, when: BEFORE });
  assert.equal(js.length, 4);
  assert.equal(urls.length, 2);
  assert.ok(!lean(urls[0]) && lean(urls[1]));
  assert.match(urls[1], /maxChanges=1/); assert.match(urls[1], /calcNumberOfTrips=8/);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /mvv: keine Fahrt mit höchstens 1 Umstieg Freising → München, Neuperlach Süd/);
  assert.match(lines[0], /warning -8011 no trips found/);
  assert.match(lines[0], /4 Fahrten/);
});

test('EFA: no second query when the first answer has a trip ahead, and none for direct trips', async () => {
  let r = efa(() => trip);
  assert.equal((await r.client.journeys({ ...ARGS, when: BEFORE })).length, 4);
  assert.equal(r.urls.length, 1); assert.deepEqual(r.lines, []);
  r = efa(() => NOTHING);
  assert.deepEqual(await r.client.journeys({ ...ARGS, transfers: 0, when: BEFORE }), []);
  assert.equal(r.urls.length, 1);                                                                          // "no direct trip" is an answer
});

test('EFA: an answer with only trips that have left counts as empty', async () => {
  // asked for 09:05: the first two trips (08:57, 09:01) have left, the other two (09:06, 09:11) have not
  const r = efa((url) => (lean(url) ? { ...trip, journeys: trip.journeys.slice(2) } : { ...trip, journeys: trip.journeys.slice(0, 2) }));
  const late = await r.client.journeys({ ...ARGS, when: '2026-10-11T09:05:00Z' });
  assert.equal(r.urls.length, 2);
  assert.deepEqual(late.map((j) => j.legs[0].line.name), ['S3', 'S5']);
  // the same answer, but a trip is still ahead: no second query
  const fine1 = efa(() => ({ ...trip, journeys: trip.journeys.slice(0, 2) }));
  assert.equal((await fine1.client.journeys({ ...ARGS, when: BEFORE })).length, 2);
  assert.equal(fine1.urls.length, 1);
  // nothing helps (all trips have left, the second query finds nothing): the first answer stands
  const gone = efa((url) => (lean(url) ? NOTHING : trip));
  const none = await gone.client.journeys({ ...ARGS, when: AFTER });
  assert.equal(gone.urls.length, 2); assert.equal(none.length, 4);
});

test('EFA: a second query that finds nothing is not repeated at once; it never turns an answer into an error; the log speaks once per ten minutes', async () => {
  const r = efa((url) => (lean(url) ? 500 : NOTHING));
  assert.deepEqual(await r.client.journeys({ ...ARGS, when: BEFORE }), []);                                  // the source fails on the second query: the first answer stands
  assert.equal(r.urls.length, 2);
  assert.match(r.lines[0], /zweite Abfrage mit wenigen Umstiegen: Fehler mvv: HTTP 500/);
  assert.deepEqual(await r.client.journeys({ ...ARGS, when: BEFORE }), []);
  assert.equal(r.urls.length, 3);                                                                            // only the first query again
  r.clock.t += 6 * 60e3;
  assert.deepEqual(await r.client.journeys({ ...ARGS, when: BEFORE }), []);
  assert.equal(r.urls.length, 5);                                                                            // five minutes later the second query is tried again …
  assert.equal(r.lines.length, 1);                                                                           // … but the log keeps quiet
  r.clock.t += 5 * 60e3 + 1e3;
  await r.client.journeys({ ...ARGS, when: BEFORE });
  assert.equal(r.lines.length, 2);
  // a route that was fine in between is not held back
  const ok = efa((url) => (lean(url) ? trip : NOTHING));
  await ok.client.journeys({ ...ARGS, when: BEFORE }); await ok.client.journeys({ ...ARGS, when: BEFORE });
  assert.equal(ok.urls.length, 4);
});

test('EFA: an error of the source stays an error (also for a query with a transfer)', async () => {
  const { client, urls } = efa(() => ({ journeys: [], systemMessages: [{ type: 'error', module: 'BROKER', code: -4000, text: 'Service nicht verfügbar' }] }));
  await assert.rejects(client.journeys({ ...ARGS, when: BEFORE }), /Service nicht verfügbar/);
  assert.equal(urls.length, 1);
});

// ---------- Preview and route ----------

const FS = { id: 'mvv|de:09178:2', name: 'Freising' }, MH = { id: 'mvv|de:09162:6', name: 'München Hbf' }, NS = { id: 'mvv|de:09162:1180', name: 'München, Neuperlach Süd' };
const NOW = Date.parse('2026-10-17T15:14:00+02:00');                                                         // Saturday, closure weekend
const at = (hhmm) => `2026-10-17T${hhmm}:00+02:00`;
const leg = (line, from, to, dep, arr, product = 'suburban') => ({
  line: { name: line, product }, direction: to.name, origin: from, destination: to, plannedDep: at(dep), dep: at(dep), depDelay: 0, rt: true,
  plannedArr: at(arr), arr: at(arr), arrDelay: 0, plannedPlatform: '1', platform: '1', plannedArrPlatform: '26', arrPlatform: '26', stopovers: [from, to], remarks: [], cancelled: false,
});
const RE3 = (dep, arr) => leg('RE3', FS, MH, dep, arr, 'regionalExpress'), S5 = (dep, arr) => leg('S5', MH, NS, dep, arr);
const pair = (a, b) => ({ legs: [a, b] });
const tmp = () => mkdtemp(join(tmpdir(), 'rego-closure-'));
const SCHEDULE = { days: ['Mo', 'Di', 'Mi', 'Do', 'Fr'], departAfter: '06:30', departUntil: '08:00' };

/** Service with a source that answers by `mode`: full | empty | past */
async function setup(mk, { transfers = 1, to = NS } = {}) {
  const clock = { t: NOW }; const now = () => clock.t;
  const store = new ProfileStore(await tmp(), now); const dev = 'sperrgeraet1234567';
  await store.update(dev, (p) => { addTours(p, { from: FS, to, schedule: SCHEDULE, ...(transfers ? { transfers } : {}) }); });
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
    const found = await s.service.searchTransfer(FS, NS);                                                    // 15:14, preview in the form
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
    assert.match(tour.view.sub, /Keine Verbindung mit höchstens 1 Umstieg/);
    assert.equal(st.connection.status, 'ok');
    assert.equal(s.lines.filter((l) => /Strecke ohne Abfahrt: Freising → München, Neuperlach Süd \(1 Umstieg\) – die Quelle lieferte 0 Fahrten/.test(l)).length, 1);

    s.clock.t += 40e3; s.src.mode = 'full'; st = await s.service.getState(s.dev);                              // the source answers again
    assert.equal(st.tours[0].departures.length, 1);
  } finally { s.done(); }
});

test('Kept trips: only those that have not left, for a direct route as well; an empty answer without a good one before stays empty', async () => {
  const S1 = (dep, arr) => leg('S1', FS, MH, dep, arr);
  const s = await setup(() => [{ legs: [S1('15:20', '15:55')] }, { legs: [S1('16:10', '16:45')] }], { transfers: 0, to: MH });
  try {
    assert.equal(await s.service.hasDirect(FS, MH), true);
    let st = await s.service.getState(s.dev);                                                                 // 15:14
    assert.deepEqual(st.tours[0].departures.map((d) => d.expectedTime), ['15:20', '16:10']);
    s.clock.t += 9 * 60e3; s.src.mode = 'empty';                                                              // 15:23, the source says nothing
    st = await s.service.getState(s.dev);
    assert.deepEqual(st.tours[0].departures.map((d) => d.expectedTime), ['16:10']);                           // the 15:20 has left, it is not kept
    assert.ok(!st.tours[0].stale); assert.equal(st.connection.status, 'ok');
    // a route that never had a good answer: nothing to keep
    const t = await setup(() => [], { transfers: 0, to: MH }); t.src.mode = 'empty';
    try { assert.equal(await t.service.hasDirect(FS, MH), false); assert.equal((await t.service.getState(t.dev)).tours[0].departures.length, 0); } finally { t.done(); }
  } finally { s.done(); }
});

test('Preview: a trip that has left already is no sample, and an answer with only such trips is "unknown", not "none"', async () => {
  const s = await setup(() => [pair(RE3('12:10', '12:37'), S5('12:45', '13:07'))]);
  try {
    const r = await s.service.searchTransfer(FS, NS);
    assert.equal(r.found, null); assert.equal(r.route, null);
  } finally { s.done(); }
  const journeys = [pair(RE3('12:10', '12:37'), S5('12:45', '13:07')), pair(RE3('19:10', '19:37'), S5('19:45', '20:07'))];
  assert.equal(previewRoute(journeys).legs[0].times, 'ab 12:10 · an 12:37');                                   // without `now` as before
  assert.equal(previewRoute(journeys, NOW).legs[0].times, 'ab 19:10 · an 19:37');
  assert.equal(previewRoute(journeys.slice(0, 1), NOW), null);
  assert.equal(previewRoute([pair(RE3('15:13', '15:40'), S5('15:48', '16:10'))], NOW).via, 'München Hbf');    // a minute ago still counts, like on the route
});

test('Run-through: the association says nothing the first time, the second query finds the trips – preview and saved route agree', async () => {
  const realFetch = globalThis.fetch, realLog = console.log, lines = [], urls = [];
  const now = () => Date.parse('2026-10-11T08:55:00Z');
  globalThis.fetch = async (u) => {
    const url = String(u);
    if (url.includes('mvv.test') && url.includes('XML_TRIP_REQUEST2')) { urls.push(url); return fine(lean(url) ? trip : NOTHING); }
    throw new Error(`unexpected ${url}`);
  };
  console.log = (...a) => { lines.push(a.join(' ')); };
  try {
    const store = new ProfileStore(await tmp(), now); const dev = 'efa-sperre1234567';
    const A = { id: 'mvv|de:09162:2', name: 'Marienplatz', lat: 48.136, lon: 11.577 }, B = { id: 'mvv|de:09162:5', name: 'Ostbahnhof', lat: 48.127, lon: 11.604 };
    await store.update(dev, (p) => { addTours(p, { from: A, to: B, transfers: 1 }); });
    const cfg = { ...config, provider: 'transport-rest', verbose: true, tourDeadlineMs: 3000, upstream: { ...config.upstream, efa: [{ key: 'mvv', url: 'https://mvv.test/ng' }], retries: 0 } };
    const service = createService({ config: cfg, store, now, providers: createProviders(cfg, now) });
    const r = await service.searchTransfer(A, B);
    assert.equal(r.found, true); assert.ok(r.route);
    const st = await service.getState(dev);                                                                   // same query, same cache
    assert.ok(st.tours[0].departures.length >= 3);
    assert.equal(st.connection.status, 'ok');
    assert.equal(urls.length, 2);                                                                             // one question, one more for the fewest transfers
    assert.equal(lines.filter((l) => /mvv: keine Fahrt mit höchstens 1 Umstieg Marienplatz → Ostbahnhof/.test(l)).length, 1);
  } finally { console.log = realLog; globalThis.fetch = realFetch; }
});
