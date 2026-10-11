// Fahrplanabfrage direkt im Backend über die Bibliotheken hafas-client (ÖBB) und db-vendo-client (DB).
// Kein geteilter Zwischenserver, nur Anfragen von Lab02 selbst. Gleiches Rohformat wie transport.rest,
// deshalb nutzen wir dieselben Umwandler wie in hafas.mjs.
import { normStop, normJourney, ProviderError } from './hafas.mjs';

async function load(spec, hint) {
  try { return await import(spec); }
  catch (e) { throw new ProviderError(`${hint} fehlt – bitte "npm install" ausführen (${e.message})`, { kind: 'setup' }); }
}

const withTimeout = (p, ms, name) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new ProviderError(`${name}: Zeitüberschreitung`, { kind: 'network' })), ms))]);

export class LibClient {
  /** createClient: async () => hafas-client-kompatibler Client (wird erst bei Bedarf geladen) */
  constructor(createClient, { name = 'lib', timeoutMs = 10000 } = {}) { this.make = createClient; this.name = name; this.timeoutMs = timeoutMs; this.client = null; }

  async c() { return (this.client ||= await this.make()); }
  async call(fn) {
    const c = await this.c();
    try { return await withTimeout(fn(c), this.timeoutMs, this.name); }
    catch (e) { throw e instanceof ProviderError ? e : new ProviderError(`${this.name}: ${e.message}`, { kind: 'network', status: e.statusCode || 0 }); }
  }

  async searchStops(query) {
    const r = await this.call((c) => c.locations(query, { results: 8, stops: true, addresses: false, poi: false, language: 'de' }));
    return (r || []).filter((x) => x.type === 'stop' || x.type === 'station').map(normStop);
  }

  /** Linien einer Haltestelle – nicht jede Quelle kann das (db-vendo-client nicht). Dann: leere Liste, Karte ohne Anschlüsse. */
  async stop(id) {
    const c = await this.c();
    if (typeof c.stop !== 'function') return { id, name: '', lines: [] };
    const s = await this.call((cl) => cl.stop(id, { linesOfStops: true, language: 'de' }));
    const out = normStop(s);
    out.lines = (s.lines || []).filter((l) => l?.name).map((l) => ({ name: l.name, product: l.product || '' }));
    return out;
  }

  async journeys({ fromId, toId, when, results = 5, transfers = 0 }) {
    const r = await this.call((c) => c.journeys(fromId, toId, { departure: new Date(when), results, transfers, stopovers: true, remarks: true, language: 'de' }));
    return (r.journeys || []).map(normJourney).filter((j) => j.legs.some((l) => l.line));
  }
}

export const createDbClient = (userAgent) => new LibClient(async () => {
  const { createClient } = await load('db-vendo-client', 'Paket db-vendo-client');
  const { profile } = await load('db-vendo-client/p/db/index.js', 'DB-Profil');
  return createClient(profile, userAgent);
}, { name: 'db' });

export const createOebbClient = (userAgent) => new LibClient(async () => {
  const { createClient } = await load('hafas-client', 'Paket hafas-client');
  const { profile } = await load('hafas-client/p/oebb/index.js', 'ÖBB-Profil');
  return createClient(profile, userAgent);
}, { name: 'oebb' });
