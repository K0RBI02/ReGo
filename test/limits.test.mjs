// A source that says "too many requests" (HTTP 429): pause instead of firing on, honest errors, fewer background requests.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SourcePause, retryAfterSec, fmtPause } from '../server/providers/pause.mjs';
import { EfaClient } from '../server/providers/efa.mjs';
import { HafasClient, ProviderError } from '../server/providers/hafas.mjs';
import { build, createProviders, createTranslator } from '../server/providers/index.mjs';
import { createService } from '../server/service.mjs';
import { createNotifier } from '../server/notifier.mjs';
import { ProfileStore, addTours } from '../server/store/profile.mjs';
import { config } from '../server/config.mjs';

const tooMany = (retryAfter = null) => ({ ok: false, status: 429, headers: { get: (h) => (String(h).toLowerCase() === 'retry-after' ? retryAfter : null) }, text: async () => 'Too Many Requests' });
const fine = (body = { locations: [] }) => ({ ok: true, status: 200, json: async () => body });
const tick = () => new Promise((r) => setImmediate(r));

test('Pause: follows Retry-After (up to a day), otherwise grows 1, 2, 4 … up to 30 minutes; several hits of one round count once', () => {
  let t = 0; const p = new SourcePause({ now: () => t });
  assert.equal(p.allow(), true); assert.equal(p.active(), false);
  assert.deepEqual(p.limited(NaN), { sec: 60, fresh: true });
  assert.deepEqual(p.limited(NaN), { sec: 60, fresh: false });          // second answer of the same round: same pause, no escalation
  assert.equal(p.allow(), false); assert.equal(p.active(), true);
  t = 61e3; assert.equal(p.active(), false);                            // over: the station search asks again …
  assert.equal(p.allow(), true);                                        // … and exactly one request is the test
  assert.equal(p.allow(), false); assert.equal(p.active(), true);
  assert.equal(p.limited(NaN).sec, 120);                                // test failed: twice as long
  t += 121e3; assert.equal(p.allow(), true); assert.equal(p.limited(NaN).sec, 240);
  for (let i = 0; i < 12; i++) { t += 3600e3; p.allow(); p.limited(NaN); }
  assert.equal(p.limited(NaN).fresh, false);
  t += 3600e3; p.allow(); assert.equal(p.limited(NaN).sec, 1800);       // growing on its own: never longer than 30 minutes
  t += 1801e3; p.allow(); p.ok();                                       // test worked: everything forgotten
  assert.equal(p.allow(), true); assert.equal(p.limited(NaN).sec, 60);
  // the source says how long: at least 10 s, at most a day (a source that asks for 24 hours means it)
  t += 3600e3; p.ok(); assert.equal(p.limited(90).sec, 90);
  t += 3600e3; p.ok(); assert.equal(p.limited(2).sec, 10);
  t += 3600e3; p.ok(); assert.equal(p.limited(7200).sec, 7200);
  t += 3600e3; p.ok(); assert.equal(p.limited(86400).sec, 86400);
  t += 86401e3; p.allow(); p.ok(); assert.equal(p.limited(99999999).sec, 86400);
  // after such a pause nothing goes out for hours, then exactly one test request
  t += 86401e3; assert.equal(p.active(), false); assert.equal(p.left(), 0);
});

test('Pause: Retry-After as seconds or date, texts', () => {
  const h = (v) => ({ headers: { get: () => v } });
  assert.equal(retryAfterSec(h('120')), 120);
  assert.equal(retryAfterSec(h('Wed, 21 Oct 2026 07:30:00 GMT'), Date.parse('Wed, 21 Oct 2026 07:28:00 GMT')), 120);
  assert.ok(Number.isNaN(retryAfterSec(h(null)))); assert.ok(Number.isNaN(retryAfterSec(h('soon')))); assert.ok(Number.isNaN(retryAfterSec({})));
  assert.equal(fmtPause(45), '45 s'); assert.equal(fmtPause(120), '2 Min.'); assert.equal(fmtPause(1800), '30 Min.');
  assert.equal(fmtPause(5400), '90 Min.'); assert.equal(fmtPause(7200), '2 Std.'); assert.equal(fmtPause(86400), '24 Std.');
});

