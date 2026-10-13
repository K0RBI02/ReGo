import http from 'node:http';
import { readFile, stat, readdir } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { config } from './config.mjs';
import { createService } from './service.mjs';
import { loadVapid } from './push.mjs';
import { loadFcmKey, createFcm } from './fcm.mjs';
import { randomInt } from 'node:crypto';
import { createNotifier } from './notifier.mjs';
import { ProfileStore, ValidationError, addTours, patchTour, deleteTour, setSettings, replaceProfile, DEVICE_RE } from './store/profile.mjs';

// Sicherheits-Header für alle Antworten. 'unsafe-eval'/'unsafe-inline' braucht der Screen-Lader (dc-lite), sonst nichts Fremdes.
const SEC = {
  'content-security-policy': "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; worker-src 'self' blob:; manifest-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'",
  'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'x-frame-options': 'DENY',
  'permissions-policy': 'camera=(self), geolocation=(self), microphone=(), payment=()',
};
// Die Android-App lädt ihre Oberfläche von dieser virtuellen Adresse und fragt die API von dort ab.
const APP_ORIGINS = ['https://appassets.androidplatform.net'];
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json', '.ico': 'image/x-icon', '.ttf': 'font/ttf', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8' };

// Nur bekannte Push-Dienste der Browser; sonst könnte jemand das Backend Anfragen an beliebige Adressen schicken lassen.
const PUSH_HOSTS = [/^fcm\.googleapis\.com$/, /(^|\.)push\.services\.mozilla\.com$/, /(^|\.)push\.apple\.com$/, /(^|\.)notify\.windows\.com$/];
export function pushEndpointOk(ep) {
  try { const u = new URL(ep); return u.protocol === 'https:' && PUSH_HOSTS.some((r) => r.test(u.hostname)); } catch { return false; }
}

