// For the test phase with friends: where feedback goes (address from the add-on options), which app version a device runs,
// the update hint for older apps and the version counts on the status page.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server/index.mjs';
import { config, contactOf, APP_LATEST } from '../server/config.mjs';
import { cleanVersion, isNewer } from '../server/lib/version.mjs';
import { ProfileStore, defaultProfile } from '../server/store/profile.mjs';

const tmp = (n = 'rego-b-') => mkdtemp(join(tmpdir(), n));
const MH = { id: '8000261', name: 'München Hbf' }, FS = { id: '8002078', name: 'Freising' };

async function appOn(dir, cfg = {}) {
  const { server, store } = createApp({ cfg: { ...config, dataDir: dir, provider: 'mock', ...cfg } });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { server, store, base: `http://127.0.0.1:${server.address().port}` };
}
const hdr = (dev) => ({ 'x-device': dev, 'content-type': 'application/json' });

test('Feedback address: an email or a web link, nothing else', () => {
  assert.equal(contactOf('k0rbi02@proton.me'), 'k0rbi02@proton.me');
  assert.equal(contactOf('  Mailto:me@example.org '), 'me@example.org');
  assert.equal(contactOf('https://t.me/korbi'), 'https://t.me/korbi');
  assert.equal(contactOf('http://example.org/x?y=1'), 'http://example.org/x?y=1');
  for (const bad of ['', '   ', undefined, null, 'foo', 'a@b', 'a b@c.de', 'x@y.de?subject=1', '<a@b.de>', 'javascript:alert(1)', 'ftp://example.org/x', 'https://localhost/x', 'https://evil.example/"onmouseover="', `${'a'.repeat(120)}@example.org`]) {
    assert.equal(contactOf(bad), '', String(bad));
  }
});

test('Versions: only 1.2.3 counts, newer is compared by number, not by text', () => {
  assert.equal(cleanVersion('0.7.4'), '0.7.4'); assert.equal(cleanVersion(' 1.12.0 '), '1.12.0');
  for (const bad of ['', null, undefined, '0.7', '0.7.4.1', '0.7.4-beta', 'v0.7.4', '<script>', '1234.0.0', '0.7.x']) assert.equal(cleanVersion(bad), '', String(bad));
  assert.ok(isNewer('0.7.5', '0.7.4')); assert.ok(isNewer('0.10.0', '0.9.9')); assert.ok(isNewer('1.0.0', '0.99.99'));
  assert.ok(!isNewer('0.7.4', '0.7.4')); assert.ok(!isNewer('0.7.3', '0.7.4')); assert.ok(!isNewer('0.9.9', '0.10.0'));
  assert.ok(!isNewer('x', '0.7.4')); assert.ok(!isNewer('0.7.4', ''));
});

test('The newest app version noted in the server is a real version and never ahead of the server itself', async () => {
  const yaml = /^version:\s*"?([^"\n]+)"?/m.exec(await readFile(new URL('../rego/config.yaml', import.meta.url), 'utf8'))[1].trim();
  assert.equal(cleanVersion(APP_LATEST), APP_LATEST);
  assert.ok(!isNewer(APP_LATEST, yaml), `APP_LATEST ${APP_LATEST} is newer than the release ${yaml}`);
  assert.equal(config.appLatest, APP_LATEST);
});

test('State: delivers the feedback address; the update hint only to an older app that tells its version', async () => {
  const { server, base } = await appOn(await tmp(), { contact: 'beta@example.org', appLatest: '0.9.0' });
  const get = async (dev, q = '') => (await fetch(`${base}/api/state${q}`, { headers: hdr(dev) })).json();
  try {
    let s = await get('aelteresgeraet1234567', '?app=0.7.2');
    assert.equal(s.contact, 'beta@example.org');
    assert.deepEqual(s.app, { latest: '0.9.0', url: 'https://github.com/K0RBI02/ReGo/releases/tag/app-v0.9.0' });
    assert.equal(s.schemaVersion, 1); assert.ok(Array.isArray(s.tours));                      // the rest of the state is unchanged
    s = await get('aktuellesgeraet12345', '?app=0.9.0'); assert.ok(!('app' in s));            // up to date
    s = await get('neueresgeraet1234567', '?app=1.0.0'); assert.ok(!('app' in s));            // newer than the newest known (e.g. built by hand)
    s = await get('ohneversion123456789'); assert.ok(!('app' in s)); assert.equal(s.contact, 'beta@example.org');   // old app or browser: nothing to compare
    s = await get('kaputtegeraet12345678', '?app=abc'); assert.ok(!('app' in s));
    s = await get('kaputtegeraet12345678', '?app=0.7.2.1'); assert.ok(!('app' in s));
  } finally { server.close(); }
});

