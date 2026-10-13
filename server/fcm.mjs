// Firebase Cloud Messaging (HTTP v1) ohne Fremdbibliothek. Gesendet wird nur ein leerer Anstoß ("data"),
// den Text holt die App danach selbst von diesem Server (/api/notifications). Es verlässt also kein Meldungstext den Server Richtung Google.
import { createPrivateKey, sign } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const b64u = (x) => Buffer.from(x).toString('base64url');

export async function loadFcmKey(dataDir, env = process.env) {
  try {
    if (env.REGO_FCM_KEY && env.REGO_FCM_KEY.trim().startsWith('{')) return JSON.parse(env.REGO_FCM_KEY);
    return JSON.parse(await readFile(join(dataDir, 'fcm.json'), 'utf8'));
  } catch { return null; }
}

export function createFcm(key, { fetchFn = fetch, now = () => Date.now(), log = () => {} } = {}) {
  if (!key?.private_key || !key?.client_email || !key?.project_id) return { enabled: false, send: async () => 'off' };
  let tok = null, exp = 0;
  async function accessToken() {
    if (tok && now() < exp - 60e3) return tok;
    const iat = Math.floor(now() / 1000);
    const head = b64u(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
    const body = b64u(JSON.stringify({ iss: key.client_email, scope: 'https://www.googleapis.com/auth/firebase.messaging', aud: 'https://oauth2.googleapis.com/token', iat, exp: iat + 3600 }));
    const sig = sign('RSA-SHA256', Buffer.from(`${head}.${body}`), createPrivateKey(key.private_key));
    const r = await fetchFn('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${head}.${body}.${b64u(sig)}` }) });
    if (!r.ok) throw new Error(`FCM-Anmeldung ${r.status}`);
    const j = await r.json(); tok = j.access_token; exp = now() + (j.expires_in || 3600) * 1000;
    return tok;
  }
  return {
    enabled: true,
    // 'ok' | 'gone' (Token ungültig) | 'error'
    async send(token) {
      try {
        const r = await fetchFn(`https://fcm.googleapis.com/v1/projects/${key.project_id}/messages:send`, {
          method: 'POST', headers: { authorization: `Bearer ${await accessToken()}`, 'content-type': 'application/json' },
          body: JSON.stringify({ message: { token, data: { n: '1' }, android: { priority: 'HIGH', ttl: '3600s' } } }) });
        if (r.ok) return 'ok';
        if (r.status === 404 || r.status === 400) { const t = await r.text(); if (/UNREGISTERED|NOT_FOUND|INVALID_ARGUMENT/.test(t)) return 'gone'; log('FCM', r.status, t.slice(0, 200)); return 'error'; }
        log('FCM', r.status); tok = null; return 'error';
      } catch (e) { log('FCM-Fehler', e.message); return 'error'; }
    },
  };
}
