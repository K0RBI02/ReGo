// Client für EFA-Schnittstellen der Verkehrsverbünde (z. B. MVV). Format "rapidJSON".
// Haltestellen-IDs bekommen den Präfix des Verbunds ("mvv|de:09162:2"), damit ReGo weiß, wohin eine Anfrage gehört.
// Normalisierte Typen wie in hafas.mjs: Stop { id, name, lat, lon, products? }
import { ProviderError } from './hafas.mjs';
import { berlin } from '../lib/time.mjs';

const COORD = 'WGS84[dd.ddddd]';

export class EfaClient {
  constructor(base, { key = 'efa', fetchImpl = (...a) => globalThis.fetch(...a), userAgent = 'ReGo', timeoutMs = 8000, retries = 1 } = {}) {
    this.base = base.replace(/\/$/, ''); this.key = key; this.name = key;
    this.fetch = fetchImpl; this.userAgent = userAgent; this.timeoutMs = timeoutMs; this.retries = retries;
  }

  owns(id) { return String(id || '').startsWith(`${this.key}|`); }
  raw(id) { return String(id).slice(this.key.length + 1); }

  async get(path, params = {}) {
    const qs = new URLSearchParams({ outputFormat: 'rapidJSON', coordOutputFormat: COORD, language: 'de', ...params }).toString();
    const url = `${this.base}/${path}?${qs}`;
    let lastErr;
    for (let attempt = 0; attempt <= this.retries; attempt++) {
      try {
        const res = await this.fetch(url, { headers: { 'user-agent': this.userAgent, accept: 'application/json' }, signal: AbortSignal.timeout(this.timeoutMs) });
        if (res.ok) return await res.json();
        lastErr = new ProviderError(`${this.name}: HTTP ${res.status}`, { status: res.status, kind: 'http' });
        if (res.status < 500 && res.status !== 429) throw lastErr;
      } catch (err) {
        if (err instanceof ProviderError && err.kind === 'http' && err.status < 500 && err.status !== 429) throw err;
        lastErr = err instanceof ProviderError ? err : new ProviderError(`${this.name}: ${err.name === 'TimeoutError' ? 'Zeitüberschreitung' : err.message}`, { kind: 'network' });
      }
      if (attempt < this.retries) await new Promise((r) => setTimeout(r, 400 * 2 ** attempt));
    }
    throw lastErr;
  }

  async searchStops(query) {
    const ask = (q) => this.get('XML_STOPFINDER_REQUEST', { type_sf: 'any', name_sf: q, anyObjFilter_sf: 2, anyMaxSizeHitList: 20 });
    const first = String(query).trim().split(/\s+/)[0];
    // Mehrere Wörter ("Lindau Hb"): der Verbund findet bei unvollständigem 2. Wort oft nur Nebensächliches -> zusätzlich nur nach dem ersten Wort fragen
    const [main, wide] = await Promise.allSettled([ask(query), first && first !== String(query).trim() && first.length >= 3 ? ask(first) : Promise.resolve(null)]);
    if (main.status === 'rejected' && !wide.value) throw main.reason;
    const locations = [...(main.value?.locations || []), ...(wide.value?.locations || [])];
    const seen = new Set();
    return parseStops({ locations: locations.filter((x) => x && !seen.has(x.id) && seen.add(x.id)) }, this.key, query);
  }

  /** Direktverbindungen (ohne Umstieg) ab "when" inkl. Zwischenhalte und Hinweise. */
  async journeys({ fromId, toId, when, results = 5 }) {
    const b = berlin(new Date(when).getTime());
    const data = await this.get('XML_TRIP_REQUEST2', {
      type_origin: 'any', name_origin: this.raw(fromId), type_destination: 'any', name_destination: this.raw(toId),
      itdDate: b.date.replaceAll('-', ''), itdTime: b.time.replace(':', ''), itdTripDateTimeDepArr: 'dep',
      calcNumberOfTrips: results, maxChanges: 0, useRealtime: 1,
    });
    const errs = (data?.systemMessages || []).filter((m) => m.type === 'error' && m.code !== -8011);
    if (!data?.journeys?.length && errs.length) throw new ProviderError(`${this.name}: ${errs[0].text || 'Fehler ' + errs[0].code}`, { kind: 'http' });
    return parseJourneys(data, this.key);
  }

  /** Koordinaten einer Haltestelle; Linien liefert EFA hier nicht (leere Liste, Karte ohne Anschlüsse). */
  async stop(id) {
    const gid = this.raw(id);
    let s = {};
    try { s = parseStops(await this.get('XML_STOPFINDER_REQUEST', { type_sf: 'any', name_sf: gid, anyObjFilter_sf: 2 }), this.key).find((x) => x.id === id) || {}; } catch { /* ohne Koordinaten weiter */ }
    return { id, name: s.name || '', lat: s.lat, lon: s.lon, lines: [] };
  }
}

