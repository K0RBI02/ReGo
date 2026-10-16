import test from 'node:test';
import assert from 'node:assert/strict';
import '../public/js/ticketcode.js';
const C = globalThis.RegoCode;

test('Aztec: message survives roundtrip (bits, stuffing, Reed-Solomon)', () => {
  for (const n of [1, 13, 40, 300, 1200]) {
    const b = Array.from({ length: n }, (_, i) => (i * 37 + 91 + (i % 5 ? i * 13 : 0)) & 255);
    assert.deepEqual(C.azDecodeForTest(C.azEncode(b)), b);
  }
});
test('QR: size grows with the data, too much data yields null', () => {
  assert.equal(C.qrEncode(Array(10).fill(65), 1).length, 21);
  assert.ok(C.qrEncode(Array(1500).fill(65), 0).length > 100);
  assert.equal(C.qrEncode(Array(4000).fill(65), 1), null);
});
test('Ticket data is read from text', async () => {
  const r = await C.parseTicket('Deutschlandticket 01.10.2026 - 31.10.2026');
  assert.equal(r.type, 'dt'); assert.equal(r.validUntil, '2026-10-31'); assert.equal(r.kind, 'data');
  assert.equal((await C.parseTicket('https://example.org/x')).kind, 'link');
  assert.equal((await C.parseTicket('\x01\x02xyz')).kind, 'opaque');
});
