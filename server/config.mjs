// Konfiguration über Umgebungsvariablen. Alles hat einen sinnvollen Standard.
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const env = process.env;

export const config = {
  root,
  port: Number(env.PORT || 8080),
  host: env.HOST || '127.0.0.1',            // lokal; für Zugriff im LAN: HOST=0.0.0.0
  dataDir: resolve(env.REGO_DATA || `${root}/data`),
  publicDir: resolve(env.REGO_PUBLIC || `${root}/public`),
  // 'library' = echte Daten direkt (hafas-client / db-vendo-client), 'transport-rest' = über transport.rest, 'mock' = Beispieldaten ohne Netz
  provider: env.REGO_PROVIDER || 'library',
  upstream: {
    db: env.REGO_DB_URL || 'https://v6.db.transport.rest',
    oebb: env.REGO_OEBB_URL || 'https://v6.oebb.transport.rest',
    // Regionale Verbünde (EFA). Kürzel = Präfix der Haltestellen-IDs. Weitere Verbünde: hier eintragen.
    efa: [{ key: 'mvv', url: env.REGO_MVV_URL || 'https://efa.mvv-muenchen.de/ng' }, { key: 'moby', url: env.REGO_MOBY_URL || 'https://bahnland-bayern.de/efa' }],
    userAgent: env.REGO_UA || 'ReGo/0.1 (privates Hobbyprojekt)',
    timeoutMs: Number(env.REGO_TIMEOUT_MS || 8000),
    retries: Number(env.REGO_RETRIES || 2),
  },
  // Cache-Laufzeiten in Sekunden
  ttl: { search: 24 * 3600, stop: 24 * 3600, journeys: 30, state: 15 },
  // Ab dieser Verspätung (Minuten) entsteht eine Meldung
  incidentMinDelay: 3,
  vapidSubject: env.REGO_VAPID_SUBJECT || 'mailto:rego@localhost.invalid',
  notifyEverySec: Number(env.REGO_NOTIFY_SEC || 60),
  verbose: env.REGO_VERBOSE === '1',        // Fehler der Datenquelle ins Protokoll schreiben
  corsOrigin: env.REGO_CORS || '',          // z. B. http://localhost:5173 beim Frontend-Entwickeln
};
