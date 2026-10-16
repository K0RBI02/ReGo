// Neu in 0.7.1: „Schneller mit 1 Umstieg“. Hat eine Strecke ohne Umstieg Ersatzverkehr, zeigt die Meldung eine Verbindung mit einem Umstieg,
// die früher am Ziel ist – nur wenn sie sicher und mindestens 5 Minuten schneller ist.
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

// Ersatzverkehr zwischen Neufahrn und Moosach: die S1 braucht 25 Minuten länger
const SEV = { type: 'status', code: 'construction', summary: 'Schienenersatzverkehr', text: 'Wegen Bauarbeiten zwischen Neufahrn und Moosach Schienenersatzverkehr mit Bussen. Reisezeit verlängert sich um ca. 25 Minuten.', validFrom: at('05:00'), validUntil: '2026-10-17T00:00:00+02:00' };
// Fahrt ohne Umstieg: S1 Freising → München Hbf, 46 Min., mit Ersatzverkehr (außer noSev)
const D = (dep, o = {}) => {
  const d = o.late || 0, arrLate = o.arrLate ?? d;
  return { line: { name: 'S1', product: 'suburban' }, direction: 'Ostbahnhof', origin: FS, destination: MH,
    plannedDep: at(dep), dep: at(add(dep, d)), depDelay: d, plannedArr: at(add(dep, 46)), arr: at(add(dep, 46 + arrLate)), arrDelay: arrLate,
    plannedPlatform: '3', platform: '3', stopovers: [FS, { id: 'a', name: 'Neufahrn' }, { id: 'b', name: 'Feldmoching' }, MO, MH],
    remarks: o.noSev ? [] : [SEV], cancelled: false };
};
// Umweg: RE 22 Freising → Moosach (25 Min.), dann U3 Moosach → München Hbf (15 Min.)
const A = (dep, o = {}) => ({ line: { name: 'RE 22', product: 'regionalExpress' }, direction: 'Moosach', origin: FS, destination: MO,
  plannedDep: at(dep), dep: at(dep), depDelay: 0, plannedArr: at(add(dep, 25)), arr: at(add(dep, 25)), arrDelay: 0, plannedPlatform: '1', platform: '1',
  stopovers: [FS, MO], remarks: o.remarks || [], cancelled: !!o.cancelled });
const B = (dep, o = {}) => ({ line: { name: 'U3', product: 'subway' }, direction: 'Fürstenried West', origin: MO, destination: MH,
  plannedDep: at(dep), dep: at(dep), depDelay: 0, plannedArr: at(add(dep, 15)), arr: at(add(dep, 15)), arrDelay: 0, plannedPlatform: '1', platform: '1',
  stopovers: [MO, MH], remarks: o.remarks || [], cancelled: !!o.cancelled });
const J = (...legs) => ({ legs });
// Fahrt mit Ersatzverkehr: ab 07:02, geplant an 07:48, mit 25 Min. mehr an 08:13
const O = { now: NOW, depart: Date.parse(at('07:02')), arrive: Date.parse(at('08:13')) };

test('Schneller mit 1 Umstieg: nimmt die früheste sichere Verbindung und nennt Linien, Umstieg, Ankunft und Ersparnis', () => {
  const card = shortcutFor([J(A('07:30'), B('08:00')), J(A('07:10'), B('07:41'))], O);
  assert.deepEqual(card, { title: 'Schneller mit 1 Umstieg', line1: 'RE 22 › U3 ab 07:10', line2: 'Umstieg Moosach · 6 Min.', line3: 'An 07:56 statt 08:13', badge: '−17 Min.', saved: 17, via: 'Moosach' });
});

test('Schneller mit 1 Umstieg: bei gleicher Ankunft gewinnt die frühere Abfahrt, sonst die frühere Ankunft', () => {
  assert.equal(shortcutFor([J(A('07:12'), B('07:41')), J(A('07:10'), B('07:41'))], O).line1, 'RE 22 › U3 ab 07:10');
  assert.equal(shortcutFor([J(A('07:10'), B('07:50')), J(A('07:13'), B('07:41'))], O).line1, 'RE 22 › U3 ab 07:13');     // 07:13 kommt um 07:56 an, 07:10 erst um 08:05
});

