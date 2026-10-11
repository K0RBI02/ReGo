// Linien: "S 1" -> "S1", Farbe nach Produktart. Alle Farben haben mit weißer Schrift mind. 4,5:1 Kontrast.
const BY_PRODUCT = {
  subway: '#1B4FBF', suburban: '#0B6B3F', tram: '#B3261E', bus: '#7A3FA0',
  regional: '#5B5B58', regionalExpress: '#5B5B58', national: '#8F1D2C', nationalExpress: '#8F1D2C', ferry: '#0B5C8F',
};
const MUNICH_U = { U1: '#2F7A32', U2: '#C3002F', U3: '#C2410C', U4: '#0B7A6F', U5: '#8A5A1C', U6: '#1B4FBF', U7: '#2F7A32', U8: '#C2410C' };

export function lineLabel(name = '?') {
  const c = String(name).replace(/\s+/g, '').replace(/^(Bus|Tram|STR)/i, '');
  const m = c.match(/^([A-Za-zÄÖÜ]+)(\d{3,})$/);   // RJX19915 -> RJX (Zugnummer, keine Linie)
  return (m ? m[1] : c) || String(name);
}
export function lineColor(name, product) {
  const l = lineLabel(name).toUpperCase();
  return MUNICH_U[l] || BY_PRODUCT[product] || '#5B5B58';
}
const PRODUCT_DE = {
  subway: 'U-Bahn', suburban: 'S-Bahn', tram: 'Tram', bus: 'Bus', regional: 'Regionalzug',
  regionalExpress: 'Regionalexpress', national: 'Fernzug', nationalExpress: 'Fernzug', ferry: 'Fähre',
};
export const productName = (p) => PRODUCT_DE[p] || 'Zug';
