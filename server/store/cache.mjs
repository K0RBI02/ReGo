// Small in-memory cache with a lifetime. Concurrent requests for the same key share one query.
// - If a fetch fails: the last value (stale), but only up to maxStaleSec old.
// - After a failure the source is left alone for a short time (10, 20, 40, 60 s), so that an outage does not slow down every app request.
// - At most `max` entries; the oldest are dropped first.
export class TtlCache {
  constructor(now = () => Date.now(), { max = 1500, backoffSec = 10, backoffMaxSec = 60 } = {}) {
    this.now = now; this.map = new Map(); this.inflight = new Map(); this.fails = new Map();
    this.max = max; this.backoffSec = backoffSec; this.backoffMaxSec = backoffMaxSec;
  }

  peek(key) { return this.map.get(key) || null; }

  set(key, value) {
    const entry = { value, at: this.now() };
    this.map.delete(key); this.map.set(key, entry);           // move to the end of the order
    while (this.map.size > this.max) this.map.delete(this.map.keys().next().value);
    return entry;
  }

  /** Returns { value, at, stale }. If the loader fails: the last value (stale: true), if there is one and it is not too old. */
  async get(key, ttlSec, loader, { staleOnError = true, maxStaleSec = Infinity } = {}) {
    const t = this.now();
    const hit = this.map.get(key);
    if (hit && t - hit.at < ttlSec * 1000) return { value: hit.value, at: hit.at, stale: false };
    const usable = staleOnError && hit && (t - hit.at) / 1000 <= maxStaleSec ? hit : null;
    const f = this.fails.get(key);
    if (f && t - f.at < f.wait) {                              // the source has just failed: do not ask again right away
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
