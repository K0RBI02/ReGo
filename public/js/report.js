/* Error report: one text file with what helps to find a problem – versions, the state of the app, the server's own view, the latest errors and the run of this session.
 * It holds no device ID, no stops, routes or tickets and no location (only how many there are). One tap in the settings saves it: into the "Download" folder in the app,
 * as a download in the browser. ReGo sends nothing anywhere; whoever wants to help sends the file on by themselves. */
(function () {
  const R = window.REGO;
  if (!R) return;
  const p2 = (n) => String(n).padStart(2, '0');
  const hms = (t) => { const d = new Date(t); return p2(d.getHours()) + ':' + p2(d.getMinutes()) + ':' + p2(d.getSeconds()); };
  const day = (t) => { const d = new Date(t); return p2(d.getDate()) + '.' + p2(d.getMonth() + 1) + '.'; };
  const when = (t) => day(t) + ' ' + hms(t);
  const dur = (min) => { const m = Math.max(0, Math.round(min)); return m >= 1440 ? Math.floor(m / 1440) + ' Tg ' + Math.floor((m % 1440) / 60) + ' h' : m >= 60 ? Math.floor(m / 60) + ' h ' + (m % 60) + ' min' : m + ' min'; };
  const storage = () => { try { let n = 0; for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); n += k.length + String(localStorage.getItem(k)).length; } return Math.round(n / 1024) + ' KB'; } catch (e) { return '?'; } };
  const why = (e) => (e && e.status ? 'Server antwortet mit ' + e.status : e && e.name === 'TimeoutError' ? 'keine Antwort in 4 Sekunden' : 'keine Verbindung zum Server');
  const STATE = { ok: 'aktuell', offline: 'offline, zeigt den gespeicherten Stand', error: 'Server erreichbar, aber keine Quelle liefert aktuelle Abfahrten' };

  async function build() {
    const ua = navigator.userAgent || '', android = /Android (\d+(?:\.\d+)*)/.exec(ua), chrome = /Chrome\/(\d+)/.exec(ua);
    const speed = navigator.connection && navigator.connection.effectiveType ? ' (' + navigator.connection.effectiveType + ')' : '';
    let tz = ''; try { tz = Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch (e) {}

    // The server's own view: its status (versions, sources) and its clock. Not asked when the phone says it is offline and only for a short time,
    // because an error report is needed most when the server does not answer.
    let status = null, health = null, fail = '', ms = 0, seen = 0;
    if (navigator.onLine === false || !R.api) fail = 'Gerät meldet: offline';
    else {
      const opt = () => (window.AbortSignal && AbortSignal.timeout ? { signal: AbortSignal.timeout(4000) } : {});
      const t0 = performance.now();
      const [s, h] = await Promise.allSettled([R.api('/status', opt()), R.api('/health', opt())]);
      ms = Math.round(performance.now() - t0); seen = Date.now();
      if (s.status === 'fulfilled') status = s.value; else fail = why(s.reason);
      if (h.status === 'fulfilled') health = h.value;
    }

    const L = [], row = (k, v) => L.push('  ' + (k + ':').padEnd(22) + v), head = (t) => L.push('', t, '-'.repeat(t.length));
    const now = Date.now(), c = R.connection || {}, tours = R.tours || [];
    L.push('ReGo – Fehlerbericht', '====================', 'Ohne Haltestellen, Strecken, Tickets, Standort und Geräte-ID. ReGo schickt diese Datei nirgendwohin.');

    head('App und Gerät');
    row('Erstellt', day(now) + new Date(now).getFullYear() + ' ' + hms(now) + (tz ? ' (' + tz + ')' : ''));
    row('App', window.RegoNative ? 'Android-App ' + (R.info.app || '?') : 'Browser');
    row('Server', (status && status.version) || R.info.server || '?');
    row('System', (android ? 'Android ' + android[1] : 'kein Android') + (chrome ? ', WebView/Chrome ' + chrome[1] : ''));
    row('Bildschirm', screen.width + '×' + screen.height + ', Fenster ' + innerWidth + '×' + innerHeight + ', Dichte ' + (window.devicePixelRatio || 1));
    row('Netz', (navigator.onLine === false ? 'offline' : 'online') + speed);
    row('Sprache', navigator.language || '?');

    head('Zustand der App');
    row('Verbindung', (c.status || '?') + (STATE[c.status] ? ' (' + STATE[c.status] + ')' : ''));
    row('Letzter Abgleich', c.lastSync || '–');
    row('Fehlerhinweis', R.errorHint || '–');
    row('Ausfall-Ansicht', R.outage ? 'ja' : 'nein');
    row('Strecken', tours.length + ' (' + tours.filter((t) => t.active !== false).length + ' aktiv, ' + tours.filter((t) => (t.departures || []).length).length + ' mit Abfahrten)');
    row('Meldungen', (R.incidents || []).length);
    row('Tickets', (R.tickets || []).length);
    row('Push', R.pushActive && R.pushActive() ? 'an' : 'aus');
    row('Einladungscode', R.invite && R.invite.needed ? (R.invite.wrong ? 'falsch' : 'verlangt') : 'nicht nötig');
    row('Standort', R.position ? 'bekannt' : 'unbekannt');
    row('Speicher belegt', storage());

    head('Server');
    if (status) {
      row('Antwortzeit', ms + ' ms');
      row('Version', status.version + ', läuft seit ' + dur(status.uptimeMin));
      row('Anbieter', status.provider || '?');
      row('Quellen', (status.sources || []).map((s) => s.name + ' ' + (s.ok === false ? 'FEHLER' : s.ok ? 'ok' : '?') + (s.pausedSec ? ' (pausiert ' + s.pausedSec + ' s)' : '')).join(', ') || '–');
      row('Sofort-Push', status.instantPush ? 'ja' : 'nein');
      if (health && health.time) {
        const skew = Math.round((Date.parse(health.time) - (seen - ms / 2)) / 1000);
        row('Uhr des Geräts', Math.abs(skew) < 5 ? 'stimmt mit dem Server überein' : Math.abs(skew) + ' s ' + (skew > 0 ? 'hinter' : 'vor') + ' dem Server');
      }
    } else row('Status', fail || 'keine Antwort');

    head('Fehler auf diesem Gerät (älteste zuerst)');
    const errs = window.RERRORS ? window.RERRORS() : [];
    if (!errs.length) L.push('  keine');
    errs.forEach((x) => L.push('  ' + when(x.a) + (x.n > 1 ? ' – ' + (day(x.b) === day(x.a) ? hms(x.b) : when(x.b)) + ' (' + x.n + '×)' : '') + '  [' + x.k + '] ' + x.m));

    head('Ablauf dieser Sitzung (älteste zuerst)');
    const run = window.RLOGS ? window.RLOGS() : [];
    if (!run.length) L.push('  –');
    run.forEach((l) => L.push('  ' + l));
    return L.join('\n') + '\n';
  }

  const b64 = (s) => { let x = ''; new TextEncoder().encode(s).forEach((c) => { x += String.fromCharCode(c); }); return btoa(x); };
  /** Builds the report and saves it. true = saved (in the app: into "Download", in the browser: download started), false = could not be saved. */
  async function save() {
    const text = await build(), d = new Date();
    const name = 'rego-fehlerbericht-' + d.getFullYear() + p2(d.getMonth() + 1) + p2(d.getDate()) + '-' + p2(d.getHours()) + p2(d.getMinutes()) + '.txt';
    if (window.RegoNative) {
      let ok = false;
      try { ok = window.RegoNative.saveFile(name, 'text/plain', b64(text)) !== false; } catch (e) { ok = false; }      // an older app answers nothing: counts as saved
      if (!ok) window.RLOGE && RLOGE('app', 'Fehlerbericht konnte nicht gespeichert werden');
      return ok;
    }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' })); a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    return true;
  }

  R.report = { build, save };
})();
