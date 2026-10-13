// Kleiner Speicher-Cache mit Laufzeit. Gleichzeitige Anfragen auf denselben Schlüssel teilen sich eine Abfrage.
// - Bei Fehler im Abruf: letzter Wert (stale), aber nur bis maxStaleSec alt.
// - Nach einem Fehler wird die Quelle kurz in Ruhe gelassen (10, 20, 40, 60 s), damit eine Störung nicht jede App-Abfrage ausbremst.
// - Höchstens `max` Einträge; die ältesten fliegen zuerst raus.
export class TtlCache {
  constructor(now = () => Date.now(), { max = 1500, backoffSec = 10, backoffMaxSec = 60 } = {}) {
    this.now = now; this.map = new Map(); this.inflight = new Map(); this.fails = new Map();
    this.max = max; this.backoffSec = backoffSec; this.backoffMaxSec = backoffMaxSec;
  }

  peek(key) { return this.map.get(key) || null; }

  set(key, value) {
    const entry = { value, at: this.now() };
    this.map.delete(key); this.map.set(key, entry);           // ans Ende der Reihenfolge
    while (this.map.size > this.max) this.map.delete(this.map.keys().next().value);
    return entry;
  }

  /** Gibt { value, at, stale } zurück. Bei Fehler im Loader: letzter Wert (stale: true), falls vorhanden und nicht zu alt. */
  async get(key, ttlSec, loader, { staleOnError = true, maxStaleSec = Infinity } = {}) {
    const t = this.now();
    const hit = this.map.get(key);
    if (hit && t - hit.at < ttlSec * 1000) return { value: hit.value, at: hit.at, stale: false };
    const usable = staleOnError && hit && (t - hit.at) / 1000 <= maxStaleSec ? hit : null;
    const f = this.fails.get(key);
    if (f && t - f.at < f.wait) {                              // Quelle hat gerade erst versagt: nicht gleich wieder fragen
      if (usable) return { value: usable.value, at: usable.at, stale: true, error: f.err };
      throw f.err;
    }
    if (this.inflight.has(key)) return this.inflight.get(key);
    const p = (async () => {
      try {
        const value = await loader();
        const entry = this.set(key, value);
        this.fails.delete(key);
        return { value, at: entry.at, stale: false };
      } catch (err) {
        const n = (this.fails.get(key)?.n || 0) + 1;
        this.fails.set(key, { at: this.now(), n, err, wait: Math.min(this.backoffMaxSec, this.backoffSec * 2 ** (n - 1)) * 1000 });
        if (this.fails.size > this.max) this.fails.delete(this.fails.keys().next().value);
        if (usable) return { value: usable.value, at: usable.at, stale: true, error: err };
        throw err;
      } finally { this.inflight.delete(key); }
    })();
    this.inflight.set(key, p);
    return p;
  }

  clear() { this.map.clear(); this.fails.clear(); }
}
