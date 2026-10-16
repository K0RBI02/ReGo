// Neu in 0.7.0: Fahrten mit einem Umstieg („Mit 1 Umstieg suchen“): Anschluss pünktlich / wackelt / verpasst, Ersatzverkehr,
// ausfallender Anschluss, Suche und Anlegen über die Schnittstelle, Push-Texte.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildTransferTour, previewRoute, transferVias } from '../server/domain/transfer.mjs';
import { addTours, replaceProfile, ValidationError } from '../server/store/profile.mjs';
import { relevant, textFor, changeOf } from '../server/notifier.mjs';
import { createApp } from '../server/index.mjs';
import { config } from '../server/config.mjs';

const tmp = (n = 'rego-x-') => mkdtemp(join(tmpdir(), n));
const FS = { id: '8002078', name: 'Freising' }, MH = { id: '8000261', name: 'München Hbf' }, SZ = { id: '8100002', name: 'Salzburg Hbf' };
const MO = { id: '8000902', name: 'Moosach' }, PA = { id: '8000298', name: 'Passau Hbf' }, WI = { id: '8100108', name: 'Wien Hbf' };
const NOW = Date.parse('2026-10-14T07:00:00+02:00');
const at = (hhmm) => `2026-10-14T${hhmm}:00+02:00`;
const add = (hhmm, m) => { const [h, mi] = hhmm.split(':').map(Number); const x = h * 60 + mi + m; return `${String(Math.floor(x / 60)).padStart(2, '0')}:${String(x % 60).padStart(2, '0')}`; };

// Zubringer: S1 Freising → München Hbf (35 Min.); Anschluss: RE 5 München Hbf → Salzburg Hbf (95 Min.)
const S1 = (dep, o = {}) => {
  const d = o.late || 0, arrLate = o.arrLate ?? d;
  return { line: { name: 'S1', product: 'suburban' }, direction: 'Ostbahnhof', origin: FS, destination: MH,
    plannedDep: at(dep), dep: at(add(dep, d)), depDelay: d, plannedArr: at(add(dep, 35)), arr: at(add(dep, 35 + arrLate)), arrDelay: arrLate,
    plannedPlatform: '3', platform: o.platform ?? '3', plannedArrPlatform: '2', arrPlatform: '2',
    stopovers: [FS, { id: 'a', name: 'Neufahrn' }, { id: 'b', name: 'Feldmoching' }, MO, MH], remarks: o.remarks || [], cancelled: !!o.cancelled };
};
const RE = (dep, o = {}) => {
  const d = o.late || 0;
  return { line: { name: 'RE 5', product: 'regionalExpress' }, direction: 'Salzburg Hbf', origin: MH, destination: SZ,
    plannedDep: at(dep), dep: at(add(dep, d)), depDelay: d, plannedArr: at(add(dep, 95)), arr: at(add(dep, 95 + d)), arrDelay: d,
    plannedPlatform: '14', platform: '14', stopovers: [MH, { id: 'c', name: 'Rosenheim' }, { id: 'd', name: 'Prien' }, { id: 'e', name: 'Traunstein' }, SZ],
    remarks: o.remarks || [], cancelled: !!o.cancelled };
};
const tour = { id: 'tu1', name: 'Freising → Salzburg Hbf', from: FS, to: SZ, active: true, transfers: 1 };
const ctx = (o = {}) => ({ now: NOW, minDelay: 3, linesAt: async () => [], lines: {}, ...o });
const J = (a, b) => ({ legs: b ? [a, b] : [a] });
const bl = (...bs) => new Map([['münchen hbf', bs]]);
const ANSCHLUESSE = bl(RE('07:16'), RE('07:46'), RE('08:16'), RE('08:46'));
const FAHRTEN = (a1 = {}) => [J(S1('07:02', a1), RE('07:46')), J(S1('07:22'), RE('08:16')), J(S1('07:42'), RE('08:46'))];
// Die kombinierte Suche des Anbieters schlägt bei einem verspäteten Zubringer schon den späteren Anschluss vor (RE 08:16)
const FAHRTEN_SPAET = (a1) => [J(S1('07:02', a1), RE('08:16')), J(S1('07:22'), RE('08:16')), J(S1('07:42'), RE('08:46'))];

// ---------- Zustände ----------

