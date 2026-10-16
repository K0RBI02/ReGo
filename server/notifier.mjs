// Regularly checks the routes of devices with a push subscription and reports new, relevant incidents.
// Delivery goes to the Android app only: Firebase nudges it (empty push), then it fetches the text from the server itself;
// without Firebase it asks about every 15 minutes (/api/notifications).
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { berlin } from './lib/time.mjs';
import { pushActive, pushAtNight } from './domain/window.mjs';

const DAY = 24 * 3600e3;

/** Which incidents are worth a notification? A delay from the threshold; everything else (replacement transport, construction, cancellation, platform change, shaky or missed connection) always. */
export function relevant(inc, threshold) {
  if (inc.kind === 'delay') return inc.delayMin >= threshold;
  return inc.validity?.activeNow !== false;
}

const LABEL = { replacement: 'Ersatzverkehr', construction: 'Baustelle', cancelled: 'Ausfall', platform: 'Gleiswechsel', tight: 'Anschluss wackelt', missed: 'Anschluss verpasst' };

// The line name comes from lineName (e.g. "RE 5", "S 1" with a space); older incidents without the field: first word of the title
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

/** What can change about a notification without it being new: delay (minutes), number of cancellations, new platform. Then the notification is updated silently. */
export const changeOf = (inc) => (inc.kind === 'delay' ? inc.delayMin : inc.kind === 'cancelled' ? inc.count : inc.kind === 'platform' ? inc.platform : undefined);

export function createNotifier({ config, store, service, now = () => Date.now(), fcm = null }) {
  const log = (...a) => config.verbose && console.log(...a);
  const idleMs = (config.notifyIdleDays ?? 21) * DAY;

  /** 'ok' | 'gone' | 'error' | 'none' */
  async function deliver(device, profile) {
    const sub = profile.push;
    if (!sub?.native) return 'none';
    // With Firebase nudge right away, otherwise the app fetches the notifications itself about every 15 min
    if (sub.fcm && fcm?.enabled) {
      const r = await fcm.send(sub.fcm);
      if (r === 'gone') await store.update(device, (p) => { if (p.push?.native) p.push = { native: true }; });
      return r;
    }
    return 'ok';
  }

  // Push only happens in the commute time of the route (from an hour before the window until shortly after its end, on the route's days)
  const tagOf = (id) => `inc|${id}`;
  const GONE_TICKS = 2;       // remove the notification only after two passes without the incident (data may hiccup briefly)
  const CLEAR_WINDOW = 12 * 3600e3;

  async function checkDevice(device) {
    const profile = await store.load(device);
    if (!profile.push?.native || !profile.tours.some((t) => t.active !== false)) return 0;
    // App uninstalled or phone gone: otherwise the app reports in by itself about every 15 min; with radio silence stop checking
    if (profile.lastSeen && now() - profile.lastSeen > idleMs) return 0;
    // Night quiet 23:00–04:00. The one exception is a route whose own push period runs into the night (a departure at 04:20 pushes from 03:20):
    // while that lasts, only such routes are looked at – every other route and all notifications stay untouched until morning.
    const hour = Number(berlin(now()).time.slice(0, 2));
    const night = hour < 4 || hour >= 23;
    const inScope = (tour) => !night || pushAtNight(tour, now());
    if (night && !profile.tours.some((t) => t.active !== false && inScope(t))) return 0;
    const state = await service.getState(device);
    const hasTours = Array.isArray(state.tours);
    if (state.connection.status === 'error' && !hasTours) return 0;
    // Routes without fresh data (source disturbed): no new notifications from them, and do not judge disappearance. Other routes carry on as usual.
    const stale = new Set(hasTours ? state.tours.filter((t) => t.stale).map((t) => t.id) : []);
    const tourOf = Object.fromEntries(profile.tours.map((t) => [t.id, t]));
    const usable = state.incidents.filter((i) => !stale.has(i.tourId) && inScope(tourOf[i.tourId]));
    const cur = new Map(usable.filter((i) => relevant(i, profile.settings.pushThresholdMin)).map((i) => [i.id, i]));
    const present = new Set(state.incidents.map((i) => i.id));
    const notified = profile.notified || {}, shown = profile.shownDelay || {}, gone = profile.goneCount || {};
    // New notifications only come in the commute time. Outside it an incident stays "present": it is neither reported anew nor removed as "behoben" (resolved).
    const fresh = [...cur.values()].filter((i) => !notified[i.id] && pushActive(tourOf[i.tourId], now()));
    // Something about a known notification changed (delay, number of cancellations, platform): update the existing notification silently
    const updates = [...cur.values()].filter((i) => notified[i.id] && changeOf(i) !== undefined && shown[i.id] != null && changeOf(i) !== shown[i.id]);
    // Incident is gone (delay over, train departed): remove the notification
    // (At night only the routes in their exception are in `cur`, so the rest of the list can't be judged: nothing is counted or cleared until morning.)
    const nextGone = night ? { ...gone } : {};
    if (!night) for (const id of Object.keys(notified)) if (!cur.has(id)) { const c = (gone[id] || 0) + (stale.size ? 0 : 1); if (c) nextGone[id] = c; }
    const cleared = night || stale.size ? [] : Object.keys(nextGone).filter((id) => nextGone[id] >= GONE_TICKS && now() - notified[id] < CLEAR_WINDOW);
    const goneChanged = JSON.stringify(nextGone) !== JSON.stringify(gone);
    if (!fresh.length && !updates.length && !cleared.length) {
      if (goneChanged) await store.update(device, (p) => { p.goneCount = nextGone; });
      return 0;
    }
    const stamp = now();
    const snap = { notified: { ...notified }, shown: { ...shown }, gone: { ...gone } };
    const entry = (i, extra = {}) => ({ ...textFor(i), kind: i.kind, line: lineOf(i), url: `/Detail#${i.id}-m`, ts: stamp, b: stamp, tag: tagOf(i.id), ...extra });
    await store.update(device, (p) => {
      // What stays remembered: whatever is younger than 3 days or still exists (long construction sites must not be reported anew every 3 days)
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
    if (r === 'error') {      // push service unreachable: try again on the next pass, lose nothing
      await store.update(device, (p) => { p.notified = snap.notified; p.shownDelay = snap.shown; p.goneCount = snap.gone; p.outbox = (p.outbox || []).filter((o) => o.b !== stamp); });
      log(`Push: Zustellung fehlgeschlagen, neuer Versuch in ${config.notifyEverySec} s (${new Date(stamp).toISOString()})`);
      return 0;
    }
    return fresh.length + updates.length + cleared.length;
  }

  let ticking = false;
  async function tick() {
    if (ticking) return 0;                                      // the last pass is not finished yet (e.g. source answers slowly)
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

  /** Test notification to this device. Returns whether it arrives right away (Firebase) or only at the app's next fetch, and the result of the delivery. */
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
