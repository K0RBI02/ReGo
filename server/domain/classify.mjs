// Sort railway remarks into ReGo categories.
const REPLACEMENT = /ersatzverkehr|schienenersatz|\bSEV\b|bus statt (zug|bahn)|ersatzbus/i;
const CONSTRUCTION = /baustell|bauarbeit|langsamfahr|gleisarbeit|streckensperr|bauma(ß|ss)nahme/i;

/** 'replacement' | 'construction' | 'other' */
export function classifyRemark(r) {
  const t = `${r.summary || ''} ${r.text || ''}`;
  if (REPLACEMENT.test(t)) return 'replacement';
  if (CONSTRUCTION.test(t)) return 'construction';
  return 'other';
}

/** "ca. 25 Minuten" / "+15 Min." -> 25 / 15, otherwise 0 */
export function extractMinutes(text = '') {
  const m = text.match(/(\d{1,3})\s*(?:min\b|minuten)/i);
  return m ? Number(m[1]) : 0;
}

/** Arrival of a trip (ms): real time; with replacement transport at least planned arrival + the stated extra time (up to 60 minutes). */
export function arrivalOf(leg) {
  let at = Date.parse(leg.arr || leg.plannedArr);
  for (const r of leg.remarks || []) {
    if (classifyRemark(r) !== 'replacement') continue;
    const extra = Math.min(extractMinutes(r.text), 60);
    if (extra) at = Math.max(at, Date.parse(leg.plannedArr) + extra * 60000);
  }
  return at;
}

/** "zwischen A und B" -> ['A','B'] */
export function extractSegment(text = '') {
  const m = text.match(/zwischen\s+(.+?)\s+und\s+(.+?)(?:[\s.,;:]|$)/i);
  return m ? [m[1], m[2]] : null;
}
