// Screen test: starts ReGo with sample data, opens every screen in phone size and checks
// for JavaScript errors, blocked content (CSP), missing files and sideways scrolling.
// Usage: node scripts/ui-smoke.mjs   (needs Playwright: npm i --no-save playwright && npx playwright install chromium)
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

const pw = await import('playwright');
// Limits raised: the test loads many files from one address in a short time (the rate limiting itself is checked by the server tests)
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
let expect422 = false;                       // when creating without a direct connection the 422 response is intended
const ignore = (x) => expect422 && /422|\/api\/tours/.test(x);
page.on('pageerror', (e) => problems.push(`${where}: JavaScript error: ${e.message}`));
page.on('console', (m) => { if (m.type() === 'error' && !ignore(m.text())) problems.push(`${where}: console: ${m.text().slice(0, 200)}`); });
page.on('requestfailed', (r) => { if (!ignore(r.url())) problems.push(`${where}: request failed: ${r.url()}`); });
page.on('response', (r) => { if (r.status() >= 400 && !ignore(r.url())) problems.push(`${where}: HTTP ${r.status()} ${r.url()}`); });

for (const path of ['/', '/Meldungen', '/Strecken', '/Ticket', '/Scan', '/Onboarding1']) {
  where = path;
  await page.goto(base + path); await page.waitForTimeout(1500);
  if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1)) problems.push(`${path}: page scrolls sideways`);
  if (!(await page.evaluate(() => document.body.innerText.trim().length))) problems.push(`${path}: page is empty`);
}

// Change route: set time, save, server has it
where = 'Change route';
await page.goto(base + '/Strecken'); await page.waitForTimeout(1200);
await page.getByRole('button', { name: /ändern$/ }).first().click();
await page.locator('input[type=time]').first().fill('06:45');
await page.getByRole('button', { name: 'Speichern' }).click(); await page.waitForTimeout(800);
const tours = (await j('/api/profile')).tours;
if (!tours.some((t) => t.schedule.departAfter === '06:45')) problems.push('Change route: time was not saved');

// Back up tickets: a file arrives
where = 'Back up tickets';
await page.evaluate(() => { localStorage.setItem('rego.tickets', JSON.stringify([{ id: 'dt', slot: 'dt', name: 'Deutschlandticket', validUntil: '01.01.2020', image: 'data:image/png;base64,iVBORw0KGgo=', original: '', payload: '', format: '' }])); });
await page.goto(base + '/Ticket'); await page.waitForTimeout(1200);
if (!(await page.getByText('abgelaufen').count())) problems.push('Ticket: expired ticket is not marked');
const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 4000 }).catch(() => null), page.getByRole('button', { name: 'Tickets sichern' }).click()]);
if (!dl) problems.push('Back up tickets: no file produced');

// ---------- Cases from the big review (0.5.0) ----------
// Each case runs on its own; if an interaction fails, it is reported as a finding instead of aborting the whole test.
// SMOKE_ONLY=<part of the name> runs only matching cases (for improving a single case)
const check = async (name, fn) => { if (process.env.SMOKE_ONLY && !name.includes(process.env.SMOKE_ONLY)) return; where = name; try { await fn(); } catch (e) { problems.push(`${name}: ${String(e.message).split('\n').slice(0, 2).join(' ')}`); } };
const suggest = async (n, text) => { const i = page.locator('input[type=text]').nth(n); await i.click(); await i.pressSequentially(text, { delay: 40 }); await page.waitForTimeout(1400); await page.getByRole('option').first().click(); };

// Double tap on "Speichern": outward and return trip only once. The commute time is typed by hand here (05:30), because the server does not create the same route with the same
// times again (the route from the start has the default time 07:00–08:00).
await check('Double tap', async () => {
  const before = (await j('/api/profile')).tours.length;
  await page.goto(base + '/Strecken'); await page.waitForTimeout(1000);
  await page.getByRole('button', { name: /Strecke hinzufügen/ }).click();
  await suggest(0, 'Freis'); await suggest(1, 'Münch');
  await page.locator('input[type=time]').nth(0).fill('05:30'); await page.locator('input[type=time]').nth(1).fill('06:30');
  await page.evaluate(() => { const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === 'Speichern'); b.click(); b.click(); });
  await page.waitForTimeout(1500);
  const tours = (await j('/api/profile')).tours, added = tours.length - before;
  if (added !== 2) problems.push(`Double tap: ${added} routes created instead of 2 (outward + return)`);
  const outward = tours.find((t) => t.schedule.departAfter === '05:30');
  if (!outward || outward.schedule.departUntil !== '06:30') problems.push(`Double tap: outward trip does not have the typed commute time 05:30–06:30 (${outward ? outward.schedule.departAfter + '–' + outward.schedule.departUntil : 'missing'})`);
});

// Commute time (0.7.2): two sliders per direction (outward 04–12, return 12–20, in half hours since 0.8.5), also operable by keyboard and with typed times.
// The handles do not overtake each other (at least 10 minutes apart); when changing a route the commute time is saved and shown in the list.
await check('Commute time', async () => {
  const slider = (name) => page.getByRole('slider', { name });
  const read = (n) => page.locator('input[type=time]').nth(n).inputValue();
  const press = async (loc, key, n) => { await loc.focus(); for (let i = 0; i < n; i++) await page.keyboard.press(key); await page.waitForTimeout(150); };
  const dims = async () => (await page.locator('input[type=range]').evaluateAll((els) => els.map((e) => [e.min, e.max, e.step, e.value].join('/')))).join(' ');
  const expect = async (label, got, want) => { const g = await got; if (g !== want) problems.push(`Commute time: ${label}: "${g}" instead of "${want}"`); };
  await page.goto(base + '/Strecken'); await page.waitForTimeout(1000);
  await page.getByRole('button', { name: /Strecke hinzufügen/ }).click(); await page.waitForTimeout(400);
  await expect('sliders in the new form (min/max/step/value)', dims(), '240/720/30/420 240/720/30/480 720/1200/30/990 720/1200/30/1050');
  await expect('times in the new form', Promise.all([0, 1, 2, 3].map(read)).then((a) => a.join(' ')), '07:00 08:00 16:30 17:30');
  // Keyboard: two half hours earlier; it goes no further than shortly before the end
  await press(slider('Hinweg: Früheste Abfahrt'), 'ArrowLeft', 2);
  await expect('earliest departure after pressing ← twice', read(0), '06:00');
  await press(slider('Hinweg: Früheste Abfahrt'), 'ArrowRight', 30);
  await expect('earliest departure at the limit', Promise.all([read(0), read(1)]).then((a) => a.join(' ')), '07:30 08:00');
  await press(slider('Hinweg: Späteste Abfahrt'), 'ArrowLeft', 30);
  await expect('latest departure does not pass the start', read(1), '08:00');
  await press(slider('Hinweg: Späteste Abfahrt'), 'ArrowRight', 2);
  await expect('latest departure after pressing → twice', read(1), '09:00');
  // Typing a time: if the start lies beyond the end, the end moves along (the length stays); an end after 12:00 widens the slider
  await page.locator('input[type=time]').nth(0).fill('10:00');
  await expect('a start beyond the end moves the end along', Promise.all([read(0), read(1)]).then((a) => a.join(' ')), '10:00 11:30');
  await page.locator('input[type=time]').nth(1).fill('13:00');
  await expect('sliders after typing the end 13:00', dims().then((d) => d.split(' ').slice(0, 2).join(' ')), '240/780/30/600 240/780/30/780');
  await page.locator('input[type=time]').nth(1).fill('09:00');
  await expect('an end before the start moves the start along', Promise.all([read(0), read(1)]).then((a) => a.join(' ')), '06:00 09:00');
  await expect('sliders return to 04–12 after shortening', dims().then((d) => d.split(' ').slice(0, 2).join(' ')), '240/720/30/360 240/720/30/540');
  // Return trip: own range from 12:00, a half hour earlier
  await press(slider('Rückweg: Früheste Abfahrt'), 'ArrowLeft', 1);
  await expect('return trip earliest departure', read(2), '16:00');
  if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1)) problems.push('Commute time: form scrolls sideways');
  await page.getByRole('button', { name: 'Abbrechen' }).click(); await page.waitForTimeout(400);
  // Change route (own route with its own time so the order of the list does not matter): one card; end a half hour later, save, server and list have it
  const ing = (await j('/api/stations?q=Ingolstadt')).stations[0];
  const mine = (await j('/api/tours', 'POST', { from: mu, to: ing, schedule: { days: ['Mo', 'Di', 'Mi', 'Do', 'Fr'], departAfter: '05:00', departUntil: '06:00' } })).tours[0];
  try {
    await page.goto(base + '/Strecken'); await page.waitForTimeout(1000);
    await page.getByRole('button', { name: `${mine.name} ändern`, exact: true }).click(); await page.waitForTimeout(500);
    if ((await page.locator('input[type=range]').count()) !== 2) problems.push('Commute time: changing a route does not show exactly two sliders');
    await expect('times when changing', Promise.all([read(0), read(1)]).then((a) => a.join(' ')), '05:00 06:00');
    await press(slider('Späteste Abfahrt'), 'ArrowRight', 1);
    await expect('latest departure when changing', read(1), '06:30');
    await page.getByRole('button', { name: 'Speichern' }).click(); await page.waitForTimeout(900);
    const sch = (await j('/api/profile')).tours.find((t) => t.id === mine.id).schedule;
    if (sch.departAfter !== '05:00' || sch.departUntil !== '06:30') problems.push(`Commute time: saved ${sch.departAfter}–${sch.departUntil} instead of 05:00–06:30`);
    const list = await page.evaluate(() => document.querySelector('#screen').innerText);
    if (!list.includes('Mo–Fr · 05:00–06:30')) problems.push('Commute time: route list does not show "Mo–Fr · 05:00–06:30"');
  } finally { await fetch(base + '/api/tours/' + mine.id, { method: 'DELETE', headers: H }); }
});

