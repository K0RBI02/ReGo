// Fachlogik: Haltestellensuche und kompletter Zustand je Gerät im Format des Datenvertrags.
import { TtlCache } from './store/cache.mjs';
import { berlin, hhmm } from './lib/time.mjs';
import { distanceKm, regionOf } from './lib/geo.mjs';
import { buildTour, stillVisible, THEME, SCHEMA_VERSION } from './domain/state.mjs';
import { createProviders } from './providers/index.mjs';

/** Wartet höchstens ms auf p. Danach gilt fallback() (falls es etwas liefert), sonst ein Fehler. Der Abruf selbst läuft weiter und füllt den Cache. */
function withDeadline(p, ms, fallback) {
  let timer;
  const timeout = new Promise((resolve, reject) => {
    timer = setTimeout(() => { const f = fallback && fallback(); if (f) resolve(f); else reject(new Error('Zeitüberschreitung')); }, ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

const sortTours = (a, b) => (a.active === b.active ? (a.distanceKm ?? 1e9) - (b.distanceKm ?? 1e9) : a.active ? -1 : 1);

export function createService({ config, store, now = () => Date.now(), providers = createProviders(config, now), cache = new TtlCache(now) }) {
  const log = (...a) => config.verbose && console.log(...a);
  const DEADLINE_MS = config.tourDeadlineMs || 12000;          // so lange darf eine Strecke höchstens auf ihre Daten warten
  const MAP_BUDGET_MS = config.mapBudgetMs || 5000;            // und so lange das Nachschlagen weiterer Linien für die Karte
  const STALE_MAX_SEC = config.staleMaxSec?.journeys ?? 30 * 60;   // ältere Fahrten zeigen wir bei Störung nicht mehr

  async function searchStations(q) {
    const query = String(q || '').trim();
    if (query.length < 2) return [];
    const { value } = await cache.get(`search:${query.toLowerCase()}`, config.ttl.search, () => providers.searchStops(query));
    if (value.partial) cache.map.delete(`search:${query.toLowerCase()}`);      // unvollständig (eine Quelle war zu langsam): beim nächsten Mal neu fragen
    return value.map((s) => ({ id: s.id, name: s.name, region: regionOf(s) || 'DE', lat: s.lat, lon: s.lon }));
  }

  const linesAt = async (id) => {
    const client = providers.forStop ? providers.forStop({ id }) : (regionOf({ id }) === 'AT' ? providers.oebb : providers.db);
    const { value } = await cache.get(`stop:${id}`, config.ttl.stop, () => client.stop(id));
    return value.lines || [];
  };

  async function getState(device, { lat, lon } = {}) {
    const profile = await store.load(device);
    const t = now();
    const lines = {};
    const tours = [], incidents = [];
    let stale = false, failed = 0, oldest = t, hadData = false;
    const here = lat != null && lon != null ? { lat: Number(lat), lon: Number(lon) } : null;

    await Promise.all(profile.tours.map(async (tour, i) => {
      if (tour.active === false) { tours[i] = { out: { id: tour.id, name: tour.name, lineId: '', active: false, period: tour.period, ...(tour.returnId ? { returnId: tour.returnId } : {}), ...(tour.returnOf ? { returnOf: tour.returnOf } : {}), distanceKm: null, schedule: tour.schedule, departures: [] }, inc: [] }; return; }
      const client = (providers.forTourSafe || providers.forTour).call(providers, tour.from, tour.to);
      let journeys = [], tourStale = false;
      const key = `jl:${tour.from.id}:${tour.to.id}`;
      try {
        const r = await withDeadline(
          cache.get(key, config.ttl.journeys, () => client.journeys({ from: tour.from, to: tour.to, fromId: tour.from.id, toId: tour.to.id, when: new Date(t).toISOString(), results: 5 }), { maxStaleSec: STALE_MAX_SEC }),
          DEADLINE_MS, () => { const hit = cache.peek(key); return hit && (t - hit.at) / 1000 <= STALE_MAX_SEC ? { value: hit.value, at: hit.at, stale: true } : null; });
        journeys = r.value; hadData = true;
        if (r.stale) { stale = true; tourStale = true; oldest = Math.min(oldest, r.at); }
      } catch (err) { failed++; stale = true; tourStale = true; log('Abruf fehlgeschlagen', tour.id, err.message); }
      const started = Date.now();
      const linesAtBudget = (id) => (Date.now() - started > MAP_BUDGET_MS ? Promise.resolve([]) : withDeadline(linesAt(id), Math.max(300, MAP_BUDGET_MS - (Date.now() - started)), () => []));
      const fromStop = { ...tour.from, ...(await withDeadline(stopCoords(tour.from), 3000, () => ({}))) };
      const dist = here && fromStop.lat != null ? distanceKm(here, fromStop) : null;
      const built = await buildTour(tour, journeys, { now: t, minDelay: config.incidentMinDelay, linesAt: linesAtBudget, lines, distanceKm: dist, graceMin: profile.settings.delayGraceMin, stale: tourStale });
      if (tourStale) built.tour.stale = true;                  // diese Strecke zeigt alte Daten (oder gar keine)
      tours[i] = { out: built.tour, inc: built.incidents };
    }));

    const outTours = tours.filter(Boolean).map((x) => x.out).sort(sortTours);
    for (const x of tours) if (x) incidents.push(...x.inc.filter((inc) => stillVisible(inc, t, profile.settings.delayGraceMin)));
    incidents.sort((a, b) => b.severity - a.severity);

    const active = profile.tours.filter((x) => x.active !== false).length;
    const allFailed = active > 0 && failed === active && !hadData;
    const b = berlin(t);
    return {
      schemaVersion: SCHEMA_VERSION,
      clock: { date: b.date, now: b.time },
      connection: { status: allFailed || stale ? 'error' : 'ok', loading: false, lastSync: hhmm(stale ? oldest : t) },
      settings: profile.settings,
      theme: THEME, lines, tours: outTours, incidents,
    };
  }

  async function stopCoords(stop) {
    if (stop.lat != null) return {};
    try {
      const { value } = await cache.get(`stop:${stop.id}`, config.ttl.stop, () => (providers.forStop ? providers.forStop(stop) : providers.forTour(stop, stop)).stop(stop.id));
      return { lat: value.lat, lon: value.lon };
    } catch { return {}; }
  }

  return { searchStations, getState, providers, cache };
}
