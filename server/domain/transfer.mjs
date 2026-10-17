// Routes with one transfer ("Mit 1 Umstieg suchen" – search with 1 transfer).
//
// The source only returns connections that still work in real time – a missed connection would not appear in it at all.
// ReGo therefore rates the connection itself: feeder trips (A) come from the combined search, the connecting trips (B)
// from the transfer station from a second query. Planning follows the timetable, rating follows real time:
//   ok      – the planned connection works (buffer ≥ 3 min or feeder on time)
//   tight   – "Anschluss wackelt" (connection at risk): feeder delayed, buffer under 3 min (or the source no longer counts the connection)
//   missed  – "Anschluss verpasst" (connection missed): buffer ≤ 0 or the connecting trip is cancelled; the next connection is shown
// ReGo picks the transfer anew for every departure.
import { createHash } from 'node:crypto';
import { berlin, hhmm, weekday } from '../lib/time.mjs';
import { lineLabel, lineColor } from '../lib/lines.mjs';
import { cleanStopName } from '../providers/hafas.mjs';
import { classifyRemark, extractMinutes, extractSegment } from './classify.mjs';
import { sampleStops, shortName, findStation, buildMap } from './map.mjs';
import { buildTour, tidyName, localIso, validityLabel, ticketHintFor, appLinkFor, andList, times, sub, okWord, okState, okView, PLATFORM_HORIZON, CANCEL_HORIZON } from './state.mjs';
import { windowView } from './window.mjs';

export const MAX_WAIT_MIN = 30;        // planned wait at the transfer; above it we do not show the trip (unless there would be nothing else)
export const TIGHT_MIN = 3;            // less buffer than this: the connection is at risk
const MCT_MIN = 2, MCT_MAX = 6, MCT_DEFAULT = 4;    // range for the estimated minimum transfer time
const SHOWN = 3;                       // this many departures the route shows (each with its own detail page)
const MIN = 60000;
const CONN_INCIDENTS = 2;              // at most this many connection incidents (at risk/missed) per route

const t = (iso) => Date.parse(iso);
const diffMin = (from, to) => Math.round((t(to) - t(from)) / MIN);
const hash = (s) => createHash('sha1').update(s).digest('hex').slice(0, 8);
const nm = (stop) => tidyName(cleanStopName(stop?.name || ''));
const viaKey = (stop) => shortName(stop?.name || '').toLowerCase();
const keyOf = (l) => `${l.line.name}|${l.plannedDep}`;
const byDep = (x, y) => t(x.dep) - t(y.dep);
const byArr = (x, y) => t(x.arr) - t(y.arr) || t(x.dep) - t(y.dep);
const dur = (m) => { m = Math.max(0, Math.round(m)); const h = Math.floor(m / 60), r = m % 60; return h ? (r ? `${h} Std. ${r} Min.` : `${h} Std.`) : `${r} Min.`; };
const uniq = (list) => { const seen = new Set(); return list.filter((x) => { const k = keyOf(x); if (seen.has(k)) return false; seen.add(k); return true; }); };
const platformChanged = (l) => !!(l && l.plannedPlatform && l.platform && String(l.plannedPlatform) !== String(l.platform));

/** Arrival of the feeder trip at the transfer station (ms): real time; with replacement transport at least planned arrival + the stated extra time. */
function arrivalOf(a) {
  let at = t(a.arr || a.plannedArr);
  for (const r of a.remarks || []) {
    if (classifyRemark(r) !== 'replacement') continue;
    const extra = Math.min(extractMinutes(r.text), 60);
    if (extra) at = Math.max(at, t(a.plannedArr) + extra * MIN);
  }
  return at;
}

function pairsOf(journeys) {
  const out = [];
  for (const j of journeys || []) {
    const legs = (j.legs || []).filter((l) => l && l.line);
    if (legs.length === 1) out.push({ a: legs[0], b: null });
    else if (legs.length === 2) out.push({ a: legs[0], b: legs[1] });     // more than one transfer is not our case
  }
  return out;
}

/**
 * Transfer stations of the connections, most frequent first. stop = stop where the connecting trip departs (for the second query),
 * firstArr = earliest planned arrival of the feeder trip there (ms).
 */
export function transferVias(journeys) {
  const by = new Map();
  for (const { a, b } of pairsOf(journeys)) {
    if (!b) continue;
    const key = viaKey(a.destination);
    if (!by.has(key)) by.set(key, { key, stop: b.origin, name: nm(a.destination), count: 0, firstArr: Infinity });
    const v = by.get(key); v.count++; v.firstArr = Math.min(v.firstArr, t(a.plannedArr));
  }
  return [...by.values()].sort((x, y) => y.count - x.count || x.firstArr - y.firstArr);
}

/**
 * Sample connection for the preview when creating a route: the first one with a transfer and a reasonable wait (otherwise simply the first).
 * With `now` trips that have left already do not count (the route itself leaves them out as well). null = nothing found.
 * today (ms, the real time): a trip on another day than today gets its weekday in front of the time ("Mo ab 07:34").
 */
