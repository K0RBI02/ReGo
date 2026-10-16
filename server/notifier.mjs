// Prüft regelmäßig die Strecken von Geräten mit Push-Abo und meldet neue, relevante Vorfälle.
// Zugestellt wird nur an die Android-App: Firebase stößt sie an (leerer Push), den Text holt sie danach selbst vom Server;
// ohne Firebase fragt sie alle ~15 Minuten nach (/api/notifications).
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { berlin } from './lib/time.mjs';
import { pushActive } from './domain/window.mjs';

const DAY = 24 * 3600e3;

/** Welche Vorfälle sind eine Benachrichtigung wert? Verspätung ab Schwelle, alles andere (Ersatzverkehr, Baustelle, Ausfall, Gleiswechsel, wackelnder oder verpasster Anschluss) immer. */
export function relevant(inc, threshold) {
  if (inc.kind === 'delay') return inc.delayMin >= threshold;
  return inc.validity?.activeNow !== false;
}

const LABEL = { replacement: 'Ersatzverkehr', construction: 'Baustelle', cancelled: 'Ausfall', platform: 'Gleiswechsel', tight: 'Anschluss wackelt', missed: 'Anschluss verpasst' };

// Linienname kommt aus lineName (z. B. „RE 5“, „S 1“ mit Leerzeichen); ältere Meldungen ohne das Feld: erstes Wort des Titels
export function lineOf(inc) {
  const full = String(inc.title || '');
  return inc.lineName && full.startsWith(`${inc.lineName} `) ? inc.lineName : full.split(' ')[0];
}

export function textFor(inc) {
  const full = String(inc.title || '');
  const named = !!inc.lineName && full.startsWith(`${inc.lineName} `);
  const line = lineOf(inc);
  const route = named ? full.slice(inc.lineName.length + 1) : full.replace(/^\S+\s/, '');
  const title = inc.kind === 'delay' ? `${line} +${inc.delayMin} Min.` : `${LABEL[inc.kind] || 'Hinweis'} · ${line}`;
  return { title, body: `${route} · ${inc.summary}` };
}

/** Was sich an einer Meldung ändern kann, ohne dass sie neu ist: Verspätung (Minuten), Zahl der Ausfälle, neues Gleis. Dann wird die Meldung leise aktualisiert. */
export const changeOf = (inc) => (inc.kind === 'delay' ? inc.delayMin : inc.kind === 'cancelled' ? inc.count : inc.kind === 'platform' ? inc.platform : undefined);

