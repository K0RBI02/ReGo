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
  } };

  const R = window.REGO = {
    schemaVersion: 1, theme: THEME, lines: linesProxy({}), tours: [], incidents: [],
    tickets: LS.get('rego.tickets', []), walletOffers: [],
    connection: { status: 'ok', loading: true, lastSync: '' },
    settings: { pushThresholdMin: 5, delayGraceMin: 10 },
    clock: nowParts(), stations: [], deviceId: device,
  };
  let stationCache = LS.get('rego.stations', []);     // [{id,name,region,lat,lon}]
  R.stations = stationCache;

  const api = async (path, opt = {}) => {
    const res = await fetch(`/api${path}`, Object.assign({ signal: (window.AbortSignal && AbortSignal.timeout) ? AbortSignal.timeout(30000) : undefined }, opt, { headers: Object.assign({ 'x-device': device, 'content-type': 'application/json' }, opt.headers || {}) }));
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(body.error || `HTTP ${res.status}`), { status: res.status });
    return body;
  };

  R.version = 'Beta';
  R.contact = 'https://github.com/K0RBI02/ReGo/issues';   // Kontaktadresse für Rückmeldungen (Mail oder Link); leer = Hinweis ohne Adresse
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
    R.tours = (state.tours || []).map((t) => Object.assign({}, t, { name: R.shortRoute(t.name) })); R.incidents = state.incidents || [];
    R.lines = linesProxy(state.lines || {}); R.settings = Object.assign({}, R.settings, state.settings || {});
    R.connection = { status, loading: false, lastSync };
  }
  let busy = false;
  R.refresh = async function () {
    if (busy) return; busy = true;
    R.clock = nowParts();
    try {
      let q = '';
      if (R.position) q = `?lat=${R.position.lat}&lon=${R.position.lon}`;
      const state = await api(`/state${q}`);
      const t = nowParts().now;
      if (state.connection && state.connection.status === 'error') {
        const cached = LS.get('rego.state', null);
        const ids = new Set(((cached && cached.state.tours) || []).map((x) => x.id));
        // Alten Stand nur zeigen, wenn er alle aktuellen Strecken kennt und Abfahrten hat; sonst würden neu angelegte Strecken verschwinden
        const useCached = cached && state.tours.every((x) => !(x.departures || []).length) && state.tours.every((x) => ids.has(x.id)) && cached.state.tours.some((x) => (x.departures || []).length);
        if (useCached) { apply(cached.state, 'error', cached.at); }
        else apply(state, 'error', state.connection.lastSync || t);
        // Ohne irgendeine verwertbare Abfahrt gibt es nichts Brauchbares zu zeigen: große Meldung statt leerer Karten
        R.outage = R.tours.length > 0 && R.tours.every((x) => !(x.departures || []).length);
      } else { R.errorHint = ''; R.outage = false; apply(state, 'ok', t); LS.set('rego.state', { state, at: t }); }
    } catch (e) {
      R.errorHint = e && e.status ? `Server ${e.status}` : (e && e.name === 'TimeoutError') ? 'Zeitüberschreitung' : 'keine Verbindung zum Server';
      const cached = LS.get('rego.state', null);
      if (cached) { R.outage = false; apply(cached.state, 'offline', cached.at); }
      else { R.outage = true; R.tours = []; R.incidents = []; R.connection = { status: 'offline', loading: false, lastSync: '' }; }
    } finally { busy = false; R.onChange && R.onChange({ remount: true }); }
  };
  R.loadCached = function () {
    const cached = LS.get('rego.state', null);
    if (cached) apply(cached.state, 'ok', cached.at);
    R.connection.loading = !cached;
    if (cached) R.connection.status = 'offline';
  };

  /* --- Änderungen (Strecken-Menü) --- */
  const DAYS = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'];
  R.actions = {
    async addTour({ from, to, days, time, trip, backTime }) {
      const a = R.findStation(from), b = R.findStation(to);
      if (!a || !b) throw new Error('Bitte Haltestellen aus der Liste wählen');
      const pt = (s) => ({ id: s.id, name: s.name, lat: s.lat, lon: s.lon });
      await api('/tours', { method: 'POST', body: JSON.stringify({ from: pt(a), to: pt(b), schedule: { days, departAfter: time }, roundTrip: trip === 'both', returnAfter: backTime }) });
      await R.refresh();
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
      const blob = new Blob([JSON.stringify({ app: 'ReGo', version: 1, savedAt: new Date().toISOString(), tickets: R.tickets })], { type: 'application/json' });
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
  /* --- Push --- */
  const b64ToU8 = (s) => { const p = '='.repeat((4 - (s.length % 4)) % 4), b = atob((s + p).replace(/-/g, '+').replace(/_/g, '/')); return Uint8Array.from(b, (c) => c.charCodeAt(0)); };
  R.actions.enablePush = async function () {
    if (!window.isSecureContext || !('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) throw new Error('Push braucht eine sichere Verbindung (https).');
    if (Notification.permission === 'denied') throw new Error('Benachrichtigungen sind für ReGo blockiert.');
    const perm = Notification.permission === 'granted' ? 'granted' : await Notification.requestPermission();
    if (perm !== 'granted') throw new Error('Ohne Erlaubnis kann ReGo keine Meldungen schicken.');
    const reg = await navigator.serviceWorker.ready;
    try { const c = await caches.open('rego-meta'); await c.put('/__device', new Response(device)); } catch (e) {}
    const { publicKey } = await api('/push/key');
    let sub = await reg.pushManager.getSubscription();
    if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToU8(publicKey) });
    await api('/push', { method: 'PUT', body: JSON.stringify(sub.toJSON()) });
    LS.set('rego.push', true);
    return true;
  };
  /* --- Standort (grob, auf ca. 1 km gerundet; nur für „nächste Strecke zuerst“) --- */
  R.requestPosition = () => new Promise((resolve) => {
    if (!navigator.geolocation) return resolve(false);
    navigator.geolocation.getCurrentPosition(
      (pos) => { R.position = { lat: pos.coords.latitude.toFixed(2), lon: pos.coords.longitude.toFixed(2) }; resolve(true); },
      () => resolve(false), { maximumAge: 600000, timeout: 15000 });
  });
  R.DAYS = DAYS;
})();
