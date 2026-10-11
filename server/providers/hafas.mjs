// Client für transport.rest (hafas-client als REST-API). Wird für DB (ganz Deutschland, auch grenzüberschreitend)
// und ÖBB (Österreich) mit je eigener Basis-URL benutzt.
//
// Normalisierte Typen – der Rest des Backends kennt nur diese:
//   Stop   { id, name, lat, lon, products? }
//   Leg    { line:{name,product}, direction, origin:Stop, destination:Stop,
//            plannedDep, dep, depDelay (Min.), plannedArr, arr, arrDelay (Min.),
//            plannedPlatform, platform, cancelled, tripId, stopovers:[Stop], remarks:[Remark] }
//   Remark { type, code, text, summary, validFrom, validUntil, priority }
//   Journey{ legs:Leg[] }
export class ProviderError extends Error {
  constructor(message, { status = 0, kind = 'network' } = {}) { super(message); this.status = status; this.kind = kind; }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const min = (sec) => (sec == null ? 0 : Math.round(sec / 60));

export class HafasClient {
  constructor(base, { fetchImpl = (...a) => globalThis.fetch(...a), userAgent = 'ReGo', timeoutMs = 8000, retries = 2, name = 'hafas' } = {}) {
    this.base = base.replace(/\/$/, '');
    this.fetch = fetchImpl; this.userAgent = userAgent; this.timeoutMs = timeoutMs; this.retries = retries; this.name = name;
  }

  async get(path, params = {}) {
    const qs = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== '').map(([k, v]) => [k, String(v)])).toString();
    const url = `${this.base}${path}${qs ? `?${qs}` : ''}`;
    let lastErr;
    for (let attempt = 0; attempt <= this.retries; attempt++) {
      try {
        const res = await this.fetch(url, { headers: { 'user-agent': this.userAgent, accept: 'application/json' }, signal: AbortSignal.timeout(this.timeoutMs) });
        if (res.ok) return await res.json();
        const retryable = res.status === 429 || res.status >= 500;
        lastErr = new ProviderError(`${this.name}: HTTP ${res.status}`, { status: res.status, kind: 'http' });
        if (!retryable) throw lastErr;
        const wait = Number(res.headers?.get?.('retry-after')) || 0;
        if (attempt < this.retries) await sleep(Math.min(wait * 1000 || 400 * 2 ** attempt, 3000));
      } catch (err) {
        if (err instanceof ProviderError && err.kind === 'http' && !(err.status === 429 || err.status >= 500)) throw err;
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

  /** Direktverbindungen (ohne Umstieg) inkl. Zwischenhalte und Hinweise. */
  async journeys({ fromId, toId, when, results = 5 }) {
    const data = await this.get('/journeys', {
      from: fromId, to: toId, departure: when, results, transfers: 0,
      stopovers: true, remarks: true, language: 'de',
    });
    return (data.journeys || []).map(normJourney).filter((j) => j.legs.some((l) => l.line));
  }
}

/** "München Hbf Gl.27-36" -> "München Hbf", "Wien Hbf (Bahnsteige 3-12)" -> "Wien Hbf" */
export function cleanStopName(n = '') {
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
    plannedDep: l.plannedDeparture || l.departure, dep: l.departure || l.plannedDeparture, depDelay: min(l.departureDelay),
    plannedArr: l.plannedArrival || l.arrival, arr: l.arrival || l.plannedArrival, arrDelay: min(l.arrivalDelay),
    plannedPlatform: l.plannedDeparturePlatform || l.departurePlatform || null,
    platform: l.departurePlatform || l.plannedDeparturePlatform || null,
    cancelled: Boolean(l.cancelled), tripId: l.tripId || '',
    stopovers: (l.stopovers || []).map((x) => normStop(x.stop || x)),
    remarks: (l.remarks || []).filter((r) => r && (r.type === 'status' || r.type === 'warning') && (r.summary || r.text)).map(normRemark),
  };
}

export function normJourney(j) {
  return { legs: (j.legs || []).map(normLeg).filter((l) => !l.walk) };
}
