// Sample data without network, in the raw format of hafas-client (as transport.rest returns it).
// NOTE: format rebuilt from the documentation, not checked against the real API (see scripts/probe.mjs).
// IDs are chosen for the example; only the stops with the comment "real?" come from memory.
const S = (id, name, lat, lon) => ({ type: 'stop', id, name, location: { type: 'location', latitude: lat, longitude: lon }, products: { nationalExpress: true, regional: true, suburban: true } });

export const MOCK_STOPS = [
  S('8000261', 'München Hbf', 48.1402, 11.5586),          // real?
  S('8002078', 'Freising', 48.4009, 11.7415),             // real?
  S('8000320', 'Rosenheim', 47.8517, 12.1186),
  S('8000183', 'Ingolstadt Hbf', 48.7448, 11.4372),
  S('8000298', 'Passau Hbf', 48.5740, 13.4511),
  S('8000105', 'Nürnberg Hbf', 49.4456, 11.0829),
  S('8100002', 'Salzburg Hbf', 47.8130, 13.0453),
  S('8100108', 'Wien Hbf', 48.1852, 16.3761),
  S('8100013', 'Linz/Donau Hbf', 48.2903, 14.2912),
  S('8004279', 'Neufahrn(b Freising)', 48.3167, 11.6667),
  S('8000901', 'Feldmoching', 48.2056, 11.5394),
  S('8000902', 'Moosach', 48.1800, 11.5200),
  S('8000903', 'Prien am Chiemsee', 47.8560, 12.3510),
  S('8000904', 'Grafing Bahnhof', 48.0430, 11.9660),
  S('8000905', 'Freilassing', 47.8350, 12.9760),
  S('8000906', 'Traunstein', 47.8680, 12.6430),
  S('8000907', 'München Ost', 48.1274, 11.6050),
  S('8000908', 'München-Neuperlach Süd', 48.0875, 11.6360),
];
const byId = Object.fromEntries(MOCK_STOPS.map((s) => [s.id, s]));
const ids = (...n) => n.map((x) => byId[MOCK_STOPS.find((s) => s.name.startsWith(x))?.id]);
const ref = (s) => ({ type: 'stop', id: s.id, name: s.name, location: s.location });

// Routes: stop sequence, line, product, headway (min), travel time (min)
const ROUTES = [
  { name: 'S1', product: 'suburban', every: 20, mins: 46, stops: ids('Freising', 'Neufahrn', 'Feldmoching', 'Moosach', 'München Hbf'), headsign: ['Freising', 'München Hbf'] },
  { name: 'RE 2', product: 'regionalExpress', every: 60, mins: 24, stops: ids('Freising', 'München Hbf'), headsign: ['Freising', 'München Hbf'] },
  { name: 'RE 5', product: 'regionalExpress', every: 30, mins: 78, stops: ids('München Hbf', 'Rosenheim', 'Prien', 'Traunstein', 'Freilassing', 'Salzburg'), headsign: ['Salzburg Hbf', 'München Hbf'], replacement: true },
  { name: 'RJX 61', product: 'nationalExpress', every: 60, mins: 100, stops: ids('München Hbf', 'Rosenheim', 'Salzburg Hbf', 'Linz', 'Wien'), headsign: ['Wien Hbf', 'München Hbf'] },
  { name: 'RE 1', product: 'regionalExpress', every: 60, mins: 50, stops: ids('München Hbf', 'Ingolstadt'), headsign: ['Ingolstadt Hbf', 'München Hbf'] },
  // Together with the S1 these two make a trip that needs two transfers (Freising → Neuperlach Süd): no stop is shared by the first and the last line
  { name: 'S4', product: 'suburban', every: 20, mins: 8, stops: ids('München Hbf', 'München Ost'), headsign: ['München Ost', 'München Hbf'] },
  { name: 'U5', product: 'subway', every: 10, mins: 14, stops: ids('München Ost', 'München-Neuperlach'), headsign: ['Neuperlach Süd', 'München Ost'] },
];

