import http from 'node:http';
import { readFile, stat, readdir } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { config } from './config.mjs';
import { createService } from './service.mjs';
import { loadVapid } from './push.mjs';
import { createNotifier } from './notifier.mjs';
import { ProfileStore, ValidationError, addTours, patchTour, deleteTour, setSettings, replaceProfile, DEVICE_RE } from './store/profile.mjs';

// Sicherheits-Header für alle Antworten. 'unsafe-eval'/'unsafe-inline' braucht der Screen-Lader (dc-lite), sonst nichts Fremdes.
const SEC = {
  'content-security-policy': "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; worker-src 'self' blob:; manifest-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'",
  'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'x-frame-options': 'DENY',
  'permissions-policy': 'camera=(self), geolocation=(self), microphone=(), payment=()',
};
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json', '.ico': 'image/x-icon' };

// Nur bekannte Push-Dienste der Browser; sonst könnte jemand das Backend Anfragen an beliebige Adressen schicken lassen.
const PUSH_HOSTS = [/^fcm\.googleapis\.com$/, /(^|\.)push\.services\.mozilla\.com$/, /(^|\.)push\.apple\.com$/, /(^|\.)notify\.windows\.com$/];
export function pushEndpointOk(ep) {
  try { const u = new URL(ep); return u.protocol === 'https:' && PUSH_HOSTS.some((r) => r.test(u.hostname)); } catch { return false; }
}

export function createApp({ cfg = config, now = () => Date.now(), service, store, pushSender } = {}) {
  store ||= new ProfileStore(cfg.dataDir, now);
  service ||= createService({ config: cfg, store, now });
  let vapidP, notifierP;
  const vapid = () => (vapidP ||= loadVapid(cfg.dataDir));
  const notifier = async () => (notifierP ||= vapid().then((v) => createNotifier({ config: cfg, store, service, vapid: v, now, ...(pushSender ? { send: pushSender } : {}) })));

  const send = (res, status, body, headers = {}) => {
    const data = typeof body === 'string' ? body : JSON.stringify(body);
    res.writeHead(status, { ...SEC, 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...(cfg.corsOrigin ? { 'access-control-allow-origin': cfg.corsOrigin, 'access-control-allow-headers': 'content-type,x-device', 'access-control-allow-methods': 'GET,POST,PATCH,PUT,DELETE,OPTIONS' } : {}), ...headers });
    res.end(data);
  };
  const readBody = (req) => new Promise((resolve, reject) => {
    let n = 0; const chunks = [];
    req.on('data', (c) => { n += c.length; if (n > 64 * 1024) { if (n - c.length <= 64 * 1024) { const e = new ValidationError('Anfrage zu groß'); e.status = 413; reject(e); } } else chunks.push(c); });
    req.on('end', () => { if (n > 64 * 1024) return; try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch { reject(new ValidationError('Kein gültiges JSON')); } });
    req.on('error', reject);
  });
  const device = (req, url) => {
    const d = req.headers['x-device'] || url.searchParams.get('device') || '';
    if (!DEVICE_RE.test(d)) throw new ValidationError('Header X-Device fehlt oder ist ungültig (16–64 Zeichen: A–Z a–z 0–9 _ -)');
    return d;
  };

  let versionP;
  const version = () => (versionP ||= (async () => { for (const f of [join(cfg.root, 'rego/config.yaml'), join(cfg.root, 'config.yaml')]) { try { const m = (await readFile(f, 'utf8')).match(/^version:\s*"?([^"\n]+)"?/m); if (m) return m[1].trim(); } catch { /* nächste Stelle */ } } return 'unbekannt'; })());
  const startedAt = now();
  async function status() {
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
    if (path === '/api/stations' && m === 'GET') {
      try { return send(res, 200, { stations: await service.searchStations(url.searchParams.get('q')) }); }
      catch (e) { return send(res, 502, { error: 'Haltestellensuche gerade nicht erreichbar', detail: e.message }); }
    }
    if (path === '/api/state' && m === 'GET') { store.touch(dev).catch(() => {}); return send(res, 200, await service.getState(dev, { lat: url.searchParams.get('lat'), lon: url.searchParams.get('lon') })); }
    if (path === '/api/profile' && m === 'GET') return send(res, 200, await store.load(dev));
    if (path === '/api/profile' && m === 'PUT') { const b = await readBody(req); return send(res, 200, await store.update(dev, (p) => replaceProfile(p, b))); }
    if (path === '/api/tours' && m === 'POST') { const b = await readBody(req); const created = await store.update(dev, (p) => addTours(p, b)); return send(res, 201, { tours: created }); }
    const tm = path.match(/^\/api\/tours\/([\w-]{1,32})$/);
    if (tm && m === 'PATCH') { const b = await readBody(req); return send(res, 200, await store.update(dev, (p) => patchTour(p, tm[1], b))); }
    if (tm && m === 'DELETE') return send(res, 200, await store.update(dev, (p) => deleteTour(p, tm[1])));
    if (path === '/api/settings' && m === 'PUT') { const b = await readBody(req); return send(res, 200, await store.update(dev, (p) => setSettings(p, b))); }
    if (path === '/api/push/key' && m === 'GET') return send(res, 200, { publicKey: (await vapid()).publicKey });
    if (path === '/api/notifications' && m === 'GET') return send(res, 200, { notifications: await (await notifier()).takeOutbox(dev) });
    if (path === '/api/push/test' && m === 'POST') {
      if (!(await store.load(dev)).push) { const e = new ValidationError('Kein Push-Abo für dieses Gerät. Push erst in der App aktivieren.'); e.status = 409; throw e; }
      await (await notifier()).sendTest(dev); return send(res, 200, { ok: true }); }
    if (path === '/api/push' && m === 'DELETE') { await store.update(dev, (p) => { p.push = null; }); return send(res, 200, { subscribed: false }); }
    if (path === '/api/push' && m === 'PUT') {
      const b = await readBody(req);
      if (!pushEndpointOk(b?.endpoint)) throw new ValidationError('Unbekannter Push-Dienst');
      const first = await store.update(dev, (p) => { const isNew = p.push?.endpoint !== b.endpoint; p.push = { endpoint: String(b.endpoint), keys: b.keys || null }; return isNew; });
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
      res.writeHead(200, { ...SEC, 'content-type': MIME[extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache' });
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
  const { server, notifier, store } = createApp();
  server.listen(config.port, config.host, () => console.log(`ReGo-Backend läuft auf http://${config.host}:${config.port} (Quelle: ${config.provider})`));
  const purge = () => store.purge(config.profileMaxAgeDays).then((n) => n && console.log(`Aufräumen: ${n} Profil(e) ohne Nutzung seit ${config.profileMaxAgeDays} Tagen gelöscht`)).catch((e) => console.error('Aufräumen:', e.message));
  purge(); setInterval(purge, 24 * 3600e3).unref();
  if (config.notifyEverySec > 0) setInterval(async () => { try { await (await notifier()).tick(); } catch (e) { console.error('Push-Prüfung:', e.message); } }, config.notifyEverySec * 1000).unref();
}
