// Baut aus Profil + Verbindungsdaten genau die Struktur, die das Frontend (window.REGO) erwartet.
import { createHash } from 'node:crypto';
import { berlin, hhmm, shortDate, fromBerlin } from '../lib/time.mjs';
import { lineLabel, lineColor, productName } from '../lib/lines.mjs';
import { regionOf, country, distanceKm } from '../lib/geo.mjs';
import { classifyRemark, extractMinutes, extractSegment } from './classify.mjs';
import { buildMap, shortName } from './map.mjs';

export const SCHEMA_VERSION = 1;
// Namen wie "München, München Hbf" (Ort doppelt) kürzen, auch bei schon gespeicherten Strecken
export const tidyName = (n = '') => String(n).replace(/(^|→\s*)([^,→]+?),\s*\2\b/gi, '$1$2');
const localIso = (ms) => { const b = berlin(ms); return `${b.date}T${b.time}`; };
const hash = (s) => createHash('sha1').update(s).digest('hex').slice(0, 8);
const severityOf = (kind, delay) => (kind === 'replacement' || kind === 'cancelled' ? 3 : kind === 'construction' ? (delay >= 10 ? 2 : 1) : kind === 'platform' ? 1 : delay >= 10 ? 3 : delay >= 5 ? 2 : 1);
const CANCEL_HORIZON = 3 * 3600e3;          // Ausfälle melden wir für die nächsten 3 Stunden (die Quelle liefert nur die nächsten Fahrten)
const PLATFORM_HORIZON = 45 * 60e3;         // ein Gleiswechsel ist erst kurz vor der Abfahrt wichtig
const times = (list) => (list.length <= 3 ? list : [...list.slice(0, 3), `${list.length - 3} weitere`]);
const andList = (list) => (list.length > 1 ? `${list.slice(0, -1).join(', ')} und ${list[list.length - 1]}` : list[0] || '');

export const THEME = {
  kinds: {
    delay:        { label: 'Verspätung',    bg: '#FDE3CF', icon: ['M24 8c1 0 2 .6 2.6 1.6L41 36c1 2-.2 4.2-2.6 4.2H9.6C7.2 40.2 6 38 7 36L21.4 9.6C22 8.6 23 8 24 8z', 'M24 18v11M24 34.5v.1'] },
    replacement:  { label: 'Ersatzverkehr', bg: '#F9D6D2', icon: ['M8 12c0-2 1.4-3.6 3.6-3.6h24.8c2.2 0 3.6 1.6 3.6 3.6v20c0 1.8-1.2 3-3 3H11c-1.8 0-3-1.2-3-3z', 'M8 26h32M14 40v-4M34 40v-4'] },
    construction: { label: 'Baustelle',     bg: '#FDF3DC', icon: ['M17 24l9 9-5 6c-2 2-5 2-7 0l-2-2c-2-2-2-5 0-7z', 'M26 29L38 13M33 8l9 7'] },
    ok:           { label: 'Pünktlich',     bg: '#EAF6CF', icon: ['M24 6a18 18 0 1 0 .01 0z', 'M14 25l8 8 14-17'] },
    none:         { label: 'Keine Daten',   bg: '#D4EDF6', icon: ['M24 6a18 18 0 1 0 .01 0z', 'M24 21v13M24 14.5v.1'] },
    cancelled:    { label: 'Ausfall',       bg: '#F9D6D2', icon: ['M24 6a18 18 0 1 0 .01 0z', 'M17 17l14 14M31 17L17 31'] },
    platform:     { label: 'Gleiswechsel',  bg: '#D4EDF6', icon: ['M24 6a18 18 0 1 0 .01 0z', 'M13 20h19M27 15l5 5-5 5M35 29H16M21 24l-5 5 5 5'] },
  },
};

/** Ansicht für eine Strecke ohne Abfahrt: ehrlich sagen, warum (keine Daten, Fahrten fallen aus, keine Direktverbindung), nie „pünktlich“. */
function noDeparturesView(tour, journeys, stale) {
  const cancelled = journeys.some((j) => j.legs[0] && j.legs[0].cancelled);
  const [big, sub] = stale ? ['Keine Daten', 'Die Fahrplanquelle antwortet gerade nicht. ReGo versucht es weiter.']
    : cancelled ? ['Fällt aus', 'Die nächsten Fahrten fallen aus.']
      : ['Keine', 'Keine Direktverbindung gefunden. ReGo zeigt nur Fahrten ohne Umstieg.'];
  // Karte: Start und Ziel, verbunden mit einer gepunkteten Linie (wie bei einer Störung)
  const stations = [tour.from, tour.to].map((s) => ({ id: s.id, name: shortName(s.name) }));
  return { kind: 'none', head: 'Nächste Abfahrt', big, sub, rows: [], alternative: null, ticketHint: null, map: { stations, hubIndex: -1, haloIndex: -1, connections: [], disrupted: { from: 0, to: 1 }, alternative: null } };
}

