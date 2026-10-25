// New in 0.7.2: commute time. For each direction you choose the window in which you depart (from – until), and ReGo aligns
// order, rated trains, push and the wording ("planmäßig" instead of "pünktlich" for far-away departures) with it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  fmtMin, untilMin, windowOf, windowState, windowView, windowRank, pushActive, pushAtNight, isFar, DEFAULT_SCHEDULE,
  ANCHOR_LEAD_MIN, PUSH_LEAD_MIN, PUSH_TAIL_MIN, FAR_MIN, WINDOW_DEFAULT_LEN, WINDOW_MIN_LEN,
} from '../server/domain/window.mjs';
import { buildTour } from '../server/domain/state.mjs';
import { ProfileStore, addTours, patchTour, defaultProfile } from '../server/store/profile.mjs';
import { createService } from '../server/service.mjs';
import { createApp } from '../server/index.mjs';
import { config } from '../server/config.mjs';
import { toMin } from '../server/lib/time.mjs';

const MH = { id: '8000261', name: 'München Hbf' }, SZ = { id: '8100002', name: 'Salzburg Hbf' }, FS = { id: '8002078', name: 'Fiktivia' };
const MON = '2026-10-12', WED = '2026-10-14', SAT = '2026-10-17';              // summer time (CEST)
const ms = (hm, day = MON, sec = '00') => Date.parse(`${day}T${hm}:${sec}+02:00`);
const iso = (hm, day = MON) => `${day}T${hm}:00+02:00`;
const WEEK = ['Mo', 'Di', 'Mi', 'Do', 'Fr'];
const SCH = { days: WEEK, departAfter: '07:00', departUntil: '08:00' };

// ---------- reine Fensterlogik ----------

test('Commute time: end of the window – if missing, one hour; at least 10 minutes; never past midnight', () => {
  assert.equal(WINDOW_DEFAULT_LEN, 60); assert.equal(WINDOW_MIN_LEN, 10);
  const end = (from, until) => fmtMin(untilMin(toMin(from), until));
  assert.equal(end('07:00', '08:30'), '08:30');
  assert.equal(end('07:00', undefined), '08:00');                // an older route only knows "from"
  assert.equal(end('07:00', 'quatsch'), '08:00');
  assert.equal(end('07:00', '24:00'), '08:00');
  assert.equal(end('07:00', '07:05'), '07:10');                  // too short
  assert.equal(end('07:00', '06:00'), '07:10');                  // end before the start
  assert.equal(end('23:30', undefined), '23:59');                // no window past midnight
  assert.equal(end('23:55', '23:59'), '23:59');
  assert.deepEqual(windowOf({ departAfter: '06:30' }), { from: '06:30', until: '07:30' });
  assert.deepEqual(windowOf({ departAfter: '06:30', departUntil: '09:15' }), { from: '06:30', until: '09:15' });
  assert.deepEqual(windowOf(undefined), { from: '07:00', until: '08:00' });
  assert.deepEqual(windowOf({ departAfter: '25:99', departUntil: '10:00' }), { from: '07:00', until: '10:00' });
});

