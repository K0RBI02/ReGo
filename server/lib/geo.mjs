export function distanceKm(a, b) {
  if (!a || !b || a.lat == null || b.lat == null) return null;
  const R = 6371, rad = (x) => (x * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat), dLon = rad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.sqrt(h)) * 10) / 10;
}

// Country and region from the stop ID (EVA number: 80… = Germany, 81… = Austria).
// Bavaria vs. the rest of Germany: a rough rectangle – enough for labels, not for border questions.
const BAVARIA = { latMin: 47.27, latMax: 50.57, lonMin: 8.97, lonMax: 13.84 };
const AUSTRIA = { latMin: 46.37, latMax: 49.02, lonMin: 9.53, lonMax: 17.16 };
const inBox = (p, b) => p && p.lat >= b.latMin && p.lat <= b.latMax && p.lon >= b.lonMin && p.lon <= b.lonMax;

/** 'AT' (Austria) | 'BY' (Bavaria) | 'DE' (rest of Germany) | '' (unknown) */
export function regionOf(stop) {
  if (!stop) return '';
  const id = String(stop.id || '').replace(/^[a-z0-9]+\|/i, '');      // strip the association prefix ("mvv|de:09162:2")
  if (/^de:/.test(id)) return inBox(stop, BAVARIA) || /^de:09/.test(id) ? 'BY' : 'DE';
  if (/^at:/.test(id)) return 'AT';
  if (/^81\d{5}/.test(id)) return 'AT';
  if (/^80\d{5}/.test(id)) return inBox(stop, BAVARIA) ? 'BY' : 'DE';
  // ID unknown (e.g. an ÖBB stop without an 81… number): decide by coordinates – German IDs are handled above, so this can only be Austria
  return inBox(stop, AUSTRIA) ? 'AT' : '';
}
export const country = (region) => (region === 'AT' ? 'AT' : region ? 'DE' : '');
