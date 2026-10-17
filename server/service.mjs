// Core logic: station search and the complete state of a device, in the shape the UI expects.
import { TtlCache } from './store/cache.mjs';
import { berlin, hhmm, fromBerlin, weekday } from './lib/time.mjs';
import { distanceKm, regionOf } from './lib/geo.mjs';
import { buildTour, stillVisible, THEME, SCHEMA_VERSION } from './domain/state.mjs';
import { buildTransferTour, transferVias, previewRoute, shortcutFor } from './domain/transfer.mjs';
import { classifyRemark } from './domain/classify.mjs';
import { windowState, windowView, windowRank, pushActive, DEFAULT_SCHEDULE } from './domain/window.mjs';
import { createProviders } from './providers/index.mjs';

/** Names of the sources in the texts for the traveller */
const SOURCE_NAME = { mvv: 'MVV', moby: 'MoBY', db: 'DB', oebb: 'ÖBB' };
/** The source that has put ReGo on pause ("too many requests", HTTP 429), as a name for the texts. '' for every other error. */
const pausedSource = (err) => (err?.status === 429 && err.source ? SOURCE_NAME[err.source] || err.source : '');
/** Why a route has no data, if the reason is known: the pause itself is logged once by the source, so there is no line per route and minute. */
const noteOf = (err) => { const src = pausedSource(err); return src ? `${src} lässt gerade keine Abfragen zu. ReGo fragt später wieder an.` : ''; };