test('Schneller mit 1 Umstieg: erst ab 5 Minuten Gewinn', () => {
  assert.equal(SHORTCUT_MIN_SAVING, 5);
  assert.equal(shortcutFor([J(A('07:10'), B('07:54'))], O), null);                  // an 08:09 = 4 Min. früher: nicht genug
  const c = shortcutFor([J(A('07:10'), B('07:53'))], O);                            // an 08:08 = 5 Min. früher
  assert.equal(c.saved, 5); assert.equal(c.badge, '−5 Min.');
  assert.equal(shortcutFor([J(A('07:10'), B('08:10'))], O), null);                  // später als die Fahrt mit Ersatzverkehr
});

test('Schneller mit 1 Umstieg: nichts Unsicheres – Ausfall, Ersatzverkehr auf dem Umweg, knapper Anschluss, schon weg, viel später', () => {
  const ok = [J(A('07:10'), B('07:41'))];
  assert.ok(shortcutFor(ok, O));
  assert.equal(shortcutFor([J(A('07:10', { cancelled: true }), B('07:41'))], O), null);            // Zubringer fällt aus
  assert.equal(shortcutFor([J(A('07:10'), B('07:41', { cancelled: true }))], O), null);            // Anschluss fällt aus
  assert.equal(shortcutFor([J(A('07:10', { remarks: [SEV] }), B('07:41'))], O), null);             // Ersatzverkehr auf dem Zubringer
  assert.equal(shortcutFor([J(A('07:10'), B('07:41', { remarks: [SEV] }))], O), null);             // … oder auf dem Anschluss
  assert.ok(shortcutFor([J(A('07:10', { remarks: [{ ...SEV, validUntil: at('06:30') }]}), B('07:41'))], O));   // abgelaufener Hinweis zählt nicht
  assert.equal(shortcutFor([J(A('07:10'), B('07:37'))], O), null);                                 // nur 2 Min. zum Umsteigen (an 07:35, ab 07:37)
  assert.ok(shortcutFor([J(A('07:10'), B('07:38'))], O));                                          // 3 Min. reichen
  assert.equal(shortcutFor([J(A('06:50'), B('07:21'))], O), null);                                 // schon abgefahren (jetzt 07:00)
  const late = { ...O, arrive: Date.parse(at('09:00')) };                                          // viel später am Ziel: dann zählt nur noch, wie spät der Umweg losfährt
  assert.ok(shortcutFor([J(A('07:30'), B('08:00'))], late));                                       // 28 Min. nach der Fahrt mit Ersatzverkehr: ok
  assert.equal(shortcutFor([J(A('07:40'), B('08:10'))], late), null);                              // 38 Min. danach: zu spät
});

test('Schneller mit 1 Umstieg: Direktfahrten, leere Listen und unbrauchbare Angaben ergeben keinen Hinweis', () => {
  assert.equal(shortcutFor([J(D('07:02', { noSev: true }))], O), null);                            // nur eine Fahrt ohne Umstieg
  assert.equal(shortcutFor([J(A('07:10'), B('07:41'), D('07:50'))], O), null);                     // mehr als ein Umstieg ist nicht gemeint
  assert.equal(shortcutFor([], O), null); assert.equal(shortcutFor(undefined, O), null);
  assert.equal(shortcutFor([J(A('07:10'), B('07:41'))], { ...O, arrive: NaN }), null);
  assert.equal(shortcutFor([J(A('07:10'), B('07:41'))], { ...O, depart: undefined }), null);
});

// ---------- in der Meldung ----------

const tour = { id: 'tk1', name: 'Freising → München Hbf', from: FS, to: MH, active: true };
const ctx = (o = {}) => ({ now: NOW, minDelay: 3, linesAt: async () => [], lines: {}, ...o });
const UMWEGE = [J(D('07:02')), J(A('07:10'), B('07:41')), J(A('07:30'), B('08:00'))];

