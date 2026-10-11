// Prüft bayernweite EFA-Schnittstellen (Bahnland Bayern / BEG) auf Erreichbarkeit, Haltestellen und Verbindungen.
// Läuft auf Lab02:  node scripts/probe-moby.mjs | tee moby.txt
import { EfaClient } from '../server/providers/efa.mjs';

const UA = 'ReGo/0.1 (privates Hobbyprojekt)';
const CANDIDATES = [['moby', 'https://bahnland-bayern.de/efa'], ['beg', 'https://mobile.defas-fgi.de/beg']];
const STOPS = ['Rosenheim', 'Kempten', 'Berchtesgaden', 'Lindau', 'Freilassing', 'Salzburg Hbf', 'Kufstein', 'Garmisch-Partenkirchen'];
const PAIRS = [['Rosenheim', 'Kufstein'], ['Freilassing', 'Salzburg Hbf'], ['Kempten', 'Lindau'], ['Berchtesgaden', 'Freilassing'], ['Garmisch-Partenkirchen', 'München Hbf']];
const hh = (v) => (v ? new Date(v).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Berlin' }) : '--');
const safe = async (fn) => { try { return await fn(); } catch (e) { return { error: e.message }; } };

for (const [key, base] of CANDIDATES) {
  console.log(`\n=== ${key}: ${base} ===`);
  const url = `${base}/XML_STOPFINDER_REQUEST?outputFormat=rapidJSON&type_sf=any&name_sf=Rosenheim&anyObjFilter_sf=2`;
  const raw = await safe(async () => { const r = await fetch(url, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(10000) }); return `HTTP ${r.status} ${r.headers.get('content-type')} ${(await r.text()).slice(0, 160).replace(/\s+/g, ' ')}`; });
  console.log('Roh:', raw.error ? 'FEHLER ' + raw.error : raw);
  const c = new EfaClient(base, { key, userAgent: UA, retries: 1 });
  const found = {};
  for (const q of STOPS) {
    const r = await safe(() => c.searchStops(q));
    if (r.error) { console.log(`Suche "${q}": FEHLER ${r.error}`); continue; }
    found[q] = r[0];
    console.log(`Suche "${q}": ${r.length} Treffer; ${r.slice(0, 3).map((x) => `${x.name} (${x.id})`).join(' | ')}`);
  }
  for (const [a, b] of PAIRS) {
    if (!found[a] || !found[b]) { console.log(`${a} → ${b}: übersprungen (Halt fehlt)`); continue; }
    const j = await safe(() => c.journeys({ fromId: found[a].id, toId: found[b].id, when: new Date().toISOString(), results: 4 }));
    console.log(`${a} → ${b}: ${j.error ? 'FEHLER ' + j.error : j.length + ' Verbindungen: ' + j.map((x) => `${x.legs[0].line.name} ${hh(x.legs[0].dep)}${x.legs[0].depDelay ? ' +' + x.legs[0].depDelay : ''}`).join(', ')}`);
  }
}
