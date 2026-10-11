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

export function textFor(inc) {
  const title = inc.kind === 'delay' ? `${inc.title.split(' ')[0]} +${inc.delayMin} Min.`
    : `${inc.kind === 'replacement' ? 'Ersatzverkehr' : 'Baustelle'} · ${inc.title.split(' ')[0]}`;
  const body = `${inc.title.replace(/^\S+\s/, '')} · ${inc.summary}`;
  return { title, body };
}

export function createNotifier({ config, store, service, vapid, now = () => Date.now(), send = sendPush }) {
  const subject = config.vapidSubject;

  async function deliver(device, profile) {
    const sub = profile.push;
    if (!sub?.endpoint) return;
    const r = await send(vapid, subject, sub);
    if (r === 'gone') await store.update(device, (p) => { p.push = null; });
  }

  async function checkDevice(device) {
    const profile = await store.load(device);
    if (!profile.push?.endpoint || !profile.tours.some((t) => t.active !== false)) return 0;
    const hour = Number(berlin(now()).time.slice(0, 2));
    if (hour < 4 || hour >= 23) return 0;                       // nachts Ruhe
    const state = await service.getState(device);
    if (state.connection.status === 'error') return 0;
    const fresh = state.incidents.filter((i) => relevant(i, profile.settings.pushThresholdMin) && !(profile.notified || {})[i.id]);
    if (!fresh.length) return 0;
    await store.update(device, (p) => {
      p.notified = Object.fromEntries(Object.entries(p.notified || {}).filter(([, ts]) => now() - ts < 3 * DAY));
      p.outbox = (p.outbox || []).slice(-9);
      for (const i of fresh) { p.notified[i.id] = now(); p.outbox.push({ ...textFor(i), url: `/Detail#${i.id}-m`, ts: now() }); }
    });
    await deliver(device, await store.load(device));
    return fresh.length;
  }

  async function tick() {
    let files = [];
    try { files = await readdir(join(config.dataDir, 'profiles')); } catch { return 0; }
    let n = 0;
    for (const f of files) {
      if (!f.endsWith('.json')) continue;
      try { n += await checkDevice(f.slice(0, -5)); } catch (e) { if (config.verbose) console.error('notifier', e.message); }
    }
    return n;
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