test('Umstieg pünktlich: zwei Linien, Umstiegszeile, Abschnitte (Fahrt – Umstieg – Fahrt) und Karte', async () => {
  const r = await buildTransferTour(tour, FAHRTEN(), ctx({ bLists: ANSCHLUESSE }));
  assert.equal(r.tour.transfers, 1); assert.equal(r.tour.via, 'München Hbf'); assert.deepEqual(r.tour.lineIds, ['S1', 'RE5']);
  assert.deepEqual(r.incidents, []);
  assert.deepEqual(r.tour.departures.map((d) => d.expectedTime), ['07:02', '07:22', '07:42']);
  assert.deepEqual(r.tour.departures.map((d) => d.transfer.minutes), [9, 19, 29]);
  const d = r.tour.departures[0];
  assert.deepEqual(d.lineIds, ['S1', 'RE5']); assert.equal(d.arrTime, '09:21');
  assert.deepEqual(d.transfer, { station: 'München Hbf', minutes: 9, state: 'ok', text: 'Umstieg München Hbf · 9 Min.' });
  assert.equal(r.tour.view.kind, 'ok');                                  // ohne Meldung zeigt die Strecke die erste Abfahrt
  const v = d.view;
  assert.equal(v.kind, 'ok'); assert.equal(v.big, 'pünktlich'); assert.equal(v.sub, 'Ankunft Salzburg Hbf 09:21 · 1 Umstieg');
  assert.deepEqual(v.sections.map((s) => s.type), ['leg', 'transfer', 'leg']);
  assert.deepEqual(v.sections[1], { type: 'transfer', state: 'ok', label: 'Umstieg', title: 'München Hbf', text: 'Gleis 2 → Gleis 14', minutes: 9 });
  assert.equal(v.sections[0].title, 'Freising → München Hbf'); assert.equal(v.sections[0].sub, '1. Fahrt · 35 Min.');
  assert.equal(v.sections[2].title, 'München Hbf → Salzburg Hbf'); assert.equal(v.sections[2].sub, '2. Fahrt · 1 Std. 35 Min.');
  assert.deepEqual(v.rows.map((x) => x.label), ['Abfahrt Freising', 'Ankunft München Hbf', 'Abfahrt München Hbf', 'Ankunft Salzburg Hbf']);   // flache Liste für ältere Oberflächen
  assert.equal(v.alternative.title, 'Danach'); assert.match(v.alternative.line1, /S1 › RE 5 ab 07:22/);
  const m = v.map;
  assert.deepEqual(m.stations.map((s) => s.name), ['Freising', 'Neufahrn', 'Feldmoching', 'München Hbf', 'Rosenheim', 'Prien', 'Salzburg Hbf']);
  assert.equal(m.hubIndex, 3); assert.deepEqual(m.legs, [{ lineId: 'S1', from: 0, to: 3 }, { lineId: 'RE5', from: 3, to: 6 }]);
  assert.deepEqual(m.transfer, { stationIndex: 3, label: 'Umstieg 9 Min. · Gleis 14', state: 'ok' });
  assert.deepEqual(m.times, { dep: 'ab 07:02', arr: 'an 09:21', depLate: false, arrLate: false });
  assert.equal(m.haloIndex, -1); assert.equal(m.disrupted, null);
  assert.ok(r.tour.lineId && r.tour.lines === undefined);
});

test('Knapp geplant, aber pünktlich: kein Alarm (wackelt gibt es nur bei verspätetem Zubringer)', async () => {
  const r = await buildTransferTour(tour, [J(S1('07:02'), RE('07:39')), J(S1('07:22'), RE('08:16'))], ctx({ bLists: bl(RE('07:39'), RE('08:16')) }));
  assert.equal(r.tour.departures[0].transfer.state, 'ok'); assert.equal(r.tour.departures[0].transfer.minutes, 2);
  assert.deepEqual(r.incidents, []);
});

