// New in 0.6.0: cancellation and platform-change incidents, no route without a direct connection, rate limiting and invitation code.
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

// ---------- Cancellation ----------

test('Cancellation: one incident per line, with all cancelled trips and the next alternative', async () => {
  const r = await buildTour(tour, J(leg(at('07:20'), { cancelled: true }), leg(at('07:40'), { cancelled: true }), leg(at('08:00'), { platform: '7' })), ctx());
  assert.equal(r.incidents.length, 1);
  const i = r.incidents[0];
  assert.equal(i.kind, 'cancelled'); assert.equal(i.count, 2); assert.equal(i.lineName, 'RE 5'); assert.equal(i.severity, 3);
  assert.equal(i.summary, 'Fahrten um 07:20 und 07:40 fallen aus');
  assert.equal(i.view.kind, 'cancelled'); assert.equal(i.view.big, 'Fällt aus');
  assert.match(i.view.sub, /Stattdessen: RE 5 ab 08:00 · Gleis 7/);
  assert.deepEqual(i.view.rows.map((x) => x.value), ['entfällt', 'entfällt']);
  assert.equal(i.view.alternative.line1, 'RE 5 ab 08:00 · Gleis 7');
  // the route's departures only show what really runs
  assert.deepEqual(r.tour.departures.map((d) => d.expectedTime), ['08:00']);
  // Einzahl
  const one = await buildTour(tour, J(leg(at('07:20'), { cancelled: true }), leg(at('08:00'))), ctx());
  assert.equal(one.incidents[0].summary, 'Fahrt um 07:20 fällt aus'); assert.equal(one.incidents[0].count, 1);
  // many: the first three, the rest as a number
  const many = await buildTour(tour, J(...['07:10', '07:20', '07:30', '07:40', '07:50'].map((h) => leg(at(h), { cancelled: true })), leg(at('08:30'))), ctx());
  assert.equal(many.incidents[0].summary, 'Fahrten um 07:10, 07:20, 07:30 und 2 weitere fallen aus');
});

test('Cancellation: ID stays the same (no repeated push), a new day or another line is new; only the next hours, only future ones', async () => {
  const a = await buildTour(tour, J(leg(at('07:20'), { cancelled: true }), leg(at('08:00'))), ctx());
  const b = await buildTour(tour, J(leg(at('07:20'), { cancelled: true }), leg(at('07:40'), { cancelled: true }), leg(at('08:00'))), ctx({ now: NOW + 60e3 }));
  assert.equal(a.incidents[0].id, b.incidents[0].id);                   // further cancellations of the same line update the incident, it is not new
  const other = await buildTour(tour, J(leg(at('07:20'), { cancelled: true, line: { name: 'RJX 61', product: 'nationalExpress' } }), leg(at('08:00'))), ctx());
  assert.notEqual(a.incidents[0].id, other.incidents[0].id);
  const nextDay = await buildTour(tour, J(leg(at('07:20', '2026-10-15'), { cancelled: true }), leg(at('08:00'))), ctx({ now: Date.parse('2026-10-15T07:00:00+02:00') }));
  assert.notEqual(a.incidents[0].id, nextDay.incidents[0].id);
  // Cancellation in five hours: no incident yet; cancellation from earlier: neither
  const far = await buildTour(tour, J(leg(at('12:30'), { cancelled: true }), leg(at('08:00'))), ctx());
  assert.deepEqual(far.incidents.filter((x) => x.kind === 'cancelled'), []);
  const past = await buildTour(tour, J(leg(at('06:40'), { cancelled: true }), leg(at('08:00'))), ctx());
  assert.deepEqual(past.incidents.filter((x) => x.kind === 'cancelled'), []);
});

test('Cancellation: if everything is cancelled, the incident stays and the route says so honestly', async () => {
  const r = await buildTour(tour, J(leg(at('07:20'), { cancelled: true }), leg(at('07:50'), { cancelled: true })), ctx());
  assert.equal(r.incidents.length, 1); assert.equal(r.incidents[0].view.alternative, null);
  assert.match(r.incidents[0].view.sub, /Keine weitere Fahrt/);
  assert.equal(r.tour.view.big, 'Fällt aus'); assert.deepEqual(r.tour.departures, []);
  // at most two lines per route
  const three = await buildTour(tour, J(...['RE 5', 'RJX 61', 'S 2'].map((n, k) => leg(at(`07:${20 + k}`), { cancelled: true, line: { name: n, product: 'regional' } })), leg(at('09:00'))), ctx());
  assert.equal(three.incidents.filter((x) => x.kind === 'cancelled').length, 2);
});

