// Routes whose connection needs two transfers – the fallback behind "with transfers".
//
// A route with transfers first looks for connections with at most one transfer (transfer.mjs). Only when there is none to come – typically while a closure
// forces a second change, like the weeks of work on the Stammstrecke – ReGo asks the source for connections with up to two transfers and shows those:
// a chain of up to three trips.
//
// The source only returns connections that work in real time, and nothing is looked up at the transfer stations (no second query), so the rating is simpler
// than for one transfer: it follows what the source delivers.
//   ok      – the planned connection works
//   tight   – "Anschluss wackelt" (connection at risk): the trip before is late and the buffer has shrunk below TIGHT_MIN
//   missed  – "Anschluss verpasst" (connection missed): buffer ≤ 0 (e.g. replacement transport takes longer) or the next trip is cancelled
// Direct trips and trips with one transfer that come with the same answer are shown with the same rules.
import { createHash } from 'node:crypto';
import { berlin, hhmm, weekday } from '../lib/time.mjs';
import { lineLabel, lineColor } from '../lib/lines.mjs';
import { classifyRemark, extractMinutes, extractSegment, arrivalOf } from './classify.mjs';
import { sampleStops, shortName, findStation, buildMap } from './map.mjs';
import { tidyName, localIso, validityLabel, ticketHintFor, appLinkFor, andList, times, sub, okState, okView, PLATFORM_HORIZON, CANCEL_HORIZON } from './state.mjs';
import { windowView } from './window.mjs';
import { nm, dur, diffMin, platformChanged, keyOf, noEntriesView, MAX_WAIT_MIN, TIGHT_MIN, SHOWN } from './transfer.mjs';

export const MAX_CHAIN = 3;             // trips in a chain: two transfers at most
const MIN = 60000;
const CONN_INCIDENTS = 2;               // at most this many connection incidents (at risk/missed) per route
const GONE_MS = 120000;                 // a trip counts as gone this long after its departure (same limit as the routes use)

const t = (iso) => Date.parse(iso);
const hash = (s) => createHash('sha1').update(s).digest('hex').slice(0, 8);
const viaKey = (stop) => shortName(stop?.name || '').toLowerCase();
const legsOf = (j) => (j?.legs || []).filter((l) => l && l.line);
const rank = { ok: 0, tight: 1, missed: 2 };
const changeWord = (n) => (n === 1 ? '1 Umstieg' : `${n} Umstiege`);

/** Trips of the answer as chains of 1 to MAX_CHAIN trips (every chain: the trips one after the other). */
export function chainsOf(journeys) {
  const out = [];
  for (const j of journeys || []) { const legs = legsOf(j); if (legs.length >= 1 && legs.length <= MAX_CHAIN) out.push(legs); }
  return out;
}

/** Is there a trip to come in the answer: not gone yet, the first trip not cancelled, and not more than `max` trips in the chain? */
export function hasStart(journeys, now, max = MAX_CHAIN) {
  return (journeys || []).some((j) => { const legs = legsOf(j); return legs.length >= 1 && legs.length <= max && !legs[0].cancelled && !(t(legs[0].dep) < now - GONE_MS); });
}

/**
 * Sample connection for the preview when creating a route, for the case that nothing with at most one transfer exists: the first chain with a reasonable wait
 * at every transfer (otherwise simply the first). Same rules as previewRoute: trips that have left already (before `now`) and cancelled ones do not count,
 * `today` decides where the weekday is put in front of the time. null = nothing found.
 * Besides `via` and `wait` (the first transfer, as older apps read them) a chain with two transfers brings `changes`: [{ via, wait }, …].
 */
