import test from 'node:test';
import assert from 'node:assert/strict';
import '../public/js/ticketcode.js';
import '../public/js/barcode-read.js';
const C = globalThis.RegoCode, R = globalThis.RegoRead;

// Renders a module matrix as a grayscale image (RGBA) with a white border
function render(matrix, scale, quiet) {
  const n = matrix.length, size = (n + quiet * 2) * scale, data = new Uint8ClampedArray(size * size * 4).fill(255);
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if (matrix[y][x])
    for (let j = 0; j < scale; j++) for (let i = 0; i < scale; i++) { const o = (((y + quiet) * scale + j) * size + (x + quiet) * scale + i) * 4; data[o] = data[o + 1] = data[o + 2] = 0; }
  return { data, width: size, height: size };
}
const sample = (n) => Array.from({ length: n }, (_, i) => (i * 31 + 7) & 255);

test('QR: own reader reads self-drawn codes byte-exactly', () => {
  for (const n of [12, 90, 400]) {
    const b = sample(n), r = R.decode(render(C.qrEncode(b, 1), 5, 4), { formats: ['qr_code'], scales: [1] });
    assert.ok(r, 'QR ' + n); assert.equal(r.format, 'qr_code'); assert.deepEqual(r.bytes, b);
  }
});
test('Aztec: own reader reads self-drawn codes byte-exactly', () => {
  for (const n of [10, 80, 300]) {
    const b = sample(n), r = R.decode(render(C.azEncode(b), 5, 3), { formats: ['aztec'], scales: [1] });
    assert.ok(r, 'Aztec ' + n); assert.equal(r.format, 'aztec'); assert.deepEqual(r.bytes, b);
  }
});
test('Empty white image yields no code', () => {
  const d = new Uint8ClampedArray(200 * 200 * 4).fill(255);
  assert.equal(R.decode({ data: d, width: 200, height: 200 }, { scales: [1] }), null);
});
