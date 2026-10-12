// Profil je Gerät als JSON-Datei. Keine Konten, keine Tickets, nur Strecken und Einstellungen.
import { mkdir, readFile, writeFile, rename, unlink, stat, utimes, readdir } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';

export const DEVICE_RE = /^[A-Za-z0-9_-]{16,64}$/;
export class ValidationError extends Error { constructor(m) { super(m); this.status = 400; } }

export const defaultProfile = () => ({ tours: [], settings: { pushThresholdMin: 5, delayGraceMin: 10, pushWindow: false }, push: null, updatedAt: 0 });
const rid = () => randomBytes(4).toString('hex');
const isStop = (s) => s && typeof s.id === 'string' && s.id && typeof s.name === 'string' && s.name;
const DAYS = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'];

export class ProfileStore {
  constructor(dir, now = () => Date.now()) { this.dir = join(dir, 'profiles'); this.now = now; this.locks = new Map(); }

  file(device) {
    if (!DEVICE_RE.test(device || '')) throw new ValidationError('Ungültige Geräte-ID');
    return join(this.dir, `${device}.json`);
  }

  async load(device) {
    try { return { ...defaultProfile(), ...JSON.parse(await readFile(this.file(device), 'utf8')) }; }
    catch (e) { if (e.code === 'ENOENT') return defaultProfile(); throw e; }
  }

  async save(device, profile) {
    await mkdir(this.dir, { recursive: true });
    const f = this.file(device), tmp = `${f}.${rid()}.tmp`;
    profile.updatedAt = this.now();
    await writeFile(tmp, JSON.stringify(profile, null, 2));
    await rename(tmp, f);
    return profile;
  }

  /** Änderungen je Gerät nacheinander ausführen (kein Verlust bei gleichzeitigen Anfragen). */
  async update(device, fn) {
    const prev = this.locks.get(device) || Promise.resolve();
    const run = prev.catch(() => {}).then(async () => { const p = await this.load(device); const r = await fn(p); await this.save(device, p); return r ?? p; });
    this.locks.set(device, run);
    try { return await run; } finally { if (this.locks.get(device) === run) this.locks.delete(device); }
  }

  /** „Zuletzt benutzt“ vermerken (Änderungszeit der Datei), höchstens alle 12 Stunden. */
  async touch(device) {
    const f = this.file(device);
    try { const st = await stat(f); if (this.now() - st.mtimeMs > 12 * 3600e3) { const d = new Date(this.now()); await utimes(f, d, d); } } catch { /* Gerät ohne Profil */ }
  }

  /** Profile löschen, die seit `days` Tagen nicht benutzt wurden. Gibt die Anzahl zurück. */
  async purge(days) {
    if (!(days > 0)) return 0;
    let n = 0, files = [];
    try { files = await readdir(this.dir); } catch { return 0; }
    for (const f of files) {
      if (!f.endsWith('.json')) continue;
      try { const st = await stat(join(this.dir, f)); if (this.now() - st.mtimeMs > days * 864e5) { await unlink(join(this.dir, f)); n++; } } catch { /* schon weg */ }
    }
    return n;
  }

  async remove(device) { try { await unlink(this.file(device)); } catch (e) { if (e.code !== 'ENOENT') throw e; } }
}

function schedule(input = {}) {
  const days = Array.isArray(input.days) ? input.days.filter((d) => DAYS.includes(d)) : ['Mo', 'Di', 'Mi', 'Do', 'Fr'];
  const departAfter = /^([01]\d|2[0-3]):[0-5]\d$/.test(input.departAfter || '') ? input.departAfter : '07:00';
  return { days: days.length ? days : ['Mo', 'Di', 'Mi', 'Do', 'Fr'], departAfter };
}

/**
 * Neue Strecke. body: { from:{id,name}, to:{id,name}, schedule?, roundTrip?: boolean, returnAfter?: 'HH:MM' }
 * Gibt die angelegten Touren zurück (1 oder 2).
 */
export function addTours(profile, body) {
  if (!isStop(body?.from) || !isStop(body?.to)) throw new ValidationError('Start und Ziel müssen Haltestellen sein');
  if (body.from.id === body.to.id) throw new ValidationError('Start und Ziel sind gleich');
  if (profile.tours.length >= 20) throw new ValidationError('Maximal 20 Strecken');
  const pt = (s) => ({ id: s.id, name: s.name, ...(Number.isFinite(s.lat) && Number.isFinite(s.lon) ? { lat: s.lat, lon: s.lon } : {}) });
  const from = pt(body.from), to = pt(body.to);
  const out = schedule(body.schedule);
  const t1 = { id: `t${rid()}`, name: `${from.name} → ${to.name}`, from, to, active: true, period: out.departAfter < '12:00' ? 'am' : 'pm', schedule: out };
  const list = [t1];
  if (body.roundTrip) {
    const back = schedule({ days: out.days, departAfter: /^([01]\d|2[0-3]):[0-5]\d$/.test(body.returnAfter || '') ? body.returnAfter : '16:30' });
    const t2 = { id: `t${rid()}`, name: `${to.name} → ${from.name}`, from: to, to: from, active: true, period: back.departAfter < '12:00' ? 'am' : 'pm', schedule: back, returnOf: t1.id };
    t1.returnId = t2.id; list.push(t2);
  }
  profile.tours.push(...list);
  return list;
}

export function patchTour(profile, id, body) {
  const t = profile.tours.find((x) => x.id === id);
  if (!t) { const e = new ValidationError('Strecke nicht gefunden'); e.status = 404; throw e; }
  if (typeof body.active === 'boolean') t.active = body.active;
  if (typeof body.name === 'string' && body.name.trim()) t.name = body.name.trim().slice(0, 80);
  if (body.schedule) { t.schedule = schedule({ ...t.schedule, ...body.schedule }); t.period = t.schedule.departAfter < '12:00' ? 'am' : 'pm'; }
  return t;
}

export function deleteTour(profile, id) {
  const t = profile.tours.find((x) => x.id === id);
  if (!t) { const e = new ValidationError('Strecke nicht gefunden'); e.status = 404; throw e; }
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
  if (body.pushWindow !== undefined) {
    if (typeof body.pushWindow !== 'boolean') throw new ValidationError('pushWindow muss true oder false sein');
    profile.settings.pushWindow = body.pushWindow;
  }
  return profile.settings;
}

/** Komplettes Profil ersetzen (für „Rückgängig“ im Frontend). Nur bekannte Felder werden übernommen. */
export function replaceProfile(profile, body) {
  if (!Array.isArray(body?.tours)) throw new ValidationError('tours fehlt');
  const tours = body.tours.slice(0, 20).map((t) => {
    if (!isStop(t.from) || !isStop(t.to) || typeof t.id !== 'string' || !/^[\w-]{1,32}$/.test(t.id)) throw new ValidationError('Ungültige Strecke');
    const sch = schedule(t.schedule);
    return { id: t.id, name: String(t.name || `${t.from.name} → ${t.to.name}`).slice(0, 80), from: { id: t.from.id, name: t.from.name }, to: { id: t.to.id, name: t.to.name }, active: t.active !== false, period: sch.departAfter < '12:00' ? 'am' : 'pm', schedule: sch, ...(t.returnId ? { returnId: String(t.returnId) } : {}), ...(t.returnOf ? { returnOf: String(t.returnOf) } : {}) };
  });
  profile.tours = tours;
  if (body.settings) setSettings(profile, body.settings);
  return profile;
}