test('Anschluss wackelt: Zubringer verspätet, nur noch 1 Minute Puffer – Meldung, Folgeverbindung, stabile Kennung', async () => {
  const r = await buildTransferTour(tour, FAHRTEN_SPAET({ late: 8 }), ctx({ bLists: ANSCHLUESSE }));
  const d = r.tour.departures[0];
  assert.equal(d.expectedTime, '07:10'); assert.equal(d.delayMin, 8);
  assert.deepEqual(d.transfer, { station: 'München Hbf', minutes: 1, state: 'tight', text: 'Umstieg nur noch 1 Min.' });
  assert.equal(d.arrTime, '09:21');                                         // der geplante Anschluss gilt noch
  assert.equal(d.view.kind, 'tight'); assert.equal(d.view.big, '+8 Min.'); assert.equal(d.view.sub, 'Anschluss in München Hbf wackelt');
  assert.deepEqual(d.view.sections[1], { type: 'transfer', state: 'tight', label: 'Anschluss wackelt', title: 'Umstieg München Hbf', text: 'S1 an 07:45 · RE 5 ab 07:46', minutes: 1 });
  assert.equal(d.view.alternative.title, 'Nächster Anschluss'); assert.equal(d.view.alternative.line1, 'RE 5 ab 08:16 · Gleis 14'); assert.equal(d.view.alternative.line2, 'An Salzburg Hbf 09:51');
  assert.equal(d.view.map.haloIndex, 3); assert.equal(d.view.map.transfer.label, 'Umstieg nur noch 1 Min.'); assert.equal(d.view.map.transfer.state, 'tight');
  assert.deepEqual([d.view.map.times.depLate, d.view.map.times.arrLate], [true, false]);
  assert.deepEqual(d.view.sections[0].rows[0], { label: 'Abfahrt Freising', sub: 'S1 Richtung Ostbahnhof · Gleis 3', value: '07:10', planned: '07:02' });
  // Meldung: genau eine, auf den Anschluss bezogen
  assert.equal(r.incidents.length, 1);
  const i = r.incidents[0];
  assert.equal(i.kind, 'tight'); assert.equal(i.severity, 2); assert.equal(i.lineName, 'RE 5'); assert.equal(i.delayMin, 8);
  assert.equal(i.title, 'RE 5 München Hbf → Salzburg Hbf'); assert.equal(i.summary, 'Umstieg nur noch 1 Min. (S1 an 07:45, RE 5 ab 07:46)');
  assert.equal(i.validity.until, '2026-10-14T07:46'); assert.equal(i.view, d.view);
  assert.equal(r.tour.view, undefined);                                    // die Meldung steht für die Strecke
  // dieselbe Lage eine Minute später: dieselbe Meldung (kein zweiter Push); wird es ein verpasster Anschluss: neue Meldung
  const later = await buildTransferTour(tour, FAHRTEN_SPAET({ late: 8 }), ctx({ now: NOW + 60e3, bLists: ANSCHLUESSE }));
  assert.equal(later.incidents[0].id, i.id);
  const worse = await buildTransferTour(tour, FAHRTEN_SPAET({ late: 12 }), ctx({ bLists: ANSCHLUESSE }));
  assert.equal(worse.incidents[0].kind, 'missed'); assert.notEqual(worse.incidents[0].id, i.id);
});

test('Anschluss verpasst: der nächste Anschluss wird gezeigt, Meldung mit höchster Dringlichkeit', async () => {
  const r = await buildTransferTour(tour, FAHRTEN_SPAET({ late: 12 }), ctx({ bLists: ANSCHLUESSE }));
  const d = r.tour.departures[0];
  assert.equal(d.expectedTime, '07:14');
  assert.deepEqual(d.transfer, { station: 'München Hbf', minutes: 27, state: 'missed', text: 'Anschluss verpasst' });   // 27 Min. bis zum nächsten RE
  assert.equal(d.arrTime, '09:51');
  const v = d.view;
  assert.equal(v.kind, 'missed'); assert.equal(v.big, 'Verpasst'); assert.equal(v.head, 'Anschluss · RE 5 ab 07:46'); assert.equal(v.sub, 'Nächster RE 5 ab 08:16, Ankunft 09:51');
  assert.deepEqual(v.sections[1], { type: 'transfer', state: 'missed', label: 'Anschluss verpasst', title: 'Umstieg München Hbf', text: 'S1 an 07:49 · RE 5 07:46 weg', minutes: 27 });
  const b = v.sections[2].rows;                                              // der gezeigte Anschluss, mit dem geplanten zum Vergleich
  assert.deepEqual(b.map((x) => [x.label, x.value, x.planned, x.plannedLabel]), [['Abfahrt München Hbf', '08:16', '07:46', 'statt'], ['Ankunft Salzburg Hbf', '09:51', '09:21', 'statt']]);
  assert.equal(v.map.transfer.label, 'Anschluss verpasst'); assert.equal(v.map.haloIndex, 3);
  assert.deepEqual([v.map.times.depLate, v.map.times.arrLate], [true, true]); assert.equal(v.map.times.arr, 'an 09:51');
  const i = r.incidents[0];
  assert.equal(i.kind, 'missed'); assert.equal(i.severity, 3); assert.equal(i.lineName, 'RE 5');
  assert.equal(i.summary, 'S1 an 07:49, RE 5 07:46 weg. Nächster RE 5 ab 08:16'); assert.equal(i.validity.until, '2026-10-14T08:16');
});