// Undo: coordinates are kept
await check('Undo', async () => {
  const before = (await j('/api/profile')).tours;
  await page.goto(base + '/Strecken'); await page.waitForTimeout(1000);
  await page.getByRole('button', { name: /entfernen$/ }).first().click(); await page.waitForTimeout(900);
  if ((await j('/api/profile')).tours.length !== before.length - 1) problems.push('Remove: route is still on the server');
  await page.getByRole('button', { name: 'Rückgängig' }).click(); await page.waitForTimeout(1000);
  const after = (await j('/api/profile')).tours;
  if (after.length !== before.length) problems.push(`Undo: ${after.length} instead of ${before.length} routes`);
  const key = (t) => `${t.id}:${t.from.lat}:${t.from.lon}:${t.to.lat}:${t.to.lon}`;
  if (before.map(key).sort().join() !== after.map(key).sort().join()) problems.push('Undo: stop coordinates were lost');
});

// Refresh while an (old) query is still running: a new route must not get lost
await check('Refresh while creating', async () => {
  await page.goto(base + '/'); await page.waitForTimeout(1200);
  await page.evaluate(async () => { const R = window.REGO; R.searchStations('Freising'); await new Promise((r) => setTimeout(r, 900)); R.searchStations('München Hbf'); await new Promise((r) => setTimeout(r, 900)); });
  let first = true;
  await page.route('**/api/state**', async (route) => {
    if (!first) return route.continue();
    first = false; const old = await route.fetch(); await new Promise((r) => setTimeout(r, 1500)); await route.fulfill({ response: old });   // old state arrives late
  });
  const [n0, n1] = await page.evaluate(async () => {
    const R = window.REGO, n0 = R.tours.length, slow = R.refresh();
    await new Promise((r) => setTimeout(r, 250));
    await R.actions.addTour({ from: 'Freising', to: 'München Hbf', days: ['Sa'], time: '09:00', trip: 'one', backTime: '16:30' });
    await slow; return [n0, R.tours.length];
  });
  await page.unroute('**/api/state**');
  if (n1 !== n0 + 1) problems.push(`Refresh: ${n1} instead of ${n0 + 1} routes in the UI (old state overwrites)`);
});

// New phone: existing routes are replaced only after confirmation
await check('Apply code', async () => {
  const OTHER = { 'x-device': 'smokeother0123456789abcd', 'content-type': 'application/json' };
  await fetch(base + '/api/tours', { method: 'POST', headers: OTHER, body: JSON.stringify({ from: st, to: mu }) });
  const { code } = await (await fetch(base + '/api/transfer', { method: 'POST', headers: OTHER, body: '{}' })).json();
  const mine = (await j('/api/profile')).tours.length;
  await page.goto(base + '/Strecken#einstellungen'); await page.waitForTimeout(1000);
  await page.getByRole('button', { name: /Neues Handy/ }).click();
  await page.getByPlaceholder('Code eingeben').fill(code);
  await page.getByRole('button', { name: 'Übernehmen' }).click(); await page.waitForTimeout(500);
  if (!(await page.getByText('werden durch die vom alten Handy ersetzt').count())) problems.push('Apply code: no confirmation prompt');
  if ((await j('/api/profile')).tours.length !== mine) problems.push('Apply code: routes were replaced without confirmation');
  await page.getByRole('button', { name: 'Ja, ersetzen' }).click(); await page.waitForTimeout(1200);
  if ((await j('/api/profile')).tours.length !== 1) problems.push('Apply code: routes were not taken over after confirmation');
  if (!(await page.getByRole('switch', { name: 'Push-Meldungen' }).count())) problems.push('Routes: switch "Push-Meldungen" is missing');
});

// Small phone (320 × 568): card not cut off, onboarding reachable
await check('small phone', async () => {
  const small = await browser.newContext({ viewport: { width: 320, height: 568 }, isMobile: true, hasTouch: true });
  await small.addInitScript(([d]) => { try { if (!localStorage.getItem('rego.device')) { localStorage.setItem('rego.device', JSON.stringify(d)); localStorage.setItem('rego.onboarded', '1'); localStorage.setItem('rego.splashSeen', '1'); } } catch (e) {} }, [DEV]);
  const sp = await small.newPage();
  const tourId = (await j('/api/profile')).tours[0].id;
  await sp.goto(base + '/Detail#' + tourId + '-m'); await sp.waitForTimeout(1800);
  const cut = await sp.evaluate(() => [...document.querySelectorAll('span')].filter((e) => /rotate\(-45deg\)/.test(e.getAttribute('style') || '') && e.textContent.trim()).filter((e) => e.getBoundingClientRect().right > innerWidth + 1).map((e) => e.textContent));
  if (cut.length) problems.push(`Card (320 px): label sticks out over the edge: ${cut.join(', ')}`);
  await sp.goto(base + '/Onboarding1'); await sp.waitForTimeout(1200);
  const oy = await sp.evaluate(() => getComputedStyle(document.querySelector('#screen > div')).overflowY);
  if (oy !== 'auto') problems.push(`Onboarding (320 × 568): page cannot scroll (overflow-y: ${oy})`);
  // Commute time (sliders and times): nothing sticks out over the edge, the page does not scroll sideways – in onboarding and in the "Neue Strecke" form
  const outside = () => sp.evaluate(() => [...document.querySelectorAll('input[type=time], input[type=range], .rg-knob')].filter((e) => { const r = e.getBoundingClientRect(); return r.width && (r.left < -1 || r.right > innerWidth + 1); }).length);
  const wide = () => sp.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1);
  if (!(await sp.locator('input[type=range]').count())) problems.push('Onboarding (320 × 568): no sliders for the commute time');
  if (await outside() || await wide()) problems.push('Onboarding (320 × 568): sliders or times stick out over the edge');
  await sp.goto(base + '/Strecken'); await sp.waitForTimeout(1000);
  await sp.getByRole('button', { name: /Strecke hinzufügen/ }).click(); await sp.waitForTimeout(500);
  if (await outside() || await wide()) problems.push('"Neue Strecke" (320 × 568): sliders or times stick out over the edge');
  await small.close();
});

// Dark mode: sentence below the route list and settings sheet readable (contrast of text against background)
await check('Dark mode', async () => {
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
  const verdict = (where, rows) => { for (const [label, ratio] of rows) if (ratio < 4.5) problems.push(`Dark mode: ${where} "${label}" poorly readable${ratio ? ` (contrast ${ratio.toFixed(1)}:1)` : ' (not found)'}`); };
  await dp.goto(base + '/Strecken'); await dp.waitForTimeout(1500);
  verdict('route list', await contrast([['button', 'Push, neues Handy und Rückmeldung findest du in den Einstellungen'], ['span', 'Einstellungen']]));
  await dp.getByRole('button', { name: /Einstellungen/ }).first().click(); await dp.waitForTimeout(450);
  await dp.getByRole('button', { name: /Neues Handy/ }).click(); await dp.waitForTimeout(300);
  verdict('settings', await contrast([['h2', 'Einstellungen'], ['span', 'Push-Meldungen'], ['span', 'Push ab Verspätung von'], ['span', 'Testmeldung'], ['span', 'Neues Handy?'], ['button', 'Code erzeugen'], ['span', 'Rückmeldung senden']]));
  // the sheet stands out from the darkened background (not the same surface as the page behind it)
  const same = await dp.evaluate(() => { const d = document.querySelector('[role=dialog]'), r = document.querySelector('#screen > div'); return !d || getComputedStyle(d).backgroundColor === getComputedStyle(r).backgroundColor; });
  if (same) problems.push('Dark mode: settings sheet has the same surface as the page behind it');
  // Commute time in the "Neue Strecke" form: times readable, handles and bar stand out from the card (both cards: dark and orange)
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
  if (pz.length < 10) problems.push(`Dark mode: commute-time form incomplete (${pz.length} parts found)`);
  for (const [label, r, need] of pz) if (r < need) problems.push(`Dark mode: commute time "${label}" hard to make out (contrast ${r.toFixed(1)}:1)`);
  await dark.close();
});

// Delay + replacement transport on the same route: two cards in "Meldungen", one shared route page, the tapped one on top
await check('Several incidents on one route', async () => {
  const sa = (await j('/api/stations?q=Salzburg')).stations[0];
  await j('/api/tours', 'POST', { from: mu, to: sa });
  const tour = (await j('/api/profile')).tours.find((t) => t.from.id === mu.id && t.to.id === sa.id);
  const incs = (await j('/api/state')).incidents.filter((i) => i.tourId === tour.id);
  const kinds = incs.map((i) => i.kind).sort().join();
  if (kinds !== 'delay,replacement') throw new Error(`Sample data returns ${kinds || 'nothing'} instead of delay + replacement transport`);
  await page.goto(base + '/Meldungen'); await page.waitForTimeout(1200);
  const cards = page.locator(`a[href^="Detail.dc.html#${tour.id}-l-"]`);
  if ((await cards.count()) !== 2) problems.push(`Incidents: ${await cards.count()} cards for the route instead of 2 (one per incident)`);
  const order = async () => { const t = await page.evaluate(() => document.body.innerText); return [t.indexOf('Verspätung ·'), t.indexOf('Ersatzverkehr ·')]; };
  await cards.filter({ hasText: 'Verspätung' }).first().click(); await page.waitForTimeout(1200);
  let [d, e] = await order();
  if (!(page.url().includes('/Detail#' + tour.id + '-l-'))) problems.push('Incidents: card does not lead to the route page');
  if (d < 0 || e < 0 || d > e) problems.push('Route page: tapped delay is not on top or the second incident is missing');
  await page.goto(base + '/Meldungen'); await page.waitForTimeout(800);
  await page.locator(`a[href^="Detail.dc.html#${tour.id}-l-"]`).filter({ hasText: 'Ersatzverkehr' }).first().click(); await page.waitForTimeout(1200);
  [d, e] = await order();
  if (d < 0 || e < 0 || e > d) problems.push('Route page: tapped replacement transport is not on top or the second incident is missing');
  // Number on the incidents button = number of cards under "Meldungen"
  await page.goto(base + '/Meldungen'); await page.waitForTimeout(800);
  const nCards = await page.locator('a[href^="Detail.dc.html#"]').count();
  await page.goto(base + '/'); await page.waitForTimeout(1200);
  const badge = await page.evaluate(() => { const b = [...document.querySelectorAll('span')].find((x) => /D4001A|rgb\(212, 0, 26\)/i.test(x.getAttribute('style') || '') && /^\d+$/.test(x.textContent.trim())); return b ? Number(b.textContent) : 0; });
  if (badge !== nCards) problems.push(`Number on the incidents button (${badge}) does not match the ${nCards} cards under "Meldungen"`);
  // An incident that no longer exists (old push notification): honest display, nothing from another route
  await page.goto(base + '/Detail#iunbekannt1-m'); await page.waitForTimeout(1200);
  const gone = await page.evaluate(() => document.body.innerText);
  if (!/Beendet/.test(gone) || /RE 5|S1|Freising/.test(gone)) problems.push('Route page: unknown incident shows no honest display');
});

