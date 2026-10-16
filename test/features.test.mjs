// Neu in 0.6.0: Ausfall- und Gleiswechsel-Meldungen, Strecke ohne Direktverbindung nicht anlegen, Begrenzung und Einladungscode.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildTour, THEME } from '../server/domain/state.mjs';
import { Buckets, clientIp, isPrivateIp } from '../server/guard.mjs';
import { ProfileStore, addTours } from '../server/store/profile.mjs';
import { createApp } from '../server/index.mjs';
import { config } from '../server/config.mjs';

const tmp = (n = 'rego-f-') => mkdtemp(join(tmpdir(), n));
const MH = { id: '8000261', name: 'München Hbf' }, SZ = { id: '8100002', name: 'Salzburg Hbf' }, FS = { id: '8002078', name: 'Freising' };
const tour = { id: 't1', name: 'München Hbf → Salzburg Hbf', from: MH, to: SZ, active: true };
const NOW = Date.parse('2026-10-14T07:00:00+02:00');
const at = (hhmm, day = '2026-10-14') => `${day}T${hhmm}:00+02:00`;
const leg = (dep, o = {}) => ({ line: { name: 'RE 5', product: 'regional' }, direction: 'Salzburg', origin: MH, destination: SZ,
  plannedDep: dep, dep, depDelay: 0, plannedArr: dep, arr: dep, arrDelay: 0, plannedPlatform: '13', platform: '13', stopovers: [], remarks: [], ...o });
const ctx = (o = {}) => ({ now: NOW, minDelay: 3, linesAt: async () => [], lines: {}, ...o });
const J = (...legs) => legs.map((l) => ({ legs: [l] }));

// ---------- Ausfall ----------

test('Ausfall: eine Meldung je Linie, mit allen ausfallenden Fahrten und der nächsten Alternative', async () => {
  const r = await buildTour(tour, J(leg(at('07:20'), { cancelled: true }), leg(at('07:40'), { cancelled: true }), leg(at('08:00'), { platform: '7' })), ctx());
  assert.equal(r.incidents.length, 1);
  const i = r.incidents[0];
  assert.equal(i.kind, 'cancelled'); assert.equal(i.count, 2); assert.equal(i.lineName, 'RE 5'); assert.equal(i.severity, 3);
  assert.equal(i.summary, 'Fahrten um 07:20 und 07:40 fallen aus');
  assert.equal(i.view.kind, 'cancelled'); assert.equal(i.view.big, 'Fällt aus');
  assert.match(i.view.sub, /Nächste Fahrt RE 5 ab 08:00 · Gleis 7/);
  assert.deepEqual(i.view.rows.map((x) => x.value), ['entfällt', 'entfällt']);
  assert.equal(i.view.alternative.line1, 'RE 5 ab 08:00 · Gleis 7');
  // die Abfahrten der Strecke zeigen nur, was wirklich fährt
  assert.deepEqual(r.tour.departures.map((d) => d.expectedTime), ['08:00']);
  // Einzahl
  const one = await buildTour(tour, J(leg(at('07:20'), { cancelled: true }), leg(at('08:00'))), ctx());
  assert.equal(one.incidents[0].summary, 'Fahrt um 07:20 fällt aus'); assert.equal(one.incidents[0].count, 1);
  // viele: die ersten drei, der Rest als Zahl
  const many = await buildTour(tour, J(...['07:10', '07:20', '07:30', '07:40', '07:50'].map((h) => leg(at(h), { cancelled: true })), leg(at('08:30'))), ctx());
  assert.equal(many.incidents[0].summary, 'Fahrten um 07:10, 07:20, 07:30 und 2 weitere fallen aus');
});

