import { HafasClient, ProviderError } from './hafas.mjs';
import { mockFetch } from './mock.mjs';
import { createOebbClient } from './lib.mjs';
import { EfaClient, rankOf } from './efa.mjs';
import { regionOf, distanceKm } from '../lib/geo.mjs';

/** Provides { db, oebb, pick(stopId) } – Austria through ÖBB, otherwise DB (the DB API covers cross-border traffic). */
export function createProviders(config, now = () => Date.now()) {
  const common = { userAgent: config.upstream.userAgent, timeoutMs: config.upstream.timeoutMs, retries: config.upstream.retries, log: (...a) => config.verbose && console.log(...a) };
  const mock = config.provider === 'mock';
  const efas = mock ? [] : (config.upstream.efa || []).map((e) => new EfaClient(e.url, { ...common, key: e.key }));
  if (config.provider === 'library') {
    // Library first; if the source blocks it (e.g. OPS_BLOCKED) or it is missing, ReGo falls back to transport.rest.
    const quick = { ...common, timeoutMs: Math.min(common.timeoutMs, 4000), retries: 0 };     // fallback source: try briefly, do not wait long
    const restDb = new HafasClient(config.upstream.db, { ...quick, name: 'db' });
    const restOebb = new HafasClient(config.upstream.oebb, { ...quick, name: 'oebb' });
    const db = restDb;      // DB blocks the library (OPS_BLOCKED), therefore only transport.rest now
    const oebb = withFallback(createOebbClient(config.upstream.userAgent), restOebb, config);
    return build(db, oebb, false, efas, { log: common.log, now });
  }
  const db = new HafasClient(config.upstream.db, { ...common, name: 'db', ...(mock ? { fetchImpl: mockFetch({ now }), retries: 0 } : {}) });
  const oebb = new HafasClient(config.upstream.oebb, { ...common, name: 'oebb', ...(mock ? { fetchImpl: mockFetch({ now }), retries: 0 } : {}) });
  return build(db, oebb, mock, efas, { log: common.log, now });
}

export function withFallback(primary, fallback, config) {
  const log = (...a) => config.verbose && console.log(...a);
  let primaryDown = 0, fallbackDown = 0;   // after an error leave the source alone for a while (the railway would otherwise block even more, users wait for nothing)
  const run = async (m, args) => {
    const now = Date.now();
    if (now >= primaryDown) {
      try { return await primary[m](...args); }
      catch (e) { primaryDown = Date.now() + 10 * 60 * 1000; log(`Bibliothek ${primary.name || ''} fehlgeschlagen (${m}): ${e.message} – 10 Minuten Pause, nutze transport.rest`); }
    }
    if (Date.now() < fallbackDown) throw new ProviderError(`${primary.name || 'Quelle'}: derzeit nicht erreichbar`, { kind: 'network' });
    try { return await fallback[m](...args); }
    catch (e) { fallbackDown = Date.now() + 2 * 60 * 1000; log(`transport.rest ${primary.name || ''} fehlgeschlagen (${m}): ${e.message} – 2 Minuten Pause`); throw e; }
  };
  return { name: primary.name, healthy: () => Date.now() >= primaryDown || Date.now() >= fallbackDown, searchStops: (...a) => run('searchStops', a), stop: (...a) => run('stop', a), journeys: (...a) => run('journeys', a) };
}


const GRACE_MS = 2200;
/** Stations that could not be found under the name travellers know (id -> display name) */
const RENAME = { '8000230': 'Lindau (Bodensee) Hbf', 'moby|de:09776:1546': 'Lindau (Bodensee), Lindau Hbf' };

/** The first source first; if it returns nothing or fails, the second. */
function chain(first, second) {
  return {
    name: first.name,
    async journeys(args) {
      let err;
      try { const r = await first.journeys(args); if (r?.length) return r; if (process.env.REGO_VERBOSE) console.log(`Strecke ${args.from?.name || args.fromId} → ${args.to?.name || args.toId}: ${first.name} ohne Treffer, versuche ÖBB`); } catch (e) { err = e; if (process.env.REGO_VERBOSE) console.log(`Strecke ${args.from?.name || args.fromId} → ${args.to?.name || args.toId}: ${first.name} Fehler (${e.message}), versuche ÖBB`); }
      try { return await second.journeys(args); } catch (e) { throw err || e; }
    },
    stop: (id) => first.stop(id),
  };
}

