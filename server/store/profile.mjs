// Profil je Gerät als JSON-Datei. Keine Konten, keine Tickets, nur Strecken und Einstellungen.
import { mkdir, readFile, writeFile, rename, unlink, stat, readdir } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';

export const DEVICE_RE = /^[A-Za-z0-9_-]{16,64}$/;
export class ValidationError extends Error { constructor(m, status = 400) { super(m); this.status = status; } }

export const defaultProfile = () => ({ tours: [], settings: { pushThresholdMin: 5, delayGraceMin: 10, pushWindow: false }, push: null, updatedAt: 0, lastSeen: 0 });
const rid = () => randomBytes(4).toString('hex');
const DAYS = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'];
const WEEKDAYS = DAYS.slice(0, 5);
const HM = /^([01]\d|2[0-3]):[0-5]\d$/;
const LINK_ID = /^[\w-]{1,32}$/;
const MAX_TOURS = 20;
const SEEN_EVERY = 2 * 3600e3;          // „zuletzt gesehen“ höchstens alle 2 Stunden festhalten

// Haltestelle aus der Haltestellensuche: Kennung (höchstens 64 Zeichen, keine Steuerzeichen) und Name
const isStop = (s) => !!s && typeof s.id === 'string' && /^[^\u0000-\u001f]{1,64}$/.test(s.id) && typeof s.name === 'string' && s.name.trim().length > 0 && s.name.length <= 120;
const validCoord = (lat, lon) => Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180;
const pt = (s) => ({ id: s.id, name: s.name.trim(), ...(validCoord(s.lat, s.lon) ? { lat: s.lat, lon: s.lon } : {}) });
/** Haltestelle aus einer Anfrage in die gespeicherte Form (Kennung, Name, Koordinaten falls sinnvoll) */
export const toStop = pt;

export class ProfileStore {
  constructor(dir, now = () => Date.now(), { maxProfiles = 2000 } = {}) {
    this.dir = join(dir, 'profiles'); this.now = now; this.locks = new Map(); this.maxProfiles = maxProfiles;
    this.known = null; this.seenAt = new Map();
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
      // Beschädigte Datei: zur Seite legen, damit das Gerät nicht dauerhaft mit Fehler 500 hängt und sich nichts überschreibt
      const bad = `${f}.corrupt-${this.now()}`;
      try { await rename(f, bad); } catch { /* schon weg */ }
      console.error(`Profil ${device.slice(0, 6)}… war beschädigt und liegt jetzt als ${bad.split(/[\\/]/).pop()} daneben: ${e.message}`);
      return { ...defaultProfile(), lastSeen: this.now() };
    }
    const def = defaultProfile();
    return {
      ...def, ...data,
      tours: Array.isArray(data.tours) ? data.tours : [],
      settings: { ...def.settings, ...(data.settings && typeof data.settings === 'object' && !Array.isArray(data.settings) ? data.settings : {}) },
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

  /** Gibt es schon ein Profil für dieses Gerät? (Neue Geräte brauchen ggf. den Einladungscode.) */
  async has(device) { return (await this.loadKnown()).has(device); }

  /** Obergrenze für die Zahl der Profile (Schutz davor, dass jemand mit erfundenen Geräte-IDs den Speicher füllt). */
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

  /** Änderungen je Gerät nacheinander ausführen (kein Verlust bei gleichzeitigen Anfragen). */
  async update(device, fn) {
    const prev = this.locks.get(device) || Promise.resolve();
    const run = prev.catch(() => {}).then(async () => { const p = await this.load(device); const r = await fn(p); await this.save(device, p); return r ?? p; });
    this.locks.set(device, run);
    try { return await run; } finally { if (this.locks.get(device) === run) this.locks.delete(device); }
  }

  /** „Zuletzt gesehen“ vermerken, wenn sich das Gerät meldet (App geöffnet, Abruf der Meldungen). Legt kein Profil an. */
  async seen(device) {
    const t = this.now();
    if (t - (this.seenAt.get(device) || 0) < SEEN_EVERY) return;
    this.seenAt.set(device, t);
    if (this.seenAt.size > 5000) this.seenAt.delete(this.seenAt.keys().next().value);
    try { await stat(this.file(device)); } catch { return; }
    await this.update(device, (p) => { p.lastSeen = t; return p; });
  }

  /** Profile löschen, die seit `days` Tagen nicht gesehen wurden (und Reste: halbe Schreibvorgänge, aussortierte Dateien). Gibt die Anzahl gelöschter Profile zurück. */
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
        let seen = (await stat(full)).mtimeMs;                                  // ältere Profile ohne Vermerk: nach Dateizeit
        try { const p = JSON.parse(await readFile(full, 'utf8')); if (Number(p?.lastSeen) > 0) seen = Number(p.lastSeen); } catch { /* beschädigt: Dateizeit */ }
        if (t - seen > days * 864e5) { await unlink(full); this.known?.delete(f.slice(0, -5)); n++; }
      } catch { /* schon weg */ }
    }
    return n;
  }

  async remove(device) {
    try { await unlink(this.file(device)); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    this.known?.delete(device);
  }
}