test('Ausfall: Kennung bleibt gleich (kein erneuter Push), neuer Tag oder andere Linie ist neu; nur die nächsten Stunden, nur Künftiges', async () => {
  const a = await buildTour(tour, J(leg(at('07:20'), { cancelled: true }), leg(at('08:00'))), ctx());
  const b = await buildTour(tour, J(leg(at('07:20'), { cancelled: true }), leg(at('07:40'), { cancelled: true }), leg(at('08:00'))), ctx({ now: NOW + 60e3 }));
  assert.equal(a.incidents[0].id, b.incidents[0].id);                   // weitere Ausfälle derselben Linie aktualisieren die Meldung, sie ist nicht neu
  const other = await buildTour(tour, J(leg(at('07:20'), { cancelled: true, line: { name: 'RJX 61', product: 'nationalExpress' } }), leg(at('08:00'))), ctx());
  assert.notEqual(a.incidents[0].id, other.incidents[0].id);
  const nextDay = await buildTour(tour, J(leg(at('07:20', '2026-10-15'), { cancelled: true }), leg(at('08:00'))), ctx({ now: Date.parse('2026-10-15T07:00:00+02:00') }));
  assert.notEqual(a.incidents[0].id, nextDay.incidents[0].id);
  // Ausfall in fünf Stunden: noch keine Meldung; Ausfall von vorhin: auch nicht
  const far = await buildTour(tour, J(leg(at('12:30'), { cancelled: true }), leg(at('08:00'))), ctx());
  assert.deepEqual(far.incidents.filter((x) => x.kind === 'cancelled'), []);
  const past = await buildTour(tour, J(leg(at('06:40'), { cancelled: true }), leg(at('08:00'))), ctx());
  assert.deepEqual(past.incidents.filter((x) => x.kind === 'cancelled'), []);
});

test('Ausfall: fällt alles aus, bleibt die Meldung stehen und die Strecke sagt es ehrlich', async () => {
  const r = await buildTour(tour, J(leg(at('07:20'), { cancelled: true }), leg(at('07:50'), { cancelled: true })), ctx());
  assert.equal(r.incidents.length, 1); assert.equal(r.incidents[0].view.alternative, null);
  assert.match(r.incidents[0].view.sub, /Keine weitere Fahrt/);
  assert.equal(r.tour.view.big, 'Fällt aus'); assert.deepEqual(r.tour.departures, []);
  // höchstens zwei Linien je Strecke
  const three = await buildTour(tour, J(...['RE 5', 'RJX 61', 'S 2'].map((n, k) => leg(at(`07:${20 + k}`), { cancelled: true, line: { name: n, product: 'regional' } })), leg(at('09:00'))), ctx());
  assert.equal(three.incidents.filter((x) => x.kind === 'cancelled').length, 2);
});

// ---------- Gleiswechsel ----------

test('Gleiswechsel: eigene, leise Meldung – nur kurz vor der Abfahrt, nicht doppelt zur Verspätung', async () => {
  const changed = (hh, o = {}) => leg(at(hh), { plannedPlatform: '13', platform: '7', ...o });
  const r = await buildTour(tour, J(changed('07:20')), ctx());
  assert.equal(r.incidents.length, 1);
  const i = r.incidents[0];
  assert.equal(i.kind, 'platform'); assert.equal(i.platform, '7'); assert.equal(i.severity, 1);
  assert.equal(i.summary, '07:20 jetzt Gleis 7 statt Gleis 13');
  assert.equal(i.view.kind, 'platform'); assert.equal(i.view.big, 'Gl. 7'); assert.equal(i.view.sub, 'statt Gleis 13');
  assert.equal(r.tour.view, undefined);                                  // es gibt eine Meldung, also keine „pünktlich“-Ansicht
  // Zug in zwei Stunden: noch zu früh
  assert.deepEqual((await buildTour(tour, J(leg(at('07:05')), changed('09:00')), ctx())).incidents, []);
  // Gleiswechsel und Verspätung am selben Zug: eine Meldung (die Verspätung nennt das Gleis schon)
  const late = await buildTour(tour, J(changed('07:20', { dep: at('07:28'), depDelay: 8 })), ctx());
  assert.deepEqual(late.incidents.map((x) => x.kind), ['delay']); assert.match(late.incidents[0].summary, /Gleiswechsel Gl\. 13 → Gl\. 7/);
  // gleiche Zeit, gleiche Linie, anderes Gleis -> dieselbe Kennung (damit ein weiterer Wechsel die Meldung aktualisiert statt neu zu melden)
  const again = await buildTour(tour, J(changed('07:20', { platform: '9' })), ctx());
  assert.equal(again.incidents[0].id, i.id); assert.equal(again.incidents[0].platform, '9');
  // höchstens zwei
  const lots = await buildTour(tour, J(changed('07:10'), changed('07:20'), changed('07:30'), changed('07:40')), ctx());
  assert.equal(lots.incidents.filter((x) => x.kind === 'platform').length, 2);
});

