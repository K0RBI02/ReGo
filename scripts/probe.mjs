// Fetch real responses from the timetable sources and save them as sample files (test/fixtures/). Run `npm install` first.
// Usage: node scripts/probe.mjs [from] [to]
import { mkdir, writeFile } from 'node:fs/promises';
import { config } from '../server/config.mjs';
import { createDbClient, createOebbClient } from '../server/providers/lib.mjs';

const [fromQ = 'Rosenheim', toQ = 'München Hbf'] = process.argv.slice(2);
const out = new URL('../test/fixtures/', import.meta.url);
await mkdir(out, { recursive: true });
const save = (n, d) => writeFile(new URL(n, out), JSON.stringify(d, null, 2));
const step = async (name, fn) => { try { const r = await fn(); console.log('ok     ', name); return r; } catch (e) { console.log('ERROR  ', name, '->', e.message); } };
const db = createDbClient(config.upstream.userAgent), oebb = createOebbClient(config.upstream.userAgent);

const from = await step(`DB search "${fromQ}"`, async () => { const r = await db.searchStops(fromQ); await save('db-locations.json', r); console.log('       ', r.slice(0, 3).map((s) => `${s.name} (${s.id})`).join(', ')); return r[0]; });
const to = await step(`DB search "${toQ}"`, async () => (await db.searchStops(toQ))[0]);
if (from && to) {
  await step('DB direct connections with stopovers and remarks', async () => {
    const j = await db.journeys({ fromId: from.id, toId: to.id, when: new Date().toISOString(), results: 5 });
    await save('db-journeys.json', j);
    const l = j[0]?.legs[0];
    console.log(`        ${j.length} connections, first: ${l?.line?.name} ${l?.origin?.name} → ${l?.destination?.name}, stopovers: ${l?.stopovers?.length}, remarks: ${l?.remarks?.length}`);
  });
}
await step('DB stop with lines (may be missing)', async () => { const r = await db.stop(from.id); await save('db-stop.json', r); console.log(`        ${(r.lines || []).length} lines`); });
const sbg = await step('ÖBB search "Salzburg Hbf"', async () => { const r = await oebb.searchStops('Salzburg Hbf'); await save('oebb-locations.json', r); console.log('       ', r.slice(0, 3).map((s) => `${s.name} (${s.id})`).join(', ')); return r[0]; });
const wien = sbg && await step('ÖBB search "Wien Hbf"', async () => (await oebb.searchStops('Wien Hbf'))[0]);
if (sbg && wien) await step('ÖBB direct connections', async () => { const j = await oebb.journeys({ fromId: sbg.id, toId: wien.id, when: new Date().toISOString(), results: 3 }); await save('oebb-journeys.json', j); console.log(`        ${j.length} connections`); });
console.log(`\nFiles saved in ${out.pathname}`);