export function createApp({ cfg = config, now = () => Date.now(), service, store, pushSender, fcmClient } = {}) {
  store ||= new ProfileStore(cfg.dataDir, now, { maxProfiles: cfg.maxProfiles });
  service ||= createService({ config: cfg, store, now });
  let vapidP, notifierP;
  const vapid = () => (vapidP ||= loadVapid(cfg.dataDir));
  const fcmP = fcmClient ? Promise.resolve(fcmClient) : loadFcmKey(cfg.dataDir).then((k) => createFcm(k, { log: (...a) => cfg.verbose && console.log(...a) }));
  const notifier = async () => (notifierP ||= Promise.all([vapid(), fcmP]).then(([v, fcm]) => createNotifier({ config: cfg, store, service, vapid: v, fcm, now, ...(pushSender ? { send: pushSender } : {}) })));

  const corsFor = (origin) => (origin && (origin === cfg.corsOrigin || APP_ORIGINS.includes(origin))
    ? { 'access-control-allow-origin': origin, vary: 'origin', 'access-control-allow-headers': 'content-type,x-device', 'access-control-allow-methods': 'GET,POST,PATCH,PUT,DELETE,OPTIONS', 'access-control-max-age': '600' } : {});
  const send = (res, status, body, headers = {}) => {
    const data = typeof body === 'string' ? body : JSON.stringify(body);
    res.writeHead(status, { ...SEC, 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...corsFor(res.req?.headers?.origin), ...headers });
    res.end(data);
  };
  const readBody = (req) => new Promise((resolve, reject) => {
    let n = 0; const chunks = [];
    req.on('data', (c) => { n += c.length; if (n > 64 * 1024) { if (n - c.length <= 64 * 1024) { const e = new ValidationError('Anfrage zu groß'); e.status = 413; reject(e); } } else chunks.push(c); });
    req.on('end', () => {
      if (n > 64 * 1024) return;
      let b = {};
      try { if (chunks.length) b = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return reject(new ValidationError('Kein gültiges JSON')); }
      if (!b || typeof b !== 'object' || Array.isArray(b)) return reject(new ValidationError('Erwartet wird ein JSON-Objekt'));      // z. B. „null“ oder eine Zahl
      resolve(b);
    });
    req.on('error', reject);
  });
  const device = (req, url) => {
    const d = req.headers['x-device'] || url.searchParams.get('device') || '';
    if (!DEVICE_RE.test(d)) throw new ValidationError('Header X-Device fehlt oder ist ungültig (16–64 Zeichen: A–Z a–z 0–9 _ -)');
    return d;
  };

  let versionP;
  const version = () => (versionP ||= (async () => { for (const f of [join(cfg.root, 'rego/config.yaml'), join(cfg.root, 'config.yaml')]) { try { const m = (await readFile(f, 'utf8')).match(/^version:\s*"?([^"\n]+)"?/m); if (m) return m[1].trim(); } catch { /* nächste Stelle */ } } return 'unbekannt'; })());
  // Umzug auf ein neues Handy: Einmal-Code (10 Min.), der Strecken und Einstellungen aufs neue Gerät kopiert
  const transfers = new Map(); let claimFails = [];
  const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const newCode = () => Array.from({ length: 6 }, () => CODE_CHARS[randomInt(CODE_CHARS.length)]).join('');
  const startedAt = now();
  let statusCache = null;                                        // Statusseite ist öffentlich: höchstens alle 30 s die Profile durchzählen
  const status = async () => {
    if (statusCache && now() - statusCache.at < 30e3) return { ...statusCache.value, uptimeMin: Math.round((now() - startedAt) / 60000), time: new Date(now()).toISOString() };
    const value = await statusNow(); statusCache = { at: now(), value }; return value;
  };
  async function statusNow() {
    let devices = 0, pushes = 0;
    try { for (const f of await readdir(join(cfg.dataDir, 'profiles'))) if (f.endsWith('.json')) { devices++; try { if ((await store.load(f.slice(0, -5))).push) pushes++; } catch { /* beschädigte Datei überspringen */ } } } catch { /* noch keine Profile */ }
    const p = service.providers;
    const sources = [...(p?.efas || []), p?.db, p?.oebb].filter(Boolean).map((c) => ({ name: c.name || c.key || '?', ok: c.healthy ? c.healthy() !== false : null }));
    return { version: await version(), provider: cfg.provider, uptimeMin: Math.round((now() - startedAt) / 60000), devices, pushSubscriptions: pushes, sources, time: new Date(now()).toISOString() };
  }

  async function api(req, res, url) {
    const path = url.pathname, m = req.method;
    if (m === 'OPTIONS') return send(res, 204, '');
    if (path === '/api/health' && m === 'GET') return send(res, 200, { ok: true, provider: cfg.provider, time: new Date(now()).toISOString() });
    if (path === '/api/status' && m === 'GET') return send(res, 200, await status());
    const dev = device(req, url);
    store.seen(dev).catch(() => {});                                // „zuletzt gesehen“ für Aufräumen und Leerlauf-Erkennung
    if (path === '/api/stations' && m === 'GET') {
      try { return send(res, 200, { stations: await service.searchStations(url.searchParams.get('q')) }); }
      catch (e) { return send(res, 502, { error: 'Haltestellensuche gerade nicht erreichbar', detail: e.message }); }
    }
    if (path === '/api/state' && m === 'GET') return send(res, 200, await service.getState(dev, { lat: url.searchParams.get('lat'), lon: url.searchParams.get('lon') }));
    if (path === '/api/profile' && m === 'GET') return send(res, 200, await store.load(dev));
    if (path === '/api/profile' && m === 'PUT') { const b = await readBody(req); return send(res, 200, await store.update(dev, (p) => replaceProfile(p, b))); }
    if (path === '/api/tours' && m === 'POST') { const b = await readBody(req); const created = await store.update(dev, (p) => addTours(p, b)); return send(res, 201, { tours: created }); }
    const tm = path.match(/^\/api\/tours\/([\w-]{1,32})$/);
    if (tm && m === 'PATCH') { const b = await readBody(req); return send(res, 200, await store.update(dev, (p) => patchTour(p, tm[1], b))); }
    if (tm && m === 'DELETE') return send(res, 200, await store.update(dev, (p) => deleteTour(p, tm[1])));
    if (path === '/api/transfer' && m === 'POST') {
      for (const [c, v] of transfers) if (v.exp < now() || v.device === dev) transfers.delete(c);
      if (transfers.size >= 500) { const e = new ValidationError('Gerade sind zu viele Codes offen. Bitte in ein paar Minuten noch einmal versuchen.'); e.status = 429; throw e; }
      let code; do { code = newCode(); } while (transfers.has(code));
      transfers.set(code, { device: dev, exp: now() + 10 * 60e3 });
      return send(res, 200, { code, minutes: 10 });
    }
    if (path === '/api/transfer/claim' && m === 'POST') {
      const b = await readBody(req);
      claimFails = claimFails.filter((t) => t > now() - 60e3);
      if (claimFails.length >= 10) { const e = new ValidationError('Zu viele Versuche. Bitte eine Minute warten.'); e.status = 429; throw e; }
      const code = String(b.code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
      const t = transfers.get(code);
      if (!t || t.exp < now()) { claimFails.push(now()); const e = new ValidationError('Code ungültig oder abgelaufen'); e.status = 404; throw e; }
      if (t.device === dev) throw new ValidationError('Das ist dieses Gerät. Gib den Code auf dem neuen Handy ein.');
      transfers.delete(code);
      const src = await store.load(t.device);
      const n = await store.update(dev, (p) => { p.tours = JSON.parse(JSON.stringify(src.tours)); p.settings = { ...p.settings, ...src.settings }; return p.tours.length; });
      return send(res, 200, { tours: n });
    }
    if (path === '/api/settings' && m === 'PUT') { const b = await readBody(req); return send(res, 200, await store.update(dev, (p) => setSettings(p, b))); }
    if (path === '/api/push/key' && m === 'GET') return send(res, 200, { publicKey: (await vapid()).publicKey });
    if (path === '/api/notifications' && m === 'GET') return send(res, 200, { notifications: await (await notifier()).takeOutbox(dev) });
    if (path === '/api/push/test' && m === 'POST') {
      if (!(await store.load(dev)).push) { const e = new ValidationError('Kein Push-Abo für dieses Gerät. Push erst in der App aktivieren.'); e.status = 409; throw e; }
      await (await notifier()).sendTest(dev); return send(res, 200, { ok: true }); }
    if (path === '/api/push/native' && m === 'PUT') { const body = await readBody(req).catch(() => ({})); const fcm = await fcmP; await store.update(dev, (p) => { p.push = { native: true, ...(typeof body?.token === 'string' && body.token.length > 20 && body.token.length < 400 ? { fcm: body.token } : {}) }; }); return send(res, 200, { subscribed: true, native: true, instant: !!(body?.token && fcm.enabled) }); }
    if (path === '/api/push' && m === 'DELETE') { await store.update(dev, (p) => { p.push = null; }); return send(res, 200, { subscribed: false }); }
    if (path === '/api/push' && m === 'PUT') {
      const b = await readBody(req);
      if (!pushEndpointOk(b?.endpoint)) throw new ValidationError('Unbekannter Push-Dienst');
      const k = b.keys, keys = k && typeof k.p256dh === 'string' && typeof k.auth === 'string' && k.p256dh.length < 200 && k.auth.length < 100 ? { p256dh: k.p256dh, auth: k.auth } : null;
      const first = await store.update(dev, (p) => { const isNew = p.push?.endpoint !== b.endpoint; p.push = { endpoint: String(b.endpoint), keys }; return isNew; });
      if (first === true) (await notifier()).sendTest(dev).catch(() => {});
      return send(res, 200, { subscribed: true });
    }
    if (path === '/api/profile' && m === 'DELETE') { await store.remove(dev); return send(res, 200, { deleted: true }); }
    return send(res, 404, { error: 'Unbekannter Pfad' });
  }

  async function serveStatic(req, res, url) {
    let decoded; try { decoded = decodeURIComponent(url.pathname); } catch { return send(res, 400, { error: 'Ungültige Adresse' }); }
    let rel = normalize(decoded === '/status' ? '/status.html' : decoded).replace(/^([/\\])+/, '');
    if (rel.split(/[/\\]/).includes('..')) return send(res, 403, { error: 'verboten' });
    let file = join(cfg.publicDir, rel || 'index.html');
    try { if ((await stat(file)).isDirectory()) file = join(file, 'index.html'); }
    catch { if (extname(rel)) return send(res, 404, { error: 'Nicht gefunden' }); file = join(cfg.publicDir, 'index.html'); }   // Pfade ohne Endung gehören der App (Router)
    try {
      const body = await readFile(file);
      // Schriften ändern sich nie: eine Woche zwischenspeichern spart bei jedem Start 140 KB Mobilfunk; alles andere wird immer neu geprüft
      res.writeHead(200, { ...SEC, 'content-type': MIME[extname(file)] || 'application/octet-stream', 'cache-control': /^\.(ttf|woff2)$/.test(extname(file)) ? 'public, max-age=604800' : 'no-cache' });
      res.end(body);
    } catch { send(res, 404, { error: 'Nicht gefunden' }); }
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (cfg.verbose) { const t0 = Date.now(); res.on('finish', () => { const ms = Date.now() - t0; if (ms >= 400 || (url.pathname.startsWith('/api/') && res.statusCode >= 400)) console.log(`${res.statusCode >= 400 ? 'Fehlerantwort' : 'langsam'}: ${req.method} ${url.pathname} ${res.statusCode} ${ms} ms`); }); }
    try {
      if (url.pathname.startsWith('/api/')) await api(req, res, url);
      else if (req.method === 'GET' || req.method === 'HEAD') await serveStatic(req, res, url);
      else send(res, 405, { error: 'Methode nicht erlaubt' });
    } catch (e) {
      if (e instanceof ValidationError) return send(res, e.status || 400, { error: e.message });
      console.error(e);
      if (!res.headersSent) send(res, 500, { error: 'Interner Fehler' });
    }
  });
  server.notifier = notifier;
  return { server, service, store, notifier, status };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  // Ein vergessener Fehler in einem Hintergrundvorgang soll das Backend nicht beenden
  process.on('unhandledRejection', (e) => console.error('Unbehandelter Fehler:', e));
  process.on('uncaughtException', (e) => console.error('Unerwarteter Fehler:', e));
  const { server, notifier, store } = createApp();
  server.listen(config.port, config.host, () => console.log(`ReGo-Backend läuft auf http://${config.host}:${config.port} (Quelle: ${config.provider})`));
  const purge = () => store.purge(config.profileMaxAgeDays).then((n) => n && console.log(`Aufräumen: ${n} Profil(e) ohne Nutzung seit ${config.profileMaxAgeDays} Tagen gelöscht`)).catch((e) => console.error('Aufräumen:', e.message));
  purge(); setInterval(purge, 24 * 3600e3).unref();
  if (config.notifyEverySec > 0) setInterval(async () => { try { await (await notifier()).tick(); } catch (e) { console.error('Push-Prüfung:', e.message); } }, config.notifyEverySec * 1000).unref();
}