function validityLabel(from, until, now) {
  const f = berlin(from).date, u = berlin(until).date, today = berlin(now).date;
  if (f <= today && u === today) return 'heute';
  const fmt = (ms) => shortDate(ms);
  return f <= today ? `bis ${fmt(until)}` : `ab ${fmt(from)} bis ${fmt(until)}`;
}

function ticketHintFor(tour) {
  const a = country(regionOf(tour.from)), b = country(regionOf(tour.to));
  if (!a || !b || a === b) return null;
  const toAt = b === 'AT';
  return {
    text: 'Grenzüberschreitende Strecke: Prüfe, ob dein Ticket auf dem ganzen Weg gilt.',
    cta: toAt ? 'In ÖBB-App prüfen' : 'In DB Navigator prüfen',
    url: toAt ? 'https://tickets.oebb.at/' : 'https://www.bahn.de/',
    note: 'Du wechselst in die offizielle App. ReGo verkauft keine Tickets.',
  };
}

// Weiterführender Link passend zur Strecke: nur Deutschland -> DB, nur Österreich -> ÖBB, grenzüberschreitend -> Hinweis mit Ticketprüfung (ticketHint)
function appLinkFor(tour) {
  const a = country(regionOf(tour.from)), b = country(regionOf(tour.to));
  if (a === 'DE' && b === 'DE') return { label: 'Im DB Navigator ansehen', url: 'https://www.bahn.de/' };
  if (a === 'AT' && b === 'AT') return { label: 'In der ÖBB-App ansehen', url: 'https://tickets.oebb.at/' };
  return null;
}

const sub = (leg, withPlatform = true) => `${leg.line.name} Richtung ${leg.direction}${withPlatform && leg.platform ? ` · Gleis ${leg.platform}` : ''}`;

/**
 * @param tour     Profil-Tour { id,name,from,to,active,period,returnId?,returnOf?,schedule }
 * @param journeys normalisierte Journeys (Direktverbindungen)
 * @param ctx      { now, minDelay, linesAt, lines (Registry), graceMin, stale (Daten stammen aus dem Zwischenspeicher oder fehlen wegen Störung) }
 * @returns { tour, incidents }
 */
