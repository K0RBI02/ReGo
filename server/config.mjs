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
    userAgent: env.REGO_UA || 'ReGo (+https://github.com/K0RBI02/ReGo)',
    timeoutMs: Number(env.REGO_TIMEOUT_MS || 8000),
    retries: Number(env.REGO_RETRIES || 2),
  },
  // Cache-Laufzeiten in Sekunden
  ttl: { search: 24 * 3600, stop: 24 * 3600, journeys: 30, state: 15 },
  staleMaxSec: { journeys: 30 * 60 },       // bei Störung der Quelle zeigen wir Fahrten höchstens so lange aus dem Zwischenspeicher
  tourDeadlineMs: Number(env.REGO_TOUR_DEADLINE_MS || 12000),   // so lange wartet eine Strecke höchstens auf ihre Daten
  mapBudgetMs: 5000,                        // und so lange das Nachschlagen weiterer Linien für die Karte
  // Ab dieser Verspätung (Minuten) entsteht eine Meldung
  incidentMinDelay: 3,
  vapidSubject: env.REGO_VAPID_SUBJECT || 'mailto:rego@localhost.invalid',
  profileMaxAgeDays: Number(env.REGO_PROFILE_DAYS || 180),   // Profile von Geräten, die so lange nichts abgefragt haben, werden gelöscht
  notifyEverySec: Number(env.REGO_NOTIFY_SEC || 60),
  notifyIdleDays: Number(env.REGO_NOTIFY_IDLE_DAYS || 21),   // App-Geräte, von denen so lange nichts kam, werden nicht mehr geprüft
  maxProfiles: Number(env.REGO_MAX_PROFILES || 2000),        // Obergrenze für die Zahl der Geräte-Profile
  verbose: env.REGO_VERBOSE === '1',        // Fehler der Datenquelle ins Protokoll schreiben
  corsOrigin: env.REGO_CORS || '',          // z. B. http://localhost:5173 beim Frontend-Entwickeln
};
