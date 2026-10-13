// Prüft regelmäßig die Strecken von Geräten mit Push-Abo und meldet neue, relevante Vorfälle.
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { sendPush } from './push.mjs';
import { berlin } from './lib/time.mjs';

const DAY = 24 * 3600e3;

/** Welche Vorfälle sind eine Benachrichtigung wert? Verspätung ab Schwelle, Ersatzverkehr/Baustelle immer. */
export function relevant(inc, threshold) {
  if (inc.kind === 'delay') return inc.delayMin >= threshold;
  return inc.validity?.activeNow !== false;
}

// Linienname kommt aus lineName (z. B. „RE 5“, „S 1“ mit Leerzeichen); ältere Meldungen ohne das Feld: erstes Wort des Titels
export function textFor(inc) {
  const full = String(inc.title || '');
  const named = !!inc.lineName && full.startsWith(`${inc.lineName} `);
  const line = named ? inc.lineName : full.split(' ')[0];
  const route = named ? full.slice(inc.lineName.length + 1) : full.replace(/^\S+\s/, '');
  const title = inc.kind === 'delay' ? `${line} +${inc.delayMin} Min.` : `${inc.kind === 'replacement' ? 'Ersatzverkehr' : 'Baustelle'} · ${line}`;
  return { title, body: `${route} · ${inc.summary}` };
}