export async function buildTour(tour, journeys, ctx) {
  const { now, minDelay, linesAt, lines } = ctx;
  const registerLine = (l) => {
    const id = lineLabel(l.name);
    if (!lines[id]) lines[id] = { id, label: id, color: lineColor(l.name, l.product) };
    return id;
  };
  // Nur Fahrten, die noch nicht abgefahren sind (2 Min. Nachlauf), nach tatsächlicher Abfahrt sortiert; ausfallende Fahrten getrennt
  const upcoming = journeys.map((j) => j.legs[0]).filter(Boolean)
    .filter((l) => !(Date.parse(l.dep) < now - 120000)).sort((a, b) => Date.parse(a.dep) - Date.parse(b.dep));
  const legs = upcoming.filter((l) => !l.cancelled);
  const canceled = upcoming.filter((l) => l.cancelled && Date.parse(l.plannedDep || l.dep) >= now && Date.parse(l.plannedDep || l.dep) <= now + CANCEL_HORIZON);
  const out = {
    id: tour.id, name: tidyName(tour.name), appLink: appLinkFor(tour), lineId: legs[0] ? registerLine(legs[0].line) : '', active: tour.active !== false,
    period: tour.period || 'am', ...(tour.returnId ? { returnId: tour.returnId } : {}), ...(tour.returnOf ? { returnOf: tour.returnOf } : {}),
    distanceKm: ctx.distanceKm ?? null,
    schedule: tour.schedule || { days: ['Mo', 'Di', 'Mi', 'Do', 'Fr'], departAfter: '06:00' },
    departures: legs.slice(0, 3).map((l) => ({
      plannedTime: hhmm(l.plannedDep), expectedTime: hhmm(l.dep), lineId: registerLine(l.line),
      plannedPlatform: l.plannedPlatform || '', expectedPlatform: l.platform || '', delayMin: l.depDelay,
      ...(berlin(Date.parse(l.dep)).date !== berlin(now).date ? { nextDay: true } : {}),
    })),
  };
  const incidents = [];
  const hint = ticketHintFor(tour);
  const dest = tour.to.name;

  // 0) Ausfälle: eine Meldung je Linie mit allen ausfallenden Fahrten der nächsten Stunden – auch wenn gar keine Fahrt mehr übrig ist
  const byLine = new Map();
  for (const l of canceled) { if (!byLine.has(l.line.name)) byLine.set(l.line.name, []); byLine.get(l.line.name).push(l); }
  for (const group of [...byLine.values()].slice(0, 2)) {
    const c = group[0], lastC = group[group.length - 1], many = group.length > 1;
    const summary = `${many ? 'Fahrten' : 'Fahrt'} um ${andList(times(group.map((l) => hhmm(l.plannedDep))))} ${many ? 'fallen' : 'fällt'} aus`;
    const alt = legs.find((l) => Date.parse(l.plannedDep) > Date.parse(c.plannedDep));
    const altLine1 = alt && `${alt.line.name} ab ${hhmm(alt.dep)}${alt.platform ? ` · Gleis ${alt.platform}` : ''}`;
    const map = await buildMap(c, linesAt, { segment: [c.origin.name, c.destination.name], alternative: alt ? { label: `Alternative · ${alt.line.name} ${hhmm(alt.dep)}` } : null, registerLine });
    incidents.push({
      id: `i${hash(`${tour.id}|cancelled|${c.line.name}|${berlin(Date.parse(c.plannedDep)).date}`)}`, tourId: tour.id, kind: 'cancelled', severity: severityOf('cancelled', 0), delayMin: 0, lineName: c.line.name, count: group.length,
      validity: { label: validityLabel(now, Date.parse(lastC.plannedDep), now), activeNow: true, from: localIso(now), until: localIso(Date.parse(lastC.plannedDep)) },
      title: `${c.line.name} ${c.origin.name} → ${c.destination.name}`, summary,
      view: {
        kind: 'cancelled', head: `Ausfall · ${c.line.name} ab ${hhmm(c.plannedDep)}`, big: 'Fällt aus',
        sub: alt ? `Nächste Fahrt ${altLine1}` : 'Keine weitere Fahrt in den nächsten Stunden',
        rows: [
          { label: `Abfahrt ${c.origin.name}`, sub: sub(c), value: 'entfällt', planned: hhmm(c.plannedDep) },
          { label: `Ankunft ${dest}`, sub: c.line.name, value: 'entfällt', planned: hhmm(c.plannedArr) },
        ],
        alternative: alt ? { title: `Nächste Verbindung · ${productName(alt.line.product)}`, line1: altLine1, line2: `An ${dest} ${hhmm(alt.arr)}`, badge: alt.depDelay >= minDelay ? `+${alt.depDelay} Min.` : 'pünktlich' } : null,
        ticketHint: hint, map,
      },
    });
  }

  if (!legs.length) { out.view = noDeparturesView(tour, journeys, ctx.stale); return { tour: out, incidents }; }

  const first = legs[0];

  // Detailansicht je Abfahrt (die ersten drei): „zwei Bahnen später“ lässt sich einzeln öffnen
  for (let k = 0; k < out.departures.length; k++) {
    const l = legs[k], nxt = legs[k + 1], isLate = l.depDelay >= minDelay;
    const platformChg = l.plannedPlatform && l.platform && l.plannedPlatform !== l.platform;
    const rows = [{ label: `Abfahrt ${l.origin.name}`, sub: sub(l), value: hhmm(l.dep), planned: hhmm(l.plannedDep) !== hhmm(l.dep) ? hhmm(l.plannedDep) : '' }];
    if (platformChg) rows.push({ label: 'Gleiswechsel', sub: `jetzt Gleis ${l.platform}, sonst Gleis ${l.plannedPlatform}`, value: `Gl. ${l.platform}`, planned: `Gl. ${l.plannedPlatform}` });
    rows.push({ label: `Ankunft ${dest}`, sub: l.line.name, value: hhmm(l.arr), planned: l.arrDelay ? hhmm(l.plannedArr) : '' });
    const kmap = await buildMap(l, linesAt, { halo: isLate, registerLine });
    out.departures[k].view = {
      kind: isLate ? 'delay' : 'ok',
      head: `${isLate ? 'Verspätung' : 'Pünktlich'} · ${l.line.name} ab ${hhmm(l.dep)}`,
      big: isLate ? `+${l.depDelay} Min.` : 'pünktlich', sub: sub(l, false), rows,
      alternative: nxt ? { title: 'Danach', line1: `${nxt.line.name} ab ${hhmm(nxt.dep)}${nxt.platform ? ` · Gleis ${nxt.platform}` : ''}`, line2: `An ${dest} ${hhmm(nxt.arr)}`, badge: nxt.depDelay >= minDelay ? `+${nxt.depDelay} Min.` : 'pünktlich' } : null,
      ticketHint: hint, map: kmap,
    };
  }

  // 1) Ereignisse aus Hinweisen (Ersatzverkehr, Baustelle) – einmal je Text
  const seen = new Set();
  for (const leg of legs) for (const r of leg.remarks) {
    const kind = classifyRemark(r);
    if (kind === 'other') continue;
    const key = `${kind}|${r.summary}|${r.validUntil}`;
    if (seen.has(key)) continue; seen.add(key);
    const from = r.validFrom ? Date.parse(r.validFrom) : now;
    const until = r.validUntil ? Date.parse(r.validUntil) : now + 24 * 3600e3;
    if (until < now) continue;
    const delay = extractMinutes(r.text);
    const alt = legs.find((l) => l !== leg && !l.remarks.some((x) => classifyRemark(x) === kind));
    const seg = extractSegment(r.text);
    const label = validityLabel(from, until, now);
    const arrPlanned = hhmm(leg.plannedArr);
    const arrExpected = hhmm(new Date(Date.parse(leg.plannedArr) + delay * 60000).toISOString());
    const map = await buildMap(leg, linesAt, { segment: seg, alternative: alt ? { label: `Alternative · ${alt.line.name} ${hhmm(alt.dep)}` } : null, registerLine });
    incidents.push({
      id: `i${hash(`${tour.id}|${key}`)}`, tourId: tour.id, kind, severity: severityOf(kind, delay), delayMin: delay, lineName: leg.line.name,
      validity: { label, activeNow: from <= now && now <= until, from: localIso(from), until: localIso(until) },
      title: `${leg.line.name} ${leg.origin.name} → ${leg.destination.name}`,
      summary: r.summary || (kind === 'replacement' ? 'Ersatzverkehr' : 'Baustelle'),
      view: {
        kind, head: `${kind === 'replacement' ? 'Ersatzverkehr' : 'Baustelle'} · ${label}`,
        big: delay ? `+${delay} Min.` : 'Hinweis', sub: `${leg.line.name} ${leg.origin.name} → ${leg.destination.name}`,
        rows: [
          { label: `Abfahrt ${leg.origin.name}`, sub: sub(leg), value: hhmm(leg.dep), planned: hhmm(leg.plannedDep) !== hhmm(leg.dep) ? hhmm(leg.plannedDep) : '' },
          { label: `Ankunft ${dest}`, sub: `${leg.line.name} · ${r.summary || 'Hinweis'}`, value: arrExpected, planned: delay ? arrPlanned : '' },
        ],
        alternative: alt ? { title: `Nächste Verbindung · ${productName(alt.line.product)}`, line1: `${alt.line.name} ab ${hhmm(alt.dep)}${alt.platform ? ` · Gleis ${alt.platform}` : ''}`, line2: `An ${dest} ${hhmm(alt.arr)}`, badge: alt.arrDelay ? `+${alt.arrDelay} Min.` : 'pünktlich' } : null,
        ticketHint: hint, map,
      },
    });
  }

  // 2) Verspätung der nächsten Abfahrt
  const late = legs.find((l) => l.depDelay >= minDelay);
  if (late) {
    const next = legs.find((l) => l !== late && l.depDelay < minDelay && Date.parse(l.plannedDep) > Date.parse(late.plannedDep));
    const platformChanged = late.plannedPlatform && late.platform && late.plannedPlatform !== late.platform;
    const reason = late.remarks.find((r) => classifyRemark(r) === 'other')?.summary;
    const summary = platformChanged ? `Gleiswechsel Gl. ${late.plannedPlatform} → Gl. ${late.platform}` : reason || `${late.depDelay} Min. später`;
    const until = Date.parse(late.dep);
    const rows = [{ label: `Abfahrt ${late.origin.name}`, sub: sub(late), value: hhmm(late.dep), planned: hhmm(late.plannedDep) }];
    if (platformChanged) rows.push({ label: 'Gleiswechsel', sub: `jetzt Gleis ${late.platform}, sonst Gleis ${late.plannedPlatform}`, value: `Gl. ${late.platform}`, planned: `Gl. ${late.plannedPlatform}` });
    rows.push({ label: `Ankunft ${dest}`, sub: late.line.name, value: hhmm(late.arr), planned: hhmm(late.plannedArr) });
    const map = await buildMap(late, linesAt, { halo: true, registerLine });
    incidents.push({
      id: `i${hash(`${tour.id}|delay|${late.line.name}|${berlin(Date.parse(late.plannedDep)).date}|${hhmm(late.plannedDep)}`)}`, tourId: tour.id, kind: 'delay', severity: severityOf('delay', late.depDelay), delayMin: late.depDelay, lineName: late.line.name,
      validity: { label: 'heute', activeNow: true, from: localIso(now), until: localIso(until) },
      title: `${late.line.name} ${late.origin.name} → ${late.destination.name}`, summary,
      view: {
        kind: 'delay', head: `Verspätung · ${late.line.name} ab ${hhmm(late.dep)}`, big: `+${late.depDelay} Min.`, sub: summary, rows,
        alternative: next ? { title: 'Nächster Zug', line1: `${next.line.name} ab ${hhmm(next.dep)}${next.platform ? ` · Gleis ${next.platform}` : ''}`, line2: `An ${dest} ${hhmm(next.arr)}`, badge: 'pünktlich' } : null,
        ticketHint: hint, map,
      },
    });
  }

  // 2b) Gleiswechsel: eigene, leise Meldung. Nur kurz vor der Abfahrt, und nicht doppelt zur Verspätungsmeldung derselben Fahrt (die nennt ihn schon)
  let platforms = 0;
  for (const l of legs) {
    if (platforms >= 2) break;
    if (l === late || !(l.plannedPlatform && l.platform && l.plannedPlatform !== l.platform) || Date.parse(l.dep) > now + PLATFORM_HORIZON) continue;
    platforms++;
    const rows = [
      { label: `Abfahrt ${l.origin.name}`, sub: sub(l), value: hhmm(l.dep), planned: hhmm(l.plannedDep) !== hhmm(l.dep) ? hhmm(l.plannedDep) : '' },
      { label: 'Gleiswechsel', sub: `jetzt Gleis ${l.platform}, sonst Gleis ${l.plannedPlatform}`, value: `Gl. ${l.platform}`, planned: `Gl. ${l.plannedPlatform}` },
      { label: `Ankunft ${dest}`, sub: l.line.name, value: hhmm(l.arr), planned: l.arrDelay ? hhmm(l.plannedArr) : '' },
    ];
    const map = await buildMap(l, linesAt, { registerLine });
    incidents.push({
      id: `i${hash(`${tour.id}|platform|${l.line.name}|${berlin(Date.parse(l.plannedDep)).date}|${hhmm(l.plannedDep)}`)}`, tourId: tour.id, kind: 'platform', severity: severityOf('platform', 0), delayMin: 0, lineName: l.line.name, platform: String(l.platform),
      validity: { label: validityLabel(now, Date.parse(l.dep), now), activeNow: true, from: localIso(now), until: localIso(Date.parse(l.dep)) },
      title: `${l.line.name} ${l.origin.name} → ${l.destination.name}`, summary: `${hhmm(l.dep)} jetzt Gleis ${l.platform} statt Gleis ${l.plannedPlatform}`,
      view: { kind: 'platform', head: `Gleiswechsel · ${l.line.name} ab ${hhmm(l.dep)}`, big: `Gl. ${l.platform}`, sub: `statt Gleis ${l.plannedPlatform}`, rows, alternative: null, ticketHint: hint, map },
    });
  }

  // 3) Keine Meldung -> Ansicht "pünktlich" an der Tour selbst
  if (!incidents.length) {
    const map = await buildMap(first, linesAt, { registerLine });
    out.view = {
      kind: 'ok', head: `Pünktlich · ${first.line.name} ab ${hhmm(first.dep)}`, big: 'pünktlich', sub: sub(first, false),
      rows: [
        { label: `Abfahrt ${first.origin.name}`, sub: sub(first), value: hhmm(first.dep), planned: '' },
        { label: `Ankunft ${dest}`, sub: first.line.name, value: hhmm(first.arr), planned: '' },
      ],
      alternative: null, ticketHint: hint, map,
    };
  }
  return { tour: out, incidents };
}

/** Sichtbarkeit wie im Frontend: Ereignisse bis until, Verspätungen bis until + Nachlauf. */
export function stillVisible(inc, now, graceMin) {
  const until = fromBerlin(inc.validity.until.slice(0, 10), inc.validity.until.slice(11, 16));
  return now <= until + (inc.kind === 'delay' ? graceMin * 60000 : 0);
}

export { distanceKm };
