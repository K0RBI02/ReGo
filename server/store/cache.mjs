// Kleiner Speicher-Cache mit Laufzeit. Gleichzeitige Anfragen auf denselben Schlüssel teilen sich eine Abfrage.
export class TtlCache {
  constructor(now = () => Date.now()) { this.now = now; this.map = new Map(); this.inflight = new Map(); }

  peek(key) { return this.map.get(key) || null; }

  /** Gibt { value, at, stale } zurück. Bei Fehler im Loader: letzter Wert (stale: true), falls vorhanden. */
  async get(key, ttlSec, loader, { staleOnError = true } = {}) {
    const hit = this.map.get(key);
    if (hit && this.now() - hit.at < ttlSec * 1000) return { value: hit.value, at: hit.at, stale: false };
    if (this.inflight.has(key)) return this.inflight.get(key);
    const p = (async () => {
      try {
        const value = await loader();
        const entry = { value, at: this.now() };
        this.map.set(key, entry);
        return { value, at: entry.at, stale: false };
      } catch (err) {
        if (staleOnError && hit) return { value: hit.value, at: hit.at, stale: true, error: err };
        throw err;
      } finally { this.inflight.delete(key); }
    })();
    this.inflight.set(key, p);
    return p;
  }

  clear() { this.map.clear(); }
}