test('Commute time: state of the window over the course of the day (before, running, over, not a commute day)', () => {
  const at = (hm, sec = '00', sch = SCH, day = MON) => windowState(sch, ms(hm, day, sec));
  const short = (w) => [w.mode, w.anchor === null ? null : w.anchor];
  assert.equal(ANCHOR_LEAD_MIN, 180);
  // more than three hours before the start: do not request anything from the window start yet
  assert.deepEqual(short(at('03:59', '59')), ['soon', null]);
  assert.deepEqual(short(at('04:00')), ['soon', ms('07:00')]);              // exactly three hours before
  assert.deepEqual(short(at('06:59', '59')), ['soon', ms('07:00')]);
  assert.equal(at('06:59', '59').endMs, ms('08:00'));
  // the window runs from 07:00 up to and including 08:00
  assert.deepEqual(short(at('07:00')), ['now', null]); assert.equal(at('07:00').endMs, ms('08:00'));
  assert.equal(at('08:00').mode, 'now');
  assert.equal(at('08:00', '01').mode, 'done'); assert.equal(at('08:00', '01').endMs, null);
  assert.equal(at('23:00').mode, 'done');
  // another weekday: not today, but the times stay known
  const sat = at('07:30', '00', SCH, SAT);
  assert.deepEqual([sat.mode, sat.from, sat.until, sat.anchor, sat.endMs], ['off', '07:00', '08:00', null, null]);
  assert.equal(at('07:30', '00', SCH, WED).mode, 'now');
  // older route without an end: one hour
  assert.deepEqual([at('07:30', '00', { days: WEEK, departAfter: '07:00' }).mode, at('08:30', '00', { days: WEEK, departAfter: '07:00' }).mode], ['now', 'done']);
  // no usable times: no window
  for (const bad of [undefined, null, {}, { days: WEEK }, { days: WEEK, departAfter: 'früh' }, { departAfter: '07:00' }]) {
    assert.deepEqual(windowState(bad, ms('07:30')), { mode: 'off', anchor: null, endMs: null });
  }
});

test('Push: from one hour before the window until 10 minutes after, only on commute days', () => {
  assert.equal(PUSH_LEAD_MIN, 60); assert.equal(PUSH_TAIL_MIN, 10);
  const tour = { schedule: SCH };
  assert.equal(pushActive(tour, ms('05:59', MON, '59')), false);
  assert.equal(pushActive(tour, ms('06:00')), true);
  assert.equal(pushActive(tour, ms('07:00')), true);
  assert.equal(pushActive(tour, ms('08:00')), true);
  assert.equal(pushActive(tour, ms('08:10')), true);
  assert.equal(pushActive(tour, ms('08:10', MON, '01')), false);
  assert.equal(pushActive(tour, ms('07:30', WED)), true);
  assert.equal(pushActive(tour, ms('07:30', SAT)), false);                          // Saturday is not a commute day
  assert.equal(pushActive({ schedule: { days: WEEK, departAfter: '07:00' } }, ms('08:05')), true);    // without an end one hour applies: until 08:10
  assert.equal(pushActive({ schedule: { days: WEEK, departAfter: '07:00' } }, ms('08:11')), false);
  // route without times (older data): push as before
  for (const bad of [undefined, {}, { schedule: {} }, { schedule: { departAfter: '07:00' } }]) assert.equal(pushActive(bad, ms('03:00')), true);
});

test('Night quiet exception: only a route with its own times, and only while its push period runs', () => {
  const early = { schedule: { days: WEEK, departAfter: '04:20', departUntil: '05:20' } };       // push period 03:20–05:30
  assert.equal(pushAtNight(early, ms('03:19', MON, '59')), false);
  assert.equal(pushAtNight(early, ms('03:20')), true);                                          // one hour before the window
  assert.equal(pushAtNight(early, ms('04:20')), true);
  assert.equal(pushAtNight(early, ms('05:30')), true);
  assert.equal(pushAtNight(early, ms('05:30', MON, '01')), false);
  assert.equal(pushAtNight(early, ms('03:30', SAT)), false);                                    // Saturday is no commute day
  const late = { schedule: { days: WEEK, departAfter: '22:30', departUntil: '23:30' } };        // the period reaches past 23:00
  assert.equal(pushAtNight(late, ms('23:40')), true);
  assert.equal(pushAtNight(late, ms('23:41')), false);
  // an ordinary morning route has no part in the night
  assert.equal(pushAtNight({ schedule: SCH }, ms('03:00')), false);
  // no times (older data): pushActive allows it, but at night that is not enough
  for (const bad of [undefined, {}, { schedule: {} }, { schedule: { departAfter: '04:20' } }, { schedule: { days: WEEK } }]) {
    assert.equal(pushActive(bad, ms('03:30')), true);
    assert.equal(pushAtNight(bad, ms('03:30')), false);
  }
});