const unsupported =(msg) => ({ name: 'efa', async journeys() { throw new ProviderError(msg, { kind: 'unsupported' }); }, async stop(id) { return { id, name: '', lines: [] }; } });

/** The source did not answer (timeout, 429, 5xx, on pause, refused) – as opposed to: it answered but does not know the stop. */
const sourceDown = (e) => e?.kind === 'network' || e?.status === 429 || e?.status === 401 || e?.status === 403 || e?.status >= 500 || /derzeit nicht erreichbar/.test(e?.message || '');

// ---- Stop names across sources -----------------------------------------------------------------------------------------

/** Words of a stop name in plain form: lower case, no umlauts, no brackets ("Lindau (Bodensee) Hbf" -> lindau hbf), "Ostbahnhof" -> "ost". */
const nameWords = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/\p{M}/gu, '').replace(/ß/g, 'ss').replace(/\(.*?\)/g, ' ')
  .split(/[^a-z0-9]+/).filter(Boolean).map((w) => w.replace(/(?<=.{2})(bahnhof|bhf|bf)$/, '') || w);
/** Words that say "station" and nothing else ("Hauptbahnhof" is "haupt" after nameWords). */
const STATION_WORDS = new Set(['bahnhof', 'bhf', 'bf', 'hbf', 'pbf', 'haupt', 'bahnhofsplatz', 'haltestelle', 'hp']);

/**
 * Does a stop of another source plausibly mean the same place? Used where ReGo steps in for an association and must not guess:
 * what is special about the original name ("Marienplatz" in "Fiktivia, Marienplatz") has to be in the other name as well, and the other
 * name must not add anything. The place before the comma and words like "Bahnhof" or "Hbf" do not count.
 * Only if the original has no comma (its place is unknown) the other may put its own place name in front: "Neuperlach Süd" and "München Neuperlach Süd".
 * Returns 0 (same words), 1 (the other adds its place name) or -1 (not the same place).
 */
export function spotMatch(name, other) {
  const s = String(name || ''), i = s.indexOf(',');
  const place = new Set(i > 0 ? nameWords(s.slice(0, i)) : []);
  const rest = (x) => new Set(nameWords(x).filter((w) => !STATION_WORDS.has(w) && !place.has(w)));
  const a = rest(i > 0 ? s.slice(i + 1) : s), b = rest(other);
  if (![...a].every((w) => b.has(w))) return -1;
  const extra = [...b].filter((w) => !a.has(w));
  if (!extra.length) return 0;
  if (i > 0) return -1;
  const o = String(other || ''), j = o.indexOf(',');
  const otherPlace = new Set(j > 0 ? nameWords(o.slice(0, j)) : nameWords(o).slice(0, 1));
  return extra.every((w) => otherPlace.has(w)) ? 1 : -1;
}

/** How long a stop that cannot be translated (not found, not plausible) is left alone before the other source is asked again. */
const REFUSED_MS = 15 * 60e3;

/**
 * Find the stop of one association again at the other provider (name + coordinates).
 * strict: ReGo steps in for a source that does not answer and must not guess: the stop needs coordinates, the name of the hit has to fit
 * (spotMatch) and a stop that cannot be translated is not searched again for a while (the answer is the same, the source is not to be asked every 30 seconds).
 */
