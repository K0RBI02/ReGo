// Beispieldaten ohne Netz, im Rohformat von hafas-client (so wie transport.rest es liefert).
// ACHTUNG: Format nach Dokumentation nachgebaut, nicht gegen die echte API geprüft (siehe scripts/probe.mjs).
// IDs sind für das Beispiel gewählt; nur die Haltestellen mit Kommentar "echt?" stammen aus dem Gedächtnis.
const S = (id, name, lat, lon) => ({ type: 'stop', id, name, location: { type: 'location', latitude: lat, longitude: lon }, products: { nationalExpress: true, regional: true, suburban: true } });

export const MOCK_STOPS = [
  S('8000261', 'München Hbf', 48.1402, 11.5586),          // echt?
  S('8002078', 'Freising', 48.4009, 11.7415),             // echt?
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
];
const byId = Object.fromEntries(MOCK_STOPS.map((s) => [s.id, s]));
const ids = (...n) => n.map((x) => byId[MOCK_STOPS.find((s) => s.name.startsWith(x))?.id]);
const ref = (s) => ({ type: 'stop', id: s.id, name: s.name, location: s.location });

// Strecken: Haltefolge, Linie, Produkt, Takt (Min.), Fahrzeit (Min.)
const ROUTES = [
  { name: 'S1', product: 'suburban', every: 20, mins: 46, stops: ids('Freising', 'Neufahrn', 'Feldmoching', 'Moosach', 'München Hbf'), headsign: ['Freising', 'München Hbf'] },
  { name: 'RE 2', product: 'regionalExpress', every: 60, mins: 24, stops: ids('Freising', 'München Hbf'), headsign: ['Freising', 'München Hbf'] },
  { name: 'RE 5', product: 'regionalExpress', every: 60, mins: 78, stops: ids('München Hbf', 'Rosenheim', 'Prien', 'Traunstein', 'Freilassing', 'Salzburg'), headsign: ['Salzburg Hbf', 'München Hbf'], replacement: true },
  { name: 'RJX 61', product: 'nationalExpress', every: 60, mins: 100, stops: ids('München Hbf', 'Rosenheim', 'Salzburg Hbf', 'Linz', 'Wien'), headsign: ['Wien Hbf', 'München Hbf'] },
  { name: 'RE 1', product: 'regionalExpress', every: 60, mins: 50, stops: ids('München Hbf', 'Ingolstadt'), headsign: ['Ingolstadt Hbf', 'München Hbf'] },
];

function route(fromId, toId) {
  for (const r of ROUTES) {
    const a = r.stops.findIndex((s) => s.id === fromId), b = r.stops.findIndex((s) => s.id === toId);
    if (a >= 0 && b >= 0 && a !== b) return { r, a, b };
  }
  return null;
}

// Zeitpunkt wählt das Szenario: kurz nach "jetzt" gibt es Verspätung auf der S1 und Baustellen auf der RE 5.
function journeysFor({ from, to, departure, results = 5, now }) {
  const hit = route(from, to);
  if (!hit) return [];
  const { r, a, b } = hit;
  const dir = b > a ? 1 : 0;
  const slice = (b > a ? r.stops.slice(a, b + 1) : r.stops.slice(b, a + 1).reverse());
  const total = Math.max(r.mins * (slice.length - 1) / Math.max(r.stops.length - 1, 1), 8);
  const t0 = Math.max(Date.parse(departure) || now, now - 5 * 60000);
  const step = r.every * 60000;
  const first = Math.ceil(t0 / step) * step;
  const out = [];
  for (let i = 0; i < results; i++) {
    const plan = first + i * step;
    const late = r.name === 'S1' && i === 0 ? 8 : r.name === 'S1' && i === 1 ? 4 : 0;
    const planArr = plan + total * 60000;
    const iso = (ms) => new Date(ms).toISOString();
    const remarks = [];
    if (late) remarks.push({ type: 'status', code: 'delay', summary: 'Stellwerksstörung', text: 'Wegen einer Stellwerksstörung kommt es zu Verspätungen und Teilausfällen.', validFrom: iso(now - 3600000), validUntil: iso(now + 5400000), priority: 80 });
    if (r.replacement && i < 2) remarks.push({ type: 'status', code: 'construction', summary: 'Schienenersatzverkehr', text: 'Wegen Bauarbeiten zwischen Rosenheim und Prien Schienenersatzverkehr mit Bussen. Reisezeit verlängert sich um ca. 25 Minuten.', validFrom: iso(now - 86400000), validUntil: iso(now + 3 * 86400000), priority: 90 });
    out.push({
      type: 'journey',
      legs: [{
        tripId: `mock-${r.name}-${plan}`.replace(/\s/g, ''),
        origin: ref(slice[0]), destination: ref(slice[slice.length - 1]),
        departure: iso(plan + late * 60000), plannedDeparture: iso(plan), departureDelay: late * 60,
        arrival: iso(planArr + late * 60000), plannedArrival: iso(planArr), arrivalDelay: late * 60,
        departurePlatform: late ? '3' : '2', plannedDeparturePlatform: '2',
        direction: slice[slice.length - 1].name,
        line: { type: 'line', name: r.name, product: r.product },
        stopovers: slice.map((s, k) => ({ stop: ref(s), plannedDeparture: iso(plan + (total * 60000 * k) / (slice.length - 1)) })),
        remarks, cancelled: false,
      }],
    });
  }
  return out;
}

// Linien je Haltestelle (für Umstiegsanschlüsse an Knoten)
function linesAt(id) {
  const lines = [];
  for (const r of ROUTES) if (r.stops.some((s) => s.id === id)) lines.push({ type: 'line', name: r.name, product: r.product });
  return lines;
}

/** Nachgebaute fetch-Funktion: gleiche Pfade wie transport.rest. */
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
      return json({ journeys: journeysFor({ from: p.get('from'), to: p.get('to'), departure: p.get('departure'), results: Number(p.get('results') || 5), now: now() }) });
    }
    return json({ message: 'unbekannt' }, 404);
  };
}
