// New in 0.7.1: "Schneller mit 1 Umstieg" (faster with 1 transfer). If a route without transfer has replacement transport, the incident shows a connection with one transfer
// that is earlier at the destination – only if it is safe and at least 5 minutes faster.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { shortcutFor, SHORTCUT_MIN_SAVING } from '../server/domain/transfer.mjs';
import { buildTour } from '../server/domain/state.mjs';
import { ProfileStore, addTours } from '../server/store/profile.mjs';
import { createService } from '../server/service.mjs';
import { config } from '../server/config.mjs';

const tmp = (n = 'rego-s-') => mkdtemp(join(tmpdir(), n));
const FS = { id: '8002078', name: 'Freising' }, MO = { id: '8000902', name: 'Moosach' }, MH = { id: '8000261', name: 'München Hbf' };
const NOW = Date.parse('2026-10-14T07:00:00+02:00');
const at = (hhmm) => `2026-10-14T${hhmm}:00+02:00`;
const add = (hhmm, m) => { const [h, mi] = hhmm.split(':').map(Number); const x = h * 60 + mi + m; return `${String(Math.floor(x / 60)).padStart(2, '0')}:${String(x % 60).padStart(2, '0')}`; };

// Replacement transport between Neufahrn and Moosach: the S1 takes 25 minutes longer
const SEV = { type: 'status', code: 'construction', summary: 'Schienenersatzverkehr', text: 'Wegen Bauarbeiten zwischen Neufahrn und Moosach Schienenersatzverkehr mit Bussen. Reisezeit verlängert sich um ca. 25 Minuten.', validFrom: at('05:00'), validUntil: '2026-10-17T00:00:00+02:00' };
// Trip without transfer: S1 Freising → München Hbf, 46 min, with replacement transport (except noSev)
const D = (dep, o = {}) => {
  const d = o.late || 0, arrLate = o.arrLate ?? d;
  return { line: { name: 'S1', product: 'suburban' }, direction: 'Ostbahnhof', origin: FS, destination: MH,
    plannedDep: at(dep), dep: at(add(dep, d)), depDelay: d, plannedArr: at(add(dep, 46)), arr: at(add(dep, 46 + arrLate)), arrDelay: arrLate,
    plannedPlatform: '3', platform: '3', stopovers: [FS, { id: 'a', name: 'Neufahrn' }, { id: 'b', name: 'Feldmoching' }, MO, MH],
    remarks: o.noSev ? [] : [SEV], cancelled: false };
};
// Detour: RE 22 Freising → Moosach (25 min), then U3 Moosach → München Hbf (15 min)
const A = (dep, o = {}) => ({ line: { name: 'RE 22', product: 'regionalExpress' }, direction: 'Moosach', origin: FS, destination: MO,
  plannedDep: at(dep), dep: at(dep), depDelay: 0, plannedArr: at(add(dep, 25)), arr: at(add(dep, 25)), arrDelay: 0, plannedPlatform: '1', platform: '1',
  stopovers: [FS, MO], remarks: o.remarks || [], cancelled: !!o.cancelled });
const B = (dep, o = {}) => ({ line: { name: 'U3', product: 'subway' }, direction: 'Fürstenried West', origin: MO, destination: MH,
  plannedDep: at(dep), dep: at(dep), depDelay: 0, plannedArr: at(add(dep, 15)), arr: at(add(dep, 15)), arrDelay: 0, plannedPlatform: '1', platform: '1',
  stopovers: [MO, MH], remarks: o.remarks || [], cancelled: !!o.cancelled });
const J = (...legs) => ({ legs });
// Trip with replacement transport: from 07:02, planned arrival 07:48, with 25 min more arriving 08:13
const O = { now: NOW, depart: Date.parse(at('07:02')), arrive: Date.parse(at('08:13')) };

test('Shortcut: picks the earliest safe connection and names lines, transfer, arrival and savings', () => {
  const card = shortcutFor([J(A('07:30'), B('08:00')), J(A('07:10'), B('07:41'))], O);
  assert.deepEqual(card, { title: 'Schneller mit 1 Umstieg', line1: 'RE 22 › U3 ab 07:10', line2: 'Umstieg Moosach · 6 Min.', line3: 'An 07:56 statt 08:13', badge: '−17 Min.', saved: 17, via: 'Moosach' });
});

test('Shortcut: with the same arrival the earlier departure wins, otherwise the earlier arrival', () => {
  assert.equal(shortcutFor([J(A('07:12'), B('07:41')), J(A('07:10'), B('07:41'))], O).line1, 'RE 22 › U3 ab 07:10');
  assert.equal(shortcutFor([J(A('07:10'), B('07:50')), J(A('07:13'), B('07:41'))], O).line1, 'RE 22 › U3 ab 07:13');     // 07:13 arrives at 07:56, 07:10 only at 08:05
});