test('EFA: "too many requests" is not retried, the source is left alone until the pause is over, one test request decides', async () => {
  let t = 1e6; const now = () => t;
  let sent = 0, answer = tooMany('120'); const logs = [];
  const c = new EfaClient('https://x.test/efa', { key: 'moby', retries: 2, pause: new SourcePause({ now }), log: (m) => logs.push(m), fetchImpl: async () => { sent++; return answer; } });
  assert.equal(c.healthy(), true);
  await assert.rejects(c.get('XML_TRIP_REQUEST2'), /moby: HTTP 429/);
  assert.equal(sent, 1);                                                // no second attempt
  assert.equal(c.healthy(), false);
  await assert.rejects(c.get('XML_TRIP_REQUEST2'), /moby: derzeit nicht erreichbar.*Pause noch 2 Min/);
  await assert.rejects(c.searchStops('Freising'), /derzeit nicht erreichbar/);
  assert.equal(sent, 1);                                                // nothing went out during the pause
  assert.equal(logs.length, 1); assert.match(logs[0], /moby: zu viele Anfragen \(HTTP 429, Retry-After 120 s, „Too Many Requests“\) – Pause 2 Min\./);
  t += 121e3;
  assert.equal(c.healthy(), true);                                      // pause over: the source is asked again
  let release; answer = null;
  c.fetch = async () => { sent++; await new Promise((r) => { release = r; }); return fine(); };
  const test1 = c.get('XML_STOPFINDER_REQUEST');                        // this one is the test request …
  await tick();
  assert.equal(sent, 2);
  await assert.rejects(c.get('XML_STOPFINDER_REQUEST'), /derzeit nicht erreichbar/);      // … the others wait for its result
  assert.equal(sent, 2);
  release(); await test1;
  assert.equal(c.healthy(), true); assert.equal(c.pause.hits, 0);
  c.fetch = async () => { sent++; return fine(); };
  await c.get('XML_STOPFINDER_REQUEST'); assert.equal(sent, 3);        // back to normal
});

test('EFA: other errors behave as before – 404 final, 503 and timeouts retried', async () => {
  let n = 0;
  const c = new EfaClient('https://x.test/efa', { retries: 1, fetchImpl: async () => { n++; return n === 1 ? { ok: false, status: 503 } : fine({ ok: 1 }); } });
  assert.deepEqual(await c.get('x'), { ok: 1 }); assert.equal(n, 2);
  n = 0; const d = new EfaClient('https://x.test/efa', { retries: 2, fetchImpl: async () => { n++; return { ok: false, status: 404 }; } });
  await assert.rejects(d.get('x'), /HTTP 404/); assert.equal(n, 1);
  assert.equal(d.healthy(), true);                                      // a 404 is no reason for a pause
});

test('EFA: at most three requests at the same time, the rest waits in line', async () => {
  let running = 0, peak = 0, sent = 0; const releases = [];
  const c = new EfaClient('https://x.test/efa', { maxParallel: 3, retries: 0, fetchImpl: async () => { sent++; running++; peak = Math.max(peak, running); await new Promise((r) => releases.push(r)); running--; return fine(); } });
  const all = Array.from({ length: 8 }, (_, i) => c.get('x', { i }));
  await tick(); assert.equal(sent, 3);
  while (releases.length) { releases.shift()(); await tick(); }
  await Promise.all(all);
  assert.equal(sent, 8); assert.equal(peak, 3);
});

