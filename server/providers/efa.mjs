// Client for the EFA interfaces of the transport associations (e.g. MVV). Format "rapidJSON".
// Stop IDs get the prefix of the association ("mvv|de:09162:2") so that ReGo knows where a request belongs.
// Normalized types as in hafas.mjs: Stop { id, name, lat, lon, products? }
import { ProviderError } from './hafas.mjs';
import { SourcePause, retryAfterSec, fmtPause } from './pause.mjs';
import { berlin } from '../lib/time.mjs';

const COORD = 'WGS84[dd.ddddd]';

const SECOND_TRY_PAUSE_MS = 5 * 60000;     // the second try (few transfers) found nothing: not again for this long
const NOTE_EVERY_MS = 10 * 60000;          // one log line per route and this long about an answer without trips

export class EfaClient {
  /** maxParallel: at most this many requests at the same time (more wait in line); pause: what to do after "too many requests" (HTTP 429) */
  constructor(base, { key = 'efa', fetchImpl = (...a) => globalThis.fetch(...a), userAgent = 'ReGo', timeoutMs = 8000, retries = 1, maxParallel = 3, pause = new SourcePause(), log = () => {}, now = () => Date.now() } = {}) {
    this.base = base.replace(/\/$/, ''); this.key = key; this.name = key;
    this.fetch = fetchImpl; this.userAgent = userAgent; this.timeoutMs = timeoutMs; this.retries = retries;
    this.pause = pause; this.log = log; this.now = now; this.maxParallel = maxParallel; this.running = 0; this.waiting = [];
    this.noLuck = new Map(); this.noted = new Map();      // route -> until when the second try is skipped / when the last log line was written
  }

  owns(id) { return String(id || '').startsWith(`${this.key}|`); }
  raw(id) { return String(id).slice(this.key.length + 1); }

  /** false while the source has us on pause (it said "too many requests"): the station search then leaves it out. */
  healthy() { return !this.pause.active(); }

  /** Runs fn when one of the parallel places is free. The place is handed on directly, so the limit holds even with many waiting. */
  async place(fn) {
    if (this.running >= this.maxParallel) await new Promise((r) => this.waiting.push(r));
    else this.running++;
    try { return await fn(); }
    finally { const next = this.waiting.shift(); if (next) next(); else this.running--; }
  }

  async get(path, params = {}) {
    const qs = new URLSearchParams({ outputFormat: 'rapidJSON', coordOutputFormat: COORD, language: 'de', ...params }).toString();
    const url = `${this.base}/${path}?${qs}`;
    let lastErr;
    for (let attempt = 0; attempt <= this.retries; attempt++) {
      try {
        // The answer is judged before the place is handed on, so a "too many requests" stops the ones waiting in line
        return await this.place(async () => {
          // Checked only now (after waiting in line): if the source has just said "too many requests", nothing more goes out
          if (!this.pause.allow()) throw new ProviderError(`${this.name}: derzeit nicht erreichbar (zu viele Anfragen, Pause noch ${fmtPause(Math.max(1, this.pause.left()))})`, { status: 429, kind: 'network', source: this.name });
          const res = await this.fetch(url, { headers: { 'user-agent': this.userAgent, accept: 'application/json' }, signal: AbortSignal.timeout(this.timeoutMs) });
          if (res.ok) { const data = await res.json(); this.pause.ok(); return data; }
          if (res.status === 429) throw await this.tooMany(res);
          throw new ProviderError(`${this.name}: HTTP ${res.status}`, { status: res.status, kind: 'http' });
        });
      } catch (err) {
        // 4xx and "too many requests" are final: asking again right away would only make it worse
        if (err instanceof ProviderError && (err.status === 429 || (err.kind === 'http' && err.status < 500))) throw err;
        lastErr = err instanceof ProviderError ? err : new ProviderError(`${this.name}: ${err.name === 'TimeoutError' ? 'Zeitüberschreitung' : err.message}`, { kind: 'network' });
      }
      if (attempt < this.retries) await new Promise((r) => setTimeout(r, 400 * 2 ** attempt));
    }
    throw lastErr;
  }

