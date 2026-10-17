/* Router + start. Paths: /  /Strecken  /Ticket  /Detail#<id>  /Meldungen  /Scan  /Onboarding1..3 */
(function () {
  const R = window.REGO;
  const SCREENS = ['Main', 'Meldungen', 'Detail', 'Ticket', 'Scan', 'Strecken', 'Onboarding1', 'Onboarding2', 'Onboarding3'];
  const TITLES = { Main: 'ReGo', Meldungen: 'Meldungen', Detail: 'Meldung', Ticket: 'Ticket', Scan: 'Ticket hinzufügen', Strecken: 'Strecken', Onboarding1: 'Willkommen', Onboarding2: 'Willkommen', Onboarding3: 'Willkommen' };
  const host = document.getElementById('screen'), styleEl = document.getElementById('screen-style');
  let current = null, currentName = '', token = 0, mounted = 0;
  const flag = (k, v) => { try { if (v === undefined) return localStorage.getItem(k) === '1'; localStorage.setItem(k, v ? '1' : '0'); } catch (e) { return false; } };

  function routeOf(path) {
    const n = path.replace(/^\/+|\/+$/g, '').replace(/\.dc\.html$/, '');
    if (!n || n === 'index.html') return R.tours.length || flag('rego.onboarded') ? 'Main' : 'Onboarding1';
    return SCREENS.includes(n) ? n : 'Main';
  }

  // "rgb(247, 247, 247)" -> "#f7f7f7" (the status bar of the app and theme-color only understand the hex notation)
  const hexOf = (c) => { const m = /rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/.exec(c || ''); return m ? '#' + [m[1], m[2], m[3]].map((v) => Math.min(255, +v).toString(16).padStart(2, '0')).join('') : (c || ''); };
  // Page background, browser bar (theme-color) and, in the app, status and navigation bar. Usually one color; the detail page has the card on top and the white sheet below.
  function paint(color, bottom) {
    document.documentElement.style.background = color; document.body.style.background = color;
    const hex = hexOf(color), hexB = bottom ? hexOf(bottom) : hex;
    const m = document.querySelector('meta[name=theme-color]'); if (m) m.setAttribute('content', hex);
    try { const N = window.RegoNative; if (N) { if (N.setBarColors) N.setBarColors(hex, hexB); else N.setBars(hex); } } catch (e) {}
  }
  // Status bar and background take the color of the screen so that no edge stays visible.
  // If the screen starts with a surface of its own at the top (data-bar="top", e.g. the card of the detail page), the status bar gets its color and the lower bar the color of the background.
  function syncBars() {
    if (document.querySelector('#app > [role=status][style*="z-index:60"]')) return;
    if (inviteEl) { paint('#D4EDF6'); return; }
    if (outageEl) { paint('#F9D6D2'); return; }
    const root = host.firstElementChild; if (!root) return;
    const bottom = getComputedStyle(root).backgroundColor, top = root.querySelector('[data-bar=top]');
    paint(top ? getComputedStyle(top).backgroundColor : bottom, bottom);
  }
  try { matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => setTimeout(syncBars, 50)); } catch (e) {}

  // Fallback when no data arrives at all: a big message over everything (ticket safe and scan stay reachable)
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
    paint('#F9D6D2');
  }

  // Invitation code: the server only accepts new devices with a code. Until the code is right, this gate lies over everything.
  let inviteEl = null, inviteBusy = false;
  function syncInvite() {
    const on = !!(R.invite && R.invite.needed);
    if (!on) { if (inviteEl) { inviteEl.remove(); inviteEl = null; syncBars(); syncOutage(); } return; }
    if (inviteEl) { const e = inviteEl.querySelector('[data-err]'); if (e && R.invite.wrong && !e.textContent) e.textContent = 'Der Code stimmt nicht.'; return; }
    inviteEl = document.createElement('div');
    inviteEl.className = 'rg-gate'; inviteEl.setAttribute('role', 'dialog'); inviteEl.setAttribute('aria-label', 'Einladungscode');
    inviteEl.innerHTML =
      '<div class="rg-gate-main"><h1>Einladung</h1>' +
      '<p>Dieser ReGo-Server ist nicht öffentlich. Gib den Einladungscode ein, den du bekommen hast.</p>' +
      '<input data-code type="text" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="Einladungscode" aria-label="Einladungscode">' +
      '<div data-err role="alert" class="rg-gate-err"></div></div>' +
      '<button type="button" data-go>Weiter</button>';
    document.getElementById('app').appendChild(inviteEl);
    const input = inviteEl.querySelector('[data-code]'), err = inviteEl.querySelector('[data-err]'), btn = inviteEl.querySelector('[data-go]');
    if (R.invite.wrong) err.textContent = 'Der Code stimmt nicht.';
    const submit = async () => {
      if (inviteBusy) return;
      const code = input.value.trim();
      if (!code) { err.textContent = 'Bitte den Code eingeben.'; return; }
      inviteBusy = true; btn.textContent = 'Einen Moment …'; btn.setAttribute('aria-busy', 'true'); err.textContent = '';
      try { if (!(await R.setInvite(code))) err.textContent = 'Der Code stimmt nicht.'; }
      catch (e) { err.textContent = e && e.status === 429 ? e.message : 'Keine Verbindung zum Server. Bitte noch einmal versuchen.'; }
      finally { inviteBusy = false; if (inviteEl) { btn.textContent = 'Weiter'; btn.removeAttribute('aria-busy'); } }
    };
    btn.addEventListener('click', submit);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); submit(); } });
    paint('#D4EDF6');
  }
  R.onInvite = syncInvite;

  // Beta notice: 3 seconds at the very first start, a tap skips it
  const BG_SPLASH = '#EAF6CF';
  function splash() {
    const el = document.getElementById('splash');
    if (!el) return;
    if (flag('rego.splashSeen')) { el.remove(); return; }      // beta notice only at the very first start
    flag('rego.splashSeen', true);
    const v = document.getElementById('splash-ver'); if (v && R.version) v.textContent = R.version;
    paint(BG_SPLASH);
    let gone = false;
    const close = () => {
      if (gone) return; gone = true; el.style.opacity = '0'; el.style.pointerEvents = 'none';
      setTimeout(() => { el.remove(); outageEl ? syncOutage() : syncBars(); }, 380);
    };
    el.addEventListener('click', close);
    setTimeout(close, 3000);
  }

  // Mount pages one after the other: if someone navigates twice quickly, the older page must not finish later and overwrite the newer one
  let chain = Promise.resolve();
  function show(name) {
    const my = ++token;
    chain = chain.then(async () => {
      if (my !== token) return;                                 // a newer page has been requested in the meantime
      if (current) { window.RLOG && RLOG('destroy ' + currentName); current.destroy(); current = null; }
      const m = await window.DC.mount(name, host, styleEl);
      current = m; currentName = name; mounted = my; window.RLOG && RLOG('mount ' + name);
      document.title = TITLES[name] || 'ReGo';
      syncBars();
      syncOutage();
      syncInvite();
      host.scrollTop = 0;
    }).catch((e) => { window.RLOG && RLOG('Seite ' + name + ' nicht geladen: ' + (e && e.message)); });
    return chain;
  }

  async function go(url, push = true) {
    const u = new URL(url, location.href);
    let name = routeOf(u.pathname);
    // Back button with an open sheet: only the anchor changes. The page stays and closes the sheet itself (no rebuild, scroll and inputs stay).
    // Only if the current page really is the most recently requested one, otherwise the newer request wins as before.
    if (!push && current && name === currentName && mounted === token && typeof current.instance.onHash === 'function') { current.instance.onHash(u.hash); return; }
    // End of onboarding: create the chosen route
    if (name === 'Main' && window.REGO_pending && !R.tours.length) {
      const p = window.REGO_pending; window.REGO_pending = null; flag('rego.onboarded', true);
      R.lastAddError = '';
      const route = { from: p.from, to: p.to, days: ['Mo', 'Di', 'Mi', 'Do', 'Fr'], time: p.time || '07:00', until: p.until };
      try {
        try { await R.actions.addTour({ ...route, transfers: p.transfers ? 1 : 0 }); } catch (e) {
          if (!(e && e.status === 422 && e.code === 'no-direct')) throw e;
          // No direct connection: look for one with a transfer, like the "Neue Strecke" form does. Nobody confirms a preview during the setup, so a connection that is found is saved right away.
          const r = await R.actions.searchTransfer({ from: p.from, to: p.to });
          if (r && r.found === true) await R.actions.addTour({ ...route, transfers: 1 });
          else if (r && r.found === false) throw new Error(`${p.from} → ${p.to}: Mit weniger als 2 Umstiegen nicht erreichbar.`);
          else throw new Error('Sorry, gerade antwortet keine Quelle. Lege die Strecke gleich noch einmal an.');
        }
      } catch (e) { R.lastAddError = (e && e.message) || 'Die Strecke konnte nicht angelegt werden.'; /* the main screen shows the empty state with the reason */ }
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
  document.addEventListener('scroll', (e) => { const t = e.target; if (t && t.classList && (t.classList.contains('rg-dockpad') || t.classList.contains('rg-fade'))) t.classList.toggle('rg-scrolled', t.scrollTop > 4); }, true);
  window.addEventListener('popstate', () => go(location.href, false));

  R.navigate = (url) => go(url, true);
  R.onChange = () => {
    syncOutage();
    syncInvite();
    if (!current) return;
    current.update();
    if (typeof current.instance.onData === 'function') current.instance.onData();
    syncBars();                                    // the detail page changes its color at the top with the state (green, gray, black when "offline")
  };

  // Use the location only if already allowed (no dialog at start). Remember the last location, fetch it anew every time the app opens.
  try { const c = JSON.parse(localStorage.getItem('rego.pos') || 'null'); if (c && c.lat && Date.now() - c.at < 12 * 3600 * 1000) R.position = { lat: c.lat, lon: c.lon }; } catch (e) {}
  const fix = () => navigator.geolocation.getCurrentPosition((pos) => {
    const n = { lat: pos.coords.latitude.toFixed(2), lon: pos.coords.longitude.toFixed(2) };
    const changed = !R.position || R.position.lat !== n.lat || R.position.lon !== n.lon;
    R.position = n; try { localStorage.setItem('rego.pos', JSON.stringify({ ...n, at: Date.now() })); } catch (e) {}
    if (changed) R.refresh();
  }, () => {}, { maximumAge: 600000, timeout: 20000 });
  const locate = () => {
    try {
      // App: Android asks for permission itself the first time, afterwards it works silently
      if (window.RegoNative) { setTimeout(fix, 1200); return; }
      navigator.permissions && navigator.permissions.query({ name: 'geolocation' }).then((p) => {
        if (p.state === 'granted') { fix(); return; }
        // Never asked: ask once, as soon as there are at least two routes (only then "nearest first" helps)
        let asked = false; try { asked = !!localStorage.getItem('rego.posAsked'); } catch (e) {}
        if (p.state === 'prompt' && !asked) setTimeout(() => { if (R.tours && R.tours.filter((t) => t.active).length >= 2) { try { localStorage.setItem('rego.posAsked', '1'); } catch (e) {} fix(); } }, 3000);
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

  // Earlier browser versions created a service worker. It no longer exists: unregister it and clear its caches.
  if (!window.RegoNative && 'serviceWorker' in navigator) {
    navigator.serviceWorker.getRegistrations().then((rs) => {
      rs.forEach((r) => r.unregister());
      if (rs.length && window.caches) caches.keys().then((ks) => ks.filter((k) => /^rego-/.test(k)).forEach((k) => caches.delete(k)));
    }).catch(() => {});
  }
})();