test('Far-away departures, order of the routes and the times going out', () => {
  assert.equal(FAR_MIN, 45);
  assert.equal(isFar(ms('07:45'), ms('07:00')), false);                             // exactly 45 minutes: still "pünktlich"
  assert.equal(isFar(ms('07:45', MON, '01'), ms('07:00')), true);
  assert.equal(isFar(ms('06:50'), ms('07:00')), false);                             // already gone or immediate
  assert.deepEqual(['now', 'soon', 'done', 'off', undefined].map(windowRank), [0, 1, 2, 2, 2]);
  // Times and state as they go to the app – also for a route that only knows "from"
  const v = windowView({ days: ['Mo'], departAfter: '06:30' }, ms('06:00'));
  assert.deepEqual(v.schedule, { days: ['Mo'], departAfter: '06:30', departUntil: '07:30' });
  assert.deepEqual(v.window, { from: '06:30', until: '07:30', mode: 'soon' });
  assert.deepEqual(windowView(undefined, ms('07:00')).schedule, { ...DEFAULT_SCHEDULE, departUntil: '07:00' });   // 06:00 + length gives 07:00
  assert.equal(windowView(undefined, ms('06:30')).window.mode, 'now');
});

// ---------- Profil ----------

test('Create route: commute time with end, return trip with its own time, defaults and minimum length', () => {
  const p = defaultProfile();
  const [outbound, inbound] = addTours(p, { from: FS, to: MH, schedule: { days: ['Mo', 'Di'], departAfter: '06:40', departUntil: '07:20' }, roundTrip: true, returnAfter: '16:00', returnUntil: '17:15' });
  assert.deepEqual(outbound.schedule, { days: ['Mo', 'Di'], departAfter: '06:40', departUntil: '07:20' });
  assert.deepEqual(inbound.schedule, { days: ['Mo', 'Di'], departAfter: '16:00', departUntil: '17:15' });
  assert.equal(outbound.period, 'am'); assert.equal(inbound.period, 'pm');
  // without details: outward 07:00–08:00, return 16:30–17:30
  const [h2, r2] = addTours(defaultProfile(), { from: FS, to: MH, roundTrip: true });
  assert.deepEqual([h2.schedule.departAfter, h2.schedule.departUntil, r2.schedule.departAfter, r2.schedule.departUntil], ['07:00', '08:00', '16:30', '17:30']);
  // older app: only "from" – the window lasts one hour
  const [h3, r3] = addTours(defaultProfile(), { from: FS, to: MH, schedule: { days: WEEK, departAfter: '06:15' }, roundTrip: true, returnAfter: '15:45' });
  assert.deepEqual([h3.schedule.departUntil, r3.schedule.departUntil], ['07:15', '16:45']);
  // end too early or broken, start late in the evening
  const [h4, r4] = addTours(defaultProfile(), { from: FS, to: MH, schedule: { days: WEEK, departAfter: '07:00', departUntil: '06:00' }, roundTrip: true, returnAfter: '23:40', returnUntil: 'x' });
  assert.deepEqual([h4.schedule.departUntil, r4.schedule.departUntil], ['07:10', '23:59']);
  // the same route with the same times (e.g. tapped twice) is not created again; another end is another commute time
  const q = defaultProfile();
  const first = addTours(q, { from: FS, to: MH, schedule: SCH, roundTrip: true });
  assert.equal(addTours(q, { from: FS, to: MH, schedule: SCH, roundTrip: true })[0].id, first[0].id);
  assert.equal(q.tours.length, 2);
  addTours(q, { from: FS, to: MH, schedule: { ...SCH, departUntil: '09:00' } });
  assert.equal(q.tours.length, 3);
});