  /** The source said HTTP 429: go on pause (as long as it asks, otherwise growing) and write one log line per pause. */
  async tooMany(res) {
    const asked = retryAfterSec(res);
    const { sec, fresh } = this.pause.limited(asked);
    if (fresh) {
      let said = '';
      try { said = String((await res.text?.()) || '').replace(/\s+/g, ' ').trim().slice(0, 100); } catch { /* no text, no problem */ }
      this.log(`${this.name}: zu viele Anfragen (HTTP 429${Number.isFinite(asked) ? `, Retry-After ${asked} s` : ''}${said ? `, „${said}“` : ''}) – Pause ${fmtPause(sec)}`);
    }
    return new ProviderError(`${this.name}: HTTP 429 – zu viele Anfragen, Pause ${fmtPause(sec)}`, { status: 429, kind: 'http', source: this.name });
  }

  async searchStops(query) {
    const ask = (q) => this.get('XML_STOPFINDER_REQUEST', { type_sf: 'any', name_sf: q, anyObjFilter_sf: 2, anyMaxSizeHitList: 20 });
    const first = String(query).trim().split(/\s+/)[0];
    // Several words ("Lindau Hb"): with an incomplete 2nd word the association often finds only side issues -> additionally ask for the first word alone
    const [main, wide] = await Promise.allSettled([ask(query), first && first !== String(query).trim() && first.length >= 3 ? ask(first) : Promise.resolve(null)]);
    if (main.status === 'rejected' && !wide.value) throw main.reason;
    const locations = [...(main.value?.locations || []), ...(wide.value?.locations || [])];
    const seen = new Set();
    return parseStops({ locations: locations.filter((x) => x && !seen.has(x.id) && seen.add(x.id)) }, this.key, query);
  }

  /** One trip request -> { journeys, messages }. No trip and an error message of the source (other than -8011, "nothing found"): an error. */
  async trips(params) {
    const data = await this.get('XML_TRIP_REQUEST2', params);
    const messages = data?.systemMessages || [];
    const errs = messages.filter((m) => m.type === 'error' && m.code !== -8011);
    if (!data?.journeys?.length && errs.length) throw new ProviderError(`${this.name}: ${errs[0].text || 'Fehler ' + errs[0].code}`, { kind: 'http' });
    return { journeys: parseJourneys(data, this.key), messages };
  }

  /** Does the answer hold a trip that has not left yet (when = the time asked for)? EFA also returns a trip or two from before that time. */
  ahead(journeys, when) {
    const from = new Date(when).getTime() - 2 * 60000;
    return (journeys || []).some((j) => Date.parse(j.legs?.[0]?.dep) >= from);
  }

  /** Writes a log line, but for the same route only every NOTE_EVERY_MS. */
  note(route, text) {
    const t = this.now();
    if (t - (this.noted.get(route) ?? -Infinity) < NOTE_EVERY_MS) return;
    if (this.noted.size >= 500) this.noted.clear();
    this.noted.set(route, t);
    this.log(text);
  }

  /**
   * Connections from "when", including intermediate stops and remarks. transfers = at most this many transfers (0 = direct connections only).
   * from/to: the stops (only for the log).
   */
  async journeys({ fromId, toId, when, results = 5, transfers = 0, from, to }) {
    const b = berlin(new Date(when).getTime());
    const params = {
      type_origin: 'any', name_origin: this.raw(fromId), type_destination: 'any', name_destination: this.raw(toId),
      itdDate: b.date.replaceAll('-', ''), itdTime: b.time.replace(':', ''), itdTripDateTimeDepArr: 'dep',
      calcNumberOfTrips: results, maxChanges: transfers, useRealtime: 1,
    };
    const first = await this.trips(params);
    if (!transfers || this.ahead(first.journeys, when)) return first.journeys;

    // EFA first calculates a few candidate trips and only then drops the ones with more transfers than allowed (maxChanges). When the network is in
    // a bad state (closures) that can leave nothing, or only trips that have left already – and the answer differs from minute to minute.
    // So we ask once more, this time for the trips with the fewest transfers; if that does not help either, the first answer stands.
    const route = `${fromId}>${toId}`;
    if (this.now() < (this.noLuck.get(route) ?? 0)) return first.journeys;
    let second = { journeys: [] }, failed = '';
    try { second = await this.trips({ ...params, routeType: 'LEASTINTERCHANGE' }); } catch (err) { failed = err.message; }
    const found = this.ahead(second.journeys, when);
    if (this.noLuck.size >= 500) this.noLuck.clear();
    this.noLuck.set(route, found ? 0 : this.now() + SECOND_TRY_PAUSE_MS);
    const said = first.messages.slice(0, 3).map((m) => `${m.type || '?'} ${m.code ?? ''} ${m.text || m.module || ''}`.replace(/\s+/g, ' ').trim()).join('; ').slice(0, 240);
    this.note(route, `${this.name}: ${first.journeys.length ? 'nur schon abgefahrene Fahrten' : 'keine Fahrt'} mit höchstens ${transfers} Umstieg ${from?.name && to?.name ? `${from.name} → ${to.name}` : route}${said ? ` (Meldungen der Quelle: ${said})` : ''} – zweite Abfrage mit wenigen Umstiegen: ${failed ? `Fehler ${failed}` : found ? `${second.journeys.length} Fahrten` : 'auch nichts'}`);
    return found ? second.journeys : first.journeys;
  }

