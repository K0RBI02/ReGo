// Protection for a server that is reachable from the internet (Tailscale Funnel):
//  - limit on requests per address and per device (otherwise a few scripts could exhaust the timetable sources or get them blocked)
//  - cap on new devices per address (otherwise someone fills the profile list with made-up device IDs)
//  - optional invitation code: new devices need it, devices that are already known keep working without any action
// Everything is kept in memory; after a restart the counters start from scratch.
import { createHash, timingSafeEqual } from 'node:crypto';
import { ValidationError } from './store/profile.mjs';

const PRIVATE_V4 = [/^127\./, /^10\./, /^192\.168\./, /^172\.(1[6-9]|2\d|3[01])\./, /^169\.254\./, /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./];

/** Local, private and Tailscale addresses (100.64.0.0/10): a connection from one of them comes from a proxy whose X-Forwarded-For we believe. */
export function isPrivateIp(ip = '') {
  const a = String(ip).trim().toLowerCase().replace(/^::ffff:/, '');
  if (a === '::1') return true;
  if (/^f[cd][0-9a-f]{2}:/.test(a) || /^fe80:/.test(a)) return true;
  return PRIVATE_V4.some((r) => r.test(a));
}

/** Address of the caller. If the connection comes from a local/private address (Tailscale, proxy), the last non-private address from X-Forwarded-For counts. */
export function clientIp(req) {
  const peer = String(req.socket?.remoteAddress || '').replace(/^::ffff:/, '');
  const xff = String(req.headers?.['x-forwarded-for'] || '').split(',').map((x) => x.trim().slice(0, 64)).filter(Boolean).slice(-8);
  if (!xff.length || !isPrivateIp(peer)) return peer || 'unbekannt';
  for (let i = xff.length - 1; i >= 0; i--) if (!isPrivateIp(xff[i])) return xff[i];
  return xff[0];
}

/** Token buckets: `burst` at once, then `perSec` per second. At most `max` keys; the longest unused ones are dropped first. */
export class Buckets {
  constructor({ burst, perSec, max = 5000 }, now = () => Date.now()) { this.burst = burst; this.perSec = perSec; this.max = max; this.now = now; this.map = new Map(); }

  level(key) {
    const b = this.map.get(key);
    if (!b) return this.burst;
    return Math.min(this.burst, b.tokens + ((this.now() - b.at) / 1000) * this.perSec);
  }

  /** 0 = let through, otherwise the wait time in seconds */
  take(key, cost = 1) {
    const t = this.now();
    const tokens = this.level(key);
    this.map.delete(key);
    const ok = tokens >= cost;
    this.map.set(key, { tokens: ok ? tokens - cost : tokens, at: t });
    if (this.map.size > this.max) this.map.delete(this.map.keys().next().value);
    return ok ? 0 : Math.max(1, Math.ceil((cost - tokens) / this.perSec));
  }
}

const same = (a, b) => timingSafeEqual(createHash('sha256').update(a).digest(), createHash('sha256').update(b).digest());
const norm = (s) => String(s ?? '').normalize('NFC').trim().toLowerCase();
const tooMany = (wait, msg = 'Zu viele Anfragen. Bitte kurz warten.') => Object.assign(new ValidationError(msg, 429), { retryAfter: wait });
// The code travels as a header (ASCII only): the app sends it URL-encoded
const readCode = (h) => { try { return norm(decodeURIComponent(String(h ?? ''))); } catch { return norm(h); } };

export function createGuard({ cfg, store, now = () => Date.now() }) {
  const lim = { ipBurst: 200, ipPerSec: 3, deviceBurst: 60, devicePerSec: 1, searchBurst: 20, searchPerSec: 0.5, inviteTries: 10, newDevicesPerHour: 10, ...(cfg.limits || {}) };
  const byIp = new Buckets({ burst: lim.ipBurst, perSec: lim.ipPerSec }, now);
  const byDevice = new Buckets({ burst: lim.deviceBurst, perSec: lim.devicePerSec }, now);
  const bySearch = new Buckets({ burst: lim.searchBurst, perSec: lim.searchPerSec }, now);
  const wrongCodes = new Buckets({ burst: lim.inviteTries, perSec: 1 / 60 }, now);        // ten failed attempts, then one per minute
  const fresh = new Map();                                                                  // address -> { device ID -> time }
  const code = norm(cfg.inviteCode);

  function newDevice(ip, dev) {
    const t = now();
    const m = fresh.get(ip) || new Map();
    fresh.delete(ip); fresh.set(ip, m);
    if (fresh.size > 5000) fresh.delete(fresh.keys().next().value);
    for (const [d, ts] of m) if (t - ts > 3600e3) m.delete(d);
    if (m.has(dev)) return;                                                                 // the same device counts only once
    if (m.size >= lim.newDevicesPerHour) throw tooMany(Math.ceil((Math.min(...m.values()) + 3600e3 - t) / 1000), 'Zu viele neue Geräte von dieser Adresse. Bitte später noch einmal versuchen.');
    m.set(dev, t);
  }

  return {
    /** First barrier for every request: limit per address. The add-on's watchdog check and preflight requests (CORS) stay free. */
    rate(req, url) {
      if (req.method === 'OPTIONS' || url.pathname === '/api/health') return;
      const wait = byIp.take(clientIp(req));
      if (wait) throw tooMany(wait);
    },

    /** Second barrier for requests with a device ID: limit per device; unknown devices need the invitation code (if set) and are limited per address. */
    async device(req, url, dev) {
      let wait = byDevice.take(dev);
      if (!wait && (url.pathname === '/api/stations' || url.pathname === '/api/connections/search')) wait = bySearch.take(dev);
      if (wait) throw tooMany(wait);
      if (await store.has(dev)) return;                                                     // known device: no code needed, not even after the invitation was switched on
      const ip = clientIp(req);
      if (code) {
        const given = readCode(req.headers['x-invite']);
        const invite = (wrong) => Object.assign(new ValidationError(wrong ? 'Der Einladungscode stimmt nicht.' : 'Für dieses Gerät ist ein Einladungscode nötig.', 403), { extra: { invite: true, wrong } });
        if (!given) throw invite(false);
        const lv = wrongCodes.level(ip);
        if (lv < 1) throw tooMany(Math.ceil((1 - lv) * 60), 'Zu viele falsche Codes. Bitte eine Minute warten.');
        if (!same(given, code)) { wrongCodes.take(ip); throw invite(true); }
      }
      newDevice(ip, dev);
    },
  };
}