export function createTranslator(efa, { strict = false, now = () => Date.now(), log = () => {} } = {}) {
  const cache = new Map(), pending = new Map(), refused = new Map(), told = new Set();
  /** What the operator needs to see to judge the name check: which stop was refused and what was close by (once per stop and source, not once per minute) */
  const tell = (stop, target, why) => { const k = `${target.name}|${stop.id}`; if (!told.has(k)) { told.add(k); log(`Ausweichquelle ${target.name}: „${stop.name}“ ${why}`); } };
  async function find(stop, target) {
    let { lat, lon } = stop;
    if (lat == null && strict) { tell(stop, target, 'hat keine gespeicherten Koordinaten'); throw new ProviderError(`Haltestelle "${stop.name}" ist ohne Koordinaten nicht sicher zu übersetzen`, { kind: 'unsupported' }); }
    if (lat == null) { try { const s = await efa.stop(stop.id); lat = s.lat; lon = s.lon; } catch { /* carry on without coordinates */ } }
    // The other side does not know names like "Freilassing (Obb), Freilassing": try several spellings in turn
    const full = String(stop.name || '').trim(), city = full.split(',')[0].replace(/\s*\(.*?\)/g, '').trim(), rest = full.split(',').slice(1).join(' ').trim();
    const variants = [...new Set([full.replace(/,\s*/g, ' '), full.replace(/\s*\(.*?\)/g, '').replace(/,\s*/g, ' ').trim(), rest && rest !== city ? `${city} ${rest}` : '', city].filter((v) => v.length >= 3))];
    // A candidate: within 600 m and, when strict, with a name that fits. r = 0 is the same name, 1 a name with a place added.
    const fit = (x) => {
      const d = distanceKm({ lat, lon }, x);
      if (d == null || d > 0.6) return null;
      const r = strict ? spotMatch(stop.name, x.name) : 0;
      return r < 0 ? null : { x, d, r };
    };
    let list = [];
    for (const q of variants) {
      // A source that does not answer says nothing about the stop: pass the error on instead of trying more spellings (and then claiming the stop does not exist)
      try { list = await target.searchStops(q); } catch (e) { if (sourceDown(e)) throw e; list = []; }
      if ((list || []).some((x) => fit(x))) break;
    }
    const near = (list || []).map(fit).filter(Boolean).sort((p, r) => p.r - r.r || p.d - r.d);
    const hit = near[0]?.x || (lat == null ? list?.[0] : null);
    if (!hit) {
      if (strict) {
        const close = (list || []).filter((x) => { const d = distanceKm({ lat, lon }, x); return d != null && d <= 0.6; }).slice(0, 3).map((x) => `„${x.name}“`);
        tell(stop, target, `ist keiner Haltestelle sicher zuzuordnen${close.length ? ` (in der Nähe: ${close.join(', ')})` : ''}`);
      }
      throw new ProviderError(`Haltestelle "${stop.name}" ist auf der anderen Seite der Grenze nicht auffindbar`, { kind: 'unsupported' });
    }
    return hit.id;
  }
  return function translate(stop, target) {
    const key = `${target.name}|${stop.id}`;
    if (cache.has(key)) return Promise.resolve(cache.get(key));
    const no = refused.get(key);
    if (no && now() < no.until) return Promise.reject(no.err);
    // Routes that start at the same moment share one search per stop
    if (!pending.has(key)) {
      pending.set(key, find(stop, target)
        .then((id) => { cache.set(key, id); return id; }, (e) => { if (strict && e?.kind === 'unsupported') refused.set(key, { until: now() + REFUSED_MS, err: e }); throw e; })
        .finally(() => pending.delete(key)));
    }
    return pending.get(key);
  };
}

/** Several associations as one for the translation: owns() is true for the stops of each of them, stop() asks the one a stop belongs to. */
const together = (list) => (list.length === 1 ? list[0] : {
  key: list.map((e) => e.key).join('+'),
  owns: (id) => list.some((e) => e.owns(id)),
  stop: (id) => list.find((e) => e.owns(id)).stop(id),
});

/**
 * The association first. If it does not answer (closed with HTTP 429, timeout, server error, refused), the railway sources step in so that the route
 * keeps showing trips: first ÖBB, then DB (only if ÖBB fails – an answer without trips is an answer, DB knows the same trains). Without trips from
 * the railway, the error of the association stays: it says which source is closed. An association that answers but does not know the route
 * is not replaced (other sources would only guess).
 */
export function withBackup(primary, backups, log = () => {}) {
  let down = false;      // for the log: one line when the backup starts, one when the association answers again
  return {
    name: primary.name,
    async journeys(args) {
      let err;
      try {
        const r = await primary.journeys(args);
        if (down) { down = false; log(`${primary.name}: antwortet wieder – die Strecken laufen wieder darüber`); }
        return r;
      } catch (e) { if (!sourceDown(e)) throw e; err = e; }
      for (const b of backups) {
        try {
          const r = await b.journeys(args);
          if (r?.length) { if (!down) { down = true; log(`${err.message} – ${b.name} übernimmt die Strecken`); } return r; }
          break;
        } catch { /* this one does not help, the next one may */ }
      }
      throw err;
    },
    stop: (id) => primary.stop(id),
  };
}

