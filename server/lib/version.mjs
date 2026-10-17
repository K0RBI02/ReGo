// Version numbers of the form 1.2.3 (as in rego/config.yaml). The Android app reports its own with every state request,
// the server compares it with the newest app version it knows.
export const VERSION_RE = /^\d{1,3}\.\d{1,3}\.\d{1,3}$/;

/** "0.7.4" -> "0.7.4"; anything else (missing, made up, too long) -> "" */
export const cleanVersion = (v) => { const s = String(v ?? '').trim(); return VERSION_RE.test(s) ? s : ''; };

/** Is version a newer than b? Invalid versions are never newer. */
export function isNewer(a, b) {
  if (!VERSION_RE.test(a) || !VERSION_RE.test(b)) return false;
  const x = a.split('.').map(Number), y = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
  return false;
}
