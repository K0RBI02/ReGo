// Bildschirmtest: startet ReGo mit Beispieldaten, öffnet jeden Screen im Handy-Format und prüft
// auf JavaScript-Fehler, blockierte Inhalte (CSP), fehlende Dateien und seitliches Scrollen.
// Aufruf: node scripts/ui-smoke.mjs   (braucht Playwright: npm i --no-save playwright && npx playwright install chromium)
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server/index.mjs';
import { config } from '../server/config.mjs';

const pw = await import('playwright').catch(() => import('/opt/npm-tools/node_modules/playwright/index.mjs'));
const { server } = createApp({ cfg: { ...config, provider: 'mock', dataDir: await mkdtemp(join(tmpdir(), 'rego-ui-')), notifyEverySec: 0 } });
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
const ignore = () => false;
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

await browser.close(); server.close();
if (problems.length) { console.error('Bildschirmtest FEHLGESCHLAGEN:\n- ' + [...new Set(problems)].join('\n- ')); process.exit(1); }
console.log('Bildschirmtest bestanden (6 Screens, Strecke ändern, Ticket sichern, Doppeltipp, Rückgängig, Aktualisieren, Code übernehmen, kleines Handy, Dunkelmodus, mehrere Meldungen je Strecke).');
