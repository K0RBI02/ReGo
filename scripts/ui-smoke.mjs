// Bildschirmtest: startet ReGo mit Beispieldaten, öffnet jeden Screen im Handy-Format und prüft
// auf JavaScript-Fehler, blockierte Inhalte (CSP), fehlende Dateien und seitliches Scrollen.
// Aufruf: node scripts/ui-smoke.mjs   (braucht Playwright: npm i --no-save playwright && npx playwright install chromium)
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server/index.mjs';
import { config } from '../server/config.mjs';
import { addTours } from '../server/store/profile.mjs';
import { buildTour } from '../server/domain/state.mjs';
import { buildTransferTour, shortcutFor } from '../server/domain/transfer.mjs';
import { berlin, weekday, toMin } from '../server/lib/time.mjs';
import { readFileSync } from 'node:fs';

const pw = await import('playwright').catch(() => import('/opt/npm-tools/node_modules/playwright/index.mjs'));
// Grenzen hoch: der Test lädt viele Dateien in kurzer Zeit von einer Adresse (die Begrenzung selbst prüfen die Server-Tests)
const { server, store } = createApp({ cfg: { ...config, provider: 'mock', dataDir: await mkdtemp(join(tmpdir(), 'rego-ui-')), notifyEverySec: 0, limits: { ipBurst: 1e6, ipPerSec: 1e6, deviceBurst: 1e6, devicePerSec: 1e6, searchBurst: 1e6, searchPerSec: 1e6, newDevicesPerHour: 1e6 } } });
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
const DEV = 'uismoketest0123456789abcd';
const H = { 'x-device': DEV, 'content-type': 'application/json' };
const j = async (p, m = 'GET', b) => (await fetch(base + p, { method: m, headers: H, body: b ? JSON.stringify(b) : undefined })).json();
const st = (await j('/api/stations?q=Freising')).stations[0], mu = (await j('/api/stations?q=München')).stations[0];
await j('/api/tours', 'POST', { from: st, to: mu, roundTrip: true });

const browser = await pw.chromium.launch({ executablePath: process.env.PW_CHROMIUM || undefined, args: ['--no-sandbox'] });
const problems = [];
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
await ctx.addInitScript(([d]) => { try { if (!localStorage.getItem('rego.device')) { localStorage.setItem('rego.device', JSON.stringify(d)); localStorage.setItem('rego.onboarded', '1'); localStorage.setItem('rego.splashSeen', '1'); } } catch (e) {} }, [DEV]);
const page = await ctx.newPage();
page.setDefaultTimeout(8000);
let where = '';
let expect422 = false;                       // beim Anlegen ohne Direktverbindung ist die 422-Antwort gewollt
const ignore = (x) => expect422 && /422|\/api\/tours/.test(x);
page.on('pageerror', (e) => problems.push(`${where}: JavaScript-Fehler: ${e.message}`));
page.on('console', (m) => { if (m.type() === 'error' && !ignore(m.text())) problems.push(`${where}: Konsole: ${m.text().slice(0, 200)}`); });
page.on('requestfailed', (r) => { if (!ignore(r.url())) problems.push(`${where}: Anfrage fehlgeschlagen: ${r.url()}`); });
page.on('response', (r) => { if (r.status() >= 400 && !ignore(r.url())) problems.push(`${where}: HTTP ${r.status()} ${r.url()}`); });

for (const path of ['/', '/Meldungen', '/Strecken', '/Ticket', '/Scan', '/Onboarding1']) {
  where = path;
  await page.goto(base + path); await page.waitForTimeout(1500);
  if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1)) problems.push(`${path}: Seite scrollt seitlich`);
  if (!(await page.evaluate(() => document.body.innerText.trim().length))) problems.push(`${path}: Seite ist leer`);
}

// Strecke ändern: Zeit setzen, speichern, Server hat sie
where = 'Strecke ändern';
await page.goto(base + '/Strecken'); await page.waitForTimeout(1200);
await page.getByRole('button', { name: /ändern$/ }).first().click();
await page.locator('input[type=time]').first().fill('06:45');
await page.getByRole('button', { name: 'Speichern' }).click(); await page.waitForTimeout(800);
const tours = (await j('/api/profile')).tours;
if (!tours.some((t) => t.schedule.departAfter === '06:45')) problems.push('Strecke ändern: Zeit wurde nicht gespeichert');

// Ticket sichern: Datei kommt
where = 'Ticket sichern';
await page.evaluate(() => { localStorage.setItem('rego.tickets', JSON.stringify([{ id: 'dt', slot: 'dt', name: 'Deutschlandticket', validUntil: '01.01.2020', image: 'data:image/png;base64,iVBORw0KGgo=', original: '', payload: '', format: '' }])); });
await page.goto(base + '/Ticket'); await page.waitForTimeout(1200);
if (!(await page.getByText('abgelaufen').count())) problems.push('Ticket: abgelaufenes Ticket ist nicht markiert');
const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 4000 }).catch(() => null), page.getByRole('button', { name: 'Tickets sichern' }).click()]);
if (!dl) problems.push('Ticket sichern: keine Datei erzeugt');

// ---------- Fälle aus der großen Prüfung (0.5.0) ----------
// Jeder Fall läuft für sich; scheitert eine Bedienung, wird das als Fund gemeldet statt den ganzen Test abzubrechen.
// SMOKE_ONLY=<Teil des Namens> führt nur passende Fälle aus (zum Nachbessern eines einzelnen Falls)
const check = async (name, fn) => { if (process.env.SMOKE_ONLY && !name.includes(process.env.SMOKE_ONLY)) return; where = name; try { await fn(); } catch (e) { problems.push(`${name}: ${String(e.message).split('\n').slice(0, 2).join(' ')}`); } };
const suggest = async (n, text) => { const i = page.locator('input[type=text]').nth(n); await i.click(); await i.pressSequentially(text, { delay: 40 }); await page.waitForTimeout(1400); await page.getByRole('option').first().click(); };

// Doppeltipp auf „Speichern“: Hin- und Rückweg nur einmal. Die Pendelzeit wird dabei von Hand getippt (05:30), weil der Server dieselbe Strecke mit denselben
// Zeiten nicht noch einmal anlegt (die Strecke vom Anfang hat die Standardzeit 07:00–08:00).
await check('Doppeltipp', async () => {
  const before = (await j('/api/profile')).tours.length;
  await page.goto(base + '/Strecken'); await page.waitForTimeout(1000);
  await page.getByRole('button', { name: /Strecke hinzufügen/ }).click();
  await suggest(0, 'Freis'); await suggest(1, 'Münch');
  await page.locator('input[type=time]').nth(0).fill('05:30'); await page.locator('input[type=time]').nth(1).fill('06:30');
  await page.evaluate(() => { const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === 'Speichern'); b.click(); b.click(); });
  await page.waitForTimeout(1500);
  const tours = (await j('/api/profile')).tours, added = tours.length - before;
  if (added !== 2) problems.push(`Doppeltipp: ${added} Strecken angelegt statt 2 (Hin + Rück)`);
  const hin = tours.find((t) => t.schedule.departAfter === '05:30');
  if (!hin || hin.schedule.departUntil !== '06:30') problems.push(`Doppeltipp: Hinweg hat nicht die getippte Pendelzeit 05:30–06:30 (${hin ? hin.schedule.departAfter + '–' + hin.schedule.departUntil : 'fehlt'})`);
});

// Pendelzeit (0.7.2): je Richtung zwei Schieber (Hinweg 04–12 Uhr, Rückweg 12–20 Uhr, in Viertelstunden), auch per Tastatur und mit getippten Uhrzeiten bedienbar.
// Die Griffe überholen sich nicht (mindestens 10 Minuten Abstand); beim Ändern einer Strecke wird die Pendelzeit gespeichert und in der Liste gezeigt.
await check('Pendelzeit', async () => {
  const slider = (name) => page.getByRole('slider', { name });
  const read = (n) => page.locator('input[type=time]').nth(n).inputValue();
  const press = async (loc, key, n) => { await loc.focus(); for (let i = 0; i < n; i++) await page.keyboard.press(key); await page.waitForTimeout(150); };
  const dims = async () => (await page.locator('input[type=range]').evaluateAll((els) => els.map((e) => [e.min, e.max, e.step, e.value].join('/')))).join(' ');
  const expect = async (label, got, want) => { const g = await got; if (g !== want) problems.push(`Pendelzeit: ${label}: „${g}“ statt „${want}“`); };
  await page.goto(base + '/Strecken'); await page.waitForTimeout(1000);
  await page.getByRole('button', { name: /Strecke hinzufügen/ }).click(); await page.waitForTimeout(400);
  await expect('Schieber im neuen Formular (min/max/Schritt/Wert)', dims(), '240/720/15/420 240/720/15/480 720/1200/15/990 720/1200/15/1050');
  await expect('Uhrzeiten im neuen Formular', Promise.all([0, 1, 2, 3].map(read)).then((a) => a.join(' ')), '07:00 08:00 16:30 17:30');
  // Tastatur: zwei Viertelstunden früher; weiter als bis kurz vor das Ende geht es nicht
  await press(slider('Hinweg: Früheste Abfahrt'), 'ArrowLeft', 2);
  await expect('früheste Abfahrt nach zweimal ←', read(0), '06:30');
  await press(slider('Hinweg: Früheste Abfahrt'), 'ArrowRight', 30);
  await expect('früheste Abfahrt am Anschlag', Promise.all([read(0), read(1)]).then((a) => a.join(' ')), '07:45 08:00');
  await press(slider('Hinweg: Späteste Abfahrt'), 'ArrowLeft', 30);
  await expect('späteste Abfahrt bleibt vor dem Beginn', read(1), '08:00');
  await press(slider('Hinweg: Späteste Abfahrt'), 'ArrowRight', 4);
  await expect('späteste Abfahrt nach viermal →', read(1), '09:00');
  // Uhrzeit tippen: liegt der Beginn hinter dem Ende, rückt das Ende mit (die Länge bleibt); ein Ende nach 12 Uhr weitet den Schieber
  await page.locator('input[type=time]').nth(0).fill('10:00');
  await expect('Beginn hinter dem Ende schiebt das Ende mit', Promise.all([read(0), read(1)]).then((a) => a.join(' ')), '10:00 11:15');
  await page.locator('input[type=time]').nth(1).fill('13:00');
  await expect('Schieber nach getipptem Ende 13:00', dims().then((d) => d.split(' ').slice(0, 2).join(' ')), '240/780/15/600 240/780/15/780');
  await page.locator('input[type=time]').nth(1).fill('09:00');
  await expect('Ende vor dem Beginn zieht den Beginn mit', Promise.all([read(0), read(1)]).then((a) => a.join(' ')), '06:00 09:00');
  await expect('Schieber geht nach dem Kürzen zurück auf 04–12 Uhr', dims().then((d) => d.split(' ').slice(0, 2).join(' ')), '240/720/15/360 240/720/15/540');
  // Rückweg: eigener Bereich ab 12 Uhr, eine Viertelstunde früher
  await press(slider('Rückweg: Früheste Abfahrt'), 'ArrowLeft', 1);
  await expect('Rückweg früheste Abfahrt', read(2), '16:15');
  if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1)) problems.push('Pendelzeit: Formular scrollt seitlich');
  await page.getByRole('button', { name: 'Abbrechen' }).click(); await page.waitForTimeout(400);
  // Strecke ändern (eigene Strecke mit eigener Zeit, damit die Reihenfolge der Liste keine Rolle spielt): eine Karte; Ende eine Viertelstunde später, speichern, Server und Liste haben es
  const ing = (await j('/api/stations?q=Ingolstadt')).stations[0];
  const mine = (await j('/api/tours', 'POST', { from: mu, to: ing, schedule: { days: ['Mo', 'Di', 'Mi', 'Do', 'Fr'], departAfter: '05:00', departUntil: '06:00' } })).tours[0];
  try {
    await page.goto(base + '/Strecken'); await page.waitForTimeout(1000);
    await page.getByRole('button', { name: `${mine.name} ändern`, exact: true }).click(); await page.waitForTimeout(500);
    if ((await page.locator('input[type=range]').count()) !== 2) problems.push('Pendelzeit: Strecke ändern zeigt nicht genau zwei Schieber');
    await expect('Uhrzeiten beim Ändern', Promise.all([read(0), read(1)]).then((a) => a.join(' ')), '05:00 06:00');
    await press(slider('Späteste Abfahrt'), 'ArrowRight', 1);
    await expect('späteste Abfahrt beim Ändern', read(1), '06:15');
    await page.getByRole('button', { name: 'Speichern' }).click(); await page.waitForTimeout(900);
    const sch = (await j('/api/profile')).tours.find((t) => t.id === mine.id).schedule;
    if (sch.departAfter !== '05:00' || sch.departUntil !== '06:15') problems.push(`Pendelzeit: gespeichert ${sch.departAfter}–${sch.departUntil} statt 05:00–06:15`);
    const list = await page.evaluate(() => document.querySelector('#screen').innerText);
    if (!list.includes('Mo–Fr · 05:00–06:15')) problems.push('Pendelzeit: Streckenliste zeigt „Mo–Fr · 05:00–06:15“ nicht');
  } finally { await fetch(base + '/api/tours/' + mine.id, { method: 'DELETE', headers: H }); }
});