test('State: without an address the field is empty (the app then uses the GitHub form); a known newest version is optional', async () => {
  const { server, base } = await appOn(await tmp(), { contact: '', appLatest: '' });
  try {
    const s = await (await fetch(`${base}/api/state?app=0.1.0`, { headers: hdr('leeresgeraet123456789') })).json();
    assert.equal(s.contact, ''); assert.ok(!('app' in s));
  } finally { server.close(); }
});

test('The address and the update hint are not on the public status page, the version counts are', async () => {
  const { server, base, store } = await appOn(await tmp(), { contact: 'beta@example.org', appLatest: '0.9.0' });
  try {
    const dev = ['geraetA123456789012', 'geraetB123456789012', 'geraetC123456789012'];
    for (const d of dev) await fetch(`${base}/api/tours`, { method: 'POST', headers: hdr(d), body: JSON.stringify({ from: MH, to: FS }) });      // a profile only exists with a route
    await fetch(`${base}/api/state?app=0.7.2`, { headers: hdr(dev[0]) });
    await fetch(`${base}/api/state?app=0.7.2`, { headers: hdr(dev[1]) });
    await fetch(`${base}/api/state?app=0.8.0`, { headers: hdr(dev[2]) });
    for (const [d, v] of [[dev[0], '0.7.2'], [dev[1], '0.7.2'], [dev[2], '0.8.0']]) {            // noting the version happens next to the answer
      for (let i = 0; i < 60 && (await store.load(d)).app !== v; i++) await new Promise((r) => setTimeout(r, 50));
    }
    assert.equal((await store.load(dev[0])).app, '0.7.2'); assert.equal((await store.load(dev[2])).app, '0.8.0');
    const st = await (await fetch(`${base}/api/status`)).json();
    assert.deepEqual(st.apps, { '0.7.2': 2, '0.8.0': 1 });
    assert.equal(st.devices, 3);
    assert.ok(!JSON.stringify(st).includes('beta@example.org'));
    assert.ok(!('app' in st) && !('contact' in st));
  } finally { server.close(); }
});

test('Noting the app version: only for an existing profile, and it writes only when the version changes', async () => {
  const dir = await tmp();
  let t = 1_000_000;
  const store = new ProfileStore(dir, () => t);
  await store.noteApp('nochkeinprofil123456', '0.7.2');
  assert.equal(await store.has('nochkeinprofil123456'), false);                                // does not create a profile
  await store.update('profil1234567890123', (p) => { Object.assign(p, defaultProfile()); });
  await store.noteApp('profil1234567890123', '0.7.2');
  const first = (await store.load('profil1234567890123'));
  assert.equal(first.app, '0.7.2');
  t += 60_000;
  await store.noteApp('profil1234567890123', '0.7.2');                                         // same version: no write
  assert.equal((await store.load('profil1234567890123')).updatedAt, first.updatedAt);
  t += 60_000;
  await store.noteApp('profil1234567890123', '0.8.0');                                         // new version: written
  const second = await store.load('profil1234567890123');
  assert.equal(second.app, '0.8.0'); assert.ok(second.updatedAt > first.updatedAt);
  // after a restart (new store, same files) the same version is read once and not written again
  const again = new ProfileStore(dir, () => t + 120_000);
  await again.noteApp('profil1234567890123', '0.8.0');
  assert.equal((await again.load('profil1234567890123')).updatedAt, second.updatedAt);
  await again.noteApp('profil1234567890123', '');                                              // nothing to note
  await again.noteApp('profil1234567890123', undefined);
  assert.equal((await again.load('profil1234567890123')).app, '0.8.0');
});

test('A device the server does not know yet and without invitation code gets neither the address nor the hint', async () => {
  const { server, base } = await appOn(await tmp(), { inviteCode: 'geheim', contact: 'beta@example.org', appLatest: '0.9.0' });
  try {
    const r = await fetch(`${base}/api/state?app=0.7.2`, { headers: hdr('fremdesgeraet12345678') });
    assert.equal(r.status, 403);
    assert.ok(!(await r.text()).includes('beta@example.org'));
  } finally { server.close(); }
});