/** Waits at most ms for p. After that fallback() applies (if it returns something), otherwise an error. The request itself keeps running and fills the cache. */
function withDeadline(p, ms, fallback) {
  let timer;
  const timeout = new Promise((resolve, reject) => {
    timer = setTimeout(() => { const f = fallback && fallback(); if (f) resolve(f); else reject(new Error('Zeitüberschreitung')); }, ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

// Active first; then the route whose commute time is running, before the one that comes later today, before the rest; otherwise by distance
const sortTours = (a, b) => (a.active !== b.active ? (a.active ? -1 : 1)
  : (windowRank(a.window?.mode) - windowRank(b.window?.mode)) || (a.window?.mode === 'soon' && b.window?.mode === 'soon' ? (a.window.from < b.window.from ? -1 : a.window.from > b.window.from ? 1 : 0) : 0)
    || (a.distanceKm ?? 1e9) - (b.distanceKm ?? 1e9));

export function createService({ config, store, now = () => Date.now(), providers = createProviders(config, now), cache = new TtlCache(now) }) {
  const log = (...a) => config.verbose && console.log(...a);
  const DEADLINE_MS = config.tourDeadlineMs || 12000;          // a route may wait this long at most for its data
  const MAP_BUDGET_MS = config.mapBudgetMs || 5000;            // and this long for looking up further lines for the map
  const STALE_MAX_SEC = config.staleMaxSec?.journeys ?? 30 * 60;   // we no longer show older trips during a disruption
  const B_DEADLINE_MS = config.transferDeadlineMs || 4000;     // connecting trips from the transfer station: we wait this long at most (otherwise the source's own suggestion counts)
  const XFER_RESULTS = 8;                                      // connections with a transfer: request a few more so that enough remain per feeder after merging
  const IDLE_TTL_SEC = config.ttl.idle ?? 600;                 // background check (push): a route that cannot push at the moment is refreshed only this often
  const KEEP_GOOD_SEC = config.keepGoodSec ?? 600;             // an answer without any trip right after a good one: the good one counts for this long
  const BANNER_AFTER_SEC = config.staleBannerSec ?? 300;       // "Server offline" only when a route shows data at least this old

  // A source can answer with nothing although it showed trips a moment ago: EFA first calculates a few candidate trips and only then drops the ones
  // with too many transfers, so on a day of closures its answers differ from minute to minute. For KEEP_GOOD_SEC the trips of the last good answer
  // that have not left yet count instead of "no connection" – the same query gives the preview and the route the same trips.
  const good = new Map();                                      // cache key -> { at, list }: the last answer that held a trip ahead
  const ahead = (j, t) => Date.parse(j?.legs?.[0]?.dep) >= t - 120000;     // same limit as the routes use for "has left"
  const noted = new Map();
  /** One log line per key and ten minutes */
  const noteOnce = (key, text) => {
    const t = now();
    if (t - (noted.get(key) ?? -Infinity) < 600e3) return;
    if (noted.size >= 500) noted.clear();
    noted.set(key, t); log(text);
  };

  /** cache.get for connection queries (stale data on errors included); an answer without a trip is handled as described above. */
  const askTrips = (key, ttl, ask) => cache.get(key, ttl, async () => {
    const list = await ask();
    const t = now();
    if ((list || []).some((j) => ahead(j, t))) {
      good.delete(key); good.set(key, { at: t, list });
      while (good.size > 1500) good.delete(good.keys().next().value);
      return list;
    }
    const g = good.get(key);
    const keep = g && t - g.at <= KEEP_GOOD_SEC * 1000 ? g.list.filter((j) => ahead(j, t)) : [];
    if (!keep.length) return list;
    noteOnce(`keep:${key}`, `Antwort ohne Fahrt (${key}): die letzte gute Antwort von ${hhmm(g.at)} bleibt (${keep.length} Fahrten)`);
    return keep;
  }, { maxStaleSec: STALE_MAX_SEC });

  async function searchStations(q) {
    const query = String(q || '').trim();
    if (query.length < 2) return [];
    const { value } = await cache.get(`search:${query.toLowerCase()}`, config.ttl.search, () => providers.searchStops(query));
    if (value.partial) cache.map.delete(`search:${query.toLowerCase()}`);      // incomplete (one source was too slow): ask again next time
    return value.map((s) => ({ id: s.id, name: s.name, region: regionOf(s) || 'DE', lat: s.lat, lon: s.lon }));
  }

  /** Are there trips without a transfer between the two stops? true | false | null (source does not answer: unknown). Uses the same cache as getState. */
  async function hasDirect(from, to) {
    const client = (providers.forTourSafe || providers.forTour).call(providers, from, to);
    const key = `jl:${from.id}:${to.id}`;
    try {
      const r = await withDeadline(
        askTrips(key, config.ttl.journeys, () => client.journeys({ from, to, fromId: from.id, toId: to.id, when: new Date(now()).toISOString(), results: 5 })),
        DEADLINE_MS, () => null);
      return (r.value || []).length > 0;
    } catch (err) { log('Prüfung beim Anlegen fehlgeschlagen', from.id, to.id, err.message); return null; }
  }

  /** Connections with at most one transfer. Uses the same query and the same cache as getState. */
  const transferJourneys = (from, to, t, stamp = '') => {
    const client = (providers.forTourSafe || providers.forTour).call(providers, from, to);
    const key = `jl:${from.id}:${to.id}:t1${stamp}`;
    return { key, load: (ttl = config.ttl.journeys) => askTrips(key, ttl, () => client.journeys({ from, to, fromId: from.id, toId: to.id, when: new Date(t).toISOString(), results: XFER_RESULTS, transfers: 1 })) };
  };

  /**
   * A typical commute morning, for the check at creation when nothing is left today: the next weekday at 07:30, at least two hours from now.
   * The route is meant for such mornings; a closure over the weekend or the night without service must not decide whether it can be created.
   */
  const commuteSample = (t) => {
    const [y, m, d] = berlin(t).date.split('-').map(Number);
    for (let i = 0; i < 9; i++) {
      const ms = fromBerlin(new Date(Date.UTC(y, m - 1, d + i)).toISOString().slice(0, 10), '07:30');
      if (ms - t >= 2 * 3600e3 && !['Sa', 'So'].includes(weekday(ms))) return ms;
    }
    return null;
  };

  /**
   * Are there trips with at most one transfer between the two stops? true | false | null (unknown) – and a sample connection. paused = name of the source that has put ReGo on pause.
   * The answer for "now" comes first. If it holds no trip that is still to come (closure, no service at the moment), the next normal morning is checked as well:
   * the question is whether the two stops are connected, not what runs this minute. The route itself keeps showing the current state.
   */
  async function searchTransfer(from, to) {
    const t = now();
    const look = async (at, stamp, ttl) => {
      const q = transferJourneys(from, to, at, stamp);
      const r = await withDeadline(q.load(ttl), DEADLINE_MS, () => { const hit = cache.peek(q.key); return hit && (t - hit.at) / 1000 <= STALE_MAX_SEC ? { value: hit.value, at: hit.at, stale: true } : null; });
      return r.value || [];
    };
    try {
      const route = previewRoute(await look(t, ''), t);      // a trip that has left already is no sample: the route would not show it either
      if (route) return { found: true, route };
      const m = commuteSample(t);
      if (m) {
        const sample = previewRoute(await look(m, `@${berlin(m).date}`, 600), m, t);
        if (sample) return { found: true, route: sample };
      }
      return { found: false, route: null };
    } catch (err) {
      if (err?.status !== 429) log('Suche mit Umstieg fehlgeschlagen', from.id, to.id, err.message);
      return { found: null, route: null, ...(pausedSource(err) ? { paused: pausedSource(err) } : {}) };      // paused: a source that has put ReGo on pause is the reason
    }
  }

  /** Connecting trips from the transfer station to the destination (second query), per station; if one is missing it is left out and the source's own suggestion counts. */
  async function loadBLists(tour, journeys, t, stamp = '', ttl = config.ttl.journeys) {
    const out = new Map();
    await Promise.all(transferVias(journeys).slice(0, 2).map(async (v) => {
      const client = (providers.forTourSafe || providers.forTour).call(providers, v.stop, tour.to);
      const key = `jb:${v.stop.id}:${tour.to.id}${stamp}`;
      const when = new Date(Math.max(t, v.firstArr - 10 * 60000)).toISOString();
      try {
        const r = await withDeadline(
          askTrips(key, ttl, () => client.journeys({ from: v.stop, to: tour.to, fromId: v.stop.id, toId: tour.to.id, when, results: 10 })),
          B_DEADLINE_MS, () => { const hit = cache.peek(key); return hit && (t - hit.at) / 1000 <= STALE_MAX_SEC ? { value: hit.value, at: hit.at, stale: true } : null; });
        out.set(v.key, (r.value || []).map((j) => j.legs?.[0]).filter((l) => l && l.line));
      } catch (err) { if (err?.status !== 429) log('Anschlussfahrten nicht verfügbar', v.name, err.message); }
    }));
    return out;
  }

  /**
   * "Schneller mit 1 Umstieg" (faster with 1 transfer): if a route without transfer has replacement transport, we also ask for connections with at most one transfer
   * (same query and same cache as the search with 1 transfer when a route is created). Without replacement transport this costs nothing. Returns a function for
   * buildTour, or undefined if there is nothing to check or the source does not answer in time (then there is simply no hint).
   */
  async function loadShortcut(tour, journeys, t, at = t, stamp = '', ttl = config.ttl.journeys) {
    if (!journeys.some((j) => (j.legs?.[0]?.remarks || []).some((r) => classifyRemark(r) === 'replacement'))) return undefined;
    const q = transferJourneys(tour.from, tour.to, at, stamp);
    try {
      const r = await withDeadline(q.load(ttl), B_DEADLINE_MS, () => { const hit = cache.peek(q.key); return hit && (t - hit.at) / 1000 <= STALE_MAX_SEC ? { value: hit.value, at: hit.at, stale: true } : null; });
      const list = r.value || [];
      return (o) => shortcutFor(list, { now: t, ...o });
    } catch (err) { if (err?.status !== 429) log('Vorschlag mit Umstieg nicht verfügbar', tour.id, err.message); return undefined; }
  }

  const linesAt = async (id) => {
    const client = providers.forStop ? providers.forStop({ id }) : (regionOf({ id }) === 'AT' ? providers.oebb : providers.db);
    const { value } = await cache.get(`stop:${id}`, config.ttl.stop, () => client.stop(id));
    return value.lines || [];
  };

  /** background: the push check asks, nobody is looking at the screen. Routes that cannot push right now are then only refreshed every IDLE_TTL_SEC. */
  async function getState(device, { lat, lon, background = false } = {}) {
    const profile = await store.load(device);
    const t = now();
    const lines = {};
    const tours = [], incidents = [];
    let stale = false, failed = 0, served = 0, oldest = t, hadData = false;      // served = routes that show older data from the cache
    const here = lat != null && lon != null ? { lat: Number(lat), lon: Number(lon) } : null;

    await Promise.all(profile.tours.map(async (tour, i) => {
      if (tour.active === false) { tours[i] = { out: { id: tour.id, name: tour.name, lineId: '', active: false, period: tour.period, ...(tour.transfers === 1 ? { transfers: 1 } : {}), ...(tour.returnId ? { returnId: tour.returnId } : {}), ...(tour.returnOf ? { returnOf: tour.returnOf } : {}), distanceKm: null, ...windowView(tour.schedule, t), departures: [] }, inc: [] }; return; }
      const client = (providers.forTourSafe || providers.forTour).call(providers, tour.from, tour.to);
      let journeys = [], tourStale = false, staleNote = '';
      const xfer = tour.transfers === 1;
      // Commute time: before the window (a few hours before at most) we request the trains from its start, otherwise from now
      const win = windowState(tour.schedule || DEFAULT_SCHEDULE, t);
      const at = win.anchor ?? t, stamp = win.anchor ? `@${hhmm(win.anchor)}` : '';
      const ttl = background && !pushActive(tour, t) ? IDLE_TTL_SEC : config.ttl.journeys;
      const q = xfer ? transferJourneys(tour.from, tour.to, at, stamp) : null;
      const key = xfer ? q.key : `jl:${tour.from.id}:${tour.to.id}${stamp}`;
      try {
        const r = await withDeadline(
          xfer ? q.load(ttl) : askTrips(key, ttl, () => client.journeys({ from: tour.from, to: tour.to, fromId: tour.from.id, toId: tour.to.id, when: new Date(at).toISOString(), results: 5 })),
          DEADLINE_MS, () => { const hit = cache.peek(key); return hit && (t - hit.at) / 1000 <= STALE_MAX_SEC ? { value: hit.value, at: hit.at, stale: true } : null; });
        journeys = r.value; hadData = true;
        // Older data from the cache: the route says so itself. The banner over all screens only comes when the data is really old
        // (a refresh that failed once leaves data that is a minute old, which is no reason to say "Server offline")
        if (r.stale) { stale = true; tourStale = true; oldest = Math.min(oldest, r.at); if (t - r.at > BANNER_AFTER_SEC * 1000) served++; }
      } catch (err) {
        failed++; stale = true; tourStale = true; staleNote = noteOf(err);
        if (err?.status !== 429) log('Abruf fehlgeschlagen', tour.id, err.message);
      }
      const started = Date.now();
      const linesAtBudget = (id) => (Date.now() - started > MAP_BUDGET_MS ? Promise.resolve([]) : withDeadline(linesAt(id), Math.max(300, MAP_BUDGET_MS - (Date.now() - started)), () => []));
      const fromStop = { ...tour.from, ...(await withDeadline(stopCoords(tour.from), 3000, () => ({}))) };
      const dist = here && fromStop.lat != null ? distanceKm(here, fromStop) : null;
      const bLists = xfer && journeys.length ? await loadBLists(tour, journeys, t, stamp, ttl) : undefined;
      const shortcut = xfer || tourStale ? undefined : await loadShortcut(tour, journeys, t, at, stamp, ttl);
      const built = await (xfer ? buildTransferTour : buildTour)(tour, journeys, { now: t, minDelay: config.incidentMinDelay, linesAt: linesAtBudget, lines, distanceKm: dist, graceMin: profile.settings.delayGraceMin, stale: tourStale, staleNote, bLists, shortcutFor: shortcut, window: win });
      if (tourStale) built.tour.stale = true;                  // this route shows old data (or none at all)
      // For the log: a route with a transfer that finds nothing although the source answered – what did the source actually return?
      if (xfer && !tourStale && !built.tour.departures.length) noteOnce(`none:${tour.id}`, `Strecke ohne Abfahrt: ${tour.from.name} → ${tour.to.name} (1 Umstieg) – die Quelle lieferte ${journeys.length} Fahrten, ${journeys.filter((j) => ahead(j, t)).length} davon noch nicht abgefahren`);
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
      // "error" (the app says "Server offline") when nothing could be loaded or data that is really old (BANNER_AFTER_SEC) is shown as if it were
      // current. Routes without any data (e.g. one source is closed) say so themselves; they do not put the banner on top of the routes that are fine.
      connection: { status: allFailed || served ? 'error' : 'ok', loading: false, lastSync: hhmm(stale ? oldest : t) },
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

  return { searchStations, getState, hasDirect, searchTransfer, providers, cache };
}
