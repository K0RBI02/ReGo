/* ReGo – ticket codes: QR and Aztec encoders, plus reading of ticket data.
   No dependencies. In the browser as window.RegoCode, in Node via require(). */
(function (root) {
  'use strict';

  // ---------------------------------------------------------------- QR code
  var ECC_PER_BLOCK = [
    [-1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
    [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28],
    [-1, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30, 28, 30, 30, 30, 30, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
    [-1, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28, 30, 24, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30]
  ];
  var NUM_BLOCKS = [
    [-1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25],
    [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49],
    [-1, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34, 34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68],
    [-1, 1, 1, 2, 4, 4, 6, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35, 37, 40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81]
  ];
  var FORMAT_BITS = [1, 0, 3, 2]; // L M Q H

  function rawModules(ver) {
    var r = (16 * ver + 128) * ver + 64;
    if (ver >= 2) { var n = Math.floor(ver / 7) + 2; r -= (25 * n - 10) * n - 55; if (ver >= 7) r -= 36; }
    return r;
  }
  function dataCodewords(ver, ecl) {
    return Math.floor(rawModules(ver) / 8) - ECC_PER_BLOCK[ecl][ver] * NUM_BLOCKS[ecl][ver];
  }
  function gfMul(x, y) {
    var z = 0;
    for (var i = 7; i >= 0; i--) { z = (z << 1) ^ ((z >>> 7) * 0x11D); z ^= ((y >>> i) & 1) * x; }
    return z & 255;
  }
  function rsDivisor(deg) {
    var res = [], i, j;
    for (i = 0; i < deg - 1; i++) res.push(0);
    res.push(1);
    var rootV = 1;
    for (i = 0; i < deg; i++) {
      for (j = 0; j < deg; j++) { res[j] = gfMul(res[j], rootV); if (j + 1 < deg) res[j] ^= res[j + 1]; }
      rootV = gfMul(rootV, 2);
    }
    return res;
  }
  function rsRemainder(data, div) {
    var res = div.map(function () { return 0; });
    data.forEach(function (b) {
      var f = b ^ res.shift();
      res.push(0);
      div.forEach(function (c, i) { res[i] ^= gfMul(c, f); });
    });
    return res;
  }
  function alignPositions(ver) {
    if (ver === 1) return [];
    var n = Math.floor(ver / 7) + 2, size = ver * 4 + 17;
    var step = ver === 32 ? 26 : Math.ceil((ver * 4 + 4) / (n * 2 - 2)) * 2;
    var res = [6];
    for (var pos = size - 7; res.length < n; pos -= step) res.splice(1, 0, pos);
    return res;
  }

  // bytes: Array/Uint8Array. ecl: 0=L 1=M 2=Q 3=H. Returns a matrix (array of rows with true=dark) or null.
  function qrEncode(bytes, ecl) {
    if (ecl == null) ecl = 1;
    var ver = 1, len = bytes.length;
    for (;; ver++) {
      if (ver > 40) return null;
      var cc = ver <= 9 ? 8 : 16;
      if (4 + cc + 8 * len <= dataCodewords(ver, ecl) * 8) break;
    }
    var bits = [];
    function put(v, n) { for (var i = n - 1; i >= 0; i--) bits.push((v >>> i) & 1); }
    put(4, 4); put(len, ver <= 9 ? 8 : 16);
    for (var i = 0; i < len; i++) put(bytes[i], 8);
    var cap = dataCodewords(ver, ecl) * 8;
    put(0, Math.min(4, cap - bits.length));
    put(0, (8 - bits.length % 8) % 8);
    for (var pad = 0xEC; bits.length < cap; pad ^= 0xEC ^ 0x11) put(pad, 8);
    var data = [];
    for (i = 0; i < bits.length; i += 8) { var b = 0; for (var k = 0; k < 8; k++) b = (b << 1) | bits[i + k]; data.push(b); }

    var nb = NUM_BLOCKS[ecl][ver], eccLen = ECC_PER_BLOCK[ecl][ver], raw = Math.floor(rawModules(ver) / 8);
    var shortN = nb - raw % nb, shortLen = Math.floor(raw / nb);
    var blocks = [], div = rsDivisor(eccLen), off = 0;
    for (i = 0; i < nb; i++) {
      var d = data.slice(off, off + shortLen - eccLen + (i < shortN ? 0 : 1));
      off += d.length;
      var ecc = rsRemainder(d, div);
      if (i < shortN) d.push(0);
      blocks.push(d.concat(ecc));
    }
    var all = [];
    for (i = 0; i < blocks[0].length; i++) {
      blocks.forEach(function (blk, j) { if (i !== shortLen - eccLen || j >= shortN) all.push(blk[i]); });
    }

    var size = ver * 4 + 17, mod = [], fn = [], y, x;
    for (y = 0; y < size; y++) { mod.push([]); fn.push([]); for (x = 0; x < size; x++) { mod[y].push(false); fn[y].push(false); } }
    function setFn(px, py, dark) { mod[py][px] = dark; fn[py][px] = true; }
    for (i = 0; i < size; i++) { setFn(6, i, i % 2 === 0); setFn(i, 6, i % 2 === 0); }
    function finder(cx, cy) {
      for (var dy = -4; dy <= 4; dy++) for (var dx = -4; dx <= 4; dx++) {
        var dist = Math.max(Math.abs(dx), Math.abs(dy)), xx = cx + dx, yy = cy + dy;
        if (xx >= 0 && xx < size && yy >= 0 && yy < size) setFn(xx, yy, dist !== 2 && dist !== 4);
      }
    }
    finder(3, 3); finder(size - 4, 3); finder(3, size - 4);
    var ap = alignPositions(ver), na = ap.length;
    for (i = 0; i < na; i++) for (var j = 0; j < na; j++) {
      if ((i === 0 && j === 0) || (i === 0 && j === na - 1) || (i === na - 1 && j === 0)) continue;
      for (var dy = -2; dy <= 2; dy++) for (var dx = -2; dx <= 2; dx++) setFn(ap[i] + dx, ap[j] + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
    }
    function drawFormat(mask) {
      var dd = (FORMAT_BITS[ecl] << 3) | mask, rem = dd, q;
      for (q = 0; q < 10; q++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
      var fb = ((dd << 10) | rem) ^ 0x5412;
      function bt(n) { return ((fb >>> n) & 1) !== 0; }
      for (q = 0; q <= 5; q++) setFn(8, q, bt(q));
      setFn(8, 7, bt(6)); setFn(8, 8, bt(7)); setFn(7, 8, bt(8));
      for (q = 9; q < 15; q++) setFn(14 - q, 8, bt(q));
      for (q = 0; q < 8; q++) setFn(size - 1 - q, 8, bt(q));
      for (q = 8; q < 15; q++) setFn(8, size - 15 + q, bt(q));
      setFn(8, size - 8, true);
    }
    drawFormat(0);
    if (ver >= 7) {
      var rem = ver, q;
      for (q = 0; q < 12; q++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1F25);
      var vb = (ver << 12) | rem;
      for (q = 0; q < 18; q++) {
        var col = ((vb >>> q) & 1) !== 0, a = size - 11 + q % 3, bb = Math.floor(q / 3);
        setFn(a, bb, col); setFn(bb, a, col);
      }
    }
    var bi = 0;
    for (var right = size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (var vert = 0; vert < size; vert++) for (j = 0; j < 2; j++) {
        x = right - j;
        var up = ((right + 1) & 2) === 0;
        y = up ? size - 1 - vert : vert;
        if (!fn[y][x] && bi < all.length * 8) { mod[y][x] = ((all[bi >>> 3] >>> (7 - (bi & 7))) & 1) !== 0; bi++; }
      }
    }
    function applyMask(m) {
      for (var yy = 0; yy < size; yy++) for (var xx = 0; xx < size; xx++) {
        var inv;
        switch (m) {
          case 0: inv = (xx + yy) % 2 === 0; break;
          case 1: inv = yy % 2 === 0; break;
          case 2: inv = xx % 3 === 0; break;
          case 3: inv = (xx + yy) % 3 === 0; break;
          case 4: inv = (Math.floor(xx / 3) + Math.floor(yy / 2)) % 2 === 0; break;
          case 5: inv = xx * yy % 2 + xx * yy % 3 === 0; break;
          case 6: inv = (xx * yy % 2 + xx * yy % 3) % 2 === 0; break;
          default: inv = ((xx + yy) % 2 + xx * yy % 3) % 2 === 0;
        }
        if (!fn[yy][xx] && inv) mod[yy][xx] = !mod[yy][xx];
      }
    }
    function penalty() {
      var score = 0, dark = 0, r, c, line, n;
      function runs(get) {
        var s = 0, run, prev, t, str;
        for (var a = 0; a < size; a++) {
          run = 1; prev = get(a, 0); str = prev ? '1' : '0';
          for (t = 1; t < size; t++) {
            var v = get(a, t); str += v ? '1' : '0';
            if (v === prev) { run++; if (run === 5) s += 3; else if (run > 5) s++; } else { prev = v; run = 1; }
          }
          var p1 = 0; while ((p1 = str.indexOf('00001011101', p1)) >= 0) { s += 40; p1++; }
          p1 = 0; while ((p1 = str.indexOf('10111010000', p1)) >= 0) { s += 40; p1++; }
        }
        return s;
      }
      score += runs(function (a, t) { return mod[a][t]; }) + runs(function (a, t) { return mod[t][a]; });
      for (r = 0; r < size - 1; r++) for (c = 0; c < size - 1; c++) {
        var v0 = mod[r][c]; if (v0 === mod[r][c + 1] && v0 === mod[r + 1][c] && v0 === mod[r + 1][c + 1]) score += 3;
      }
      for (r = 0; r < size; r++) for (c = 0; c < size; c++) if (mod[r][c]) dark++;
      var total = size * size, kk = Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1;
      return score + (kk > 0 ? kk * 10 : 0);
    }
    var best = 0, bestScore = Infinity;
    for (var m = 0; m < 8; m++) {
      applyMask(m); drawFormat(m);
      var p = penalty();
      if (p < bestScore) { bestScore = p; best = m; }
      applyMask(m);
    }
    applyMask(best); drawFormat(best);
    return mod;
  }

  // ------------------------------------------------------------------ Aztec
  var AZ_POLY = { 4: 0x13, 6: 0x43, 8: 0x12D, 10: 0x409, 12: 0x1069 };
  function azField(ws) {
    var size = 1 << ws, exp = new Array(size), log = new Array(size), x = 1, i;
    for (i = 0; i < size; i++) { exp[i] = x; x <<= 1; if (x >= size) x ^= AZ_POLY[ws]; }
    for (i = 0; i < size - 1; i++) log[exp[i]] = i;
    return { size: size, exp: exp, log: log, mul: function (a, b) { return a === 0 || b === 0 ? 0 : exp[(log[a] + log[b]) % (size - 1)]; } };
  }
  function azRs(words, eccCount, ws) {
    var f = azField(ws), gen = [1], i, j;
    for (i = 1; i <= eccCount; i++) {                    // Produkt (x - a^i), i = 1..ecc
      var next = new Array(gen.length + 1);
      for (j = 0; j < next.length; j++) next[j] = 0;
      for (j = 0; j < gen.length; j++) {
        next[j] ^= gen[j];                               // * x
        next[j + 1] ^= f.mul(gen[j], f.exp[i % (f.size - 1)]);
      }
      gen = next;
    }
    // gen[0] is the coefficient of x^deg (=1)
    var rem = []; for (i = 0; i < eccCount; i++) rem.push(0);
    words.forEach(function (w) {
      var factor = w ^ rem[0];
      rem.shift(); rem.push(0);
      for (var k = 0; k < eccCount; k++) rem[k] ^= f.mul(gen[k + 1], factor);
    });
    return rem;
  }
  function azStuff(bits, ws) {
    var out = [], n = bits.length, mask = (1 << ws) - 2;
    for (var i = 0; i < n; i += ws) {
      var word = 0;
      for (var j = 0; j < ws; j++) if (i + j >= n || bits[i + j]) word |= 1 << (ws - 1 - j);
      if ((word & mask) === mask) { word &= mask; i--; }
      else if ((word & mask) === 0) { word |= 1; i--; }
      for (var k = ws - 1; k >= 0; k--) out.push((word >>> k) & 1);
    }
    return out;
  }
  function azWordSize(layers) { return layers <= 2 ? 6 : layers <= 8 ? 8 : layers <= 22 ? 10 : 12; }
  function azTotal(layers, compact) { return ((compact ? 88 : 112) + 16 * layers) * layers; }
  function azDataBits(bytes) {
    var bits = [], i, p = 0;
    function put(v, n) { for (var q = n - 1; q >= 0; q--) bits.push((v >>> q) & 1); }
    while (p < bytes.length) {
      var chunk = Math.min(bytes.length - p, 2078);
      put(31, 5);
      if (chunk <= 31) put(chunk, 5); else { put(0, 5); put(chunk - 31, 11); }
      for (i = 0; i < chunk; i++) put(bytes[p + i], 8);
      p += chunk;
    }
    return bits;
  }
  function azPlan(bytes, minEccPercent) {
    var bits = azDataBits(bytes), eccBits = Math.floor(bits.length * (minEccPercent || 33) / 100) + 11;
    var ws = 0, stuffed = null;
    for (var i = 0; i <= 32; i++) {
      var compact = i <= 3, layers = compact ? i + 1 : i;
      if (layers === 0) continue;
      var total = azTotal(layers, compact);
      if (bits.length + eccBits > total) continue;
      if (ws !== azWordSize(layers)) { ws = azWordSize(layers); stuffed = azStuff(bits, ws); }
      if (stuffed.length + eccBits > total) continue;
      if (compact && stuffed.length > ws * 64) continue;
      return { compact: compact, layers: layers, ws: ws, stuffed: stuffed, total: total };
    }
    return null;
  }
  // Bits of a message including check words (padding at the front)
  function azMessage(stuffed, total, ws) {
    var words = [], i, w;
    for (i = 0; i < stuffed.length; i += ws) { w = 0; for (var j = 0; j < ws; j++) w = (w << 1) | stuffed[i + j]; words.push(w); }
    var totalWords = Math.floor(total / ws), eccCount = totalWords - words.length;
    var ecc = azRs(words, eccCount, ws), out = [];
    for (i = 0; i < total % ws; i++) out.push(0);
    words.concat(ecc).forEach(function (v) { for (var k = ws - 1; k >= 0; k--) out.push((v >>> k) & 1); });
    return { bits: out, wordCount: words.length };
  }
  function azModeMessage(compact, layers, words) {
    var raw = [], i;
    function put(v, n) { for (var q = n - 1; q >= 0; q--) raw.push((v >>> q) & 1); }
    if (compact) { put(layers - 1, 2); put(words - 1, 6); } else { put(layers - 1, 5); put(words - 1, 11); }
    var wl = [];
    for (i = 0; i < raw.length; i += 4) wl.push((raw[i] << 3) | (raw[i + 1] << 2) | (raw[i + 2] << 1) | raw[i + 3]);
    var ecc = azRs(wl, compact ? 5 : 6, 4), out = [];
    wl.concat(ecc).forEach(function (v) { for (var k = 3; k >= 0; k--) out.push((v >>> k) & 1); });
    return out;
  }
  // Mapping message bit -> position, shared by encoder and test decoder
  function azLayout(compact, layers) {
    var base = compact ? 11 + 4 * layers : 14 + 4 * layers, size, map = [], i;
    if (compact) { size = base; for (i = 0; i < base; i++) map[i] = i; }
    else {
      size = base + 1 + 2 * Math.floor((Math.floor(base / 2) - 1) / 15);
      var orig = Math.floor(base / 2), center = Math.floor(size / 2);
      for (i = 0; i < orig; i++) { var no = i + Math.floor(i / 15); map[orig - i - 1] = center - no - 1; map[orig + i] = center + no + 1; }
    }
    var pos = [], rowOff = 0;
    for (i = 0; i < layers; i++) {
      var rowSize = (layers - i) * 4 + (compact ? 9 : 12);
      for (var j = 0; j < rowSize; j++) {
        var colOff = j * 2;
        for (var k = 0; k < 2; k++) {
          pos[rowOff + colOff + k] = [map[i * 2 + k], map[i * 2 + j]];
          pos[rowOff + rowSize * 2 + colOff + k] = [map[i * 2 + j], map[base - 1 - i * 2 - k]];
          pos[rowOff + rowSize * 4 + colOff + k] = [map[base - 1 - i * 2 - k], map[base - 1 - i * 2 - j]];
          pos[rowOff + rowSize * 6 + colOff + k] = [map[base - 1 - i * 2 - j], map[i * 2 + k]];
        }
      }
      rowOff += rowSize * 8;
    }
    return { size: size, base: base, pos: pos };
  }
  function azEncode(bytes) {
    var plan = azPlan(bytes, 33);
    if (!plan) return null;
    var msg = azMessage(plan.stuffed, plan.total, plan.ws);
    var mode = azModeMessage(plan.compact, plan.layers, msg.wordCount);
    var lay = azLayout(plan.compact, plan.layers), size = lay.size, center = Math.floor(size / 2), m = [], x, y, i;
    for (y = 0; y < size; y++) { m.push([]); for (x = 0; x < size; x++) m[y].push(false); }
    function set(px, py) { m[py][px] = true; }              // (x, y)
    msg.bits.forEach(function (b, idx) { if (b) set(lay.pos[idx][0], lay.pos[idx][1]); });
    if (plan.compact) {
      for (i = 0; i < 7; i++) {
        var o = center - 3 + i;
        if (mode[i]) set(o, center - 5);
        if (mode[i + 7]) set(center + 5, o);
        if (mode[20 - i]) set(o, center + 5);
        if (mode[27 - i]) set(center - 5, o);
      }
    } else {
      for (i = 0; i < 10; i++) {
        var o2 = center - 5 + i + Math.floor(i / 5);
        if (mode[i]) set(o2, center - 7);
        if (mode[i + 10]) set(center + 7, o2);
        if (mode[29 - i]) set(o2, center + 7);
        if (mode[39 - i]) set(center - 7, o2);
      }
    }
    var bsz = plan.compact ? 5 : 7;
    for (i = 0; i < bsz; i += 2) for (var j = center - i; j <= center + i; j++) {
      set(j, center - i); set(j, center + i); set(center - i, j); set(center + i, j);
    }
    set(center - bsz, center - bsz); set(center - bsz + 1, center - bsz); set(center - bsz, center - bsz + 1);
    set(center + bsz, center - bsz); set(center + bsz, center - bsz + 1); set(center + bsz, center + bsz - 1);
    if (!plan.compact) {
      for (i = 0, j = 0; i < Math.floor(lay.base / 2) - 1; i += 15, j += 16) {
        for (var k = center & 1; k < size; k += 2) { set(center - j, k); set(center + j, k); set(k, center - j); set(k, center + j); }
      }
    }
    return m;
  }

  // Cross-check: reads an Aztec matrix back (for tests only)
  function azDecodeForTest(m) {
    var size = m.length, compact, layers, i;
    var cands = [];
    for (var L = 1; L <= 4; L++) if (11 + 4 * L === size) cands.push([true, L]);
    for (L = 1; L <= 32; L++) { var b = 14 + 4 * L; if (b + 1 + 2 * Math.floor((Math.floor(b / 2) - 1) / 15) === size) cands.push([false, L]); }
    var c = cands[0]; compact = c[0]; layers = c[1];
    var lay = azLayout(compact, layers), ws = azWordSize(layers), total = azTotal(layers, compact);
    var bits = [];
    for (i = 0; i < total; i++) bits.push(m[lay.pos[i][1]][lay.pos[i][0]] ? 1 : 0);
    var pad = total % ws, words = [];
    for (i = pad; i < total; i += ws) { var w = 0; for (var j = 0; j < ws; j++) w = (w << 1) | bits[i + j]; words.push(w); }
    var f = azField(ws), eccCount, syn;
    // Check the mode message: number of data words
    var center = Math.floor(size / 2), mode = [];
    if (compact) {
      for (i = 0; i < 7; i++) { var o = center - 3 + i; mode[i] = m[center - 5][o]; mode[i + 7] = m[o][center + 5]; mode[20 - i] = m[center + 5][o]; mode[27 - i] = m[o][center - 5]; }
    } else {
      for (i = 0; i < 10; i++) { var o2 = center - 5 + i + Math.floor(i / 5); mode[i] = m[center - 7][o2]; mode[i + 10] = m[o2][center + 7]; mode[29 - i] = m[center + 7][o2]; mode[39 - i] = m[o2][center - 7]; }
    }
    var mb = mode.map(function (v) { return v ? 1 : 0; }), nd = compact ? 2 : 4, mv = 0;
    for (i = 0; i < nd * 4; i++) mv = (mv * 2) + mb[i];
    var wordsCount = compact ? (mv & 63) + 1 : (mv & 2047) + 1;
    var lyr = compact ? ((mv >> 6) & 3) + 1 : ((mv >> 11) & 31) + 1;
    if (lyr !== layers) throw new Error('layers mismatch');
    var dataWords = words.slice(0, wordsCount), eccCalc = azRs(dataWords, words.length - wordsCount, ws);
    if (eccCalc.join() !== words.slice(wordsCount).join()) throw new Error('rs mismatch');
    // Unstuffing
    var out = [];
    dataWords.forEach(function (v) {
      var top = v >> 1, allOnes = (1 << (ws - 1)) - 1;
      if (top === 0 || top === allOnes) { for (var k = ws - 1; k >= 1; k--) out.push((v >>> k) & 1); }
      else for (var k2 = ws - 1; k2 >= 0; k2--) out.push((v >>> k2) & 1);
    });
    var res = [], p = 0;
    while (p + 10 <= out.length) {
      var rd = function (n) { var r = 0; for (var q = 0; q < n; q++) r = r * 2 + out[p++]; return r; };
      var sh = rd(5); if (sh !== 31) break;
      var ln = rd(5); if (ln === 0) ln = rd(11) + 31;
      for (var q2 = 0; q2 < ln; q2++) res.push(rd(8));
    }
    return res;
  }

  // ------------------------------------------------------------ Text <-> bytes
  function utf8(str) {
    if (typeof TextEncoder !== 'undefined') return Array.prototype.slice.call(new TextEncoder().encode(str));
    return Array.prototype.slice.call(Buffer.from(str, 'utf8'));
  }
  function latin1(str) {
    var out = [];
    for (var i = 0; i < str.length; i++) { var c = str.charCodeAt(i); if (c > 255) return null; out.push(c); }
    return out;
  }
  // Possible byte sequences for a read text (UTF-8 first, then Latin-1)
  function candidates(str) {
    var a = utf8(str), b = latin1(str), res = [a];
    if (b && b.join() !== a.join()) res.push(b);
    return res;
  }

  function matrixCanvas(matrix, scale, quiet) {
    var n = matrix.length, size = (n + quiet * 2) * scale, c = document.createElement('canvas');
    c.width = c.height = size;
    var g = c.getContext('2d');
    g.fillStyle = '#fff'; g.fillRect(0, 0, size, size);
    g.fillStyle = '#000';
    for (var y = 0; y < n; y++) for (var x = 0; x < n; x++) if (matrix[y][x]) g.fillRect((x + quiet) * scale, (y + quiet) * scale, scale, scale);
    return c;
  }

  // Redraws the code for the read bytes. format: 'qr_code' | 'aztec'.
  // Returns { image, bytes } if the own reader reads the result back byte-exactly, otherwise null.
  function sameBytes(a, b) { if (!a || !b || a.length !== b.length) return false; for (var i = 0; i < a.length; i++) if (a[i] !== b[i]) return false; return true; }
  function regenerate(input, format) {
    if (!input || !input.length || (format !== 'qr_code' && format !== 'aztec')) return Promise.resolve(null);
    var cands = typeof input === 'string' ? candidates(input) : [Array.prototype.slice.call(input)];
    for (var i = 0; i < cands.length; i++) {
      var bytes = cands[i], matrix = format === 'qr_code' ? (qrEncode(bytes, 1) || qrEncode(bytes, 0)) : azEncode(bytes);
      if (!matrix) continue;
      var scale = Math.max(4, Math.ceil(480 / matrix.length)), quiet = format === 'qr_code' ? 4 : 2;
      var canvas = matrixCanvas(matrix, scale, quiet);
      if (!root.RegoRead) continue;
      var d = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height);
      var r = root.RegoRead.decode({ data: d.data, width: d.width, height: d.height }, { formats: [format], scales: [1] });
      if (r && sameBytes(r.bytes, bytes)) return Promise.resolve({ image: canvas.toDataURL('image/png'), bytes: bytes.length });
    }
    return Promise.resolve(null);
  }

  // ------------------------------------------------------------ Ticket data
  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  function validDate(y, m, d) {
    if (y < 2020 || y > 2100 || m < 1 || m > 12 || d < 1 || d > 31) return null;
    var dt = new Date(Date.UTC(y, m - 1, d));
    if (dt.getUTCMonth() !== m - 1) return null;
    return y + '-' + pad2(m) + '-' + pad2(d);
  }
  function inflateAt(bytes, start) {
    if (typeof DecompressionStream === 'undefined') return Promise.resolve(null);
    var ds = new DecompressionStream('deflate'), w = ds.writable.getWriter();
    w.write(new Uint8Array(bytes.slice(start))).catch(function () {});
    w.close().catch(function () {});
    return new Response(ds.readable).arrayBuffer().then(function (b) { return new Uint8Array(b); }, function () { return null; });
  }
  function toText(arr) {
    var s = '';
    for (var i = 0; i < arr.length; i++) { var c = arr[i]; s += (c >= 32 && c < 127) || c >= 160 ? String.fromCharCode(c) : ' '; }
    return s;
  }
  function analyse(text) {
    var out = { type: null, name: null, dates: [] }, low = text.toLowerCase(), m;
    if (/deutschland[\s\-]?(job)?ticket|d-ticket|deutschlandsemester/.test(low)) { out.type = 'dt'; out.name = /jobticket/.test(low) ? 'Deutschland-Jobticket' : 'Deutschlandticket'; }
    else if (/klimaticket|klima[\s\-]?ticket/.test(low)) { out.type = 'kt'; out.name = 'KlimaTicket'; }
    var re = /(\d{1,2})\.(\d{1,2})\.(20\d\d)/g;
    while ((m = re.exec(text))) { var a = validDate(+m[3], +m[2], +m[1]); if (a) out.dates.push(a); }
    re = /(20\d\d)-(\d\d)-(\d\d)/g;
    while ((m = re.exec(text))) { var b = validDate(+m[1], +m[2], +m[3]); if (b) out.dates.push(b); }
    re = /(?:^|\D)(20\d\d)(\d\d)(\d\d)(?!\d)/g;
    while ((m = re.exec(text))) { var c = validDate(+m[1], +m[2], +m[3]); if (c) out.dates.push(c); }
    return out;
  }
  // Reads what can be recognized from a ticket code without a key (text, data, zlib parts)
  function parseTicket(raw) {
    var res = { kind: 'empty', type: null, name: null, validUntil: null, validFrom: null };
    if (!raw) return Promise.resolve(res);
    var text = typeof raw === 'string' ? raw : String.fromCharCode.apply(null, Array.prototype.slice.call(raw, 0, 8192));
    var texts = [text], bytes = latin1(text), tasks = [];
    if (/^https?:\/\//i.test(text.trim())) res.kind = 'link';
    if (bytes) {
      for (var i = 0; i + 2 < bytes.length; i++) {
        if (bytes[i] === 0x78 && (bytes[i + 1] === 0x9c || bytes[i + 1] === 0xda || bytes[i + 1] === 0x01 || bytes[i + 1] === 0x5e)) tasks.push(inflateAt(bytes, i));
      }
    }
    return Promise.all(tasks.slice(0, 6)).then(function (list) {
      list.forEach(function (u) { if (u && u.length) texts.push(toText(u)); });
      var found = { type: null, name: null, dates: [] };
      texts.forEach(function (t) {
        var a = analyse(t);
        if (!found.type && a.type) { found.type = a.type; found.name = a.name; }
        found.dates = found.dates.concat(a.dates);
      });
      var today = new Date().toISOString().slice(0, 10);
      var dates = found.dates.filter(function (d, ix, arr) { return arr.indexOf(d) === ix; }).sort();
      res.type = found.type; res.name = found.name;
      if (dates.length) {
        res.validUntil = dates[dates.length - 1];
        res.validFrom = dates.length > 1 ? dates[0] : null;
        if (res.validUntil < today && dates.length === 1) res.validFrom = res.validUntil, res.validUntil = null;
      }
      if (res.type || res.validUntil) res.kind = 'data';
      else if (res.kind !== 'link') res.kind = 'opaque';
      return res;
    });
  }

  var api = { internals: { ECC_PER_BLOCK: ECC_PER_BLOCK, NUM_BLOCKS: NUM_BLOCKS, FORMAT_BITS: FORMAT_BITS, rawModules: rawModules, alignPositions: alignPositions, azLayout: azLayout, azWordSize: azWordSize, azTotal: azTotal, AZ_POLY: AZ_POLY }, build: '9', qrEncode: qrEncode, azEncode: azEncode, azDecodeForTest: azDecodeForTest, regenerate: regenerate, parseTicket: parseTicket, candidates: candidates, analyse: analyse };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.RegoCode = api;
})(typeof window !== 'undefined' ? window : globalThis);
