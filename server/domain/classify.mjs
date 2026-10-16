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

/** "zwischen A und B" -> ['A','B'] */
export function extractSegment(text = '') {
  const m = text.match(/zwischen\s+(.+?)\s+und\s+(.+?)(?:[\s.,;:]|$)/i);
  return m ? [m[1], m[2]] : null;
}