// Route without a direct connection (sample data: Freising → Salzburg does not exist): honest display instead of "Alles pünktlich", the route stays visible
await check('Route without a direct connection (existing)', async () => {
  const sa = (await j('/api/stations?q=Salzburg')).stations[0];
  const mk = async (dev) => {
    const c = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    await c.addInitScript(([d]) => { try { if (!localStorage.getItem('rego.device')) { localStorage.setItem('rego.device', JSON.stringify(d)); localStorage.setItem('rego.onboarded', '1'); localStorage.setItem('rego.splashSeen', '1'); } } catch (e) {} }, [dev]);
    // Creating anew is rejected by the server since 0.6.0 (422); routes from older versions or after a timetable change still exist, though
    const post = (to) => store.update(dev, (p) => { addTours(p, { from: st, to }); });
    return { c, post, pg: await c.newPage() };
  };
  const text = (pg) => pg.evaluate(() => document.querySelector('#screen').innerText);
  // A: only the route without a direct connection
  const a = await mk('smokeleera0123456789abcd');
  await a.post(sa);
  await a.pg.goto(base + '/'); await a.pg.waitForTimeout(1800);
  let t = await text(a.pg);
  if (/Alles pünktlich|Pünktlich/.test(t)) problems.push('Without direct connection: main screen says "pünktlich"');
  if (!/Nächste Abfahrt/.test(t) || !/Keine Direktverbindung/.test(t)) problems.push('Without direct connection: main screen does not explain why there is no departure');
  if (/ · \s*(\n|$)|\s·\s*·/.test(t)) problems.push('Without direct connection: dangling separator dot on the main screen');
  await a.pg.goto(base + '/Strecken'); await a.pg.waitForTimeout(1200);
  t = await text(a.pg);
  if (!/Keine Direktverbindung/.test(t)) problems.push('Without direct connection: route list has no hint');
  const tid = (await (await fetch(base + '/api/profile', { headers: { 'x-device': 'smokeleera0123456789abcd' } })).json()).tours[0].id;
  await a.pg.goto(base + '/Detail#' + tid + '-m'); await a.pg.waitForTimeout(1500);
  t = await text(a.pg);
  if (/Beendet|nicht mehr aktuell/.test(t)) problems.push('Without direct connection: detail page says "Beendet"');
  if (!/Keine Direktverbindung/.test(t)) problems.push('Without direct connection: detail page explains nothing');
  const dot = await a.pg.evaluate(() => [...document.querySelectorAll('span')].filter((e) => /min-width: 34px/.test(e.getAttribute('style') || '') && getComputedStyle(e).display !== 'none' && !e.textContent.trim()).length);
  if (dot) problems.push('Without direct connection: detail page shows an empty line dot');
  await a.c.close();
  // B: normal route first, the one without a direct connection still stays in the list on the main screen
  const b = await mk('smokeleerb0123456789abcd');
  await b.post(mu); await b.post(sa);
  await b.pg.goto(base + '/'); await b.pg.waitForTimeout(1800);
  t = await text(b.pg);
  if (!/Salzburg/.test(t) || !/keine Abfahrt/.test(t)) problems.push('Without direct connection: route is missing from the list on the main screen');
  await b.c.close();
});

// Font: Instrument Sans comes from our own server (both weights load, no error)
await check('Font', async () => {
  await page.goto(base + '/'); await page.waitForTimeout(1200);
  const faces = await page.evaluate(async () => {
    const fs = [...document.fonts].filter((x) => x.family.replace(/["']/g, '') === 'Instrument Sans');
    await Promise.all(fs.map((f) => f.load().catch(() => null)));
    return fs.map((f) => `${f.weight}:${f.status}`);
  });
  if (faces.length !== 2 || faces.some((f) => !f.endsWith(':loaded'))) problems.push(`Font: Instrument Sans not loaded (${faces.join(', ') || 'no font faces'})`);
});


// ---------- New in 0.6.0 ----------
const NEW_CTX = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true };
const initFor = (extra = '') => ([d]) => { try { localStorage.setItem('rego.device', JSON.stringify(d)); localStorage.setItem('rego.onboarded', '1'); localStorage.setItem('rego.splashSeen', '1'); } catch (e) {} };
// Is the icon next to the big line (same row, inside the card) and not below it? sel = card, svg = icon inside it
const beside = (pg, sel, svgSel = 'svg') => pg.evaluate(([sel, svgSel]) => {
  // sel = null: card is the parent element of the icon (detail page)
  const svg0 = sel ? null : document.querySelector(svgSel), a = sel ? document.querySelector(sel) : svg0 && svg0.parentElement;
  const svg = sel ? a && a.querySelector(svgSel) : svg0, col = a && a.firstElementChild;
  if (!svg || !col) return false;
  const s = svg.getBoundingClientRect(), c = col.getBoundingClientRect(), r = a.getBoundingClientRect();
  return s.top < c.bottom - 4 && s.left >= c.right - 2 && s.right <= r.right + 1;
}, [sel, svgSel]);

// New route without a direct connection (T2): is not created, the reason is shown in the form, changing the stop hides it
await check('Create without direct connection', async () => {
  expect422 = true;
  try {
  const before = (await j('/api/profile')).tours.length;
  await page.goto(base + '/Strecken'); await page.waitForTimeout(1000);
  await page.getByRole('button', { name: /Strecke hinzufügen/ }).click();
  await suggest(0, 'Freis'); await suggest(1, 'Salzb');
  await page.getByRole('button', { name: 'Speichern' }).click(); await page.waitForTimeout(1200);
  const alert = page.getByRole('alert').filter({ hasText: 'keine Direktverbindung gefunden' });
  if (!(await alert.count())) problems.push('Create without direct connection: no explanation in the form');
  if (!(await page.getByRole('button', { name: 'Abbrechen' }).count())) problems.push('Create without direct connection: form was closed');
  if ((await j('/api/profile')).tours.length !== before) problems.push('Create without direct connection: route was created anyway');
  const to = page.locator('input[type=text]').nth(1); await to.fill('');
  await to.pressSequentially('Münch', { delay: 40 }); await page.waitForTimeout(900);
  if (await alert.count()) problems.push('Create without direct connection: explanation stays after changing the stop');
  if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1)) problems.push('Create without direct connection: page scrolls sideways');
  } finally { expect422 = false; }
});

// Test notification and version line under "Strecken". The Android bridge is faked so that push counts as "on".
await check('Test notification and version line', async () => {
  const ver = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
  await j('/api/push/native', 'PUT', {});
  const c = await browser.newContext(NEW_CTX);
  await c.addInitScript(([d]) => { try { localStorage.setItem('rego.device', JSON.stringify(d)); localStorage.setItem('rego.onboarded', '1'); localStorage.setItem('rego.splashSeen', '1'); localStorage.setItem('rego.push', 'true'); } catch (e) {} window.RegoNative = { appVersion: () => '9.9.9', enablePush() {}, disablePush() {}, setBars() {}, setBrightness() {}, keepScreenOn() {}, saveFile() {} }; }, [DEV]);
  const p = await c.newPage(); p.setDefaultTimeout(8000);
  try {
    await p.goto(base + '/Strecken#einstellungen'); await p.waitForTimeout(1500);
    const text = await p.evaluate(() => document.querySelector('#screen').innerText);
    if (!text.includes(`App 9.9.9 · Server ${ver}`)) problems.push(`Version line: expected "App 9.9.9 · Server ${ver}", found: ${(text.match(/(App [^\n]*)?Server [^\n]*/) || ['nothing'])[0]}`);
    for (const [href, label] of [['https://github.com/K0RBI02/ReGo/blob/main/PRIVACY.md', 'Datenschutz'], ['https://github.com/K0RBI02/ReGo', 'ReGo auf GitHub']]) {
      const a = p.locator(`a[href="${href}"]`);
      if (!(await a.count()) || (await a.getAttribute('target')) !== '_blank' || !(await a.innerText()).includes(label)) problems.push(`Version line: link "${label}" is missing or does not open in a new window`);
    }
    if (!/Prüft, ob Meldungen bei dir ankommen/.test(text)) problems.push('Test notification: hint text is missing with push switched on');
    await p.getByRole('button', { name: 'Senden' }).click(); await p.waitForTimeout(1000);
    if (!(await p.getByText('Testmeldung angefordert').count())) problems.push('Test notification: no feedback after tapping');
    const got = (await j('/api/notifications')).notifications;
    if (!got.some((n) => n.kind === 'test' && n.title === 'ReGo Testmeldung')) problems.push('Test notification: server did not prepare a test notification');
    // Push off (without app bridge): button greyed out, hint says what to do
    const q = await browser.newContext(NEW_CTX); await q.addInitScript(initFor(), [DEV]);
    const pq = await q.newPage(); await pq.goto(base + '/Strecken#einstellungen'); await pq.waitForTimeout(1200);
    const off = await pq.evaluate(() => { const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === 'Senden'); return b ? b.getAttribute('aria-disabled') : 'fehlt'; });
    if (off !== 'true') problems.push(`Test notification: button is not disabled without push (aria-disabled=${off})`);
    if (!(await pq.getByText('Schalte zuerst Push-Meldungen ein').count())) problems.push('Test notification: hint "Schalte zuerst Push-Meldungen ein" is missing');
    await q.close();
  } finally { await c.close(); }
});

