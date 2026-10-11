// Web-Push ohne Fremdbibliothek: VAPID (RFC 8292) mit leerem Push. Der Service Worker holt den Text danach selbst
// vom Backend (/api/notifications). So verlässt kein Meldungstext das Gerät/Backend Richtung Push-Dienst.
import { generateKeyPairSync, createPrivateKey, createPublicKey, sign } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

const b64u = (buf) => Buffer.from(buf).toString('base64url');

export async function loadVapid(dataDir) {
  const file = join(dataDir, 'vapid.json');
  try { return JSON.parse(await readFile(file, 'utf8')); }
  catch {
    const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const jwk = privateKey.export({ format: 'jwk' });
    const pub = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')]);
    const v = { publicKey: b64u(pub), privateJwk: jwk };
    await mkdir(dataDir, { recursive: true });
    await writeFile(file, JSON.stringify(v), { mode: 0o600 });
    return v;
  }
}

export function vapidHeaders(vapid, endpoint, subject, nowSec = Math.floor(Date.now() / 1000)) {
  const aud = new URL(endpoint).origin;
  const head = b64u(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const body = b64u(JSON.stringify({ aud, exp: nowSec + 12 * 3600, sub: subject }));
  const key = createPrivateKey({ key: vapid.privateJwk, format: 'jwk' });
  const sig = sign('sha256', Buffer.from(`${head}.${body}`), { key, dsaEncoding: 'ieee-p1363' });
  return { authorization: `vapid t=${head}.${body}.${b64u(sig)}, k=${vapid.publicKey}`, ttl: '3600', urgency: 'high', 'content-length': '0' };
}

export function verifyJwt(jwt, publicKeyB64u) {
  const [h, b, s] = jwt.split('.');
  const raw = Buffer.from(publicKeyB64u, 'base64url');
  const key = createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: b64u(raw.subarray(1, 33)), y: b64u(raw.subarray(33, 65)) }, format: 'jwk' });
  return verifyP1363(`${h}.${b}`, Buffer.from(s, 'base64url'), key);
}
import { verify } from 'node:crypto';
function verifyP1363(data, sig, key) { return verify('sha256', Buffer.from(data), { key, dsaEncoding: 'ieee-p1363' }, sig); }

/** Leeren Push senden. Gibt 'ok' | 'gone' | 'error' zurück. */
export async function sendPush(vapid, subject, sub, fetchImpl = (...a) => globalThis.fetch(...a)) {
  try {
    const res = await fetchImpl(sub.endpoint, { method: 'POST', headers: vapidHeaders(vapid, sub.endpoint, subject), signal: AbortSignal.timeout(10000) });
    if (res.status === 404 || res.status === 410) return 'gone';
    return res.ok ? 'ok' : 'error';
  } catch { return 'error'; }
}