test('Anschlussfahrt fällt aus: „Anschluss fällt aus“, auch wenn der Zubringer pünktlich ist', async () => {
  const fahrten = [J(S1('07:02'), RE('07:46', { cancelled: true })), J(S1('07:22'), RE('08:16')), J(S1('07:42'), RE('08:46'))];
  const r = await buildTransferTour(tour, fahrten, ctx({ bLists: bl(RE('07:16'), RE('07:46', { cancelled: true }), RE('08:16'), RE('08:46')) }));
  const d = r.tour.departures[0];
  assert.deepEqual(d.transfer, { station: 'München Hbf', minutes: 39, state: 'missed', text: 'Anschluss fällt aus' });
  assert.equal(d.view.kind, 'missed'); assert.equal(d.view.big, 'Fällt aus'); assert.equal(d.view.sub, 'Nächster RE 5 ab 08:16, Ankunft 09:51');
  assert.equal(d.view.alternative.title, 'Danach · gleiche Ankunft');
  assert.equal(r.incidents[0].summary, 'RE 5 ab 07:46 fällt aus. Nächster RE 5 ab 08:16');
  assert.equal(d.view.map.transfer.label, 'Anschluss fällt aus');
});

test('Ersatzverkehr auf dem Zubringer: der Anschluss bleibt erreichbar, die Meldung sagt es dazu', async () => {
  const bus = { type: 'status', code: 'x', summary: 'Ersatzbusse ab Moosach', text: 'Wegen Bauarbeiten zwischen Moosach und München Hbf Schienenersatzverkehr mit Bussen. Reisezeit verlängert sich um ca. 4 Minuten.', validFrom: at('00:00'), validUntil: '2026-10-14T23:00:00+02:00' };
  const r = await buildTransferTour(tour, FAHRTEN({ arrLate: 0, remarks: [bus] }), ctx({ bLists: ANSCHLUESSE }));
  const d = r.tour.departures[0];
  assert.equal(d.transfer.state, 'ok'); assert.equal(d.transfer.minutes, 5);                  // Bus an 07:41, RE 07:46
  assert.deepEqual(d.view.sections[1], { type: 'transfer', state: 'ok', label: 'Umstieg', title: 'München Hbf', text: 'Bus an 07:41 · RE 5 ab 07:46', minutes: 5 });
  assert.equal(r.incidents.length, 1);
  const i = r.incidents[0];
  assert.equal(i.kind, 'replacement'); assert.equal(i.lineName, 'S1'); assert.equal(i.delayMin, 4);
  assert.equal(i.view.sub, 'S1 Moosach → München Hbf · Anschluss bleibt erreichbar');
  assert.ok(i.view.map.disrupted && i.view.map.disrupted.to === i.view.map.hubIndex);        // der gestörte Abschnitt endet am Umstiegsbahnhof
  // reicht die Mehrzeit nicht mehr: Anschluss wackelt/verpasst (Bus 25 Min. später)
  const lang = { ...bus, text: bus.text.replace('ca. 4 Minuten', 'ca. 25 Minuten') };
  const r2 = await buildTransferTour(tour, FAHRTEN_SPAET({ arrLate: 0, remarks: [lang] }), ctx({ bLists: ANSCHLUESSE }));
  assert.equal(r2.tour.departures[0].transfer.state, 'missed');
  assert.ok(r2.incidents.some((x) => x.kind === 'replacement' && /Anschluss verpasst$/.test(x.view.sub)));
});

test('Ohne Anschlussliste vertraut ReGo dem Anbieter (kein Raten): verspäteter Zubringer, vorgeschlagener Anschluss bleibt erreichbar', async () => {
  const r = await buildTransferTour(tour, [J(S1('07:02', { late: 12 }), RE('08:16')), J(S1('07:22'), RE('08:16'))], ctx());
  const d = r.tour.departures[0];
  assert.equal(d.transfer.state, 'ok'); assert.equal(d.view.kind, 'delay'); assert.equal(d.view.sub, 'Anschluss in München Hbf bleibt erreichbar');
  assert.equal(r.incidents.length, 1); assert.equal(r.incidents[0].kind, 'delay');
});

test('Lange Wartezeit am Umstieg (über 30 Min. geplant): nur, wenn es sonst nichts gibt', async () => {
  const lang = J(S1('07:02'), RE('08:16')), kurz = J(S1('07:22'), RE('08:16'));          // 39 bzw. 19 Min. Wartezeit
  const a = await buildTransferTour(tour, [lang, kurz], ctx());
  assert.deepEqual(a.tour.departures.map((d) => d.expectedTime), ['07:22']);
  const b = await buildTransferTour(tour, [lang], ctx());
  assert.deepEqual(b.tour.departures.map((d) => [d.expectedTime, d.transfer.minutes]), [['07:02', 39]]);
});

