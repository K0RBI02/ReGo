// New in 0.8.12: the error log on the device (public/js/rlog.js) and the error report that is written from it (public/js/report.js).
// Both are browser scripts; they run here in a small stand-in for the page (no real browser needed).
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const plain = (v) => JSON.parse(JSON.stringify(v));                 // the page lives in its own realm: arrays from there are compared as plain data
const src = (f) => readFile(new URL('../public/js/' + f, import.meta.url), 'utf8');
const storage = () => {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { m.set(k, String(v)); }, removeItem: (k) => { m.delete(k); }, key: (i) => [...m.keys()][i], get length() { return m.size; } };
};
/** A page with just enough for the scripts: storage, event listeners (kept so that a test can fire them), a few browser values. */
async function page(files, extra = {}) {
  const on = {}, ctx = {
    localStorage: storage(), sessionStorage: storage(), location: { pathname: '/Strecken' }, performance: { getEntriesByType: () => [], now: () => 0 },
    addEventListener: (t, fn) => { on[t] = fn; }, document: { addEventListener() {}, visibilityState: 'visible' },
    navigator: { userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36', onLine: true, language: 'de-DE' },
    screen: { width: 412, height: 915 }, innerWidth: 412, innerHeight: 800, devicePixelRatio: 2.6,
    TextEncoder, AbortSignal, btoa, Blob, URL, console, setTimeout, clearTimeout, ...extra,
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  for (const f of files) vm.runInContext(await src(f), ctx, { filename: f });
  return { win: ctx, on };
}

test('Error log: the same message counts up (also when others came in between), a different one is a new entry, the newest is last', async () => {
  const { win } = await page(['rlog.js']);
  win.RLOGE('net', '/state: keine Verbindung'); win.RLOGE('net', '/state: keine Verbindung'); win.RLOGE('net', '/state: keine Verbindung');
  win.RLOGE('server', '500 /state'); win.RLOGE('net', '/state: keine Verbindung'); win.RLOGE('net', '/stations: keine Verbindung');
  const e = win.RERRORS();
  assert.deepEqual(plain(e.map((x) => [x.k, x.m, x.n])), [['server', '500 /state', 1], ['net', '/state: keine Verbindung', 4], ['net', '/stations: keine Verbindung', 1]]);
  assert.ok(e[1].b >= e[1].a);
  win.RLOGE('server', '500 /state');
  assert.deepEqual(plain(win.RERRORS().map((x) => [x.m, x.n])), [['/state: keine Verbindung', 4], ['/stations: keine Verbindung', 1], ['500 /state', 2]]);
});

test('Error log: keeps the last 30 entries and forgets entries older than 14 days', async () => {
  const { win } = await page(['rlog.js']);
  for (let i = 0; i < 45; i++) win.RLOGE('js', 'Fehler Nummer ' + i);
  const e = win.RERRORS();
  assert.equal(e.length, 30);
  assert.equal(e[0].m, 'Fehler Nummer 15'); assert.equal(e[29].m, 'Fehler Nummer 44');
  const old = Date.now() - 15 * 864e5;
  win.localStorage.setItem('rego.errors', JSON.stringify([{ k: 'js', m: 'uralt', n: 1, a: old, b: old }, { k: 'js', m: 'frisch', n: 1, a: Date.now(), b: Date.now() }]));
  assert.deepEqual(plain(win.RERRORS().map((x) => x.m)), ['frisch']);
  win.localStorage.setItem('rego.errors', 'kaputt'); assert.deepEqual(plain(win.RERRORS()), []);          // damaged storage is no reason to fail
  win.RLOGE('js', 'nach dem Schaden'); assert.equal(win.RERRORS().length, 1);
});

test('Error log: what was typed and the device ID never get in (query strings, long codes with digits)', async () => {
  const { win } = await page(['rlog.js']);
  const device = 'a1b2c3d4e5f6g7h8i9j0k1l2';
  win.RLOGE('net', `Failed to parse URL from /api/stations?q=Marienplatz%20Nord&x=1 für Gerät ${device}`);
  win.RLOGE('js', 'Cannot read properties of undefined (reading \'name\') createImageBitmap rego-live.js:123');
  const all = JSON.stringify(win.RERRORS());
  assert.ok(!/Marienplatz/.test(all), 'typed stop name');
  assert.ok(!all.includes(device), 'device id');
  assert.match(all, /stations\?…/);
  assert.match(all, /createImageBitmap rego-live\.js:123/);                     // long words without digits stay readable
  win.RLOGE('js', '   '); win.RLOGE('js', ''); assert.equal(win.RERRORS().length, 2);   // nothing to say, no entry
  win.RLOGE('js', 'x'.repeat(500)); assert.ok(win.RERRORS().at(-1).m.length <= 140);
});

test('Error log: script errors and rejected promises are written down, a harmless browser message is not', async () => {
  const { win, on } = await page(['rlog.js']);
  on.error({ message: 'TypeError: x is not a function', filename: 'https://appassets.androidplatform.net/js/app.js?v=1', lineno: 77 });
  on.error({ message: 'ResizeObserver loop completed with undelivered notifications.', filename: '', lineno: 0 });
  on.unhandledrejection({ reason: new Error('HTTP 502') });
  on.unhandledrejection({ reason: 'einfach ein Text' });
  const e = win.RERRORS();
  assert.equal(e.length, 3);
  assert.equal(e[0].m, 'TypeError: x is not a function app.js:77');
  assert.equal(e[1].m, 'Promise: HTTP 502');
  assert.equal(e[2].m, 'Promise: einfach ein Text');
  assert.ok(win.RLOGS().some((l) => /FEHLER TypeError/.test(l)), 'the run log still gets the line as before');
});

// ---------- the report ----------

const STOPS = ['Marienplatz', 'Garching-Forschungszentrum', 'Fiktivia'];
const DEVICE = 'k3j9x0q1w2e3r4t5y6u7i8o9';
const rego = (o = {}) => ({
  deviceId: DEVICE, info: { app: '0.8.12', server: '0.8.12' }, connection: { status: 'offline', lastSync: '22:40' }, errorHint: 'keine Verbindung zum Server', outage: false,
  tours: [{ id: 't1', name: `${STOPS[0]} → ${STOPS[1]}`, active: true, departures: [{ t: 1 }] }, { id: 't2', name: `${STOPS[2]} → ${STOPS[0]}`, active: false, departures: [] }],
  incidents: [], tickets: [{ name: 'Mein Deutschlandticket', image: 'data:image/png;base64,AAAA' }], invite: { needed: false, wrong: false },
  position: { lat: '48.14', lon: '11.58' }, pushActive: () => true,
  api: async (path) => {
    if (path === '/status') return { version: '0.8.12', provider: 'efa', uptimeMin: 190, devices: 7, sources: [{ name: 'MVV', ok: true }, { name: 'DB', ok: false, pausedSec: 120 }], instantPush: true, time: new Date().toISOString() };
    if (path === '/health') return { ok: true, time: new Date(Date.now() - 42000).toISOString() };       // the clock of the phone is 42 s ahead
    throw new Error('?');
  },
  ...o,
});

test('Report: versions, state, server and errors – without stops, tickets, location, device model and device ID', async () => {
  const { win } = await page(['rlog.js', 'report.js'], { REGO: rego(), RegoNative: { saveFile: () => true } });
  win.RLOGE('net', '/state: keine Verbindung'); win.RLOGE('net', '/state: keine Verbindung');
  win.RLOGE('server', '502 /stations: Haltestellensuche gerade nicht erreichbar');
  win.RLOG('mount Strecken');
  const t = await win.REGO.report.build();
  for (const part of ['ReGo – Fehlerbericht', 'App und Gerät', 'Zustand der App', 'Server\n', 'Fehler auf diesem Gerät', 'Ablauf dieser Sitzung']) assert.ok(t.includes(part), part);
  assert.match(t, /App: +Android-App 0\.8\.12/); assert.match(t, /Server: +0\.8\.12/);
  assert.match(t, /System: +Android 14, WebView\/Chrome 130/); assert.match(t, /Bildschirm: +412×915/);
  assert.match(t, /Verbindung: +offline \(offline, zeigt den gespeicherten Stand\)/); assert.match(t, /Fehlerhinweis: +keine Verbindung zum Server/);
  assert.match(t, /Strecken: +2 \(1 aktiv, 1 mit Abfahrten\)/); assert.match(t, /Tickets: +1\b/); assert.match(t, /Push: +an/);
  assert.match(t, /Quellen: +MVV ok, DB FEHLER \(pausiert 120 s\)/); assert.match(t, /Version: +0\.8\.12, läuft seit 3 h 10 min/);
  assert.match(t, /Uhr des Geräts: +4\d s vor dem Server/);
  assert.match(t, /\d\d\.\d\d\. \d\d:\d\d:\d\d – \d\d:\d\d:\d\d \(2×\)  \[net\] \/state: keine Verbindung/); assert.match(t, /Erstellt: +\d\d\.\d\d\.20\d\d \d\d:\d\d:\d\d/); assert.match(t, /\[server\] 502 \/stations: Haltestellensuche/);
  assert.match(t, /mount Strecken/);
  for (const s of [...STOPS, 'Deutschlandticket', 'AAAA', '48.14', '11.58', 'Pixel', DEVICE]) assert.ok(!t.includes(s), `must not contain ${s}`);
});

test('Report: without a connection it is still written, quickly and with the reason', async () => {
  const offline = await page(['rlog.js', 'report.js'], { REGO: rego({ api: async () => { throw new Error('darf nicht gefragt werden'); } }) });
  offline.win.navigator.onLine = false;
  let t = await offline.win.REGO.report.build();
  assert.match(t, /Netz: +offline/); assert.match(t, /Status: +Gerät meldet: offline/);

  const down = await page(['rlog.js', 'report.js'], { REGO: rego({ api: async () => { throw Object.assign(new Error('x'), { status: 503 }); } }) });
  t = await down.win.REGO.report.build();
  assert.match(t, /Status: +Server antwortet mit 503/);

  const slow = await page(['rlog.js', 'report.js'], { REGO: rego({ api: async () => { throw Object.assign(new Error('x'), { name: 'TimeoutError' }); } }) });
  t = await slow.win.REGO.report.build();
  assert.match(t, /Status: +keine Antwort in 4 Sekunden/); assert.match(t, /Fehler auf diesem Gerät[^\n]*\n-+\n  keine/);
});

test('Report: in the app it goes to the Download folder as a text file, otherwise a failure is said and written down', async () => {
  const calls = [];
  const { win } = await page(['rlog.js', 'report.js'], { REGO: rego(), RegoNative: { saveFile: (name, mime, b64) => { calls.push({ name, mime, b64 }); return true; } } });
  assert.equal(await win.REGO.report.save(), true);
  assert.equal(calls.length, 1);
  assert.match(calls[0].name, /^rego-fehlerbericht-\d{8}-\d{4}\.txt$/); assert.equal(calls[0].mime, 'text/plain');
  const text = Buffer.from(calls[0].b64, 'base64').toString('utf8');
  assert.ok(text.startsWith('ReGo – Fehlerbericht\n'), 'umlauts and dashes survive');
  assert.ok(text.includes('läuft seit'));

  const bad = await page(['rlog.js', 'report.js'], { REGO: rego(), RegoNative: { saveFile: () => false } });
  assert.equal(await bad.win.REGO.report.save(), false);
  assert.deepEqual(plain(bad.win.RERRORS().map((x) => x.k)), ['app']);
  const broken = await page(['rlog.js', 'report.js'], { REGO: rego(), RegoNative: { saveFile: () => { throw new Error('Bridge weg'); } } });
  assert.equal(await broken.win.REGO.report.save(), false);
  const older = await page(['rlog.js', 'report.js'], { REGO: rego(), RegoNative: { saveFile: () => undefined } });         // an older app answers nothing
  assert.equal(await older.win.REGO.report.save(), true);
});