// Commute time on the main screen: the route whose window is running now is on top (even if it was created later); a route that is not commuted
// today still shows its next trains. If the window is still far away, it says "planmäßig" instead of "pünktlich".
await check('Commute time on the main screen', async () => {
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
      addTours(p, { from: st, to: mu, schedule: { days: ALL.filter((d) => d !== today), departAfter: '07:00', departUntil: '08:00' } });          // no commute day today, created first
      addTours(p, { from: mu, to: st, schedule: { days: ALL, departAfter: hm(Math.max(0, nowMin - 5)), departUntil: hm(Math.min(24 * 60 - 1, nowMin + 55)) } });   // window running
    });
    const m = (await modes(dev)).join(' | ');
    if (m !== `${mu.name} → ${st.name}=now | ${st.name} → ${mu.name}=off`) problems.push(`Commute time: order and state in the app state: ${m}`);
    const text = await screen(dev), iNow = text.indexOf(`${mu.name} → ${st.name}`), iOff = text.indexOf(`${st.name} → ${mu.name}`);
    if (iNow < 0 || iOff < 0 || iNow > iOff) problems.push('Commute time: main screen does not show the route with the running window on top');
    else if (!/(S1|RE \d)/.test(text.slice(iOff))) problems.push('Commute time: route without a commute day today shows no next trains');
  }
  if (nowMin + 150 <= 23 * 60 + 59) {
    const dev = 'smokeweitweg0123456789abcd';
    await store.update(dev, (p) => { addTours(p, { from: st, to: mu, schedule: { days: ALL, departAfter: hm(nowMin + 90), departUntil: hm(nowMin + 150) } }); });
    const text = await screen(dev);
    if (!/planmäßig/.test(text) || /pünktlich/i.test(text)) problems.push(`Commute time: trip in over 45 minutes is not called "planmäßig" (${text.replace(/\s+/g, ' ').slice(0, 120)})`);
  }
});

// Settings as a sheet from below: push, "Neues Handy?", feedback and version are no longer in the route list. The sentence at the end of the list
// opens it; ✕, dimming, Escape and the back button close the sheet first, without rebuilding the page.
await check('Settings sheet', async () => {
  const H = 844;
  const c = await browser.newContext(NEW_CTX); await c.addInitScript(initFor(), [DEV]);
  const p = await c.newPage(); p.setDefaultTimeout(8000);
  const dlg = p.getByRole('dialog', { name: 'Einstellungen' });
  const open = async () => { await p.getByRole('button', { name: /Einstellungen/ }).first().click(); await p.waitForTimeout(450); };
  try {
    await p.goto(base + '/Strecken'); await p.waitForTimeout(1300);
    await p.evaluate(() => { document.querySelector('#screen > div').__keep = 1; });           // marker: stays only as long as the page is not rebuilt
    const len0 = await p.evaluate(() => history.length);
    // List: only the sentence, nothing of the settings
    if (!(await p.getByRole('button', { name: /findest du in den Einstellungen/ }).count())) { problems.push('Settings: sentence "… findest du in den Einstellungen" is missing under the route list'); return; }
    if (await p.getByRole('switch', { name: 'Push-Meldungen' }).count()) problems.push('Settings: push switch is still in the route list');
    if (await p.getByText('Rückmeldung senden').count() || await p.getByPlaceholder('Code eingeben').count()) problems.push('Settings: "Neues Handy?" or feedback are still in the route list');
    if (await dlg.count()) problems.push('Settings: sheet is open although nobody tapped');
    // Opening: from below, 90 % at most, everything important there, focus in the sheet
    await open();
    if (!(await dlg.count())) { problems.push('Settings: tapping the sentence does not open a sheet'); return; }
    const box = await dlg.boundingBox();
    if (Math.abs(box.y + box.height - H) > 1) problems.push(`Settings: sheet is not at the very bottom (bottom edge ${Math.round(box.y + box.height)} instead of ${H})`);
    if (box.height > H * 0.9 + 1 || box.height < H * 0.4) problems.push(`Settings: sheet has an unsuitable height (${Math.round(box.height)} of ${H} px)`);
    if (!/#einstellungen$/.test(p.url())) problems.push('Settings: opened sheet has no history entry of its own (Back would leave the page)');
    for (const [role, name] of [['switch', 'Push-Meldungen'], ['button', '3 Min.'], ['button', '5 Min.'], ['button', '10 Min.'], ['button', 'Senden'], ['button', /Neues Handy/], ['button', 'Schließen']]) {
      if (!(await dlg.getByRole(role, { name }).count())) problems.push(`Settings: "${name}" is missing in the sheet`);
    }
    if (await dlg.getByRole('switch', { name: /Nur rund um die Abfahrt/ }).count()) problems.push('Settings: the switch "Nur rund um die Abfahrt" is still in the sheet (push now follows the commute time of the route)');
    if (!(await dlg.locator('a[href^="https://github.com/K0RBI02/ReGo/issues/new"]').count())) problems.push('Settings: link "Rückmeldung senden" is missing in the sheet');
    if (!(await dlg.evaluate((el) => el.contains(document.activeElement)))) problems.push('Settings: focus is not inside the sheet after opening');
    if (await p.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1)) problems.push('Settings: page scrolls sideways');
    // Operating inside the sheet: the hint appears on top (not above the settings), the sheet is not rebuilt in the process
    await dlg.evaluate((el) => { el.__keep = 1; });
    await dlg.getByRole('button', { name: '10 Min.' }).click(); await p.waitForTimeout(700);
    const toast = p.locator('.rg-toast');
    if (!(await toast.count())) problems.push('Settings: no feedback after toggling');
    else { const tb = await toast.boundingBox(), db = await dlg.boundingBox(); if (tb.y + tb.height > db.y + 1) problems.push('Settings: notice covers the settings (it should sit above the sheet)'); }
    if (!(await dlg.evaluate((el) => el.__keep === 1))) problems.push('Settings: sheet is rebuilt when toggling (scroll position and focus are lost)');
    await dlg.getByRole('button', { name: '5 Min.' }).click(); await p.waitForTimeout(400);   // back to the default threshold
    // "Neues Handy?" unfolds, the sheet grows to 90 % at most and scrolls; feedback and version stay reachable
    await dlg.getByRole('button', { name: /Neues Handy/ }).click(); await p.waitForTimeout(300);
    if ((await dlg.getByRole('button', { name: /Neues Handy/ }).getAttribute('aria-expanded')) !== 'true') problems.push('Settings: "Neues Handy?" does not report itself as expanded');
    if (!(await dlg.getByPlaceholder('Code eingeben').count())) problems.push('Settings: "Neues Handy?" shows no code input after expanding');
    const big = await dlg.boundingBox();
    if (big.height > H * 0.9 + 1 || big.y < 0) problems.push(`Settings: expanded sheet is too tall (${Math.round(big.height)} px)`);
    const fb = dlg.getByText('Rückmeldung senden'); await fb.scrollIntoViewIfNeeded();
    const fbb = await fb.boundingBox();
    if (fbb.y + fbb.height > H || fbb.y < 0) problems.push('Settings: "Rückmeldung senden" is not reachable after expanding');
    await dlg.getByRole('link', { name: 'ReGo auf GitHub' }).scrollIntoViewIfNeeded();
    // Back button (Android): closes only the sheet, stays on the page, does not rebuild it
    await p.goBack(); await p.waitForTimeout(500);
    if (await dlg.count()) problems.push('Settings: Back does not close the sheet');
    if (!/\/Strecken$/.test(p.url())) problems.push(`Settings: Back lands on ${p.url()} instead of the route list`);
    if (!(await p.evaluate(() => document.querySelector('#screen > div').__keep === 1))) problems.push('Settings: Back rebuilds the route list');
    // ✕, dimming (also via the page's "Zurück" button) and Escape close; the history does not grow in the process
    for (const [how, close] of [
      ['✕', () => p.getByRole('button', { name: 'Schließen' }).click()],
      ['dimming', () => p.mouse.click(60, 40)],
      ['Escape', () => p.keyboard.press('Escape')],
    ]) {
      await open();
      if (!(await dlg.count())) { problems.push(`Settings (${how}): sheet does not open again`); continue; }
      await close(); await p.waitForTimeout(500);
      if (await dlg.count()) problems.push(`Settings: ${how} does not close the sheet`);
      if (/#einstellungen/.test(p.url()) || !/\/Strecken$/.test(p.url())) problems.push(`Settings (${how}): address after closing is ${p.url()}`);
      if (!(await p.evaluate(() => document.activeElement && document.activeElement.hasAttribute('data-sheet-open')))) problems.push(`Settings (${how}): focus does not return to the sentence in the list`);
    }
    if ((await p.evaluate(() => history.length)) > len0 + 1) problems.push('Settings: opening and closing adds to the history');
    // Direct call with #einstellungen (e.g. from a shortcut): sheet open, back closes the sheet first
    const q = await c.newPage(); q.setDefaultTimeout(8000);
    await q.goto(base + '/Strecken#einstellungen'); await q.waitForTimeout(1300);
    if (!(await q.getByRole('dialog', { name: 'Einstellungen' }).count())) problems.push('Settings: #einstellungen does not open the sheet');
    await q.goBack(); await q.waitForTimeout(500);
    if (await q.getByRole('dialog', { name: 'Einstellungen' }).count() || !/\/Strecken$/.test(q.url())) problems.push(`Settings: Back after a direct visit does not close only the sheet (${q.url()})`);
    await q.goForward(); await q.waitForTimeout(500);
    if (!(await q.getByRole('dialog', { name: 'Einstellungen' }).count())) problems.push('Settings: Forward does not reopen the sheet');
    await q.close();
  } finally { await c.close(); }
  // Small phone (320 × 568): sheet stays in view, everything reachable by scrolling, nothing runs over sideways
  const sc = await browser.newContext({ viewport: { width: 320, height: 568 }, isMobile: true, hasTouch: true }); await sc.addInitScript(initFor(), [DEV]);
  try {
    const sp = await sc.newPage(); sp.setDefaultTimeout(8000);
    await sp.goto(base + '/Strecken#einstellungen'); await sp.waitForTimeout(1300);
    const sd = sp.getByRole('dialog', { name: 'Einstellungen' });
    await sd.getByRole('button', { name: /Neues Handy/ }).click(); await sp.waitForTimeout(300);
    const sb = await sd.boundingBox();
    if (sb.height > 568 * 0.9 + 1) problems.push(`Settings (320 × 568): sheet too tall (${Math.round(sb.height)} px)`);
    if (!(await sd.evaluate((el) => el.scrollHeight > el.clientHeight))) problems.push('Settings (320 × 568): expanded sheet does not scroll');
    const out = await sp.evaluate(() => [...document.querySelectorAll('[role=dialog] *')].filter((e) => e.getBoundingClientRect().right > innerWidth + 1 && getComputedStyle(e).display !== 'none').map((e) => e.textContent.trim().slice(0, 20) || e.tagName));
    if (out.length) problems.push(`Settings (320 × 568): sticks out over the edge: ${out.slice(0, 3).join(', ')}`);
    if (await sp.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1)) problems.push('Settings (320 × 568): page scrolls sideways');
  } finally { await sc.close(); }
});

