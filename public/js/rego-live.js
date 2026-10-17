/* window.REGO – same fields as in the design (rego-data.js), filled from the backend.
 * Offline-first: the latest state is kept on the device, tickets never leave the device. */
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
    tight: { label: 'Anschluss wackelt', bg: '#FDE3CF', icon: ['M24 8c1 0 2 .6 2.6 1.6L41 36c1 2-.2 4.2-2.6 4.2H9.6C7.2 40.2 6 38 7 36L21.4 9.6C22 8.6 23 8 24 8z', 'M24 18v11M24 34.5v.1'] },
    missed: { label: 'Anschluss verpasst', bg: '#F9D6D2', icon: ['M24 6a18 18 0 1 0 .01 0z', 'M17 17l14 14M31 17L17 31'] },
  } };
  // Route without a departure: the server delivers an exact view; an older server (or an old intermediate state) does not, then this one applies – never "pünktlich"
  const NONE_VIEW = { kind: 'none', head: 'Nächste Abfahrt', big: 'Keine', sub: 'Keine Abfahrten gefunden.', rows: [], alternative: null, ticketHint: null, map: null };

  // Version of the Android app (only known inside the app); the browser version has none
  const nativeApp = () => { try { return window.RegoNative && window.RegoNative.appVersion ? String(window.RegoNative.appVersion()) : ''; } catch (e) { return ''; } };

  const R = window.REGO = {
    schemaVersion: 1, theme: THEME, lines: linesProxy({}), tours: [], incidents: [],
    tickets: LS.get('rego.tickets', []), walletOffers: [],
    connection: { status: 'ok', loading: true, lastSync: '' },
    settings: { pushThresholdMin: 5, delayGraceMin: 10 },
    clock: nowParts(), stations: [], deviceId: device,
    invite: { needed: false, wrong: false },          // the server demands an invitation code (new devices)
    info: { app: nativeApp(), server: '' },
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
      throw Object.assign(new Error(body.error || `HTTP ${res.status}`), { status: res.status, invite, code: body.code || '' });
    }
    return body;
  };
  /** Remember and check the invitation code. true = accepted, false = wrong; without a connection there is an error. */
  R.setInvite = async function (code) {
    LS.set('rego.invite', String(code || '').trim());
    try { await api('/state'); } catch (e) { if (e && e.invite) return false; throw e; }
    R.invite = { needed: false, wrong: false }; asked.clear();
    try { R.onInvite && R.onInvite(); } catch (e) {}
    R.refresh();
    return true;
  };
  /** Versions for the line in the settings (under "Strecken"): app (only known in the app) and server (public status request) */
  R.loadInfo = async function () {
    R.info.app = nativeApp();
    try { const s = await api('/status'); R.info.server = String(s.version || ''); } catch (e) {}
    return R.info;
  };

  R.version = 'Beta';
  // Where feedback goes: the server delivers the address it is configured with (email or link). Without one, the GitHub issue form is the way out.
  // The address is kept on the device: it is needed most when the server is not reachable.
  R.contact = String(LS.get('rego.contact', '') || '');
  R.feedback = function () {
    const body = 'Was ist passiert bzw. was wünschst du dir?\n\n\n\n---\n' + (R.info.app ? 'App ' + R.info.app : window.RegoNative ? 'Android-App' : 'Browser') + ' · Server ' + (R.info.server || '?');
    const c = R.contact;
    if (/^[^\s@]+@[^\s@]+$/.test(c)) return { href: 'mailto:' + c + '?subject=' + encodeURIComponent('ReGo Rückmeldung') + '&body=' + encodeURIComponent(body), shown: c, mail: true };
    if (/^https?:\/\//i.test(c)) return { href: c, shown: c.replace(/^https?:\/\//i, '').replace(/\/$/, ''), mail: false };
    return { href: 'https://github.com/K0RBI02/ReGo/issues/new?body=' + encodeURIComponent(body), shown: '', mail: false };
  };

  // Update hint: the server says which app version is the newest if this one is older. Shown as a bar on the main screen (can be closed for that version) and in the settings.
  const vnum = (v) => String(v).split('.').map((x) => parseInt(x, 10) || 0);
  const newer = (a, b) => { const x = vnum(a), y = vnum(b); for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0); return false; };
  R.app = null;                                                  // { latest, url } from the last state
  R.updateHint = () => (R.app && R.info.app && newer(R.app.latest, R.info.app) ? R.app : null);
  R.updateBar = () => { const u = R.updateHint(); return u && LS.get('rego.updateSeen', '') !== u.latest ? u : null; };
  R.dismissUpdate = () => { if (R.app) LS.set('rego.updateSeen', R.app.latest); };
  R.banner = function () {
    const c = R.connection; let st = c.status;
    try { if (navigator.onLine === false) st = 'offline'; } catch (e) {}
    return { offline: st === 'offline' || st === 'error', bannerLabel: st === 'error' ? 'Server offline' : 'Offline-Modus', offlineSince: c.lastSync, loading: !!c.loading };
  };
  R.isVisible = function (inc) {
    const now = new Date(`${R.clock.date}T${R.clock.now}`).getTime();
    let until = new Date(inc.validity.until).getTime();
    if (inc.kind === 'delay') until += R.settings.delayGraceMin * 60000;
    return now <= until;
  };

  /** Incidents exactly as they appear under "Meldungen" (also for the number on the button): only active routes, only visible ones,
   *  the same incident on the outward and return trip of the same route as one card. */
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

  /* --- Stops: suggestions come from the server, known ones stay on the device --- */
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

  /* --- Fetch the state --- */
  function apply(state, status, lastSync) {
    R.tours = (state.tours || []).map((t) => {
      const o = Object.assign({}, t, { name: R.shortRoute(t.name) });
      if (o.active !== false && !(o.departures || []).length && !o.view) o.view = NONE_VIEW;
      return o;
    });
    R.incidents = state.incidents || [];
    if (typeof state.contact === 'string') { R.contact = state.contact; LS.set('rego.contact', state.contact); }      // an older server does not send it: keep what we had
    R.app = state.app && /^\d+\.\d+\.\d+$/.test(String(state.app.latest)) ? { latest: String(state.app.latest), url: /^https:\/\//.test(String(state.app.url)) ? String(state.app.url) : 'https://github.com/K0RBI02/ReGo/releases' } : null;
    R.lines = linesProxy(state.lines || {}); R.settings = Object.assign({}, R.settings, state.settings || {});
    R.connection = { status, loading: false, lastSync };
  }
  // The latest state is kept on the device. Older than 6 hours it is of no use any more (yesterday's departures): better to say honestly "keine Daten".
  const CACHE_MAX_AGE = 6 * 3600e3;
  const readCache = () => { const c = LS.get('rego.state', null); return c && c.state && typeof c.ts === 'number' && Date.now() - c.ts < CACHE_MAX_AGE ? c : null; };
  // Only one request at a time. Whoever wants to refresh in the meantime (e.g. after creating a route) gets a fresh round afterwards.
  let running = null, queued = null;
  R.refresh = function () {
    if (!running) { running = refreshOnce().finally(() => { running = null; }); return running; }
    if (!queued) queued = running.then(() => { queued = null; return R.refresh(); });
    return queued;
  };
  async function refreshOnce() {
    R.clock = nowParts();
    try {
      const qs = [];
      if (R.position) qs.push(`lat=${R.position.lat}`, `lon=${R.position.lon}`);
      if (/^\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(R.info.app)) qs.push(`app=${R.info.app}`);       // the server notes the app version (update hint, status page); a query parameter because of the allowed request headers (CORS)
      const state = await api(`/state${qs.length ? '?' + qs.join('&') : ''}`);
      const t = nowParts().now;
      if (state.connection && state.connection.status === 'error') {
        const cached = readCache();
        const ids = new Set(((cached && cached.state.tours) || []).map((x) => x.id));
        // Show the old state only if it knows all current routes and has departures; otherwise newly created routes would disappear
        const useCached = cached && state.tours.every((x) => !(x.departures || []).length) && state.tours.every((x) => ids.has(x.id)) && cached.state.tours.some((x) => (x.departures || []).length);
        if (useCached) { apply(cached.state, 'error', cached.at); }
        else apply(state, 'error', state.connection.lastSync || t);
        // Without any usable departure there is nothing useful to show: a big message instead of empty cards
        R.outage = R.tours.length > 0 && R.tours.every((x) => !(x.departures || []).length);
      } else { R.errorHint = ''; R.outage = false; apply(state, 'ok', t); LS.set('rego.state', { state, at: t, ts: Date.now() }); }
    } catch (e) {
      R.errorHint = e && e.status ? `Server ${e.status}` : (e && e.name === 'TimeoutError') ? 'Zeitüberschreitung' : 'keine Verbindung zum Server';
      const cached = readCache();
      if (e && e.invite) {            // the server is waiting for the invitation code: no outage, the gate above explains it
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

  /* --- Changes (route menu) --- */
  const DAYS = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'];
  let adding = null;
  R.actions = {
    addTour(opts) {
      if (adding) return adding;                          // tapped twice: the same request, not two
      adding = (async () => {
        const { from, to, days, time, until, trip, backTime, backUntil, transfers } = opts;
        const a = R.findStation(from), b = R.findStation(to);
        if (!a || !b) throw new Error('Bitte Haltestellen aus der Liste wählen');
        const pt = (s) => ({ id: s.id, name: s.name, lat: s.lat, lon: s.lon });
        const body = { from: pt(a), to: pt(b), schedule: { days, departAfter: time, ...(until ? { departUntil: until } : {}) }, roundTrip: trip === 'both', returnAfter: backTime, ...(backUntil ? { returnUntil: backUntil } : {}) };
        if (transfers) body.transfers = 1;                  // only after the search with 1 transfer has found a connection
        await api('/tours', { method: 'POST', body: JSON.stringify(body) });
        await R.refresh();
      })().finally(() => { adding = null; });
      return adding;
    },
    /** Connection with at most 1 transfer between two chosen stops (preview before creating). */
    async searchTransfer({ from, to }) {
      const a = R.findStation(from), b = R.findStation(to);
      if (!a || !b) throw new Error('Bitte Haltestellen aus der Liste wählen');
      const pt = (s) => ({ id: s.id, name: s.name, lat: s.lat, lon: s.lon });
      return api('/connections/search', { method: 'POST', body: JSON.stringify({ from: pt(a), to: pt(b) }) });
    },
    async setActive(id, active) { await api(`/tours/${id}`, { method: 'PATCH', body: JSON.stringify({ active }) }); await R.refresh(); },
    async updateTour(id, { days, time, until }) { await api(`/tours/${id}`, { method: 'PATCH', body: JSON.stringify({ schedule: { days, departAfter: time, ...(until ? { departUntil: until } : {}) } }) }); await R.refresh(); },
    async removeTour(id) { R._before = await api('/profile'); await api(`/tours/${id}`, { method: 'DELETE' }); await R.refresh(); },
    async undoRemove() { if (R._before) { await api('/profile', { method: 'PUT', body: JSON.stringify(R._before) }); R._before = null; await R.refresh(); } },
    saveTicket(t) {
      const id = t.slot || ('t' + Date.now().toString(36));
      R.tickets = R.tickets.filter((x) => x.id !== id && !(t.slot && x.slot === t.slot));
      const before = R.tickets.slice();
      R.tickets.push({ id, slot: t.slot || null, name: t.name, validUntil: t.validUntil, image: t.image, original: t.original || '', payload: t.payload || '', format: t.format || '' });
      if (!LS.set('rego.tickets', R.tickets)) { R.tickets = before; throw new Error('Das Ticket konnte nicht gespeichert werden: Speicher voll oder gesperrt. Entferne ein altes Ticket oder schaffe Speicherplatz auf dem Gerät.'); }
    },
    /** Back up tickets as a file (stays on the device) and read them in again */
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
    async setThreshold(v) { await api('/settings', { method: 'PUT', body: JSON.stringify({ pushThresholdMin: v }) }); R.settings.pushThresholdMin = v; },
  };
  /* --- Move to a new phone --- */
  R.actions.transferCode = async function () { return (await api('/transfer', { method: 'POST', body: '{}' })).code; };
  R.actions.claimTransfer = async function (code) { const r = await api('/transfer/claim', { method: 'POST', body: JSON.stringify({ code }) }); await R.refresh(); return r.tours; };

  /* --- Push (Android app only) --- */
  R.actions.enablePush = async function () {
    if (!window.RegoNative) throw new Error('Push-Meldungen gibt es nur in der Android-App.');
    const ok = await new Promise((res) => { window.__rgPushDone = res; try { window.RegoNative.enablePush(device, window.REGO_API || ''); } catch (e) { res(false); } });
    if (ok === false) throw new Error('Benachrichtigungen sind für ReGo blockiert. Bitte in den Android-Einstellungen erlauben.');
    await api('/push/native', { method: 'PUT', body: JSON.stringify(ok ? { token: ok } : {}) });   // ok = Firebase token (or empty without Firebase)
    LS.set('rego.push', true);
    return true;
  };
  /** Is push on? (if it was switched on in the app) */
  R.pushActive = () => { try { return !!LS.get('rego.push', false) && !!window.RegoNative; } catch (e) { return false; } };
  R.actions.disablePush = async function () {
    await api('/push', { method: 'DELETE' });                // first sign out at the server; if that fails, everything stays as it is
    if (window.RegoNative) { try { window.RegoNative.disablePush(); } catch (e) {} }
    LS.set('rego.push', false);
    return true;
  };
  /** Test notification to this device. Answer: { ok, instant } – instant = arrives immediately (Firebase), otherwise at the app's next fetch (up to ~15 min). */
  R.actions.testPush = async function () { return api('/push/test', { method: 'POST', body: '{}' }); };
  /* --- Location (coarse, rounded to about 1 km; only for "nearest route first") --- */
  R.requestPosition = () => new Promise((resolve) => {
    if (!navigator.geolocation) return resolve(false);
    navigator.geolocation.getCurrentPosition(
      (pos) => { R.position = { lat: pos.coords.latitude.toFixed(2), lon: pos.coords.longitude.toFixed(2) }; resolve(true); },
      () => resolve(false), { maximumAge: 600000, timeout: 15000 });
  });

  /* --- Commute time: from when to when you leave. Setup and "Strecke ändern" use the same sliders. --- */
  // The track shows eight hours: 4 to 12 for the outward trip, 12 to 20 for the return trip (so the handles stay well apart even with a gap of one hour
  // and every step is easy to hit on a phone). If the period lies outside, the track grows long enough to fit it.
  const W = {
    step: 30,                                          // minutes per step on the slider (half an hour); more exact times are typed into the time fields
    gap: 10,                                           // the shortest a period may be (as on the server)
    day: 24 * 60 - 1,
    out: { from: '07:00', until: '08:00' }, back: { from: '16:30', until: '17:30' },
  };
  const toM = (s) => { const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(s || '')); return m ? +m[1] * 60 + +m[2] : null; };
  const toS = (n) => pad(Math.floor(n / 60)) + ':' + pad(n % 60);
  const clampN = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
  // With an English language setting the browser's time field shows "07:00 AM" and then needs more room
  const h12 = (() => { try { return new Intl.DateTimeFormat(undefined, { hour: 'numeric' }).resolvedOptions().hour12 === true; } catch (e) { return false; } })();
  /** Section of the day for the track: start before 12 = 4 to 12, otherwise 12 to 20; longer if needed (night, late evening) */
  const rangeFor = (f, u) => {
    const base = f < 12 * 60 ? [4 * 60, 12 * 60] : [12 * 60, 20 * 60];
    const lo = Math.min(base[0], Math.floor(f / 60) * 60);
    const want = Math.min(W.day, Math.max(base[1], Math.ceil(u / 60) * 60));
    return { lo, hi: lo + Math.floor((want - lo) / W.step) * W.step };
  };
  const frac = (w, v) => (clampN(v, w.lo, w.hi) - w.lo) / (w.hi - w.lo);
  // The handles do not run to the edge of the track but with their center from 18 px to width − 18 px (invisible handle = 36 px wide)
  const at = (f) => 'calc(18px + (100% - 36px) * ' + f.toFixed(4) + ')';
  R.win = {
    RANGE: W,
    /** Period with the section of the track: if the end is missing (older server) or unusable, one hour applies. */
    of(from, until) {
      const f = toM(from) == null ? toM(W.out.from) : toM(from);
      const u = toM(until) != null && toM(until) >= f + W.gap ? toM(until) : Math.min(W.day, f + 60);
      return Object.assign({ from: toS(f), until: toS(u) }, rangeFor(f, u));
    },
    /** Default for a new outward trip ('out', morning) or return trip ('back', afternoon) */
    fresh(kind) { const d = kind === 'back' ? W.back : W.out; return R.win.of(d.from, d.until); },
    text(w) { return w.from + '–' + w.until; },
    /**
     * Values for a slider card. w = period from of(), set(newPeriod) stores it in the state of the page.
     * o = { title, tone: 'w' (white) | 'o' (orange), compact }
     */
    view(w, set, o = {}) {
      const f = toM(w.from), u = toM(w.until), len = u - f;
      if (w.lo == null || w.hi == null) w = Object.assign({}, w, rangeFor(f, u));
      const compact = !!o.compact;
      const dir = String(o.title || '').includes(' · ') ? String(o.title).split(' · ')[0] + ': ' : '';      // "Hinweg: …" / "Rückweg: …" for screen readers when two cards are stacked
      const keep = (nf, nu) => set({ from: toS(nf), until: toS(nu), lo: w.lo, hi: w.hi });      // slider: the section stays while dragging
      const move = (nf, nu) => set(R.win.of(toS(nf), toS(nu)));                                // time typed: the section follows
      const ticks = compact ? [] : Array.from({ length: 25 }, (_, h) => h).filter((h) => h % 2 === 0 && h * 60 >= w.lo && h * 60 <= w.hi)
        .map((h) => ({ label: String(h), style: 'position: absolute; top: 0; left: ' + at(frac(w, h * 60)) + '; transform: translateX(-50%); font-size: 12px; font-weight: 600; color: #4A4747; line-height: 16px' }));
      const target = (e) => (e && e.target ? e.target : null);
      return {
        title: o.title || 'Abfahrt zwischen', tone: o.tone === 'o' ? 'rg-win-o' : 'rg-win-w',
        cardStyle: (o.tone === 'o' ? 'background: #FDE3CF; ' : 'background: #fff; ' + (compact ? '' : 'border: 1.5px solid #E8E8E8; ')) + 'border-radius: ' + (compact ? 22 : 24) + 'px; padding: ' + (compact ? '8px 16px 2px' : '12px 20px 2px') + '; display: flex; flex-direction: column; gap: 0',
        fromText: w.from, untilText: w.until, timePx: compact ? (h12 ? 17 : 21) : (h12 ? 21 : 26),
        min: w.lo, max: w.hi, step: W.step, fromRange: clampN(f, w.lo, w.hi), untilRange: clampN(u, w.lo, w.hi),
        fromLabel: dir + 'Früheste Abfahrt', untilLabel: dir + 'Späteste Abfahrt',
        fromValue: w.from + ' Uhr', untilValue: w.until + ' Uhr',
        fillStyle: 'left: ' + at(frac(w, f)) + '; right: ' + at(1 - frac(w, u)),
        dualCls: compact ? 'rg-dual rg-c' : 'rg-dual',
        fromKnob: 'left: ' + at(frac(w, f)), untilKnob: 'left: ' + at(frac(w, u)),
        // Each slider reacts only up to the middle between the two handles
        fromClip: 'clip-path: inset(0 ' + at(1 - (frac(w, f) + frac(w, u)) / 2) + ' 0 0)', untilClip: 'clip-path: inset(0 0 0 ' + at((frac(w, f) + frac(w, u)) / 2) + ')',
        ticks, hasTicks: ticks.length > 0, ticksStyle: 'position: relative; height: 16px; margin-bottom: 4px',
        // Slider: the handles cannot overtake each other; they snap to half hours, at least 10 minutes apart
        setFromRange: (e) => { const t = target(e); if (!t) return; const raw = +t.value; if (!isFinite(raw)) return; const top = w.lo + Math.floor((u - W.gap - w.lo) / W.step) * W.step; const nf = clampN(raw, w.lo, Math.max(w.lo, top)); if (+t.value !== nf) t.value = String(nf); keep(nf, u); },
        setUntilRange: (e) => { const t = target(e); if (!t) return; const raw = +t.value; if (!isFinite(raw)) return; const bottom = w.lo + Math.ceil((f + W.gap - w.lo) / W.step) * W.step; const nu = clampN(raw, Math.min(w.hi, bottom), w.hi); if (+t.value !== nu) t.value = String(nu); keep(f, nu); },
        // Typing a time: moves the other end along if it is in the way (the length stays)
        setFromText: (e) => { const t = target(e), m = t ? toM(t.value) : null; if (m == null) return; const nf = Math.min(m, W.day - W.gap); move(nf, nf + W.gap > u ? Math.min(W.day, nf + Math.max(len, W.gap)) : u); },
        setUntilText: (e) => { const t = target(e), m = t ? toM(t.value) : null; if (m == null) return; const nu = Math.max(m, W.gap); move(nu - W.gap < f ? Math.max(0, nu - Math.max(len, W.gap)) : f, nu); },
      };
    },
  };
  R.DAYS = DAYS;
})();