export function previewRoute(journeys, now = -Infinity, today = now) {
  const pairs = pairsOf(journeys).filter((p) => !p.a.cancelled && !(p.b && p.b.cancelled) && !(t(p.a.dep) < now - 120000));
  if (!pairs.length) return null;
  const two = pairs.filter((p) => p.b);
  const pick = two.find((p) => diffMin(p.a.arr, p.b.dep) <= MAX_WAIT_MIN) || two[0] || pairs[0];
  const legs = [pick.a, pick.b].filter(Boolean);
  const dayOf = (l, k) => (Number.isFinite(today) && berlin(t(l.dep)).date !== berlin(k ? t(legs[0].dep) : today).date ? `${weekday(t(l.dep))} ` : '');
  return {
    duration: dur(diffMin(legs[0].dep, legs[legs.length - 1].arr)),
    ...(pick.b ? { via: nm(pick.a.destination), wait: Math.max(0, diffMin(pick.a.arr, pick.b.dep)) } : {}),
    legs: legs.map((l, k) => ({ lineId: lineLabel(l.line.name), line: l.line.name, color: lineColor(l.line.name, l.line.product), title: `${nm(l.origin)} → ${nm(l.destination)}`, times: `${dayOf(l, k)}ab ${hhmm(l.dep)} · an ${hhmm(l.arr)}` })),
  };
}

/** Key under which the connecting trips of a transfer station are stored in ctx.bLists */
export const viaKeyOf = viaKey;

// ---------- "Schneller mit 1 Umstieg" (faster with 1 transfer) for replacement transport ----------
export const SHORTCUT_MIN_SAVING = 5;                 // this many minutes earlier at the destination, otherwise the hint is not worth the space
const SHORTCUT_LATER = 30 * MIN;                      // the detour may depart up to this much later than the trip with replacement transport
const hasReplacement = (leg, now) => (leg.remarks || []).some((r) => classifyRemark(r) === 'replacement' && !(r.validUntil && t(r.validUntil) < now));

/**
 * If a trip has replacement transport and therefore arrives later, there is sometimes a connection with one transfer that is earlier at the destination.
 * The one with the earliest arrival among the safe ones is chosen: connection with at least TIGHT_MIN minutes of buffer, nothing cancelled,
 * no replacement transport on the two trips, still reachable (not before now) and at most 30 min after the trip with replacement transport.
 * The gain must be at least SHORTCUT_MIN_SAVING minutes. Plain direct trips in the list do not count (the incident already shows those as "Ohne Ersatzverkehr", without replacement transport).
 * @param journeys connections with at most one transfer
 * @param o        { now, depart (ms: departure of the trip with replacement transport), arrive (ms: its arrival with replacement transport) }
 * @returns card for the incident { title, line1, line2, line3, badge, saved, via } or null
 */
export function shortcutFor(journeys, { now, depart, arrive }) {
  if (!Number.isFinite(depart) || !Number.isFinite(arrive)) return null;
  let best = null;
  for (const { a, b } of pairsOf(journeys)) {
    if (!b || a.cancelled || b.cancelled || hasReplacement(a, now) || hasReplacement(b, now)) continue;
    const dep = t(a.dep), arr = t(b.arr);
    if (!(dep >= now - MIN) || dep > depart + SHORTCUT_LATER) continue;
    const buffer = diffMin(a.arr, b.dep);
    if (!(buffer >= TIGHT_MIN)) continue;                                      // a tight connection is no recommendation
    const saved = Math.round((arrive - arr) / MIN);
    if (!(saved >= SHORTCUT_MIN_SAVING)) continue;
    if (!best || arr < best.arr || (arr === best.arr && dep < best.dep)) best = { a, b, dep, arr, saved, buffer };
  }
  if (!best) return null;
  const via = nm(best.a.destination);
  return {
    title: 'Schneller mit 1 Umstieg',
    line1: `${best.a.line.name} › ${best.b.line.name} ab ${hhmm(best.a.dep)}`,
    line2: `Umstieg ${via} · ${best.buffer} Min.`,
    line3: `An ${hhmm(best.b.arr)} statt ${hhmm(arrive)}`,
    badge: `−${best.saved} Min.`,
    saved: best.saved, via,
  };
}

/**
 * Rates all feeder trips. Result per trip:
 *   { kind:'transfer', a, plan, next, after, state, buffer, plannedGap, cancelledB, aArr, aLate, bs, cands }
 *   { kind:'direct', a } (direct trip, if the source returns one)   { kind:'cancelledA', a }
 */