test('Meldung zu Ersatzverkehr trägt die Karte; Verspätung, Baustelle und fehlende Funktion nicht', async () => {
  const sf = (o) => shortcutFor(UMWEGE, { now: NOW, ...o });
  const direct = [J(D('07:02')), J(D('07:22')), J(D('07:42'))];
  const r = await buildTour(tour, direct, ctx({ shortcutFor: sf }));
  const rep = r.incidents.find((i) => i.kind === 'replacement');
  assert.equal(rep.delayMin, 25);
  assert.deepEqual(rep.view.shortcut, { title: 'Schneller mit 1 Umstieg', line1: 'RE 22 › U3 ab 07:10', line2: 'Umstieg Moosach · 6 Min.', line3: 'An 07:56 statt 08:13', badge: '−17 Min.', saved: 17, via: 'Moosach' });
  assert.equal(rep.view.rows.find((x) => /^Ankunft/.test(x.label)).value, '08:13');               // dieselbe Ankunftszeit wie in der Zeile der Meldung
  // ohne Funktion (nichts geladen) bleibt die Meldung wie bisher
  const plain = await buildTour(tour, direct, ctx());
  assert.ok(!('shortcut' in plain.incidents.find((i) => i.kind === 'replacement').view));
  // Verspätung bekommt keine Karte, auch wenn es einen schnelleren Umweg gäbe
  const slow = await buildTour(tour, [J(D('07:02', { noSev: true, late: 12 }))], ctx({ shortcutFor: sf }));
  assert.ok(slow.incidents.length && slow.incidents.every((i) => !('shortcut' in i.view)));
});

test('Meldung zu Ersatzverkehr: ist die Fahrt selbst noch später dran als der Ersatzverkehr sagt, zählt die spätere Ankunft', async () => {
  const sf = (o) => shortcutFor(UMWEGE, { now: NOW, ...o });
  const r = await buildTour(tour, [J(D('07:02', { arrLate: 40 }))], ctx({ shortcutFor: sf }));     // geplant 07:48, laut Quelle 08:28
  const rep = r.incidents.find((i) => i.kind === 'replacement');
  assert.equal(rep.view.shortcut.line3, 'An 07:56 statt 08:28'); assert.equal(rep.view.shortcut.badge, '−32 Min.');
});

test('Strecke ohne Direktverbindung („Keine“): der Satz verweist auf „Mit 1 Umstieg suchen“, nicht mehr auf „nur Fahrten ohne Umstieg“', async () => {
  const r = await buildTour(tour, [], ctx());
  assert.equal(r.tour.view.big, 'Keine'); assert.match(r.tour.view.sub, /^Keine Direktverbindung gefunden\./);
  assert.match(r.tour.view.sub, /Mit 1 Umstieg suchen/); assert.doesNotMatch(r.tour.view.sub, /nur Fahrten ohne Umstieg/);
});

// ---------- im Dienst ----------

test('Dienst: fragt Verbindungen mit Umstieg nur bei Ersatzverkehr, nutzt den Zwischenspeicher und übersteht eine Störung der Abfrage', async () => {
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
  // mit Ersatzverkehr: eine Abfrage ohne, eine mit Umstieg; beim zweiten Mal kommt beides aus dem Zwischenspeicher
  const a = mk();
  let s = await a.service.getState(dev);
  const rep = s.incidents.find((i) => i.kind === 'replacement');
  assert.equal(rep.view.shortcut.line1, 'RE 22 › U3 ab 07:10'); assert.equal(rep.view.shortcut.badge, '−17 Min.');
  assert.deepEqual(a.calls, [0, 1]);
  await a.service.getState(dev); assert.deepEqual(a.calls, [0, 1]);
  // ohne Ersatzverkehr wird gar nicht erst nach Umstiegen gefragt
  const b = mk({ noSev: true });
  s = await b.service.getState(dev);
  assert.deepEqual(b.calls, [0]); assert.ok(s.incidents.every((i) => !('shortcut' in i.view)));
  // Abfrage mit Umstieg gestört: die Meldung kommt trotzdem, nur ohne Karte
  const c = mk({ broken: true });
  s = await c.service.getState(dev);
  const rep2 = s.incidents.find((i) => i.kind === 'replacement');
  assert.ok(rep2); assert.ok(!('shortcut' in rep2.view)); assert.equal(s.tours[0].departures.length, 2);
});

test('Dienst: Strecke mit Umstieg bekommt keine zusätzliche Abfrage für den Hinweis', async () => {
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