// Invitation code: mask over the app, wrong code is rejected, right one opens; afterwards everything works
await check('Invitation code', async () => {
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
    if (!(await gate.count())) { problems.push('Invitation code: no gate for a new device'); return; }
    await gate.locator('[data-go]').click(); await p.waitForTimeout(300);
    if (!/Bitte den Code eingeben/.test(await gate.innerText())) problems.push('Invitation code: empty input is not rejected');
    await gate.locator('[data-code]').fill('falsch'); await gate.locator('[data-go]').click(); await p.waitForTimeout(900);
    if (!/stimmt nicht/.test(await gate.innerText())) problems.push('Invitation code: wrong code is not rejected');
    await gate.locator('[data-code]').fill('  ostern26 '); await gate.locator('[data-code]').press('Enter'); await p.waitForTimeout(1800);
    if (await p.locator('.rg-gate').count()) problems.push('Invitation code: gate stays after the correct code');
    if (await p.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1)) problems.push('Invitation code: page scrolls sideways');
    // with the code creating a route works (header is sent along)
    await p.goto(b2 + '/Strecken'); await p.waitForTimeout(1200);
    if (await p.locator('.rg-gate').count()) problems.push('Invitation code: gate comes back after reloading');
    const r = await p.evaluate(async () => { try { await window.REGO.actions.addTour({ from: 'Freising', to: 'Freising', days: ['Mo'], time: '07:00', trip: 'one', backTime: '16:30' }); return 'ok'; } catch (e) { return e.message; } });
    if (/Einladungscode/.test(r)) problems.push('Invitation code: creating a route asks for a code again despite the saved code');
  } finally { await c.close(); s2.close(); }
});

// End of onboarding with a route without a direct connection: nothing is created, the main page says why (instead of empty and silent)
await check('Onboarding without a direct connection', async () => {
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
    if (!/keine Direktverbindung gefunden/.test(t)) problems.push('Onboarding without a direct connection: page does not name the reason');
    const n = (await (await fetch(base + '/api/profile', { headers: { 'x-device': dev, 'content-type': 'application/json' } })).json()).tours.length;
    if (n !== 0) problems.push(`Onboarding without a direct connection: ${n} route(s) created`);
  } finally { expect422 = false; await c.close(); }
});

// Platform change (sample data: the next train runs on platform 3 instead of 2) appears as its own card under "Meldungen"
await check('Platform change in incidents', async () => {
  await page.goto(base + '/Meldungen'); await page.waitForTimeout(1500);
  const t = await page.evaluate(() => document.querySelector('#screen').innerText);
  if (!/Gleiswechsel/.test(t)) problems.push('Incidents: no "Gleiswechsel" card'); else if (!/Gl\. ?3/.test(t)) problems.push('Incidents: "Gleiswechsel" card does not name the new platform');
});

// Cancellation in the UI: the state is produced by the real build (buildTour) and slipped to the page
await check('Cancellation in the UI', async () => {
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
    if (!/Fällt aus/.test(t)) problems.push('Cancellation: main screen does not show "Fällt aus"');
    if (!(await beside(page, '#screen a.rg-in'))) problems.push('Cancellation: check mark slips below "Fällt aus" on the main screen');
    if (!/Ausfall · S ?1 ab/.test(t) || !/Stattdessen/.test(t)) problems.push('Cancellation: main screen does not name the cancelled trip or the next trip');
    await page.goto(base + '/Meldungen'); await page.waitForTimeout(1400);
    t = await page.evaluate(() => document.querySelector('#screen').innerText);
    if (!/Ausfall/.test(t)) problems.push('Cancellation: no card under "Meldungen"');
    if (!/Fahrten um \d\d:\d\d und \d\d:\d\d fallen aus/.test(t)) problems.push('Cancellation: card under "Meldungen" does not name the cancelled trips');
    await page.locator('a[href^="Detail.dc.html#"]').filter({ hasText: 'Ausfall' }).first().click(); await page.waitForTimeout(1400);
    t = await page.evaluate(() => document.querySelector('#screen').innerText);
    if (!/entfällt/.test(t) || !/Stattdessen/.test(t)) problems.push('Cancellation: route page does not show "entfällt" or the next trip');
    if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1)) problems.push('Cancellation: route page scrolls sideways');
  } finally { await page.unroute('**/api/state**'); }
});

// Main screen: the icon stays next to the big line (also on narrow phones). Detail page: "Danach" leads to the next departure of the list.
await check('Hero line and "Danach"', async () => {
  const prof = (await j('/api/profile')).tours;
  const iso = (min) => new Date(Date.now() + min * 60000).toISOString();
  const mk = (t, min, o = {}) => ({ line: { name: 'S 1', product: 'suburban' }, direction: t.to.name, origin: t.from, destination: t.to, plannedDep: iso(min), dep: iso(min), depDelay: 0, plannedArr: iso(min + 40), arr: iso(min + 40), arrDelay: 0, plannedPlatform: '2', platform: '2', stopovers: [], remarks: [], ...o });
  // four trips per route: on time, +2 min (below the threshold), on time, on time. The fourth has no detail page of its own (only the first three).
  // All routes get the same trips: which route is on top depends on time of day and location.
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
      if (!(await beside(pg, '#screen a.rg-in'))) problems.push(`Main screen (${w} px): check mark slips below the hero line`);
      const big = await pg.evaluate(() => { const a = document.querySelector('#screen a.rg-in'), t = a.querySelector('span[style*="nowrap"]'); return t ? { text: t.textContent.trim(), px: parseFloat(getComputedStyle(t).fontSize), over: t.getBoundingClientRect().right > a.getBoundingClientRect().right } : null; });
      if (!big || big.over) problems.push(`Main screen (${w} px): hero line sticks out over the card`);
      if (!big || big.text !== 'pünktlich') problems.push(`Main screen (${w} px): expected "pünktlich" (injected state), found: ${big && big.text}`);
      if (w === 390 && big && !(big.px >= 44 && big.px <= 58)) problems.push(`Main screen: hero line has an unsuitable size (${big.px} px)`);
      if (w === 390) {
        const times = await pg.locator('a.rg-dep').evaluateAll((els) => els.map((e) => e.querySelector('span').textContent.trim()));
        if (times.length !== 3) { problems.push(`Danach: departure list has ${times.length} rows instead of 3`); continue; }
        // Page of the first departure: "Danach" is a link to the second, there to the third; the third has no link any more (fourth trip without detail page)
        await pg.locator('a.rg-dep').nth(0).click(); await pg.waitForTimeout(1200);
        const danach = () => pg.locator('a[href^="Detail.dc.html#"]').filter({ hasText: 'Danach' });
        if (!(await beside(pg, null, '#screen svg[width="72"]'))) problems.push('Detail page: check mark slips below the hero line');
        if ((await danach().count()) !== 1) { problems.push('Danach: on the page of the first departure "Danach" is not a link'); continue; }
        await danach().click(); await pg.waitForTimeout(1200);
        if (!/\.1-m$/.test(pg.url()) && !/\.1-m/.test(await pg.evaluate(() => location.hash))) problems.push(`Danach: leads to ${pg.url()} instead of the second departure`);
        if (!(await pg.evaluate(() => document.querySelector('#screen').innerText)).includes(times[1])) problems.push(`Danach: page of the second departure does not show ${times[1]}`);
        await pg.goBack(); await pg.waitForTimeout(900);
        if (!(await pg.evaluate(() => document.querySelector('#screen').innerText)).includes(times[0])) problems.push('Danach: Back does not lead to the first departure');
        await danach().click(); await pg.waitForTimeout(900);
        await danach().click(); await pg.waitForTimeout(1200);
        if (!(await pg.evaluate(() => document.querySelector('#screen').innerText)).includes(times[2])) problems.push(`Danach: page of the third departure does not show ${times[2]}`);
        if (await danach().count() || !(await pg.getByText('Danach').count())) problems.push('Danach: on the third departure "Danach" should be there but without a link (the fourth has no detail page)');
        // Tapping the big card (route) shows "Danach" with a link to the second departure
        await pg.goto(base + '/'); await pg.waitForTimeout(1500);
        await pg.locator('#screen a.rg-in').first().click(); await pg.waitForTimeout(1200);
        if ((await pg.locator('a[href$=".1-m"]').filter({ hasText: 'Danach' }).count()) !== 1) problems.push('Danach: route page (big card) does not link "Danach" to the second departure');
      }
      if (await pg.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1)) problems.push(`Main screen/detail (${w} px): page scrolls sideways`);
    } finally { await c.close(); }
  }
});

// ---------- New in 0.7.0: trips with 1 transfer ----------
// Own devices so that the routes of the cases above stay unchanged.
const jx = async (dev, p, m = 'GET', b) => (await fetch(base + p, { method: m, headers: { 'x-device': dev, 'content-type': 'application/json' }, body: b ? JSON.stringify(b) : undefined })).json();
const watch = (pg) => {
  pg.on('pageerror', (e) => problems.push(`${where}: JavaScript error: ${e.message}`));
  pg.on('console', (m) => { if (m.type() === 'error' && !ignore(m.text())) problems.push(`${where}: console: ${m.text().slice(0, 200)}`); });
  pg.on('response', (r) => { if (r.status() >= 400 && !ignore(r.url())) problems.push(`${where}: HTTP ${r.status()} ${r.url()}`); });
};
const suggestOn = async (pg, n, text) => { const i = pg.locator('input[type=text]').nth(n); await i.click(); await i.fill(''); await i.pressSequentially(text, { delay: 40 }); await pg.waitForTimeout(1400); await pg.getByRole('option').first().click(); };
const sideways = (pg) => pg.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1);
// Contrast of text against background (nearest non-transparent ancestor).
// items = [[tag, text], …] returns [[text, ratio], …] (0 = not found); root = selection returns all visible texts below it with contrast under min.
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
    if (ratio < min) bad.push(`"${own.slice(0, 28)}" ${ratio.toFixed(1)}:1`);
  }
  return bad;
}, { items: args.items || null, root: args.root || '', min: args.min || 4.5 });
const contrastOf = (pg, items) => contrastScan(pg, { items });
const lowContrast = (pg, root, min = 4.5) => contrastScan(pg, { root, min });

