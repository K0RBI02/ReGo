// Echte Antworten abholen und als Beispieldateien speichern. Vorher: npm install
// Aufruf: node scripts/probe.mjs [Start] [Ziel]
import { mkdir, writeFile } from 'node:fs/promises';
import { config } from '../server/config.mjs';
import { createDbClient, createOebbClient } from '../server/providers/lib.mjs';

const [fromQ = 'Freising', toQ = 'München Hbf'] = process.argv.slice(2);
const out = new URL('../fixtures/real/', import.meta.url);
await mkdir(out, { recursive: true });
const save = (n, d) => writeFile(new URL(n, out), JSON.stringify(d, null, 2));
const step = async (name, fn) => { try { const r = await fn(); console.log('ok     ', name); return r; } catch (e) { console.log('FEHLER ', name, '->', e.message); } };
const db = createDbClient(config.upstream.userAgent), oebb = createOebbClient(config.upstream.userAgent);

const from = await step(`DB Suche "${fromQ}"`, async () => { const r = await db.searchStops(fromQ); await save('db-locations.json', r); console.log('       ', r.slice(0, 3).map((s) => `${s.name} (${s.id})`).join(', ')); return r[0]; });
const to = await step(`DB Suche "${toQ}"`, async () => (await db.searchStops(toQ))[0]);
if (from && to) {
  await step('DB Direktverbindungen mit Zwischenhalten + Hinweisen', async () => {
    const j = await db.journeys({ fromId: from.id, toId: to.id, when: new Date().toISOString(), results: 5 });
    await save('db-journeys.json', j);
    const l = j[0]?.legs[0];
    console.log(`        ${j.length} Verbindungen, erste: ${l?.line?.name} ${l?.origin?.name} → ${l?.destination?.name}, Zwischenhalte: ${l?.stopovers?.length}, Hinweise: ${l?.remarks?.length}`);
  });
}
await step('DB Haltestelle mit Linien (darf fehlen)', async () => { const r = await db.stop(from.id); await save('db-stop.json', r); console.log(`        ${(r.lines || []).length} Linien`); });
const sbg = await step('ÖBB Suche "Salzburg Hbf"', async () => { const r = await oebb.searchStops('Salzburg Hbf'); await save('oebb-locations.json', r); console.log('       ', r.slice(0, 3).map((s) => `${s.name} (${s.id})`).join(', ')); return r[0]; });
const wien = sbg && await step('ÖBB Suche "Wien Hbf"', async () => (await oebb.searchStops('Wien Hbf'))[0]);
if (sbg && wien) await step('ÖBB Direktverbindungen', async () => { const j = await oebb.journeys({ fromId: sbg.id, toId: wien.id, when: new Date().toISOString(), results: 3 }); await save('oebb-journeys.json', j); console.log(`        ${j.length} Verbindungen`); });
console.log(`\nDateien in ${out.pathname} – bitte zurückschicken (zip), dann gleiche ich das Format ab.`);
