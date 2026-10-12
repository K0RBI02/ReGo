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

await browser.close(); server.close();
if (problems.length) { console.error('Bildschirmtest FEHLGESCHLAGEN:\n- ' + [...new Set(problems)].join('\n- ')); process.exit(1); }
console.log('Bildschirmtest bestanden (6 Screens, Strecke ändern, Ticket sichern).');