function entriesOf(journeys, bLists) {
  const pairs = pairsOf(journeys);
  const byA = new Map();
  for (const p of pairs) {
    const k = keyOf(p.a);
    if (!byA.has(k)) byA.set(k, { a: p.a, bs: [] });
    if (p.b) byA.get(k).bs.push(p.b);
  }
  // Estimate the minimum transfer time: the smallest planned gap among pairs the source suggests without any delay.
  // Downwards this is only an upper bound (the pairs found are often much further apart), hence at most 6 min:
  // better to rate a connection as too tight than not to report a missed one at all.
  const gaps = pairs.filter((p) => p.b && !p.b.cancelled && t(p.a.arr) <= t(p.a.plannedArr) && t(p.b.dep) <= t(p.b.plannedDep)).map((p) => diffMin(p.a.plannedArr, p.b.plannedDep)).filter((g) => Number.isFinite(g));
  const mct = gaps.length ? Math.min(MCT_MAX, Math.max(MCT_MIN, Math.min(...gaps))) : MCT_DEFAULT;

  const out = [];
  for (const { a, bs } of byA.values()) {
    if (a.cancelled) { out.push({ kind: 'cancelledA', a }); continue; }
    if (!bs.length) { out.push({ kind: 'direct', a }); continue; }
    const bList = bLists?.get(viaKey(a.destination)) || null;
    const aArr = arrivalOf(a);
    const aLate = aArr - t(a.plannedArr) >= MIN;
    const cands = uniq([...bs, ...(bList || [])]);
    const real = [...bs].filter((b) => !b.cancelled).sort(byArr)[0] || [...bs].sort(byArr)[0];   // the connection the source suggests now
    // The planned connection is the one the timetable foresaw: earliest scheduled arrival among the trips with enough planned gap.
    const planned = bList && bList.length
      ? cands.filter((b) => diffMin(a.plannedArr, b.plannedDep) >= mct).sort((x, y) => t(x.plannedArr) - t(y.plannedArr) || t(x.plannedDep) - t(y.plannedDep))[0] || null
      : null;
    let plan = real;
    if (planned && keyOf(planned) !== keyOf(real) && t(real.arr) > t(planned.plannedArr)) {
      // Feeder delayed: the source has already switched to a later connection. Feeder on time: only cancelled connections
      // count, otherwise the source's suggestion applies (it knows the station's real transfer time).
      if (aLate || planned.cancelled) plan = planned;
    }
    const buffer = Math.round((t(plan.dep) - aArr) / MIN);
    const plannedGap = diffMin(a.plannedArr, plan.plannedDep);
    // Wait for the selection (MAX_WAIT_MIN at most): delayed feeder without timetable comparison -> the actual wait counts as well
    const filterWait = aLate ? (planned ? diffMin(a.plannedArr, planned.plannedDep) : Math.min(plannedGap, buffer)) : plannedGap;
    const cancelledB = !!plan.cancelled;
    const dropped = !bs.some((b) => keyOf(b) === keyOf(plan));
    let state = 'ok';
    if (cancelledB || buffer <= 0) state = 'missed';
    else if (aLate && (dropped || (buffer < TIGHT_MIN && buffer < plannedGap))) state = 'tight';

    const usable = (b) => !b.cancelled && keyOf(b) !== keyOf(plan);
    let next = null, after = null;
    if (state === 'missed') {
      next = (real && usable(real) ? real : null)
        || cands.filter((b) => usable(b) && t(b.dep) - aArr >= Math.max(mct, TIGHT_MIN) * MIN).sort(byDep)[0] || null;
    } else if (state === 'tight') {
      after = (real && usable(real) ? real : null)
        || cands.filter((b) => usable(b) && t(b.dep) > t(plan.dep) && t(b.dep) - aArr >= Math.max(mct, TIGHT_MIN) * MIN).sort(byDep)[0] || null;
    }
    const shownB = state === 'missed' ? next : plan;        // the connecting trip with which one actually arrives
    out.push({ kind: 'transfer', a, plan, next, after, state, buffer, plannedGap, filterWait, cancelledB, aArr, aLate, bs, cands, shownB, finalArr: shownB ? t(shownB.arr) : null, hasBList: !!(bList && bList.length), mct });
  }
  return out;
}

/** Route without a departure: say honestly why – never "pünktlich" (on time). */
function noEntriesView(tour, stale, cancelled, staleNote) {
  const [big, sub2] = stale ? ['Keine Daten', staleNote || 'Die Fahrplanquelle antwortet gerade nicht. ReGo versucht es weiter.']
    : cancelled ? ['Fällt aus', 'Die nächsten Fahrten fallen aus.']
      : ['Keine', 'Keine Verbindung mit höchstens 1 Umstieg gefunden.'];
  const stations = [tour.from, tour.to].map((s) => ({ id: s.id, name: shortName(s.name) }));
  return { kind: 'none', head: 'Nächste Abfahrt', big, sub: sub2, rows: [], alternative: null, ticketHint: null, map: { stations, hubIndex: -1, haloIndex: -1, connections: [], disrupted: { from: 0, to: 1 }, alternative: null } };
}

/**
 * @param tour     profile route with transfers: 1
 * @param journeys normalized connections of the combined search (feeder + connecting trip, or direct trip)
 * @param ctx      as for buildTour; additionally bLists: Map(transfer station → connecting trips from there), may be missing
 * @returns { tour, incidents }
 */