test('EFA: a round of requests after "too many requests" costs as many requests as run at the same time – the rest in line stays at home', async () => {
  let sent = 0;
  const c = new EfaClient('https://x.test/efa', { maxParallel: 3, retries: 2, fetchImpl: async () => { sent++; return tooMany(); } });
  const r = await Promise.allSettled(Array.from({ length: 9 }, (_, i) => c.get('x', { i })));
  assert.equal(sent, 3);                                                // not 27
  assert.ok(r.every((x) => x.status === 'rejected'));
  assert.equal(r.filter((x) => /HTTP 429/.test(x.reason.message)).length, 3);
  assert.equal(r.filter((x) => /derzeit nicht erreichbar/.test(x.reason.message)).length, 6);
});

test('transport.rest: "too many requests" puts the source on pause as well', async () => {
  let sent = 0;
  const h = new HafasClient('https://x.test', { name: 'db', retries: 2, fetchImpl: async () => { sent++; return tooMany('30'); } });
  assert.equal(h.healthy(), true);
  await assert.rejects(h.searchStops('Freising'), /db: HTTP 429/);
  assert.equal(sent, 1); assert.equal(h.healthy(), false);
  await assert.rejects(h.searchStops('Freising'), /derzeit nicht erreichbar/);
  assert.equal(sent, 1);
  // 503 is still retried, with the wait the source asks for
  let n = 0;
  const g = new HafasClient('https://x.test', { retries: 1, fetchImpl: async () => { n++; return n === 1 ? { ok: false, status: 503, headers: { get: () => '0' } } : fine([]); } });
  assert.deepEqual(await g.searchStops('x'), []); assert.equal(n, 2);
});