// Rückgängig: Koordinaten bleiben erhalten
await check('Rückgängig', async () => {
  const before = (await j('/api/profile')).tours;
  await page.goto(base + '/Strecken'); await page.waitForTimeout(1000);
  await page.getByRole('button', { name: /entfernen$/ }).first().click(); await page.waitForTimeout(900);
  if ((await j('/api/profile')).tours.length !== before.length - 1) problems.push('Entfernen: Strecke ist noch auf dem Server');
  await page.getByRole('button', { name: 'Rückgängig' }).click(); await page.waitForTimeout(1000);
  const after = (await j('/api/profile')).tours;
  if (after.length !== before.length) problems.push(`Rückgängig: ${after.length} statt ${before.length} Strecken`);
  const key = (t) => `${t.id}:${t.from.lat}:${t.from.lon}:${t.to.lat}:${t.to.lon}`;
  if (before.map(key).sort().join() !== after.map(key).sort().join()) problems.push('Rückgängig: Koordinaten der Haltestellen gingen verloren');
});

// Aktualisieren, während gerade eine (alte) Abfrage läuft: neue Strecke darf nicht untergehen
await check('Aktualisieren während Anlegen', async () => {
  await page.goto(base + '/'); await page.waitForTimeout(1200);
  await page.evaluate(async () => { const R = window.REGO; R.searchStations('Freising'); await new Promise((r) => setTimeout(r, 900)); R.searchStations('München Hbf'); await new Promise((r) => setTimeout(r, 900)); });
  let first = true;
  await page.route('**/api/state**', async (route) => {
    if (!first) return route.continue();
    first = false; const old = await route.fetch(); await new Promise((r) => setTimeout(r, 1500)); await route.fulfill({ response: old });   // alter Stand kommt verspätet an
  });
  const [n0, n1] = await page.evaluate(async () => {
    const R = window.REGO, n0 = R.tours.length, slow = R.refresh();
    await new Promise((r) => setTimeout(r, 250));
    await R.actions.addTour({ from: 'Freising', to: 'München Hbf', days: ['Sa'], time: '09:00', trip: 'one', backTime: '16:30' });
    await slow; return [n0, R.tours.length];
  });
  await page.unroute('**/api/state**');
  if (n1 !== n0 + 1) problems.push(`Aktualisieren: ${n1} statt ${n0 + 1} Strecken in der Oberfläche (alter Stand überschreibt)`);
});

// Neues Handy: vorhandene Strecken erst nach Rückfrage ersetzen
await check('Code übernehmen', async () => {
  const OTHER = { 'x-device': 'smokeother0123456789abcd', 'content-type': 'application/json' };
  await fetch(base + '/api/tours', { method: 'POST', headers: OTHER, body: JSON.stringify({ from: st, to: mu }) });
  const { code } = await (await fetch(base + '/api/transfer', { method: 'POST', headers: OTHER, body: '{}' })).json();
  const mine = (await j('/api/profile')).tours.length;
  await page.goto(base + '/Strecken#einstellungen'); await page.waitForTimeout(1000);
  await page.getByRole('button', { name: /Neues Handy/ }).click();
  await page.getByPlaceholder('Code eingeben').fill(code);
  await page.getByRole('button', { name: 'Übernehmen' }).click(); await page.waitForTimeout(500);
  if (!(await page.getByText('werden durch die vom alten Handy ersetzt').count())) problems.push('Code übernehmen: keine Rückfrage');
  if ((await j('/api/profile')).tours.length !== mine) problems.push('Code übernehmen: Strecken wurden ohne Rückfrage ersetzt');
  await page.getByRole('button', { name: 'Ja, ersetzen' }).click(); await page.waitForTimeout(1200);
  if ((await j('/api/profile')).tours.length !== 1) problems.push('Code übernehmen: Strecken wurden nach Bestätigung nicht übernommen');
  if (!(await page.getByRole('switch', { name: 'Push-Meldungen' }).count())) problems.push('Strecken: Schalter „Push-Meldungen“ fehlt');
});

// Kleines Handy (320 × 568): Karte nicht abgeschnitten, Onboarding erreichbar
await check('kleines Handy', async () => {
  const small = await browser.newContext({ viewport: { width: 320, height: 568 }, isMobile: true, hasTouch: true });
  await small.addInitScript(([d]) => { try { if (!localStorage.getItem('rego.device')) { localStorage.setItem('rego.device', JSON.stringify(d)); localStorage.setItem('rego.onboarded', '1'); localStorage.setItem('rego.splashSeen', '1'); } } catch (e) {} }, [DEV]);
  const sp = await small.newPage();
  const tourId = (await j('/api/profile')).tours[0].id;
  await sp.goto(base + '/Detail#' + tourId + '-m'); await sp.waitForTimeout(1800);
  const cut = await sp.evaluate(() => [...document.querySelectorAll('span')].filter((e) => /rotate\(-45deg\)/.test(e.getAttribute('style') || '') && e.textContent.trim()).filter((e) => e.getBoundingClientRect().right > innerWidth + 1).map((e) => e.textContent));
  if (cut.length) problems.push(`Karte (320 px): Beschriftung ragt über den Rand: ${cut.join(', ')}`);
  await sp.goto(base + '/Onboarding1'); await sp.waitForTimeout(1200);
  const oy = await sp.evaluate(() => getComputedStyle(document.querySelector('#screen > div')).overflowY);
  if (oy !== 'auto') problems.push(`Onboarding (320 × 568): Seite kann nicht scrollen (overflow-y: ${oy})`);
  // Pendelzeit (Schieber und Uhrzeiten): nichts ragt über den Rand, die Seite scrollt nicht seitlich – im Onboarding und im Formular „Neue Strecke“
  const outside = () => sp.evaluate(() => [...document.querySelectorAll('input[type=time], input[type=range], .rg-knob')].filter((e) => { const r = e.getBoundingClientRect(); return r.width && (r.left < -1 || r.right > innerWidth + 1); }).length);
  const wide = () => sp.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1);
  if (!(await sp.locator('input[type=range]').count())) problems.push('Onboarding (320 × 568): keine Schieber für die Pendelzeit');
  if (await outside() || await wide()) problems.push('Onboarding (320 × 568): Schieber oder Uhrzeiten ragen über den Rand');
  await sp.goto(base + '/Strecken'); await sp.waitForTimeout(1000);
  await sp.getByRole('button', { name: /Strecke hinzufügen/ }).click(); await sp.waitForTimeout(500);
  if (await outside() || await wide()) problems.push('Neue Strecke (320 × 568): Schieber oder Uhrzeiten ragen über den Rand');
  await small.close();
});

// Dunkelmodus: Satz unter der Streckenliste und Einstellungs-Sheet lesbar (Kontrast Text gegen Untergrund)
await check('Dunkelmodus', async () => {
  const dark = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, colorScheme: 'dark' });
  await dark.addInitScript(([d]) => { try { if (!localStorage.getItem('rego.device')) { localStorage.setItem('rego.device', JSON.stringify(d)); localStorage.setItem('rego.onboarded', '1'); localStorage.setItem('rego.splashSeen', '1'); } } catch (e) {} }, [DEV]);
  const dp = await dark.newPage();
  const contrast = (items) => dp.evaluate((items) => {
    const lum = (c) => { const m = c.match(/\d+(\.\d+)?/g).map(Number).slice(0, 3).map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return 0.2126 * m[0] + 0.7152 * m[1] + 0.0722 * m[2]; };
    return items.map(([tag, label]) => {
      const el = [...document.querySelectorAll(tag)].find((x) => x.textContent.trim() === label);
      if (!el) return [label, 0];
      let bgEl = el; while (bgEl && /rgba\(0, 0, 0, 0\)|transparent/.test(getComputedStyle(bgEl).backgroundColor)) bgEl = bgEl.parentElement;
      const a = lum(getComputedStyle(el).color), b = lum(getComputedStyle(bgEl).backgroundColor);
      return [label, (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)];
    });
  }, items);
  const verdict = (where, rows) => { for (const [label, ratio] of rows) if (ratio < 4.5) problems.push(`Dunkelmodus: ${where} „${label}“ schlecht lesbar${ratio ? ` (Kontrast ${ratio.toFixed(1)}:1)` : ' (nicht gefunden)'}`); };
  await dp.goto(base + '/Strecken'); await dp.waitForTimeout(1500);
  verdict('Streckenliste', await contrast([['button', 'Push, neues Handy und Rückmeldung findest du in den Einstellungen'], ['span', 'Einstellungen']]));
  await dp.getByRole('button', { name: /Einstellungen/ }).first().click(); await dp.waitForTimeout(450);
  await dp.getByRole('button', { name: /Neues Handy/ }).click(); await dp.waitForTimeout(300);
  verdict('Einstellungen', await contrast([['h2', 'Einstellungen'], ['span', 'Push-Meldungen'], ['span', 'Push ab Verspätung von'], ['span', 'Testmeldung'], ['span', 'Neues Handy?'], ['button', 'Code erzeugen'], ['span', 'Rückmeldung senden']]));
  // das Sheet hebt sich vom abgedunkelten Untergrund ab (nicht dieselbe Fläche wie die Seite dahinter)
  const same = await dp.evaluate(() => { const d = document.querySelector('[role=dialog]'), r = document.querySelector('#screen > div'); return !d || getComputedStyle(d).backgroundColor === getComputedStyle(r).backgroundColor; });
  if (same) problems.push('Dunkelmodus: Einstellungen-Sheet hat dieselbe Fläche wie die Seite dahinter');
  // Pendelzeit im Formular „Neue Strecke“: Uhrzeiten lesbar, Griffe und Balken heben sich von der Karte ab (beide Karten: dunkel und orange)
  await dp.goto(base + '/Strecken'); await dp.waitForTimeout(1200);
  await dp.getByRole('button', { name: /Strecke hinzufügen/ }).click(); await dp.waitForTimeout(500);
  const pz = await dp.evaluate(() => {
    const lum = (c) => { const m = c.match(/\d+(\.\d+)?/g).map(Number).slice(0, 3).map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return 0.2126 * m[0] + 0.7152 * m[1] + 0.0722 * m[2]; };
    const bgOf = (el) => { let b = el; while (b && /rgba\(0, 0, 0, 0\)|transparent/.test(getComputedStyle(b).backgroundColor)) b = b.parentElement; return b ? getComputedStyle(b).backgroundColor : 'rgb(255, 255, 255)'; };
    const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
    const rows = [];
    for (const el of document.querySelectorAll('input[type=time]')) rows.push([`Uhrzeit ${el.value}`, ratio(getComputedStyle(el).color, bgOf(el)), 4.5]);
    for (const el of document.querySelectorAll('.rg-knob')) rows.push(['Griff', ratio(getComputedStyle(el).backgroundColor, bgOf(el.parentElement)), 3]);
    for (const el of document.querySelectorAll('.rg-fill')) rows.push(['Balken', ratio(getComputedStyle(el).backgroundColor, bgOf(el.parentElement)), 3]);
    return rows;
  });
  if (pz.length < 10) problems.push(`Dunkelmodus: Pendelzeit-Formular unvollständig (${pz.length} Teile gefunden)`);
  for (const [label, r, need] of pz) if (r < need) problems.push(`Dunkelmodus: Pendelzeit „${label}“ schlecht zu erkennen (Kontrast ${r.toFixed(1)}:1)`);
  await dark.close();
});

