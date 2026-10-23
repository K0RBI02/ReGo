/* Small run log that survives a restart of the page (sessionStorage). Shown on the scan screen.
 * Next to it a short error log that stays on the device (localStorage): what went wrong and when. The error report (report.js) is written from it. */
(function () {
  const K = 'rego.log';
  const get = () => { try { return JSON.parse(sessionStorage.getItem(K) || '[]'); } catch (e) { return []; } };
  window.RLOG = (m) => { try { const a = get(); a.push(new Date().toTimeString().slice(0, 8) + ' ' + m); sessionStorage.setItem(K, JSON.stringify(a.slice(-16))); } catch (e) {} };
  window.RLOGS = get;

  /* Error log: the last 30 different messages of the last 14 days. The same message again is not a new entry but counts up (n, first time a, last time b) and moves to the end.
   * Only things that went wrong are in it, never names of stops, routes or tickets and never the device ID: query strings (they carry what was typed)
   * and long codes with digits (device ID, tokens) are cut out before anything is stored. */
  const KE = 'rego.errors', MAX = 30, MAX_AGE = 14 * 864e5;
  const clean = (s) => String(s == null ? '' : s)
    .replace(/\?[^\s'"”)]*/g, '?…')
    .replace(/\b(?=[A-Za-z_-]*\d)[A-Za-z0-9_-]{20,}\b/g, '…')
    .replace(/\s+/g, ' ').trim().slice(0, 140);
  const errors = () => {
    try { const a = JSON.parse(localStorage.getItem(KE) || '[]'); return Array.isArray(a) ? a.filter((x) => x && typeof x.m === 'string' && Date.now() - x.b < MAX_AGE) : []; } catch (e) { return []; }
  };
  window.RERRORS = errors;
  /** kind: js (script error), net (no connection / too slow), server (the server answered with an error), quelle (no source delivers departures), app (the app itself) */
  window.RLOGE = (kind, msg) => {
    try {
      const m = clean(msg); if (!m) return;
      const a = errors(), k = String(kind || 'js').slice(0, 12), t = Date.now(), i = a.findIndex((x) => x.k === k && x.m === m);
      if (i >= 0) { const x = a.splice(i, 1)[0]; x.n = (x.n || 1) + 1; x.b = t; a.push(x); } else a.push({ k, m, n: 1, a: t, b: t });
      localStorage.setItem(KE, JSON.stringify(a.slice(-MAX)));
    } catch (e) {}
  };

  window.addEventListener('error', (e) => {
    const w = (e.message || '') + ' ' + (e.filename ? e.filename.split('/').pop().split('?')[0] + ':' + e.lineno : '');
    window.RLOG('FEHLER ' + w);
    if (!/ResizeObserver loop/.test(w)) window.RLOGE('js', w);            // harmless message of the browser, not worth an entry
  });
  window.addEventListener('unhandledrejection', (e) => {
    const w = String((e.reason && e.reason.message) || e.reason).slice(0, 80);
    window.RLOG('REJECT ' + w);
    window.RLOGE('js', 'Promise: ' + w);
  });
  window.addEventListener('pagehide', () => window.RLOG('pagehide'));
  window.addEventListener('pageshow', (e) => window.RLOG('pageshow' + (e.persisted ? ' (aus Cache)' : '')));
  document.addEventListener('visibilitychange', () => window.RLOG('sichtbar=' + document.visibilityState));
  document.addEventListener('freeze', () => window.RLOG('freeze'));
  document.addEventListener('resume', () => window.RLOG('resume'));
  window.addEventListener('popstate', () => window.RLOG('popstate ' + location.pathname));
  window.RLOG('Start ' + location.pathname + (performance.getEntriesByType && performance.getEntriesByType('navigation')[0] ? ' (' + performance.getEntriesByType('navigation')[0].type + ')' : ''));
})();