test('Translation: a source that does not answer is named as such – no further spellings, no "not found"', async () => {
  let asked = 0;
  const down = { name: 'moby', searchStops: async () => { asked++; throw new ProviderError('moby: HTTP 429 – zu viele Anfragen, Pause 1 Min.', { status: 429, kind: 'http' }); } };
  const tr = createTranslator({ stop: async () => ({}) });
  const munich = { id: 'mvv|de:09162:6', name: 'München, München Hbf', lat: 48.1402, lon: 11.5586 };
  await assert.rejects(tr(munich, down), (e) => /HTTP 429/.test(e.message) && !/Grenze/.test(e.message));
  assert.equal(asked, 1);                                               // not four spellings with two requests each
  const timeout = { name: 'moby', searchStops: async () => { throw new ProviderError('moby: Zeitüberschreitung', { kind: 'network' }); } };
  await assert.rejects(tr(munich, timeout), /Zeitüberschreitung/);
  // The source answers but does not know the stop: now it really is "not found"
  await assert.rejects(tr(munich, { name: 'moby', searchStops: async () => [] }), /nicht auffindbar/);
  // A refusal of one spelling (HTTP 400) does not stop the next ones
  const picky = { name: 'oebb', searchStops: async (q) => { if (/\(/.test(q)) throw new ProviderError('oebb: HTTP 400', { status: 400, kind: 'http' }); return [{ id: '8100050', name: 'Freilassing', lat: 47.8394, lon: 12.9777 }]; } };
  assert.equal(await tr({ id: 'moby|de:09189:1', name: 'Freilassing (Obb), Freilassing', lat: 47.8395, lon: 12.9778 }, picky), '8100050');
});

test('Station search: an association on pause is left out and the answer does not count as complete (it is not cached)', async () => {
  const asked = [];
  const mk = (key, list, healthy) => ({ key, name: key, owns: (id) => String(id).startsWith(`${key}|`), healthy: () => healthy.v, searchStops: async () => { asked.push(key); return list; } });
  const mvv = mk('mvv', [{ id: 'mvv|de:09162:6', name: 'München Hbf', lat: 48.14, lon: 11.56 }], { v: true });
  const mobyUp = { v: false }, moby = mk('moby', [{ id: 'moby|de:09162:6', name: 'München Hbf', lat: 48.14, lon: 11.56 }], mobyUp);
  const off = { name: 'db', healthy: () => false, searchStops: async () => [] };
  const p = build(off, { ...off, name: 'oebb' }, false, [mvv, moby]);
  const r = await p.searchStops('München Hbf');
  assert.deepEqual(asked, ['mvv']); assert.equal(r.partial, true); assert.equal(r.length, 1);
  asked.length = 0; mobyUp.v = true;
  const r2 = await p.searchStops('München Hbf');
  assert.deepEqual(asked.sort(), ['moby', 'mvv']); assert.ok(!r2.partial);
  // the service does not remember the incomplete answer
  let calls = 0;
  const service = createService({ config, store: {}, providers: { searchStops: async () => { calls++; const l = [{ id: 'a', name: 'A' }]; l.partial = true; return l; } } });
  await service.searchStations('München'); await service.searchStations('München');
  assert.equal(calls, 2);
});

async function twoRoutes(name, clock) {
  const now = () => clock.t;
  const store = new ProfileStore(await mkdtemp(join(tmpdir(), name)), now);
  const dev = `${name.replace(/[^a-z0-9]/gi, '')}geraet12345678`;
  await store.update(dev, (p) => {
    // Monday 07:00: the first route is in its commute time, the second only commutes on Saturdays
    addTours(p, { from: { id: '8002078', name: 'Freising' }, to: { id: '8000261', name: 'München Hbf' }, schedule: { days: ['Mo'], departAfter: '07:00', departUntil: '08:00' } });
    addTours(p, { from: { id: '8000190', name: 'Landshut' }, to: { id: '8000261', name: 'München Hbf' }, schedule: { days: ['Sa'], departAfter: '07:00', departUntil: '08:00' } });
  });
  return { store, dev, now };
}

test('Push check: routes that cannot push right now are refreshed every ten minutes, the others every minute; the app always asks fresh', async () => {
  const clock = { t: Date.parse('2026-10-12T07:00:00+02:00') };             // Monday
  const { store, dev, now } = await twoRoutes('rego-idle-', clock);
  const asked = {};
  const client = { journeys: async (o) => { asked[o.fromId] = (asked[o.fromId] || 0) + 1; return []; }, stop: async () => ({ lines: [], lat: 48.4, lon: 11.74 }) };
  const service = createService({ config: { ...config, tourDeadlineMs: 500 }, store, now, providers: { forTour: () => client, forStop: () => client, searchStops: async () => [] } });
  const check = () => service.getState(dev, { background: true });
  await check();
  assert.deepEqual(asked, { 8002078: 1, 8000190: 1 });
  clock.t += 60e3; await check();
  assert.deepEqual(asked, { 8002078: 2, 8000190: 1 });                      // the Saturday route waits
  clock.t += 9 * 60e3; await check();                                        // ten minutes after its last query
  assert.deepEqual(asked, { 8002078: 3, 8000190: 2 });
  clock.t += 40e3; await service.getState(dev);                              // somebody opens the app: everything fresh (30 s)
  assert.deepEqual(asked, { 8002078: 4, 8000190: 3 });
  // Without the flag nothing changes: both routes every 30 seconds
  clock.t += 40e3; await service.getState(dev);
  assert.deepEqual(asked, { 8002078: 5, 8000190: 4 });
});

test('Push check: asks the service for a background state', async () => {
  const clock = { t: Date.parse('2026-10-12T12:00:00+02:00') };
  const { store, dev, now } = await twoRoutes('rego-bg-', clock);
  await store.update(dev, (p) => { p.push = { native: true }; });
  const seen = [];
  const service = { getState: async (d, o) => { seen.push(o); return { connection: { status: 'ok' }, tours: [], incidents: [] }; } };
  const n = createNotifier({ config, store, service, now, fcm: { enabled: false } });
  await n.checkDevice(dev);
  assert.deepEqual(seen, [{ background: true }]);
});

test('Run-through: the source says "too many requests" – nine routes cost three requests, then silence until the pause is over', async () => {
  const realFetch = globalThis.fetch;
  let sent = 0, mode = 'limit';
  globalThis.fetch = async (u) => {
    if (!String(u).includes('moby.test')) throw new Error(`unexpected ${u}`);
    sent++; return mode === 'limit' ? tooMany('120') : fine({ journeys: [] });
  };
  try {
    const clock = { t: Date.parse('2026-10-12T07:00:00+02:00') }; const now = () => clock.t;
    const dir = await mkdtemp(join(tmpdir(), 'rego-429-'));
    const store = new ProfileStore(dir, now); const dev = 'zuvieleanfragen1234';
    await store.update(dev, (p) => { for (let i = 1; i <= 9; i++) addTours(p, { from: { id: `moby|de:09162:${i}`, name: `Von ${i}` }, to: { id: `moby|de:09163:${i}`, name: `Nach ${i}` } }); });
    const cfg = { ...config, provider: 'transport-rest', verbose: false, tourDeadlineMs: 3000, upstream: { ...config.upstream, efa: [{ key: 'moby', url: 'https://moby.test/efa' }], retries: 2 } };
    const providers = createProviders(cfg, now);
    providers.efas[0].pause = new SourcePause({ now });
    const service = createService({ config: cfg, store, now, providers });

    let s = await service.getState(dev);
    assert.equal(sent, 3);                                                   // before: nine routes, three attempts each
    assert.equal(s.connection.status, 'error'); assert.ok(s.tours.every((x) => x.stale));
    clock.t += 70e3; await service.getState(dev);
    assert.equal(sent, 3);                                                   // pause of two minutes: not a single request
    clock.t += 70e3; await service.getState(dev);                            // pause over, source still closed: one test request
    assert.equal(sent, 4);
    mode = 'ok'; clock.t += 130e3; await service.getState(dev);              // the test request works …
    clock.t += 70e3; s = await service.getState(dev);                        // … and everything is back
    assert.equal(s.connection.status, 'ok'); assert.ok(s.tours.every((x) => !x.stale));
    assert.equal((await service.providers.efas[0].healthy()), true);
  } finally { globalThis.fetch = realFetch; }
});

// ---------- A source that asks for a day of peace (MoBY in October 2026: HTTP 429, Retry-After 86400, "not an open data endpoint") ----------

const CLOSED = { ok: false, status: 429, headers: { get: (h) => (String(h).toLowerCase() === 'retry-after' ? '86400' : null) }, text: async () => 'This endpoint is not an open data endpoint. Please contact the portal owner' };
const efaLeg = (from, to, dep, arr) => ({
  origin: { id: `${from}:1`, name: 'Von', type: 'platform', coord: [48.1, 11.5], parent: { id: from, name: 'Von', type: 'stop', coord: [48.1, 11.5] }, departureTimePlanned: dep, departureTimeEstimated: dep, properties: { platformName: '1', plannedPlatformName: '1' } },
  destination: { id: `${to}:1`, name: 'Nach', type: 'platform', coord: [48.2, 11.6], parent: { id: to, name: 'Nach', type: 'stop', coord: [48.2, 11.6] }, arrivalTimePlanned: arr, arrivalTimeEstimated: arr, properties: { platformName: '2', plannedPlatformName: '2' } },
  transportation: { id: 'x', name: 'S-Bahn S1', number: 'S1', product: { class: 1, name: 'S-Bahn' }, destination: { name: 'Nach' } },
  realtimeStatus: ['MONITORED'], stopSequence: [],
});
const MVV_TRIP = { journeys: [{ legs: [efaLeg('de:09162:1', 'de:09162:2', '2026-10-12T05:10:00Z', '2026-10-12T05:30:00Z')] }, { legs: [efaLeg('de:09162:1', 'de:09162:2', '2026-10-12T05:30:00Z', '2026-10-12T05:50:00Z')] }] };
const EFAS = [{ key: 'mvv', url: 'https://mvv.test/efa' }, { key: 'moby', url: 'https://moby.test/efa' }];

test('Run-through: a source asks for a day of peace – no request for hours, the routes say why, the banner stays off for the routes that are fine', async () => {
  const realFetch = globalThis.fetch, realLog = console.log;
  let moby = 0; const lines = [];
  globalThis.fetch = async (u) => {
    const url = String(u);
    if (url.includes('moby.test')) { moby++; return CLOSED; }
    if (url.includes('mvv.test')) return fine(MVV_TRIP);
    throw new Error(`unexpected ${url}`);
  };
  console.log = (...a) => { lines.push(a.join(' ')); };
  try {
    const clock = { t: Date.parse('2026-10-12T07:00:00+02:00') }; const now = () => clock.t;
    const dir = await mkdtemp(join(tmpdir(), 'rego-closed-'));
    const store = new ProfileStore(dir, now); const dev = 'einenmonatruhe12345';
    const sched = { days: ['Mo', 'Di', 'Mi', 'Do', 'Fr'], departAfter: '06:30', departUntil: '09:00' };
    await store.update(dev, (p) => {
      addTours(p, { from: { id: 'mvv|de:09162:1', name: 'Von' }, to: { id: 'mvv|de:09162:2', name: 'Nach' }, schedule: sched });
      for (let i = 1; i <= 2; i++) addTours(p, { from: { id: `moby|de:09162:${i}`, name: `Von ${i}` }, to: { id: `moby|de:09163:${i}`, name: `Nach ${i}` }, schedule: sched });
    });
    const ids = (await store.load(dev)).tours.map((x) => x.id);
    const cfg = { ...config, provider: 'transport-rest', verbose: true, tourDeadlineMs: 3000, upstream: { ...config.upstream, efa: EFAS, retries: 0 } };
    const providers = createProviders(cfg, now);
    for (const e of providers.efas) e.pause = new SourcePause({ now });
    const service = createService({ config: cfg, store, now, providers });

    let s = await service.getState(dev);
    const live = s.tours.find((x) => x.id === ids[0]), dead = s.tours.filter((x) => ids.slice(1).includes(x.id));
    assert.ok(live.departures.length >= 1 && !live.stale);
    assert.equal(dead.length, 2);
    for (const d of dead) {
      assert.equal(d.stale, true); assert.equal(d.view.big, 'Keine Daten');
      assert.equal(d.view.sub, 'MoBY lässt gerade keine Abfragen zu. ReGo fragt später wieder an.');       // the reason, not "the source does not answer"
    }
    assert.equal(s.connection.status, 'ok');                                 // two dead routes do not turn the whole screen into "Server offline"
    assert.ok(moby >= 1 && moby <= 2); const first = moby;
    assert.equal(lines.filter((l) => /moby: zu viele Anfragen \(HTTP 429, Retry-After 86400 s, „This endpoint is not an open data endpoint\. Please contact the portal owner“\) – Pause 24 Std\./.test(l)).length, 1);
    assert.equal(lines.filter((l) => /Abruf fehlgeschlagen/.test(l)).length, 0);      // not a line per route and minute

    for (const hours of [1, 6, 12]) { clock.t += hours * 3600e3; s = await service.getState(dev); }
    assert.equal(moby, first);                                               // 19 hours later: still not a single request to the source that asked for a day
    assert.equal(s.connection.status, 'ok');
    clock.t += 6 * 3600e3 + 120e3; await service.getState(dev);              // 25 hours: the pause is over, one test request decides
    assert.equal(moby, first + 1);
    assert.equal(lines.filter((l) => /Pause 24 Std\./.test(l)).length, 2);   // it still says no: another day of peace, one more line
    assert.equal(lines.filter((l) => /Abruf fehlgeschlagen/.test(l)).length, 0);
  } finally { globalThis.fetch = realFetch; console.log = realLog; }
});

test('Run-through: every route without data (the only source is closed) still shows the banner', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (u) => { if (String(u).includes('moby.test')) return CLOSED; throw new Error(`unexpected ${u}`); };
  try {
    const clock = { t: Date.parse('2026-10-12T07:00:00+02:00') }; const now = () => clock.t;
    const dir = await mkdtemp(join(tmpdir(), 'rego-closed-')); const store = new ProfileStore(dir, now); const dev = 'allesdichtgemacht123';
    await store.update(dev, (p) => { for (let i = 1; i <= 2; i++) addTours(p, { from: { id: `moby|de:09162:${i}`, name: `Von ${i}` }, to: { id: `moby|de:09163:${i}`, name: `Nach ${i}` } }); });
    const cfg = { ...config, provider: 'transport-rest', verbose: false, tourDeadlineMs: 3000, upstream: { ...config.upstream, efa: EFAS, retries: 0 } };
    const providers = createProviders(cfg, now); for (const e of providers.efas) e.pause = new SourcePause({ now });
    const s = await createService({ config: cfg, store, now, providers }).getState(dev);
    assert.equal(s.connection.status, 'error'); assert.ok(s.tours.every((x) => x.stale && x.view.big === 'Keine Daten'));
  } finally { globalThis.fetch = realFetch; }
});