// Verspätung + Ersatzverkehr auf derselben Strecke: zwei Karten in „Meldungen“, eine gemeinsame Streckenseite, die angetippte oben
await check('Mehrere Meldungen einer Strecke', async () => {
  const sa = (await j('/api/stations?q=Salzburg')).stations[0];
  await j('/api/tours', 'POST', { from: mu, to: sa });
  const tour = (await j('/api/profile')).tours.find((t) => t.from.id === mu.id && t.to.id === sa.id);
  const incs = (await j('/api/state')).incidents.filter((i) => i.tourId === tour.id);
  const kinds = incs.map((i) => i.kind).sort().join();
  if (kinds !== 'delay,replacement') throw new Error(`Beispieldaten liefern ${kinds || 'nichts'} statt Verspätung + Ersatzverkehr`);
  await page.goto(base + '/Meldungen'); await page.waitForTimeout(1200);
  const cards = page.locator(`a[href^="Detail.dc.html#${tour.id}-l-"]`);
  if ((await cards.count()) !== 2) problems.push(`Meldungen: ${await cards.count()} Karten für die Strecke statt 2 (eine je Meldung)`);
  const order = async () => { const t = await page.evaluate(() => document.body.innerText); return [t.indexOf('Verspätung ·'), t.indexOf('Ersatzverkehr ·')]; };
  await cards.filter({ hasText: 'Verspätung' }).first().click(); await page.waitForTimeout(1200);
  let [d, e] = await order();
  if (!(page.url().includes('/Detail#' + tour.id + '-l-'))) problems.push('Meldungen: Karte führt nicht auf die Streckenseite');
  if (d < 0 || e < 0 || d > e) problems.push('Streckenseite: angetippte Verspätung steht nicht oben oder die zweite Meldung fehlt');
  await page.goto(base + '/Meldungen'); await page.waitForTimeout(800);
  await page.locator(`a[href^="Detail.dc.html#${tour.id}-l-"]`).filter({ hasText: 'Ersatzverkehr' }).first().click(); await page.waitForTimeout(1200);
  [d, e] = await order();
  if (d < 0 || e < 0 || e > d) problems.push('Streckenseite: angetippter Ersatzverkehr steht nicht oben oder die zweite Meldung fehlt');
  // Zahl am Meldungs-Knopf = Anzahl der Karten unter „Meldungen“
  await page.goto(base + '/Meldungen'); await page.waitForTimeout(800);
  const nCards = await page.locator('a[href^="Detail.dc.html#"]').count();
  await page.goto(base + '/'); await page.waitForTimeout(1200);
  const badge = await page.evaluate(() => { const b = [...document.querySelectorAll('span')].find((x) => /D4001A|rgb\(212, 0, 26\)/i.test(x.getAttribute('style') || '') && /^\d+$/.test(x.textContent.trim())); return b ? Number(b.textContent) : 0; });
  if (badge !== nCards) problems.push(`Zahl am Meldungs-Knopf (${badge}) passt nicht zu den ${nCards} Karten unter „Meldungen“`);
  // Eine Meldung, die es nicht mehr gibt (alte Push-Meldung): ehrliche Anzeige, nichts von einer fremden Strecke
  await page.goto(base + '/Detail#iunbekannt1-m'); await page.waitForTimeout(1200);
  const gone = await page.evaluate(() => document.body.innerText);
  if (!/Beendet/.test(gone) || /RE 5|S1|Freising/.test(gone)) problems.push('Streckenseite: unbekannte Meldung zeigt keine ehrliche Anzeige');
});

// Strecke ohne Direktverbindung (Beispieldaten: Freising → Salzburg gibt es nicht): ehrliche Anzeige statt „Alles pünktlich“, die Strecke bleibt sichtbar
await check('Strecke ohne Direktverbindung (bestehend)', async () => {
  const sa = (await j('/api/stations?q=Salzburg')).stations[0];
  const mk = async (dev) => {
    const c = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    await c.addInitScript(([d]) => { try { if (!localStorage.getItem('rego.device')) { localStorage.setItem('rego.device', JSON.stringify(d)); localStorage.setItem('rego.onboarded', '1'); localStorage.setItem('rego.splashSeen', '1'); } } catch (e) {} }, [dev]);
    // Neu anlegen lehnt der Server seit 0.6.0 ab (422); Strecken aus älteren Versionen oder nach einer Fahrplanänderung gibt es aber weiter
    const post = (to) => store.update(dev, (p) => { addTours(p, { from: st, to }); });
    return { c, post, pg: await c.newPage() };
  };
  const text = (pg) => pg.evaluate(() => document.querySelector('#screen').innerText);
  // A: nur die Strecke ohne Direktverbindung
  const a = await mk('smokeleera0123456789abcd');
  await a.post(sa);
  await a.pg.goto(base + '/'); await a.pg.waitForTimeout(1800);
  let t = await text(a.pg);
  if (/Alles pünktlich|Pünktlich/.test(t)) problems.push('Ohne Direktverbindung: Hauptbildschirm sagt „pünktlich“');
  if (!/Nächste Abfahrt/.test(t) || !/Keine Direktverbindung/.test(t)) problems.push('Ohne Direktverbindung: Hauptbildschirm erklärt nicht, warum es keine Abfahrt gibt');
  if (/ · \s*(\n|$)|\s·\s*·/.test(t)) problems.push('Ohne Direktverbindung: hängender Trennpunkt im Hauptbildschirm');
  await a.pg.goto(base + '/Strecken'); await a.pg.waitForTimeout(1200);
  t = await text(a.pg);
  if (!/Keine Direktverbindung/.test(t)) problems.push('Ohne Direktverbindung: Streckenliste hat keinen Hinweis');
  const tid = (await (await fetch(base + '/api/profile', { headers: { 'x-device': 'smokeleera0123456789abcd' } })).json()).tours[0].id;
  await a.pg.goto(base + '/Detail#' + tid + '-m'); await a.pg.waitForTimeout(1500);
  t = await text(a.pg);
  if (/Beendet|nicht mehr aktuell/.test(t)) problems.push('Ohne Direktverbindung: Detailseite sagt „Beendet“');
  if (!/Keine Direktverbindung/.test(t)) problems.push('Ohne Direktverbindung: Detailseite erklärt nichts');
  const dot = await a.pg.evaluate(() => [...document.querySelectorAll('span')].filter((e) => /min-width: 34px/.test(e.getAttribute('style') || '') && getComputedStyle(e).display !== 'none' && !e.textContent.trim()).length);
  if (dot) problems.push('Ohne Direktverbindung: Detailseite zeigt einen leeren Linienpunkt');
  await a.c.close();
  // B: normale Strecke zuerst, die ohne Direktverbindung bleibt trotzdem in der Liste auf dem Hauptbildschirm
  const b = await mk('smokeleerb0123456789abcd');
  await b.post(mu); await b.post(sa);
  await b.pg.goto(base + '/'); await b.pg.waitForTimeout(1800);
  t = await text(b.pg);
  if (!/Salzburg/.test(t) || !/keine Abfahrt/.test(t)) problems.push('Ohne Direktverbindung: Strecke fehlt in der Liste des Hauptbildschirms');
  await b.c.close();
});

// Schrift: Instrument Sans kommt vom eigenen Server (beide Schnitte laden, kein Fehler)
await check('Schrift', async () => {
  await page.goto(base + '/'); await page.waitForTimeout(1200);
  const faces = await page.evaluate(async () => {
    const fs = [...document.fonts].filter((x) => x.family.replace(/["']/g, '') === 'Instrument Sans');
    await Promise.all(fs.map((f) => f.load().catch(() => null)));
    return fs.map((f) => `${f.weight}:${f.status}`);
  });
  if (faces.length !== 2 || faces.some((f) => !f.endsWith(':loaded'))) problems.push(`Schrift: Instrument Sans nicht geladen (${faces.join(', ') || 'keine Schnitte'})`);
});


// ---------- Neu in 0.6.0 ----------
const NEW_CTX = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true };
const initFor = (extra = '') => ([d]) => { try { localStorage.setItem('rego.device', JSON.stringify(d)); localStorage.setItem('rego.onboarded', '1'); localStorage.setItem('rego.splashSeen', '1'); } catch (e) {} };
// Steht das Symbol neben der großen Zeile (gleiche Reihe, innerhalb der Karte) und nicht darunter? sel = Karte, svg = Symbol darin
const beside = (pg, sel, svgSel = 'svg') => pg.evaluate(([sel, svgSel]) => {
  // sel = null: Karte ist das Elternelement des Symbols (Detailseite)
  const svg0 = sel ? null : document.querySelector(svgSel), a = sel ? document.querySelector(sel) : svg0 && svg0.parentElement;
  const svg = sel ? a && a.querySelector(svgSel) : svg0, col = a && a.firstElementChild;
  if (!svg || !col) return false;
  const s = svg.getBoundingClientRect(), c = col.getBoundingClientRect(), r = a.getBoundingClientRect();
  return s.top < c.bottom - 4 && s.left >= c.right - 2 && s.right <= r.right + 1;
}, [sel, svgSel]);

// Neue Strecke ohne Direktverbindung (T2): wird nicht angelegt, der Grund steht im Formular, Ändern der Haltestelle blendet ihn aus
await check('Anlegen ohne Direktverbindung', async () => {
  expect422 = true;
  try {
  const before = (await j('/api/profile')).tours.length;
  await page.goto(base + '/Strecken'); await page.waitForTimeout(1000);
  await page.getByRole('button', { name: /Strecke hinzufügen/ }).click();
  await suggest(0, 'Freis'); await suggest(1, 'Salzb');
  await page.getByRole('button', { name: 'Speichern' }).click(); await page.waitForTimeout(1200);
  const alert = page.getByRole('alert').filter({ hasText: 'keine Direktverbindung gefunden' });
  if (!(await alert.count())) problems.push('Anlegen ohne Direktverbindung: keine Erklärung im Formular');
  if (!(await page.getByRole('button', { name: 'Abbrechen' }).count())) problems.push('Anlegen ohne Direktverbindung: Formular wurde geschlossen');
  if ((await j('/api/profile')).tours.length !== before) problems.push('Anlegen ohne Direktverbindung: Strecke wurde trotzdem angelegt');
  const to = page.locator('input[type=text]').nth(1); await to.fill('');
  await to.pressSequentially('Münch', { delay: 40 }); await page.waitForTimeout(900);
  if (await alert.count()) problems.push('Anlegen ohne Direktverbindung: Erklärung bleibt nach Ändern der Haltestelle stehen');
  if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1)) problems.push('Anlegen ohne Direktverbindung: Seite scrollt seitlich');
  } finally { expect422 = false; }
});

