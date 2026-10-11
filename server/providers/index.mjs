import { HafasClient, ProviderError } from './hafas.mjs';
import { mockFetch } from './mock.mjs';
import { createDbClient, createOebbClient } from './lib.mjs';
import { EfaClient } from './efa.mjs';
import { regionOf, distanceKm } from '../lib/geo.mjs';

/** Liefert { db, oebb, pick(stopId) } – Österreich über ÖBB, sonst DB (die DB-API deckt Grenzverkehr ab). */
export function createProviders(config, now = () => Date.now()) {
  const common = { userAgent: config.upstream.userAgent, timeoutMs: config.upstream.timeoutMs, retries: config.upstream.retries };
  const mock = config.provider === 'mock';
  const efas = mock ? [] : (config.upstream.efa || []).map((e) => new EfaClient(e.url, { ...common, key: e.key }));
  if (config.provider === 'library') {
    // Bibliothek zuerst; blockiert die Quelle (z. B. OPS_BLOCKED) oder fehlt sie, springt ReGo auf transport.rest.
    const quick = { ...common, timeoutMs: Math.min(common.timeoutMs, 4000), retries: 0 };     // Ausweichquelle: kurz probieren, nicht lange warten
    const restDb = new HafasClient(config.upstream.db, { ...quick, name: 'db' });
    const restOebb = new HafasClient(config.upstream.oebb, { ...quick, name: 'oebb' });
    const db = withFallback(createDbClient(config.upstream.userAgent), restDb, config);
    const oebb = withFallback(createOebbClient(config.upstream.userAgent), restOebb, config);
    return build(db, oebb, false, efas);
  }
  const db = new HafasClient(config.upstream.db, { ...common, name: 'db', ...(mock ? { fetchImpl: mockFetch({ now }), retries: 0 } : {}) });
  const oebb = new HafasClient(config.upstream.oebb, { ...common, name: 'oebb', ...(mock ? { fetchImpl: mockFetch({ now }), retries: 0 } : {}) });
  return build(db, oebb, mock, efas);
}

export function withFallback(primary, fallback, config) {
  const log = (...a) => config.verbose && console.log(...a);
  let primaryDown = 0, fallbackDown = 0;   // nach einem Fehler die Quelle eine Weile in Ruhe lassen (Bahn blockt sonst noch mehr, Nutzer warten umsonst)
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

const unsupported =(msg) => ({ name: 'efa', async journeys() { throw new ProviderError(msg, { kind: 'unsupported' }); }, async stop(id) { return { id, name: '', lines: [] }; } });

/** Haltestelle eines Verbunds beim anderen Anbieter wiederfinden (Name + Koordinaten). */
export function createTranslator(efa) {
  const cache = new Map();
  return async function translate(stop, target) {
    const key = `${target.name}|${stop.id}`;
    if (cache.has(key)) return cache.get(key);
    let { lat, lon } = stop;
    if (lat == null) { try { const s = await efa.stop(stop.id); lat = s.lat; lon = s.lon; } catch { /* ohne Koordinaten weiter */ } }
    const q = String(stop.name || '').replace(/,\s*/g, ' ').trim();
    const list = await target.searchStops(q);
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
    /** Quelle für eine einzelne Haltestelle */
    forStop(stop) { return efaOf(stop) || (regionOf(stop) === 'AT' ? oebb : db); },
    // Verbindung: Verbund, wenn beide Enden dazu gehören; ein Ende im Verbund, das andere anderswo (Grenzverkehr): Haltestelle übersetzen;
    // sonst: mindestens ein Ende in Österreich -> ÖBB (kennt auch deutsche Grenzorte), sonst DB
    forTour(from, to) {
      const a = efaOf(from), b = efaOf(to);
      if (a && a === b) return a;
      if (a || b) {
        if (a && b) return unsupported('Verbindung zwischen verschiedenen Verkehrsverbünden wird noch nicht unterstützt');
        const other = a ? to : from;
        const target = regionOf(other) === 'AT' || regionOf(a ? from : to) === 'AT' ? oebb : db;
        return mixed(target, a || b);
      }
      return regionOf(from) === 'AT' || regionOf(to) === 'AT' ? oebb : db;
    },
    async searchStops(q) {
      // Alle Quellen gleichzeitig fragen; sobald eine antwortet, höchstens noch kurz auf die anderen warten (die Bahn kann hängen)
      const sources = [...efas, db, oebb].filter((c) => c.healthy?.() !== false);        // gesperrte Quellen gar nicht erst fragen
      if (!sources.length) throw new ProviderError('Keine Quelle erreichbar', { kind: 'network' });
      const results = new Array(sources.length), errors = [];
      let done = 0, firstAt = 0;
      await new Promise((resolve) => {
        const finish = () => { clearTimeout(timer); resolve(); };
        let timer;
        sources.forEach((c, i) => {
          // Nach dem ersten Treffer noch kurz auf die übrigen warten: der Verbund ist schnell, ÖBB braucht meist 1–2 s (sonst fehlen österreichische Halte)
          Promise.resolve().then(() => c.searchStops(q)).then((r) => { results[i] = r || []; if (r?.length && !firstAt) { firstAt = Date.now(); timer = setTimeout(finish, GRACE_MS); } },
            (e) => { errors.push(e); results[i] = []; log(e); }).finally(() => { if (++done === sources.length) finish(); });
        });
      });
      if (process.env.REGO_VERBOSE) console.log(`Suche "${q}": ` + sources.map((c, i) => `${c.key || c.name} ${i in results && results[i] ? results[i].length : 'offen'}`).join(', ') + (errors.length ? ` (Fehler: ${errors.map((e) => e.message).join(' | ')})` : ''));
      const nE = sources.filter((c) => efas.includes(c)).length;
      const efaStops = results.slice(0, nE).flat().filter(Boolean);
      const others = results.slice(nE).flat().filter(Boolean)
        .filter((s) => !efaStops.some((e) => (distanceKm(e, s) ?? 99) < 0.3));      // dieselbe Haltestelle: Verbund-Eintrag bevorzugen
      const seen = new Set();
      const list = [...efaStops, ...others].filter((s) => !seen.has(s.id) && seen.add(s.id));
      if (!list.length && errors.length === sources.length) throw errors[0];
      if (done < sources.length) list.partial = true;      // nicht alle Quellen waren fertig: nicht zwischenspeichern
      return list;
    },
  };
}
