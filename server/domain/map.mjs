// Schematic map: at most 7 stations, transfer nodes with connecting lines.
import { lineLabel } from '../lib/lines.mjs';
import { cleanStopName } from '../providers/hafas.mjs';

const norm = (s) => String(s).toLowerCase().replace(/\s*\(.*?\)\s*/g, ' ').replace(/\bhbf\b|\bbahnhof\b|\bbf\b/g, '').trim();
export function shortName(name) {
  let n = cleanStopName(name).replace(/\s*\(.*?\)/g, '').replace(/\bBahnhof\b/i, '').replace(/\s+/g, ' ').trim();
  if (/^[^,]{2,},\s*\S/.test(n)) n = n.replace(/^[^,]+,\s*/, '');                 // the associations write "Ort, Haltestelle" ("München, Moosach"): the place is no help on the map
  if (!/^München[ -]?(Hbf|Ost)$/.test(n)) n = n.replace(/^München[- ]/, '');   // "München-Feldmoching" -> "Feldmoching"
  if (n.length > 15 && !/Hbf$/.test(n)) n = n.split(/[ \-/]/)[0];
  return n.length > 15 && !/Hbf$/.test(n) ? `${n.slice(0, 14)}.` : n;
}
export function findStation(stations, query) {
  const q = norm(query);
  return stations.findIndex((s) => { const n = norm(s.name); return n === q || n.startsWith(q) || q.startsWith(n); });
}

/** Picks up to `max` stops; start, end and mandatory indices stay. */
export function sampleStops(stops, must = [], max = 7) {
  if (stops.length <= max) return stops.map((_, i) => i);
  const keep = new Set([0, stops.length - 1, ...must]);
  const rest = stops.map((_, i) => i).filter((i) => !keep.has(i));
  const free = max - keep.size;
  for (let k = 0; k < free && rest.length; k++) keep.add(rest[Math.round(((k + 1) * rest.length) / (free + 1)) - 1] ?? rest[k]);
  return [...keep].sort((a, b) => a - b).slice(0, max);
}

/**
 * leg: normalisierter Leg; linesAt(stopId) -> [{name,product}]; opts: { segment:[a,b]|null, alternative:{label,from,to}|null, halo:boolean }
 */
export async function buildMap(leg, linesAt, { segment = null, alternative = null, halo = false, registerLine = () => {} } = {}) {
  // the stopovers already contain start and destination (with different IDs per platform group) -> use them directly
  const so = leg.stopovers.filter((s) => s.name);
  const all = so.length >= 2 ? so : [leg.origin, leg.destination];
  const own = lineLabel(leg.line.name);
  let segIdx = null;
  if (segment) {
    const a = findStation(all, segment[0]), b = findStation(all, segment[1]);
    if (a >= 0 && b >= 0 && a !== b) segIdx = [Math.min(a, b), Math.max(a, b)];
  }
  const idx = sampleStops(all, segIdx || []);
  const stations = idx.map((i) => ({ id: all[i].id, name: shortName(all[i].name) }));
  const connections = [];
  let hubIndex = -1;
  for (let k = 1; k < idx.length - 1 && connections.length < 3; k++) {
    let lines = [];
    try { lines = await linesAt(all[idx[k]].id); } catch { lines = []; }
    const other = lines.find((l) => lineLabel(l.name) !== own && !/^bus/i.test(l.name));
    if (other) {
      const line = registerLine(other);
      connections.push({ stationIndex: k, lineId: line, dir: 'down' });
      if (hubIndex < 0) hubIndex = k;
    }
  }
  const last = stations.length - 1;
  connections.push({ stationIndex: last, lineId: registerLine(leg.line), dir: 'right' });
  const map = {
    stations, hubIndex, haloIndex: halo ? 0 : -1, connections,
    disrupted: segIdx ? { from: idx.indexOf(segIdx[0]), to: idx.indexOf(segIdx[1]) } : null,
    alternative: alternative ? { label: alternative.label, fromIndex: 0, toIndex: last } : null,
  };
  if (map.disrupted && (map.disrupted.from < 0 || map.disrupted.to < 0)) map.disrupted = null;
  return map;
}