export function previewChain(journeys, now = -Infinity, today = now) {
  const waitsOf = (c) => c.slice(1).map((l, k) => Math.max(0, diffMin(c[k].arr, l.dep)));
  const chains = chainsOf(journeys).filter((c) => !c.some((l) => l.cancelled) && !(t(c[0].dep) < now - GONE_MS));
  if (!chains.length) return null;
  const moving = chains.filter((c) => c.length > 1);
  const pick = moving.find((c) => Math.max(...waitsOf(c)) <= MAX_WAIT_MIN) || moving[0] || chains[0];
  const waits = waitsOf(pick);
  const dayOf = (l, k) => (Number.isFinite(today) && berlin(t(l.dep)).date !== berlin(k ? t(pick[0].dep) : today).date ? `${weekday(t(l.dep))} ` : '');
  return {
    duration: dur(diffMin(pick[0].dep, pick[pick.length - 1].arr)),
    ...(pick.length > 1 ? { via: nm(pick[0].destination), wait: waits[0] } : {}),
    ...(pick.length > 2 ? { changes: pick.slice(0, -1).map((l, k) => ({ via: nm(l.destination), wait: waits[k] })) } : {}),
    legs: pick.map((l, k) => ({ lineId: lineLabel(l.line.name), line: l.line.name, color: lineColor(l.line.name, l.line.product), title: `${nm(l.origin)} → ${nm(l.destination)}`, times: `${dayOf(l, k)}ab ${hhmm(l.dep)} · an ${hhmm(l.arr)}` })),
  };
}

/** One chain rated: its transfers ("hops") with buffer and state, the worst state, arrival at the destination. */
function entryOf(legs) {
  const hops = [];
  for (let k = 0; k < legs.length - 1; k++) {
    const a = legs[k], b = legs[k + 1], aArr = arrivalOf(a);       // with replacement transport the arrival includes the extra time
    const buffer = Math.round((t(b.dep) - aArr) / MIN);
    const plannedGap = diffMin(a.plannedArr, b.plannedDep);
    const late = aArr - t(a.plannedArr) >= MIN;
    let state = 'ok';
    if (b.cancelled || buffer <= 0) state = 'missed';
    else if (late && buffer < TIGHT_MIN && buffer < plannedGap) state = 'tight';
    hops.push({ k, a, b, aArr, buffer, plannedGap, late, state, station: nm(a.destination), cancelledB: !!b.cancelled });
  }
  const state = hops.reduce((w, h) => (rank[h.state] > rank[w] ? h.state : w), 'ok');
  const last = legs[legs.length - 1];
  return {
    legs, hops, a: legs[0], last, state, worst: state === 'ok' ? null : hops.find((h) => h.state === state),
    finalArr: arrivalOf(last),
    // wait for the selection (MAX_WAIT_MIN at most) at the longest transfer; a late trip before counts with the wait it really leaves
    filterWait: Math.max(0, ...hops.map((h) => (h.late ? Math.min(h.plannedGap, h.buffer) : h.plannedGap))),
  };
}

/** All chains of the answer, one per first trip (the one that arrives first; fewer transfers on a tie); chains whose first trip is cancelled apart. */
function entriesOf(journeys) {
  const best = new Map(), cancelled = new Map();
  for (const legs of chainsOf(journeys)) {
    const e = entryOf(legs), k = keyOf(e.a);
    if (e.a.cancelled) { if (!cancelled.has(k)) cancelled.set(k, e.a); continue; }
    const cur = best.get(k);
    if (!cur || rank[e.state] < rank[cur.state] || (e.state === cur.state && (e.finalArr < cur.finalArr || (e.finalArr === cur.finalArr && e.legs.length < cur.legs.length)))) best.set(k, e);
  }
  return { entries: [...best.values()], cancelled: [...cancelled.values()] };
}

/**
 * @param tour     profile route with transfers: 1 (the fallback: nothing with at most one transfer is left)
 * @param journeys normalized connections with up to two transfers
 * @param ctx      as for buildTransferTour (bLists is not used)
 * @returns { tour, incidents } – the same shape as buildTransferTour; a departure with transfers has transfer { station: "A › B", minutes, state, text, count }
 */
