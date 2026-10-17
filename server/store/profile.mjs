// Profile per device as a JSON file. No accounts, no tickets, only routes and settings.
import { mkdir, readFile, writeFile, rename, unlink, stat, readdir } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { untilMin, fmtMin } from '../domain/window.mjs';
import { toMin } from '../lib/time.mjs';

export const DEVICE_RE = /^[A-Za-z0-9_-]{16,64}$/;
export class ValidationError extends Error { constructor(m, status = 400) { super(m); this.status = status; } }

export const defaultProfile = () => ({ tours: [], settings: { pushThresholdMin: 5, delayGraceMin: 10 }, push: null, updatedAt: 0, lastSeen: 0 });
const rid = () => randomBytes(4).toString('hex');
const DAYS = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'];
const WEEKDAYS = DAYS.slice(0, 5);
const HM = /^([01]\d|2[0-3]):[0-5]\d$/;
const LINK_ID = /^[\w-]{1,32}$/;
const MAX_TOURS = 20;
const SEEN_EVERY = 2 * 3600e3;          // store "last seen" at most every 2 hours

// Stop from the stop search: ID (at most 64 characters, no control characters) and name
const isStop = (s) => !!s && typeof s.id === 'string' && /^[^\u0000-\u001f]{1,64}$/.test(s.id) && typeof s.name === 'string' && s.name.trim().length > 0 && s.name.length <= 120;
const validCoord = (lat, lon) => Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180;
const pt = (s) => ({ id: s.id, name: s.name.trim(), ...(validCoord(s.lat, s.lon) ? { lat: s.lat, lon: s.lon } : {}) });
/** Stop from a request in the stored form (ID, name, coordinates if sensible) */
export const toStop = pt;

// "Nur rund um die Abfahrt" (only around the departure) no longer exists: push always follows the commute time of the route
const withoutLegacy = ({ pushWindow, ...rest }) => rest;

export class ProfileStore {
  constructor(dir, now = () => Date.now(), { maxProfiles = 2000 } = {}) {
    this.dir = join(dir, 'profiles'); this.now = now; this.locks = new Map(); this.maxProfiles = maxProfiles;
    this.known = null; this.seenAt = new Map(); this.appAt = new Map();
  }

  file(device) {
    if (!DEVICE_RE.test(device || '')) throw new ValidationError('Ungültige Geräte-ID');
    return join(this.dir, `${device}.json`);
  }

  async load(device) {
    const f = this.file(device);
    let raw;
    try { raw = await readFile(f, 'utf8'); }
    catch (e) { if (e.code === 'ENOENT') return { ...defaultProfile(), lastSeen: this.now() }; throw e; }
    let data;
    try {
      data = JSON.parse(raw);
      if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('kein JSON-Objekt');
    } catch (e) {
      // Damaged file: set it aside so that the device does not hang permanently with error 500 and nothing gets overwritten
      const bad = `${f}.corrupt-${this.now()}`;
      try { await rename(f, bad); } catch { /* already gone */ }
      console.error(`Profil ${device.slice(0, 6)}… war beschädigt und liegt jetzt als ${bad.split(/[\\/]/).pop()} daneben: ${e.message}`);
      return { ...defaultProfile(), lastSeen: this.now() };
    }
    const def = defaultProfile();
    return {
      ...def, ...data,
      tours: Array.isArray(data.tours) ? data.tours : [],
      settings: withoutLegacy({ ...def.settings, ...(data.settings && typeof data.settings === 'object' && !Array.isArray(data.settings) ? data.settings : {}) }),
      lastSeen: Number(data.lastSeen) || Number(data.updatedAt) || 0,
    };
  }

  async loadKnown() {
    if (!this.known) {
      try { this.known = new Set((await readdir(this.dir)).filter((x) => x.endsWith('.json')).map((x) => x.slice(0, -5))); }
      catch { this.known = new Set(); }
    }
    return this.known;
  }

  /** Is there already a profile for this device? (New devices may need the invitation code.) */
  async has(device) { return (await this.loadKnown()).has(device); }

  /** Upper limit for the number of profiles (protection against someone filling the storage with made-up device IDs). */
  async admit(device) {
    await this.loadKnown();
    if (this.known.has(device)) return;
    if (this.known.size >= this.maxProfiles) throw new ValidationError('Der Server ist gerade voll. Bitte später noch einmal versuchen.', 503);
    this.known.add(device);
  }

  async save(device, profile) {
    await mkdir(this.dir, { recursive: true });
    const f = this.file(device), tmp = `${f}.${rid()}.tmp`;
    await this.admit(device);
    profile.updatedAt = this.now();
    await writeFile(tmp, JSON.stringify(profile, null, 2));
    await rename(tmp, f);
    return profile;
  }