// Creating: no direct connection → "Mit 1 Umstieg suchen" → preview (two lines, transfer station) → saving creates outward and return trip with a transfer
await check('Create with transfer', async () => {
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
    // 1) Save: nothing is created, the explanation is in the form and offers the search with 1 transfer
    await save();
    if (!(await hint().count())) { problems.push('Create with transfer: no explanation in the form'); return; }
    if (!(await find().count())) { problems.push('Create with transfer: button "Mit 1 Umstieg suchen" is missing under the explanation'); return; }
    if ((await jx(XD, '/api/profile')).tours.length) problems.push('Create with transfer: route was already created before the search');
    // 2) Search: preview with both lines and the transfer station; the red hint goes away
    await find().click(); await p.waitForTimeout(2500);
    if (!(await card().count())) { problems.push('Create with transfer: no preview after the search'); return; }
    const t = await card().innerText();
    if (!/München Hbf/.test(t) || !/S ?1/.test(t) || !/RE ?5/.test(t) || !/Umstieg München Hbf · \d+ Min\./.test(t)) problems.push(`Create with transfer: preview does not name lines and transfer (${t.replace(/\s+/g, ' ').slice(0, 120)})`);
    if (await hint().count()) problems.push('Create with transfer: red notice stays after a connection was found');
    if (await sideways(p)) problems.push('Create with transfer: page scrolls sideways (preview)');
    // 3) Change the stop: the preview no longer applies
    await p.locator('input[type=text]').nth(1).fill(''); await p.waitForTimeout(500);
    if (await card().count()) problems.push('Create with transfer: preview stays after changing the stop');
    await suggestOn(p, 1, 'Salzb');
    await save();
    if (!(await find().count())) { problems.push('Create with transfer: button is missing again after the change'); return; }
    await find().click(); await p.waitForTimeout(2500);
    if (!(await card().count())) { problems.push('Create with transfer: second search yields no preview'); return; }
    // 4) Save with preview: outward and return trip, both with a transfer; the list names transfer and station
    await save(); await p.waitForTimeout(600);
    const tours = (await jx(XD, '/api/profile')).tours;
    if (tours.length !== 2 || tours.some((x) => x.transfers !== 1)) problems.push(`Create with transfer: ${tours.length} route(s) with transfer ${tours.map((x) => x.transfers).join('/')} instead of 2 × 1`);
    await p.goto(base + '/Strecken'); await p.waitForTimeout(1800);
    const list = await p.evaluate(() => document.querySelector('#screen').innerText);
    if (!/1 Umstieg · meist München Hbf/.test(list)) problems.push(`Create with transfer: route list does not name "1 Umstieg · meist München Hbf" (${list.replace(/\s+/g, ' ').slice(0, 160)})`);
    if (await sideways(p)) problems.push('Create with transfer: route list scrolls sideways');
    // 5) Without a connection even with a transfer (Passau → Wien does not exist in the sample data): honest sentence, no button any more
    await p.getByRole('button', { name: /Strecke hinzufügen/ }).click();
    await suggestOn(p, 0, 'Passau'); await suggestOn(p, 1, 'Wien');
    await save();
    if (!(await find().count())) { problems.push('Create with transfer (Passau → Wien): button "Mit 1 Umstieg suchen" is missing'); return; }
    await find().click(); await p.waitForTimeout(2500);
    if (!(await p.getByRole('alert').filter({ hasText: 'Auch mit 1 Umstieg habe ich zwischen' }).count())) problems.push('Create with transfer (Passau → Wien): no explanation "Auch mit 1 Umstieg …"');
    if (await find().count()) problems.push('Create with transfer (Passau → Wien): button stays after the unsuccessful search');
    if ((await jx(XD, '/api/profile')).tours.length !== 2) problems.push('Create with transfer (Passau → Wien): something was created despite the missing connection');
  } finally { expect422 = false; await c.close(); }
  // Dark mode: red hint, button and green preview stay readable
  expect422 = true;
  const dk = await browser.newContext({ ...NEW_CTX, colorScheme: 'dark' }); await dk.addInitScript(initFor(), ['smokexfer3123456789abcdefg']);
  try {
    const dp = await dk.newPage(); dp.setDefaultTimeout(8000); watch(dp);
    await dp.goto(base + '/Strecken'); await dp.waitForTimeout(1000);
    await dp.getByRole('button', { name: /Strecke hinzufügen/ }).click();
    await suggestOn(dp, 0, 'Freis'); await suggestOn(dp, 1, 'Salzb');
    await dp.getByRole('button', { name: 'Speichern' }).click(); await dp.waitForTimeout(1300);
    const verdict = (what, rows) => { for (const [label, ratio] of rows) if (ratio < 4.5) problems.push(`Dark mode: ${what} "${label}" poorly readable${ratio ? ` (contrast ${ratio.toFixed(1)}:1)` : ' (not found)'}`); };
    verdict('notice "keine Direktverbindung"', await contrastOf(dp, [['span', 'Zwischen Freising und Salzburg Hbf habe ich keine Direktverbindung gefunden.'], ['button', 'Mit 1 Umstieg suchen']]));
    await dp.getByRole('button', { name: 'Mit 1 Umstieg suchen' }).click(); await dp.waitForTimeout(2500);
    const bad = await lowContrast(dp, '[role=status]');
    if (bad.length) problems.push(`Dark mode: preview "Gefunden · 1 Umstieg" poorly readable: ${bad.slice(0, 4).join(', ')}`);
    if (!(await dp.getByRole('status').filter({ hasText: 'Gefunden · 1 Umstieg' }).count())) problems.push('Dark mode: no preview "Gefunden · 1 Umstieg"');
  } finally { expect422 = false; await dk.close(); }
});

// Transfer trip in the UI: the state is produced by the real build (buildTransferTour) and slipped to the page, with times from now on.
// Three situations: connection on time, at risk (feeder +8 min), missed (feeder +12 min). Main page, route page, incidents, dark mode, narrow phone.
await check('Transfer trip in the UI', async () => {
  const XD2 = 'smokexfer2123456789abcdefg';
  const sa = (await j('/api/stations?q=Salzburg')).stations[0];
  const made = await jx(XD2, '/api/tours', 'POST', { from: st, to: sa, transfers: 1 });
  const tour = (made.tours || [])[0];
  if (!tour) { problems.push(`Transfer trip: route with transfer could not be created (${made.error || 'no answer'})`); return; }
  const MH = { id: '8000261', name: 'München Hbf' };
  const iso = (min) => new Date(Date.now() + min * 60000).toISOString();
  const S1 = (min, o = {}) => { const d = o.late || 0; return { line: { name: 'S1', product: 'suburban' }, direction: 'Ostbahnhof', origin: tour.from, destination: MH, plannedDep: iso(min), dep: iso(min + d), depDelay: d, plannedArr: iso(min + 35), arr: iso(min + 35 + d), arrDelay: d, plannedPlatform: '3', platform: '3', plannedArrPlatform: '2', arrPlatform: '2', stopovers: [tour.from, { id: 'a', name: 'Neufahrn' }, { id: 'b', name: 'Feldmoching' }, MH], remarks: [], cancelled: false }; };
  const RE = (min) => ({ line: { name: 'RE 5', product: 'regionalExpress' }, direction: 'Salzburg Hbf', origin: MH, destination: tour.to, plannedDep: iso(min), dep: iso(min), depDelay: 0, plannedArr: iso(min + 95), arr: iso(min + 95), arrDelay: 0, plannedPlatform: '14', platform: '14', stopovers: [MH, { id: 'c', name: 'Rosenheim' }, { id: 'd', name: 'Prien' }, tour.to], remarks: [], cancelled: false });
  const J = (a, b) => ({ legs: [a, b] });
  const connectingTrips = () => new Map([['münchen hbf', [RE(24), RE(54), RE(84), RE(114)]]]);
  const scen = [
    { name: 'on time', state: 'ok', hero: /pünktlich/, detail: [/Umstieg/, /Gleis 2\s*→\s*Gleis 14/], js: () => [J(S1(10), RE(54)), J(S1(30), RE(84)), J(S1(50), RE(114))] },
    { name: 'at risk', state: 'tight', hero: /\+8 Min/, detail: [/Anschluss wackelt/, /Nächster Anschluss/], card: /Anschluss wackelt/, js: () => [J(S1(10, { late: 8 }), RE(84)), J(S1(30), RE(84)), J(S1(50), RE(114))] },
    { name: 'missed', state: 'missed', hero: /Verpasst/, detail: [/Anschluss verpasst/, /Nächster RE ?5 ab/], card: /Anschluss verpasst/, js: () => [J(S1(10, { late: 12 }), RE(84)), J(S1(30), RE(84)), J(S1(50), RE(114))] },
  ];
  for (const sc of scen) for (const [w, h, dark] of [[390, 844, false], [320, 568, false], [390, 844, true]]) {
    const tag = `Transfer trip ${sc.name} (${w} px${dark ? ', dark' : ''})`;
    where = tag;
    const c = await browser.newContext({ viewport: { width: w, height: h }, isMobile: true, hasTouch: true, colorScheme: dark ? 'dark' : 'light' });
    await c.addInitScript(initFor(), [XD2]);
    let built = null;
    await c.route('**/api/state**', async (route) => {
      const res = await route.fetch(); const body = await res.json();
      built = await buildTransferTour(tour, sc.js(), { now: Date.now(), minDelay: 3, linesAt: async () => [], lines: body.lines, bLists: connectingTrips() });
      body.tours = body.tours.map((x) => (x.id === tour.id ? { ...x, ...built.tour } : x));
      body.incidents = built.incidents;
      await route.fulfill({ response: res, json: body });
    });
    const pg = await c.newPage(); pg.setDefaultTimeout(8000); watch(pg);
    const text = () => pg.evaluate(() => document.querySelector('#screen').innerText);
    try {
      // Main page: big card, three rows with two lines each and the transfer row
      await pg.goto(base + '/'); await pg.waitForTimeout(1800);
      if (!built) { problems.push(`${tag}: state was not injected`); continue; }
      const states = built.tour.departures.map((d) => d.transfer && d.transfer.state);
      if (states[0] !== sc.state) problems.push(`${tag}: first departure has the state ${states[0]} instead of ${sc.state}`);
      const hero = await pg.locator('#screen a.rg-in').first().innerText();
      if (!sc.hero.test(hero)) problems.push(`${tag}: big card does not show ${sc.hero} (${hero.replace(/\s+/g, ' ').slice(0, 80)})`);
      const rows = pg.locator('a.rg-xdep');
      if ((await rows.count()) !== 3) { problems.push(`${tag}: ${await rows.count()} instead of 3 transfer rows`); continue; }
      for (let i = 0; i < 3; i++) {
        const rt = await rows.nth(i).innerText();
        if (!/S ?1/.test(rt) || !/RE ?5/.test(rt)) problems.push(`${tag}: row ${i + 1} does not show both lines (${rt.replace(/\s+/g, ' ')})`);
        if (!rt.includes(built.tour.departures[i].transfer.text)) problems.push(`${tag}: row ${i + 1} does not name "${built.tour.departures[i].transfer.text}" (${rt.replace(/\s+/g, ' ')})`);
      }
      if (await sideways(pg)) problems.push(`${tag}: main page scrolls sideways`);
      if (dark) { const bad = await lowContrast(pg, '#screen'); if (bad.length) problems.push(`${tag}: main page poorly readable: ${bad.slice(0, 4).join(', ')}`); }
      // Page of the first departure: two sections, transfer card, map of the route
      await rows.first().click(); await pg.waitForTimeout(1600);
      const dt = await text();
      for (const re of sc.detail) if (!re.test(dt)) problems.push(`${tag}: departure page does not show ${re}`);
      if (!/Freising\s*→\s*München Hbf/.test(dt) || !/München Hbf\s*→\s*Salzburg Hbf/.test(dt)) problems.push(`${tag}: departure page does not show the two trips`);
      if (!/1\. Fahrt/.test(dt) || !/2\. Fahrt/.test(dt)) problems.push(`${tag}: departure page does not name "1. Fahrt" and "2. Fahrt"`);
      if (await sideways(pg)) problems.push(`${tag}: departure page scrolls sideways`);
      const cut = await pg.evaluate(() => [...document.querySelectorAll('span')].filter((e) => /rotate\(-45deg\)/.test(e.getAttribute('style') || '') && e.textContent.trim()).filter((e) => e.getBoundingClientRect().right > innerWidth + 1 || e.getBoundingClientRect().left < -1).map((e) => e.textContent));
      if (cut.length) problems.push(`${tag}: label on the card sticks out over the edge: ${cut.join(', ')}`);
      if (dark) { const bad = await lowContrast(pg, '#screen'); if (bad.length) problems.push(`${tag}: departure page poorly readable: ${bad.slice(0, 4).join(', ')}`); }
      await pg.evaluate(() => { const s = [...document.querySelectorAll('[style*="overflow-y: auto"]')].pop(); if (s) s.scrollTop = 9999; }); await pg.waitForTimeout(300);
      if (await sideways(pg)) problems.push(`${tag}: departure page scrolls sideways at the bottom`);
      // Incidents: for at risk/missed exactly one card for the connection, for on time none
      await pg.goto(base + '/Meldungen'); await pg.waitForTimeout(1500);
      const cards = pg.locator('a[href^="Detail.dc.html#"]');
      if (sc.card) {
        if ((await cards.count()) !== 1) problems.push(`${tag}: ${await cards.count()} cards under "Meldungen" instead of 1`);
        else {
          const ct = await cards.first().innerText();
          if (!sc.card.test(ct) || !/RE ?5/.test(ct) || !/München Hbf/.test(ct)) problems.push(`${tag}: card under "Meldungen" does not name state, line or station (${ct.replace(/\s+/g, ' ')})`);
          await cards.first().click(); await pg.waitForTimeout(1500);
          const mt = await text();
          for (const re of sc.detail) if (!re.test(mt)) problems.push(`${tag}: route page via "Meldungen" does not show ${re}`);
        }
      } else if (await cards.count()) problems.push(`${tag}: incident despite an on-time connection`);
      if (await sideways(pg)) problems.push(`${tag}: "Meldungen" scrolls sideways`);
      if (dark) { const bad = await lowContrast(pg, '#screen'); if (bad.length) problems.push(`${tag}: "Meldungen" poorly readable: ${bad.slice(0, 4).join(', ')}`); }
    } finally { await c.close(); }
  }
});