// Testmeldung und Versionszeile unter „Strecken“. Die Android-Brücke wird vorgetäuscht, damit Push als „an“ gilt.
await check('Testmeldung und Versionszeile', async () => {
  const ver = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
  await j('/api/push/native', 'PUT', {});
  const c = await browser.newContext(NEW_CTX);
  await c.addInitScript(([d]) => { try { localStorage.setItem('rego.device', JSON.stringify(d)); localStorage.setItem('rego.onboarded', '1'); localStorage.setItem('rego.splashSeen', '1'); localStorage.setItem('rego.push', 'true'); } catch (e) {} window.RegoNative = { appVersion: () => '9.9.9', enablePush() {}, disablePush() {}, setBars() {}, setBrightness() {}, keepScreenOn() {}, saveFile() {} }; }, [DEV]);
  const p = await c.newPage(); p.setDefaultTimeout(8000);
  try {
    await p.goto(base + '/Strecken#einstellungen'); await p.waitForTimeout(1500);
    const text = await p.evaluate(() => document.querySelector('#screen').innerText);
    if (!text.includes(`App 9.9.9 · Server ${ver}`)) problems.push(`Versionszeile: erwartet „App 9.9.9 · Server ${ver}“, gefunden: ${(text.match(/(App [^\n]*)?Server [^\n]*/) || ['nichts'])[0]}`);
    for (const [href, label] of [['https://github.com/K0RBI02/ReGo/blob/main/PRIVACY.md', 'Datenschutz'], ['https://github.com/K0RBI02/ReGo', 'ReGo auf GitHub']]) {
      const a = p.locator(`a[href="${href}"]`);
      if (!(await a.count()) || (await a.getAttribute('target')) !== '_blank' || !(await a.innerText()).includes(label)) problems.push(`Versionszeile: Link „${label}“ fehlt oder öffnet nicht in neuem Fenster`);
    }
    if (!/Prüft, ob Meldungen bei dir ankommen/.test(text)) problems.push('Testmeldung: Hinweistext bei eingeschaltetem Push fehlt');
    await p.getByRole('button', { name: 'Senden' }).click(); await p.waitForTimeout(1000);
    if (!(await p.getByText('Testmeldung angefordert').count())) problems.push('Testmeldung: keine Rückmeldung nach dem Tippen');
    const got = (await j('/api/notifications')).notifications;
    if (!got.some((n) => n.kind === 'test' && n.title === 'ReGo Testmeldung')) problems.push('Testmeldung: Server hat keine Testmeldung bereitgelegt');
    // Push aus (ohne App-Brücke): Knopf ausgegraut, Hinweis sagt was zu tun ist
    const q = await browser.newContext(NEW_CTX); await q.addInitScript(initFor(), [DEV]);
    const pq = await q.newPage(); await pq.goto(base + '/Strecken#einstellungen'); await pq.waitForTimeout(1200);
    const off = await pq.evaluate(() => { const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === 'Senden'); return b ? b.getAttribute('aria-disabled') : 'fehlt'; });
    if (off !== 'true') problems.push(`Testmeldung: Knopf ist ohne Push nicht gesperrt (aria-disabled=${off})`);
    if (!(await pq.getByText('Schalte zuerst Push-Meldungen ein').count())) problems.push('Testmeldung: Hinweis „Schalte zuerst Push-Meldungen ein“ fehlt');
    await q.close();
  } finally { await c.close(); }
});

// Pendelzeit auf dem Hauptbildschirm: Die Strecke, deren Fenster gerade läuft, steht oben (auch wenn sie später angelegt wurde); eine Strecke, die heute nicht
// gependelt wird, zeigt trotzdem ihre nächsten Züge. Liegt das Fenster noch weit weg, steht dort „planmäßig“ statt „pünktlich“.
await check('Pendelzeit auf dem Hauptbildschirm', async () => {
  const now = Date.now(), nowMin = toMin(berlin(now).time), today = weekday(now), ALL = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'];
  const hm = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
  const screen = async (dev) => {
    const c = await browser.newContext(NEW_CTX); await c.addInitScript(initFor(), [dev]);
    const pg = await c.newPage(); pg.setDefaultTimeout(8000);
    try { await pg.goto(base + '/'); await pg.waitForTimeout(1800); return await pg.evaluate(() => document.querySelector('#screen').innerText); } finally { await c.close(); }
  };
  const modes = async (dev) => ((await (await fetch(base + '/api/state', { headers: { 'x-device': dev } })).json()).tours || []).map((t) => `${t.name}=${t.window && t.window.mode}`);
  if (nowMin <= 23 * 60 + 55) {
    const dev = 'smokependeln0123456789abcd';
    await store.update(dev, (p) => {
      addTours(p, { from: st, to: mu, schedule: { days: ALL.filter((d) => d !== today), departAfter: '07:00', departUntil: '08:00' } });          // heute kein Pendeltag, zuerst angelegt
      addTours(p, { from: mu, to: st, schedule: { days: ALL, departAfter: hm(Math.max(0, nowMin - 5)), departUntil: hm(Math.min(24 * 60 - 1, nowMin + 55)) } });   // Fenster läuft
    });
    const m = (await modes(dev)).join(' | ');
    if (m !== `${mu.name} → ${st.name}=now | ${st.name} → ${mu.name}=off`) problems.push(`Pendelzeit: Reihenfolge und Zustand im Stand der App: ${m}`);
    const text = await screen(dev), iNow = text.indexOf(`${mu.name} → ${st.name}`), iOff = text.indexOf(`${st.name} → ${mu.name}`);
    if (iNow < 0 || iOff < 0 || iNow > iOff) problems.push('Pendelzeit: Hauptbildschirm zeigt die Strecke mit laufendem Fenster nicht oben');
    else if (!/(S1|RE \d)/.test(text.slice(iOff))) problems.push('Pendelzeit: Strecke ohne Pendeltag heute zeigt keine nächsten Züge');
  }
  if (nowMin + 150 <= 23 * 60 + 59) {
    const dev = 'smokeweitweg0123456789abcd';
    await store.update(dev, (p) => { addTours(p, { from: st, to: mu, schedule: { days: ALL, departAfter: hm(nowMin + 90), departUntil: hm(nowMin + 150) } }); });
    const text = await screen(dev);
    if (!/planmäßig/.test(text) || /pünktlich/i.test(text)) problems.push(`Pendelzeit: Fahrt in über 45 Minuten heißt nicht „planmäßig“ (${text.replace(/\s+/g, ' ').slice(0, 120)})`);
  }
});

// Einstellungen als Sheet von unten: Push, „Neues Handy?“, Rückmeldung und Version liegen nicht mehr in der Streckenliste. Der Satz am Ende der Liste
// öffnet sie; ✕, Abdunklung, Escape und die Zurück-Taste schließen zuerst das Sheet, ohne die Seite neu aufzubauen.
await check('Einstellungen-Sheet', async () => {
  const H = 844;
  const c = await browser.newContext(NEW_CTX); await c.addInitScript(initFor(), [DEV]);
  const p = await c.newPage(); p.setDefaultTimeout(8000);
  const dlg = p.getByRole('dialog', { name: 'Einstellungen' });
  const open = async () => { await p.getByRole('button', { name: /Einstellungen/ }).first().click(); await p.waitForTimeout(450); };
  try {
    await p.goto(base + '/Strecken'); await p.waitForTimeout(1300);
    await p.evaluate(() => { document.querySelector('#screen > div').__keep = 1; });           // Marke: bleibt nur, solange die Seite nicht neu aufgebaut wird
    const len0 = await p.evaluate(() => history.length);
    // Liste: nur noch der Satz, nichts von den Einstellungen
    if (!(await p.getByRole('button', { name: /findest du in den Einstellungen/ }).count())) { problems.push('Einstellungen: Satz „… findest du in den Einstellungen“ fehlt unter der Streckenliste'); return; }
    if (await p.getByRole('switch', { name: 'Push-Meldungen' }).count()) problems.push('Einstellungen: Push-Schalter steht noch in der Streckenliste');
    if (await p.getByText('Rückmeldung senden').count() || await p.getByPlaceholder('Code eingeben').count()) problems.push('Einstellungen: „Neues Handy?“ oder Rückmeldung stehen noch in der Streckenliste');
    if (await dlg.count()) problems.push('Einstellungen: Sheet ist offen, ohne dass jemand getippt hat');
    // Öffnen: von unten, höchstens 90 %, alles Wichtige da, Fokus im Sheet
    await open();
    if (!(await dlg.count())) { problems.push('Einstellungen: Tippen auf den Satz öffnet kein Sheet'); return; }
    const box = await dlg.boundingBox();
    if (Math.abs(box.y + box.height - H) > 1) problems.push(`Einstellungen: Sheet sitzt nicht ganz unten (Unterkante ${Math.round(box.y + box.height)} statt ${H})`);
    if (box.height > H * 0.9 + 1 || box.height < H * 0.4) problems.push(`Einstellungen: Sheet hat eine unpassende Höhe (${Math.round(box.height)} von ${H} px)`);
    if (!/#einstellungen$/.test(p.url())) problems.push('Einstellungen: geöffnetes Sheet hat keinen eigenen Verlaufseintrag (Zurück würde die Seite verlassen)');
    for (const [role, name] of [['switch', 'Push-Meldungen'], ['button', '3 Min.'], ['button', '5 Min.'], ['button', '10 Min.'], ['button', 'Senden'], ['button', /Neues Handy/], ['button', 'Schließen']]) {
      if (!(await dlg.getByRole(role, { name }).count())) problems.push(`Einstellungen: „${name}“ fehlt im Sheet`);
    }
    if (await dlg.getByRole('switch', { name: /Nur rund um die Abfahrt/ }).count()) problems.push('Einstellungen: Der Schalter „Nur rund um die Abfahrt“ steht noch im Sheet (Push folgt jetzt der Pendelzeit der Strecke)');
    if (!(await dlg.locator('a[href^="https://github.com/K0RBI02/ReGo/issues/new"]').count())) problems.push('Einstellungen: Link „Rückmeldung senden“ fehlt im Sheet');
    if (!(await dlg.evaluate((el) => el.contains(document.activeElement)))) problems.push('Einstellungen: Fokus liegt nach dem Öffnen nicht im Sheet');
    if (await p.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1)) problems.push('Einstellungen: Seite scrollt seitlich');
    // Bedienen im Sheet: Hinweis erscheint oben (nicht über den Einstellungen), das Sheet wird dabei nicht neu aufgebaut
    await dlg.evaluate((el) => { el.__keep = 1; });
    await dlg.getByRole('button', { name: '10 Min.' }).click(); await p.waitForTimeout(700);
    const toast = p.locator('.rg-toast');
    if (!(await toast.count())) problems.push('Einstellungen: keine Rückmeldung nach dem Umschalten');
    else { const tb = await toast.boundingBox(), db = await dlg.boundingBox(); if (tb.y + tb.height > db.y + 1) problems.push('Einstellungen: Hinweis verdeckt die Einstellungen (soll über dem Sheet stehen)'); }
    if (!(await dlg.evaluate((el) => el.__keep === 1))) problems.push('Einstellungen: Sheet wird beim Umschalten neu aufgebaut (Scroll und Fokus gehen verloren)');
    await dlg.getByRole('button', { name: '5 Min.' }).click(); await p.waitForTimeout(400);   // wieder zurück auf die Standardschwelle
    // „Neues Handy?“ klappt auf, Sheet wächst höchstens bis 90 % und scrollt; Rückmeldung und Version bleiben erreichbar
    await dlg.getByRole('button', { name: /Neues Handy/ }).click(); await p.waitForTimeout(300);
    if ((await dlg.getByRole('button', { name: /Neues Handy/ }).getAttribute('aria-expanded')) !== 'true') problems.push('Einstellungen: „Neues Handy?“ meldet nicht „aufgeklappt“');
    if (!(await dlg.getByPlaceholder('Code eingeben').count())) problems.push('Einstellungen: „Neues Handy?“ zeigt nach dem Aufklappen keine Code-Eingabe');
    const big = await dlg.boundingBox();
    if (big.height > H * 0.9 + 1 || big.y < 0) problems.push(`Einstellungen: aufgeklapptes Sheet ist zu hoch (${Math.round(big.height)} px)`);
    const fb = dlg.getByText('Rückmeldung senden'); await fb.scrollIntoViewIfNeeded();
    const fbb = await fb.boundingBox();
    if (fbb.y + fbb.height > H || fbb.y < 0) problems.push('Einstellungen: „Rückmeldung senden“ ist nach dem Aufklappen nicht erreichbar');
    await dlg.getByRole('link', { name: 'ReGo auf GitHub' }).scrollIntoViewIfNeeded();
    // Zurück-Taste (Android): schließt nur das Sheet, bleibt auf der Seite, baut sie nicht neu auf
    await p.goBack(); await p.waitForTimeout(500);
    if (await dlg.count()) problems.push('Einstellungen: Zurück schließt das Sheet nicht');
    if (!/\/Strecken$/.test(p.url())) problems.push(`Einstellungen: Zurück landet auf ${p.url()} statt auf der Streckenliste`);
    if (!(await p.evaluate(() => document.querySelector('#screen > div').__keep === 1))) problems.push('Einstellungen: Zurück baut die Streckenliste neu auf');
    // ✕, Abdunklung (auch über „Zurück“-Knopf der Seite) und Escape schließen; der Verlauf wächst dabei nicht
    for (const [how, close] of [
      ['✕', () => p.getByRole('button', { name: 'Schließen' }).click()],
      ['Abdunklung', () => p.mouse.click(60, 40)],
      ['Escape', () => p.keyboard.press('Escape')],
    ]) {
      await open();
      if (!(await dlg.count())) { problems.push(`Einstellungen (${how}): Sheet öffnet nicht erneut`); continue; }
      await close(); await p.waitForTimeout(500);
      if (await dlg.count()) problems.push(`Einstellungen: ${how} schließt das Sheet nicht`);
      if (/#einstellungen/.test(p.url()) || !/\/Strecken$/.test(p.url())) problems.push(`Einstellungen (${how}): Adresse nach dem Schließen ist ${p.url()}`);
      if (!(await p.evaluate(() => document.activeElement && document.activeElement.hasAttribute('data-sheet-open')))) problems.push(`Einstellungen (${how}): Fokus kehrt nicht zum Satz in der Liste zurück`);
    }
    if ((await p.evaluate(() => history.length)) > len0 + 1) problems.push('Einstellungen: Öffnen und Schließen füllt den Verlauf auf');
    // Direktaufruf mit #einstellungen (z. B. aus einem Kurzbefehl): Sheet offen, Zurück schließt zuerst das Sheet
    const q = await c.newPage(); q.setDefaultTimeout(8000);
    await q.goto(base + '/Strecken#einstellungen'); await q.waitForTimeout(1300);
    if (!(await q.getByRole('dialog', { name: 'Einstellungen' }).count())) problems.push('Einstellungen: #einstellungen öffnet das Sheet nicht');
    await q.goBack(); await q.waitForTimeout(500);
    if (await q.getByRole('dialog', { name: 'Einstellungen' }).count() || !/\/Strecken$/.test(q.url())) problems.push(`Einstellungen: Zurück nach Direktaufruf schließt nicht nur das Sheet (${q.url()})`);
    await q.goForward(); await q.waitForTimeout(500);
    if (!(await q.getByRole('dialog', { name: 'Einstellungen' }).count())) problems.push('Einstellungen: Vorwärts öffnet das Sheet nicht wieder');
    await q.close();
  } finally { await c.close(); }
  // Kleines Handy (320 × 568): Sheet bleibt im Bild, alles per Scrollen erreichbar, nichts läuft seitlich über
  const sc = await browser.newContext({ viewport: { width: 320, height: 568 }, isMobile: true, hasTouch: true }); await sc.addInitScript(initFor(), [DEV]);
  try {
    const sp = await sc.newPage(); sp.setDefaultTimeout(8000);
    await sp.goto(base + '/Strecken#einstellungen'); await sp.waitForTimeout(1300);
    const sd = sp.getByRole('dialog', { name: 'Einstellungen' });
    await sd.getByRole('button', { name: /Neues Handy/ }).click(); await sp.waitForTimeout(300);
    const sb = await sd.boundingBox();
    if (sb.height > 568 * 0.9 + 1) problems.push(`Einstellungen (320 × 568): Sheet zu hoch (${Math.round(sb.height)} px)`);
    if (!(await sd.evaluate((el) => el.scrollHeight > el.clientHeight))) problems.push('Einstellungen (320 × 568): aufgeklapptes Sheet scrollt nicht');
    const out = await sp.evaluate(() => [...document.querySelectorAll('[role=dialog] *')].filter((e) => e.getBoundingClientRect().right > innerWidth + 1 && getComputedStyle(e).display !== 'none').map((e) => e.textContent.trim().slice(0, 20) || e.tagName));
    if (out.length) problems.push(`Einstellungen (320 × 568): ragt über den Rand: ${out.slice(0, 3).join(', ')}`);
    if (await sp.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1)) problems.push('Einstellungen (320 × 568): Seite scrollt seitlich');
  } finally { await sc.close(); }
});

