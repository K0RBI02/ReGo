/* window.REGO – gleiche Felder wie im Design (rego-data.js), gefüllt aus dem Backend.
 * Offline-first: letzter Stand liegt im Gerät, Tickets verlassen das Gerät nie. */
(function () {
  const LS = {
    get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch (e) { return false; } },
  };
  const rid = () => Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => b.toString(36).padStart(2, '0')).join('').slice(0, 24);
  let device = LS.get('rego.device', null);
  if (!device) { device = rid(); LS.set('rego.device', device); }

  const pad = (n) => String(n).padStart(2, '0');
  const nowParts = () => { const d = new Date(); return { date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`, now: `${pad(d.getHours())}:${pad(d.getMinutes())}` }; };

  const FALLBACK_LINE = { id: '', label: '', color: '#5B5B58' };
  const linesProxy = (obj) => new Proxy(obj, { get: (t, k) => (k in t ? t[k] : (typeof k === 'string' ? Object.assign({}, FALLBACK_LINE, { id: k, label: k }) : undefined)) });

  const THEME = { kinds: {
    delay: { label: 'Verspätung', bg: '#FDE3CF', icon: ['M24 8c1 0 2 .6 2.6 1.6L41 36c1 2-.2 4.2-2.6 4.2H9.6C7.2 40.2 6 38 7 36L21.4 9.6C22 8.6 23 8 24 8z', 'M24 18v11M24 34.5v.1'] },
    replacement: { label: 'Ersatzverkehr', bg: '#F9D6D2', icon: ['M8 12c0-2 1.4-3.6 3.6-3.6h24.8c2.2 0 3.6 1.6 3.6 3.6v20c0 1.8-1.2 3-3 3H11c-1.8 0-3-1.2-3-3z', 'M8 26h32M14 40v-4M34 40v-4'] },
    construction: { label: 'Baustelle', bg: '#FDF3DC', icon: ['M17 24l9 9-5 6c-2 2-5 2-7 0l-2-2c-2-2-2-5 0-7z', 'M26 29L38 13M33 8l9 7'] },
    ok: { label: 'Pünktlich', bg: '#EAF6CF', icon: ['M24 6a18 18 0 1 0 .01 0z', 'M14 25l8 8 14-17'] },
    none: { label: 'Keine Daten', bg: '#D4EDF6', icon: ['M24 6a18 18 0 1 0 .01 0z', 'M24 21v13M24 14.5v.1'] },
    cancelled: { label: 'Ausfall', bg: '#F9D6D2', icon: ['M24 6a18 18 0 1 0 .01 0z', 'M17 17l14 14M31 17L17 31'] },
    platform: { label: 'Gleiswechsel', bg: '#D4EDF6', icon: ['M24 6a18 18 0 1 0 .01 0z', 'M13 20h19M27 15l5 5-5 5M35 29H16M21 24l-5 5 5 5'] },
  } };
  // Strecke ohne Abfahrt: der Server liefert eine genaue Ansicht; ein älterer Server (oder ein alter Zwischenstand) nicht, dann gilt diese – nie „pünktlich“
  const NONE_VIEW = { kind: 'none', head: 'Nächste Abfahrt', big: 'Keine', sub: 'Keine Abfahrten gefunden.', rows: [], alternative: null, ticketHint: null, map: null };

  const R = window.REGO = {
    schemaVersion: 1, theme: THEME, lines: linesProxy({}), tours: [], incidents: [],
    tickets: LS.get('rego.tickets', []), walletOffers: [],
    connection: { status: 'ok', loading: true, lastSync: '' },
    settings: { pushThresholdMin: 5, delayGraceMin: 10 },
    clock: nowParts(), stations: [], deviceId: device,
    invite: { needed: false, wrong: false },          // der Server verlangt einen Einladungscode (neue Geräte)
    info: { app: '', server: '' },
  };
  let stationCache = LS.get('rego.stations', []);     // [{id,name,region,lat,lon}]
  R.stations = stationCache;

  const api = async (path, opt = {}) => {
    const code = String(LS.get('rego.invite', '') || '');
    const res = await fetch(`${window.REGO_API || ''}/api${path}`, Object.assign({ signal: (window.AbortSignal && AbortSignal.timeout) ? AbortSignal.timeout(30000) : undefined }, opt, { headers: Object.assign({ 'x-device': device, 'content-type': 'application/json' }, code ? { 'x-invite': encodeURIComponent(code) } : {}, opt.headers || {}) }));
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      const invite = res.status === 403 && !!body.invite;
      if (invite) { R.invite = { needed: true, wrong: !!body.wrong }; try { R.onInvite && R.onInvite(); } catch (e) {} }
      throw Object.assign(new Error(body.error || `HTTP ${res.status}`), { status: res.status, invite });
    }
    return body;
  };
  /** Einladungscode merken und prüfen. true = angenommen, false = falsch; bei fehlender Verbindung gibt es einen Fehler. */
  R.setInvite = async function (code) {
    LS.set('rego.invite', String(code || '').trim());
    try { await api('/state'); } catch (e) { if (e && e.invite) return false; throw e; }
    R.invite = { needed: false, wrong: false }; asked.clear();
    try { R.onInvite && R.onInvite(); } catch (e) {}
    R.refresh();
    return true;
  };
  /** Versionen für die Zeile unter „Strecken“: App (nur in der App bekannt) und Server (öffentliche Statusabfrage) */
  R.loadInfo = async function () {
    let app = '';
    try { app = window.RegoNative && window.RegoNative.appVersion ? String(window.RegoNative.appVersion()) : ''; } catch (e) {}
    R.info.app = app;
    try { const s = await api('/status'); R.info.server = String(s.version || ''); } catch (e) {}
    return R.info;
  };

  R.version = 'Beta';
  R.contact = 'https://github.com/K0RBI02/ReGo/issues/new?body=' + encodeURIComponent('Was ist passiert bzw. was wünschst du dir?\n\n\n\n---\nGerät: ' + (window.RegoNative ? 'Android-App' : 'Browser'));   // Kontaktadresse für Rückmeldungen (Mail oder Link); leer = Hinweis ohne Adresse
  R.banner = function () {
    const c = R.connection; let st = c.status;
    try { if (navigator.onLine === false) st = 'offline'; } catch (e) {}
    return { offline: st === 'offline' || st === 'error', bannerLabel: st === 'error' ? 'Keine aktuellen Daten' : 'Offline-Modus', offlineSince: c.lastSync, loading: !!c.loading };
  };
  R.isVisible = function (inc) {
    const now = new Date(`${R.clock.date}T${R.clock.now}`).getTime();
    let until = new Date(inc.validity.until).getTime();
    if (inc.kind === 'delay') until += R.settings.delayGraceMin * 60000;
    return now <= until;
  };

  /** Meldungen genau so, wie sie unter „Meldungen“ stehen (auch für die Zahl am Knopf): nur aktive Strecken, nur sichtbare,
   *  dieselbe Meldung auf Hin- und Rückweg derselben Strecke als eine Karte. */
  R.meldungen = function () {
    const tours = R.tours.filter((t) => t.active), merged = [];
    for (const x of R.incidents.map((i) => ({ i, t: tours.find((t) => t.id === i.tourId) })).filter((x) => x.t && R.isVisible(x.i))) {
      const pair = [x.t.id, x.t.returnId, x.t.returnOf].filter(Boolean).sort()[0];
      const key = [pair, x.i.kind, x.i.summary, x.i.delayMin, x.i.title.split(' ')[0]].join('|');
      const hit = merged.find((m) => m.key === key && m.i.tourId !== x.i.tourId && (m.t.returnId === x.t.id || m.t.returnOf === x.t.id));
      if (hit) { hit.both = true; if ((x.t.distanceKm ?? 0) < (hit.t.distanceKm ?? 0)) hit.t = x.t; } else merged.push({ ...x, key, both: false });
    }
    return merged;
  };

  /* --- Haltestellen: Vorschläge kommen vom Server, bekannte bleiben im Gerät --- */
  const norm = (s) => String(s || '').trim().toLowerCase();
  const asked = new Set();
  let timer;
  R.isStation = (name) => stationCache.some((s) => norm(s.name) === norm(name));
  R.findStation = (name) => stationCache.find((s) => norm(s.name) === norm(name));
  R.searchStations = function (query) {
    const q = norm(query);
    if (!q || R.isStation(q)) return [];
    if (q.length >= 2 && !asked.has(q)) {
      asked.add(q);
      clearTimeout(timer);
      timer = setTimeout(async () => {
        try {
          const { stations } = await api(`/stations?q=${encodeURIComponent(q)}`);
          const known = new Set(stationCache.map((s) => s.id));
          for (const s of stations) if (!known.has(s.id)) stationCache.push(s);
          stationCache = stationCache.slice(-400); R.stations = stationCache; LS.set('rego.stations', stationCache);
          R.onChange && R.onChange({ remount: false });
        } catch (e) { asked.delete(q); }
      }, 450);
    }
    const toks = q.split(/[\s,()\-\/]+/).filter(Boolean);
    const hit = stationCache.filter((s) => { const n = norm(s.name); return toks.every((t) => n.indexOf(t) >= 0); });
    const score = (s) => { const n = norm(s.name); return n === q ? 0 : n.startsWith(q) && /\b(hbf|hauptbahnhof|bahnhof|bf)\b/.test(n) ? 1 : n.startsWith(q) ? 2 : /\b(hbf|hauptbahnhof|bahnhof|bf)\b/.test(n) ? 3 : 4; };
    return hit.map((s, n) => ({ s, n })).sort((x, y) => score(x.s) - score(y.s) || x.n - y.n).map((x) => x.s).slice(0, 5);
  };

  /* Lange Haltestellennamen: "Freising, Freising" -> "Freising"; gleicher Ort an beiden Enden -> Ort weglassen */
  const split = (s) => { const m = /^([^,]+),\s*(.+)$/.exec(s); return m ? { loc: m[1].trim(), rest: m[2].trim() } : null; };
  const dedupe = (s) => { const p = split(s); return p && norm(p.loc) === norm(p.rest) ? p.loc : s; };
  const dropLoc = (s, other) => { const p = split(s); return p && norm(other).startsWith(norm(p.loc)) ? p.rest : s; };
  R.shortRoute = (name) => {
    const p = String(name || '').split(' → ');
    if (p.length !== 2) return dedupe(String(name || ''));
    const a = dedupe(p[0]), b = dedupe(p[1]);
    return `${dropLoc(a, b)} → ${dropLoc(b, a)}`;
  };

  /* --- Zustand holen --- */
  function apply(state, status, lastSync) {
    R.tours = (state.tours || []).map((t) => {
      const o = Object.assign({}, t, { name: R.shortRoute(t.name) });
      if (o.active !== false && !(o.departures || []).length && !o.view) o.view = NONE_VIEW;
      return o;
    });
    R.incidents = state.incidents || [];
    R.lines = linesProxy(state.lines || {}); R.settings = Object.assign({}, R.settings, state.settings || {});
    R.connection = { status, loading: false, lastSync };
  }
  // Der letzte Stand liegt im Gerät. Älter als 6 Stunden nützt er nichts mehr (gestrige Abfahrten): dann lieber ehrlich „keine Daten“.
  const CACHE_MAX_AGE = 6 * 3600e3;
  const readCache = () => { const c = LS.get('rego.state', null); return c && c.state && typeof c.ts === 'number' && Date.now() - c.ts < CACHE_MAX_AGE ? c : null; };
  // Immer nur eine Abfrage zur Zeit. Wer währenddessen aktualisieren will (z. B. nach dem Anlegen einer Strecke), bekommt danach eine frische Runde.
  let running = null, queued = null;
  R.refresh = function () {
    if (!running) { running = refreshOnce().finally(() => { running = null; }); return running; }
    if (!queued) queued = running.then(() => { queued = null; return R.refresh(); });
    return queued;
  };
  async function refreshOnce() {
    R.clock = nowParts();
    try {
      let q = '';
      if (R.position) q = `?lat=${R.position.lat}&lon=${R.position.lon}`;
      const state = await api(`/state${q}`);
      const t = nowParts().now;
      if (state.connection && state.connection.status === 'error') {
        const cached = readCache();
        const ids = new Set(((cached && cached.state.tours) || []).map((x) => x.id));
        // Alten Stand nur zeigen, wenn er alle aktuellen Strecken kennt und Abfahrten hat; sonst würden neu angelegte Strecken verschwinden
        const useCached = cached && state.tours.every((x) => !(x.departures || []).length) && state.tours.every((x) => ids.has(x.id)) && cached.state.tours.some((x) => (x.departures || []).length);
        if (useCached) { apply(cached.state, 'error', cached.at); }
        else apply(state, 'error', state.connection.lastSync || t);
        // Ohne irgendeine verwertbare Abfahrt gibt es nichts Brauchbares zu zeigen: große Meldung statt leerer Karten
        R.outage = R.tours.length > 0 && R.tours.every((x) => !(x.departures || []).length);
      } else { R.errorHint = ''; R.outage = false; apply(state, 'ok', t); LS.set('rego.state', { state, at: t, ts: Date.now() }); }
    } catch (e) {
      R.errorHint = e && e.status ? `Server ${e.status}` : (e && e.name === 'TimeoutError') ? 'Zeitüberschreitung' : 'keine Verbindung zum Server';
      const cached = readCache();
      if (e && e.invite) {            // der Server wartet auf den Einladungscode: keine Störung, die Maske darüber erklärt es
        R.outage = false;
        if (cached) apply(cached.state, 'offline', cached.at); else { R.tours = []; R.incidents = []; R.connection = { status: 'ok', loading: false, lastSync: '' }; }
      } else if (cached) { R.outage = false; apply(cached.state, 'offline', cached.at); }
      else { R.outage = true; R.tours = []; R.incidents = []; R.connection = { status: 'offline', loading: false, lastSync: '' }; }
    } finally { try { R.onChange && R.onChange({ remount: true }); } catch (e) { window.RLOG && RLOG('onChange: ' + (e && e.message)); } }
  }
  R.loadCached = function () {
    const cached = readCache();
    if (cached) apply(cached.state, 'ok', cached.at);
    R.connection.loading = !cached;
    if (cached) R.connection.status = 'offline';
  };

  /* --- Änderungen (Strecken-Menü) --- */
  const DAYS = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'];
  let adding = null;
  R.actions = {
    addTour(opts) {
      if (adding) return adding;                          // doppelt getippt: dieselbe Anfrage, nicht zwei
      adding = (async () => {
        const { from, to, days, time, trip, backTime } = opts;
        const a = R.findStation(from), b = R.findStation(to);
        if (!a || !b) throw new Error('Bitte Haltestellen aus der Liste wählen');
        const pt = (s) => ({ id: s.id, name: s.name, lat: s.lat, lon: s.lon });
        await api('/tours', { method: 'POST', body: JSON.stringify({ from: pt(a), to: pt(b), schedule: { days, departAfter: time }, roundTrip: trip === 'both', returnAfter: backTime }) });
        await R.refresh();
      })().finally(() => { adding = null; });
      return adding;
    },
    async setActive(id, active) { await api(`/tours/${id}`, { method: 'PATCH', body: JSON.stringify({ active }) }); await R.refresh(); },
    async updateTour(id, { days, time }) { await api(`/tours/${id}`, { method: 'PATCH', body: JSON.stringify({ schedule: { days, departAfter: time } }) }); await R.refresh(); },
    async removeTour(id) { R._before = await api('/profile'); await api(`/tours/${id}`, { method: 'DELETE' }); await R.refresh(); },
    async undoRemove() { if (R._before) { await api('/profile', { method: 'PUT', body: JSON.stringify(R._before) }); R._before = null; await R.refresh(); } },
    saveTicket(t) {
      const id = t.slot || ('t' + Date.now().toString(36));
      R.tickets = R.tickets.filter((x) => x.id !== id && !(t.slot && x.slot === t.slot));
      const before = R.tickets.slice();
      R.tickets.push({ id, slot: t.slot || null, name: t.name, validUntil: t.validUntil, image: t.image, original: t.original || '', payload: t.payload || '', format: t.format || '' });
      if (!LS.set('rego.tickets', R.tickets)) { R.tickets = before; throw new Error('Das Ticket konnte nicht gespeichert werden: Speicher voll oder gesperrt. Entferne ein altes Ticket oder gib dem Browser Speicherplatz.'); }
    },
    /** Tickets als Datei sichern (bleibt auf dem Gerät) und wieder einlesen */
    exportTickets() {
      const json = JSON.stringify({ app: 'ReGo', version: 1, savedAt: new Date().toISOString(), tickets: R.tickets });
      if (window.RegoNative) { try { const b64 = btoa(unescape(encodeURIComponent(json))); window.RegoNative.saveFile('rego-tickets.json', 'application/json', b64); } catch (e) {} return R.tickets.length; }
      const blob = new Blob([json], { type: 'application/json' });
      const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'rego-tickets.json'; document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 4000);
      return R.tickets.length;
    },
    async importTickets(file) {
      if (!file || file.size > 8 * 1024 * 1024) throw new Error('Datei fehlt oder ist zu groß.');
      let data; try { data = JSON.parse(await file.text()); } catch (e) { throw new Error('Das ist keine ReGo-Ticketdatei.'); }
      if (!data || data.app !== 'ReGo' || !Array.isArray(data.tickets)) throw new Error('Das ist keine ReGo-Ticketdatei.');
      const ok = data.tickets.filter((t) => t && typeof t.id === 'string' && typeof t.name === 'string' && typeof t.validUntil === 'string' && typeof t.image === 'string' && /^data:image\//.test(t.image));
      if (!ok.length) throw new Error('Keine Tickets in der Datei.');
      const before = R.tickets.slice();
      const ids = new Set(ok.map((t) => t.id));
      R.tickets = R.tickets.filter((x) => !ids.has(x.id)).concat(ok.map((t) => ({ id: t.id.slice(0, 40), slot: ['dt', 'kt'].includes(t.slot) ? t.slot : null, name: t.name.slice(0, 80), validUntil: t.validUntil.slice(0, 10), image: t.image, original: typeof t.original === 'string' && /^data:image\//.test(t.original) ? t.original : '', payload: String(t.payload || ''), format: String(t.format || '') })));
      if (!LS.set('rego.tickets', R.tickets)) { R.tickets = before; throw new Error('Speicher voll, Tickets nicht übernommen.'); }
      return ok.length;
    },
    ticketExpired(t) { const m = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(t && t.validUntil || ''); if (!m) return false; return new Date(+m[3], +m[2] - 1, +m[1], 23, 59, 59).getTime() < Date.now(); },
    removeTicket(id) { R.tickets = R.tickets.filter((x) => x.id !== id); LS.set('rego.tickets', R.tickets); },
    async setPushWindow(v) { await api('/settings', { method: 'PUT', body: JSON.stringify({ pushWindow: v }) }); R.settings.pushWindow = v; },
    async setThreshold(v) { await api('/settings', { method: 'PUT', body: JSON.stringify({ pushThresholdMin: v }) }); R.settings.pushThresholdMin = v; },
  };
  /* --- Umzug auf ein neues Handy --- */
  R.actions.transferCode = async function () { return (await api('/transfer', { method: 'POST', body: '{}' })).code; };
  R.actions.claimTransfer = async function (code) { const r = await api('/transfer/claim', { method: 'POST', body: JSON.stringify({ code }) }); await R.refresh(); return r.tours; };

  /* --- Push (nur in der Android-App) --- */
  R.actions.enablePush = async function () {
    if (!window.RegoNative) throw new Error('Push-Meldungen gibt es nur in der Android-App.');
    const ok = await new Promise((res) => { window.__rgPushDone = res; try { window.RegoNative.enablePush(device, window.REGO_API || ''); } catch (e) { res(false); } });
    if (ok === false) throw new Error('Benachrichtigungen sind für ReGo blockiert. Bitte in den Android-Einstellungen erlauben.');
    await api('/push/native', { method: 'PUT', body: JSON.stringify(ok ? { token: ok } : {}) });   // ok = Firebase-Kennung (oder leer ohne Firebase)
    LS.set('rego.push', true);
    return true;
  };
  /** Ist Push an? (wenn er in der App eingeschaltet wurde) */
  R.pushActive = () => { try { return !!LS.get('rego.push', false) && !!window.RegoNative; } catch (e) { return false; } };
  R.actions.disablePush = async function () {
    await api('/push', { method: 'DELETE' });                // zuerst beim Server abmelden; klappt das nicht, bleibt alles wie es ist
    if (window.RegoNative) { try { window.RegoNative.disablePush(); } catch (e) {} }
    LS.set('rego.push', false);
    return true;
  };
  /** Testmeldung an dieses Gerät. Antwort: { ok, instant } – instant = kommt sofort (Firebase), sonst beim nächsten Abholen der App (bis ~15 Min.). */
  R.actions.testPush = async function () { return api('/push/test', { method: 'POST', body: '{}' }); };
  /* --- Standort (grob, auf ca. 1 km gerundet; nur für „nächste Strecke zuerst“) --- */
  R.requestPosition = () => new Promise((resolve) => {
    if (!navigator.geolocation) return resolve(false);
    navigator.geolocation.getCurrentPosition(
      (pos) => { R.position = { lat: pos.coords.latitude.toFixed(2), lon: pos.coords.longitude.toFixed(2) }; resolve(true); },
      () => resolve(false), { maximumAge: 600000, timeout: 15000 });
  });
  R.DAYS = DAYS;
})();