  /** Run changes per device one after another (no loss with concurrent requests). */
  async update(device, fn) {
    const prev = this.locks.get(device) || Promise.resolve();
    const run = prev.catch(() => {}).then(async () => { const p = await this.load(device); const r = await fn(p); await this.save(device, p); return r ?? p; });
    this.locks.set(device, run);
    try { return await run; } finally { if (this.locks.get(device) === run) this.locks.delete(device); }
  }

  /** Note "last seen" when the device reports in (app opened, notifications fetched). Does not create a profile. */
  async seen(device) {
    const t = this.now();
    if (t - (this.seenAt.get(device) || 0) < SEEN_EVERY) return;
    this.seenAt.set(device, t);
    if (this.seenAt.size > 5000) this.seenAt.delete(this.seenAt.keys().next().value);
    try { await stat(this.file(device)); } catch { return; }
    await this.update(device, (p) => { p.lastSeen = t; return p; });
  }

  /**
   * Remember which app version a device runs (it tells with every state request), so the status page can count versions during a test phase.
   * Does not create a profile; writes only when the version changed (at most one extra read per device and server run).
   */
  async noteApp(device, app) {
    if (!app || this.appAt.get(device) === app) return;
    try { await stat(this.file(device)); } catch { return; }         // no profile yet: try again with the next request
    this.appAt.set(device, app);
    if (this.appAt.size > 5000) this.appAt.delete(this.appAt.keys().next().value);
    if ((await this.load(device)).app !== app) await this.update(device, (p) => { p.app = app; return p; });
  }

  /** Delete profiles that have not been seen for `days` days (and leftovers: half-written files, files set aside). Returns the number of deleted profiles. */
  async purge(days) {
    if (!(days > 0)) return 0;
    let n = 0, files = [];
    try { files = await readdir(this.dir); } catch { return 0; }
    const t = this.now();
    for (const f of files) {
      const full = join(this.dir, f);
      try {
        if (f.endsWith('.tmp')) { if (t - (await stat(full)).mtimeMs > 3600e3) await unlink(full); continue; }
        if (/\.corrupt-\d+$/.test(f)) { if (t - (await stat(full)).mtimeMs > 30 * 864e5) await unlink(full); continue; }
        if (!f.endsWith('.json')) continue;
        let seen = (await stat(full)).mtimeMs;                                  // older profiles without a note: by file time
        try { const p = JSON.parse(await readFile(full, 'utf8')); if (Number(p?.lastSeen) > 0) seen = Number(p.lastSeen); } catch { /* damaged: use the file time */ }
        if (t - seen > days * 864e5) { await unlink(full); this.known?.delete(f.slice(0, -5)); n++; }
      } catch { /* already gone */ }
    }
    return n;
  }

