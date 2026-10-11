export function distanceKm(a, b) {
  if (!a || !b || a.lat == null || b.lat == null) return null;
  const R = 6371, rad = (x) => (x * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat), dLon = rad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.sqrt(h)) * 10) / 10;
}

// Land und Region aus der Haltestellen-ID (EVA-Nummer: 80… = Deutschland, 81… = Österreich).
// Bayern vs. übriges Deutschland: grobes Rechteck – reicht für die Beschriftung, nicht für Grenzfragen.
const BAVARIA = { latMin: 47.27, latMax: 50.57, lonMin: 8.97, lonMax: 13.84 };
const inBox = (p, b) => p && p.lat >= b.latMin && p.lat <= b.latMax && p.lon >= b.lonMin && p.lon <= b.lonMax;

/** 'AT' (Österreich) | 'BY' (Bayern) | 'DE' (übriges Deutschland) | '' (unbekannt) */
export function regionOf(stop) {
  if (!stop) return '';
  const id = String(stop.id || '').replace(/^[a-z0-9]+\|/i, '');      // Verbund-Präfix ("mvv|de:09162:2") ablösen
  if (/^de:/.test(id)) return inBox(stop, BAVARIA) || /^de:09/.test(id) ? 'BY' : 'DE';
  if (/^at:/.test(id)) return 'AT';
  if (/^81\d{5}/.test(id)) return 'AT';
  if (/^80\d{5}/.test(id)) return inBox(stop, BAVARIA) ? 'BY' : 'DE';
  return '';
}
export const country = (region) => (region === 'AT' ? 'AT' : region ? 'DE' : '');
