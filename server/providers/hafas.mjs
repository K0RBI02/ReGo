import { SourcePause, retryAfterSec, fmtPause } from './pause.mjs';

// Client for transport.rest (hafas-client as a REST API). Used for DB (all of Germany, also cross-border)
// and ÖBB (Austria), each with its own base URL.
//
// Normalised types – the rest of the backend only knows these:
//   Stop   { id, name, lat, lon, products? }
//   Leg    { line:{name,product}, direction, origin:Stop, destination:Stop,
//            plannedDep, dep, depDelay (min.), rt, plannedArr, arr, arrDelay (min.),
//            plannedPlatform, platform (departure platform), plannedArrPlatform, arrPlatform (arrival platform),
//            cancelled, tripId, stopovers:[Stop], remarks:[Remark] }
//   Remark { type, code, text, summary, validFrom, validUntil, priority }
//   Journey{ legs:Leg[] }
// rt = the source has real-time data for the departure. Without it depDelay is 0 only because nothing is known, not because the trip is on time.
export class ProviderError extends Error {
  /** source = name of the source that said "too many requests" (HTTP 429): the texts for the traveller can name it */
  constructor(message, { status = 0, kind = 'network', source = '' } = {}) { super(message); this.status = status; this.kind = kind; this.source = source; }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const min = (sec) => (sec == null ? 0 : Math.round(sec / 60));

export class HafasClient {
  constructor(base, { fetchImpl = (...a) => globalThis.fetch(...a), userAgent = 'ReGo', timeoutMs = 8000, retries = 2, name = 'hafas', pause = new SourcePause(), log = () => {} } = {}) {
    this.base = base.replace(/\/$/, '');
    this.fetch = fetchImpl; this.userAgent = userAgent; this.timeoutMs = timeoutMs; this.retries = retries; this.name = name;
    this.pause = pause; this.log = log;
  }

  /** false while the source has us on pause (it said "too many requests") */
  healthy() { return !this.pause.active(); }

  async get(path, params = {}) {
    const qs = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== '').map(([k, v]) => [k, String(v)])).toString();
    const url = `${this.base}${path}${qs ? `?${qs}` : ''}`;
    let lastErr;
    for (let attempt = 0; attempt <= this.retries; attempt++) {
      try {
        if (!this.pause.allow()) throw new ProviderError(`${this.name}: derzeit nicht erreichbar (zu viele Anfragen, Pause noch ${fmtPause(Math.max(1, this.pause.left()))})`, { status: 429, kind: 'network', source: this.name });
        const res = await this.fetch(url, { headers: { 'user-agent': this.userAgent, accept: 'application/json' }, signal: AbortSignal.timeout(this.timeoutMs) });
        if (res.ok) { const data = await res.json(); this.pause.ok(); return data; }
        if (res.status === 429) {
          const asked = retryAfterSec(res), { sec, fresh } = this.pause.limited(asked);
          if (fresh) this.log(`${this.name}: zu viele Anfragen (HTTP 429${Number.isFinite(asked) ? `, Retry-After ${asked} s` : ''}) – Pause ${fmtPause(sec)}`);
          throw new ProviderError(`${this.name}: HTTP 429 – zu viele Anfragen, Pause ${fmtPause(sec)}`, { status: 429, kind: 'http', source: this.name });
        }
        lastErr = new ProviderError(`${this.name}: HTTP ${res.status}`, { status: res.status, kind: 'http' });
        if (res.status < 500) throw lastErr;
        const wait = retryAfterSec(res);
        if (attempt < this.retries) await sleep(Math.min(Number.isFinite(wait) && wait > 0 ? wait * 1000 : 400 * 2 ** attempt, 3000));
      } catch (err) {
        // 4xx and "too many requests" are final: asking again right away would only make it worse
        if (err instanceof ProviderError && (err.status === 429 || (err.kind === 'http' && err.status < 500))) throw err;
        lastErr = err instanceof ProviderError ? err : new ProviderError(`${this.name}: ${err.name === 'TimeoutError' ? 'Zeitüberschreitung' : err.message}`, { kind: 'network' });
        if (attempt < this.retries) await sleep(400 * 2 ** attempt);
      }
    }
    throw lastErr;
  }

  async searchStops(query) {
    const data = await this.get('/locations', { query, results: 8, stops: true, addresses: false, poi: false, language: 'de' });
    return (Array.isArray(data) ? data : []).filter((x) => x.type === 'stop' || x.type === 'station').map(normStop);
  }

  async stop(id) {
    const s = await this.get(`/stops/${encodeURIComponent(id)}`, { linesOfStops: true, language: 'de' });
    const stop = normStop(s);
    stop.lines = (s.lines || []).filter((l) => l?.name).map((l) => ({ name: l.name, product: l.product || '' }));
    return stop;
  }

  /** Connections incl. stopovers and remarks. transfers = at most this many transfers (0 = direct connections only). */
  async journeys({ fromId, toId, when, results = 5, transfers = 0 }) {
    const data = await this.get('/journeys', {
      from: fromId, to: toId, departure: when, results, transfers,
      stopovers: true, remarks: true, language: 'de',
    });
    return (data.journeys || []).map(normJourney).filter((j) => j.legs.some((l) => l.line));
  }
}

