// Pendelzeit („Fenster“): Beim Einrichten legt man fest, an welchen Tagen und von wann bis wann man losfährt.
// Daran richtet ReGo alles aus: welche Strecke oben steht, welche Züge bewertet werden und wann Push kommt.
import { berlin, fromBerlin, weekday, toMin } from '../lib/time.mjs';

const MIN = 60000;
export const WINDOW_DEFAULT_LEN = 60;    // ältere Strecken kennen nur „ab“: ihr Fenster dauert dann eine Stunde
export const WINDOW_MIN_LEN = 10;        // kürzer darf ein Fenster nicht sein
export const ANCHOR_LEAD_MIN = 180;      // so früh vor dem Fenster zeigt die Strecke schon die Züge darin
export const PUSH_LEAD_MIN = 60;         // Push ab einer Stunde vor dem Fenster …
export const PUSH_TAIL_MIN = 10;         // … bis kurz nach seinem Ende
export const FAR_MIN = 45;               // Fahrten, die weiter weg sind, heißen „planmäßig“: für sie kennt die Quelle noch kaum Verspätungen

const DAY_END = 24 * 60 - 1;
const HM = /^([01]\d|2[0-3]):[0-5]\d$/;
export const fmtMin = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
/** Does the schedule carry usable commute times (start time and days)? Older routes may lack them. */
const known = (schedule) => !!schedule && HM.test(schedule.departAfter || '') && Array.isArray(schedule.days);

/**
 * Ende des Fensters (Minuten seit Mitternacht) zu einem Beginn. `until` fehlt oder taugt nicht: eine Stunde nach dem Beginn.
 * Mindestens WINDOW_MIN_LEN, höchstens bis 23:59 (über Mitternacht gibt es kein Fenster).
 */
export function untilMin(fromMin, until) {
  const raw = HM.test(until || '') ? toMin(until) : fromMin + WINDOW_DEFAULT_LEN;
  return Math.min(DAY_END, Math.max(raw, fromMin + WINDOW_MIN_LEN));
}

/** Fenster einer Strecke: { from: 'HH:MM', until: 'HH:MM' } – auch für ältere Strecken ohne Ende. */
export function windowOf(schedule) {
  const from = toMin(HM.test(schedule?.departAfter || '') ? schedule.departAfter : '07:00');
  return { from: fmtMin(from), until: fmtMin(untilMin(from, schedule?.departUntil)) };
}

/**
 * Wo steht die Strecke jetzt zu ihrer Pendelzeit?
 *   now   – das Fenster läuft
 *   soon  – das Fenster beginnt heute noch
 *   done  – das Fenster war heute schon
 *   off   – heute wird auf dieser Strecke nicht gependelt (anderer Wochentag), oder es sind keine Zeiten bekannt
 * anchor: ab diesem Zeitpunkt (ms) fragen wir die Züge ab – vor dem Fenster, aber höchstens ANCHOR_LEAD_MIN davor; sonst null.
 * endMs: Ende des Fensters heute (ms), bei now und soon.
 */
export function windowState(schedule, nowMs) {
  if (!known(schedule)) return { mode: 'off', anchor: null, endMs: null };
  const w = windowOf(schedule);
  const base = { from: w.from, until: w.until, anchor: null, endMs: null };
  if (!schedule.days.includes(weekday(nowMs))) return { ...base, mode: 'off' };
  const date = berlin(nowMs).date;
  const startMs = fromBerlin(date, w.from), endMs = fromBerlin(date, w.until);
  if (nowMs < startMs) return { ...base, mode: 'soon', endMs, anchor: startMs - nowMs <= ANCHOR_LEAD_MIN * MIN ? startMs : null };
  if (nowMs <= endMs) return { ...base, mode: 'now', endMs };
  return { ...base, mode: 'done' };
}

/** Zeiten, wenn eine Strecke keine hat (so alt kann nur Testdaten betreffen) */
export const DEFAULT_SCHEDULE = { days: ['Mo', 'Di', 'Mi', 'Do', 'Fr'], departAfter: '06:00' };

/** Was die Strecke nach außen von ihrer Pendelzeit zeigt: die Zeiten vollständig (auch bei älteren Strecken) und das Fenster mit seinem Zustand. */
export function windowView(schedule, nowMs) {
  const sch = schedule || DEFAULT_SCHEDULE, w = windowOf(sch);
  return { schedule: { ...sch, departUntil: w.until }, window: { from: w.from, until: w.until, mode: windowState(sch, nowMs).mode } };
}

/**
 * Darf für diese Strecke jetzt Push kommen? An den Tagen der Strecke ab PUSH_LEAD_MIN vor dem Fenster bis PUSH_TAIL_MIN nach seinem Ende.
 * Eine Strecke ohne Zeiten (ältere Daten) darf immer.
 */
export function pushActive(tour, nowMs) {
  const s = tour?.schedule;
  if (!known(s)) return true;
  if (!s.days.includes(weekday(nowMs))) return false;
  const w = windowOf(s), date = berlin(nowMs).date;
  return nowMs >= fromBerlin(date, w.from) - PUSH_LEAD_MIN * MIN && nowMs <= fromBerlin(date, w.until) + PUSH_TAIL_MIN * MIN;
}

/**
 * Exception to the night quiet (23:00–04:00): a route with its own commute times may push at night while its push period runs,
 * e.g. a departure at 04:20 pushes from 03:20. A route without times (older data) stays quiet at night.
 */
export const pushAtNight = (tour, nowMs) => known(tour?.schedule) && pushActive(tour, nowMs);

/** Liegt die Abfahrt weiter weg als FAR_MIN? Dann sagt ReGo „planmäßig“ statt „pünktlich“. */
export const isFar = (depMs, nowMs) => depMs - nowMs > FAR_MIN * MIN;

/** Reihenfolge der Strecken auf dem Hauptbildschirm: Fenster läuft, dann das nächste Fenster heute, danach der Rest. */
export const windowRank = (mode) => (mode === 'now' ? 0 : mode === 'soon' ? 1 : 2);