/** Antwort der Haltestellensuche -> Stop[]; beste Treffer zuerst, höchstens 8. */
const STATION = /\b(hbf|hauptbahnhof|bahnhof|bf)\b/i;
/** Je kleiner, desto besser: genauer Name, dann Bahnhof mit dem Suchbegriff am Anfang, dann Anfang, dann irgendwo enthalten. */
export function rankOf(name, q) {
  const n = String(name || '').toLowerCase().trim(), s = String(q || '').toLowerCase().trim();
  if (!s) return 0;
  if (n === s) return 0;
  if (n.startsWith(s) && STATION.test(n)) return 1;
  if (n.startsWith(s)) return 2;
  const nt = n.split(/[\s,()/-]+/).filter(Boolean), qt = s.split(/\s+/);
  if (qt.length > 1 && qt.every((t) => nt.some((w) => w.startsWith(t)))) return STATION.test(n) ? 1 : 2;      // "Lindau Hb" -> "Lindau (Bodensee) Hbf"
  return n.includes(s) ? 3 : 4;
}
export function parseStops(data, key = 'efa', query = '') {
  const list = (data?.locations || []).filter((x) => x && (x.type === 'stop' || x.type === 'station') && x.id);
  list.sort((a, b) => rankOf(a.name || a.disassembledName, query) - rankOf(b.name || b.disassembledName, query) || (b.isBest ? 1 : 0) - (a.isBest ? 1 : 0) || (b.matchQuality || 0) - (a.matchQuality || 0));
  return list.slice(0, 8).map((x) => ({
    id: `${key}|${x.id}`, name: String(x.name || x.disassembledName || '').trim(),
    lat: Array.isArray(x.coord) ? x.coord[0] : undefined, lon: Array.isArray(x.coord) ? x.coord[1] : undefined,
  }));
}

// ---- Verbindungen ---------------------------------------------------------------------------------------------