function mixedFor(target, efa, translate = createTranslator(efa)) {
  return {
    name: target.name,
    async journeys({ from, to, fromId, toId, ...rest }) {
      const f = efa.owns(fromId) ? await translate(from || { id: fromId }, target) : fromId;
      const t = efa.owns(toId) ? await translate(to || { id: toId }, target) : toId;
      return target.journeys({ ...rest, fromId: f, toId: t });
    },
    stop: (id) => (efa.owns(id) ? efa.stop(id) : target.stop(id)),
  };
}

export function build(db, oebb, mock, efas = [], { log = () => {}, now = () => Date.now() } = {}) {
  const efaOf = (stop) => efas.find((c) => c.owns(stop?.id));
  const mixedCache = new Map();
  /** strict: the stops are translated without guessing (see createTranslator), for the case that ReGo steps in for an association */
  const mixed = (target, efa, strict = false) => {
    const k = `${target.name}|${efa.key}${strict ? '|strict' : ''}`;
    if (!mixedCache.has(k)) mixedCache.set(k, mixedFor(target, efa, createTranslator(efa, { strict, now, log })));
    return mixedCache.get(k);
  };
  const backupCache = new Map();
  /** The association (or the mix of two) first; if it does not answer, ÖBB and DB with strictly translated stops. */
  const withRail = (primary, efa) => {
    const k = `${primary.name}|${efa.key}`;
    if (!backupCache.has(k)) backupCache.set(k, withBackup(primary, [mixed(oebb, efa, true), mixed(db, efa, true)], log));
    return backupCache.get(k);
  };
  return {
    db, oebb, mock, efas,
    /** Source for a single stop */
    forStop(stop) { return efaOf(stop) || (regionOf(stop) === 'AT' ? oebb : db); },
    // Connection: the association if both ends belong to it; one end in the association, the other elsewhere (cross-border): translate the stop;
    // otherwise: at least one end in Austria -> ÖBB (also knows German border towns), otherwise DB
    forTour(from, to) {
      const a = efaOf(from), b = efaOf(to);
      if (a && a === b) return a;
      if (a && b) {      // two associations (MVV + Bayern): ask the wider source (moby), translate the stop of the other
        const target = efas.find((e) => e.key === 'moby') || a;
        return mixed(target, target === a ? b : a);
      }
      if (a || b) {
        const other = a ? to : from;
        const target = regionOf(other) === 'AT' || regionOf(a ? from : to) === 'AT' ? oebb : db;
        return mixed(target, a || b);
      }
      return regionOf(from) === 'AT' || regionOf(to) === 'AT' ? oebb : db;
    },
    /**
     * Association first; for routes with an Austrian end ÖBB is tried as a fallback (e.g. if the association knows nothing there).
     * Routes between stops of associations (one or two): if the association does not answer, ÖBB and then DB step in (withBackup).
     */
    forTourSafe(from, to) {
      const c = this.forTour(from, to);
      const a = efaOf(from), b = efaOf(to);
      if (a && a === b && (regionOf(from) === 'AT' || regionOf(to) === 'AT')) return chain(a, mixed(oebb, a));
      if (a && b) return withRail(c, together([...new Set([a, b])].sort((p, q) => String(p.key).localeCompare(String(q.key)))));
      return c;
    },
    /** Search with special cases: Lindau Hbf is called "Lindau (Bodensee) Insel" or "Lindau Inselbahnhof" by the sources. */
    async searchStops(query) {
      const q = String(query || '').trim();
      const alias = /^lindau\b[\s(]*(bodensee\)?\s*)?[hb]\w*$/i.test(q) && q.length >= 8;
      const [main, extra] = await Promise.all([this.search(q), alias ? this.search('Lindau Insel').catch(() => []) : []]);
      const pinned = (extra || []).filter((x) => RENAME[x.id]);
      const seen = new Set(pinned.map((x) => x.id));
      const list = [...pinned, ...main.filter((x) => !seen.has(x.id))].map((x) => (RENAME[x.id] ? { ...x, name: RENAME[x.id] } : x));
      if (main.partial) list.partial = true;
      return list;
    },
    async search(query) {
      const q = String(query || '').trim();
      // Ask all sources at the same time; as soon as one answers, wait only a little longer for the others (the railway can hang)
      const sources = [...efas, db, oebb].filter((c) => c.healthy?.() !== false);        // do not ask blocked sources at all
      if (!sources.length) throw new ProviderError('Keine Quelle erreichbar', { kind: 'network' });
      const results = new Array(sources.length), errors = [], skipped = new Set();
      let done = 0, firstAt = 0;
      const isEfa = (c) => efas.includes(c);
      const efaCount = sources.filter(isEfa).length;
      await new Promise((resolve) => {
        const finish = () => { clearTimeout(timer); resolve(); };
        let timer, efaSettled = 0, efaReady;
        const efaDone = new Promise((r) => { efaReady = r; if (!efaCount) r(); });
        const good = () => results.some((r, i) => isEfa(sources[i]) && (r || []).some((x) => rankOf(x.name, q) <= 1));      // the association already knows the station exactly
        const ask = (c, i) => Promise.resolve().then(() => c.searchStops(q)).then((r) => { results[i] = r || []; if (r?.length && !firstAt) { firstAt = Date.now(); timer = setTimeout(finish, GRACE_MS); } },
          (e) => { errors.push(e); results[i] = []; log(e); }).finally(() => { if (isEfa(c) && ++efaSettled === efaCount) efaReady(); if (++done === sources.length) finish(); });
        sources.forEach((c, i) => {
          if (isEfa(c)) return ask(c, i);
          // Ask the railway sources sparingly (otherwise they block at every keystroke): only after the association, only from 4 characters and only if the association does not know an exact station
          Promise.race([efaDone, new Promise((r) => setTimeout(r, 900))]).then(() => {
            if (q.length < 4 || (efaSettled === efaCount && efaCount && good())) { results[i] = []; skipped.add(i); if (++done === sources.length) finish(); } else ask(c, i);
          });
        });
      });
      if (process.env.REGO_VERBOSE) console.log(`Suche "${q}": ` + sources.map((c, i) => `${c.key || c.name} ${skipped.has(i) ? 'übersprungen' : i in results && results[i] ? results[i].length + (results[i].length ? ' [' + results[i].slice(0, 3).map((x) => x.name).join(' | ') + ']' : '') : 'offen'}`).join(', ') + (errors.length ? ` (Fehler: ${errors.map((e) => e.message).join(' | ')})` : ''));
      const nE = sources.filter((c) => efas.includes(c)).length;
      const related = (a, b) => { const x = String(a.name || '').toLowerCase(), y = String(b.name || '').toLowerCase(); return x === y || x.includes(y) || y.includes(x); };
      const kept = [];
      results.slice(0, nE).forEach((r, si) => (r || []).forEach((s) => {
        if (s && !kept.some((k) => k.src !== si && (distanceKm(k.s, s) ?? 99) < 0.3 && related(k.s, s))) kept.push({ s, src: si });
      }));
      const efaStops = kept.map((k) => k.s);
      const others = results.slice(nE).flat().filter(Boolean)
        .filter((s) => !efaStops.some((e) => (distanceKm(e, s) ?? 99) < 0.3));      // same stop: prefer the association's entry
      const seen = new Set();
      const list = [...efaStops, ...others].filter((s) => !seen.has(s.id) && seen.add(s.id))
        .map((s, n) => ({ s, n })).sort((a, b) => rankOf(a.s.name, q) - rankOf(b.s.name, q) || a.n - b.n).map((x) => x.s);      // exact names and stations to the front, no matter which source
      if (!list.length && errors.length === sources.length) throw errors[0];
      if (done < sources.length || efas.some((c) => c.healthy?.() === false)) list.partial = true;      // not all sources were finished, or an association is on pause: do not cache
      return list;
    },
  };
}
