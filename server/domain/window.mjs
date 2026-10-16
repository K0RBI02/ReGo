// Commute time (the "window"): when setting up a route you choose the days and the time from–until you leave.
// Everything is aligned with it: which route is shown on top, which trains are evaluated and when push comes.
import { berlin, fromBerlin, weekday, toMin } from '../lib/time.mjs';

const MIN = 60000;
export const WINDOW_DEFAULT_LEN = 60;    // older routes only know "from": their window then lasts one hour
export const WINDOW_MIN_LEN = 10;        // a window must not be shorter than this
export const ANCHOR_LEAD_MIN = 180;      // this early before the window the route already shows the trains in it
export const PUSH_LEAD_MIN = 60;         // push from one hour before the window …
export const PUSH_TAIL_MIN = 10;         // … until shortly after its end
export const FAR_MIN = 45;               // departures further away are called "planmäßig" (on schedule): the source hardly knows any delays for them yet

const DAY_END = 24 * 60 - 1;
const HM = /^([01]\d|2[0-3]):[0-5]\d$/;
export const fmtMin = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
/** Does the schedule carry usable commute times (start time and days)? Older routes may lack them. */
const known = (schedule) => !!schedule && HM.test(schedule.departAfter || '') && Array.isArray(schedule.days);

/**
 * End of the window (minutes since midnight) for a start. `until` is missing or unusable: one hour after the start.
 * At least WINDOW_MIN_LEN, at most until 23:59 (there is no window across midnight).
 */
export function untilMin(fromMin, until) {
  const raw = HM.test(until || '') ? toMin(until) : fromMin + WINDOW_DEFAULT_LEN;
  return Math.min(DAY_END, Math.max(raw, fromMin + WINDOW_MIN_LEN));
}

/** Window of a route: { from: 'HH:MM', until: 'HH:MM' } – also for older routes without an end. */
export function windowOf(schedule) {
  const from = toMin(HM.test(schedule?.departAfter || '') ? schedule.departAfter : '07:00');
  return { from: fmtMin(from), until: fmtMin(untilMin(from, schedule?.departUntil)) };
}

/**
 * Where is the route now relative to its commute time?
 *   now   – the window is running
 *   soon  – the window begins later today
 *   done  – the window was earlier today
 *   off   – no commuting on this route today (another weekday), or no times are known
 * anchor: from this point in time (ms) the trains are requested – before the window, but at most ANCHOR_LEAD_MIN before it; otherwise null.
 * endMs: end of the window today (ms), for now and soon.
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

/** Times for a route that has none (so old that it can only concern test data) */
export const DEFAULT_SCHEDULE = { days: ['Mo', 'Di', 'Mi', 'Do', 'Fr'], departAfter: '06:00' };

/** What the route shows to the outside about its commute time: the complete times (also for older routes) and the window with its state. */
export function windowView(schedule, nowMs) {
  const sch = schedule || DEFAULT_SCHEDULE, w = windowOf(sch);
  return { schedule: { ...sch, departUntil: w.until }, window: { from: w.from, until: w.until, mode: windowState(sch, nowMs).mode } };
}

/**
 * May push be sent for this route now? On the route's days from PUSH_LEAD_MIN before the window until PUSH_TAIL_MIN after its end.
 * A route without times (older data) always may.
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

/** Is the departure further away than FAR_MIN? Then ReGo says "planmäßig" instead of "pünktlich". */
export const isFar = (depMs, nowMs) => depMs - nowMs > FAR_MIN * MIN;

/** Order of the routes on the main screen: window running, then the next window today, then the rest. */
export const windowRank = (mode) => (mode === 'now' ? 0 : mode === 'soon' ? 1 : 2);