// ---------- New in 0.7.1: "Schneller mit 1 Umstieg" for replacement transport ----------
// The state comes from the real build (buildTour with shortcutFor) and is slipped to the page, with times from now on.
await check('Faster with 1 transfer in the UI', async () => {
  const XD3 = 'smokeshort1123456789abcdefg';
  const made = await jx(XD3, '/api/tours', 'POST', { from: st, to: mu });
  const tour = (made.tours || [])[0];
  if (!tour) { problems.push(`Faster with 1 transfer: route could not be created (${made.error || 'no answer'})`); return; }
  const MO = { id: '8000902', name: 'Moosach' };
  const iso = (min) => new Date(Date.now() + min * 60000).toISOString();
  const SEV = { type: 'status', code: 'construction', summary: 'Schienenersatzverkehr', text: 'Wegen Bauarbeiten zwischen Neufahrn und Moosach Schienenersatzverkehr mit Bussen. Reisezeit verlängert sich um ca. 25 Minuten.', validFrom: iso(-600), validUntil: iso(3 * 24 * 60) };
  const D = (min) => ({ line: { name: 'S1', product: 'suburban' }, direction: 'Ostbahnhof', origin: tour.from, destination: tour.to, plannedDep: iso(min), dep: iso(min), depDelay: 0, plannedArr: iso(min + 46), arr: iso(min + 46), arrDelay: 0, plannedPlatform: '3', platform: '3', stopovers: [tour.from, { id: 'a', name: 'Neufahrn' }, { id: 'b', name: 'Feldmoching' }, MO, tour.to], remarks: [SEV], cancelled: false });
  const A = (min) => ({ line: { name: 'RE 22', product: 'regionalExpress' }, direction: 'Moosach', origin: tour.from, destination: MO, plannedDep: iso(min), dep: iso(min), depDelay: 0, plannedArr: iso(min + 25), arr: iso(min + 25), arrDelay: 0, plannedPlatform: '1', platform: '1', stopovers: [tour.from, MO], remarks: [], cancelled: false });
  const B = (min) => ({ line: { name: 'U3', product: 'subway' }, direction: 'Fürstenried West', origin: MO, destination: tour.to, plannedDep: iso(min), dep: iso(min), depDelay: 0, plannedArr: iso(min + 15), arr: iso(min + 15), arrDelay: 0, plannedPlatform: '1', platform: '1', stopovers: [MO, tour.to], remarks: [], cancelled: false });
  const J = (...legs) => ({ legs });
  // Scenarios: with a faster detour (RE 22 › U3 from now+12 min, 23 min earlier at the destination) and without (the detour would be only 4 min faster)
  const scen = [
    { name: 'with detour', detours: () => [J(A(12), B(43)), J(A(32), B(63))], card: true },
    { name: 'without detour', detours: () => [J(A(12), B(62))], card: false },
  ];
  for (const sc of scen) for (const [w, h, dark] of (sc.card ? [[390, 844, false], [320, 568, false], [390, 844, true]] : [[390, 844, false]])) {
    const tag = `Faster with 1 transfer ${sc.name} (${w} px${dark ? ', dark' : ''})`;
    where = tag;
    const c = await browser.newContext({ viewport: { width: w, height: h }, isMobile: true, hasTouch: true, colorScheme: dark ? 'dark' : 'light' });
    await c.addInitScript(initFor(), [XD3]);
    let built = null;
    await c.route('**/api/state**', async (route) => {
      const res = await route.fetch(); const body = await res.json(); const now = Date.now();
      built = await buildTour(tour, [J(D(10)), J(D(30)), J(D(50))], { now, minDelay: 3, linesAt: async () => [], lines: body.lines, shortcutFor: (o) => shortcutFor(sc.detours(), { now, ...o }) });
      body.tours = body.tours.map((x) => (x.id === tour.id ? { ...x, ...built.tour } : x));
      body.incidents = built.incidents;
      await route.fulfill({ response: res, json: body });
    });
    const pg = await c.newPage(); pg.setDefaultTimeout(8000); watch(pg);
    const text = () => pg.evaluate(() => document.querySelector('#screen').innerText);
    try {
      await pg.goto(base + '/'); await pg.waitForTimeout(1800);
      const rep = built && built.incidents.find((i) => i.kind === 'replacement');
      if (!rep) { problems.push(`${tag}: state with replacement transport was not injected`); continue; }
      if (!!rep.view.shortcut !== sc.card) problems.push(`${tag}: server view ${rep.view.shortcut ? 'has' : 'has no'} card, expected ${sc.card ? 'one' : 'none'}`);
      // Open the incident page
      await pg.goto(base + '/Detail#' + rep.id + '-m'); await pg.waitForTimeout(1600);
      const dt = await text();
      if (!/Ersatzverkehr/.test(dt)) problems.push(`${tag}: page does not show the replacement transport`);
      if (sc.card) {
        if (!/Schneller mit 1 Umstieg/.test(dt)) problems.push(`${tag}: card "Schneller mit 1 Umstieg" is missing`);
        else {
          const ct = dt.slice(dt.indexOf('Schneller mit 1 Umstieg')).replace(/\s+/g, ' ').slice(0, 160);
          if (!/RE 22 › U3 ab \d\d:\d\d/.test(ct) || !/Umstieg Moosach · \d+ Min\./.test(ct) || !/An \d\d:\d\d statt \d\d:\d\d/.test(ct) || !/−\d+ Min\./.test(ct)) problems.push(`${tag}: card does not name lines, transfer, arrival or saving (${ct.slice(0, 140)})`);
        }
      } else if (/Schneller mit 1 Umstieg/.test(dt)) problems.push(`${tag}: card appears although the detour is not faster`);
      if (await sideways(pg)) problems.push(`${tag}: page scrolls sideways`);
      await pg.evaluate(() => { const s = [...document.querySelectorAll('[style*="overflow-y: auto"]')].pop(); if (s) s.scrollTop = 9999; }); await pg.waitForTimeout(300);
      if (await sideways(pg)) problems.push(`${tag}: page scrolls sideways at the bottom`);
      if (dark) { const bad = await lowContrast(pg, '#screen'); if (bad.length) problems.push(`${tag}: page poorly readable: ${bad.slice(0, 4).join(', ')}`); }
    } finally { await c.close(); }
  }
});

