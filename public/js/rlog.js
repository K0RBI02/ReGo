/* Kleines Ablaufprotokoll, überlebt einen Neustart der Seite (sessionStorage). Wird auf dem Scan-Screen angezeigt. */
(function () {
  const K = 'rego.log';
  const get = () => { try { return JSON.parse(sessionStorage.getItem(K) || '[]'); } catch (e) { return []; } };
  window.RLOG = (m) => { try { const a = get(); a.push(new Date().toTimeString().slice(0, 8) + ' ' + m); sessionStorage.setItem(K, JSON.stringify(a.slice(-16))); } catch (e) {} };
  window.RLOGS = get;
  window.addEventListener('error', (e) => window.RLOG('FEHLER ' + (e.message || '') + ' ' + (e.filename ? e.filename.split('/').pop() + ':' + e.lineno : '')));
  window.addEventListener('unhandledrejection', (e) => window.RLOG('REJECT ' + String((e.reason && e.reason.message) || e.reason).slice(0, 80)));
  window.addEventListener('pagehide', () => window.RLOG('pagehide'));
  window.addEventListener('pageshow', (e) => window.RLOG('pageshow' + (e.persisted ? ' (aus Cache)' : '')));
  document.addEventListener('visibilitychange', () => window.RLOG('sichtbar=' + document.visibilityState));
  document.addEventListener('freeze', () => window.RLOG('freeze'));
  document.addEventListener('resume', () => window.RLOG('resume'));
  window.addEventListener('popstate', () => window.RLOG('popstate ' + location.pathname));
  window.RLOG('Start ' + location.pathname + (performance.getEntriesByType && performance.getEntriesByType('navigation')[0] ? ' (' + performance.getEntriesByType('navigation')[0].type + ')' : ''));
})();