function route(fromId, toId) {
  for (const r of ROUTES) {
    const a = r.stops.findIndex((s) => s.id === fromId), b = r.stops.findIndex((s) => s.id === toId);
    if (a >= 0 && b >= 0 && a !== b) return { r, a, b };
  }
  return null;
}

const MCT = 4;                                   // minimum transfer time in the sample data (min)
const iso = (ms) => new Date(ms).toISOString();

/** Stop sequence and travel time of a route between two stops (in direction of travel) */
function sliceOf({ r, a, b }) {
  const slice = (b > a ? r.stops.slice(a, b + 1) : r.stops.slice(b, a + 1).reverse());
  return { r, slice, total: Math.max(r.mins * (slice.length - 1) / Math.max(r.stops.length - 1, 1), 8) };
}

// A trip at the planned departure `plan`. i = running number from "now": the sample disruptions follow it,
// so that the same trip has the same disruption in every query (direct or as part of a connection with a transfer).
function tripOf({ r, slice, total }, plan, i, now) {
  const late = r.name === 'S1' && i === 0 ? 8 : r.name === 'S1' && i === 1 ? 4 : r.name === 'RE 5' && i === 0 ? 12 : 0;   // RE 5: replacement transport AND delay (two incidents, one route page)
  const planArr = plan + total * 60000;
  const remarks = [];
  if (late) remarks.push({ type: 'status', code: 'delay', summary: r.name === 'S1' ? 'Stellwerksstörung' : 'Fahrzeugstörung', text: r.name === 'S1' ? 'Wegen einer Stellwerksstörung kommt es zu Verspätungen und Teilausfällen.' : 'Wegen einer Fahrzeugstörung verspätet sich der Zug.', validFrom: iso(now - 3600000), validUntil: iso(now + 5400000), priority: 80 });
  if (r.replacement && i >= 0 && i < 2) remarks.push({ type: 'status', code: 'construction', summary: 'Schienenersatzverkehr', text: 'Wegen Bauarbeiten zwischen Rosenheim und Prien Schienenersatzverkehr mit Bussen. Reisezeit verlängert sich um ca. 25 Minuten.', validFrom: iso(now - 86400000), validUntil: iso(now + 3 * 86400000), priority: 90 });
  return {
    tripId: `mock-${r.name}-${plan}`.replace(/\s/g, ''),
    origin: ref(slice[0]), destination: ref(slice[slice.length - 1]),
    departure: iso(plan + late * 60000), plannedDeparture: iso(plan), departureDelay: late * 60,
    arrival: iso(planArr + late * 60000), plannedArrival: iso(planArr), arrivalDelay: late * 60,
    departurePlatform: late ? '3' : '2', plannedDeparturePlatform: '2',
    arrivalPlatform: late ? '5' : '4', plannedArrivalPlatform: '4',
    direction: slice[slice.length - 1].name,
    line: { type: 'line', name: r.name, product: r.product },
    stopovers: slice.map((s, k) => ({ stop: ref(s), plannedDeparture: iso(plan + (total * 60000 * k) / (slice.length - 1)) })),
    remarks, cancelled: false,
  };
}

/** Trips of a route from t0: [{ plan, i }] */
function gridFrom(r, t0, now, count) {
  const step = r.every * 60000, first = Math.ceil(t0 / step) * step, base = Math.ceil(now / step) * step;
  return Array.from({ length: count }, (_, k) => { const plan = first + k * step; return { plan, i: Math.round((plan - base) / step) }; });
}