test('Der Zubringer fällt aus: Ausfallmeldung wie bei einer Direktstrecke, die Fahrt erscheint nicht in der Liste', async () => {
  const r = await buildTransferTour(tour, [J(S1('07:10', { cancelled: true }), RE('08:16')), J(S1('07:22'), RE('08:16')), J(S1('07:42'), RE('08:46'))], ctx({ bLists: ANSCHLUESSE }));
  assert.deepEqual(r.tour.departures.map((d) => d.expectedTime), ['07:22', '07:42']);
  const c = r.incidents.find((x) => x.kind === 'cancelled');
  assert.ok(c); assert.equal(c.lineName, 'S1'); assert.equal(c.summary, 'Fahrt um 07:10 fällt aus');
});

test('Nur Direktfahrten (der Anbieter schlägt keinen Umstieg mehr vor): gewohnte Regeln mit allen Meldungen', async () => {
  const direkt = { id: 'td', name: 'Freising → München Hbf', from: FS, to: MH, active: true, transfers: 1 };
  const r = await buildTransferTour(direkt, [J(S1('07:02', { late: 8 })), J(S1('07:22'))], ctx());
  assert.equal(r.tour.transfers, undefined); assert.equal(r.tour.departures[0].transfer, undefined);
  assert.equal(r.tour.departures[0].view.kind, 'delay');
  assert.ok(r.incidents.some((x) => x.kind === 'delay'));
  // ohne jede Verbindung: ehrliche Erklärung, kein Absturz
  const leer = await buildTransferTour(tour, [], ctx());
  assert.equal(leer.tour.view.kind, 'none'); assert.match(leer.tour.view.sub, /Umstieg/); assert.deepEqual(leer.tour.departures, []);
});

test('Gleiswechsel am Umstieg: die Anschlussfahrt bekommt eine eigene, leise Meldung', async () => {
  const b = RE('07:46'); b.platform = '9';
  const r = await buildTransferTour(tour, [J(S1('07:02'), b), J(S1('07:22'), RE('08:16'))], ctx({ bLists: bl(b, RE('08:16')) }));
  const p = r.incidents.find((x) => x.kind === 'platform');
  assert.ok(p); assert.equal(p.lineName, 'RE 5'); assert.equal(p.platform, '9'); assert.equal(p.summary, '07:46 in München Hbf jetzt Gleis 9 statt Gleis 14');
  assert.equal(r.tour.departures[0].view.sections[1].text, 'Gleis 2 → Gleis 9');
});