test('Change route: the window keeps its length when only the start comes; days alone leave the times', () => {
  const p = defaultProfile();
  const t = addTours(p, { from: FS, to: MH, schedule: { days: WEEK, departAfter: '07:00', departUntil: '08:30' } })[0];
  patchTour(p, t.id, { schedule: { departAfter: '06:00' } });                        // older app sends only the start
  assert.deepEqual([t.schedule.departAfter, t.schedule.departUntil], ['06:00', '07:30']);
  patchTour(p, t.id, { schedule: { departAfter: '06:10', departUntil: '09:00' } });
  assert.deepEqual([t.schedule.departAfter, t.schedule.departUntil], ['06:10', '09:00']);
  patchTour(p, t.id, { schedule: { days: ['Mi'] } });
  assert.deepEqual(t.schedule, { days: ['Mi'], departAfter: '06:10', departUntil: '09:00' });
  patchTour(p, t.id, { schedule: { departUntil: '06:15' } });                        // end too early: at least 10 minutes after the start
  assert.equal(t.schedule.departUntil, '06:20');
  patchTour(p, t.id, { schedule: { departAfter: '23:30', departUntil: '23:50' } });
  patchTour(p, t.id, { schedule: { departAfter: '23:45' } });                        // length 20 min no longer fits before midnight
  assert.deepEqual([t.schedule.departAfter, t.schedule.departUntil], ['23:45', '23:59']);
  assert.equal(t.period, 'pm');
  // Route from an older version: stored without an end, the hour is added when changing
  const old = { id: 'told', name: 'alt', from: FS, to: MH, active: true, period: 'am', schedule: { days: WEEK, departAfter: '06:30' } };
  p.tours.push(old);
  patchTour(p, 'told', { active: false });
  assert.deepEqual(old.schedule, { days: WEEK, departAfter: '06:30' });              // untouched as long as nobody changes the times
  patchTour(p, 'told', { schedule: { days: ['Mo'] } });
  assert.deepEqual(old.schedule, { days: ['Mo'], departAfter: '06:30', departUntil: '07:30' });
});

// ---------- Rating of the trains ----------

const tour = { id: 't1', name: 'München Hbf → Salzburg Hbf', from: MH, to: SZ, active: true, schedule: SCH };
const leg = (dep, o = {}) => ({ line: { name: 'RE 5', product: 'regional' }, direction: 'Salzburg', origin: MH, destination: SZ,
  plannedDep: dep, dep, depDelay: 0, plannedArr: dep, arr: dep, arrDelay: 0, plannedPlatform: '13', platform: '13', stopovers: [], remarks: [], ...o });
const J = (...legs) => legs.map((l) => ({ legs: [l] }));
const ctx = (now, o = {}) => ({ now, minDelay: 3, linesAt: async () => [], lines: {}, window: windowState(SCH, now), ...o });