// Einladungscode: Maske über der App, falscher Code wird abgelehnt, richtiger öffnet; danach läuft alles
await check('Einladungscode', async () => {
  const lim = { ipBurst: 1e6, ipPerSec: 1e6, deviceBurst: 1e6, devicePerSec: 1e6, searchBurst: 1e6, searchPerSec: 1e6, newDevicesPerHour: 1e6 };
  const { server: s2 } = createApp({ cfg: { ...config, provider: 'mock', dataDir: await mkdtemp(join(tmpdir(), 'rego-ui2-')), notifyEverySec: 0, inviteCode: 'Ostern26', limits: lim } });
  await new Promise((r) => s2.listen(0, '127.0.0.1', r));
  const b2 = `http://127.0.0.1:${s2.address().port}`;
  const c = await browser.newContext(NEW_CTX);
  await c.addInitScript(() => { try { localStorage.setItem('rego.onboarded', '1'); localStorage.setItem('rego.splashSeen', '1'); } catch (e) {} });
  const p = await c.newPage(); p.setDefaultTimeout(8000);
  try {
    await p.goto(b2 + '/'); await p.waitForTimeout(1800);
    const gate = p.locator('.rg-gate');
    if (!(await gate.count())) { problems.push('Einladungscode: keine Maske bei neuem Gerät'); return; }
    await gate.locator('[data-go]').click(); await p.waitForTimeout(300);
    if (!/Bitte den Code eingeben/.test(await gate.innerText())) problems.push('Einladungscode: leere Eingabe wird nicht beanstandet');
    await gate.locator('[data-code]').fill('falsch'); await gate.locator('[data-go]').click(); await p.waitForTimeout(900);
    if (!/stimmt nicht/.test(await gate.innerText())) problems.push('Einladungscode: falscher Code wird nicht abgelehnt');
    await gate.locator('[data-code]').fill('  ostern26 '); await gate.locator('[data-code]').press('Enter'); await p.waitForTimeout(1800);
    if (await p.locator('.rg-gate').count()) problems.push('Einladungscode: Maske bleibt nach richtigem Code');
    if (await p.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1)) problems.push('Einladungscode: Seite scrollt seitlich');
    // mit dem Code funktioniert das Anlegen einer Strecke (Header wird mitgeschickt)
    await p.goto(b2 + '/Strecken'); await p.waitForTimeout(1200);
    if (await p.locator('.rg-gate').count()) problems.push('Einladungscode: Maske kommt nach dem Neuladen erneut');
    const r = await p.evaluate(async () => { try { await window.REGO.actions.addTour({ from: 'Freising', to: 'Freising', days: ['Mo'], time: '07:00', trip: 'one', backTime: '16:30' }); return 'ok'; } catch (e) { return e.message; } });
    if (/Einladungscode/.test(r)) problems.push('Einladungscode: Anlegen verlangt trotz gespeichertem Code erneut einen Code');
  } finally { await c.close(); s2.close(); }
});

// Ende des Onboardings mit einer Strecke ohne Direktverbindung: nichts wird angelegt, die Hauptseite sagt warum (statt leer und stumm)
await check('Onboarding ohne Direktverbindung', async () => {
  const dev = 'smokeonb0123456789abcdefg';
  const c = await browser.newContext(NEW_CTX);
  await c.addInitScript(([d]) => { try { localStorage.setItem('rego.device', JSON.stringify(d)); localStorage.setItem('rego.splashSeen', '1'); } catch (e) {} }, [dev]);
  const p = await c.newPage(); p.setDefaultTimeout(8000);
  expect422 = true;
  try {
    await p.goto(base + '/Onboarding1'); await p.waitForTimeout(1200);
    await p.evaluate(async () => { const R = window.REGO; R.searchStations('Freising'); await new Promise((r) => setTimeout(r, 900)); R.searchStations('Salzburg'); await new Promise((r) => setTimeout(r, 900)); window.REGO_pending = { from: 'Freising', to: 'Salzburg Hbf', trip: 'both' }; R.navigate('/Main'); });
    await p.waitForTimeout(2000);
    const t = await p.evaluate(() => document.querySelector('#screen').innerText);
    if (!/keine Direktverbindung gefunden/.test(t)) problems.push('Onboarding ohne Direktverbindung: Hauptseite nennt den Grund nicht');
    const n = (await (await fetch(base + '/api/profile', { headers: { 'x-device': dev, 'content-type': 'application/json' } })).json()).tours.length;
    if (n !== 0) problems.push(`Onboarding ohne Direktverbindung: ${n} Strecke(n) angelegt`);
  } finally { expect422 = false; await c.close(); }
});

// Gleiswechsel (Beispieldaten: der nächste Zug fährt auf Gleis 3 statt 2) erscheint als eigene Karte unter „Meldungen“
await check('Gleiswechsel in Meldungen', async () => {
  await page.goto(base + '/Meldungen'); await page.waitForTimeout(1500);
  const t = await page.evaluate(() => document.querySelector('#screen').innerText);
  if (!/Gleiswechsel/.test(t)) problems.push('Meldungen: keine Karte „Gleiswechsel“'); else if (!/Gl\. ?3/.test(t)) problems.push('Meldungen: Karte „Gleiswechsel“ nennt das neue Gleis nicht');
});

// Ausfall in der Oberfläche: der Zustand wird vom echten Aufbau (buildTour) erzeugt und der Seite untergeschoben
await check('Ausfall in der Oberfläche', async () => {
  const prof = (await j('/api/profile')).tours; const tour = prof.find((t) => t.active !== false);
  const iso = (min) => new Date(Date.now() + min * 60000).toISOString();
  const mk = (min, o = {}) => ({ line: { name: 'S 1', product: 'suburban' }, direction: tour.to.name, origin: tour.from, destination: tour.to, plannedDep: iso(min), dep: iso(min), depDelay: 0, plannedArr: iso(min + 40), arr: iso(min + 40), arrDelay: 0, plannedPlatform: '2', platform: '2', stopovers: [], remarks: [], ...o });
  await page.route('**/api/state**', async (route) => {
    const res = await route.fetch(); const body = await res.json();
    const r = await buildTour(tour, [mk(18, { cancelled: true }), mk(38, { cancelled: true }), mk(58)].map((l) => ({ legs: [l] })), { now: Date.now(), minDelay: 3, linesAt: async () => [], lines: body.lines });
    body.tours = body.tours.map((x) => (x.id === tour.id ? { ...x, ...r.tour } : x));
    body.incidents = [...body.incidents.filter((i) => i.tourId !== tour.id), ...r.incidents];
    await route.fulfill({ response: res, json: body });
  });
  try {
    await page.goto(base + '/'); await page.waitForTimeout(1800);
    let t = await page.evaluate(() => document.querySelector('#screen').innerText);
    if (!/Fällt aus/.test(t)) problems.push('Ausfall: Hauptbildschirm zeigt „Fällt aus“ nicht');
    if (!(await beside(page, '#screen a.rg-in'))) problems.push('Ausfall: Häkchen rutscht auf dem Hauptbildschirm unter „Fällt aus“');
    if (!/Ausfall · S ?1 ab/.test(t) || !/Nächste Fahrt/.test(t)) problems.push('Ausfall: Hauptbildschirm nennt die ausfallende Fahrt oder die nächste Fahrt nicht');
    await page.goto(base + '/Meldungen'); await page.waitForTimeout(1400);
    t = await page.evaluate(() => document.querySelector('#screen').innerText);
    if (!/Ausfall/.test(t)) problems.push('Ausfall: keine Karte unter „Meldungen“');
    if (!/Fahrten um \d\d:\d\d und \d\d:\d\d fallen aus/.test(t)) problems.push('Ausfall: Karte unter „Meldungen“ nennt die ausfallenden Fahrten nicht');
    await page.locator('a[href^="Detail.dc.html#"]').filter({ hasText: 'Ausfall' }).first().click(); await page.waitForTimeout(1400);
    t = await page.evaluate(() => document.querySelector('#screen').innerText);
    if (!/entfällt/.test(t) || !/Nächste Fahrt/.test(t)) problems.push('Ausfall: Streckenseite zeigt „entfällt“ oder die nächste Fahrt nicht');
    if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1)) problems.push('Ausfall: Streckenseite scrollt seitlich');
  } finally { await page.unroute('**/api/state**'); }
});

