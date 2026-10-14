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
const check = async (name, fn) => { where = name; try { await fn(); } catch (e) { problems.push(`${name}: ${String(e.message).split('\n')[0]}`); } };
const suggest = async (n, text) => { const i = page.locator('input[type=text]').nth(n); await i.click(); await i.pressSequentially(text, { delay: 40 }); await page.waitForTimeout(1400); await page.getByRole('option').first().click(); };

// Doppeltipp auf „Speichern“: Hin- und Rückweg nur einmal
await check('Doppeltipp', async () => {
  const before = (await j('/api/profile')).tours.length;
  await page.goto(base + '/Strecken'); await page.waitForTimeout(1000);
  await page.getByRole('button', { name: /Strecke hinzufügen/ }).click();
  await suggest(0, 'Freis'); await suggest(1, 'Münch');
  await page.evaluate(() => { const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === 'Speichern'); b.click(); b.click(); });
  await page.waitForTimeout(1500);
  const added = (await j('/api/profile')).tours.length - before;
  if (added !== 2) problems.push(`Doppeltipp: ${added} Strecken angelegt statt 2 (Hin + Rück)`);
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
  await page.goto(base + '/Strecken'); await page.waitForTimeout(1000);
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
  await small.close();
});

// Dunkelmodus: Karte „Neues Handy?“ lesbar
await check('Dunkelmodus', async () => {
  const dark = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, colorScheme: 'dark' });
  await dark.addInitScript(([d]) => { try { if (!localStorage.getItem('rego.device')) { localStorage.setItem('rego.device', JSON.stringify(d)); localStorage.setItem('rego.onboarded', '1'); localStorage.setItem('rego.splashSeen', '1'); } } catch (e) {} }, [DEV]);
  const dp = await dark.newPage();
  await dp.goto(base + '/Strecken'); await dp.waitForTimeout(1500);
  const ratio = await dp.evaluate(() => {
    const el = [...document.querySelectorAll('span')].find((x) => x.textContent.trim() === 'Neues Handy?');
    if (!el) return 0;
    const lum = (c) => { const m = c.match(/\d+(\.\d+)?/g).map(Number).slice(0, 3).map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return 0.2126 * m[0] + 0.7152 * m[1] + 0.0722 * m[2]; };
    let bgEl = el; while (bgEl && /rgba\(0, 0, 0, 0\)|transparent/.test(getComputedStyle(bgEl).backgroundColor)) bgEl = bgEl.parentElement;
    const a = lum(getComputedStyle(el).color), b = lum(getComputedStyle(bgEl).backgroundColor);
    return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
  });
  if (ratio < 4.5) problems.push(`Dunkelmodus: Karte „Neues Handy?“ schlecht lesbar (Kontrast ${ratio.toFixed(1)}:1)`);
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
    await p.goto(base + '/Strecken'); await p.waitForTimeout(1500);
    const text = await p.evaluate(() => document.querySelector('#screen').innerText);
    if (!text.includes(`App 9.9.9 · Server ${ver}`)) problems.push(`Versionszeile: erwartet „App 9.9.9 · Server ${ver}“, gefunden: ${(text.match(/(App [^\n]*)?Server [^\n]*/) || ['nichts'])[0]}`);
    for (const [href, label] of [['https://github.com/K0RBI02/ReGo/blob/main/DATENSCHUTZ.md', 'Datenschutz'], ['https://github.com/K0RBI02/ReGo', 'ReGo auf GitHub']]) {
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
    const pq = await q.newPage(); await pq.goto(base + '/Strecken'); await pq.waitForTimeout(1200);
    const off = await pq.evaluate(() => { const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === 'Senden'); return b ? b.getAttribute('aria-disabled') : 'fehlt'; });
    if (off !== 'true') problems.push(`Testmeldung: Knopf ist ohne Push nicht gesperrt (aria-disabled=${off})`);
    if (!(await pq.getByText('Schalte zuerst Push-Meldungen ein').count())) problems.push('Testmeldung: Hinweis „Schalte zuerst Push-Meldungen ein“ fehlt');
    await q.close();
  } finally { await c.close(); }
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

await browser.close(); server.close();
if (problems.length) { console.error('Bildschirmtest FEHLGESCHLAGEN:\n- ' + [...new Set(problems)].join('\n- ')); process.exit(1); }
console.log('Bildschirmtest bestanden (6 Screens, Strecke ändern, Ticket sichern, Doppeltipp, Rückgängig, Aktualisieren, Code übernehmen, kleines Handy, Dunkelmodus, mehrere Meldungen je Strecke, Strecke ohne Direktverbindung, Schrift, Anlegen ohne Direktverbindung, Onboarding ohne Direktverbindung, Testmeldung, Versionszeile, Einladungscode, Gleiswechsel, Ausfall).');