// ---------- Kleinkram ----------

test('Ersatzverkehr und Baustelle: das Datum steht nur einmal im Kopf, nicht noch einmal darunter (E1)', async () => {
  const remark = { type: 'status', code: 'construction', summary: 'Schienenersatzverkehr', text: 'Wegen Bauarbeiten zwischen Rosenheim und Prien Schienenersatzverkehr.', validFrom: at('00:00', '2026-10-10'), validUntil: at('23:00', '2026-10-17'), priority: 90 };
  const r = await buildTour(tour, J(leg(at('07:20'), { remarks: [remark] }), leg(at('08:20'))), ctx());
  const i = r.incidents.find((x) => x.kind === 'replacement');
  assert.match(i.view.head, /bis Sa 17\.10\./); assert.doesNotMatch(i.view.sub, /bis|\d\d\.\d\d\./);
  assert.equal(i.view.sub, 'RE 5 München Hbf → Salzburg Hbf');
});

test('Farben: jede Meldungsart hat eine Farbe, die der Dunkelmodus kennt; Server und App sind einer Meinung', async () => {
  const known = ['#FDE3CF', '#F9D6D2', '#FDF3DC', '#EAF6CF', '#D4EDF6'];     // Pastellfarben, auf die der Dunkelmodus in den Seiten wartet
  for (const [kind, k] of Object.entries(THEME.kinds)) { assert.ok(known.includes(k.bg), `${kind}: ${k.bg}`); assert.ok(k.icon.length >= 1 && k.label); }
  const flat = (x) => x.replace(/\s+/g, '');
  const parse = (src) => Object.fromEntries([...src.matchAll(/^\s+(\w+):\s*\{ label: '([^']+)', bg: '(#[0-9A-Fa-f]{6})', icon: \[([^\]]*)\]/gm)].map((m) => [m[1], { label: m[2], bg: m[3].toUpperCase(), icon: flat(m[4]) }]));
  const client = parse(await readFile(new URL('../public/js/rego-live.js', import.meta.url), 'utf8'));
  const server = Object.fromEntries(Object.entries(THEME.kinds).map(([k, v]) => [k, { label: v.label, bg: v.bg.toUpperCase(), icon: flat(v.icon.map((d) => `'${d}'`).join(',')) }]));
  assert.deepEqual(Object.keys(client).sort(), Object.keys(server).sort());
  assert.deepEqual(client, server);
  for (const f of ['Main', 'Detail', 'Meldungen']) {                            // die Seiten kennen jede Farbe auch im Dunkelmodus (Regeln stehen in jeder Seite)
    const src = await readFile(new URL(`../public/screens/${f}.dc.html`, import.meta.url), 'utf8');
    for (const bg of known) { const [, r, g, b] = /^#(..)(..)(..)$/.exec(bg); assert.ok(src.includes(`background: rgb(${parseInt(r, 16)}, ${parseInt(g, 16)}, ${parseInt(b, 16)})`), `${f}: ${bg}`); }
  }
});

test('Version: package.json, Add-on und Änderungsliste nennen dieselbe Nummer', async () => {
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')).version;
  const yaml = /^version:\s*"?([^"\n]+)"?/m.exec(await readFile(new URL('../rego/config.yaml', import.meta.url), 'utf8'))[1].trim();
  const log = /^##\s*\[?v?(\d+\.\d+\.\d+)/m.exec(await readFile(new URL('../rego/CHANGELOG.md', import.meta.url), 'utf8'))[1];
  assert.equal(yaml, pkg); assert.equal(log, pkg);
});

// ---------- keine Direktverbindung beim Anlegen (T2) ----------

async function appOn(dir, cfg = {}, extra = {}) {
  const { server, store, service } = createApp({ cfg: { ...config, dataDir: dir, provider: 'mock', ...cfg }, ...extra });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { server, store, service, base: `http://127.0.0.1:${server.address().port}` };
}
const hdr = (dev, extra = {}) => ({ 'x-device': dev, 'content-type': 'application/json', ...extra });

test('Strecke ohne Direktverbindung wird nicht angelegt (422), mit Direktverbindung schon; im Zweifel wird angelegt', async () => {
  const { server, base, service } = await appOn(await tmp());
  const h = hdr('direktgeraet12345678');
  const post = (body) => fetch(`${base}/api/tours`, { method: 'POST', headers: h, body: JSON.stringify(body) });
  try {
    let r = await post({ from: FS, to: SZ });                              // Freising → Salzburg: die Beispieldaten kennen keine Fahrt ohne Umstieg
    assert.equal(r.status, 422);
    assert.match((await r.json()).error, /Zwischen Freising und Salzburg Hbf habe ich keine Direktverbindung gefunden/);
    r = await post({ from: FS, to: SZ, roundTrip: true }); assert.equal(r.status, 422);
    r = await post({ from: MH, to: FS, roundTrip: true }); assert.equal(r.status, 201);          // München ↔ Freising gibt es
    assert.equal((await (await fetch(`${base}/api/profile`, { headers: h })).json()).tours.length, 2);   // von der abgelehnten wurde nichts gespeichert
    // Quelle antwortet nicht: wissen wir es nicht, legen wir an (der Nutzer soll nicht ausgesperrt werden)
    const orig = service.hasDirect; service.hasDirect = async () => null;
    r = await post({ from: FS, to: SZ }); assert.equal(r.status, 201);
    service.hasDirect = orig;
    // dieselbe Strecke noch einmal (Doppeltippen): mit Direktverbindung bleibt es bei der vorhandenen Strecke
    r = await post({ from: MH, to: FS }); assert.equal(r.status, 201);
    assert.equal((await (await fetch(`${base}/api/profile`, { headers: h })).json()).tours.length, 3);
    // eine vorhandene Strecke ohne Direktverbindung (aus einer älteren Version) wird nicht stillschweigend „noch einmal angelegt“: der Hinweis kommt wieder (seit 0.7.0 mit „Mit 1 Umstieg suchen“)
    service.hasDirect = async () => false;
    r = await post({ from: FS, to: SZ }); assert.equal(r.status, 422); assert.equal((await r.json()).code, 'no-direct');
    // unsinnige Eingabe bleibt ein 400, nicht 422
    assert.equal((await post({ from: FS, to: FS })).status, 400);
  } finally { server.close(); }
});

// ---------- Begrenzung ----------

test('Eimer mit Marken: Stoß, Nachfüllen, Wartezeit, begrenzte Größe', () => {
  let t = 0; const b = new Buckets({ burst: 3, perSec: 1, max: 2 }, () => t);
  assert.deepEqual([b.take('a'), b.take('a'), b.take('a')], [0, 0, 0]);
  assert.equal(b.take('a'), 1);                                             // leer: eine Sekunde warten
  t = 1500; assert.equal(b.take('a'), 0);                                   // eine Marke nachgefüllt
  assert.equal(b.take('a'), 1);
  t = 60000; assert.equal(b.level('a'), 3);                                 // nie über dem Stoß
  b.take('b'); b.take('c');                                                 // max 2 Schlüssel: der älteste fliegt raus
  assert.equal(b.map.size, 2); assert.ok(!b.map.has('a'));
});

test('Adresse des Anrufers: X-Forwarded-For zählt nur hinter lokalem/privatem/Tailscale-Proxy', () => {
  const req = (peer, xff) => ({ socket: { remoteAddress: peer }, headers: xff ? { 'x-forwarded-for': xff } : {} });
  assert.equal(clientIp(req('203.0.113.9', '1.2.3.4')), '203.0.113.9');             // direkt aus dem Internet: Header ist erfunden
  assert.equal(clientIp(req('127.0.0.1', '198.51.100.7')), '198.51.100.7');
  assert.equal(clientIp(req('::ffff:100.101.102.103', '198.51.100.7, 100.64.0.5')), '198.51.100.7');   // Tailscale-Hop am Ende wird übersprungen
  assert.equal(clientIp(req('172.30.32.1', '10.0.0.4, 198.51.100.7')), '198.51.100.7');
  assert.equal(clientIp(req('127.0.0.1', '6.6.6.6, 198.51.100.7')), '198.51.100.7');      // vorn erfundene Einträge ändern nichts: die letzte öffentliche zählt
  assert.equal(clientIp(req('127.0.0.1', '')), '127.0.0.1');
  for (const ip of ['127.0.0.1', '10.1.2.3', '192.168.1.5', '172.16.0.1', '172.31.255.1', '100.64.0.1', '100.127.255.254', '::1', 'fd12::1', 'fe80::1']) assert.ok(isPrivateIp(ip), ip);
  for (const ip of ['8.8.8.8', '172.32.0.1', '100.128.0.1', '100.63.255.255', '2001:db8::1']) assert.ok(!isPrivateIp(ip), ip);
});

test('Begrenzung je Adresse: zu viele Anfragen -> 429 mit Wartezeit; Watchdog-Prüfung und Vorabfragen bleiben frei', async () => {
  const { server, base } = await appOn(await tmp(), { limits: { ipBurst: 6, ipPerSec: 0.001 } });
  try {
    const codes = [];
    for (let k = 0; k < 8; k++) codes.push((await fetch(`${base}/api/status`)).status);
    assert.deepEqual(codes, [200, 200, 200, 200, 200, 200, 429, 429]);
    const r = await fetch(`${base}/api/status`);
    assert.equal(r.status, 429); assert.ok(Number(r.headers.get('retry-after')) >= 1); assert.match((await r.json()).error, /Zu viele Anfragen/);
    for (let k = 0; k < 5; k++) assert.equal((await fetch(`${base}/api/health`)).status, 200);            // Watchdog des Add-ons
    assert.equal((await fetch(`${base}/api/state`, { method: 'OPTIONS' })).status, 204);
  } finally { server.close(); }
});

test('Begrenzung je Gerät und für die Haltestellensuche', async () => {
  const { server, base } = await appOn(await tmp(), { limits: { deviceBurst: 5, devicePerSec: 0.001, searchBurst: 2, searchPerSec: 0.001 } });
  try {
    const h = hdr('begrenztgeraet123456');
    const s = [];
    for (let k = 0; k < 3; k++) s.push((await fetch(`${base}/api/stations?q=Freising`, { headers: h })).status);
    assert.deepEqual(s, [200, 200, 429]);                                     // Suche: zwei, dann Pause
    assert.equal((await fetch(`${base}/api/state`, { headers: h })).status, 200);       // der Rest des Geräts läuft weiter (3 Such-Anfragen + 2 hier = Stoß von 5)
    assert.equal((await fetch(`${base}/api/state`, { headers: h })).status, 200);
    assert.equal((await fetch(`${base}/api/state`, { headers: h })).status, 429);       // Geräte-Stoß ausgeschöpft
    assert.equal((await fetch(`${base}/api/state`, { headers: hdr('anderesgeraet1234567') })).status, 200);   // ein anderes Gerät ist nicht betroffen
  } finally { server.close(); }
});

test('Neue Geräte je Adresse sind begrenzt, bekannte laufen weiter', async () => {
  const { server, base, store } = await appOn(await tmp(), { limits: { newDevicesPerHour: 2 } });
  try {
    await store.update('bekanntgeraet1234567', () => {});
    const get = (d) => fetch(`${base}/api/state`, { headers: hdr(d) }).then((r) => r.status);
    assert.equal(await get('neuesgeraet00000001'), 200);
    assert.equal(await get('neuesgeraet00000001'), 200);                       // dasselbe Gerät zählt einmal
    assert.equal(await get('neuesgeraet00000002'), 200);
    assert.equal(await get('neuesgeraet00000003'), 429);                       // das dritte neue von derselben Adresse
    assert.equal(await get('bekanntgeraet1234567'), 200);
  } finally { server.close(); }
});

test('Einladungscode: neue Geräte brauchen ihn, bekannte nicht; falsche Codes sperren kurz', async () => {
  const { server, base, store } = await appOn(await tmp(), { inviteCode: 'Öl-Pendler 26', limits: { inviteTries: 3 } });
  try {
    const get = async (d, code) => { const r = await fetch(`${base}/api/state`, { headers: hdr(d, code === undefined ? {} : { 'x-invite': encodeURIComponent(code) }) }); return { status: r.status, body: await r.json() }; };
    let r = await get('einladungsgeraet12345');
    assert.equal(r.status, 403); assert.equal(r.body.invite, true); assert.equal(r.body.wrong, false);
    r = await get('einladungsgeraet12345', 'falsch');
    assert.equal(r.status, 403); assert.equal(r.body.wrong, true);
    r = await get('einladungsgeraet12345', 'öl-pendler 26');                    // Groß/Klein egal, Umlaut übersteht den Header
    assert.equal(r.status, 200); assert.ok(Array.isArray(r.body.tours));
    // schon vorhandene Geräte (vor dem Einschalten der Einladung angelegt) brauchen keinen Code
    await store.update('altesgeraet123456789', () => {});
    assert.equal((await get('altesgeraet123456789')).status, 200);
    // Raten: nach drei falschen Versuchen ist Pause, auch mit richtigem Code
    for (let k = 0; k < 3; k++) await get('ratergeraet1234567', `x${k}`);
    r = await get('ratergeraet1234567', 'Öl-Pendler 26');
    assert.equal(r.status, 429); assert.match(r.body.error, /falsche Codes/);
    // Status und Watchdog sind öffentlich
    assert.equal((await fetch(`${base}/api/status`)).status, 200);
  } finally { server.close(); }
});

test('Ohne Einladungscode (Standard) ist alles offen', async () => {
  const { server, base } = await appOn(await tmp());
  try { assert.equal((await fetch(`${base}/api/state`, { headers: hdr('offengeraet12345678') })).status, 200); } finally { server.close(); }
});

test('Antworten bei Begrenzung tragen die CORS-Kopfzeilen der App (sonst sieht die App nur „Netzwerkfehler“)', async () => {
  const { server, base } = await appOn(await tmp(), { inviteCode: 'abc' });
  try {
    const r = await fetch(`${base}/api/state`, { headers: hdr('corsgeraet1234567890', { origin: 'https://appassets.androidplatform.net' }) });
    assert.equal(r.status, 403); assert.equal(r.headers.get('access-control-allow-origin'), 'https://appassets.androidplatform.net');
    const pre = await fetch(`${base}/api/state`, { method: 'OPTIONS', headers: { origin: 'https://appassets.androidplatform.net', 'access-control-request-headers': 'x-invite' } });
    assert.match(pre.headers.get('access-control-allow-headers'), /x-invite/);
  } finally { server.close(); }
});