// Hauptbildschirm: das Symbol bleibt neben der großen Zeile (auch auf schmalen Handys). Detailseite: „Danach“ führt zur nächsten Abfahrt der Liste.
await check('Hero und Danach', async () => {
  const prof = (await j('/api/profile')).tours;
  const iso = (min) => new Date(Date.now() + min * 60000).toISOString();
  const mk = (t, min, o = {}) => ({ line: { name: 'S 1', product: 'suburban' }, direction: t.to.name, origin: t.from, destination: t.to, plannedDep: iso(min), dep: iso(min), depDelay: 0, plannedArr: iso(min + 40), arr: iso(min + 40), arrDelay: 0, plannedPlatform: '2', platform: '2', stopovers: [], remarks: [], ...o });
  // vier Fahrten je Strecke: pünktlich, +2 Min. (unter der Schwelle), pünktlich, pünktlich. Die vierte hat keine eigene Detailseite (nur die ersten drei).
  // Alle Strecken bekommen dieselben Fahrten: Welche Strecke oben steht, hängt von Tageszeit und Standort ab.
  const legsFor = (t) => [mk(t, 25), mk(t, 45, { dep: iso(47), depDelay: 2 }), mk(t, 65), mk(t, 85)];
  const install = (c) => c.route('**/api/state**', async (route) => {
    const res = await route.fetch(); const body = await res.json();
    const mine = new Set(prof.map((t) => t.id));
    let incidents = body.incidents.filter((i) => !mine.has(i.tourId)); const tours = [];
    for (const x of body.tours) {
      const t = prof.find((p) => p.id === x.id);
      if (!t) { tours.push(x); continue; }
      const r = await buildTour(t, legsFor(t).map((l) => ({ legs: [l] })), { now: Date.now(), minDelay: 3, linesAt: async () => [], lines: body.lines });
      tours.push({ ...x, ...r.tour }); incidents = [...incidents, ...r.incidents];
    }
    body.tours = tours; body.incidents = incidents;
    await route.fulfill({ response: res, json: body });
  });
  for (const [w, h] of [[390, 844], [360, 740], [320, 568]]) {
    const c = await browser.newContext({ viewport: { width: w, height: h }, isMobile: true, hasTouch: true }); await c.addInitScript(initFor(), [DEV]); await install(c);
    const pg = await c.newPage(); pg.setDefaultTimeout(8000);
    try {
      await pg.goto(base + '/'); await pg.waitForTimeout(1600);
      if (!(await beside(pg, '#screen a.rg-in'))) problems.push(`Hauptbildschirm (${w} px): Häkchen rutscht unter die große Zeile`);
      const big = await pg.evaluate(() => { const a = document.querySelector('#screen a.rg-in'), t = a.querySelector('span[style*="nowrap"]'); return t ? { text: t.textContent.trim(), px: parseFloat(getComputedStyle(t).fontSize), over: t.getBoundingClientRect().right > a.getBoundingClientRect().right } : null; });
      if (!big || big.over) problems.push(`Hauptbildschirm (${w} px): große Zeile ragt über die Karte`);
      if (!big || big.text !== 'pünktlich') problems.push(`Hauptbildschirm (${w} px): erwartet „pünktlich“ (untergeschobener Zustand), gefunden: ${big && big.text}`);
      if (w === 390 && big && !(big.px >= 44 && big.px <= 58)) problems.push(`Hauptbildschirm: große Zeile hat eine unpassende Größe (${big.px} px)`);
      if (w === 390) {
        const times = await pg.locator('a.rg-dep').evaluateAll((els) => els.map((e) => e.querySelector('span').textContent.trim()));
        if (times.length !== 3) { problems.push(`Danach: Abfahrtsliste hat ${times.length} statt 3 Zeilen`); continue; }
        // Seite der ersten Abfahrt: „Danach“ ist ein Link auf die zweite, dort auf die dritte; die dritte hat keinen Link mehr (vierte Fahrt ohne Detailseite)
        await pg.locator('a.rg-dep').nth(0).click(); await pg.waitForTimeout(1200);
        const danach = () => pg.locator('a[href^="Detail.dc.html#"]').filter({ hasText: 'Danach' });
        if (!(await beside(pg, null, '#screen svg[width="56"]'))) problems.push('Detailseite: Häkchen rutscht unter die große Zeile');
        if ((await danach().count()) !== 1) { problems.push('Danach: auf der Seite der ersten Abfahrt ist „Danach“ kein Link'); continue; }
        await danach().click(); await pg.waitForTimeout(1200);
        if (!/\.1-m$/.test(pg.url()) && !/\.1-m/.test(await pg.evaluate(() => location.hash))) problems.push(`Danach: führt auf ${pg.url()} statt auf die zweite Abfahrt`);
        if (!(await pg.evaluate(() => document.querySelector('#screen').innerText)).includes(times[1])) problems.push(`Danach: Seite der zweiten Abfahrt zeigt ${times[1]} nicht`);
        await pg.goBack(); await pg.waitForTimeout(900);
        if (!(await pg.evaluate(() => document.querySelector('#screen').innerText)).includes(times[0])) problems.push('Danach: Zurück führt nicht auf die erste Abfahrt');
        await danach().click(); await pg.waitForTimeout(900);
        await danach().click(); await pg.waitForTimeout(1200);
        if (!(await pg.evaluate(() => document.querySelector('#screen').innerText)).includes(times[2])) problems.push(`Danach: Seite der dritten Abfahrt zeigt ${times[2]} nicht`);
        if (await danach().count() || !(await pg.getByText('Danach').count())) problems.push('Danach: auf der dritten Abfahrt soll „Danach“ da sein, aber ohne Link (die vierte hat keine Detailseite)');
        // Antippen der großen Karte (Strecke) zeigt „Danach“ mit Link auf die zweite Abfahrt
        await pg.goto(base + '/'); await pg.waitForTimeout(1500);
        await pg.locator('#screen a.rg-in').first().click(); await pg.waitForTimeout(1200);
        if ((await pg.locator('a[href$=".1-m"]').filter({ hasText: 'Danach' }).count()) !== 1) problems.push('Danach: Streckenseite (große Karte) verlinkt „Danach“ nicht auf die zweite Abfahrt');
      }
      if (await pg.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1)) problems.push(`Hauptbildschirm/Detail (${w} px): Seite scrollt seitlich`);
    } finally { await c.close(); }
  }
});

// ---------- Neu in 0.7.0: Fahrten mit 1 Umstieg ----------
// Eigene Geräte, damit die Strecken der Fälle oben unverändert bleiben.
const jx = async (dev, p, m = 'GET', b) => (await fetch(base + p, { method: m, headers: { 'x-device': dev, 'content-type': 'application/json' }, body: b ? JSON.stringify(b) : undefined })).json();
const watch = (pg) => {
  pg.on('pageerror', (e) => problems.push(`${where}: JavaScript-Fehler: ${e.message}`));
  pg.on('console', (m) => { if (m.type() === 'error' && !ignore(m.text())) problems.push(`${where}: Konsole: ${m.text().slice(0, 200)}`); });
  pg.on('response', (r) => { if (r.status() >= 400 && !ignore(r.url())) problems.push(`${where}: HTTP ${r.status()} ${r.url()}`); });
};
const suggestOn = async (pg, n, text) => { const i = pg.locator('input[type=text]').nth(n); await i.click(); await i.fill(''); await i.pressSequentially(text, { delay: 40 }); await pg.waitForTimeout(1400); await pg.getByRole('option').first().click(); };
const sideways = (pg) => pg.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1);
// Kontrast Text gegen Untergrund (nächster nicht durchsichtiger Vorfahre).
// items = [[Tag, Text], …] liefert [[Text, Kennzahl], …] (0 = nicht gefunden); root = Auswahl liefert alle sichtbaren Texte darunter mit Kontrast unter min.
const contrastScan = (pg, args) => pg.evaluate(({ items, root, min }) => {
  const lum = (c) => { const m = c.match(/\d+(\.\d+)?/g).map(Number).slice(0, 3).map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return 0.2126 * m[0] + 0.7152 * m[1] + 0.0722 * m[2]; };
  const ratioOf = (el) => {
    let bg = el; while (bg && /rgba\(0, 0, 0, 0\)|transparent/.test(getComputedStyle(bg).backgroundColor)) bg = bg.parentElement;
    const a = lum(getComputedStyle(el).color), b = lum(bg ? getComputedStyle(bg).backgroundColor : 'rgb(255, 255, 255)');
    return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
  };
  if (items) return items.map(([tag, label]) => { const el = [...document.querySelectorAll(tag)].find((x) => x.textContent.trim() === label); return [label, el ? ratioOf(el) : 0]; });
  const bad = [];
  for (const el of document.querySelectorAll(root + ' *')) {
    const own = [...el.childNodes].filter((n) => n.nodeType === 3 && n.textContent.trim()).map((n) => n.textContent.trim()).join(' ');
    const r = el.getBoundingClientRect();
    if (!own || !r.width || !r.height || getComputedStyle(el).visibility === 'hidden') continue;
    const ratio = ratioOf(el);
    if (ratio < min) bad.push(`„${own.slice(0, 28)}“ ${ratio.toFixed(1)}:1`);
  }
  return bad;
}, { items: args.items || null, root: args.root || '', min: args.min || 4.5 });
const contrastOf = (pg, items) => contrastScan(pg, { items });
const lowContrast = (pg, root, min = 4.5) => contrastScan(pg, { root, min });