  async remove(device) {
    try { await unlink(this.file(device)); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    this.known?.delete(device);
  }
}

/**
 * Commute time of a route: days and the window in which one departs (departAfter to departUntil).
 * If the end is missing (older routes, older app), the window lasts one hour.
 */
function schedule(input = {}) {
  const set = new Set(Array.isArray(input.days) ? input.days.filter((d) => DAYS.includes(d)) : []);
  const days = DAYS.filter((d) => set.has(d));                                  // without duplicates, in weekday order
  const departAfter = HM.test(input.departAfter || '') ? input.departAfter : '07:00';
  return { days: days.length ? days : [...WEEKDAYS], departAfter, departUntil: fmtMin(untilMin(toMin(departAfter), input.departUntil)) };
}
const sameSchedule = (a = {}, b = {}) => { const x = schedule(a), y = schedule(b); return x.departAfter === y.departAfter && x.departUntil === y.departUntil && x.days.join() === y.days.join(); };

/**
 * New route. body: { from:{id,name}, to:{id,name}, schedule?: { days, departAfter, departUntil }, roundTrip?: boolean, returnAfter?: 'HH:MM', returnUntil?: 'HH:MM', transfers?: 1 }
 * transfers: 1 = trips with one transfer (only after the user's explicit choice, when there is no direct connection); applies to outward and return trip.
 * Returns the created tours (1 or 2). If this exact route with the same days and times already exists
 * (e.g. tapped twice), nothing is created and the existing one is returned. An existing route without a transfer
 * (from an older version, without a direct connection) is switched to transfer when the user now creates it with a transfer.
 */
export function addTours(profile, body) {
  if (!isStop(body?.from) || !isStop(body?.to)) throw new ValidationError('Start und Ziel müssen Haltestellen sein');
  if (body.from.id === body.to.id) throw new ValidationError('Start und Ziel sind gleich');
  if (body.transfers !== undefined && body.transfers !== 0 && body.transfers !== 1) throw new ValidationError('transfers muss 1 sein (oder fehlen)');
  const from = pt(body.from), to = pt(body.to);
  const out = schedule(body.schedule);
  const dup = profile.tours.find((x) => x.from?.id === from.id && x.to?.id === to.id && sameSchedule(x.schedule, out));
  if (dup) {
    const back = dup.returnId && profile.tours.find((x) => x.id === dup.returnId);
    if (body.transfers === 1) for (const x of [dup, back]) if (x && x.transfers !== 1) x.transfers = 1;
    return back ? [dup, back] : [dup];
  }
  if (profile.tours.length + (body.roundTrip ? 2 : 1) > MAX_TOURS) throw new ValidationError(`Maximal ${MAX_TOURS} Strecken`);
  const xfer = body.transfers === 1 ? { transfers: 1 } : {};
  const t1 = { id: `t${rid()}`, name: `${from.name} → ${to.name}`.slice(0, 160), from, to, active: true, period: out.departAfter < '12:00' ? 'am' : 'pm', schedule: out, ...xfer };
  const list = [t1];
  if (body.roundTrip) {
    const back = schedule({ days: out.days, departAfter: HM.test(body.returnAfter || '') ? body.returnAfter : '16:30', departUntil: body.returnUntil });
    const t2 = { id: `t${rid()}`, name: `${to.name} → ${from.name}`.slice(0, 160), from: to, to: from, active: true, period: back.departAfter < '12:00' ? 'am' : 'pm', schedule: back, returnOf: t1.id, ...xfer };
    t1.returnId = t2.id; list.push(t2);
  }
  profile.tours.push(...list);
  return list;
}

export function patchTour(profile, id, body) {
  const t = profile.tours.find((x) => x.id === id);
  if (!t) throw new ValidationError('Strecke nicht gefunden', 404);
  if (typeof body.active === 'boolean') t.active = body.active;
  if (typeof body.name === 'string' && body.name.trim()) t.name = body.name.trim().slice(0, 160);
  if (body.schedule && typeof body.schedule === 'object') {
    const prev = schedule(t.schedule), want = body.schedule;
    // Only the start comes (older app): the window keeps its length instead of getting stuck at the old end
    const keepLen = HM.test(want.departAfter || '') && !HM.test(want.departUntil || '')
      ? { departUntil: fmtMin(Math.min(24 * 60 - 1, toMin(want.departAfter) + toMin(prev.departUntil) - toMin(prev.departAfter))) } : {};
    t.schedule = schedule({ ...prev, ...want, ...keepLen });
    t.period = t.schedule.departAfter < '12:00' ? 'am' : 'pm';
  }
  return t;
}

export function deleteTour(profile, id) {
  const t = profile.tours.find((x) => x.id === id);
  if (!t) throw new ValidationError('Strecke nicht gefunden', 404);
  profile.tours = profile.tours.filter((x) => x.id !== id);
  for (const o of profile.tours) { if (o.returnId === id) delete o.returnId; if (o.returnOf === id) delete o.returnOf; }
  return t;
}

export function setSettings(profile, body) {
  if (body.pushThresholdMin === undefined && body.pushWindow === undefined) throw new ValidationError('Keine bekannte Einstellung');
  if (body.pushThresholdMin !== undefined) {
    if (![3, 5, 10].includes(body.pushThresholdMin)) throw new ValidationError('pushThresholdMin muss 3, 5 oder 10 sein');
    profile.settings.pushThresholdMin = body.pushThresholdMin;
  }
  // pushWindow used to exist as a switch ("Nur rund um die Abfahrt"). Older apps still send it; it has no effect any more: push follows the commute time.
  if (body.pushWindow !== undefined && typeof body.pushWindow !== 'boolean') throw new ValidationError('pushWindow muss true oder false sein');
  return profile.settings;
}

/**
 * Replace all routes (for "Rückgängig" (undo) in the frontend). Only known fields are taken over, coordinates are kept.
 * Settings and push subscription stay untouched: undo must not overwrite anything that was changed in the meantime.
 */
export function replaceProfile(profile, body) {
  if (!Array.isArray(body?.tours)) throw new ValidationError('tours fehlt');
  const ids = new Set(), tours = [];
  for (const t of body.tours.slice(0, MAX_TOURS)) {
    if (!t || !isStop(t.from) || !isStop(t.to) || typeof t.id !== 'string' || !LINK_ID.test(t.id)) throw new ValidationError('Ungültige Strecke');
    if (ids.has(t.id)) continue;
    ids.add(t.id);
    const sch = schedule(t.schedule);
    tours.push({ id: t.id, name: String(t.name || `${t.from.name} → ${t.to.name}`).slice(0, 160), from: pt(t.from), to: pt(t.to), active: t.active !== false, period: sch.departAfter < '12:00' ? 'am' : 'pm', schedule: sch,
      ...(typeof t.returnId === 'string' && LINK_ID.test(t.returnId) ? { returnId: t.returnId } : {}), ...(typeof t.returnOf === 'string' && LINK_ID.test(t.returnOf) ? { returnOf: t.returnOf } : {}),
      ...(t.transfers === 1 ? { transfers: 1 } : {}) });
  }
  for (const t of tours) { if (t.returnId && !ids.has(t.returnId)) delete t.returnId; if (t.returnOf && !ids.has(t.returnOf)) delete t.returnOf; }
  profile.tours = tours;
  return profile;
}
