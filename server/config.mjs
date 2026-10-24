// Configuration through environment variables. Everything has a sensible default.
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const env = process.env;

/**
 * Newest version of the Android app that can be downloaded (GitHub Releases, tag app-v<version>). The app reports its version with every state
 * request and is pointed to the update if it is older. The server version does not tell: server-only releases build no APK.
 * Set this to the release version whenever a release changes `public/` or `android/`. The APK build (apk.yml) stops with a message when it is
 * about to publish a new app version while this still names another one.
 */
export const APP_LATEST = '0.8.13';

/** Where testers send feedback: an email address or a web link (http/https). Anything else, or nothing, gives "" (the app then uses the GitHub issue form). */
export function contactOf(value) {
  const s = String(value ?? '').trim().replace(/^mailto:/i, '');
  if (!s || s.length > 120 || /[\s<>"'`\\\u0000-\u001f]/.test(s)) return '';
  if (/^[^\s@/:?#&%]+@[^\s@/:?#&%]+\.[^\s@/:?#&%.]{2,}$/.test(s)) return s;
  try { const u = new URL(s); return /^https?:$/.test(u.protocol) && u.hostname.includes('.') ? u.href : ''; } catch { return ''; }
}

export const config = {
  root,
  port: Number(env.PORT || 8080),
  host: env.HOST || '127.0.0.1',            // local only; for access from the LAN: HOST=0.0.0.0
  dataDir: resolve(env.REGO_DATA || `${root}/data`),
  publicDir: resolve(env.REGO_PUBLIC || `${root}/public`),
  // 'library' = real data (EFA and hafas-client directly, Deutsche Bahn through transport.rest), 'transport-rest' = ÖBB and DB through transport.rest, 'mock' = sample data without network
  provider: env.REGO_PROVIDER || 'library',
  upstream: {
    db: env.REGO_DB_URL || 'https://v6.db.transport.rest',
    oebb: env.REGO_OEBB_URL || 'https://v6.oebb.transport.rest',
    // Regional transport associations (EFA). The key is the prefix of the stop IDs. Add further associations here.
    efa: [{ key: 'mvv', url: env.REGO_MVV_URL || 'https://efa.mvv-muenchen.de/ng' }, { key: 'moby', url: env.REGO_MOBY_URL || 'https://bahnland-bayern.de/efa' }],
    userAgent: env.REGO_UA || 'ReGo (+https://github.com/K0RBI02/ReGo)',
    timeoutMs: Number(env.REGO_TIMEOUT_MS || 8000),
    retries: Number(env.REGO_RETRIES || 2),
  },
  // Cache lifetimes in seconds
  ttl: { search: 24 * 3600, stop: 24 * 3600, journeys: 30, state: 15, idle: 600 },       // idle: push check, routes that cannot push right now
  staleMaxSec: { journeys: 30 * 60 },       // if a source fails, trips are shown from the cache for this long at most
  tourDeadlineMs: Number(env.REGO_TOUR_DEADLINE_MS || 12000),   // a tour waits at most this long for its data
  mapBudgetMs: 5000,                        // and this long for looking up further lines for the map
  // A delay of at least this many minutes creates an incident
  incidentMinDelay: 3,
  inviteCode: String(env.REGO_INVITE || '').trim(),          // set: new devices need this invitation code (known devices keep working)
  contact: contactOf(env.REGO_CONTACT),                      // feedback address for testers (email or link), delivered to known devices with the state
  appLatest: APP_LATEST,                                     // newest downloadable app version, see above
  appReleaseUrl: 'https://github.com/K0RBI02/ReGo/releases/tag/app-v',
  limits: {},                                                // override the request limits (see guard.mjs), mainly for tests
  profileMaxAgeDays: Number(env.REGO_PROFILE_DAYS || 180),   // profiles of devices that have not made a request for this long are deleted
  notifyEverySec: Number(env.REGO_NOTIFY_SEC || 60),
  notifyIdleDays: Number(env.REGO_NOTIFY_IDLE_DAYS || 21),   // app devices that have not been heard from for this long are no longer checked
  maxProfiles: Number(env.REGO_MAX_PROFILES || 2000),        // upper limit for the number of device profiles
  verbose: env.REGO_VERBOSE === '1',        // write source errors to the log
  corsOrigin: env.REGO_CORS || '',          // e.g. http://localhost:5173 while working on the frontend
};