// Without real-time data from the source the app must not say "pünktlich" with a green check: "planmäßig", "Ohne Echtzeit" and a neutral look.
await check('No real-time data', async () => {
  const prof = (await j('/api/profile')).tours;
  const iso = (min) => new Date(Date.now() + min * 60000).toISOString();
  const mk = (t, min, rt) => ({ line: { name: 'S 1', product: 'suburban' }, direction: t.to.name, origin: t.from, destination: t.to, plannedDep: iso(min), dep: iso(min), depDelay: 0, rt, plannedArr: iso(min + 40), arr: iso(min + 40), arrDelay: 0, plannedPlatform: '2', platform: '2', stopovers: [], remarks: [] });
  const c = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true }); await c.addInitScript(initFor(), [DEV]);
  await c.route('**/api/state**', async (route) => {
    const res = await route.fetch(); const body = await res.json();
    const mine = new Set(prof.map((t) => t.id));
    let incidents = body.incidents.filter((i) => !mine.has(i.tourId)); const tours = [];
    for (const x of body.tours) {
      const t = prof.find((q) => q.id === x.id);
      if (!t) { tours.push(x); continue; }
      const r = await buildTour(t, [mk(t, 25, false), mk(t, 40, true), mk(t, 55, true)].map((l) => ({ legs: [l] })), { now: Date.now(), minDelay: 3, linesAt: async () => [], lines: body.lines });
      tours.push({ ...x, ...r.tour }); incidents = [...incidents, ...r.incidents];
    }
    body.tours = tours; body.incidents = incidents;
    await route.fulfill({ response: res, json: body });
  });
  const pg = await c.newPage(); pg.setDefaultTimeout(8000);
  try {
    await pg.goto(base + '/'); await pg.waitForTimeout(1600);
    const hero = await pg.evaluate(() => { const a = document.querySelector('#screen a.rg-in'); return { text: a.innerText.replace(/\s+/g, ' '), bg: getComputedStyle(a).backgroundColor }; });
    if (!/Ohne Echtzeit/.test(hero.text) || !/planmäßig/.test(hero.text) || !/Verspätungen unbekannt/.test(hero.text) || /pünktlich/i.test(hero.text)) problems.push(`No real-time data: main card words it wrong (${hero.text.slice(0, 140)})`);
    if (hero.bg !== 'rgb(212, 237, 246)') problems.push(`No real-time data: main card should be neutral blue, it is ${hero.bg}`);
    const rows = await pg.locator('a.rg-dep').evaluateAll((els) => els.map((e) => ({ text: e.innerText.replace(/\s+/g, ' '), icon: (e.querySelector('svg path') || {}).getAttribute ? e.querySelector('svg path').getAttribute('d') : '' })));
    if (rows.length < 2) { problems.push(`No real-time data: ${rows.length} departure rows`); return; }
    if (!/planmäßig/.test(rows[0].text) || /pünktlich/.test(rows[0].text) || rows[0].icon.startsWith('M9 25')) problems.push(`No real-time data: first row says "pünktlich" or keeps the check mark (${rows[0].text})`);
    if (!/pünktlich/.test(rows[1].text) || !rows[1].icon.startsWith('M9 25')) problems.push(`No real-time data: monitored second row changed (${rows[1].text})`);
    await pg.locator('a.rg-dep').nth(0).click(); await pg.waitForTimeout(1300);
    const dt = await pg.evaluate(() => document.querySelector('#screen').innerText);
    if (!/Ohne Echtzeit/.test(dt)) problems.push('No real-time data: detail page does not say "Ohne Echtzeit"');
    if (await pg.locator('#screen [style*="background: rgb(234, 246, 207)"]').count()) problems.push('No real-time data: detail page still shows the green "all fine" card');
    if (await pg.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1)) problems.push('No real-time data: page scrolls sideways');
  } finally { await c.close(); }
});

// Ticket notes: no hint to use screenshots; the card says that the inspection staff decides, the photo page says what ReGo does with the image
await check('Ticket notes', async () => {
  const c = await browser.newContext(NEW_CTX); await c.addInitScript(initFor(), [DEV]);
  await c.addInitScript(() => { try { localStorage.setItem('rego.tickets', JSON.stringify([{ id: 'dt', slot: 'dt', name: 'Deutschlandticket', validUntil: '31.12.2099', image: 'data:image/png;base64,iVBORw0KGgo=', original: '', payload: '', format: '' }])); } catch (e) {} });
  const pg = await c.newPage(); pg.setDefaultTimeout(8000);
  try {
    await pg.goto(base + '/Ticket'); await pg.waitForTimeout(1300);
    let t = await pg.evaluate(() => document.querySelector('#screen').innerText);
    if (!/Kontrollpersonal/.test(t) || !/Original-Ticket/.test(t)) problems.push('Ticket notes: the card does not say that the inspection staff decides');
    if (!/Browserdaten/.test(t)) problems.push('Ticket notes: storage note lacks the browser wording (outside the app)');
    await pg.goto(base + '/Scan'); await pg.waitForTimeout(1300);
    await pg.getByRole('button', { name: 'Aus Foto' }).click(); await pg.waitForTimeout(500);
    t = await pg.evaluate(() => document.querySelector('#screen').innerText);
    if (!/Bild mit Barcode/.test(t) || !/zeichnet ihn neu/.test(t) || !/Kontrollpersonal/.test(t)) problems.push('Ticket notes: photo page does not explain what ReGo does with the image');
    if (/Screenshot/i.test(t)) problems.push('Ticket notes: photo page still recommends screenshots');
    if (await pg.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1)) problems.push('Ticket notes: page scrolls sideways');
  } finally { await c.close(); }
});

// Update hint (the app tells its version, the server says there is a newer one) and the way to give feedback (mail with the address visible)
await check('Update hint and feedback', async () => {
  const c = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  await c.addInitScript(initFor(), [DEV]);
  await c.addInitScript(() => { window.RegoNative = { appVersion: () => '0.7.2' }; });
  const urls = [];
  await c.route('**/api/state**', async (route) => {
    urls.push(route.request().url());
    const res = await route.fetch(); const body = await res.json();
    body.contact = 'beta@example.org'; body.app = { latest: '0.9.0', url: 'https://github.com/K0RBI02/ReGo/releases/tag/app-v0.9.0' };
    await route.fulfill({ response: res, json: body });
  });
  const pg = await c.newPage(); pg.setDefaultTimeout(8000);
  const barText = () => pg.locator('#screen').getByText('Neue App-Version 0.9.0');
  try {
    await pg.goto(base + '/'); await pg.waitForTimeout(1600);
    if (!urls.some((u) => /[?&]app=0\.7\.2(&|$)/.test(u))) problems.push('Update hint: the app does not send its version with the state request');
    if (!(await barText().count())) { problems.push('Update hint: no bar on the main screen'); return; }
    if (!(await pg.locator('#screen a[href="https://github.com/K0RBI02/ReGo/releases/tag/app-v0.9.0"]').count())) problems.push('Update hint: bar has no link to the release');
    if (await pg.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1)) problems.push('Update hint: main screen scrolls sideways');
    await pg.getByRole('button', { name: 'Hinweis schließen' }).click(); await pg.waitForTimeout(400);
    if (await barText().count()) problems.push('Update hint: bar stays after closing it');
    await pg.goto(base + '/'); await pg.waitForTimeout(1500);
    if (await barText().count()) problems.push('Update hint: a closed bar comes back after reloading');
    // Settings: the update stays reachable there, the feedback is a prepared mail and the address can be read
    await pg.goto(base + '/Strecken'); await pg.waitForTimeout(1300);
    await pg.getByRole('button', { name: /Einstellungen/ }).first().click(); await pg.waitForTimeout(500);
    const dlg = pg.getByRole('dialog', { name: 'Einstellungen' });
    if (!(await dlg.getByText(/neuere App-Version \(0\.9\.0\)/).count())) problems.push('Update hint: settings do not mention the newer version');
    const mail = await dlg.locator('a[href^="mailto:beta@example.org?subject="]').getAttribute('href').catch(() => '');
    if (!mail) problems.push('Feedback: the link is not a mail to the configured address');
    else if (!/body=.*App%200\.7\.2/.test(mail)) problems.push('Feedback: the prepared mail does not name the app version');
    if (!(await dlg.getByText(/schreib an beta@example\.org/).count())) problems.push('Feedback: the address is not shown as text');
    if (!/App 0\.7\.2 · Server /.test(await dlg.innerText())) problems.push('Settings: version line lacks the app version');
  } finally { await c.close(); }
});

// Feedback without a configured address (older server or none set): the GitHub form stays as the way out
await check('Feedback without address', async () => {
  const c = await browser.newContext(NEW_CTX); await c.addInitScript(initFor(), [DEV]);
  const pg = await c.newPage(); pg.setDefaultTimeout(8000);
  try {
    await pg.goto(base + '/Strecken'); await pg.waitForTimeout(1300);
    await pg.getByRole('button', { name: /Einstellungen/ }).first().click(); await pg.waitForTimeout(500);
    const dlg = pg.getByRole('dialog', { name: 'Einstellungen' });
    if (!(await dlg.locator('a[href^="https://github.com/K0RBI02/ReGo/issues/new"]').count())) problems.push('Feedback without address: GitHub form is missing');
    if (await dlg.getByText(/Öffnet sich kein Mail-Programm/).count()) problems.push('Feedback without address: mail hint shown although there is no address');
    if (await dlg.getByText(/neuere App-Version/).count()) problems.push('Feedback without address: update line shown without a newer version');
  } finally { await c.close(); }
});

await browser.close(); server.close();
if (problems.length) { console.error('Screen test FAILED:\n- ' + [...new Set(problems)].join('\n- ')); process.exit(1); }
console.log('Screen test passed (6 screens, change route, back up tickets, double tap, commute time (sliders, main screen), undo, refresh, apply code, small phone, dark mode, several incidents per route, route without direct connection, font, create without direct connection, onboarding without direct connection, test notification, version line, settings sheet, invitation code, platform change, cancellation, hero line and "Danach", create with transfer, transfer trip on time / at risk / missed, faster with 1 transfer on replacement transport, no real-time data, ticket notes, update hint and feedback).');