export async function buildTransferTour(tour, journeys, ctx) {
  // If there are only direct trips by now (the source no longer suggests a transfer), the usual rules apply, including all incidents
  if ((journeys || []).length && journeys.every((j) => (j.legs || []).filter((l) => l && l.line).length === 1)) return buildTour(tour, journeys, ctx);
  const { now, minDelay, linesAt, lines } = ctx;
  const bLists = ctx.bLists || new Map();
  const registerLine = (l) => {
    const id = lineLabel(l.name);
    if (!lines[id]) lines[id] = { id, label: id, color: lineColor(l.name, l.product) };
    return id;
  };
  const dest = tidyName(tour.to.name);
  const hint = ticketHintFor(tour);

  const all = entriesOf(journeys, bLists).filter((e) => !(t(e.a.dep) < now - 120000)).sort((x, y) => byDep(x.a, y.a));
  // Before and during the commute window only the trips up to its end count (only if something runs in it). The "Danach" (then) card may still look past the window.
  const win = ctx.window;
  const scoped = win && (win.mode === 'now' || win.anchor) && win.endMs ? all.filter((e) => t(e.a.plannedDep || e.a.dep) <= win.endMs) : null;
  const inScope = scoped && scoped.some((e) => e.kind !== 'cancelledA') ? scoped : all;
  const cancelledAs = inScope.filter((e) => e.kind === 'cancelledA' && t(e.a.plannedDep) >= now && t(e.a.plannedDep) <= now + CANCEL_HORIZON);
  const usable = (src) => { const l = src.filter((e) => e.kind !== 'cancelledA'); const ok = l.filter((e) => e.kind !== 'transfer' || e.filterWait <= MAX_WAIT_MIN); return ok.length ? ok : l; };   // long waits only if there is nothing else
  const listAll = usable(all);
  const list = inScope === all ? listAll : usable(inScope);
  const after = (e) => listAll[listAll.indexOf(e) + 1];
  const shown = list.slice(0, SHOWN);

  const first = shown.find((e) => e.kind === 'transfer');
  const viaCount = new Map();
  for (const e of list) if (e.kind === 'transfer') { const k = nm(e.a.destination); viaCount.set(k, (viaCount.get(k) || 0) + 1); }
  const via = [...viaCount.entries()].sort((x, y) => y[1] - x[1])[0]?.[0] || '';

  const out = {
    id: tour.id, name: tidyName(tour.name), appLink: appLinkFor(tour), lineId: shown[0] ? registerLine(shown[0].a.line) : '', active: tour.active !== false,
    transfers: 1, ...(via ? { via } : {}), ...(first ? { lineIds: [registerLine(first.a.line), registerLine((first.shownB || first.plan).line)] } : {}),
    period: tour.period || 'am', ...(tour.returnId ? { returnId: tour.returnId } : {}), ...(tour.returnOf ? { returnOf: tour.returnOf } : {}),
    distanceKm: ctx.distanceKm ?? null,
    ...windowView(tour.schedule || { days: ['Mo', 'Di', 'Mi', 'Do', 'Fr'], departAfter: '06:00' }, now),
    departures: [],
  };
  const incidents = [];

  // ---------- Helpers for the texts ----------
  const jump = (e) => { const i = shown.indexOf(e); return i >= 0 ? { departure: i } : {}; };
  const chipsOf = (e) => (e.kind === 'transfer' ? `${e.a.line.name} › ${(e.shownB || e.plan).line.name}` : e.a.line.name);
  const delayOf = (e) => Math.max(e.a.depDelay || 0, e.kind === 'transfer' ? Math.round((e.aArr - t(e.a.plannedArr)) / MIN) : (e.a.arrDelay || 0));
  // With a transfer both trips need real-time data before we say "pünktlich"
  const stOf = (e) => okState(now, e.a, ...(e.kind === 'transfer' ? [e.shownB || e.plan] : []));
  const badgeOf = (e) => (e.state === 'tight' ? 'wackelt' : e.state === 'missed' ? 'verpasst' : e.a.depDelay >= minDelay ? `+${e.a.depDelay} Min.` : stOf(e).word);
  const arrOf = (e) => (e.kind === 'transfer' ? e.finalArr : t(e.a.arr));
  const thenCard = (e, title = 'Danach') => (e ? { title, line1: `${chipsOf(e)} ab ${hhmm(e.a.dep)}`, line2: arrOf(e) ? `An ${dest} ${hhmm(arrOf(e))}` : 'Kein Anschluss gefunden', badge: badgeOf(e), ...jump(e) } : null);
  const afterCard = (alt) => (alt ? { title: 'Nächster Anschluss', line1: `${alt.line.name} ab ${hhmm(alt.dep)}${alt.platform ? ` · Gleis ${alt.platform}` : ''}`, line2: `An ${dest} ${hhmm(alt.arr)}`, badge: alt.depDelay >= minDelay ? `+${alt.depDelay} Min.` : okWord(alt, now) } : null);
  // "Bus an 07:41" (bus arriving 07:41) only if the replacement transport reaches the transfer station (the segment from the remark ends there)
  const busAtHub = (e) => {
    const st = stopsOf(e.a), hub = st.length - 1;
    return (e.a.remarks || []).some((r) => { if (classifyRemark(r) !== 'replacement') return false; const seg = extractSegment(r.text); return !!seg && [findStation(st, seg[0]), findStation(st, seg[1])].includes(hub); });
  };

  // ---------- Rows and sections of the detail page ----------
  const row = (label, sub2, value, planned = '', extra = {}) => ({ label, sub: sub2, value, planned, ...extra });
  const rowsA = (e, arrSub) => {
    const a = e.a, viaName = nm(a.destination);
    const rows = [];
    if (platformChanged(a)) rows.push(row('Gleiswechsel', `jetzt Gleis ${a.platform}, sonst Gleis ${a.plannedPlatform}`, `Gl. ${a.platform}`, `Gl. ${a.plannedPlatform}`));      // before the departure it belongs to
    rows.push(row(`Abfahrt ${nm(a.origin)}`, sub(a), hhmm(a.dep), hhmm(a.plannedDep) !== hhmm(a.dep) ? hhmm(a.plannedDep) : ''));
    rows.push(row(`Ankunft ${viaName}`, arrSub || `${a.line.name}${a.arrPlatform ? ` · Gleis ${a.arrPlatform}` : ''}`, hhmm(e.aArr), hhmm(e.aArr) !== hhmm(a.plannedArr) ? hhmm(a.plannedArr) : ''));
    return rows;
  };
  const rowsB = (e) => {
    const plan = e.plan, viaName = nm(e.a.destination);
    if (e.state === 'missed') {
      const n = e.next;
      if (!n) return [row(`Abfahrt ${viaName}`, e.cancelledB ? `${plan.line.name} · fällt aus` : `${plan.line.name} · schon weg`, e.cancelledB ? 'entfällt' : 'verpasst', hhmm(plan.plannedDep))];
      const rows = [];
      if (platformChanged(n)) rows.push(row('Gleiswechsel', `jetzt Gleis ${n.platform}, sonst Gleis ${n.plannedPlatform}`, `Gl. ${n.platform}`, `Gl. ${n.plannedPlatform}`));
      rows.push(row(`Abfahrt ${viaName}`, sub(n), hhmm(n.dep), hhmm(plan.plannedDep), { plannedLabel: 'statt' }));
      rows.push(row(`Ankunft ${dest}`, n.line.name, hhmm(n.arr), hhmm(plan.plannedArr), { plannedLabel: 'statt' }));
      return rows;
    }
    const rows = [];
    if (platformChanged(plan)) rows.push(row('Gleiswechsel', `jetzt Gleis ${plan.platform}, sonst Gleis ${plan.plannedPlatform}`, `Gl. ${plan.platform}`, `Gl. ${plan.plannedPlatform}`));
    rows.push(row(`Abfahrt ${viaName}`, sub(plan), hhmm(plan.dep), hhmm(plan.plannedDep) !== hhmm(plan.dep) ? hhmm(plan.plannedDep) : ''));
    rows.push(row(`Ankunft ${dest}`, plan.line.name, hhmm(plan.arr), plan.arrDelay ? hhmm(plan.plannedArr) : ''));
    return rows;
  };
  const transferCard = (e) => {
    const a = e.a, plan = e.plan, viaName = nm(a.destination);
    const word = busAtHub(e) ? 'Bus' : a.line.name;
    const cancelled = e.state === 'missed' && e.cancelledB;
    const base = e.state === 'missed'
      ? (cancelled ? `${plan.line.name} ab ${hhmm(plan.plannedDep)} fällt aus` : `${word} an ${hhmm(e.aArr)} · ${plan.line.name} ${hhmm(plan.dep)} weg`)
      : `${word} an ${hhmm(e.aArr)} · ${plan.line.name} ab ${hhmm(plan.dep)}`;
    const platforms = a.arrPlatform && plan.platform ? `Gleis ${a.arrPlatform} → Gleis ${plan.platform}` : '';
    const minutes = e.state === 'missed' ? (e.next ? Math.round((t(e.next.dep) - e.aArr) / MIN) : 0) : e.buffer;
    return {
      type: 'transfer', state: e.state,
      label: e.state === 'ok' ? 'Umstieg' : e.state === 'tight' ? 'Anschluss wackelt' : cancelled ? 'Anschluss fällt aus' : 'Anschluss verpasst',
      title: e.state === 'ok' ? viaName : `Umstieg ${viaName}`,
      text: e.state === 'ok' && platforms && !busAtHub(e) ? platforms : base,
      minutes,
    };
  };
  const sectionsOf = (e, arrSub) => {
    const a = e.a, b = e.shownB || e.plan, viaName = nm(a.destination);
    return [
      { type: 'leg', lineId: registerLine(a.line), title: `${nm(a.origin)} → ${viaName}`, sub: `1. Fahrt · ${dur((e.aArr - t(a.dep)) / MIN)}`, rows: rowsA(e, arrSub) },
      transferCard(e),
      { type: 'leg', lineId: registerLine(b.line), title: `${viaName} → ${dest}`, sub: `2. Fahrt · ${dur((t(b.arr) - t(b.dep)) / MIN)}`, rows: rowsB(e) },
    ];
  };

  // ---------- Karte ----------
  const stopsOf = (leg) => { const so = (leg.stopovers || []).filter((s) => s && s.name); return so.length >= 2 ? so : [leg.origin, leg.destination]; };
  function transferMap(e, { halo = '', segment = null } = {}) {
    const a = e.a, b = e.shownB || e.plan;
    const sa = stopsOf(a).slice(), sb = stopsOf(b).slice();
    if (viaKey(sa[sa.length - 1]) !== viaKey(a.destination)) sa.push(a.destination);
    if (viaKey(sb[0]) !== viaKey(b.origin)) sb.unshift(b.origin);
    const hub = sa.length - 1;
    const stops = [...sa, ...sb.slice(1)];
    let segIdx = null;
    if (segment) {
      const x = findStation(stops, segment[0]), y = findStation(stops, segment[1]);
      if (x >= 0 && y >= 0 && x !== y) { const lo = Math.min(x, y), hi = Math.max(x, y); if (!(lo < hub && hi > hub)) segIdx = [lo, hi]; }
    }
    const idx = sampleStops(stops, [hub, ...(segIdx || [])]);
    const stations = idx.map((i) => ({ id: stops[i].id, name: shortName(stops[i].name) }));
    const hubIndex = idx.indexOf(hub), last = stations.length - 1;
    const skips = [];
    for (let k = 0; k < idx.length - 1; k++) { const hidden = idx[k + 1] - idx[k] - 1; if (hidden >= 2) skips.push({ after: k, n: hidden }); }
    const label = e.state === 'missed' ? (e.cancelledB ? 'Anschluss fällt aus' : 'Anschluss verpasst')
      : e.state === 'tight' ? `Umstieg nur noch ${e.buffer} Min.`
        : `Umstieg ${e.buffer} Min.${e.plan.platform ? ` · Gleis ${e.plan.platform}` : ''}`;
    const disrupted = segIdx ? { from: idx.indexOf(segIdx[0]), to: idx.indexOf(segIdx[1]) } : null;
    return {
      stations, hubIndex, haloIndex: halo === 'hub' ? hubIndex : halo === 'start' ? 0 : -1, connections: [],
      disrupted: disrupted && disrupted.from >= 0 && disrupted.to >= 0 ? disrupted : null, alternative: null,
      legs: [{ lineId: registerLine(a.line), from: 0, to: hubIndex }, { lineId: registerLine(b.line), from: hubIndex, to: last }],
      skips, transfer: { stationIndex: hubIndex, label, state: e.state },
      // depLate/arrLate: the time pill turns colored when the departure is delayed or the arrival at the destination is later than planned
      times: {
        dep: `ab ${hhmm(a.dep)}`, arr: e.finalArr ? `an ${hhmm(e.finalArr)}` : '',
        depLate: a.depDelay >= minDelay, arrLate: !!e.finalArr && e.finalArr - t(e.plan.plannedArr) >= minDelay * MIN,
      },
    };
  }

  // ---------- View per departure ----------
  async function viewOf(e, k) {
    const nxt = after(e);
    if (e.kind === 'direct') {
      const l = e.a, isLate = l.depDelay >= minDelay;
      const rows = [row(`Abfahrt ${nm(l.origin)}`, sub(l), hhmm(l.dep), hhmm(l.plannedDep) !== hhmm(l.dep) ? hhmm(l.plannedDep) : ''), row(`Ankunft ${dest}`, l.line.name, hhmm(l.arr), l.arrDelay ? hhmm(l.plannedArr) : '')];
      const what = `${l.line.name} ab ${hhmm(l.dep)}`;
      return { kind: isLate ? 'delay' : 'ok', ...(isLate ? { head: `Verspätung · ${what}`, big: `+${l.depDelay} Min.`, sub: sub(l, false) } : okView(stOf(e), what, sub(l, false))), rows, alternative: thenCard(nxt), ticketHint: hint, map: await buildMap(l, linesAt, { halo: isLate, registerLine }) };
    }
    const { a, plan, next, state } = e;
    const viaName = nm(a.destination), delay = delayOf(e), bShown = e.shownB || plan;
    const sections = sectionsOf(e);
    const base = { rows: sections.flatMap((s) => s.rows || []), sections, ticketHint: hint };
    const lateB = state === 'ok' && !(a.depDelay >= minDelay) && plan.depDelay >= minDelay;
    e.lateKind = state === 'ok' ? (a.depDelay >= minDelay ? 'a' : lateB ? 'b' : '') : '';
    if (state === 'missed') {
      return { kind: 'missed', head: `Anschluss · ${plan.line.name} ab ${hhmm(e.cancelledB ? plan.plannedDep : plan.dep)}`, big: e.cancelledB ? 'Fällt aus' : 'Verpasst',
        sub: next ? `Nächster ${next.line.name} ab ${hhmm(next.dep)}, Ankunft ${hhmm(next.arr)}` : 'Kein weiterer Anschluss in den nächsten Stunden',
        ...base, alternative: thenCard(nxt, nxt && arrOf(nxt) && e.finalArr && hhmm(arrOf(nxt)) === hhmm(e.finalArr) ? 'Danach · gleiche Ankunft' : nxt && arrOf(nxt) && e.finalArr && arrOf(nxt) < e.finalArr ? 'Danach · früher am Ziel' : 'Danach'),
        map: transferMap(e, { halo: 'hub' }) };
    }
    if (state === 'tight') {
      return { kind: 'tight', head: `Verspätung · ${a.line.name} ab ${hhmm(a.dep)}`, big: `+${delay} Min.`, sub: `Anschluss in ${viaName} wackelt`,
        ...base, alternative: afterCard(e.after) || thenCard(nxt), map: transferMap(e, { halo: 'hub' }) };
    }
    if (e.lateKind === 'a') {
      return { kind: 'delay', head: `Verspätung · ${a.line.name} ab ${hhmm(a.dep)}`, big: `+${a.depDelay} Min.`, sub: `Anschluss in ${viaName} bleibt erreichbar`,
        ...base, alternative: thenCard(nxt), map: transferMap(e, { halo: 'start' }) };
    }
    if (e.lateKind === 'b') {
      return { kind: 'delay', head: `Verspätung · ${plan.line.name} ab ${hhmm(plan.dep)}`, big: `+${plan.depDelay} Min.`, sub: `Umstieg ${viaName} · Ankunft ${hhmm(plan.arr)}`,
        ...base, alternative: thenCard(nxt), map: transferMap(e, { halo: 'hub' }) };
    }
    return { kind: 'ok', ...okView(stOf(e), `${chipsOf(e)} ab ${hhmm(a.dep)}`, `Ankunft ${dest} ${hhmm(bShown.arr)} · 1 Umstieg`),
      ...base, alternative: thenCard(nxt), map: transferMap(e) };
  }

  for (let k = 0; k < shown.length; k++) {
    const e = shown[k], a = e.a;
    e.view = await viewOf(e, k);
    out.departures.push({
      plannedTime: hhmm(a.plannedDep), expectedTime: hhmm(a.dep), lineId: registerLine(a.line),
      plannedPlatform: a.plannedPlatform || '', expectedPlatform: a.platform || '', delayMin: a.depDelay,
      ...(berlin(t(a.dep)).date !== berlin(now).date ? { nextDay: true } : {}),
      ...(stOf(e).plan ? { far: true } : {}),                 // "planmäßig" instead of "pünktlich" (far away, or no real-time data; older apps only know this flag)
      ...(stOf(e).unconfirmed ? { noRt: true } : {}),         // near, but no real-time data: newer apps show it neutral
      ...(e.kind === 'transfer' ? {
        lineIds: [registerLine(a.line), registerLine((e.shownB || e.plan).line)],
        arrTime: e.finalArr ? hhmm(e.finalArr) : '',
        transfer: {
          station: nm(a.destination), minutes: e.state === 'missed' ? (e.next ? Math.round((t(e.next.dep) - e.aArr) / MIN) : 0) : e.buffer, state: e.state,
          text: e.state === 'ok' ? `Umstieg ${nm(a.destination)} · ${e.buffer} Min.` : e.state === 'tight' ? `Umstieg nur noch ${e.buffer} Min.` : e.cancelledB ? 'Anschluss fällt aus' : 'Anschluss verpasst',
        },
      } : { lineIds: [registerLine(a.line)], arrTime: hhmm(a.arr) }),
      view: e.view,
    });
  }

  // ---------- Incidents ----------
  // 0) Cancellations of the feeder trip
  const byLine = new Map();
  for (const e of cancelledAs) { const n = e.a.line.name; if (!byLine.has(n)) byLine.set(n, []); byLine.get(n).push(e.a); }
  for (const group of [...byLine.values()].slice(0, 2)) {
    const c = group[0], lastC = group[group.length - 1], many = group.length > 1;
    const alt = listAll.find((e) => t(e.a.plannedDep) > t(c.plannedDep));
    incidents.push({
      id: `i${hash(`${tour.id}|cancelled|${c.line.name}|${berlin(t(c.plannedDep)).date}`)}`, tourId: tour.id, kind: 'cancelled', severity: 3, delayMin: 0, lineName: c.line.name, count: group.length,
      validity: { label: validityLabel(now, t(lastC.plannedDep), now), activeNow: true, from: localIso(now), until: localIso(t(lastC.plannedDep)) },
      title: `${c.line.name} ${nm(c.origin)} → ${nm(c.destination)}`,
      summary: `${many ? 'Fahrten' : 'Fahrt'} um ${andList(times(group.map((l) => hhmm(l.plannedDep))))} ${many ? 'fallen' : 'fällt'} aus`,
      view: {
        kind: 'cancelled', head: `Ausfall · ${c.line.name} ab ${hhmm(c.plannedDep)}`, big: 'Fällt aus',
        sub: alt ? `Stattdessen: ${chipsOf(alt)} ab ${hhmm(alt.a.dep)}` : 'Keine weitere Fahrt in den nächsten Stunden',
        rows: [row(`Abfahrt ${nm(c.origin)}`, sub(c), 'entfällt', hhmm(c.plannedDep)), row(`Ankunft ${nm(c.destination)}`, c.line.name, 'entfällt', hhmm(c.plannedArr))],
        alternative: alt ? { ...thenCard(alt, 'Stattdessen') } : null, ticketHint: hint,
        map: await buildMap(c, linesAt, { segment: [c.origin.name, c.destination.name], registerLine }),
      },
    });
  }

  // 1) Connection at risk / missed
  let conn = 0;
  for (const e of shown) {
    if (e.kind !== 'transfer' || (e.state !== 'tight' && e.state !== 'missed') || conn >= CONN_INCIDENTS) continue;
    conn++;
    const { a, plan, next, state } = e;
    const word = busAtHub(e) ? 'Bus' : a.line.name;
    const until = state === 'tight' ? t(plan.dep) : t((next || plan).dep);
    const summary = state === 'tight'
      ? `Umstieg nur noch ${e.buffer} Min. (${word} an ${hhmm(e.aArr)}, ${plan.line.name} ab ${hhmm(plan.dep)})`
      : e.cancelledB
        ? `${plan.line.name} ab ${hhmm(plan.plannedDep)} fällt aus. ${next ? `Nächster ${next.line.name} ab ${hhmm(next.dep)}` : 'Kein weiterer Anschluss gefunden'}`
        : `${word} an ${hhmm(e.aArr)}, ${plan.line.name} ${hhmm(plan.dep)} weg. ${next ? `Nächster ${next.line.name} ab ${hhmm(next.dep)}` : 'Kein weiterer Anschluss gefunden'}`;
    incidents.push({
      id: `i${hash(`${tour.id}|${state}|${keyOf(a)}|${keyOf(plan)}`)}`, tourId: tour.id, kind: state, severity: state === 'missed' ? 3 : 2, delayMin: delayOf(e), lineName: plan.line.name,
      validity: { label: validityLabel(now, until, now), activeNow: true, from: localIso(now), until: localIso(until) },
      title: `${plan.line.name} ${nm(plan.origin)} → ${nm(plan.destination)}`, summary, view: e.view,
    });
  }

  // 2) Replacement transport, construction – once per text, on both trips
  const seen = new Set();
  for (const e of shown) {
    if (e.kind !== 'transfer') continue;
    for (const leg of [e.a, e.plan, e.next].filter(Boolean)) for (const r of leg.remarks || []) {
      const kind = classifyRemark(r);
      if (kind === 'other') continue;
      const key = `${kind}|${r.summary}|${r.validUntil}`;
      if (seen.has(key)) continue; seen.add(key);
      const from = r.validFrom ? t(r.validFrom) : now;
      const until = r.validUntil ? t(r.validUntil) : now + 24 * 3600e3;
      if (until < now) continue;
      const delay = extractMinutes(r.text), seg = extractSegment(r.text);
      const label = validityLabel(from, until, now);
      const onA = leg === e.a;
      const st = stopsOf(leg), sx = seg ? findStation(st, seg[0]) : -1, sy = seg ? findStation(st, seg[1]) : -1;
      const where = sx >= 0 && sy >= 0 && sx !== sy ? `${nm(st[Math.min(sx, sy)])} → ${nm(st[Math.max(sx, sy)])}` : `${nm(leg.origin)} → ${nm(leg.destination)}`;
      const suffix = onA ? { ok: ' · Anschluss bleibt erreichbar', tight: ' · Anschluss wackelt', missed: ' · Anschluss verpasst' }[e.state] : '';
      const sections = sectionsOf(e, onA ? `${e.a.line.name} · ${r.summary || 'Hinweis'}` : undefined);
      const alt = listAll.find((x) => x !== e && x.kind === 'transfer' && ![x.a, x.plan, x.next].some((l) => l && (l.remarks || []).some((y) => classifyRemark(y) === kind)));
      incidents.push({
        id: `i${hash(`${tour.id}|${key}`)}`, tourId: tour.id, kind, severity: kind === 'replacement' ? 3 : delay >= 10 ? 2 : 1, delayMin: delay, lineName: leg.line.name,
        validity: { label, activeNow: from <= now && now <= until, from: localIso(from), until: localIso(until) },
        title: `${leg.line.name} ${nm(leg.origin)} → ${nm(leg.destination)}`,
        summary: r.summary || (kind === 'replacement' ? 'Ersatzverkehr' : 'Baustelle'),
        view: {
          kind, head: `${kind === 'replacement' ? 'Ersatzverkehr' : 'Baustelle'} · ${label}`,
          big: delay ? `+${delay} Min.` : 'Hinweis', sub: kind === 'replacement' ? `Statt ${leg.line.name} fährt Ersatzverkehr · ${where}${suffix}` : `${leg.line.name} ${where}${suffix}`,
          rows: sections.flatMap((s) => s.rows || []), sections, alternative: alt ? thenCard(alt, kind === 'replacement' ? 'Ohne Ersatzverkehr' : 'Danach') : null, ticketHint: hint,
          map: transferMap(e, { segment: seg }),
        },
      });
    }
  }

  // 3) Delay (feeder or connecting trip), unless the connection already has an incident of its own
  const late = shown.find((e) => e.kind === 'transfer' && e.lateKind);
  if (late) {
    const leg = late.lateKind === 'a' ? late.a : late.plan, n = leg.depDelay;
    const reason = (leg.remarks || []).find((r) => classifyRemark(r) === 'other')?.summary;
    incidents.push({
      id: `i${hash(`${tour.id}|delay|${leg.line.name}|${berlin(t(leg.plannedDep)).date}|${hhmm(leg.plannedDep)}`)}`, tourId: tour.id, kind: 'delay', severity: n >= 10 ? 3 : n >= 5 ? 2 : 1, delayMin: n, lineName: leg.line.name,
      validity: { label: 'heute', activeNow: true, from: localIso(now), until: localIso(t(leg.dep)) },
      title: `${leg.line.name} ${nm(leg.origin)} → ${nm(leg.destination)}`, summary: reason || `${n} Min. später`, view: late.view,
    });
  }

  // 4) Platform change (feeder, and at the transfer the connecting trip): its own quiet incident, only shortly before departure
  let platforms = 0;
  for (const e of shown) {
    if (e.kind !== 'transfer' || t(e.a.dep) > now + PLATFORM_HORIZON) continue;
    for (const leg of [e.a, e.shownB || e.plan]) {
      if (platforms >= 2) break;
      if (!platformChanged(leg) || e === late || e.state !== 'ok') continue;
      platforms++;
      const atHub = leg !== e.a;
      incidents.push({
        id: `i${hash(`${tour.id}|platform|${leg.line.name}|${berlin(t(leg.plannedDep)).date}|${hhmm(leg.plannedDep)}`)}`, tourId: tour.id, kind: 'platform', severity: 1, delayMin: 0, lineName: leg.line.name, platform: String(leg.platform),
        validity: { label: validityLabel(now, t(leg.dep), now), activeNow: true, from: localIso(now), until: localIso(t(leg.dep)) },
        title: `${leg.line.name} ${nm(leg.origin)} → ${nm(leg.destination)}`, summary: `${hhmm(leg.dep)}${atHub ? ` in ${nm(leg.origin)}` : ''} jetzt Gleis ${leg.platform} statt Gleis ${leg.plannedPlatform}`,
        view: { ...e.view, kind: 'platform', head: `Gleiswechsel · ${leg.line.name} ab ${hhmm(leg.dep)}`, big: `Gl. ${leg.platform}`, sub: `statt Gleis ${leg.plannedPlatform}`, alternative: null },
      });
    }
  }

  // No incident: "pünktlich" view on the route itself; without a departure an honest explanation
  if (!shown.length) out.view = noEntriesView(tour, ctx.stale, all.some((e) => e.kind === 'cancelledA'), ctx.staleNote);
  else if (!incidents.length) out.view = shown[0].view;
  return { tour: out, incidents };
}