test('Your train: during and before the window only trips up to its end count, the "Danach" looks beyond', async () => {
  const short = { ...tour, schedule: { days: WEEK, departAfter: '07:00', departUntil: '07:30' } };
  const win = (now) => windowState(short.schedule, now);
  // the window runs: the trip at 08:20 lies beyond it
  let now = ms('07:10');
  let r = await buildTour(short, J(leg(iso('07:20')), leg(iso('07:25')), leg(iso('08:20'))), ctx(now, { window: win(now) }));
  assert.deepEqual(r.tour.departures.map((d) => d.plannedTime), ['07:20', '07:25']);
  assert.equal(r.tour.window.mode, 'now');
  r = await buildTour(short, J(leg(iso('07:20')), leg(iso('08:20'))), ctx(now, { window: win(now) }));
  assert.deepEqual(r.tour.departures.map((d) => d.plannedTime), ['07:20']);
  assert.equal(r.tour.view.alternative.title, 'Danach'); assert.match(r.tour.view.alternative.line1, /ab 08:20/);       // "Danach" may look beyond the window
  // nothing in the window yet (e.g. source failure for this time): better the next trains than none at all
  r = await buildTour(short, J(leg(iso('08:20')), leg(iso('08:50'))), ctx(now, { window: win(now) }));
  assert.deepEqual(r.tour.departures.map((d) => d.plannedTime), ['08:20', '08:50']);
  // before the window, query from its start: the same
  now = ms('05:30');
  r = await buildTour(short, J(leg(iso('07:05')), leg(iso('07:25')), leg(iso('08:20'))), ctx(now, { window: win(now) }));
  assert.deepEqual(r.tour.departures.map((d) => d.plannedTime), ['07:05', '07:25']);
  assert.equal(r.tour.window.mode, 'soon');
  // more than three hours before, the query does not start from the beginning, so nothing is narrowed down either
  now = ms('03:00');
  r = await buildTour(short, J(leg(iso('03:20')), leg(iso('08:20'))), ctx(now, { window: win(now) }));
  assert.deepEqual(r.tour.departures.map((d) => d.plannedTime), ['03:20', '08:20']);
  // no commute day today or window over: as before the next trains, nothing narrowed down
  now = ms('07:10', SAT);
  r = await buildTour(short, J(leg(iso('07:20', SAT)), leg(iso('08:20', SAT))), ctx(now, { window: win(now) }));
  assert.deepEqual(r.tour.departures.map((d) => d.plannedTime), ['07:20', '08:20']); assert.equal(r.tour.window.mode, 'off');
  now = ms('09:00');
  r = await buildTour(short, J(leg(iso('09:20')), leg(iso('09:40'))), ctx(now, { window: win(now) }));
  assert.deepEqual(r.tour.departures.map((d) => d.plannedTime), ['09:20', '09:40']); assert.equal(r.tour.window.mode, 'done');
  // without information on the window (other callers): nothing narrowed down
  now = ms('07:10');
  r = await buildTour(short, J(leg(iso('07:20')), leg(iso('08:20'))), { now, minDelay: 3, linesAt: async () => [], lines: {} });
  assert.equal(r.tour.departures.length, 2);
});

test('"planmäßig" instead of "pünktlich" as long as the departure is more than 45 minutes away', async () => {
  // Window begins in 90 minutes, the first trip departs at 07:05
  let now = ms('05:30');
  let r = await buildTour(tour, J(leg(iso('07:05')), leg(iso('07:25'))), ctx(now));
  assert.equal(r.tour.view.kind, 'ok'); assert.equal(r.tour.view.big, 'planmäßig'); assert.match(r.tour.view.head, /^Planmäßig · RE 5 ab 07:05$/);
  assert.equal(r.tour.departures[0].far, true);
  assert.equal(r.tour.view.alternative.badge, 'planmäßig');
  // 35 minutes before: the source knows delays, so "pünktlich"; and the trip carries no "far away" flag
  now = ms('06:30');
  r = await buildTour(tour, J(leg(iso('07:05')), leg(iso('07:25'))), ctx(now));
  assert.equal(r.tour.view.big, 'pünktlich'); assert.match(r.tour.view.head, /^Pünktlich · RE 5 ab 07:05$/);
  assert.ok(!('far' in r.tour.departures[0]));
  // exactly 45 minutes: still "pünktlich"
  now = ms('06:20');
  r = await buildTour(tour, J(leg(iso('07:05'))), ctx(now));
  assert.equal(r.tour.view.big, 'pünktlich');
  // a known delay is always named, even long before departure
  now = ms('05:30');
  r = await buildTour(tour, J(leg(iso('07:05'), { dep: iso('07:13'), depDelay: 8 }), leg(iso('07:25'))), ctx(now));
  assert.equal(r.incidents.length, 1); assert.equal(r.incidents[0].view.kind, 'delay'); assert.equal(r.incidents[0].view.big, '+8 Min.');
});