test('Vorschau beim Anlegen und Umstiegsbahnhöfe', () => {
  const js = [J(S1('07:02'), RE('08:16')), J(S1('07:22'), RE('08:16')), J(S1('07:42'), RE('08:46'))];
  const p = previewRoute(js);                                                // die erste mit vertretbarer Wartezeit (07:02 wartet 39 Min.)
  assert.equal(p.via, 'München Hbf'); assert.equal(p.wait, 19); assert.equal(p.duration, '2 Std. 29 Min.');
  assert.deepEqual(p.legs.map((l) => [l.line, l.lineId, l.title, l.times]), [['S1', 'S1', 'Freising → München Hbf', 'ab 07:22 · an 07:57'], ['RE 5', 'RE5', 'München Hbf → Salzburg Hbf', 'ab 08:16 · an 09:51']]);
  assert.ok(/^#[0-9a-f]{6}$/i.test(p.legs[0].color));
  assert.equal(previewRoute([]), null);
  assert.equal(previewRoute([J(S1('07:02', { cancelled: true }), RE('07:46'))]), null);
  const direkt = previewRoute([J(S1('07:02'))]);
  assert.equal(direkt.legs.length, 1); assert.equal(direkt.via, undefined);
  const v = transferVias(js);
  assert.equal(v.length, 1); assert.equal(v[0].name, 'München Hbf'); assert.equal(v[0].count, 3); assert.equal(v[0].stop.id, MH.id);
});

// ---------- Strecken speichern ----------

test('Strecken: transfers 1 gilt für Hin- und Rückweg, bleibt beim Ersetzen erhalten, andere Werte sind ein Fehler', () => {
  const p = { tours: [], settings: {} };
  const [hin, rueck] = addTours(p, { from: FS, to: SZ, roundTrip: true, transfers: 1 });
  assert.equal(hin.transfers, 1); assert.equal(rueck.transfers, 1); assert.equal(rueck.returnOf, hin.id);
  const [direkt] = addTours(p, { from: MH, to: FS });
  assert.equal(direkt.transfers, undefined);
  assert.throws(() => addTours(p, { from: FS, to: MH, transfers: 2 }), (e) => e instanceof ValidationError && e.status === 400 && /transfers/.test(e.message));
  assert.throws(() => addTours(p, { from: FS, to: MH, transfers: 'ja' }), ValidationError);
  assert.equal(addTours({ tours: [], settings: {} }, { from: FS, to: MH, transfers: 0 })[0].transfers, undefined);
  const back = replaceProfile({ tours: [], settings: {} }, { tours: JSON.parse(JSON.stringify(p.tours)) });
  assert.deepEqual(back.tours.map((t) => t.transfers), [1, 1, undefined]);
});

test('Strecke ohne Direktverbindung aus älteren Versionen: mit Umstieg angelegt, wird sie umgestellt (kein Duplikat)', () => {
  const p = { tours: [], settings: {} };
  const [alt, altBack] = addTours(p, { from: FS, to: SZ, roundTrip: true });             // wie aus einer älteren Version
  assert.equal(alt.transfers, undefined);
  const again = addTours(p, { from: FS, to: SZ, roundTrip: true, transfers: 1 });
  assert.deepEqual(again.map((t) => t.id), [alt.id, altBack.id]);                         // dieselben Strecken, nicht doppelt
  assert.deepEqual(p.tours.map((t) => t.transfers), [1, 1]);
  addTours(p, { from: FS, to: SZ, roundTrip: true });                                     // noch einmal ohne Umstieg: bleibt, wie sie ist
  assert.deepEqual(p.tours.map((t) => t.transfers), [1, 1]); assert.equal(p.tours.length, 2);
});

// ---------- Schnittstelle (Beispieldaten) ----------

async function appOn(dir, cfg = {}, extra = {}) {
  const { server, store, service } = createApp({ cfg: { ...config, dataDir: dir, provider: 'mock', ...cfg }, ...extra });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { server, store, service, base: `http://127.0.0.1:${server.address().port}` };
}
const hdr = (dev) => ({ 'x-device': dev, 'content-type': 'application/json' });
const poster = (base, h) => async (p, b) => { const r = await fetch(`${base}${p}`, { method: 'POST', headers: h, body: JSON.stringify(b) }); return { status: r.status, body: await r.json() }; };

test('Suche mit 1 Umstieg: Vorschau, Direktverbindung, nichts gefunden, Quelle antwortet nicht', async () => {
  const { server, base, service } = await appOn(await tmp(), {}, { now: () => NOW });
  const post = poster(base, hdr('umstiegssuche123456'));
  try {
    let r = await post('/api/connections/search', { from: FS, to: SZ });
    assert.equal(r.status, 200); assert.equal(r.body.found, true); assert.equal(r.body.transfers, 1);
    assert.equal(r.body.route.via, 'München Hbf'); assert.equal(r.body.route.legs.length, 2); assert.equal(typeof r.body.route.wait, 'number');
    assert.deepEqual(r.body.route.legs.map((l) => l.line), ['S1', 'RE 5']);
    assert.deepEqual(r.body.route.legs.map((l) => l.title), ['Freising → München Hbf', 'München Hbf → Salzburg Hbf']);
    assert.match(r.body.route.legs[0].times, /^ab \d\d:\d\d · an \d\d:\d\d$/); assert.match(r.body.route.duration, /Std\./);
    r = await post('/api/connections/search', { from: MH, to: FS });                      // gibt es direkt: eine Fahrt, kein Umstieg
    assert.equal(r.body.found, true); assert.equal(r.body.route.legs.length, 1); assert.equal(r.body.route.via, undefined);
    r = await post('/api/connections/search', { from: PA, to: WI });                      // in den Beispieldaten gibt es dazwischen nichts
    assert.equal(r.status, 200); assert.equal(r.body.found, false); assert.equal(r.body.route, undefined);
    const orig = service.searchTransfer; service.searchTransfer = async () => ({ found: null });
    r = await post('/api/connections/search', { from: FS, to: SZ }); assert.equal(r.status, 200); assert.equal(r.body.found, null);   // „weiß ich gerade nicht“
    service.searchTransfer = orig;
    assert.equal((await post('/api/connections/search', { from: FS, to: FS })).status, 400);
    assert.equal((await post('/api/connections/search', {})).status, 400);
    assert.equal((await fetch(`${base}/api/connections/search`, { headers: hdr('umstiegssuche123456') })).status, 404);   // nur POST
  } finally { server.close(); }
});

test('Strecke mit Umstieg anlegen: erst ohne Direktverbindung (422 no-direct), dann mit transfers 1; ohne Verbindung 422 no-connection', async () => {
  const { server, base, service } = await appOn(await tmp(), {}, { now: () => NOW });
  const h = hdr('umstiegsanlegen1234'), post = poster(base, h);
  try {
    let r = await post('/api/tours', { from: FS, to: SZ });
    assert.equal(r.status, 422); assert.equal(r.body.code, 'no-direct'); assert.equal(r.body.error, 'Zwischen Freising und Salzburg Hbf habe ich keine Direktverbindung gefunden.');
    r = await post('/api/tours', { from: PA, to: WI, transfers: 1 });
    assert.equal(r.status, 422); assert.equal(r.body.code, 'no-connection'); assert.equal(r.body.error, 'Auch mit 1 Umstieg habe ich zwischen Passau Hbf und Wien Hbf nichts gefunden.');
    assert.equal((await post('/api/tours', { from: FS, to: SZ, transfers: 2 })).status, 400);
    assert.equal((await (await fetch(`${base}/api/profile`, { headers: h })).json()).tours.length, 0);       // nichts davon wurde gespeichert
    r = await post('/api/tours', { from: FS, to: SZ, roundTrip: true, transfers: 1 });
    assert.equal(r.status, 201); assert.deepEqual(r.body.tours.map((t) => t.transfers), [1, 1]);
    r = await post('/api/tours', { from: MH, to: FS }); assert.equal(r.status, 201); assert.equal(r.body.tours[0].transfers, undefined);
    const prof = (await (await fetch(`${base}/api/profile`, { headers: h })).json()).tours;
    assert.deepEqual(prof.map((t) => t.transfers), [1, 1, undefined]);
    // weiß die Quelle es nicht, wird im Zweifel angelegt (der Nutzer soll nicht ausgesperrt werden)
    service.searchTransfer = async () => ({ found: null });
    r = await post('/api/tours', { from: WI, to: PA, transfers: 1 }); assert.equal(r.status, 201);
  } finally { server.close(); }
});

test('Alte Strecke ohne Direktverbindung wird mit „Mit 1 Umstieg“ umgestellt statt doppelt angelegt; ohne Verbindung bleibt sie, wie sie ist', async () => {
  const dev = 'umstiegsumstellen1';
  const { server, store, base } = await appOn(await tmp(), {}, { now: () => NOW });
  const h = hdr(dev), post = poster(base, h);
  const tours = async () => (await (await fetch(`${base}/api/profile`, { headers: h })).json()).tours;
  try {
    await store.update(dev, (p) => { addTours(p, { from: FS, to: SZ }); addTours(p, { from: PA, to: WI }); });   // wie aus einer älteren Version: das Neuanlegen lehnt der Server inzwischen ab
    assert.deepEqual((await tours()).map((t) => t.transfers), [undefined, undefined]);
    let r = await post('/api/tours', { from: FS, to: SZ });                                                    // noch einmal ohne Umstieg: nicht stillschweigend „gespeichert“, der Hinweis kommt wieder
    assert.equal(r.status, 422); assert.equal(r.body.code, 'no-direct');
    r = await post('/api/tours', { from: FS, to: SZ, transfers: 1 });
    assert.equal(r.status, 201); assert.equal(r.body.tours.length, 1); assert.equal(r.body.tours[0].transfers, 1);
    assert.deepEqual((await tours()).map((t) => t.transfers), [1, undefined]);                                 // umgestellt, nicht doppelt
    r = await post('/api/tours', { from: PA, to: WI, transfers: 1 });                                          // auch mit Umstieg nichts: 422, die Strecke bleibt unverändert
    assert.equal(r.status, 422); assert.equal(r.body.code, 'no-connection');
    assert.deepEqual((await tours()).map((t) => t.transfers), [1, undefined]);
    r = await post('/api/tours', { from: FS, to: SZ, transfers: 1 });                                          // noch einmal mit Umstieg (Doppeltippen): nichts Neues
    assert.equal(r.status, 201); assert.equal((await tours()).length, 2);
  } finally { server.close(); }
});

test('Strecke mit Umstieg im Zustand (Beispieldaten, feste Uhr): zwei Linien, Umstieg je Abfahrt, Meldungen', async () => {
  const now = Date.parse('2026-10-14T06:50:00+02:00');
  const { server, base } = await appOn(await tmp(), {}, { now: () => now });
  const h = hdr('umstiegszustand1234'), post = poster(base, h);
  try {
    assert.equal((await post('/api/tours', { from: FS, to: SZ, roundTrip: true, transfers: 1 })).status, 201);
    const st = await (await fetch(`${base}/api/state`, { headers: h })).json();
    const hin = st.tours.find((t) => !t.returnOf), rueck = st.tours.find((t) => t.returnOf);
    assert.equal(hin.transfers, 1); assert.equal(hin.via, 'München Hbf'); assert.deepEqual(hin.lineIds, ['S1', 'RE5']);
    assert.ok(st.lines.S1 && st.lines.RE5);                                              // beide Linien sind im Verzeichnis (Farbe, Kurzname)
    assert.deepEqual(hin.departures.map((d) => d.expectedTime), ['07:08', '07:24', '07:40']);
    assert.deepEqual(hin.departures.map((d) => d.transfer.state), ['ok', 'ok', 'ok']);
    assert.equal(hin.departures[0].view.kind, 'delay'); assert.equal(hin.departures[0].view.sub, 'Anschluss in München Hbf bleibt erreichbar');
    assert.equal(hin.departures[2].view.kind, 'ok'); assert.equal(hin.departures[2].transfer.text, 'Umstieg München Hbf · 4 Min.');
    // Rückweg: der erste RE 5 hat Ersatzverkehr und Verspätung, der Anschluss ist weg
    assert.deepEqual(rueck.departures.map((d) => d.transfer.state), ['missed', 'missed', 'ok']);
    assert.equal(rueck.departures[0].view.kind, 'missed');
    const kinds = st.incidents.map((i) => i.kind);
    for (const k of ['missed', 'replacement', 'delay', 'platform']) assert.ok(kinds.includes(k), k);
    assert.ok(st.incidents.filter((i) => i.kind === 'missed').every((i) => i.tourId === rueck.id));
    assert.ok(st.incidents.every((i) => st.tours.some((t) => t.id === i.tourId)));
    // jede Meldung kennt ihre Ansicht (Farbe und Zeichen kommen aus dem Verzeichnis der Arten)
    for (const i of st.incidents) assert.ok(st.theme.kinds[i.kind], `Art ${i.kind} fehlt im Verzeichnis`);
  } finally { server.close(); }
});

test('Strecke mit Umstieg, pausiert: bleibt als Umstiegsstrecke erkennbar', async () => {
  const { server, base } = await appOn(await tmp(), {}, { now: () => NOW });
  const h = hdr('umstiegspause12345'), post = poster(base, h);
  try {
    const { body } = await post('/api/tours', { from: FS, to: SZ, transfers: 1 });
    const id = body.tours[0].id;
    assert.equal((await fetch(`${base}/api/tours/${id}`, { method: 'PATCH', headers: h, body: JSON.stringify({ active: false }) })).status, 200);
    const t = (await (await fetch(`${base}/api/state`, { headers: h })).json()).tours.find((x) => x.id === id);
    assert.equal(t.active, false); assert.equal(t.transfers, 1); assert.deepEqual(t.departures, []);
  } finally { server.close(); }
});

// ---------- Push ----------

test('Push: „Anschluss wackelt“ und „Anschluss verpasst“ kommen immer (solange aktuell), mit eigenem Titel', () => {
  const inc = (kind, extra = {}) => ({ kind, delayMin: 8, lineName: 'RE 5', title: 'RE 5 München Hbf → Salzburg Hbf', summary: 'Umstieg nur noch 1 Min. (S1 an 07:45, RE 5 ab 07:46)', validity: { activeNow: true }, ...extra });
  for (const k of ['tight', 'missed']) { assert.ok(relevant(inc(k), 10), k); assert.ok(!relevant(inc(k, { validity: { activeNow: false } }), 3), k); }   // unabhängig von der Verspätungs-Schwelle
  assert.deepEqual(textFor(inc('tight')), { title: 'Anschluss wackelt · RE 5', body: 'München Hbf → Salzburg Hbf · Umstieg nur noch 1 Min. (S1 an 07:45, RE 5 ab 07:46)' });
  assert.equal(textFor(inc('missed')).title, 'Anschluss verpasst · RE 5');
  assert.equal(changeOf(inc('tight')), undefined); assert.equal(changeOf(inc('missed')), undefined);        // keine stillen Aktualisierungen: ein neuer Zustand ist eine neue Meldung
});