  /** Coordinates of a stop; EFA does not return lines here (empty list, map without connections). */
  async stop(id) {
    const gid = this.raw(id);
    let s = {};
    try { s = parseStops(await this.get('XML_STOPFINDER_REQUEST', { type_sf: 'any', name_sf: gid, anyObjFilter_sf: 2 }), this.key).find((x) => x.id === id) || {}; } catch { /* carry on without coordinates */ }
    return { id, name: s.name || '', lat: s.lat, lon: s.lon, lines: [] };
  }
}

/** Answer of the stop search -> Stop[]; best hits first, at most 8. */
const STATION = /\b(hbf|hauptbahnhof|bahnhof|bf)\b/i;
/** The smaller the better: exact name, then station with the search term at the start, then start, then contained anywhere. */
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

/** Does a line info concern the route travelled? With "zwischen A und B" (between A and B): the section must overlap with the trip,
 *  otherwise: a stop of the trip appears in the text or the message has high priority. */
/** The subtitle of the associations is often cut off in the middle of a word ("… bis Frei"): then take the first whole sentence from the full text. */
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
  if (!t || (t.product?.class ?? 0) >= 99) return null;     // walking leg, transfer
  const seq = (l.stopSequence || []).map((x) => stopOf(key, x));
  const names = seq.map((x) => x.name);
  const o = l.origin || {}, d = l.destination || {};
  const rt = [].concat(l.realtimeStatus || []);
  const remarks = [];
  for (const h of l.hints || []) {
    if (!h?.content || h.type === 'Timetable') continue;     // bicycle notes & co. are no operational event
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
    rt: Boolean(o.departureTimeEstimated) || rt.some((x) => /^MONITORED$/i.test(String(x))),      // an estimated time or "monitored": otherwise the 0 minutes only mean "unknown"
    plannedArr: d.arrivalTimePlanned || d.arrivalTimeBaseTimetable, arr: d.arrivalTimeEstimated || d.arrivalTimePlanned, arrDelay: delayMin(d.arrivalTimePlanned, d.arrivalTimeEstimated),
    plannedPlatform: o.properties?.plannedPlatformName || o.properties?.platformName || null,
    platform: o.properties?.platformName || o.properties?.plannedPlatformName || null,
    plannedArrPlatform: d.properties?.plannedPlatformName || d.properties?.platformName || null,
    arrPlatform: d.properties?.platformName || d.properties?.plannedPlatformName || null,
    cancelled: Boolean(l.isCancelled) || rt.some((x) => /CANCEL/i.test(String(x))),
    tripId: t.properties?.AVMSTripID || t.id || '',
    stopovers: seq, remarks,
  };
}

/** Answer of XML_TRIP_REQUEST2 -> Journey[] (only trips with a line) */
export function parseJourneys(data, key = 'efa') {
  return (data?.journeys || []).map((j) => ({ legs: (j.legs || []).map((l) => parseLeg(l, key)).filter(Boolean) })).filter((j) => j.legs.length);
}