test('Shortcut: only from 5 minutes of gain', () => {
  assert.equal(SHORTCUT_MIN_SAVING, 5);
  assert.equal(shortcutFor([J(A('07:10'), B('07:54'))], O), null);                  // arriving 08:09 = 4 min earlier: not enough
  const c = shortcutFor([J(A('07:10'), B('07:53'))], O);                            // arriving 08:08 = 5 min earlier
  assert.equal(c.saved, 5); assert.equal(c.badge, '−5 Min.');
  assert.equal(shortcutFor([J(A('07:10'), B('08:10'))], O), null);                  // later than the trip with replacement transport
});

test('Shortcut: nothing unsafe – cancellation, replacement transport on the detour, tight connection, already gone, much later', () => {
  const ok = [J(A('07:10'), B('07:41'))];
  assert.ok(shortcutFor(ok, O));
  assert.equal(shortcutFor([J(A('07:10', { cancelled: true }), B('07:41'))], O), null);            // feeder is cancelled
  assert.equal(shortcutFor([J(A('07:10'), B('07:41', { cancelled: true }))], O), null);            // connection is cancelled
  assert.equal(shortcutFor([J(A('07:10', { remarks: [SEV] }), B('07:41'))], O), null);             // replacement transport on the feeder
  assert.equal(shortcutFor([J(A('07:10'), B('07:41', { remarks: [SEV] }))], O), null);             // … or on the connection
  assert.ok(shortcutFor([J(A('07:10', { remarks: [{ ...SEV, validUntil: at('06:30') }]}), B('07:41'))], O));   // expired remark does not count
  assert.equal(shortcutFor([J(A('07:10'), B('07:37'))], O), null);                                 // only 2 min to transfer (arriving 07:35, departing 07:37)
  assert.ok(shortcutFor([J(A('07:10'), B('07:38'))], O));                                          // 3 min are enough
  assert.equal(shortcutFor([J(A('06:50'), B('07:21'))], O), null);                                 // already departed (now 07:00)
  const late = { ...O, arrive: Date.parse(at('09:00')) };                                          // much later at the destination: then only how late the detour departs counts
  assert.ok(shortcutFor([J(A('07:30'), B('08:00'))], late));                                       // 28 min after the trip with replacement transport: ok
  assert.equal(shortcutFor([J(A('07:40'), B('08:10'))], late), null);                              // 38 min after: too late
});

test('Shortcut: direct trips, empty lists and unusable data give no hint', () => {
  assert.equal(shortcutFor([J(D('07:02', { noSev: true }))], O), null);                            // only a trip without transfer
  assert.equal(shortcutFor([J(A('07:10'), B('07:41'), D('07:50'))], O), null);                     // more than one transfer is not meant
  assert.equal(shortcutFor([], O), null); assert.equal(shortcutFor(undefined, O), null);
  assert.equal(shortcutFor([J(A('07:10'), B('07:41'))], { ...O, arrive: NaN }), null);
  assert.equal(shortcutFor([J(A('07:10'), B('07:41'))], { ...O, depart: undefined }), null);
});

// ---------- in the incident ----------

const tour = { id: 'tk1', name: 'Freising → München Hbf', from: FS, to: MH, active: true };
const ctx = (o = {}) => ({ now: NOW, minDelay: 3, linesAt: async () => [], lines: {}, ...o });
const DETOURS = [J(D('07:02')), J(A('07:10'), B('07:41')), J(A('07:30'), B('08:00'))];

test('Replacement-transport incident carries the card; delay, construction and missing function do not', async () => {
  const sf = (o) => shortcutFor(DETOURS, { now: NOW, ...o });
  const direct = [J(D('07:02')), J(D('07:22')), J(D('07:42'))];
  const r = await buildTour(tour, direct, ctx({ shortcutFor: sf }));
  const rep = r.incidents.find((i) => i.kind === 'replacement');
  assert.equal(rep.delayMin, 25);
  assert.deepEqual(rep.view.shortcut, { title: 'Schneller mit 1 Umstieg', line1: 'RE 22 › U3 ab 07:10', line2: 'Umstieg Moosach · 6 Min.', line3: 'An 07:56 statt 08:13', badge: '−17 Min.', saved: 17, via: 'Moosach' });
  assert.equal(rep.view.rows.find((x) => /^Ankunft/.test(x.label)).value, '08:13');               // same arrival time as in the row of the incident
  // without the function (nothing loaded) the incident stays as before
  const plain = await buildTour(tour, direct, ctx());
  assert.ok(!('shortcut' in plain.incidents.find((i) => i.kind === 'replacement').view));
  // A delay gets no card, even if there were a faster detour
  const slow = await buildTour(tour, [J(D('07:02', { noSev: true, late: 12 }))], ctx({ shortcutFor: sf }));
  assert.ok(slow.incidents.length && slow.incidents.every((i) => !('shortcut' in i.view)));
});