/** "München Hbf Gl.27-36" -> "München Hbf", "Wien Hbf (Bahnsteige 3-12)" -> "Wien Hbf" */
export function cleanStopName(n = '') {
  // "München, München Hbf" -> "München Hbf" (place name doubled)
  n = String(n).replace(/^([^,→]+),\s*(\1\b.*)$/i, '$2');
  return String(n).replace(/\s+Gl\.[\w\-–, ]+$/i, '').replace(/\s*\((?:Bahnsteige?|Bstg\.?|Gleis)[^)]*\)\s*$/i, '').trim();
}

export function normStop(s = {}) {
  const base = s.stop && !s.id ? s.stop : s;
  return { id: base.id, name: cleanStopName(base.name), lat: base.location?.latitude, lon: base.location?.longitude, products: base.products || undefined };
}

export function normRemark(r) {
  return {
    type: r.type, code: r.code || '', priority: r.priority ?? null,
    summary: r.summary || '', text: r.text || r.summary || '',
    validFrom: r.validFrom || null, validUntil: r.validUntil || null,
  };
}

export function normLeg(l) {
  if (l.walking || (!l.line && l.transfer)) return { walk: true };
  return {
    line: { name: String(l.line?.name || '?').replace(/\s*\(.*$/, '').trim() || '?', product: l.line?.product || '' },
    direction: l.direction || '',
    origin: normStop(l.origin), destination: normStop(l.destination),
    plannedDep: l.plannedDeparture || l.departure, dep: l.departure || l.plannedDeparture, depDelay: min(l.departureDelay), rt: l.departureDelay != null,
    plannedArr: l.plannedArrival || l.arrival, arr: l.arrival || l.plannedArrival, arrDelay: min(l.arrivalDelay),
    plannedPlatform: l.plannedDeparturePlatform || l.departurePlatform || null,
    platform: l.departurePlatform || l.plannedDeparturePlatform || null,
    plannedArrPlatform: l.plannedArrivalPlatform || l.arrivalPlatform || null,
    arrPlatform: l.arrivalPlatform || l.plannedArrivalPlatform || null,
    cancelled: Boolean(l.cancelled), tripId: l.tripId || '',
    stopovers: (l.stopovers || []).map((x) => normStop(x.stop || x)),
    remarks: (l.remarks || []).filter((r) => r && (r.type === 'status' || r.type === 'warning') && (r.summary || r.text)).map(normRemark),
  };
}

export function normJourney(j) {
  return { legs: (j.legs || []).map(normLeg).filter((l) => !l.walk) };
}
