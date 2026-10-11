import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { config } from './config.mjs';
import { createService } from './service.mjs';
import { loadVapid } from './push.mjs';
import { createNotifier } from './notifier.mjs';
import { ProfileStore, ValidationError, addTours, patchTour, deleteTour, setSettings, replaceProfile, DEVICE_RE } from './store/profile.mjs';

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
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...(cfg.corsOrigin ? { 'access-control-allow-origin': cfg.corsOrigin, 'access-control-allow-headers': 'content-type,x-device', 'access-control-allow-methods': 'GET,POST,PATCH,PUT,DELETE,OPTIONS' } : {}), ...headers });
    res.end(data);
  };
  const readBody = (req) => new Promise((resolve, reject) => {
    let n = 0; const chunks = [];
    req.on('data', (c) => { n += c.length; if (n > 64 * 1024) { reject(new ValidationError('Anfrage zu groß')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch { reject(new ValidationError('Kein gültiges JSON')); } });
    req.on('error', reject);
  });
  const device = (req, url) => {
    const d = req.headers['x-device'] || url.searchParams.get('device') || '';
    if (!DEVICE_RE.test(d)) throw new ValidationError('Header X-Device fehlt oder ist ungültig (16–64 Zeichen: A–Z a–z 0–9 _ -)');
    return d;
  };

  async function api(req, res, url) {
    const path = url.pathname, m = req.method;
    if (m === 'OPTIONS') return send(res, 204, '');
    if (path === '/api/health' && m === 'GET') return send(res, 200, { ok: true, provider: cfg.provider, time: new Date(now()).toISOString() });
    if (path === '/api/stations' && m === 'GET') {
      try { return send(res, 200, { stations: await service.searchStations(url.searchParams.get('q')) }); }
      catch (e) { return send(res, 502, { error: 'Haltestellensuche gerade nicht erreichbar', detail: e.message }); }
    }
    const dev = device(req, url);
    if (path === '/api/state' && m === 'GET') return send(res, 200, await service.getState(dev, { lat: url.searchParams.get('lat'), lon: url.searchParams.get('lon') }));
    if (path === '/api/profile' && m === 'GET') return send(res, 200, await store.load(dev));
    if (path === '/api/profile' && m === 'PUT') { const b = await readBody(req); return send(res, 200, await store.update(dev, (p) => replaceProfile(p, b))); }
    if (path === '/api/tours' && m === 'POST') { const b = await readBody(req); const created = await store.update(dev, (p) => addTours(p, b)); return send(res, 201, { tours: created }); }
    const tm = path.match(/^\/api\/tours\/([\w-]{1,32})$/);
    if (tm && m === 'PATCH') { const b = await readBody(req); return send(res, 200, await store.update(dev, (p) => patchTour(p, tm[1], b))); }
    if (tm && m === 'DELETE') return send(res, 200, await store.update(dev, (p) => deleteTour(p, tm[1])));
    if (path === '/api/settings' && m === 'PUT') { const b = await readBody(req); return send(res, 200, await store.update(dev, (p) => setSettings(p, b))); }
    if (path === '/api/push/key' && m === 'GET') return send(res, 200, { publicKey: (await vapid()).publicKey });
    if (path === '/api/notifications' && m === 'GET') return send(res, 200, { notifications: await (await notifier()).takeOutbox(dev) });
    if (path === '/api/push/test' && m === 'POST') { await (await notifier()).sendTest(dev); return send(res, 200, { ok: true }); }
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
    let rel = normalize(decodeURIComponent(url.pathname)).replace(/^([/\\])+/, '');
    if (rel.split(/[/\\]/).includes('..')) return send(res, 403, { error: 'verboten' });
    let file = join(cfg.publicDir, rel || 'index.html');
    try { if ((await stat(file)).isDirectory()) file = join(file, 'index.html'); }
    catch { if (extname(rel)) return send(res, 404, { error: 'Nicht gefunden' }); file = join(cfg.publicDir, 'index.html'); }   // Pfade ohne Endung gehören der App (Router)
    try {
      const body = await readFile(file);
      res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache' });
      res.end(body);
    } catch { send(res, 404, { error: 'Nicht gefunden' }); }
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (cfg.verbose) { const t0 = Date.now(); res.on('finish', () => { const ms = Date.now() - t0; if (ms >= 400) console.log(`langsam: ${req.method} ${url.pathname} ${res.statusCode} ${ms} ms`); }); }
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
  return { server, service, store, notifier };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { server, notifier } = createApp();
  server.listen(config.port, config.host, () => console.log(`ReGo-Backend läuft auf http://${config.host}:${config.port} (Quelle: ${config.provider})`));
  if (config.notifyEverySec > 0) setInterval(async () => { try { await (await notifier()).tick(); } catch (e) { console.error('Push-Prüfung:', e.message); } }, config.notifyEverySec * 1000).unref();
}