// ---------- Query and order in the service ----------

async function serviceAt(t0, toursIn) {
  const dir = await mkdtemp(join(tmpdir(), 'rego-w-'));
  const clock = { t: t0 }, now = () => clock.t;
  const store = new ProfileStore(dir, now), dev = 'fenstergeraet12345678';
  await store.update(dev, (p) => { for (const x of toursIn) addTours(p, x); });
  const calls = [];
  // Stand-in for the source: a trip five minutes after the requested time
  const client = {
    journeys: async (q) => { calls.push(q); return [{ legs: [leg(new Date(Date.parse(q.when) + 5 * 60000).toISOString())] }]; },
    stop: async () => ({ lines: [], lat: 48.14, lon: 11.56 }),
  };
  const providers = { forTour: () => client, forStop: () => client, searchStops: async () => [] };
  const service = createService({ config: { ...config, tourDeadlineMs: 500 }, store, now, providers });
  return { service, calls, clock, dev, store };
}

test('Service: before the window the query starts at its beginning (3 hours before at most), otherwise from now', async () => {
  const when = (hm, day = MON) => new Date(ms(hm, day)).toISOString();
  const { service, calls, clock, dev } = await serviceAt(ms('03:00'), [{ from: MH, to: SZ, schedule: SCH }]);
  // more than three hours before: from now (nothing new to expect yet)
  let s = await service.getState(dev);
  assert.equal(calls.length, 1); assert.equal(calls[0].when, when('03:00')); assert.equal(s.tours[0].window.mode, 'soon');
  // two hours before: from the start of the window, "planmäßig" because far away
  clock.t = ms('05:00'); s = await service.getState(dev);
  assert.equal(calls.length, 2); assert.equal(calls[1].when, when('07:00'));
  assert.equal(s.tours[0].window.mode, 'soon'); assert.deepEqual([s.tours[0].window.from, s.tours[0].window.until], ['07:00', '08:00']);
  assert.equal(s.tours[0].departures[0].plannedTime, '07:05');
  assert.equal(s.tours[0].view.big, 'planmäßig');                                    // 125 minutes away
  // within the holding period the answer comes from the cache
  clock.t += 10e3; await service.getState(dev); assert.equal(calls.length, 2);
  // the time until the window shrinks: the query stays on the start of the window, not on "now"
  clock.t = ms('06:30'); s = await service.getState(dev);
  assert.equal(calls.length, 3); assert.equal(calls[2].when, when('07:00')); assert.equal(s.tours[0].view.big, 'pünktlich');   // 35 minutes away
  // the window runs: from now
  clock.t = ms('07:20'); s = await service.getState(dev);
  assert.equal(calls.length, 4); assert.equal(calls[3].when, when('07:20')); assert.equal(s.tours[0].window.mode, 'now');
  // over: from now, as before
  clock.t = ms('09:00'); s = await service.getState(dev);
  assert.equal(calls[4].when, when('09:00')); assert.equal(s.tours[0].window.mode, 'done');
  // another weekday: from now, no narrowing
  const sat = await serviceAt(ms('06:30', SAT), [{ from: MH, to: SZ, schedule: SCH }]);
  s = await sat.service.getState(sat.dev);
  assert.equal(sat.calls[0].when, when('06:30', SAT)); assert.equal(s.tours[0].window.mode, 'off');
});