// The scenario chooses the time: shortly after "now" there is a delay on the S1 as well as replacement transport and a delay on the RE 5.
// transfers >= 1: if there is no direct trip, two routes are joined via a common stop (usually München Hbf) – like a real timetable, only with the
// connection that is still reachable after the actual arrival.
// transfers >= 2: if even that is not possible, three routes are joined via two stops.
function journeysFor({ from, to, departure, results = 5, now, transfers = 0 }) {
  const t0 = Math.max(Date.parse(departure) || now, now - 5 * 60000);
  const hit = route(from, to);
  if (hit) {
    const sl = sliceOf(hit);
    return gridFrom(sl.r, t0, now, results).map(({ plan, i }) => ({ type: 'journey', legs: [tripOf(sl, plan, i, now)] }));
  }
  if (transfers < 1) return [];
  const hub = MOCK_STOPS.find((s) => s.id !== from && s.id !== to && route(from, s.id) && route(s.id, to));
  if (!hub) return transfers >= 2 ? chainFor({ from, to, t0, results, now }) : [];
  const one = sliceOf(route(from, hub.id)), two = sliceOf(route(hub.id, to));
  const tripsB = gridFrom(two.r, t0, now, 24).map(({ plan, i }) => tripOf(two, plan, i, now));
  const out = [];
  for (const { plan, i } of gridFrom(one.r, t0, now, results + 6)) {
    const a = tripOf(one, plan, i, now);
    const b = tripsB.find((x) => Date.parse(x.departure) >= Date.parse(a.arrival) + MCT * 60000);
    if (b) out.push({ type: 'journey', legs: [a, b] });
    if (out.length >= results) break;
  }
  return out;
}

/** Two transfers: from → first stop → second stop → to, each part on its own route; every next trip is the first one that is reachable after the actual arrival. */
function chainFor({ from, to, t0, results, now }) {
  let hubs = null;
  for (const h1 of MOCK_STOPS) {
    if (h1.id === from || h1.id === to || !route(from, h1.id)) continue;
    const h2 = MOCK_STOPS.find((s) => s.id !== from && s.id !== to && s.id !== h1.id && route(h1.id, s.id) && route(s.id, to));
    if (h2) { hubs = [h1, h2]; break; }
  }
  if (!hubs) return [];
  const one = sliceOf(route(from, hubs[0].id)), two = sliceOf(route(hubs[0].id, hubs[1].id)), three = sliceOf(route(hubs[1].id, to));
  const tripsB = gridFrom(two.r, t0, now, 40).map(({ plan, i }) => tripOf(two, plan, i, now));
  const tripsC = gridFrom(three.r, t0, now, 80).map(({ plan, i }) => tripOf(three, plan, i, now));
  const out = [];
  for (const { plan, i } of gridFrom(one.r, t0, now, results + 6)) {
    const a = tripOf(one, plan, i, now);
    const b = tripsB.find((x) => Date.parse(x.departure) >= Date.parse(a.arrival) + MCT * 60000);
    const c = b && tripsC.find((x) => Date.parse(x.departure) >= Date.parse(b.arrival) + MCT * 60000);
    if (b && c) out.push({ type: 'journey', legs: [a, b, c] });
    if (out.length >= results) break;
  }
  return out;
}

// Lines per stop (for transfer connections at hubs)
function linesAt(id) {
  const lines = [];
  for (const r of ROUTES) if (r.stops.some((s) => s.id === id)) lines.push({ type: 'line', name: r.name, product: r.product });
  return lines;
}

/** Rebuilt fetch function: same paths as transport.rest. */
export function mockFetch({ now = () => Date.now() } = {}) {
  return async (url) => {
    const u = new URL(url);
    const json = (body, status = 200) => ({ ok: status < 400, status, headers: new Map(), json: async () => body });
    if (u.pathname === '/locations') {
      const q = (u.searchParams.get('query') || '').toLowerCase();
      return json(MOCK_STOPS.filter((s) => s.name.toLowerCase().includes(q)).slice(0, Number(u.searchParams.get('results') || 8)));
    }
    const m = u.pathname.match(/^\/stops\/(.+)$/);
    if (m) {
      const s = byId[decodeURIComponent(m[1])];
      return s ? json({ ...s, lines: linesAt(s.id) }) : json({ message: 'not found' }, 404);
    }
    if (u.pathname === '/journeys') {
      const p = u.searchParams;
      return json({ journeys: journeysFor({ from: p.get('from'), to: p.get('to'), departure: p.get('departure'), results: Number(p.get('results') || 5), transfers: Number(p.get('transfers') || 0), now: now() }) });
    }
    return json({ message: 'unbekannt' }, 404);
  };
}