// ---------- Gleiswechsel ----------

test('Platform change: own, quiet incident – only shortly before departure, not twice with the delay', async () => {
  const changed = (hh, o = {}) => leg(at(hh), { plannedPlatform: '13', platform: '7', ...o });
  const r = await buildTour(tour, J(changed('07:20')), ctx());
  assert.equal(r.incidents.length, 1);
  const i = r.incidents[0];
  assert.equal(i.kind, 'platform'); assert.equal(i.platform, '7'); assert.equal(i.severity, 1);
  assert.equal(i.summary, '07:20 jetzt Gleis 7 statt Gleis 13');
  assert.equal(i.view.kind, 'platform'); assert.equal(i.view.big, 'Gl. 7'); assert.equal(i.view.sub, 'statt Gleis 13');
  assert.equal(r.tour.view, undefined);                                  // there is an incident, so no "pünktlich" view
  // Train in two hours: still too early
  assert.deepEqual((await buildTour(tour, J(leg(at('07:05')), changed('09:00')), ctx())).incidents, []);
  // Platform change and delay on the same train: one incident (the delay already names the platform)
  const late = await buildTour(tour, J(changed('07:20', { dep: at('07:28'), depDelay: 8 })), ctx());
  assert.deepEqual(late.incidents.map((x) => x.kind), ['delay']); assert.match(late.incidents[0].summary, /Gleiswechsel Gl\. 13 → Gl\. 7/);
  // same time, same line, other platform -> same ID (so that a further change updates the incident instead of reporting anew)
  const again = await buildTour(tour, J(changed('07:20', { platform: '9' })), ctx());
  assert.equal(again.incidents[0].id, i.id); assert.equal(again.incidents[0].platform, '9');
  // at most two
  const lots = await buildTour(tour, J(changed('07:10'), changed('07:20'), changed('07:30'), changed('07:40')), ctx());
  assert.equal(lots.incidents.filter((x) => x.kind === 'platform').length, 2);
});

// ---------- Kleinkram ----------

test('Replacement transport and construction: the date appears only once in the header, not again below (E1)', async () => {
  const remark = { type: 'status', code: 'construction', summary: 'Schienenersatzverkehr', text: 'Wegen Bauarbeiten zwischen Rosenheim und Prien Schienenersatzverkehr.', validFrom: at('00:00', '2026-10-10'), validUntil: at('23:00', '2026-10-17'), priority: 90 };
  const r = await buildTour(tour, J(leg(at('07:20'), { remarks: [remark] }), leg(at('08:20'))), ctx());
  const i = r.incidents.find((x) => x.kind === 'replacement');
  assert.match(i.view.head, /bis Sa 17\.10\./); assert.doesNotMatch(i.view.sub, /bis|\d\d\.\d\d\./);
  assert.equal(i.view.sub, 'RE 5 ab 07:20 · mit Ersatzverkehr');           // names the affected trip, never claims that the whole line is replaced
});

test('Direct trips: every departure carries its arrival at the destination (real time; replacement transport with the stated extra time)', async () => {
  const remark = { type: 'status', code: 'construction', summary: 'Schienenersatzverkehr', text: 'Wegen Bauarbeiten zwischen Rosenheim und Prien Schienenersatzverkehr. Die Reisezeit verlängert sich um ca. 25 Minuten.', validFrom: at('00:00', '2026-10-10'), validUntil: at('23:00', '2026-10-17'), priority: 90 };
  const r = await buildTour(tour, J(
    leg(at('07:20'), { plannedArr: at('08:20'), arr: at('08:25'), arrDelay: 5 }),                    // 5 minutes late at the destination
    leg(at('07:40'), { plannedArr: at('08:40'), arr: at('08:40'), remarks: [remark] }),              // replacement transport: planned arrival + 25 minutes
    leg(at('08:00'), { plannedArr: at('09:00'), arr: at('09:00') }),
  ), ctx());
  assert.deepEqual(r.tour.departures.map((d) => d.arrTime), ['08:25', '09:05', '09:00']);
});