test('Service: on top is the route whose window is running, then the one that comes later today, last the rest', async () => {
  const MORNING = { days: WEEK, departAfter: '07:00', departUntil: '08:00' }, EVENING = { days: WEEK, departAfter: '16:30', departUntil: '17:30' }, LATE = { days: WEEK, departAfter: '18:00', departUntil: '19:00' };
  const mk = (t0) => serviceAt(t0, [
    { from: FS, to: MH, schedule: LATE }, { from: MH, to: SZ, schedule: EVENING }, { from: MH, to: FS, schedule: MORNING },
  ]);
  const order = async (t0, mutate) => {
    const x = await mk(t0); if (mutate) await x.store.update(x.dev, mutate);
    return (await x.service.getState(x.dev)).tours.map((t) => `${t.window.from}=${t.window.mode}`).join(' ');
  };
  // 07:30 – morning one runs; evening 16:30 comes before 18:00
  assert.equal(await order(ms('07:30')), '07:00=now 16:30=soon 18:00=soon');
  // 06:30 – all still before their window: the earliest first, regardless of the order of creation
  assert.equal(await order(ms('06:30')), '07:00=soon 16:30=soon 18:00=soon');
  // 17:00 – evening one runs, morning one is over and therefore comes after what is still to come
  assert.equal(await order(ms('17:00')), '16:30=now 18:00=soon 07:00=done');
  // 20:00 – all over: order as created (distance unknown)
  assert.equal(await order(ms('20:00')), '18:00=done 16:30=done 07:00=done');
  // Saturday: no commuting today
  assert.equal(await order(ms('07:30', SAT)), '18:00=off 16:30=off 07:00=off');
  // switched-off routes come last, even if their window is running right now
  const off = await order(ms('07:30'), (p) => { p.tours.find((t) => t.schedule.departAfter === '07:00').active = false; });
  assert.equal(off, '16:30=soon 18:00=soon 07:00=now');
});

test('Interface: create route with window and return trip, older app without end, old switch "Nur rund um die Abfahrt"', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'rego-wa-'));
  const { server } = createApp({ cfg: { ...config, dataDir: dir, provider: 'mock', notifyEverySec: 0 } });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`, h = { 'x-device': 'fensterapigeraet12345', 'content-type': 'application/json' };
  const call = (path, method, body) => fetch(base + path, { method, headers: h, body: body ? JSON.stringify(body) : undefined });
  try {
    let r = await call('/api/tours', 'POST', { from: FS, to: MH, schedule: { days: WEEK, departAfter: '06:45', departUntil: '07:45' }, roundTrip: true, returnAfter: '16:15', returnUntil: '17:45' });
    assert.equal(r.status, 201);
    const made = (await r.json()).tours;
    assert.deepEqual(made.map((t) => [t.schedule.departAfter, t.schedule.departUntil]), [['06:45', '07:45'], ['16:15', '17:45']]);
    // older app changes only the start: the window keeps its length (one hour)
    r = await call('/api/tours/' + made[0].id, 'PATCH', { schedule: { days: WEEK, departAfter: '06:00' } });
    assert.equal(r.status, 200);
    const patched = await r.json();
    assert.deepEqual([patched.schedule.departAfter, patched.schedule.departUntil], ['06:00', '07:00']);
    assert.equal((await (await call('/api/profile', 'GET')).json()).tours[0].schedule.departUntil, '07:00');
    // State of the app: times, window and state per route
    const state = await (await call('/api/state', 'GET')).json();
    for (const t of state.tours) {
      assert.match(t.schedule.departUntil, /^\d\d:\d\d$/); assert.match(t.window.from, /^\d\d:\d\d$/); assert.ok(['now', 'soon', 'done', 'off'].includes(t.window.mode));
    }
    // the old switch is accepted (older app), but stays without effect and no longer shows up
    r = await call('/api/settings', 'PUT', { pushWindow: true, pushThresholdMin: 3 });
    assert.equal(r.status, 200);
    const settings = (await (await call('/api/profile', 'GET')).json()).settings;
    assert.equal(settings.pushThresholdMin, 3); assert.ok(!('pushWindow' in settings));
    assert.equal((await call('/api/settings', 'PUT', { pushWindow: true })).status, 200);
    assert.equal((await call('/api/settings', 'PUT', { pushWindow: 'ja' })).status, 400);
  } finally { server.close(); }
});