function schedule(input = {}) {
  const set = new Set(Array.isArray(input.days) ? input.days.filter((d) => DAYS.includes(d)) : []);
  const days = DAYS.filter((d) => set.has(d));                                  // ohne Doppelte, in Wochenreihenfolge
  const departAfter = HM.test(input.departAfter || '') ? input.departAfter : '07:00';
  return { days: days.length ? days : [...WEEKDAYS], departAfter };
}
const sameSchedule = (a = {}, b = {}) => a.departAfter === b.departAfter && (a.days || []).join() === (b.days || []).join();

/**
 * Neue Strecke. body: { from:{id,name}, to:{id,name}, schedule?, roundTrip?: boolean, returnAfter?: 'HH:MM' }
 * Gibt die angelegten Touren zurück (1 oder 2). Gibt es genau diese Strecke mit denselben Tagen und Zeiten schon
 * (z. B. doppelt getippt), wird nichts angelegt und die vorhandene zurückgegeben.
 */
export function addTours(profile, body) {
  if (!isStop(body?.from) || !isStop(body?.to)) throw new ValidationError('Start und Ziel müssen Haltestellen sein');
  if (body.from.id === body.to.id) throw new ValidationError('Start und Ziel sind gleich');
  const from = pt(body.from), to = pt(body.to);
  const out = schedule(body.schedule);
  const dup = profile.tours.find((x) => x.from?.id === from.id && x.to?.id === to.id && sameSchedule(x.schedule, out));
  if (dup) { const back = dup.returnId && profile.tours.find((x) => x.id === dup.returnId); return back ? [dup, back] : [dup]; }
  if (profile.tours.length + (body.roundTrip ? 2 : 1) > MAX_TOURS) throw new ValidationError(`Maximal ${MAX_TOURS} Strecken`);
  const t1 = { id: `t${rid()}`, name: `${from.name} → ${to.name}`.slice(0, 160), from, to, active: true, period: out.departAfter < '12:00' ? 'am' : 'pm', schedule: out };
  const list = [t1];
  if (body.roundTrip) {
    const back = schedule({ days: out.days, departAfter: HM.test(body.returnAfter || '') ? body.returnAfter : '16:30' });
    const t2 = { id: `t${rid()}`, name: `${to.name} → ${from.name}`.slice(0, 160), from: to, to: from, active: true, period: back.departAfter < '12:00' ? 'am' : 'pm', schedule: back, returnOf: t1.id };
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
  if (body.schedule && typeof body.schedule === 'object') { t.schedule = schedule({ ...t.schedule, ...body.schedule }); t.period = t.schedule.departAfter < '12:00' ? 'am' : 'pm'; }
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
  if (body.pushWindow !== undefined) {
    if (typeof body.pushWindow !== 'boolean') throw new ValidationError('pushWindow muss true oder false sein');
    profile.settings.pushWindow = body.pushWindow;
  }
  return profile.settings;
}

/**
 * Alle Strecken ersetzen (für „Rückgängig“ im Frontend). Nur bekannte Felder werden übernommen, Koordinaten bleiben erhalten.
 * Einstellungen und Push-Abo bleiben unberührt: Rückgängig darf nichts überschreiben, was inzwischen geändert wurde.
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
      ...(typeof t.returnId === 'string' && LINK_ID.test(t.returnId) ? { returnId: t.returnId } : {}), ...(typeof t.returnOf === 'string' && LINK_ID.test(t.returnOf) ? { returnOf: t.returnOf } : {}) });
  }
  for (const t of tours) { if (t.returnId && !ids.has(t.returnId)) delete t.returnId; if (t.returnOf && !ids.has(t.returnOf)) delete t.returnOf; }
  profile.tours = tours;
  return profile;
}