test('Interface: a source on pause – the search with 1 transfer names it (503, "Sorry"), saving is not blocked, the status shows the pause', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (u, o) => {
    const url = String(u);
    if (url.startsWith('http://127.0.0.1')) return realFetch(u, o);
    if (url.includes('moby.test')) return CLOSED;
    if (url.includes('mvv.test')) return fine(MVV_TRIP);
    throw new Error(`unexpected ${url}`);
  };
  const clock = { t: Date.parse('2026-10-12T07:00:00+02:00') };
  const dir = await mkdtemp(join(tmpdir(), 'rego-closed-'));
  const cfg = { ...config, dataDir: dir, provider: 'transport-rest', verbose: false, upstream: { ...config.upstream, efa: EFAS, retries: 0 } };
  const { createApp } = await import('../server/index.mjs');
  const { server, service } = createApp({ cfg, now: () => clock.t });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`, h = { 'x-device': 'quellegesperrt123456', 'content-type': 'application/json' };
  const post = async (p, b) => { const r = await fetch(`${base}${p}`, { method: 'POST', headers: h, body: JSON.stringify(b) }); return { status: r.status, body: await r.json() }; };
  try {
    const A = { id: 'moby|de:09162:1', name: 'Von' }, B = { id: 'moby|de:09163:1', name: 'Nach' };
    await assert.rejects(service.providers.efas[1].get('XML_STOPFINDER_REQUEST'), /HTTP 429/);       // the first request gets the answer, the pause begins
    let r = await post('/api/connections/search', { from: A, to: B });
    assert.equal(r.status, 503); assert.equal(r.body.code, 'source-paused');
    assert.equal(r.body.error, 'Sorry, MoBY lässt gerade keine Abfragen zu. Die Suche geht für diese Strecke später wieder.');
    // when in doubt the route is created (the user must not be locked out), with or without a transfer
    r = await post('/api/tours', { from: A, to: B }); assert.equal(r.status, 201);
    r = await post('/api/tours', { from: B, to: A, transfers: 1 }); assert.equal(r.status, 201);
    // a route in the area of the other association is not affected
    r = await post('/api/connections/search', { from: { id: 'mvv|de:09162:1', name: 'Von' }, to: { id: 'mvv|de:09162:2', name: 'Nach' } }); assert.equal(r.status, 200); assert.equal(r.body.found, true);
    const st = await (await fetch(`${base}/api/status`)).json();
    const m = st.sources.find((x) => x.name === 'moby'), v = st.sources.find((x) => x.name === 'mvv');
    assert.equal(m.ok, false); assert.ok(m.pausedSec > 86000 && m.pausedSec <= 86400);
    assert.equal(v.ok, true); assert.ok(!('pausedSec' in v));
  } finally { server.close(); globalThis.fetch = realFetch; }
});