const ENT = { auml: 'ä', ouml: 'ö', uuml: 'ü', Auml: 'Ä', Ouml: 'Ö', Uuml: 'Ü', szlig: 'ß', nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', bdquo: '„', ldquo: '“', rdquo: '”', ndash: '–', mdash: '—' };
export const plain = (html = '') => String(html)
  .replace(/<\/(?:p|div|li|ul|h\d)>|<br\s*\/?>/gi, ' ').replace(/<[^>]+>/g, '')
  .replace(/&(?:#(\d+)|#x([0-9a-f]+)|(\w+));/gi, (m, d, h, n) => (d ? String.fromCodePoint(+d) : h ? String.fromCodePoint(parseInt(h, 16)) : ENT[n] ?? m))
  .replace(/\s+/g, ' ').trim();

/** EFA-Produkt -> ReGo-Produkt (subway, suburban, tram, bus, regional, regionalExpress, nationalExpress, ferry) */
export function productOf(p = {}) {
  const n = String(p.name || '').toLowerCase();
  if (/s-bahn/.test(n)) return 'suburban';
  if (/u-bahn/.test(n)) return 'subway';
  if (/straßenbahn|strassenbahn|tram|stadtbahn/.test(n)) return 'tram';
  if (/bus|taxi|ast/.test(n)) return 'bus';
  if (/schiff|fähre|faehre/.test(n)) return 'ferry';
  if (/ice|intercity|\bic\b|\bec\b|railjet|fern/.test(n)) return 'nationalExpress';
  if (/express|\bre\b|\brex\b/.test(n)) return 'regionalExpress';
  if (/bahn|zug|regio/.test(n)) return 'regional';
  return { 1: 'suburban', 2: 'subway', 3: 'tram', 4: 'tram', 5: 'bus', 6: 'bus', 7: 'bus', 9: 'ferry' }[p.class] || 'regional';
}

const stopOf = (key, p = {}) => {
  const s = p.parent && p.parent.type === 'stop' ? p.parent : p;
  const c = s.coord || p.coord || [];
  return { id: `${key}|${s.id}`, name: String(s.name || '').trim(), lat: c[0], lon: c[1] };
};
const delayMin = (planned, est) => (planned && est ? Math.round((Date.parse(est) - Date.parse(planned)) / 60000) : 0);

/** Betrifft eine Linieninfo die gefahrene Strecke? Mit "zwischen A und B": Die Strecke muss sich mit der Fahrt überlappen,
 *  sonst: Eine Haltestelle der Fahrt kommt im Text vor oder die Meldung hat hohe Priorität. */
/** Der Untertitel der Verbünde ist oft mitten im Wort abgeschnitten ("… bis Frei"): dann den ersten ganzen Satz aus dem Volltext nehmen. */
export function summaryOf(subtitle, text) {
  const sub = plain(subtitle || ''), t = plain(text || '');
  if (!t) return sub;
  if (sub && !(t.length > sub.length && t.startsWith(sub.slice(0, 30)) && !/[.!?]$/.test(sub))) return sub;
  const re = /(?<![\d\s])[.!?](?=\s+[A-ZÄÖÜ]|$)/g;
  let m;
  while ((m = re.exec(t))) if (m.index >= 30) return t.slice(0, m.index + 1).slice(0, 260);
  return t.slice(0, 260);
}

export function infoRelevant(info, names) {
  if (!names.length) return true;
  const low = (t) => String(t).toLowerCase().replace(/ß/g, 'ss');
  const text = low(plain(`${info.subtitle || ''}. ${(info.infoLinks || []).map((l) => l.content).join(' ')}`));
  const stops = names.map((n) => low(n).trim()).filter((n) => n.length >= 4);
  const inner = stops.slice(1, -1);
  const hit = (e, list) => e.split('/').map((x) => x.trim()).filter((x) => x.length >= 4).some((x) => list.some((n) => n.includes(x) || x.includes(n)));
  const segs = [...text.matchAll(/zwischen\s+(.{1,60}?)\s+und\s+(.{1,60}?)(?=[.,;:]|\s(?:zu|von|im|in|ist|sind|kommt|besteht|verkehr\w*|fahren|ab|bis|auf|nur|durchgehend|beginn\w*|enden)\b|$)/g)];
  if (segs.length) return segs.some(([, a, b]) => (hit(a, stops) && hit(b, stops)) || hit(a, inner) || hit(b, inner));
  return stops.some((n) => text.includes(n)) || ['high', 'veryhigh'].includes(String(info.priority || '').toLowerCase());
}

export function parseLeg(l, key) {
  const t = l.transportation;
  if (!t || (t.product?.class ?? 0) >= 99) return null;     // Fußweg, Umstieg
  const seq = (l.stopSequence || []).map((x) => stopOf(key, x));
  const names = seq.map((x) => x.name);
  const o = l.origin || {}, d = l.destination || {};
  const rt = [].concat(l.realtimeStatus || []);
  const remarks = [];
  for (const h of l.hints || []) {
    if (!h?.content || h.type === 'Timetable') continue;     // Fahrradhinweise & Co. sind kein Betriebsereignis
    remarks.push({ type: 'status', code: h.providerCode || '', priority: null, summary: plain(h.content), text: plain(h.content), validFrom: null, validUntil: null });
  }
  for (const i of l.infos || []) {
    if (!infoRelevant(i, names)) continue;
    const text = plain((i.infoLinks || []).map((x) => x.content).join(' '));
    remarks.push({ type: 'warning', code: i.id || '', priority: null, summary: summaryOf(i.subtitle, text), text: text || plain(i.subtitle), validFrom: null, validUntil: null });
  }
  return {
    line: { name: String(t.number || t.name || '?').replace(/\s*\(.*$/, '').trim() || '?', product: productOf(t.product) },
    direction: t.destination?.name || '',
    origin: stopOf(key, o), destination: stopOf(key, d),
    plannedDep: o.departureTimePlanned || o.departureTimeBaseTimetable, dep: o.departureTimeEstimated || o.departureTimePlanned, depDelay: delayMin(o.departureTimePlanned, o.departureTimeEstimated),
    plannedArr: d.arrivalTimePlanned || d.arrivalTimeBaseTimetable, arr: d.arrivalTimeEstimated || d.arrivalTimePlanned, arrDelay: delayMin(d.arrivalTimePlanned, d.arrivalTimeEstimated),
    plannedPlatform: o.properties?.plannedPlatformName || o.properties?.platformName || null,
    platform: o.properties?.platformName || o.properties?.plannedPlatformName || null,
    cancelled: Boolean(l.isCancelled) || rt.some((x) => /CANCEL/i.test(String(x))),
    tripId: t.properties?.AVMSTripID || t.id || '',
    stopovers: seq, remarks,
  };
}

/** Antwort von XML_TRIP_REQUEST2 -> Journey[] (nur Fahrten mit Linie) */
export function parseJourneys(data, key = 'efa') {
  return (data?.journeys || []).map((j) => ({ legs: (j.legs || []).map((l) => parseLeg(l, key)).filter(Boolean) })).filter((j) => j.legs.length);
}
