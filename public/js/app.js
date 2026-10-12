/* Router + Start. Pfade: /  /Strecken  /Ticket  /Detail#<id>  /Meldungen  /Scan  /Onboarding1..3 */
(function () {
  const R = window.REGO;
  const SCREENS = ['Main', 'Meldungen', 'Detail', 'Ticket', 'Scan', 'Strecken', 'Onboarding1', 'Onboarding2', 'Onboarding3'];
  const TITLES = { Main: 'ReGo', Meldungen: 'Meldungen', Detail: 'Meldung', Ticket: 'Ticket', Scan: 'Ticket hinzufügen', Strecken: 'Strecken', Onboarding1: 'Willkommen', Onboarding2: 'Willkommen', Onboarding3: 'Willkommen' };
  const host = document.getElementById('screen'), styleEl = document.getElementById('screen-style');
  let current = null, currentName = '', token = 0;
  const flag = (k, v) => { try { if (v === undefined) return localStorage.getItem(k) === '1'; localStorage.setItem(k, v ? '1' : '0'); } catch (e) { return false; } };

  function routeOf(path) {
    const n = path.replace(/^\/+|\/+$/g, '').replace(/\.dc\.html$/, '');
    if (!n || n === 'index.html') return R.tours.length || flag('rego.onboarded') ? 'Main' : 'Onboarding1';
    return SCREENS.includes(n) ? n : 'Main';
  }

  // Statusleiste und Hintergrund nehmen die Farbe des Screens an, damit kein Rand sichtbar bleibt
  function syncBars() {
    if (document.querySelector('#app > [role=status][style*="z-index:60"]')) return;
    const root = host.firstElementChild; if (!root) return;
    const bg = getComputedStyle(root).backgroundColor;
    document.documentElement.style.background = bg; document.body.style.background = bg;
    const m = document.querySelector('meta[name=theme-color]'); if (m) m.setAttribute('content', bg);
  }
  try { matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => setTimeout(syncBars, 50)); } catch (e) {}

  // Notlösung, wenn gar keine Daten ankommen: große Meldung über allem (Ticket-Safe und Scan bleiben erreichbar)
  const NO_OUTAGE = ['Ticket', 'Scan', 'Onboarding1', 'Onboarding2', 'Onboarding3'];
  let outageEl = null, retrying = false;
  function syncOutage() {
    const on = !!R.outage && !NO_OUTAGE.includes(currentName);
    if (!on) {
      if (outageEl) { outageEl.remove(); outageEl = null; syncBars(); }
      return;
    }
    if (!outageEl) {
      outageEl = document.createElement('div');
      outageEl.setAttribute('role', 'alert');
      outageEl.style.cssText = 'position:absolute;inset:0;z-index:50;background:#F9D6D2;color:#1C1A1A;font-family:"Instrument Sans","Helvetica Neue",Arial,sans-serif;display:flex;flex-direction:column;padding:calc(28px + env(safe-area-inset-top)) 24px calc(28px + env(safe-area-inset-bottom));box-sizing:border-box';
      outageEl.innerHTML =
        '<div style="flex:1;min-height:0;display:flex;flex-direction:column;justify-content:center;gap:18px">' +
        '<svg width="120" height="120" viewBox="0 0 64 64" fill="none" stroke="#1C1A1A" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M52 22a8 8 0 0 1-10-10 22 22 0 1 0 10 10z" fill="#fff"></path><circle cx="24" cy="30" r="2" fill="#1C1A1A"></circle><circle cx="34" cy="42" r="2" fill="#1C1A1A"></circle><circle cx="22" cy="44" r="1.5" fill="#1C1A1A"></circle><circle cx="40" cy="30" r="1.5" fill="#1C1A1A"></circle></svg>' +
        '<h1 style="margin:0;font-size:60px;line-height:.95;font-weight:700;letter-spacing:-0.05em">Sorry!</h1>' +
        '<p style="margin:0;font-size:22px;font-weight:600;line-height:1.3">Momentan erreicht uns kein einziger Krümel. Probier es später noch einmal.</p>' +
        '</div>' +
        '<div style="display:flex;flex-direction:column;gap:10px">' +
        '<button type="button" data-retry style="min-height:64px;border:0;border-radius:999px;background:#1C1A1A;color:#fff;font-size:19px;font-weight:700;font-family:inherit;cursor:pointer">Nochmal versuchen</button>' +
        '<a href="/Ticket" data-ticket style="min-height:56px;display:flex;align-items:center;justify-content:center;border-radius:999px;border:1.5px solid #1C1A1A;font-size:17px;font-weight:700">Zum Ticket-Safe</a>' +
        '</div>';
      document.getElementById('app').appendChild(outageEl);
      outageEl.querySelector('[data-retry]').addEventListener('click', async (e) => {
        if (retrying) return; retrying = true; const b = e.currentTarget; b.textContent = 'Einen Moment …'; b.setAttribute('aria-busy', 'true');
        try { await R.refresh(); } finally { retrying = false; if (outageEl) { b.textContent = 'Nochmal versuchen'; b.removeAttribute('aria-busy'); } }
      });
      outageEl.querySelector('[data-ticket]').addEventListener('click', (e) => { e.preventDefault(); go('/Ticket', true); });
    }
    document.documentElement.style.background = document.body.style.background = '#F9D6D2';
    const m = document.querySelector('meta[name=theme-color]'); if (m) m.setAttribute('content', '#F9D6D2');
  }

  // Beta-Hinweis: bei jedem Start 3 Sekunden, Tippen überspringt
  const BG_SPLASH = '#EAF6CF';
  function splash() {
    const el = document.getElementById('splash');
    if (!el) return;
    if (flag('rego.splashSeen')) { el.remove(); return; }      // Beta-Hinweis nur beim allerersten Start
    flag('rego.splashSeen', true);
    const v = document.getElementById('splash-ver'); if (v && R.version) v.textContent = R.version;
    document.documentElement.style.background = document.body.style.background = BG_SPLASH;
    const m = document.querySelector('meta[name=theme-color]'); if (m) m.setAttribute('content', BG_SPLASH);
    let gone = false;
    const close = () => {
      if (gone) return; gone = true; el.style.opacity = '0'; el.style.pointerEvents = 'none';
      setTimeout(() => { el.remove(); outageEl ? syncOutage() : syncBars(); }, 380);
    };
    el.addEventListener('click', close);
    setTimeout(close, 3000);
  }

  async function show(name) {
    const my = ++token;
    if (current) { window.RLOG && RLOG('destroy ' + currentName); current.destroy(); }
    const m = await window.DC.mount(name, host, styleEl);
    if (my !== token) { m.destroy(); return; }
    current = m; currentName = name; window.RLOG && RLOG('mount ' + name);
    document.title = TITLES[name] || 'ReGo';
    syncBars();
    syncOutage();
    host.scrollTop = 0;
  }

  async function go(url, push = true) {
    const u = new URL(url, location.href);
    let name = routeOf(u.pathname);
    // Ende des Onboardings: gewählte Strecke anlegen
    if (name === 'Main' && window.REGO_pending && !R.tours.length) {
      const p = window.REGO_pending; window.REGO_pending = null; flag('rego.onboarded', true);
      try { await R.actions.addTour({ from: p.from, to: p.to, days: ['Mo', 'Di', 'Mi', 'Do', 'Fr'], time: '07:00', trip: p.trip, backTime: '16:30' }); } catch (e) { /* Dashboard zeigt dann den Leerzustand */ }
    }
    if (name === 'Main' && R.tours.length) flag('rego.onboarded', true);
    if (push) history.pushState(null, '', u.pathname === '/index.html' ? '/' : u.pathname + u.hash); else if (u.hash !== location.hash) history.replaceState(null, '', u.pathname + u.hash);
    await show(name);
  }

  document.addEventListener('click', (e) => {
    const a = e.target.closest && e.target.closest('a[href]');
    if (!a || e.defaultPrevented || e.metaKey || e.ctrlKey || e.button) return;
    const h = a.getAttribute('href');
    if (h === '#' || h === '') { e.preventDefault(); return; }
    if (/^[A-Za-z0-9]+\.dc\.html(#.*)?$/.test(h)) { e.preventDefault(); go('/' + h.replace('.dc.html', ''), true); }
  });
  window.addEventListener('popstate', () => go(location.href, false));

  R.navigate = (url) => go(url, true);
  R.onChange = () => {
    syncOutage();
    if (!current) return;
    current.update();
    if (typeof current.instance.onData === 'function') current.instance.onData();
  };

  // Standort nur nutzen, wenn schon erlaubt (kein Dialog beim Start). Letzten Standort merken, bei jedem Öffnen der App neu holen.
  try { const c = JSON.parse(localStorage.getItem('rego.pos') || 'null'); if (c && c.lat && Date.now() - c.at < 12 * 3600 * 1000) R.position = { lat: c.lat, lon: c.lon }; } catch (e) {}
  const locate = () => {
    try {
      navigator.permissions && navigator.permissions.query({ name: 'geolocation' }).then((p) => {
        if (p.state !== 'granted') return;
        navigator.geolocation.getCurrentPosition((pos) => {
          const n = { lat: pos.coords.latitude.toFixed(2), lon: pos.coords.longitude.toFixed(2) };
          const changed = !R.position || R.position.lat !== n.lat || R.position.lon !== n.lon;
          R.position = n; try { localStorage.setItem('rego.pos', JSON.stringify({ ...n, at: Date.now() })); } catch (e) {}
          if (changed) R.refresh();
        }, () => {}, { maximumAge: 600000, timeout: 20000 });
      });
    } catch (e) {}
  };
  locate();

  R.loadCached();
  splash();
  go(location.href, false).then(() => R.refresh());

  const tick = () => { if (document.visibilityState === 'visible') R.refresh(); };
  setInterval(tick, 30000);
  document.addEventListener('visibilitychange', () => { tick(); if (document.visibilityState === 'visible') locate(); });
  window.addEventListener('online', tick);
  window.addEventListener('offline', () => R.onChange());

  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
})();
