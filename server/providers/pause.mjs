// Pause for a source that tells us to slow down (HTTP 429 "too many requests").
// While the pause runs no request goes out at all. When it is over, exactly one request tests whether the source answers again;
// the others keep waiting for its result. The pause follows the Retry-After header, however long it is (at most a day: a source that
// asks for 24 hours means it, and asking every half hour anyway is how a closed door becomes a locked one). Without a statement the
// pause grows with every hit in a row (1, 2, 4 … minutes, at most 30), so a source that stays closed is asked only a few times per hour.
export class SourcePause {
  constructor({ now = () => Date.now(), baseSec = 60, maxSec = 1800, maxAskedSec = 86400 } = {}) {
    this.now = now; this.baseSec = baseSec; this.maxSec = maxSec; this.maxAskedSec = maxAskedSec;
    this.hits = 0; this.until = 0; this.testUntil = 0;
  }

  /** May a request go out now? When the pause is over, the first caller gets the test request. */
  allow() {
    const t = this.now();
    if (t < this.until) return false;
    if (!this.hits) return true;
    if (t < this.testUntil) return false;          // the test request is on its way
    this.testUntil = t + 15e3;                     // (if it never reports back, another one may follow after 15 s)
    return true;
  }

  /** Is the source paused right now? For the status page and the station search; does not start a test request. */
  active() {
    const t = this.now();
    return t < this.until || (this.hits > 0 && t < this.testUntil);
  }

  /** Seconds until the pause is over (0: not paused). */
  left() { return Math.max(0, Math.ceil((this.until - this.now()) / 1000)); }

  /** The source said "too many requests". Several answers of the same round count once. Returns { sec, fresh }. */
  limited(retryAfterSec) {
    const t = this.now();
    if (t < this.until) return { sec: this.left(), fresh: false };
    this.hits++;
    const said = Number.isFinite(retryAfterSec) && retryAfterSec > 0;
    const sec = said ? Math.min(this.maxAskedSec, Math.max(10, retryAfterSec)) : Math.min(this.maxSec, this.baseSec * 2 ** Math.min(this.hits - 1, 16));
    this.until = t + sec * 1000; this.testUntil = 0;
    return { sec, fresh: true };
  }

  /** The source answered normally. */
  ok() { this.hits = 0; this.until = 0; this.testUntil = 0; }
}

/** Retry-After of an answer: seconds or an HTTP date; NaN if there is none. */
export function retryAfterSec(res, now = Date.now()) {
  const h = res?.headers?.get?.('retry-after');
  if (h == null || h === '') return NaN;
  const n = Number(h);
  if (Number.isFinite(n)) return n;
  const d = Date.parse(h);
  return Number.isNaN(d) ? NaN : Math.max(0, Math.round((d - now) / 1000));
}

/** "45 s" / "5 Min." / "24 Std." for log lines and error texts */
export const fmtPause = (sec) => (sec < 90 ? `${sec} s` : sec < 7200 ? `${Math.round(sec / 60)} Min.` : `${Math.round(sec / 3600)} Std.`);