test('Replacement-transport incident: if the trip itself is even later than the replacement transport says, the later arrival counts', async () => {
  const sf = (o) => shortcutFor(DETOURS, { now: NOW, ...o });
  const r = await buildTour(tour, [J(D('07:02', { arrLate: 40 }))], ctx({ shortcutFor: sf }));     // planned 07:48, according to the source 08:28
  const rep = r.incidents.find((i) => i.kind === 'replacement');
  assert.equal(rep.view.shortcut.line3, 'An 07:56 statt 08:28'); assert.equal(rep.view.shortcut.badge, '−32 Min.');
});

test('Route without a direct connection ("Keine"): the sentence says that ReGo searches with 1 transfer when the route is created again, no longer points to a button or to "nur Fahrten ohne Umstieg"', async () => {
  const r = await buildTour(tour, [], ctx());
  assert.equal(r.tour.view.big, 'Keine'); assert.match(r.tour.view.sub, /^Keine Direktverbindung gefunden\./);
  assert.match(r.tour.view.sub, /sucht ReGo auch mit 1 Umstieg/); assert.doesNotMatch(r.tour.view.sub, /nur Fahrten ohne Umstieg|Mit 1 Umstieg suchen/);
});

// ---------- in the service ----------

test('Service: asks for connections with a transfer only on replacement transport, uses the cache and survives a failing query', async () => {
  const store = new ProfileStore(await tmp(), () => NOW); const dev = 'umwegtestgeraet123456';
  await store.update(dev, (p) => { addTours(p, { from: FS, to: MH }); });
  const mk = (opts = {}) => {
    const calls = [];
    const client = {
      journeys: async (o) => {
        calls.push(o.transfers || 0);
        if (o.transfers === 1) { if (opts.broken) throw new Error('down'); return [J(D('07:02', { noSev: opts.noSev })), J(A('07:10'), B('07:41')), J(A('07:30'), B('08:00'))]; }
        return [J(D('07:02', { noSev: opts.noSev })), J(D('07:22', { noSev: opts.noSev }))];
      },
      stop: async () => ({ lines: [], lat: 48.4, lon: 11.74 }),
    };
    const providers = { forTour: () => client, forStop: () => client, searchStops: async () => [] };
    return { calls, service: createService({ config: { ...config, tourDeadlineMs: 500 }, store, now: () => NOW, providers }) };
  };
  // with replacement transport: one query without, one with a transfer; the second time both come from the cache
  const a = mk();
  let s = await a.service.getState(dev);
  const rep = s.incidents.find((i) => i.kind === 'replacement');
  assert.equal(rep.view.shortcut.line1, 'RE 22 › U3 ab 07:10'); assert.equal(rep.view.shortcut.badge, '−17 Min.');
  assert.deepEqual(a.calls, [0, 1]);
  await a.service.getState(dev); assert.deepEqual(a.calls, [0, 1]);
  // without replacement transport nobody even asks for transfers
  const b = mk({ noSev: true });
  s = await b.service.getState(dev);
  assert.deepEqual(b.calls, [0]); assert.ok(s.incidents.every((i) => !('shortcut' in i.view)));
  // query with transfer disturbed: the incident still comes, just without the card
  const c = mk({ broken: true });
  s = await c.service.getState(dev);
  const rep2 = s.incidents.find((i) => i.kind === 'replacement');
  assert.ok(rep2); assert.ok(!('shortcut' in rep2.view)); assert.equal(s.tours[0].departures.length, 2);
});

test('Service: a route with a transfer gets no additional query for the hint', async () => {
  const store = new ProfileStore(await tmp(), () => NOW); const dev = 'umwegtestgeraet654321';
  await store.update(dev, (p) => { addTours(p, { from: FS, to: MH, transfers: 1 }); });
  const calls = [];
  const client = {
    journeys: async (o) => {
      calls.push(o.transfers || 0);
      if (o.transfers === 1) return [J(A('07:10'), B('07:41', { remarks: [SEV] })), J(A('07:30'), B('08:00'))];
      return [J(B('07:41', { remarks: [SEV] })), J(B('08:00'))];                          // Anschlussfahrten ab Moosach
    },
    stop: async () => ({ lines: [], lat: 48.4, lon: 11.74 }),
  };
  const providers = { forTour: () => client, forStop: () => client, searchStops: async () => [] };
  const service = createService({ config: { ...config, tourDeadlineMs: 500 }, store, now: () => NOW, providers });
  const s = await service.getState(dev);
  assert.equal(s.tours[0].transfers, 1);
  assert.equal(calls.filter((n) => n === 1).length, 1, `eine Suche mit Umstieg erwartet, Abfragen: ${calls}`);
  assert.ok(s.incidents.every((i) => !('shortcut' in i.view)));
});