// Anlegen: keine Direktverbindung → „Mit 1 Umstieg suchen“ → Vorschau (zwei Linien, Umstiegsbahnhof) → Speichern legt Hin- und Rückweg mit Umstieg an
await check('Anlegen mit Umstieg', async () => {
  const XD = 'smokexfer1123456789abcdefg';
  expect422 = true;
  const c = await browser.newContext(NEW_CTX); await c.addInitScript(initFor(), [XD]);
  const p = await c.newPage(); p.setDefaultTimeout(8000); watch(p);
  const hint = () => p.getByRole('alert').filter({ hasText: 'keine Direktverbindung gefunden' });
  const find = () => p.getByRole('button', { name: 'Mit 1 Umstieg suchen' });
  const card = () => p.getByRole('status').filter({ hasText: 'Gefunden · 1 Umstieg' });
  const save = async () => { await p.getByRole('button', { name: 'Speichern' }).click(); await p.waitForTimeout(1300); };
  try {
    await p.goto(base + '/Strecken'); await p.waitForTimeout(1000);
    await p.getByRole('button', { name: /Strecke hinzufügen/ }).click();
    await suggestOn(p, 0, 'Freis'); await suggestOn(p, 1, 'Salzb');
    // 1) Speichern: nichts wird angelegt, die Erklärung steht im Formular und bietet die Suche mit 1 Umstieg an
    await save();
    if (!(await hint().count())) { problems.push('Anlegen mit Umstieg: keine Erklärung im Formular'); return; }
    if (!(await find().count())) { problems.push('Anlegen mit Umstieg: Knopf „Mit 1 Umstieg suchen“ fehlt unter der Erklärung'); return; }
    if ((await jx(XD, '/api/profile')).tours.length) problems.push('Anlegen mit Umstieg: Strecke wurde schon vor der Suche angelegt');
    // 2) Suche: Vorschau mit beiden Linien und dem Umstiegsbahnhof; der rote Hinweis geht
    await find().click(); await p.waitForTimeout(2500);
    if (!(await card().count())) { problems.push('Anlegen mit Umstieg: keine Vorschau nach der Suche'); return; }
    const t = await card().innerText();
    if (!/München Hbf/.test(t) || !/S ?1/.test(t) || !/RE ?5/.test(t) || !/Umstieg München Hbf · \d+ Min\./.test(t)) problems.push(`Anlegen mit Umstieg: Vorschau nennt Linien und Umstieg nicht (${t.replace(/\s+/g, ' ').slice(0, 120)})`);
    if (await hint().count()) problems.push('Anlegen mit Umstieg: roter Hinweis bleibt nach gefundener Verbindung stehen');
    if (await sideways(p)) problems.push('Anlegen mit Umstieg: Seite scrollt seitlich (Vorschau)');
    // 3) Haltestelle ändern: die Vorschau gilt nicht mehr
    await p.locator('input[type=text]').nth(1).fill(''); await p.waitForTimeout(500);
    if (await card().count()) problems.push('Anlegen mit Umstieg: Vorschau bleibt nach Ändern der Haltestelle stehen');
    await suggestOn(p, 1, 'Salzb');
    await save();
    if (!(await find().count())) { problems.push('Anlegen mit Umstieg: nach dem Ändern fehlt der Knopf erneut'); return; }
    await find().click(); await p.waitForTimeout(2500);
    if (!(await card().count())) { problems.push('Anlegen mit Umstieg: zweite Suche ergibt keine Vorschau'); return; }
    // 4) Speichern mit Vorschau: Hin- und Rückweg, beide mit Umstieg; die Liste nennt Umstieg und Bahnhof
    await save(); await p.waitForTimeout(600);
    const tours = (await jx(XD, '/api/profile')).tours;
    if (tours.length !== 2 || tours.some((x) => x.transfers !== 1)) problems.push(`Anlegen mit Umstieg: ${tours.length} Strecke(n) mit Umstieg ${tours.map((x) => x.transfers).join('/')} statt 2 × 1`);
    await p.goto(base + '/Strecken'); await p.waitForTimeout(1800);
    const list = await p.evaluate(() => document.querySelector('#screen').innerText);
    if (!/1 Umstieg · meist München Hbf/.test(list)) problems.push(`Anlegen mit Umstieg: Streckenliste nennt „1 Umstieg · meist München Hbf“ nicht (${list.replace(/\s+/g, ' ').slice(0, 160)})`);
    if (await sideways(p)) problems.push('Anlegen mit Umstieg: Streckenliste scrollt seitlich');
    // 5) Ohne Verbindung auch mit Umstieg (Passau → Wien gibt es in den Beispieldaten nicht): ehrlicher Satz, kein Knopf mehr
    await p.getByRole('button', { name: /Strecke hinzufügen/ }).click();
    await suggestOn(p, 0, 'Passau'); await suggestOn(p, 1, 'Wien');
    await save();
    if (!(await find().count())) { problems.push('Anlegen mit Umstieg (Passau → Wien): Knopf „Mit 1 Umstieg suchen“ fehlt'); return; }
    await find().click(); await p.waitForTimeout(2500);
    if (!(await p.getByRole('alert').filter({ hasText: 'Auch mit 1 Umstieg habe ich zwischen' }).count())) problems.push('Anlegen mit Umstieg (Passau → Wien): keine Erklärung „Auch mit 1 Umstieg …“');
    if (await find().count()) problems.push('Anlegen mit Umstieg (Passau → Wien): Knopf bleibt nach der erfolglosen Suche stehen');
    if ((await jx(XD, '/api/profile')).tours.length !== 2) problems.push('Anlegen mit Umstieg (Passau → Wien): trotz fehlender Verbindung wurde etwas angelegt');
  } finally { expect422 = false; await c.close(); }
  // Dunkelmodus: roter Hinweis, Knopf und grüne Vorschau bleiben lesbar
  expect422 = true;
  const dk = await browser.newContext({ ...NEW_CTX, colorScheme: 'dark' }); await dk.addInitScript(initFor(), ['smokexfer3123456789abcdefg']);
  try {
    const dp = await dk.newPage(); dp.setDefaultTimeout(8000); watch(dp);
    await dp.goto(base + '/Strecken'); await dp.waitForTimeout(1000);
    await dp.getByRole('button', { name: /Strecke hinzufügen/ }).click();
    await suggestOn(dp, 0, 'Freis'); await suggestOn(dp, 1, 'Salzb');
    await dp.getByRole('button', { name: 'Speichern' }).click(); await dp.waitForTimeout(1300);
    const verdict = (what, rows) => { for (const [label, ratio] of rows) if (ratio < 4.5) problems.push(`Dunkelmodus: ${what} „${label}“ schlecht lesbar${ratio ? ` (Kontrast ${ratio.toFixed(1)}:1)` : ' (nicht gefunden)'}`); };
    verdict('Hinweis „keine Direktverbindung“', await contrastOf(dp, [['span', 'Zwischen Freising und Salzburg Hbf habe ich keine Direktverbindung gefunden.'], ['button', 'Mit 1 Umstieg suchen']]));
    await dp.getByRole('button', { name: 'Mit 1 Umstieg suchen' }).click(); await dp.waitForTimeout(2500);
    const bad = await lowContrast(dp, '[role=status]');
    if (bad.length) problems.push(`Dunkelmodus: Vorschau „Gefunden · 1 Umstieg“ schlecht lesbar: ${bad.slice(0, 4).join(', ')}`);
    if (!(await dp.getByRole('status').filter({ hasText: 'Gefunden · 1 Umstieg' }).count())) problems.push('Dunkelmodus: keine Vorschau „Gefunden · 1 Umstieg“');
  } finally { expect422 = false; await dk.close(); }
});

// Umstiegsfahrt in der Oberfläche: der Zustand wird vom echten Aufbau (buildTransferTour) erzeugt und der Seite untergeschoben, mit Zeiten ab jetzt.
// Drei Lagen: Anschluss pünktlich, wackelt (Zubringer +8 Min.), verpasst (Zubringer +12 Min.). Hauptseite, Streckenseite, Meldungen, Dunkelmodus, schmales Handy.
await check('Umstiegsfahrt in der Oberfläche', async () => {
  const XD2 = 'smokexfer2123456789abcdefg';
  const sa = (await j('/api/stations?q=Salzburg')).stations[0];
  const made = await jx(XD2, '/api/tours', 'POST', { from: st, to: sa, transfers: 1 });
  const tour = (made.tours || [])[0];
  if (!tour) { problems.push(`Umstiegsfahrt: Strecke mit Umstieg ließ sich nicht anlegen (${made.error || 'keine Antwort'})`); return; }
  const MH = { id: '8000261', name: 'München Hbf' };
  const iso = (min) => new Date(Date.now() + min * 60000).toISOString();
  const S1 = (min, o = {}) => { const d = o.late || 0; return { line: { name: 'S1', product: 'suburban' }, direction: 'Ostbahnhof', origin: tour.from, destination: MH, plannedDep: iso(min), dep: iso(min + d), depDelay: d, plannedArr: iso(min + 35), arr: iso(min + 35 + d), arrDelay: d, plannedPlatform: '3', platform: '3', plannedArrPlatform: '2', arrPlatform: '2', stopovers: [tour.from, { id: 'a', name: 'Neufahrn' }, { id: 'b', name: 'Feldmoching' }, MH], remarks: [], cancelled: false }; };
  const RE = (min) => ({ line: { name: 'RE 5', product: 'regionalExpress' }, direction: 'Salzburg Hbf', origin: MH, destination: tour.to, plannedDep: iso(min), dep: iso(min), depDelay: 0, plannedArr: iso(min + 95), arr: iso(min + 95), arrDelay: 0, plannedPlatform: '14', platform: '14', stopovers: [MH, { id: 'c', name: 'Rosenheim' }, { id: 'd', name: 'Prien' }, tour.to], remarks: [], cancelled: false });
  const J = (a, b) => ({ legs: [a, b] });
  const anschluesse = () => new Map([['münchen hbf', [RE(24), RE(54), RE(84), RE(114)]]]);
  const scen = [
    { name: 'pünktlich', state: 'ok', hero: /pünktlich/, detail: [/Umstieg/, /Gleis 2\s*→\s*Gleis 14/], js: () => [J(S1(10), RE(54)), J(S1(30), RE(84)), J(S1(50), RE(114))] },
    { name: 'wackelt', state: 'tight', hero: /\+8 Min/, detail: [/Anschluss wackelt/, /Nächster Anschluss/], card: /Anschluss wackelt/, js: () => [J(S1(10, { late: 8 }), RE(84)), J(S1(30), RE(84)), J(S1(50), RE(114))] },
    { name: 'verpasst', state: 'missed', hero: /Verpasst/, detail: [/Anschluss verpasst/, /Nächster RE ?5 ab/], card: /Anschluss verpasst/, js: () => [J(S1(10, { late: 12 }), RE(84)), J(S1(30), RE(84)), J(S1(50), RE(114))] },
  ];
  for (const sc of scen) for (const [w, h, dark] of [[390, 844, false], [320, 568, false], [390, 844, true]]) {
    const tag = `Umstiegsfahrt ${sc.name} (${w} px${dark ? ', dunkel' : ''})`;
    where = tag;
    const c = await browser.newContext({ viewport: { width: w, height: h }, isMobile: true, hasTouch: true, colorScheme: dark ? 'dark' : 'light' });
    await c.addInitScript(initFor(), [XD2]);
    let built = null;
    await c.route('**/api/state**', async (route) => {
      const res = await route.fetch(); const body = await res.json();
      built = await buildTransferTour(tour, sc.js(), { now: Date.now(), minDelay: 3, linesAt: async () => [], lines: body.lines, bLists: anschluesse() });
      body.tours = body.tours.map((x) => (x.id === tour.id ? { ...x, ...built.tour } : x));
      body.incidents = built.incidents;
      await route.fulfill({ response: res, json: body });
    });
    const pg = await c.newPage(); pg.setDefaultTimeout(8000); watch(pg);
    const text = () => pg.evaluate(() => document.querySelector('#screen').innerText);
    try {
      // Hauptseite: große Karte, drei Zeilen mit je zwei Linien und der Umstiegszeile
      await pg.goto(base + '/'); await pg.waitForTimeout(1800);
      if (!built) { problems.push(`${tag}: Zustand wurde nicht untergeschoben`); continue; }
      const states = built.tour.departures.map((d) => d.transfer && d.transfer.state);
      if (states[0] !== sc.state) problems.push(`${tag}: erste Abfahrt hat den Zustand ${states[0]} statt ${sc.state}`);
      const hero = await pg.locator('#screen a.rg-in').first().innerText();
      if (!sc.hero.test(hero)) problems.push(`${tag}: große Karte zeigt nicht ${sc.hero} (${hero.replace(/\s+/g, ' ').slice(0, 80)})`);
      const rows = pg.locator('a.rg-xdep');
      if ((await rows.count()) !== 3) { problems.push(`${tag}: ${await rows.count()} statt 3 Umstiegszeilen`); continue; }
      for (let i = 0; i < 3; i++) {
        const rt = await rows.nth(i).innerText();
        if (!/S ?1/.test(rt) || !/RE ?5/.test(rt)) problems.push(`${tag}: Zeile ${i + 1} zeigt nicht beide Linien (${rt.replace(/\s+/g, ' ')})`);
        if (!rt.includes(built.tour.departures[i].transfer.text)) problems.push(`${tag}: Zeile ${i + 1} nennt „${built.tour.departures[i].transfer.text}“ nicht (${rt.replace(/\s+/g, ' ')})`);
      }
      if (await sideways(pg)) problems.push(`${tag}: Hauptseite scrollt seitlich`);
      if (dark) { const bad = await lowContrast(pg, '#screen'); if (bad.length) problems.push(`${tag}: Hauptseite schlecht lesbar: ${bad.slice(0, 4).join(', ')}`); }
      // Seite der ersten Abfahrt: zwei Abschnitte, Umstiegskarte, Karte der Strecke
      await rows.first().click(); await pg.waitForTimeout(1600);
      const dt = await text();
      for (const re of sc.detail) if (!re.test(dt)) problems.push(`${tag}: Seite der Abfahrt zeigt ${re} nicht`);
      if (!/Freising\s*→\s*München Hbf/.test(dt) || !/München Hbf\s*→\s*Salzburg Hbf/.test(dt)) problems.push(`${tag}: Seite der Abfahrt zeigt die beiden Fahrten nicht`);
      if (!/1\. Fahrt/.test(dt) || !/2\. Fahrt/.test(dt)) problems.push(`${tag}: Seite der Abfahrt nennt „1. Fahrt“ und „2. Fahrt“ nicht`);
      if (await sideways(pg)) problems.push(`${tag}: Seite der Abfahrt scrollt seitlich`);
      const cut = await pg.evaluate(() => [...document.querySelectorAll('span')].filter((e) => /rotate\(-45deg\)/.test(e.getAttribute('style') || '') && e.textContent.trim()).filter((e) => e.getBoundingClientRect().right > innerWidth + 1 || e.getBoundingClientRect().left < -1).map((e) => e.textContent));
      if (cut.length) problems.push(`${tag}: Beschriftung der Karte ragt über den Rand: ${cut.join(', ')}`);
      if (dark) { const bad = await lowContrast(pg, '#screen'); if (bad.length) problems.push(`${tag}: Seite der Abfahrt schlecht lesbar: ${bad.slice(0, 4).join(', ')}`); }
      await pg.evaluate(() => { const s = [...document.querySelectorAll('[style*="overflow-y: auto"]')].pop(); if (s) s.scrollTop = 9999; }); await pg.waitForTimeout(300);
      if (await sideways(pg)) problems.push(`${tag}: Seite der Abfahrt scrollt unten seitlich`);
      // Meldungen: bei wackelt/verpasst genau eine Karte für den Anschluss, bei pünktlich keine
      await pg.goto(base + '/Meldungen'); await pg.waitForTimeout(1500);
      const cards = pg.locator('a[href^="Detail.dc.html#"]');
      if (sc.card) {
        if ((await cards.count()) !== 1) problems.push(`${tag}: ${await cards.count()} Karten unter „Meldungen“ statt 1`);
        else {
          const ct = await cards.first().innerText();
          if (!sc.card.test(ct) || !/RE ?5/.test(ct) || !/München Hbf/.test(ct)) problems.push(`${tag}: Karte unter „Meldungen“ nennt Zustand, Linie oder Bahnhof nicht (${ct.replace(/\s+/g, ' ')})`);
          await cards.first().click(); await pg.waitForTimeout(1500);
          const mt = await text();
          for (const re of sc.detail) if (!re.test(mt)) problems.push(`${tag}: Streckenseite über „Meldungen“ zeigt ${re} nicht`);
        }
      } else if (await cards.count()) problems.push(`${tag}: Meldung trotz pünktlichem Anschluss`);
      if (await sideways(pg)) problems.push(`${tag}: „Meldungen“ scrollt seitlich`);
      if (dark) { const bad = await lowContrast(pg, '#screen'); if (bad.length) problems.push(`${tag}: „Meldungen“ schlecht lesbar: ${bad.slice(0, 4).join(', ')}`); }
    } finally { await c.close(); }
  }
});

