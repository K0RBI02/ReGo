// Grenzverkehr und Abdeckung prüfen (läuft auf Lab02, wo die Abfragen funktionieren). Vorher: npm install
// Aufruf: node scripts/probe-grenze.mjs | tee grenze.txt
import { mkdir, writeFile } from 'node:fs/promises';
import { config } from '../server/config.mjs';
import { createOebbClient } from '../server/providers/lib.mjs';
import { EfaClient } from '../server/providers/efa.mjs';
import { createTranslator } from '../server/providers/index.mjs';

const oebb = createOebbClient(config.upstream.userAgent);
const mvv = new EfaClient(config.upstream.efa[0].url, { key: 'mvv', userAgent: config.upstream.userAgent });
const out = {};
const hh = (v) => (v ? new Date(v).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Berlin' }) : '--');
const safe = async (fn) => { try { return await fn(); } catch (e) { return { error: e.message }; } };
const search = async (c, q) => { let r = await safe(() => c.searchStops(q)); if (r.error) r = await safe(() => c.searchStops(q)); return r; };      // eine Wiederholung bei Zeitüberschreitung

console.log('=== 1) ÖBB: Strecken über die Grenze und in Österreich (Direktverbindungen) ===');
const PAIRS = [['Freilassing', 'Salzburg Hbf'], ['Salzburg Hbf', 'Bad Reichenhall'], ['Rosenheim', 'Kufstein'], ['Kufstein', 'Innsbruck Hbf'],
  ['Lindau Hbf', 'Bregenz'], ['Garmisch-Partenkirchen', 'Innsbruck Hbf'], ['Berchtesgaden', 'Salzburg Hbf'], ['Salzburg Hbf', 'Zell am See']];
for (const [a, b] of PAIRS) {
  const [sa, sb] = [await search(oebb, a), await search(oebb, b)];
  if (sa.error || sb.error || !sa[0] || !sb[0]) { console.log(`${a} → ${b}: Haltestelle nicht gefunden (${sa.error || sb.error || (!sa[0] ? a : b)})`); out[`${a}→${b}`] = { sa, sb }; continue; }
  const j = await safe(() => oebb.journeys({ fromId: sa[0].id, toId: sb[0].id, when: new Date().toISOString(), results: 4 }));
  out[`${a}→${b}`] = { from: sa[0], to: sb[0], journeys: j };
  if (j.error) {
    const j1 = await safe(() => oebb.journeys({ fromId: sa[0].id, toId: sb[0].id, when: new Date().toISOString(), results: 3, transfers: 1 }));
    console.log(`${a} (${sa[0].name} ${sa[0].id}) → ${b} (${sb[0].name} ${sb[0].id}): FEHLER ${j.error}; mit 1 Umstieg: ${j1.error ? 'FEHLER ' + j1.error : j1.length + ' Verbindungen'}`);
    console.log('   weitere Treffer A:', (sa.slice(1, 4) || []).map((x) => `${x.name} ${x.id}`).join(' | '), ' B:', (sb.slice(1, 4) || []).map((x) => `${x.name} ${x.id}`).join(' | '));
    continue;
  }
  const lines = j.map((x) => `${x.legs[0].line.name} ${hh(x.legs[0].dep)}`).join(', ');
  console.log(`${a} (${sa[0].id}) → ${b} (${sb[0].id}): ${j.length} direkt${j.length ? ' – ' + lines : ''}`);
}

console.log('\n=== 2) MVV: wie weit reicht die Haltestellensuche? ===');
for (const q of ['Rosenheim Bahnhof', 'Bad Reichenhall', 'Berchtesgaden', 'Traunstein', 'Kufstein', 'Garmisch-Partenkirchen', 'Kempten', 'Lindau', 'Füssen', 'Oberstdorf']) {
  const r = await safe(() => mvv.searchStops(q));
  out[`mvv:${q}`] = r;
  console.log(`${q}: ${r.error ? 'FEHLER ' + r.error : r.length ? r.slice(0, 2).map((s) => s.name).join(' | ') : 'nichts'}`);
}

console.log('\n=== 3) Übersetzung: MVV-Haltestelle -> ÖBB-Haltestelle (Name + Koordinaten) ===');
const translate = createTranslator(mvv);
for (const q of ['Rosenheim Bahnhof', 'Bad Reichenhall', 'Garmisch-Partenkirchen', 'Berchtesgaden', 'Freilassing', 'Kufstein', 'Lindau']) {
  const m = await search(mvv, q);
  const st = Array.isArray(m) ? m.find((x) => /bahnhof|hbf|bad reichenhall, bad reichenhall|garmisch-partenkirchen, garmisch/i.test(x.name)) || m[0] : null;
  if (!st) { console.log(`${q}: kein MVV-Treffer`); continue; }
  const t = await safe(() => translate(st, oebb));
  out[`translate:${q}`] = { st, t };
  console.log(`${st.name} (${st.id}) -> ${t.error ? 'FEHLER ' + t.error : t}`);
}

const dir = new URL('../fixtures/real/', import.meta.url);
await mkdir(dir, { recursive: true });
await writeFile(new URL('grenze.json', dir), JSON.stringify(out, null, 2));
console.log('\nFertig. Bitte die Ausgabe (grenze.txt) hier anhängen.');
