import { HafasClient, ProviderError } from './hafas.mjs';
import { mockFetch } from './mock.mjs';
import { createOebbClient } from './lib.mjs';
import { EfaClient, rankOf } from './efa.mjs';
import { regionOf, distanceKm } from '../lib/geo.mjs';

/** Provides { db, oebb, pick(stopId) } – Austria through ÖBB, otherwise DB (the DB API covers cross-border traffic). */
export function createProviders(config, now = () => Date.now()) {
  const common = { userAgent: config.upstream.userAgent, timeoutMs: config.upstream.timeoutMs, retries: config.upstream.retries };
  const mock = config.provider === 'mock';
  const efas = mock ? [] : (config.upstream.efa || []).map((e) => new EfaClient(e.url, { ...common, key: e.key }));
  if (config.provider === 'library') {
    // Library first; if the source blocks it (e.g. OPS_BLOCKED) or it is missing, ReGo falls back to transport.rest.
    const quick = { ...common, timeoutMs: Math.min(common.timeoutMs, 4000), retries: 0 };     // fallback source: try briefly, do not wait long
    const restDb = new HafasClient(config.upstream.db, { ...quick, name: 'db' });
    const restOebb = new HafasClient(config.upstream.oebb, { ...quick, name: 'oebb' });
    const db = restDb;      // DB blocks the library (OPS_BLOCKED), therefore only transport.rest now
    const oebb = withFallback(createOebbClient(config.upstream.userAgent), restOebb, config);
    return build(db, oebb, false, efas);
  }
  const db = new HafasClient(config.upstream.db, { ...common, name: 'db', ...(mock ? { fetchImpl: mockFetch({ now }), retries: 0 } : {}) });
  const oebb = new HafasClient(config.upstream.oebb, { ...common, name: 'oebb', ...(mock ? { fetchImpl: mockFetch({ now }), retries: 0 } : {}) });
  return build(db, oebb, mock, efas);
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

/** Find the stop of one association again at the other provider (name + coordinates). */
const v0err = (e) => e?.kind === 'network' && /derzeit nicht erreichbar/.test(e.message || '');
export function createTranslator(efa) {
  const cache = new Map();
  return async function translate(stop, target) {
    const key = `${target.name}|${stop.id}`;
    if (cache.has(key)) return cache.get(key);
    let { lat, lon } = stop;
    if (lat == null) { try { const s = await efa.stop(stop.id); lat = s.lat; lon = s.lon; } catch { /* carry on without coordinates */ } }
    // The other side does not know names like "Freilassing (Obb), Freilassing": try several spellings in turn
    const full = String(stop.name || '').trim(), city = full.split(',')[0].replace(/\s*\(.*?\)/g, '').trim(), rest = full.split(',').slice(1).join(' ').trim();
    const variants = [...new Set([full.replace(/,\s*/g, ' '), full.replace(/\s*\(.*?\)/g, '').replace(/,\s*/g, ' ').trim(), rest && rest !== city ? `${city} ${rest}` : '', city].filter((v) => v.length >= 3))];
    let list = [];
    for (const q of variants) {
      try { list = await target.searchStops(q); } catch (e) { if (v0err(e)) throw e; list = []; }
      if ((list || []).some((x) => { const d = distanceKm({ lat, lon }, x); return d != null && d <= 0.6; })) break;
    }
    const near = (list || []).map((x) => ({ x, d: distanceKm({ lat, lon }, x) })).filter((c) => c.d != null && c.d <= 0.6).sort((p, r) => p.d - r.d);
    const hit = near[0]?.x || (lat == null ? list?.[0] : null);
    if (!hit) throw new ProviderError(`Haltestelle "${stop.name}" ist auf der anderen Seite der Grenze nicht auffindbar`, { kind: 'unsupported' });
    cache.set(key, hit.id);
    return hit.id;
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

export function build(db, oebb, mock, efas = []) {
  const efaOf = (stop) => efas.find((c) => c.owns(stop?.id));
  const mixedCache = new Map();
  const mixed = (target, efa) => { const k = `${target.name}|${efa.key}`; if (!mixedCache.has(k)) mixedCache.set(k, mixedFor(target, efa)); return mixedCache.get(k); };
  const log = () => {};
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
    /** Association first; for routes with an Austrian end ÖBB is tried as a fallback (e.g. if the association knows nothing there). */
    forTourSafe(from, to) {
      const c = this.forTour(from, to);
      const a = efaOf(from), b = efaOf(to);
      if (a && a === b && (regionOf(from) === 'AT' || regionOf(to) === 'AT')) return chain(a, mixed(oebb, a));
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
      if (done < sources.length) list.partial = true;      // not all sources were finished: do not cache
      return list;
    },
  };
}