test('Colors: every incident kind has a color that dark mode knows; server and app agree', async () => {
  const known = ['#FDE3CF', '#F9D6D2', '#FDF3DC', '#EAF6CF', '#D4EDF6'];     // pastel colors that the dark-mode rules in the pages are keyed to
  for (const [kind, k] of Object.entries(THEME.kinds)) { assert.ok(known.includes(k.bg), `${kind}: ${k.bg}`); assert.ok(k.icon.length >= 1 && k.label); }
  const flat = (x) => x.replace(/\s+/g, '');
  const parse = (src) => Object.fromEntries([...src.matchAll(/^\s+(\w+):\s*\{ label: '([^']+)', bg: '(#[0-9A-Fa-f]{6})', icon: \[([^\]]*)\]/gm)].map((m) => [m[1], { label: m[2], bg: m[3].toUpperCase(), icon: flat(m[4]) }]));
  const client = parse(await readFile(new URL('../public/js/rego-live.js', import.meta.url), 'utf8'));
  const server = Object.fromEntries(Object.entries(THEME.kinds).map(([k, v]) => [k, { label: v.label, bg: v.bg.toUpperCase(), icon: flat(v.icon.map((d) => `'${d}'`).join(',')) }]));
  assert.deepEqual(Object.keys(client).sort(), Object.keys(server).sort());
  assert.deepEqual(client, server);
  for (const f of ['Main', 'Detail', 'Meldungen']) {                            // the pages know every color in dark mode too (the rules are in each page)
    const src = await readFile(new URL(`../public/screens/${f}.dc.html`, import.meta.url), 'utf8');
    for (const bg of known) { const [, r, g, b] = /^#(..)(..)(..)$/.exec(bg); assert.ok(src.includes(`background: rgb(${parseInt(r, 16)}, ${parseInt(g, 16)}, ${parseInt(b, 16)})`), `${f}: ${bg}`); }
  }
});

test('Version: package.json, add-on and changelog show the same number', async () => {
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')).version;
  const yaml = /^version:\s*"?([^"\n]+)"?/m.exec(await readFile(new URL('../rego/config.yaml', import.meta.url), 'utf8'))[1].trim();
  const log = /^##\s*\[?v?(\d+\.\d+\.\d+)/m.exec(await readFile(new URL('../rego/CHANGELOG.md', import.meta.url), 'utf8'))[1];
  assert.equal(yaml, pkg); assert.equal(log, pkg);
});

// ---------- no direct connection when creating (T2) ----------

async function appOn(dir, cfg = {}, extra = {}) {
  const { server, store, service } = createApp({ cfg: { ...config, dataDir: dir, provider: 'mock', ...cfg }, ...extra });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { server, store, service, base: `http://127.0.0.1:${server.address().port}` };
}
const hdr = (dev, extra = {}) => ({ 'x-device': dev, 'content-type': 'application/json', ...extra });

test('A route without a direct connection is not created (422), one with a direct connection is; when in doubt it is created', async () => {
  const { server, base, service } = await appOn(await tmp());
  const h = hdr('direktgeraet12345678');
  const post = (body) => fetch(`${base}/api/tours`, { method: 'POST', headers: h, body: JSON.stringify(body) });
  try {
    let r = await post({ from: FS, to: SZ });                              // Freising → Salzburg: the sample data know no trip without a transfer
    assert.equal(r.status, 422);
    assert.match((await r.json()).error, /Zwischen Freising und Salzburg Hbf habe ich keine Direktverbindung gefunden/);
    r = await post({ from: FS, to: SZ, roundTrip: true }); assert.equal(r.status, 422);
    r = await post({ from: MH, to: FS, roundTrip: true }); assert.equal(r.status, 201);          // München ↔ Freising exists
    assert.equal((await (await fetch(`${base}/api/profile`, { headers: h })).json()).tours.length, 2);   // nothing of the rejected one was stored
    // source does not answer: if we do not know, we create it (the user must not be locked out)
    const orig = service.hasDirect; service.hasDirect = async () => null;
    r = await post({ from: FS, to: SZ }); assert.equal(r.status, 201);
    service.hasDirect = orig;
    // the same route once more (double tap): with a direct connection the existing route stays
    r = await post({ from: MH, to: FS }); assert.equal(r.status, 201);
    assert.equal((await (await fetch(`${base}/api/profile`, { headers: h })).json()).tours.length, 3);
    // an existing route without a direct connection (from an older version) is not silently "created once more": the hint comes again (since 0.7.0 with "Mit 1 Umstieg suchen")
    service.hasDirect = async () => false;
    r = await post({ from: FS, to: SZ }); assert.equal(r.status, 422); assert.equal((await r.json()).code, 'no-direct');
    // nonsensical input stays a 400, not 422
    assert.equal((await post({ from: FS, to: FS })).status, 400);
  } finally { server.close(); }
});

// ---------- Begrenzung ----------

test('Token buckets: burst, refill, wait time, limited size', () => {
  let t = 0; const b = new Buckets({ burst: 3, perSec: 1, max: 2 }, () => t);
  assert.deepEqual([b.take('a'), b.take('a'), b.take('a')], [0, 0, 0]);
  assert.equal(b.take('a'), 1);                                             // empty: wait one second
  t = 1500; assert.equal(b.take('a'), 0);                                   // one token refilled
  assert.equal(b.take('a'), 1);
  t = 60000; assert.equal(b.level('a'), 3);                                 // never above the burst
  b.take('b'); b.take('c');                                                 // max 2 keys: the oldest drops out
  assert.equal(b.map.size, 2); assert.ok(!b.map.has('a'));
});

test('Caller address: X-Forwarded-For only counts behind a local/private/Tailscale proxy', () => {
  const req = (peer, xff) => ({ socket: { remoteAddress: peer }, headers: xff ? { 'x-forwarded-for': xff } : {} });
  assert.equal(clientIp(req('203.0.113.9', '1.2.3.4')), '203.0.113.9');             // directly from the internet: the header is made up
  assert.equal(clientIp(req('127.0.0.1', '198.51.100.7')), '198.51.100.7');
  assert.equal(clientIp(req('::ffff:100.101.102.103', '198.51.100.7, 100.64.0.5')), '198.51.100.7');   // Tailscale hop at the end is skipped
  assert.equal(clientIp(req('172.30.32.1', '10.0.0.4, 198.51.100.7')), '198.51.100.7');
  assert.equal(clientIp(req('127.0.0.1', '6.6.6.6, 198.51.100.7')), '198.51.100.7');      // made-up entries at the front change nothing: the last public one counts
  assert.equal(clientIp(req('127.0.0.1', '')), '127.0.0.1');
  for (const ip of ['127.0.0.1', '10.1.2.3', '192.168.1.5', '172.16.0.1', '172.31.255.1', '100.64.0.1', '100.127.255.254', '::1', 'fd12::1', 'fe80::1']) assert.ok(isPrivateIp(ip), ip);
  for (const ip of ['8.8.8.8', '172.32.0.1', '100.128.0.1', '100.63.255.255', '2001:db8::1']) assert.ok(!isPrivateIp(ip), ip);
});

test('Rate limit per address: too many requests -> 429 with wait time; watchdog check and preflight requests stay free', async () => {
  const { server, base } = await appOn(await tmp(), { limits: { ipBurst: 6, ipPerSec: 0.001 } });
  try {
    const codes = [];
    for (let k = 0; k < 8; k++) codes.push((await fetch(`${base}/api/status`)).status);
    assert.deepEqual(codes, [200, 200, 200, 200, 200, 200, 429, 429]);
    const r = await fetch(`${base}/api/status`);
    assert.equal(r.status, 429); assert.ok(Number(r.headers.get('retry-after')) >= 1); assert.match((await r.json()).error, /Zu viele Anfragen/);
    for (let k = 0; k < 5; k++) assert.equal((await fetch(`${base}/api/health`)).status, 200);            // add-on watchdog
    assert.equal((await fetch(`${base}/api/state`, { method: 'OPTIONS' })).status, 204);
  } finally { server.close(); }
});

test('Limits per device and for the stop search', async () => {
  const { server, base } = await appOn(await tmp(), { limits: { deviceBurst: 5, devicePerSec: 0.001, searchBurst: 2, searchPerSec: 0.001 } });
  try {
    const h = hdr('begrenztgeraet123456');
    const s = [];
    for (let k = 0; k < 3; k++) s.push((await fetch(`${base}/api/stations?q=Freising`, { headers: h })).status);
    assert.deepEqual(s, [200, 200, 429]);                                     // search: two, then a pause
    assert.equal((await fetch(`${base}/api/state`, { headers: h })).status, 200);       // the rest of the device keeps working (3 search requests + 2 here = burst of 5)
    assert.equal((await fetch(`${base}/api/state`, { headers: h })).status, 200);
    assert.equal((await fetch(`${base}/api/state`, { headers: h })).status, 429);       // device burst used up
    assert.equal((await fetch(`${base}/api/state`, { headers: hdr('anderesgeraet1234567') })).status, 200);   // another device is not affected
  } finally { server.close(); }
});

test('New devices per address are limited, known ones keep working', async () => {
  const { server, base, store } = await appOn(await tmp(), { limits: { newDevicesPerHour: 2 } });
  try {
    await store.update('bekanntgeraet1234567', () => {});
    const get = (d) => fetch(`${base}/api/state`, { headers: hdr(d) }).then((r) => r.status);
    assert.equal(await get('neuesgeraet00000001'), 200);
    assert.equal(await get('neuesgeraet00000001'), 200);                       // the same device counts once
    assert.equal(await get('neuesgeraet00000002'), 200);
    assert.equal(await get('neuesgeraet00000003'), 429);                       // the third new one from the same address
    assert.equal(await get('bekanntgeraet1234567'), 200);
  } finally { server.close(); }
});

test('Invitation code: new devices need it, known ones do not; wrong codes lock out briefly', async () => {
  const { server, base, store } = await appOn(await tmp(), { inviteCode: 'Öl-Pendler 26', limits: { inviteTries: 3 } });
  try {
    const get = async (d, code) => { const r = await fetch(`${base}/api/state`, { headers: hdr(d, code === undefined ? {} : { 'x-invite': encodeURIComponent(code) }) }); return { status: r.status, body: await r.json() }; };
    let r = await get('einladungsgeraet12345');
    assert.equal(r.status, 403); assert.equal(r.body.invite, true); assert.equal(r.body.wrong, false);
    r = await get('einladungsgeraet12345', 'falsch');
    assert.equal(r.status, 403); assert.equal(r.body.wrong, true);
    r = await get('einladungsgeraet12345', 'öl-pendler 26');                    // upper/lower case does not matter, umlaut survives the header
    assert.equal(r.status, 200); assert.ok(Array.isArray(r.body.tours));
    // devices that already exist (created before the invitation was switched on) need no code
    await store.update('altesgeraet123456789', () => {});
    assert.equal((await get('altesgeraet123456789')).status, 200);
    // guessing: after three wrong attempts there is a pause, even with the right code
    for (let k = 0; k < 3; k++) await get('ratergeraet1234567', `x${k}`);
    r = await get('ratergeraet1234567', 'Öl-Pendler 26');
    assert.equal(r.status, 429); assert.match(r.body.error, /falsche Codes/);
    // status and watchdog are public
    assert.equal((await fetch(`${base}/api/status`)).status, 200);
  } finally { server.close(); }
});

test('Without an invitation code (default) everything is open', async () => {
  const { server, base } = await appOn(await tmp());
  try { assert.equal((await fetch(`${base}/api/state`, { headers: hdr('offengeraet12345678') })).status, 200); } finally { server.close(); }
});

test('Responses under rate limiting carry the CORS headers of the app (otherwise the app only sees "Netzwerkfehler")', async () => {
  const { server, base } = await appOn(await tmp(), { inviteCode: 'abc' });
  try {
    const r = await fetch(`${base}/api/state`, { headers: hdr('corsgeraet1234567890', { origin: 'https://appassets.androidplatform.net' }) });
    assert.equal(r.status, 403); assert.equal(r.headers.get('access-control-allow-origin'), 'https://appassets.androidplatform.net');
    const pre = await fetch(`${base}/api/state`, { method: 'OPTIONS', headers: { origin: 'https://appassets.androidplatform.net', 'access-control-request-headers': 'x-invite' } });
    assert.match(pre.headers.get('access-control-allow-headers'), /x-invite/);
  } finally { server.close(); }
});