export async function buildChainTour(tour, journeys, ctx) {
  const { now, minDelay, linesAt, lines } = ctx;
  const registerLine = (l) => {
    const id = lineLabel(l.name);
    if (!lines[id]) lines[id] = { id, label: id, color: lineColor(l.name, l.product) };
    return id;
  };
  const dest = tidyName(tour.to.name);
  const hint = ticketHintFor(tour);

  const { entries, cancelled: cancelledFirst } = entriesOf(journeys);
  const all = entries.filter((e) => !(t(e.a.dep) < now - GONE_MS)).sort((x, y) => t(x.a.dep) - t(y.a.dep) || x.finalArr - y.finalArr);
  // Before and during the commute window only the trips up to its end count (only if something runs in it). The "Danach" (then) card may still look past the window.
  const win = ctx.window;
  const scoped = win && (win.mode === 'now' || win.anchor) && win.endMs ? all.filter((e) => t(e.a.plannedDep || e.a.dep) <= win.endMs) : null;
  const inScope = scoped && scoped.length ? scoped : all;
  const usable = (src) => { const ok = src.filter((e) => e.filterWait <= MAX_WAIT_MIN); return ok.length ? ok : src; };      // long waits only if there is nothing else
  const listAll = usable(all);
  const list = inScope === all ? listAll : usable(inScope);
  const after = (e) => listAll[listAll.indexOf(e) + 1];
  const shown = list.slice(0, SHOWN);
  const cancelledAs = cancelledFirst.filter((l) => t(l.plannedDep) >= now && t(l.plannedDep) <= now + CANCEL_HORIZON && (inScope === all || t(l.plannedDep) <= win.endMs));

  // The transfers most routes in the list make, for the line of the route list
  const bySignature = new Map();
  const signatureOf = (e) => e.hops.map((h) => h.station).join(' › ');
  for (const e of list) if (e.hops.length) { const k = signatureOf(e); const v = bySignature.get(k) || { n: 0, e }; v.n++; bySignature.set(k, v); }
  const usual = [...bySignature.values()].sort((x, y) => y.n - x.n)[0]?.e || null;
  const lead = shown.find((e) => e.hops.length) || null;

  const out = {
    id: tour.id, name: tidyName(tour.name), appLink: appLinkFor(tour), lineId: shown[0] ? registerLine(shown[0].a.line) : '', active: tour.active !== false,
    transfers: 1, ...(usual ? { via: signatureOf(usual), changes: usual.hops.length } : {}), ...(lead ? { lineIds: lead.legs.map((l) => registerLine(l.line)) } : {}),
    period: tour.period || 'am', ...(tour.returnId ? { returnId: tour.returnId } : {}), ...(tour.returnOf ? { returnOf: tour.returnOf } : {}),
    distanceKm: ctx.distanceKm ?? null,
    ...windowView(tour.schedule || { days: ['Mo', 'Di', 'Mi', 'Do', 'Fr'], departAfter: '06:00' }, now),
    departures: [],
  };
  const incidents = [];

  // ---------- Helpers for the texts ----------
  const jump = (e) => { const i = shown.indexOf(e); return i >= 0 ? { departure: i } : {}; };
  const chipsOf = (e) => e.legs.map((l) => l.line.name).join(' › ');
  const delayOf = (e) => Math.max(0, ...e.legs.map((l) => l.depDelay || 0), ...e.hops.map((h) => Math.round((h.aArr - t(h.a.plannedArr)) / MIN)), e.hops.length ? 0 : (e.a.arrDelay || 0));
  // Every trip needs real-time data before we say "pünktlich"
  const stOf = (e) => okState(now, ...e.legs);
  const badgeOf = (e) => (e.state === 'tight' ? 'wackelt' : e.state === 'missed' ? 'verpasst' : e.a.depDelay >= minDelay ? `+${e.a.depDelay} Min.` : stOf(e).word);
  const thenCard = (e, title = 'Danach') => (e ? { title, line1: `${chipsOf(e)} ab ${hhmm(e.a.dep)}`, line2: `An ${dest} ${hhmm(e.finalArr)}`, badge: badgeOf(e), ...jump(e) } : null);
  const stopsOf = (leg) => { const so = (leg.stopovers || []).filter((s) => s && s.name); return so.length >= 2 ? so : [leg.origin, leg.destination]; };
  // "Bus an 07:41" (bus arriving 07:41) only if the replacement transport reaches the transfer station (the segment from the remark ends there)
  const busAtHub = (h) => {
    const st = stopsOf(h.a), hub = st.length - 1;
    return (h.a.remarks || []).some((r) => { if (classifyRemark(r) !== 'replacement') return false; const seg = extractSegment(r.text); return !!seg && [findStation(st, seg[0]), findStation(st, seg[1])].includes(hub); });
  };

  // ---------- Rows and sections of the detail page ----------
  const row = (label, sub2, value, planned = '', extra = {}) => ({ label, sub: sub2, value, planned, ...extra });
  const placeOf = (e, k) => (k === 0 ? nm(e.legs[0].origin) : e.hops[k - 1].station);          // where trip k starts
  const goalOf = (e, k) => (k === e.legs.length - 1 ? dest : e.hops[k].station);                // where trip k ends
  const legRows = (e, k, arrSub) => {
    const l = e.legs[k], arr = arrivalOf(l), rows = [];
    if (platformChanged(l)) rows.push(row('Gleiswechsel', `jetzt Gleis ${l.platform}, sonst Gleis ${l.plannedPlatform}`, `Gl. ${l.platform}`, `Gl. ${l.plannedPlatform}`));      // before the departure it belongs to
    rows.push(row(`Abfahrt ${placeOf(e, k)}`, sub(l), hhmm(l.dep), hhmm(l.plannedDep) !== hhmm(l.dep) ? hhmm(l.plannedDep) : ''));
    rows.push(row(`Ankunft ${goalOf(e, k)}`, arrSub || `${l.line.name}${k < e.hops.length && l.arrPlatform ? ` · Gleis ${l.arrPlatform}` : ''}`, hhmm(arr), hhmm(arr) !== hhmm(l.plannedArr) ? hhmm(l.plannedArr) : ''));
    return rows;
  };
  const transferCard = (h) => {
    const { a, b } = h;
    const word = busAtHub(h) ? 'Bus' : a.line.name;
    const cancelled = h.state === 'missed' && h.cancelledB;
    const base = h.state === 'missed'
      ? (cancelled ? `${b.line.name} ab ${hhmm(b.plannedDep)} fällt aus` : `${word} an ${hhmm(h.aArr)} · ${b.line.name} ${hhmm(b.dep)} weg`)
      : `${word} an ${hhmm(h.aArr)} · ${b.line.name} ab ${hhmm(b.dep)}`;
    const platforms = a.arrPlatform && b.platform ? `Gleis ${a.arrPlatform} → Gleis ${b.platform}` : '';
    return {
      type: 'transfer', state: h.state,
      label: h.state === 'ok' ? 'Umstieg' : h.state === 'tight' ? 'Anschluss wackelt' : cancelled ? 'Anschluss fällt aus' : 'Anschluss verpasst',
      title: h.state === 'ok' ? h.station : `Umstieg ${h.station}`,
      text: h.state === 'ok' && platforms && !busAtHub(h) ? platforms : base,
      minutes: h.state === 'missed' ? 0 : h.buffer,
    };
  };
  /** Sections of the detail page: trip, transfer, trip, … mark = { k, text }: the arrival row of that trip carries the text of a remark. */
  const sectionsOf = (e, mark = null) => {
    const sec = [];
    e.legs.forEach((l, k) => {
      sec.push({ type: 'leg', lineId: registerLine(l.line), title: `${placeOf(e, k)} → ${goalOf(e, k)}`, sub: `${k + 1}. Fahrt · ${dur((arrivalOf(l) - t(l.dep)) / MIN)}`, rows: legRows(e, k, mark && mark.k === k ? mark.text : undefined) });
      if (k < e.hops.length) sec.push(transferCard(e.hops[k]));
    });
    return sec;
  };

  // ---------- Karte ----------
  function chainMap(e, { halo = '', hop = null, segment = null } = {}) {
    const stops = [], hubAt = [];
    e.legs.forEach((l, k) => {
      const s = stopsOf(l).slice();
      if (viaKey(s[0]) !== viaKey(l.origin)) s.unshift(l.origin);
      if (viaKey(s[s.length - 1]) !== viaKey(l.destination)) s.push(l.destination);
      stops.push(...(k === 0 ? s : s.slice(1)));
      if (k < e.legs.length - 1) hubAt.push(stops.length - 1);
    });
    let segIdx = null;
    if (segment) {
      const x = findStation(stops, segment[0]), y = findStation(stops, segment[1]);
      if (x >= 0 && y >= 0 && x !== y) { const lo = Math.min(x, y), hi = Math.max(x, y); if (!hubAt.some((h) => lo < h && hi > h)) segIdx = [lo, hi]; }
    }
    const idx = sampleStops(stops, [...hubAt, ...(segIdx || [])]);
    const stations = idx.map((i) => ({ id: stops[i].id, name: shortName(stops[i].name) }));
    const hubs = hubAt.map((h) => idx.indexOf(h)), last = stations.length - 1, bounds = [0, ...hubs, last];
    const skips = [];
    for (let k = 0; k < idx.length - 1; k++) { const hidden = idx[k + 1] - idx[k] - 1; if (hidden >= 2) skips.push({ after: k, n: hidden }); }
    const label = (h) => (h.state === 'missed' ? (h.cancelledB ? 'Anschluss fällt aus' : 'Anschluss verpasst') : h.state === 'tight' ? `Umstieg nur noch ${h.buffer} Min.` : `Umstieg ${h.buffer} Min.${h.b.platform ? ` · Gleis ${h.b.platform}` : ''}`);
    const changes = e.hops.map((h, k) => ({ stationIndex: hubs[k], label: label(h), state: h.state }));
    const disrupted = segIdx ? { from: idx.indexOf(segIdx[0]), to: idx.indexOf(segIdx[1]) } : null;
    return {
      stations, hubIndex: hubs.length ? hubs[0] : -1, haloIndex: halo === 'hub' ? hubs[hop ?? 0] ?? -1 : halo === 'start' ? 0 : -1, connections: [],
      disrupted: disrupted && disrupted.from >= 0 && disrupted.to >= 0 ? disrupted : null, alternative: null,
      legs: e.legs.map((l, k) => ({ lineId: registerLine(l.line), from: bounds[k], to: bounds[k + 1] })),
      skips, ...(changes.length ? { transfer: changes[0], changes } : {}),
      // depLate/arrLate: the time pill turns colored when the departure is delayed or the arrival at the destination is later than planned
      times: {
        dep: `ab ${hhmm(e.a.dep)}`, arr: `an ${hhmm(e.finalArr)}`,
        depLate: e.a.depDelay >= minDelay, arrLate: e.finalArr - t(e.last.plannedArr) >= minDelay * MIN,
      },
    };
  }

  // ---------- View per departure ----------
  async function viewOf(e) {
    const nxt = after(e), a = e.a;
    if (!e.hops.length) {
      const isLate = a.depDelay >= minDelay;
      const rows = [row(`Abfahrt ${nm(a.origin)}`, sub(a), hhmm(a.dep), hhmm(a.plannedDep) !== hhmm(a.dep) ? hhmm(a.plannedDep) : ''), row(`Ankunft ${dest}`, a.line.name, hhmm(e.finalArr), a.arrDelay ? hhmm(a.plannedArr) : '')];
      const what = `${a.line.name} ab ${hhmm(a.dep)}`;
      return { kind: isLate ? 'delay' : 'ok', ...(isLate ? { head: `Verspätung · ${what}`, big: `+${a.depDelay} Min.`, sub: sub(a, false) } : okView(stOf(e), what, sub(a, false))), rows, alternative: thenCard(nxt), ticketHint: hint, map: await buildMap(a, linesAt, { halo: isLate, registerLine }) };
    }
    const delay = delayOf(e), w = e.worst;
    const sections = sectionsOf(e);
    const base = { rows: sections.flatMap((s) => s.rows || []), sections, ticketHint: hint };
    const lateK = e.state === 'ok' ? e.legs.findIndex((l) => (l.depDelay || 0) >= minDelay) : -1;
    e.lateK = lateK;
    if (e.state === 'missed') {
      return { kind: 'missed', head: `Anschluss · ${w.b.line.name} ab ${hhmm(w.cancelledB ? w.b.plannedDep : w.b.dep)}`, big: w.cancelledB ? 'Fällt aus' : 'Verpasst',
        sub: `Anschluss in ${w.station} ${w.cancelledB ? 'fällt aus' : 'verpasst'}`,
        ...base, alternative: thenCard(nxt), map: chainMap(e, { halo: 'hub', hop: w.k }) };
    }
    if (e.state === 'tight') {
      const slow = e.legs.find((l) => (l.depDelay || 0) >= minDelay) || w.a;
      return { kind: 'tight', head: `Verspätung · ${slow.line.name} ab ${hhmm(slow.dep)}`, big: `+${delay} Min.`, sub: `Anschluss in ${w.station} wackelt`,
        ...base, alternative: thenCard(nxt), map: chainMap(e, { halo: 'hub', hop: w.k }) };
    }
    const many = e.hops.length > 1;
    if (lateK === 0) {
      return { kind: 'delay', head: `Verspätung · ${a.line.name} ab ${hhmm(a.dep)}`, big: `+${a.depDelay} Min.`, sub: many ? 'Anschlüsse bleiben erreichbar' : `Anschluss in ${e.hops[0].station} bleibt erreichbar`,
        ...base, alternative: thenCard(nxt), map: chainMap(e, { halo: 'start' }) };
    }
    if (lateK > 0) {
      const l = e.legs[lateK];
      return { kind: 'delay', head: `Verspätung · ${l.line.name} ab ${hhmm(l.dep)}`, big: `+${l.depDelay} Min.`, sub: `Umstieg ${e.hops[lateK - 1].station} · Ankunft ${hhmm(e.finalArr)}`,
        ...base, alternative: thenCard(nxt), map: chainMap(e, { halo: 'hub', hop: lateK - 1 }) };
    }
    return { kind: 'ok', ...okView(stOf(e), `${chipsOf(e)} ab ${hhmm(a.dep)}`, `Ankunft ${dest} ${hhmm(e.finalArr)} · ${changeWord(e.hops.length)}`),
      ...base, alternative: thenCard(nxt), map: chainMap(e) };
  }

  /** The short line for the route list: where and how long the transfers are, or what is wrong with them */
  const transferOf = (e) => {
    const w = e.worst, n = e.hops.length;
    const text = w ? (w.state === 'tight' ? `Umstieg nur noch ${w.buffer} Min.` : w.cancelledB ? 'Anschluss fällt aus' : 'Anschluss verpasst')
      : n === 1 ? `Umstieg ${e.hops[0].station} · ${e.hops[0].buffer} Min.` : `${changeWord(n)} · ${e.hops.map((h) => h.buffer).join(' und ')} Min.`;
    return { station: signatureOf(e), minutes: w ? (w.state === 'missed' ? 0 : w.buffer) : Math.min(...e.hops.map((h) => h.buffer)), state: e.state, text, count: n };
  };

  for (const e of shown) {
    const a = e.a;
    e.view = await viewOf(e);
    out.departures.push({
      plannedTime: hhmm(a.plannedDep), expectedTime: hhmm(a.dep), lineId: registerLine(a.line),
      plannedPlatform: a.plannedPlatform || '', expectedPlatform: a.platform || '', delayMin: a.depDelay,
      ...(berlin(t(a.dep)).date !== berlin(now).date ? { nextDay: true } : {}),
      ...(stOf(e).plan ? { far: true } : {}),                 // "planmäßig" instead of "pünktlich" (far away, or no real-time data; older apps only know this flag)
      ...(stOf(e).unconfirmed ? { noRt: true } : {}),         // near, but no real-time data: newer apps show it neutral
      lineIds: e.legs.map((l) => registerLine(l.line)), arrTime: hhmm(e.finalArr),
      ...(e.hops.length ? { transfer: transferOf(e) } : {}),
      view: e.view,
    });
  }

  // ---------- Incidents ----------
  // 0) Cancellations of the first trip
  const byLine = new Map();
  for (const l of cancelledAs) { if (!byLine.has(l.line.name)) byLine.set(l.line.name, []); byLine.get(l.line.name).push(l); }
  for (const group of [...byLine.values()].slice(0, 2)) {
    const c = group[0], lastC = group[group.length - 1], many = group.length > 1;
    const alt = listAll.find((e) => t(e.a.plannedDep) > t(c.plannedDep));
    incidents.push({
      id: `i${hash(`${tour.id}|cancelled|${c.line.name}|${berlin(t(c.plannedDep)).date}`)}`, tourId: tour.id, kind: 'cancelled', severity: 3, delayMin: 0, lineName: c.line.name, count: group.length,
      validity: { label: validityLabel(now, t(lastC.plannedDep), now), activeNow: true, from: localIso(now), until: localIso(t(lastC.plannedDep)) },
      title: `${c.line.name} ${nm(c.origin)} → ${nm(c.destination)}`,
      summary: `${many ? 'Fahrten' : 'Fahrt'} um ${andList(times(group.map((x) => hhmm(x.plannedDep))))} ${many ? 'fallen' : 'fällt'} aus`,
      view: {
        kind: 'cancelled', head: `Ausfall · ${c.line.name} ab ${hhmm(c.plannedDep)}`, big: 'Fällt aus',
        sub: alt ? `Stattdessen: ${chipsOf(alt)} ab ${hhmm(alt.a.dep)}` : 'Keine weitere Fahrt in den nächsten Stunden',
        rows: [row(`Abfahrt ${nm(c.origin)}`, sub(c), 'entfällt', hhmm(c.plannedDep)), row(`Ankunft ${nm(c.destination)}`, c.line.name, 'entfällt', hhmm(c.plannedArr))],
        alternative: alt ? thenCard(alt, 'Stattdessen') : null, ticketHint: hint,
        map: await buildMap(c, linesAt, { segment: [c.origin.name, c.destination.name], registerLine }),
      },
    });
  }

  // 1) Connection at risk / missed (the first such transfer of a chain)
  let conn = 0;
  for (const e of shown) {
    if (!e.worst || conn >= CONN_INCIDENTS) continue;
    conn++;
    const { a, b, aArr, state } = e.worst;
    const word = busAtHub(e.worst) ? 'Bus' : a.line.name;
    const until = t(b.dep);
    const summary = state === 'tight'
      ? `Umstieg nur noch ${e.worst.buffer} Min. (${word} an ${hhmm(aArr)}, ${b.line.name} ab ${hhmm(b.dep)})`
      : e.worst.cancelledB ? `${b.line.name} ab ${hhmm(b.plannedDep)} fällt aus` : `${word} an ${hhmm(aArr)}, ${b.line.name} ${hhmm(b.dep)} weg`;
    incidents.push({
      id: `i${hash(`${tour.id}|${state}|${keyOf(a)}|${keyOf(b)}`)}`, tourId: tour.id, kind: state, severity: state === 'missed' ? 3 : 2, delayMin: delayOf(e), lineName: b.line.name,
      validity: { label: validityLabel(now, until, now), activeNow: true, from: localIso(now), until: localIso(until) },
      title: `${b.line.name} ${nm(b.origin)} → ${nm(b.destination)}`, summary, view: e.view,
    });
  }

  // 2) Replacement transport, construction – once per text, on every trip of the chains shown
  const seen = new Set();
  for (const e of shown) {
    if (!e.hops.length) continue;
    for (const [k, leg] of e.legs.entries()) for (const r of leg.remarks || []) {
      const kind = classifyRemark(r);
      if (kind === 'other') continue;
      const key = `${kind}|${r.summary}|${r.validUntil}`;
      if (seen.has(key)) continue; seen.add(key);
      const from = r.validFrom ? t(r.validFrom) : now;
      const until = r.validUntil ? t(r.validUntil) : now + 24 * 3600e3;
      if (until < now) continue;
      const delay = extractMinutes(r.text), seg = extractSegment(r.text);
      const label = validityLabel(from, until, now);
      const st = stopsOf(leg), sx = seg ? findStation(st, seg[0]) : -1, sy = seg ? findStation(st, seg[1]) : -1;
      const where = sx >= 0 && sy >= 0 && sx !== sy ? `${nm(st[Math.min(sx, sy)])} → ${nm(st[Math.max(sx, sy)])}` : `${nm(leg.origin)} → ${nm(leg.destination)}`;
      const suffix = k < e.hops.length ? { ok: ' · Anschluss bleibt erreichbar', tight: ' · Anschluss wackelt', missed: ' · Anschluss verpasst' }[e.hops[k].state] : '';
      const sections = sectionsOf(e, { k, text: `${leg.line.name} · ${r.summary || 'Hinweis'}` });
      const alt = listAll.find((x) => x !== e && x.hops.length && !x.legs.some((l) => (l.remarks || []).some((y) => classifyRemark(y) === kind)));
      incidents.push({
        id: `i${hash(`${tour.id}|${key}`)}`, tourId: tour.id, kind, severity: kind === 'replacement' ? 3 : delay >= 10 ? 2 : 1, delayMin: delay, lineName: leg.line.name,
        validity: { label, activeNow: from <= now && now <= until, from: localIso(from), until: localIso(until) },
        title: `${leg.line.name} ${nm(leg.origin)} → ${nm(leg.destination)}`,
        summary: r.summary || (kind === 'replacement' ? 'Ersatzverkehr' : 'Baustelle'),
        view: {
          kind, head: `${kind === 'replacement' ? 'Ersatzverkehr' : 'Baustelle'} · ${label}`,
          big: delay ? `+${delay} Min.` : 'Hinweis', sub: kind === 'replacement' ? `${leg.line.name} ab ${hhmm(leg.dep)} · mit Ersatzverkehr${suffix}` : `${leg.line.name} ${where}${suffix}`,
          rows: sections.flatMap((s) => s.rows || []), sections, alternative: alt ? thenCard(alt, kind === 'replacement' ? 'Ohne Ersatzverkehr' : 'Danach') : null, ticketHint: hint,
          map: chainMap(e, { segment: seg }),
        },
      });
    }
  }

  // 3) Delay of a trip in the chain, unless the connection already has an incident of its own
  const late = shown.find((e) => e.hops.length && e.lateK >= 0);
  if (late) {
    const leg = late.legs[late.lateK], n = leg.depDelay;
    const reason = (leg.remarks || []).find((r) => classifyRemark(r) === 'other')?.summary;
    incidents.push({
      id: `i${hash(`${tour.id}|delay|${leg.line.name}|${berlin(t(leg.plannedDep)).date}|${hhmm(leg.plannedDep)}`)}`, tourId: tour.id, kind: 'delay', severity: n >= 10 ? 3 : n >= 5 ? 2 : 1, delayMin: n, lineName: leg.line.name,
      validity: { label: 'heute', activeNow: true, from: localIso(now), until: localIso(t(leg.dep)) },
      title: `${leg.line.name} ${nm(leg.origin)} → ${nm(leg.destination)}`, summary: reason || `${n} Min. später`, view: late.view,
    });
  }

  // 4) Platform change (and at a transfer the next trip): its own quiet incident, only shortly before departure
  let platforms = 0;
  for (const e of shown) {
    if (!e.hops.length || t(e.a.dep) > now + PLATFORM_HORIZON || e === late || e.state !== 'ok') continue;
    for (const [k, leg] of e.legs.entries()) {
      if (platforms >= 2) break;
      if (!platformChanged(leg)) continue;
      platforms++;
      incidents.push({
        id: `i${hash(`${tour.id}|platform|${leg.line.name}|${berlin(t(leg.plannedDep)).date}|${hhmm(leg.plannedDep)}`)}`, tourId: tour.id, kind: 'platform', severity: 1, delayMin: 0, lineName: leg.line.name, platform: String(leg.platform),
        validity: { label: validityLabel(now, t(leg.dep), now), activeNow: true, from: localIso(now), until: localIso(t(leg.dep)) },
        title: `${leg.line.name} ${nm(leg.origin)} → ${nm(leg.destination)}`, summary: `${hhmm(leg.dep)}${k ? ` in ${placeOf(e, k)}` : ''} jetzt Gleis ${leg.platform} statt Gleis ${leg.plannedPlatform}`,
        view: { ...e.view, kind: 'platform', head: `Gleiswechsel · ${leg.line.name} ab ${hhmm(leg.dep)}`, big: `Gl. ${leg.platform}`, sub: `statt Gleis ${leg.plannedPlatform}`, alternative: null },
      });
    }
  }

  // No incident: "pünktlich" view on the route itself; without a departure an honest explanation (we looked for up to two transfers)
  if (!shown.length) out.view = noEntriesView(tour, ctx.stale, cancelledFirst.length > 0, ctx.staleNote, 2);
  else if (!incidents.length) out.view = shown[0].view;
  return { tour: out, incidents };
}