export function createNotifier({ config, store, service, now = () => Date.now(), fcm = null }) {
  const log = (...a) => config.verbose && console.log(...a);
  const idleMs = (config.notifyIdleDays ?? 21) * DAY;

  /** 'ok' | 'gone' | 'error' | 'none' */
  async function deliver(device, profile) {
    const sub = profile.push;
    if (!sub?.native) return 'none';
    // Mit Firebase sofort anstoßen, sonst holt die App die Meldungen selbst alle ~15 Min. ab
    if (sub.fcm && fcm?.enabled) {
      const r = await fcm.send(sub.fcm);
      if (r === 'gone') await store.update(device, (p) => { if (p.push?.native) p.push = { native: true }; });
      return r;
    }
    return 'ok';
  }

  // Push gibt es nur in der Pendelzeit der Strecke (ab einer Stunde vor dem Fenster bis kurz nach seinem Ende, an den Tagen der Strecke)
  const tagOf = (id) => `inc|${id}`;
  const GONE_TICKS = 2;       // erst nach zwei Durchläufen ohne den Vorfall die Meldung entfernen (Daten können kurz haken)
  const CLEAR_WINDOW = 12 * 3600e3;

  async function checkDevice(device) {
    const profile = await store.load(device);
    if (!profile.push?.native || !profile.tours.some((t) => t.active !== false)) return 0;
    // App deinstalliert oder Handy verschwunden: die App meldet sich sonst alle ~15 Min. von selbst, bei Funkstille nicht mehr prüfen
    if (profile.lastSeen && now() - profile.lastSeen > idleMs) return 0;
    const hour = Number(berlin(now()).time.slice(0, 2));
    if (hour < 4 || hour >= 23) return 0;                       // nachts Ruhe
    const state = await service.getState(device);
    const hasTours = Array.isArray(state.tours);
    if (state.connection.status === 'error' && !hasTours) return 0;
    // Strecken ohne frische Daten (Quelle gestört): keine neuen Meldungen daraus, und Wegfall nicht beurteilen. Andere Strecken laufen normal weiter.
    const stale = new Set(hasTours ? state.tours.filter((t) => t.stale).map((t) => t.id) : []);
    const tourOf = Object.fromEntries(profile.tours.map((t) => [t.id, t]));
    const usable = state.incidents.filter((i) => !stale.has(i.tourId));
    const cur = new Map(usable.filter((i) => relevant(i, profile.settings.pushThresholdMin)).map((i) => [i.id, i]));
    const present = new Set(state.incidents.map((i) => i.id));
    const notified = profile.notified || {}, shown = profile.shownDelay || {}, gone = profile.goneCount || {};
    // Neu gemeldet wird nur in der Pendelzeit. Außerhalb bleibt ein Vorfall „vorhanden“: er wird weder neu gemeldet noch als „behoben“ weggenommen.
    const fresh = [...cur.values()].filter((i) => !notified[i.id] && pushActive(tourOf[i.tourId], now()));
    // Etwas an einer bekannten Meldung hat sich geändert (Verspätung, Zahl der Ausfälle, Gleis): bestehende Meldung leise aktualisieren
    const updates = [...cur.values()].filter((i) => notified[i.id] && changeOf(i) !== undefined && shown[i.id] != null && changeOf(i) !== shown[i.id]);
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
    const entry = (i, extra = {}) => ({ ...textFor(i), kind: i.kind, line: lineOf(i), url: `/Detail#${i.id}-m`, ts: stamp, b: stamp, tag: tagOf(i.id), ...extra });
    await store.update(device, (p) => {
      // Gemerkt bleibt, was jünger als 3 Tage ist oder noch besteht (lange Baustellen sollen nicht alle 3 Tage neu gemeldet werden)
      p.notified = Object.fromEntries(Object.entries(p.notified || {}).filter(([id, ts]) => now() - ts < 3 * DAY || present.has(id)));
      p.shownDelay = Object.fromEntries(Object.entries(p.shownDelay || {}).filter(([id]) => id in p.notified));
      p.outbox = (p.outbox || []).slice(-19);
      for (const i of fresh) { p.notified[i.id] = now(); if (changeOf(i) !== undefined) p.shownDelay[i.id] = changeOf(i); p.outbox.push(entry(i)); }
      for (const i of updates) { p.shownDelay[i.id] = changeOf(i); p.outbox.push(entry(i, { update: true })); }
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

  /** Testmeldung an dieses Gerät. Gibt zurück, ob sie sofort (Firebase) oder erst beim nächsten Abholen der App ankommt, und das Ergebnis der Zustellung. */
  async function sendTest(device) {
    const text = { title: 'ReGo Testmeldung', body: 'So sieht eine Meldung aus. Wenn du das liest, funktioniert Push.', kind: 'test', url: '/Meldungen' };
    await store.update(device, (p) => { p.outbox = [...(p.outbox || []).slice(-9), { ...text, ts: now() }]; });
    const profile = await store.load(device);
    const instant = !!(profile.push?.fcm && fcm?.enabled);
    const result = await deliver(device, profile);
    return { instant: instant && result === 'ok', result };
  }

  async function takeOutbox(device) {
    let out = [];
    await store.update(device, (p) => { out = p.outbox || []; p.outbox = []; });
    return out;
  }

  return { tick, checkDevice, sendTest, takeOutbox };
}
