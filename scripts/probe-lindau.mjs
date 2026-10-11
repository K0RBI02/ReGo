// Wie heißt Lindau Hbf bei den Quellen? Läuft auf Lab02: node scripts/probe-lindau.mjs
import { config } from '../server/config.mjs';
import { createOebbClient } from '../server/providers/lib.mjs';
import { EfaClient } from '../server/providers/efa.mjs';

const ua = config.upstream.userAgent;
const oebb = createOebbClient(ua);
const moby = new EfaClient(config.upstream.efa.find((e) => e.key === 'moby').url, { key: 'moby', userAgent: ua });
const QUERIES = ['Lindau Hbf', 'Lindau (Bodensee) Hbf', 'Lindau Bodensee', 'Lindau Insel', 'Lindau Bahnhof', 'Lindau Reutin', 'Lindau', 'Bregenz'];
for (const [name, c] of [['ÖBB', oebb], ['MoBY', moby]]) {
  console.log(`\n=== ${name} ===`);
  for (const q of QUERIES) {
    let r; try { r = await c.searchStops(q); } catch (e) { try { r = await c.searchStops(q); } catch (e2) { console.log(`"${q}": FEHLER ${e2.message}`); continue; } }
    console.log(`"${q}" (${r.length}): ` + r.map((s) => `${s.name} [${s.id}]`).join(' | '));
  }
}