// ---------- Neu in 0.7.1: „Schneller mit 1 Umstieg“ bei Ersatzverkehr ----------
// Der Zustand kommt vom echten Aufbau (buildTour mit shortcutFor) und wird der Seite untergeschoben, mit Zeiten ab jetzt.
await check('Schneller mit 1 Umstieg in der Oberfläche', async () => {
  const XD3 = 'smokeshort1123456789abcdefg';
  const made = await jx(XD3, '/api/tours', 'POST', { from: st, to: mu });
  const tour = (made.tours || [])[0];
  if (!tour) { problems.push(`Schneller mit 1 Umstieg: Strecke ließ sich nicht anlegen (${made.error || 'keine Antwort'})`); return; }
  const MO = { id: '8000902', name: 'Moosach' };
  const iso = (min) => new Date(Date.now() + min * 60000).toISOString();
  const SEV = { type: 'status', code: 'construction', summary: 'Schienenersatzverkehr', text: 'Wegen Bauarbeiten zwischen Neufahrn und Moosach Schienenersatzverkehr mit Bussen. Reisezeit verlängert sich um ca. 25 Minuten.', validFrom: iso(-600), validUntil: iso(3 * 24 * 60) };
  const D = (min) => ({ line: { name: 'S1', product: 'suburban' }, direction: 'Ostbahnhof', origin: tour.from, destination: tour.to, plannedDep: iso(min), dep: iso(min), depDelay: 0, plannedArr: iso(min + 46), arr: iso(min + 46), arrDelay: 0, plannedPlatform: '3', platform: '3', stopovers: [tour.from, { id: 'a', name: 'Neufahrn' }, { id: 'b', name: 'Feldmoching' }, MO, tour.to], remarks: [SEV], cancelled: false });
  const A = (min) => ({ line: { name: 'RE 22', product: 'regionalExpress' }, direction: 'Moosach', origin: tour.from, destination: MO, plannedDep: iso(min), dep: iso(min), depDelay: 0, plannedArr: iso(min + 25), arr: iso(min + 25), arrDelay: 0, plannedPlatform: '1', platform: '1', stopovers: [tour.from, MO], remarks: [], cancelled: false });
  const B = (min) => ({ line: { name: 'U3', product: 'subway' }, direction: 'Fürstenried West', origin: MO, destination: tour.to, plannedDep: iso(min), dep: iso(min), depDelay: 0, plannedArr: iso(min + 15), arr: iso(min + 15), arrDelay: 0, plannedPlatform: '1', platform: '1', stopovers: [MO, tour.to], remarks: [], cancelled: false });
  const J = (...legs) => ({ legs });
  // Szenarien: mit einem schnelleren Umweg (RE 22 › U3 ab jetzt+12 Min., 23 Min. früher am Ziel) und ohne (der Umweg wäre nur 4 Min. schneller)
  const scen = [
    { name: 'mit Umweg', umwege: () => [J(A(12), B(43)), J(A(32), B(63))], card: true },
    { name: 'ohne Umweg', umwege: () => [J(A(12), B(62))], card: false },
  ];
  for (const sc of scen) for (const [w, h, dark] of (sc.card ? [[390, 844, false], [320, 568, false], [390, 844, true]] : [[390, 844, false]])) {
    const tag = `Schneller mit 1 Umstieg ${sc.name} (${w} px${dark ? ', dunkel' : ''})`;
    where = tag;
    const c = await browser.newContext({ viewport: { width: w, height: h }, isMobile: true, hasTouch: true, colorScheme: dark ? 'dark' : 'light' });
    await c.addInitScript(initFor(), [XD3]);
    let built = null;
    await c.route('**/api/state**', async (route) => {
      const res = await route.fetch(); const body = await res.json(); const now = Date.now();
      built = await buildTour(tour, [J(D(10)), J(D(30)), J(D(50))], { now, minDelay: 3, linesAt: async () => [], lines: body.lines, shortcutFor: (o) => shortcutFor(sc.umwege(), { now, ...o }) });
      body.tours = body.tours.map((x) => (x.id === tour.id ? { ...x, ...built.tour } : x));
      body.incidents = built.incidents;
      await route.fulfill({ response: res, json: body });
    });
    const pg = await c.newPage(); pg.setDefaultTimeout(8000); watch(pg);
    const text = () => pg.evaluate(() => document.querySelector('#screen').innerText);
    try {
      await pg.goto(base + '/'); await pg.waitForTimeout(1800);
      const rep = built && built.incidents.find((i) => i.kind === 'replacement');
      if (!rep) { problems.push(`${tag}: Zustand mit Ersatzverkehr wurde nicht untergeschoben`); continue; }
      if (!!rep.view.shortcut !== sc.card) problems.push(`${tag}: Server-Ansicht ${rep.view.shortcut ? 'hat' : 'hat keine'} Karte, erwartet ${sc.card ? 'eine' : 'keine'}`);
      // Seite der Meldung öffnen
      await pg.goto(base + '/Detail#' + rep.id + '-m'); await pg.waitForTimeout(1600);
      const dt = await text();
      if (!/Ersatzverkehr/.test(dt)) problems.push(`${tag}: Seite zeigt den Ersatzverkehr nicht`);
      if (sc.card) {
        if (!/Schneller mit 1 Umstieg/.test(dt)) problems.push(`${tag}: Karte „Schneller mit 1 Umstieg“ fehlt`);
        else {
          const ct = dt.slice(dt.indexOf('Schneller mit 1 Umstieg')).replace(/\s+/g, ' ').slice(0, 160);
          if (!/RE 22 › U3 ab \d\d:\d\d/.test(ct) || !/Umstieg Moosach · \d+ Min\./.test(ct) || !/An \d\d:\d\d statt \d\d:\d\d/.test(ct) || !/−\d+ Min\./.test(ct)) problems.push(`${tag}: Karte nennt Linien, Umstieg, Ankunft oder Ersparnis nicht (${ct.slice(0, 140)})`);
        }
      } else if (/Schneller mit 1 Umstieg/.test(dt)) problems.push(`${tag}: Karte erscheint, obwohl der Umweg nicht schneller ist`);
      if (await sideways(pg)) problems.push(`${tag}: Seite scrollt seitlich`);
      await pg.evaluate(() => { const s = [...document.querySelectorAll('[style*="overflow-y: auto"]')].pop(); if (s) s.scrollTop = 9999; }); await pg.waitForTimeout(300);
      if (await sideways(pg)) problems.push(`${tag}: Seite scrollt unten seitlich`);
      if (dark) { const bad = await lowContrast(pg, '#screen'); if (bad.length) problems.push(`${tag}: Seite schlecht lesbar: ${bad.slice(0, 4).join(', ')}`); }
    } finally { await c.close(); }
  }
});

await browser.close(); server.close();
if (problems.length) { console.error('Bildschirmtest FEHLGESCHLAGEN:\n- ' + [...new Set(problems)].join('\n- ')); process.exit(1); }
console.log('Bildschirmtest bestanden (6 Screens, Strecke ändern, Ticket sichern, Doppeltipp, Pendelzeit (Schieber, Hauptbildschirm), Rückgängig, Aktualisieren, Code übernehmen, kleines Handy, Dunkelmodus, mehrere Meldungen je Strecke, Strecke ohne Direktverbindung, Schrift, Anlegen ohne Direktverbindung, Onboarding ohne Direktverbindung, Testmeldung, Versionszeile, Einstellungs-Sheet, Einladungscode, Gleiswechsel, Ausfall, Hero und Danach, Anlegen mit Umstieg, Umstiegsfahrt pünktlich / wackelt / verpasst, Schneller mit 1 Umstieg bei Ersatzverkehr).');