export function createNotifier({ config, store, service, vapid, now = () => Date.now(), send = sendPush, fcm = null }) {
  const subject = config.vapidSubject;

  const log = (...a) => config.verbose && console.log(...a);
  const idleMs = (config.notifyIdleDays ?? 21) * DAY;

  async function deliver(device, profile) {
    const sub = profile.push;
    if (sub?.native) {
      // Android-App: mit Firebase sofort anstoßen, sonst holt sie die Meldungen selbst alle ~15 Min. ab
      if (sub.fcm && fcm?.enabled) {
        const r = await fcm.send(sub.fcm);
        if (r === 'gone') await store.update(device, (p) => { if (p.push?.native) p.push = { native: true }; });
        return r;
      }
      return 'ok';
    }
    if (!sub?.endpoint) return 'none';
    const r = await send(vapid, subject, sub, undefined, log);
    if (r === 'gone') await store.update(device, (p) => { p.push = null; });
    return r;
  }

  // Nur rund um die eingestellte Abfahrtszeit (±20 Min.) an den Tagen der Strecke
  const WINDOW_MIN = 20, WD = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'];
  function inWindow(tour, t) {
    if (!tour?.schedule) return true;
    const b = berlin(t), wd = WD[new Date(`${b.date}T12:00:00Z`).getUTCDay()];
    if (!tour.schedule.days.includes(wd)) return false;
    const m = (hm) => Number(hm.slice(0, 2)) * 60 + Number(hm.slice(3, 5));
    return Math.abs(m(b.time) - m(tour.schedule.departAfter)) <= WINDOW_MIN;
  }
  const tagOf = (id) => `inc|${id}`;
  const GONE_TICKS = 2;       // erst nach zwei Durchläufen ohne den Vorfall die Meldung entfernen (Daten können kurz haken)
  const CLEAR_WINDOW = 12 * 3600e3;

  async function checkDevice(device) {
    const profile = await store.load(device);
    if (!profile.push || !profile.tours.some((t) => t.active !== false)) return 0;
    // App deinstalliert oder Handy verschwunden: die App meldet sich sonst alle ~15 Min. von selbst, bei Funkstille nicht mehr prüfen
    if (profile.push.native && profile.lastSeen && now() - profile.lastSeen > idleMs) return 0;
    const hour = Number(berlin(now()).time.slice(0, 2));
    if (hour < 4 || hour >= 23) return 0;                       // nachts Ruhe
    const state = await service.getState(device);
    const hasTours = Array.isArray(state.tours);
    if (state.connection.status === 'error' && !hasTours) return 0;
    // Strecken ohne frische Daten (Quelle gestört): keine neuen Meldungen daraus, und Wegfall nicht beurteilen. Andere Strecken laufen normal weiter.
    const stale = new Set(hasTours ? state.tours.filter((t) => t.stale).map((t) => t.id) : []);
    const tourOf = Object.fromEntries(profile.tours.map((t) => [t.id, t]));
    const usable = state.incidents.filter((i) => !stale.has(i.tourId));
    const cur = new Map(usable.filter((i) => relevant(i, profile.settings.pushThresholdMin) && (!profile.settings.pushWindow || inWindow(tourOf[i.tourId], now()))).map((i) => [i.id, i]));
    const present = new Set(state.incidents.map((i) => i.id));
    const notified = profile.notified || {}, shown = profile.shownDelay || {}, gone = profile.goneCount || {};
    const fresh = [...cur.values()].filter((i) => !notified[i.id]);
    // Verspätung hat sich geändert: bestehende Meldung leise aktualisieren
    const updates = [...cur.values()].filter((i) => notified[i.id] && i.kind === 'delay' && shown[i.id] != null && i.delayMin !== shown[i.id]);
    // Vorfall ist weg (Verspätung vorbei, Zug abgefahren): Meldung entfernen
    const nextGone = {};
    for (const id of Object.keys(notified)) if (!cur.has(id)) { const c = (gone[id] || 0) + (stale.size ? 0 : 1); if (c) nextGone[id] = c; }
    const cleared = stale.size ? [] : Object.keys(nextGone).filter((id) => nextGone[id] >= GONE_TICKS && now() - notified[id] < CLEAR_WINDOW);
    const goneChanged = JSON.stringify(nextGone) !== JSON.stringify(gone);
    if (!fresh.length && !updates.length && !cleared.length) {
      if (goneChanged) await store.update(device, (p) => { p.goneCount = nextGone; });
      return 0;
    }
    const stamp = now();
    const snap = { notified: { ...notified }, shown: { ...shown }, gone: { ...gone } };
    await store.update(device, (p) => {
      // Gemerkt bleibt, was jünger als 3 Tage ist oder noch besteht (lange Baustellen sollen nicht alle 3 Tage neu gemeldet werden)
      p.notified = Object.fromEntries(Object.entries(p.notified || {}).filter(([id, ts]) => now() - ts < 3 * DAY || present.has(id)));
      p.shownDelay = Object.fromEntries(Object.entries(p.shownDelay || {}).filter(([id]) => id in p.notified));
      p.outbox = (p.outbox || []).slice(-19);
      for (const i of fresh) { p.notified[i.id] = now(); if (i.kind === 'delay') p.shownDelay[i.id] = i.delayMin; p.outbox.push({ ...textFor(i), url: `/Detail#${i.id}-m`, ts: stamp, b: stamp, tag: tagOf(i.id) }); }
      for (const i of updates) { p.shownDelay[i.id] = i.delayMin; p.outbox.push({ ...textFor(i), url: `/Detail#${i.id}-m`, ts: stamp, b: stamp, tag: tagOf(i.id), update: true }); }
      for (const id of cleared) { delete p.notified[id]; delete p.shownDelay[id]; delete nextGone[id]; p.outbox.push({ clear: true, tag: tagOf(id), ts: stamp, b: stamp }); }
      p.goneCount = nextGone;
    });
    log(`Push: ${fresh.length} neu, ${updates.length} aktualisiert, ${cleared.length} entfernt (${[...fresh, ...updates].map((i) => i.title).join(' | ')})`);
    const r = await deliver(device, await store.load(device));
    if (r === 'error') {      // Push-Dienst nicht erreichbar: beim nächsten Durchlauf noch einmal versuchen, nichts verlieren
      await store.update(device, (p) => { p.notified = snap.notified; p.shownDelay = snap.shown; p.goneCount = snap.gone; p.outbox = (p.outbox || []).filter((o) => o.b !== stamp); });
      log(`Push: Zustellung fehlgeschlagen, neuer Versuch in ${config.notifyEverySec} s (${new Date(stamp).toISOString()})`);
      return 0;
    }
    return fresh.length + updates.length + cleared.length;
  }

  let ticking = false;
  async function tick() {
    if (ticking) return 0;                                      // der letzte Durchlauf ist noch nicht fertig (z. B. Quelle antwortet langsam)
    ticking = true;
    try {
      let files = [];
      try { files = await readdir(join(config.dataDir, 'profiles')); } catch { return 0; }
      let n = 0;
      for (const f of files) {
        if (!f.endsWith('.json')) continue;
        try { n += await checkDevice(f.slice(0, -5)); } catch (e) { if (config.verbose) console.error('notifier', e.message); }
      }
      return n;
    } finally { ticking = false; }
  }

  async function sendTest(device, text = { title: 'ReGo', body: 'Push ist eingerichtet.' }) {
    await store.update(device, (p) => { p.outbox = [...(p.outbox || []).slice(-9), { ...text, url: '/', ts: now() }]; });
    await deliver(device, await store.load(device));
  }

  async function takeOutbox(device) {
    let out = [];
    await store.update(device, (p) => { out = p.outbox || []; p.outbox = []; });
    return out;
  }

  return { tick, checkDevice, sendTest, takeOutbox };
}
