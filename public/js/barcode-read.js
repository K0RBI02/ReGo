/* ReGo – own barcode reader for QR code and Aztec (without Google Play services, without dependencies).
   Needs ticketcode.js (tables). Runs in a web worker, on the main thread and in Node.
   decode({ data: RGBA, width, height }) -> { format, bytes, box:{x,y,width,height} } | null */
(function (root) {
  'use strict';
  var RC = root.RegoCode, I = RC.internals;

  // ---------------------------------------------------------------- Galois field and Reed-Solomon
  function makeField(prim, bits) {
    var size = 1 << bits, exp = new Array(size * 2), log = new Array(size), x = 1, i;
    for (i = 0; i < size - 1; i++) { exp[i] = x; log[x] = i; x <<= 1; if (x >= size) x ^= prim; }
    for (i = size - 1; i < size * 2; i++) exp[i] = exp[i - (size - 1)];
    return {
      size: size, exp: exp, log: log,
      mul: function (a, b) { return a && b ? exp[log[a] + log[b]] : 0; },
      div: function (a, b) { return a ? exp[(log[a] - log[b] + size - 1) % (size - 1)] : 0; }
    };
  }
  var fields = {};
  function getField(prim, bits) { var k = prim + ':' + bits; return fields[k] || (fields[k] = makeField(prim, bits)); }

  // msg: symbols, highest power first. Returns a corrected copy or null.
  function rsDecode(f, msg, nsym, fcr) {
    var n = msg.length, q1 = f.size - 1, synd = [], bad = false, i, j, s;
    for (i = 0; i < nsym; i++) {
      var a = f.exp[(fcr + i) % q1]; s = 0;
      for (j = 0; j < n; j++) s = f.mul(s, a) ^ msg[j];
      synd.push(s); if (s) bad = true;
    }
    if (!bad) return msg.slice();
    var C = [1], B = [1], L = 0, m = 1, b = 1, k;
    for (k = 0; k < nsym; k++) {
      var d = synd[k];
      for (i = 1; i <= L; i++) d ^= f.mul(C[i] || 0, synd[k - i]);
      if (d === 0) { m++; continue; }
      var T = C.slice(), coef = f.div(d, b);
      while (C.length < B.length + m) C.push(0);
      for (i = 0; i < B.length; i++) C[i + m] ^= f.mul(coef, B[i]);
      if (2 * L <= k) { L = k + 1 - L; B = T; b = d; m = 1; } else m++;
    }
    while (C.length > 1 && C[C.length - 1] === 0) C.pop();
    if (C.length - 1 !== L || L * 2 > nsym) return null;
    function evalAt(poly, p, step) {          // poly(α^(-p)) for coefficients from index step (0 or 1, only odd ones when 1)
      var sum = 0;
      for (var t = 0; t < poly.length; t++) {
        if (!poly[t]) continue;
        if (step === 1 && !(t & 1)) continue;
        var e = (f.log[poly[t]] - p * (step === 1 ? t - 1 : t)) % q1; if (e < 0) e += q1;
        sum ^= f.exp[e];
      }
      return sum;
    }
    var omega = [];
    for (i = 0; i < nsym; i++) { var o = 0; for (j = 0; j <= i && j < synd.length; j++) o ^= f.mul(synd[j], C[i - j] || 0); omega.push(o); }
    var out = msg.slice(), found = 0;
    for (var p = 0; p < n; p++) {
      if (evalAt(C, p, 0) !== 0) continue;
      found++;
      var sp = evalAt(C, p, 1), om = evalAt(omega, p, 0);
      if (!sp) return null;
      var xe = (((p * (1 - fcr)) % q1) + q1) % q1;
      out[n - 1 - p] ^= f.mul(f.exp[xe], f.div(om, sp));
    }
    if (found !== L) return null;
    for (i = 0; i < nsym; i++) {            // Cross-check
      var a2 = f.exp[(fcr + i) % q1]; s = 0;
      for (j = 0; j < n; j++) s = f.mul(s, a2) ^ out[j];
      if (s) return null;
    }
    return out;
  }

  // ---------------------------------------------------------------- Binarizing
  function binarize(rgba, w, h, mode) {
    var n = w * h, g = new Uint8Array(n), i, x, y;
    for (i = 0; i < n; i++) { var o = i * 4; g[i] = (rgba[o] * 77 + rgba[o + 1] * 150 + rgba[o + 2] * 29) >> 8; }
    var bw = new Uint8Array(n);
    if (mode === 'otsu') {
      var hist = new Array(256).fill(0); for (i = 0; i < n; i++) hist[g[i]]++;
      var sum = 0; for (i = 0; i < 256; i++) sum += i * hist[i];
      var sB = 0, wB = 0, best = 0, thr = 128;
      for (i = 0; i < 256; i++) { wB += hist[i]; if (!wB) continue; var wF = n - wB; if (!wF) break; sB += i * hist[i]; var mB = sB / wB, mF = (sum - sB) / wF, v = wB * wF * (mB - mF) * (mB - mF); if (v > best) { best = v; thr = i; } }
      for (i = 0; i < n; i++) bw[i] = g[i] <= thr ? 1 : 0;
      bw.gray = g; return bw;
    }
    var W1 = w + 1, integ = new Float64Array(W1 * (h + 1));
    for (y = 0; y < h; y++) { var row = 0; for (x = 0; x < w; x++) { row += g[y * w + x]; integ[(y + 1) * W1 + x + 1] = integ[y * W1 + x + 1] + row; } }
    var half = Math.max(8, Math.round(Math.min(w, h) / 16));
    for (y = 0; y < h; y++) {
      var y0 = Math.max(0, y - half), y1 = Math.min(h, y + half + 1);
      for (x = 0; x < w; x++) {
        var x0 = Math.max(0, x - half), x1 = Math.min(w, x + half + 1);
        var area = (x1 - x0) * (y1 - y0);
        var mean = (integ[y1 * W1 + x1] - integ[y0 * W1 + x1] - integ[y1 * W1 + x0] + integ[y0 * W1 + x0]) / area;
        bw[y * w + x] = g[y * w + x] < mean * 0.9 - 2 ? 1 : 0;
      }
    }
    bw.gray = g; return bw;
  }

  // ---------------------------------------------------------------- Helpers
  function runsOfLine(bw, w, h, x0, y0, dx, dy, len) {   // runs along a line
    var runs = [], cur = -1, start = 0, i;
    for (i = 0; i < len; i++) {
      var v = bw[(y0 + dy * i) * w + (x0 + dx * i)];
      if (v !== cur) { if (cur >= 0) runs.push({ s: start, l: i - start, c: cur }); cur = v; start = i; }
    }
    if (cur >= 0) runs.push({ s: start, l: len - start, c: cur });
    return runs;
  }
  function solve(A, b) {   // Gauss for 8x8
    var n = b.length, i, j, k;
    for (i = 0; i < n; i++) {
      var piv = i; for (j = i + 1; j < n; j++) if (Math.abs(A[j][i]) > Math.abs(A[piv][i])) piv = j;
      var t = A[i]; A[i] = A[piv]; A[piv] = t; var tb = b[i]; b[i] = b[piv]; b[piv] = tb;
      if (Math.abs(A[i][i]) < 1e-12) return null;
      for (j = i + 1; j < n; j++) { var f = A[j][i] / A[i][i]; for (k = i; k < n; k++) A[j][k] -= f * A[i][k]; b[j] -= f * b[i]; }
    }
    var x = new Array(n);
    for (i = n - 1; i >= 0; i--) { var s = b[i]; for (j = i + 1; j < n; j++) s -= A[i][j] * x[j]; x[i] = s / A[i][i]; }
    return x;
  }
  // Mapping from (gx,gy) to image points from 4 point pairs: src[i]=[gx,gy], dst[i]=[px,py]
  function homography(src, dst) {
    var A = [], b = [], i;
    for (i = 0; i < 4; i++) {
      var X = src[i][0], Y = src[i][1], u = dst[i][0], v = dst[i][1];
      A.push([X, Y, 1, 0, 0, 0, -u * X, -u * Y]); b.push(u);
      A.push([0, 0, 0, X, Y, 1, -v * X, -v * Y]); b.push(v);
    }
    var h = solve(A, b); if (!h) return null;
    return function (gx, gy) { var d = h[6] * gx + h[7] * gy + 1; return [(h[0] * gx + h[1] * gy + h[2]) / d, (h[3] * gx + h[4] * gy + h[5]) / d]; };
  }
  // Homography from any number (>=4) of point pairs (normal equations)
  function homographyLS(src, dst) {
    var n = src.length, A = [], i, j, k;
    for (i = 0; i < 8; i++) { A.push([]); for (j = 0; j < 9; j++) A[i].push(0); }
    for (i = 0; i < n; i++) {
      var X = src[i][0], Y = src[i][1], u = dst[i][0], v = dst[i][1];
      var r1 = [X, Y, 1, 0, 0, 0, -u * X, -u * Y, u], r2 = [0, 0, 0, X, Y, 1, -v * X, -v * Y, v];
      [r1, r2].forEach(function (r) { for (j = 0; j < 8; j++) { for (k = 0; k < 8; k++) A[j][k] += r[j] * r[k]; A[j][8] += r[j] * r[8]; } });
    }
    var M = A.map(function (row) { return row.slice(0, 8); }), b = A.map(function (row) { return row[8]; }), h = solve(M, b);
    if (!h) return null;
    return function (gx, gy) { var d = h[6] * gx + h[7] * gy + 1; return [(h[0] * gx + h[1] * gy + h[2]) / d, (h[3] * gx + h[4] * gy + h[5]) / d]; };
  }
  function bitAt(bw, w, h, px, py) {
    var x = Math.round(px), y = Math.round(py);
    if (x < 0 || y < 0 || x >= w || y >= h) return 0;
    return bw[y * w + x];
  }
  // Sample a module: majority from the center and four neighboring points
  function sampleModule(bw, w, h, P, gx, gy, d) {
    var c = 0, k, offs = [[0, 0], [d, 0], [-d, 0], [0, d], [0, -d]];
    for (k = 0; k < 5; k++) { var p = P(gx + offs[k][0], gy + offs[k][1]); c += bitAt(bw, w, h, p[0], p[1]); }
    return c >= 3 ? 1 : 0;
  }
  function bytesToTextLatin(b) { var s = ''; for (var i = 0; i < b.length; i++) s += String.fromCharCode(b[i]); return s; }

  // ---------------------------------------------------------------- Fine alignment
  function grayAt(g, w, h, x, y) {   // bilinear brightness
    if (x < 0 || y < 0 || x >= w - 1 || y >= h - 1) return 128;
    var x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0, i = y0 * w + x0;
    return (g[i] * (1 - fx) + g[i + 1] * fx) * (1 - fy) + (g[i + w] * (1 - fx) + g[i + w + 1] * fx) * fy;
  }
  // Moves the four corner points of the mapping until the module centers are as clearly light or dark as possible
  function refine(Pinit, ideal, samples, known, g, w, h, m) {
    var cur = ideal.map(function (c) { return Pinit(c[0], c[1]).slice(); });
    function score(pts) {
      var P = homography(ideal, pts); if (!P) return -1e18;
      var sum = 0, T = 0, i, vals = [];
      var allS = samples.length ? samples : known;
      for (i = 0; i < allS.length; i++) { var p = P(allS[i][0], allS[i][1]); vals.push(grayAt(g, w, h, p[0], p[1])); T += vals[i]; }
      T /= vals.length;
      if (samples.length) for (i = 0; i < vals.length; i++) sum += Math.abs(vals[i] - T);
      var kn = 0;
      for (i = 0; i < known.length; i++) { var q = P(known[i][0], known[i][1]), gv = grayAt(g, w, h, q[0], q[1]); kn += known[i][2] ? (T - gv) : (gv - T); }
      return (samples.length ? sum / vals.length : 0) + (known.length ? 3 * kn / known.length : 0);
    }
    var best = score(cur), steps = [0.8, 0.5, 0.25, 0.12, 0.06], si, improved, idx, sgn;
    function similarity(pts, dx, dy, k, rot) {
      var cx = 0, cy = 0; pts.forEach(function (q) { cx += q[0] / 4; cy += q[1] / 4; });
      var cs = Math.cos(rot), sn = Math.sin(rot);
      return pts.map(function (q) { var x = (q[0] - cx) * k, y = (q[1] - cy) * k; return [cx + dx + x * cs - y * sn, cy + dy + x * sn + y * cs]; });
    }
    // coarse grid search around the starting mapping (scale, rotation, shift) to avoid local maxima
    (function () {
      var sc, rt, dx, dy, bestT = cur, bestS = best;
      for (sc = -1; sc <= 1; sc++) for (rt = -1; rt <= 1; rt++) for (dx = -1; dx <= 1; dx++) for (dy = -1; dy <= 1; dy++) {
        if (!sc && !rt && !dx && !dy) continue;
        var t = similarity(cur, dx * 0.2 * m, dy * 0.2 * m, 1 + sc * 0.012, rt * 0.008), v = score(t);
        if (v > bestS + 1e-6) { bestS = v; bestT = t; }
      }
      cur = bestT; best = bestS;
    })();
    for (si = 0; si < steps.length; si++) {
      var st = steps[si] * m, rounds = 0;
      do {
        improved = false; rounds++;
        var rad = Math.hypot(cur[1][0] - cur[0][0], cur[1][1] - cur[0][1]) / 2 || 1, eps = st / rad, trials = [];
        for (sgn = -1; sgn <= 1; sgn += 2) {
          trials.push(similarity(cur, sgn * st, 0, 1, 0), similarity(cur, 0, sgn * st, 1, 0), similarity(cur, 0, 0, 1 + sgn * eps, 0), similarity(cur, 0, 0, 1, sgn * eps));
          for (idx = 0; idx < 8; idx++) { var t2 = cur.map(function (q) { return q.slice(); }); t2[idx >> 1][idx & 1] += sgn * st; trials.push(t2); }
        }
        for (idx = 0; idx < trials.length; idx++) { var sc = score(trials[idx]); if (sc > best + 1e-6) { best = sc; cur = trials[idx]; improved = true; } }
      } while (improved && rounds < 20);
    }
    return homography(ideal, cur);
  }

  // ---------------------------------------------------------------- QR code
  function qrFunctionMask(ver) {
    var size = ver * 4 + 17, fn = [], y, x, i, j;
    for (y = 0; y < size; y++) { fn.push([]); for (x = 0; x < size; x++) fn[y].push(false); }
    function setR(x0, y0, x1, y1) { for (var yy = y0; yy <= y1; yy++) for (var xx = x0; xx <= x1; xx++) if (xx >= 0 && yy >= 0 && xx < size && yy < size) fn[yy][xx] = true; }
    setR(0, 0, 8, 8); setR(size - 8, 0, size - 1, 8); setR(0, size - 8, 8, size - 1);
    for (i = 0; i < size; i++) { fn[6][i] = true; fn[i][6] = true; }
    var ap = I.alignPositions(ver), na = ap.length;
    for (i = 0; i < na; i++) for (j = 0; j < na; j++) {
      if ((i === 0 && j === 0) || (i === 0 && j === na - 1) || (i === na - 1 && j === 0)) continue;
      setR(ap[i] - 2, ap[j] - 2, ap[i] + 2, ap[j] + 2);
    }
    if (ver >= 7) { setR(size - 11, 0, size - 9, 5); setR(0, size - 11, 5, size - 9); }
    return fn;
  }
  var FORMAT_WORDS = (function () {
    var res = [];
    for (var d = 0; d < 32; d++) { var rem = d; for (var q = 0; q < 10; q++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537); res.push({ data: d, word: ((d << 10) | rem) ^ 0x5412 }); }
    return res;
  })();
  function popcount(v) { var c = 0; while (v) { c += v & 1; v >>>= 1; } return c; }
  function maskBit(m, x, y) {
    switch (m) {
      case 0: return (x + y) % 2 === 0;
      case 1: return y % 2 === 0;
      case 2: return x % 3 === 0;
      case 3: return (x + y) % 3 === 0;
      case 4: return (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0;
      case 5: return x * y % 2 + x * y % 3 === 0;
      case 6: return (x * y % 2 + x * y % 3) % 2 === 0;
      default: return ((x + y) % 2 + x * y % 3) % 2 === 0;
    }
  }
  function qrParse(data, ver) {
    var pos = 0, out = [];
    function bits(n) { var v = 0; for (var i = 0; i < n; i++) { if (pos >= data.length * 8) throw new Error('end'); v = (v << 1) | ((data[pos >> 3] >> (7 - (pos & 7))) & 1); pos++; } return v; }
    var cc = ver <= 9 ? [10, 9, 8, 8] : ver <= 26 ? [12, 11, 16, 10] : [14, 13, 16, 12];
    var AN = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:';
    while (pos + 4 <= data.length * 8) {
      var mode = bits(4);
      if (mode === 0) break;
      if (mode === 1) { var n1 = bits(cc[0]); while (n1 >= 3) { var t = bits(10); out.push(48 + Math.floor(t / 100), 48 + Math.floor(t / 10) % 10, 48 + t % 10); n1 -= 3; } if (n1 === 2) { var t2 = bits(7); out.push(48 + Math.floor(t2 / 10), 48 + t2 % 10); } else if (n1 === 1) out.push(48 + bits(4)); }
      else if (mode === 2) { var n2 = bits(cc[1]); while (n2 >= 2) { var t3 = bits(11); out.push(AN.charCodeAt(Math.floor(t3 / 45)), AN.charCodeAt(t3 % 45)); n2 -= 2; } if (n2 === 1) out.push(AN.charCodeAt(bits(6))); }
      else if (mode === 4) { var n3 = bits(cc[2]); for (var i = 0; i < n3; i++) out.push(bits(8)); }
      else if (mode === 7) { var b0 = bits(8); if (b0 & 0x80) { if ((b0 & 0xC0) === 0x80) bits(8); else bits(16); } }
      else return null;   // Kanji etc. not supported
    }
    return out;
  }
  function qrDecodeGrid(grid, dim) {
    var ver = (dim - 17) / 4, size = dim, i, x, y;
    function g(x, y) { return grid[y][x] ? 1 : 0; }
    var c1 = 0, c2 = 0;
    for (i = 0; i <= 5; i++) c1 |= g(8, i) << i;
    c1 |= g(8, 7) << 6; c1 |= g(8, 8) << 7; c1 |= g(7, 8) << 8;
    for (i = 9; i < 15; i++) c1 |= g(14 - i, 8) << i;
    for (i = 0; i < 8; i++) c2 |= g(size - 1 - i, 8) << i;
    for (i = 8; i < 15; i++) c2 |= g(8, size - 15 + i) << i;
    var best = null, bd = 99;
    FORMAT_WORDS.forEach(function (fw) { var d = Math.min(popcount(fw.word ^ c1), popcount(fw.word ^ c2)); if (d < bd) { bd = d; best = fw; } });
    if (!best || bd > 3) return null;
    var eclBits = best.data >> 3, mask = best.data & 7, ecl = I.FORMAT_BITS.indexOf(eclBits);
    if (ecl < 0) return null;
    var fn = qrFunctionMask(ver), bits = [];
    var right, vert, j;
    for (right = size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (vert = 0; vert < size; vert++) for (j = 0; j < 2; j++) {
        x = right - j; var up = ((right + 1) & 2) === 0; y = up ? size - 1 - vert : vert;
        if (!fn[y][x]) bits.push(g(x, y) ^ (maskBit(mask, x, y) ? 1 : 0));
      }
    }
    var cw = [];
    for (i = 0; i + 8 <= bits.length; i += 8) { var v = 0; for (j = 0; j < 8; j++) v = (v << 1) | bits[i + j]; cw.push(v); }
    var nb = I.NUM_BLOCKS[ecl][ver], eccLen = I.ECC_PER_BLOCK[ecl][ver], raw = Math.floor(I.rawModules(ver) / 8);
    var shortN = nb - raw % nb, shortLen = Math.floor(raw / nb), blocks = [], b2;
    for (b2 = 0; b2 < nb; b2++) blocks.push([]);
    var idx = 0;
    for (i = 0; i < shortLen + 1; i++) for (b2 = 0; b2 < nb; b2++) {
      if (i === shortLen - eccLen && b2 < shortN) continue;          // space that is missing in short blocks
      if (idx < cw.length) blocks[b2].push(cw[idx++]);
    }
    var f = getField(0x11D, 8), data = [];
    for (b2 = 0; b2 < nb; b2++) {
      var blk = blocks[b2], dl = blk.length - eccLen;
      var fixed = rsDecode(f, blk, eccLen, 0);
      if (!fixed) return null;
      for (i = 0; i < dl; i++) data.push(fixed[i]);
    }
    try { return qrParse(data, ver); } catch (e) { return null; }
  }

  function qrCandidates(bw, w, h) {
    var cands = [], y;
    function addCand(x, yy, m) {
      for (var i = 0; i < cands.length; i++) {
        var c = cands[i];
        if (Math.abs(c.x - x) < Math.max(c.m, m) * 1.2 && Math.abs(c.y - yy) < Math.max(c.m, m) * 1.2 && Math.abs(c.m - m) < Math.max(c.m, m) * 0.6) {
          c.x = (c.x * c.n + x) / (c.n + 1); c.y = (c.y * c.n + yy) / (c.n + 1); c.m = (c.m * c.n + m) / (c.n + 1); c.n++; return;
        }
      }
      cands.push({ x: x, y: yy, m: m, n: 1 });
    }
    function check5(runs, j, ratio) {   // runs[j] is black and the center; ratio = [1,1,3,1,1] or [1,1,1,1,1]
      if (j < 2 || j + 2 >= runs.length) return 0;
      var tot = 0, k; for (k = -2; k <= 2; k++) tot += runs[j + k].l;
      var sumR = 0; for (k = 0; k < 5; k++) sumR += ratio[k];
      var m = tot / sumR;
      if (m < 1.5) return 0;
      for (k = -2; k <= 2; k++) if (Math.abs(runs[j + k].l - ratio[k + 2] * m) > ratio[k + 2] * m * 0.55 + 0.6) return 0;
      return m;
    }
    for (y = 0; y < h; y++) {
      var runs = runsOfLine(bw, w, h, 0, y, 1, 0, w);
      for (var j = 2; j + 2 < runs.length; j++) {
        if (!runs[j].c) continue;
        var m = check5(runs, j, [1, 1, 3, 1, 1]);
        if (!m) continue;
        var cx = runs[j].s + runs[j].l / 2, xi = Math.round(cx);
        var col = runsOfLine(bw, w, h, xi, 0, 0, 1, h), jj = -1, t;
        for (t = 0; t < col.length; t++) if (col[t].s <= y && y < col[t].s + col[t].l) { jj = t; break; }
        if (jj < 0 || !col[jj].c) continue;
        var m2 = check5(col, jj, [1, 1, 3, 1, 1]);
        if (!m2) continue;
        addCand(cx, col[jj].s + col[jj].l / 2, (m + m2) / 2);
      }
    }
    return cands.filter(function (c) { return c.n >= 2; }).sort(function (a, b) { return b.n - a.n; }).slice(0, 14);
  }
  function dist(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }
  function qrTriples(cands) {
    var res = [], a, b, c;
    for (a = 0; a < cands.length; a++) for (b = a + 1; b < cands.length; b++) for (c = b + 1; c < cands.length; c++) {
      var t = [cands[a], cands[b], cands[c]], ms = t.map(function (z) { return z.m; });
      if (Math.max.apply(null, ms) / Math.min.apply(null, ms) > 1.7) continue;
      var d = [dist(t[0], t[1]), dist(t[0], t[2]), dist(t[1], t[2])], hi = d.indexOf(Math.max.apply(null, d));
      var o = d.filter(function (_, i) { return i !== hi; }), avg = (o[0] + o[1]) / 2;
      if (Math.abs(o[0] - o[1]) / avg > 0.4) continue;
      var ratio = d[hi] / avg; if (ratio < 1.2 || ratio > 1.65) continue;
      // corner opposite the hypotenuse
      var tl = hi === 0 ? t[2] : hi === 1 ? t[1] : t[0], rest = t.filter(function (z) { return z !== tl; });
      res.push({ score: Math.abs(o[0] - o[1]) / avg + Math.abs(ratio - 1.414) - 0.04 * Math.min(t[0].n, t[1].n, t[2].n, 10), tl: tl, p: rest[0], q: rest[1] });
    }
    return res.sort(function (x, y) { return x.score - y.score; }).slice(0, 5);
  }
  function findAlignment(bw, w, h, ex, ey, m) {
    var r = Math.ceil(m * 4), best = null, bd = 1e9, y;
    var xa = Math.max(0, Math.round(ex - r)), xb = Math.min(w - 1, Math.round(ex + r)), ya = Math.max(0, Math.round(ey - r)), yb = Math.min(h - 1, Math.round(ey + r));
    if (xb - xa < 5 || yb - ya < 5) return null;
    for (y = ya; y <= yb; y++) {
      var runs = runsOfLine(bw, w, h, xa, y, 1, 0, xb - xa + 1);
      for (var j = 2; j + 2 < runs.length; j++) {
        if (!runs[j].c) continue;
        var tot = 0, k, ok = true; for (k = -2; k <= 2; k++) tot += runs[j + k].l;
        var mm = tot / 5; if (mm < m * 0.5 || mm > m * 1.6) continue;
        for (k = -2; k <= 2; k++) if (Math.abs(runs[j + k].l - mm) > mm * 0.6) { ok = false; break; }
        if (!ok) continue;
        var cx = xa + runs[j].s + runs[j].l / 2, cy = y;
        var d = Math.hypot(cx - ex, cy - ey);
        if (d < bd) { bd = d; best = { x: cx, y: cy }; }
      }
    }
    if (!best) return null;
    // check/refine perpendicularly
    var col = runsOfLine(bw, w, h, Math.round(best.x), ya, 0, 1, yb - ya + 1), t;
    for (t = 2; t + 2 < col.length; t++) {
      if (!col[t].c) continue;
      var tt = 0; for (var q = -2; q <= 2; q++) tt += col[t + q].l;
      var m3 = tt / 5, ok2 = m3 > m * 0.5 && m3 < m * 1.6;
      for (q = -2; q <= 2 && ok2; q++) if (Math.abs(col[t + q].l - m3) > m3 * 0.6) ok2 = false;
      var cy2 = ya + col[t].s + col[t].l / 2;
      if (ok2 && Math.abs(cy2 - best.y) < m * 2.5) return { x: best.x, y: cy2 };
    }
    return null;
  }
  // Search for the alignment pattern (5x5: black-white-black) around the predicted position by template matching
  function locateAlignment(bw, w, h, P, gx, gy, m) {
    var g = bw.gray, c0 = P(gx, gy), r = Math.ceil(m * 3), best = null, bs = -1e18, dx, dy, ux, uy, cs = [];
    var offs = []; for (uy = -2; uy <= 2; uy++) for (ux = -2; ux <= 2; ux++) offs.push([ux, uy, Math.max(Math.abs(ux), Math.abs(uy)) === 1 ? -1 : 1]);
    var base = offs.map(function (o) { var p = P(gx + o[0], gy + o[1]); return [p[0] - c0[0], p[1] - c0[1], o[2]]; });
    var lo = 255, hi = 0, T;
    for (dy = -r; dy <= r; dy += 1) for (dx = -r; dx <= r; dx += 1) {
      var sum = 0, sg = 0, k;
      for (k = 0; k < base.length; k++) { var gv = grayAt(g, w, h, c0[0] + dx + base[k][0], c0[1] + dy + base[k][1]); sg += gv; cs[k] = gv; }
      T = sg / base.length;
      for (k = 0; k < base.length; k++) sum += base[k][2] * (T - cs[k]);
      if (sum > bs) { bs = sum; best = [c0[0] + dx, c0[1] + dy]; }
    }
    // Quality: the mean deviation from the average must be clear
    var rng = 0, q; for (q = 0; q < base.length; q++) rng += 1;
    return bs / base.length > 18 ? best : null;
  }
  function decodeQr(bw, w, h) {
    var lastP = null;
    var cands = qrCandidates(bw, w, h);
    if (cands.length < 3) return null;
    var triples = qrTriples(cands), ti;
    for (ti = 0; ti < triples.length; ti++) {
      var T = triples[ti], tl = T.tl, P = T.p, Q = T.q;
      var cross = (P.x - tl.x) * (Q.y - tl.y) - (P.y - tl.y) * (Q.x - tl.x);
      var tr = cross > 0 ? P : Q, bl = cross > 0 ? Q : P;
      var ang = Math.abs(Math.atan2(tr.y - tl.y, tr.x - tl.x)) % (Math.PI / 2), ang2 = Math.min(ang, Math.PI / 2 - ang);
      var m = (tl.m + tr.m + bl.m) / 3 * Math.cos(ang2), dd = (dist(tl, tr) + dist(tl, bl)) / 2;   // runs are longer when rotated
      var dim0 = Math.round(dd / m) + 7, base = 17 + 4 * Math.round((dim0 - 17) / 4);
      QLOG.push('Finder TL ' + [tl.x, tl.y, tl.m].map(function (v) { return v.toFixed(1); }) + ' TR ' + [tr.x, tr.y, tr.m].map(function (v) { return v.toFixed(1); }) + ' BL ' + [bl.x, bl.y, bl.m].map(function (v) { return v.toFixed(1); }) + ' dim0 ' + dim0);
      var dims = [base, base - 4, base + 4];
      for (var di = 0; di < dims.length; di++) {
        var dim = dims[di]; if (dim < 21 || dim > 177) continue;
        var span = dim - 7;
        var aff = function (gx, gy) { var a = (gx - 3.5) / span, b = (gy - 3.5) / span; return [tl.x + (tr.x - tl.x) * a + (bl.x - tl.x) * b, tl.y + (tr.y - tl.y) * a + (bl.y - tl.y) * b]; };
        var P0 = aff, mod = dd / span;
        if (dim >= 25) {
          var ap = I.alignPositions((dim - 17) / 4), pairsS = [[3.5, 3.5], [dim - 3.5, 3.5], [3.5, dim - 3.5]], pairsD = [[tl.x, tl.y], [tr.x, tr.y], [bl.x, bl.y]];
          var apl = [], ai, aj;
          for (ai = 0; ai < ap.length; ai++) for (aj = 0; aj < ap.length; aj++) {
            if ((ai === 0 && aj === 0) || (ai === 0 && aj === ap.length - 1) || (ai === ap.length - 1 && aj === 0)) continue;
            var dmin = Math.min(Math.hypot(ap[ai] - 3.5, ap[aj] - 3.5), Math.hypot(ap[ai] - (dim - 3.5), ap[aj] - 3.5), Math.hypot(ap[ai] - 3.5, ap[aj] - (dim - 3.5)));
            apl.push({ x: ap[ai] + 0.5, y: ap[aj] + 0.5, d: dmin });
          }
          apl.sort(function (a, b) { return a.d - b.d; });
          var cur = aff, found = 0;
          apl.forEach(function (a) {
            var loc = locateAlignment(bw, w, h, cur, a.x, a.y, mod);
            if (!loc) return;
            pairsS.push([a.x, a.y]); pairsD.push([loc[0], loc[1]]); found++;
            var H = pairsS.length >= 4 ? homographyLS(pairsS, pairsD) : null;
            if (H) cur = H;
          });
          if (found) P0 = cur;
          QLOG.push('Alignment-Muster gefunden: ' + found + '/' + apl.length);
        }
        QLOG.push('QR dim ' + dim + ' modul ' + mod.toFixed(2) + (P0 === aff ? ' ohne Alignment' : ' mit Alignment'));
        var res = tryGrid(P0, dim, mod, false) || tryGrid(P0, dim, mod, true);
        if (res) {
          if (lastP) P0 = lastP;
          var c0 = P0(0, 0), c1 = P0(dim, 0), c2 = P0(0, dim), c3 = P0(dim, dim), xs = [c0[0], c1[0], c2[0], c3[0]], ys = [c0[1], c1[1], c2[1], c3[1]];
          var x0 = Math.min.apply(null, xs), y0 = Math.min.apply(null, ys);
          return { format: 'qr_code', bytes: res, box: { x: x0, y: y0, width: Math.max.apply(null, xs) - x0, height: Math.max.apply(null, ys) - y0 } };
        }
      }
    }
    return null;
    function qrKnown(dim) {
      var known = [], c, r, i, j;
      function fin(x0, y0) {
        for (r = -1; r <= 7; r++) for (c = -1; c <= 7; c++) {
          var x = x0 + c, y = y0 + r; if (x < 0 || y < 0 || x >= dim || y >= dim) continue;
          var cheb = Math.max(Math.abs(c - 3), Math.abs(r - 3));
          known.push([x + 0.5, y + 0.5, cheb === 3 || cheb <= 1]);
        }
      }
      fin(0, 0); fin(dim - 7, 0); fin(0, dim - 7);
      for (i = 8; i < dim - 8; i++) { known.push([6.5, i + 0.5, i % 2 === 0]); known.push([i + 0.5, 6.5, i % 2 === 0]); }
      var ap = I.alignPositions((dim - 17) / 4), na = ap.length;
      for (i = 0; i < na; i++) for (j = 0; j < na; j++) {
        if ((i === 0 && j === 0) || (i === 0 && j === na - 1) || (i === na - 1 && j === 0)) continue;
        for (r = -2; r <= 2; r++) for (c = -2; c <= 2; c++) known.push([ap[i] + c + 0.5, ap[j] + r + 0.5, Math.max(Math.abs(c), Math.abs(r)) !== 1]);
      }
      return known;
    }
    function gridFrom(Pm, dim, mirror) {
      var grid = [], x, y, d = 0.22;
      for (y = 0; y < dim; y++) { grid.push([]); for (x = 0; x < dim; x++) grid[y].push(sampleModule(bw, w, h, Pm, x + 0.5, y + 0.5, d)); }
      if (mirror) { var g2 = []; for (y = 0; y < dim; y++) { g2.push([]); for (x = 0; x < dim; x++) g2[y].push(grid[x][y]); } grid = g2; }
      return grid;
    }
    function tryGrid(Pm, dim, mod, mirror) {
      var r = qrDecodeGrid(gridFrom(Pm, dim, mirror), dim);
      if (r || mirror) return r;
      var samples = [], x, y;
      for (y = 0; y < dim; y++) for (x = 0; x < dim; x++) samples.push([x + 0.5, y + 0.5]);
      var P3 = refine(Pm, [[0, 0], [dim, 0], [0, dim], [dim, dim]], samples, qrKnown(dim), bw.gray, w, h, mod);
      if (!P3) return null;
      lastP = P3;
      return qrDecodeGrid(gridFrom(P3, dim, false), dim);
    }
  }

  // ---------------------------------------------------------------- Aztec
  var AZ_UPPER = ['P/S', ' ', 'A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L', 'M', 'N', 'O', 'P', 'Q', 'R', 'S', 'T', 'U', 'V', 'W', 'X', 'Y', 'Z', 'L/L', 'M/L', 'D/L', 'B/S'];
  var AZ_LOWER = ['P/S', ' ', 'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l', 'm', 'n', 'o', 'p', 'q', 'r', 's', 't', 'u', 'v', 'w', 'x', 'y', 'z', 'U/S', 'M/L', 'D/L', 'B/S'];
  var AZ_MIXED = ['P/S', ' ', '\u0001', '\u0002', '\u0003', '\u0004', '\u0005', '\u0006', '\u0007', '\b', '\t', '\n', '\u000b', '\f', '\r', '\u001b', '\u001c', '\u001d', '\u001e', '\u001f', '@', '\\', '^', '_', '`', '|', '~', '\u007f', 'L/L', 'U/L', 'P/L', 'B/S'];
  var AZ_PUNCT = ['FLG', '\r', '\r\n', '. ', ', ', ': ', '!', '"', '#', '$', '%', '&', '\'', '(', ')', '*', '+', ',', '-', '.', '/', ':', ';', '<', '=', '>', '?', '[', ']', '{', '}', 'U/L'];
  var AZ_DIGIT = ['P/S', ' ', '0', '1', '2', '3', '4', '5', '6', '7', '8', '9', ',', '.', 'U/L', 'U/S'];
  function azHighLevel(bits) {
    var out = [], mode = 'U', shiftBack = null, pos = 0, tables = { U: AZ_UPPER, L: AZ_LOWER, M: AZ_MIXED, P: AZ_PUNCT, D: AZ_DIGIT };
    function take(n) { var v = 0; for (var i = 0; i < n; i++) v = (v << 1) | bits[pos + i]; pos += n; return v; }
    function pushStr(s) { for (var i = 0; i < s.length; i++) out.push(s.charCodeAt(i) & 255); }
    while (true) {
      var size = mode === 'D' ? 4 : 5;
      if (pos + size > bits.length) break;
      var code = take(size), sym = tables[mode][code], cur = mode;
      if (sym === 'B/S') {
        if (pos + 5 > bits.length) break;
        var n = take(5); if (n === 0) { if (pos + 11 > bits.length) break; n = take(11) + 31; }
        for (var i = 0; i < n; i++) { if (pos + 8 > bits.length) return out; out.push(take(8)); }
        if (shiftBack) { mode = shiftBack; shiftBack = null; }
        continue;
      }
      if (sym === 'FLG') { var f = take(3); if (f === 0) {} else if (f <= 6) { var dg = take(4 * f); } else break; if (shiftBack) { mode = shiftBack; shiftBack = null; } continue; }
      if (sym.length === 3 && sym.charAt(1) === '/') {
        var tgt = sym.charAt(0), kind = sym.charAt(2);
        if (kind === 'L') { mode = tgt; shiftBack = null; }
        else { shiftBack = shiftBack || cur; mode = tgt; }
        if (kind === 'S') { shiftBack = cur; }
        continue;
      }
      pushStr(sym);
      if (shiftBack) { mode = shiftBack; shiftBack = null; }
    }
    return out;
  }

  function azCandidates(bw, w, h) {
    var cands = [], y;
    // inner: runs j-inner..j+inner equally wide; the two outer (black) runs may be longer (neighboring modules)
    function ring(runs, j, inner) {
      if (j - inner - 1 < 0 || j + inner + 1 >= runs.length) return 0;
      var tot = 0, k; for (k = j - inner; k <= j + inner; k++) tot += runs[k].l;
      var m = tot / (2 * inner + 1);
      if (m < 1.5) return 0;
      for (k = j - inner; k <= j + inner; k++) if (Math.abs(runs[k].l - m) > m * 0.55 + 0.5) return 0;
      if (runs[j - inner - 1].l < m * 0.45 || runs[j + inner + 1].l < m * 0.45) return 0;
      return m;
    }
    function add(x, yy, m, full) {
      for (var i = 0; i < cands.length; i++) { var c = cands[i]; if (c.full === full && Math.abs(c.x - x) < c.m * 1.5 && Math.abs(c.y - yy) < c.m * 1.5) { c.x = (c.x * c.n + x) / (c.n + 1); c.y = (c.y * c.n + yy) / (c.n + 1); c.m = (c.m * c.n + m) / (c.n + 1); c.n++; return; } }
      cands.push({ x: x, y: yy, m: m, full: full, n: 1 });
    }
    for (y = 0; y < h; y++) {
      var runs = runsOfLine(bw, w, h, 0, y, 1, 0, w);
      for (var j = 4; j + 4 < runs.length; j++) {
        if (!runs[j].c) continue;
        var cx = runs[j].s + runs[j].l / 2, xi = Math.round(cx);
        var col = runsOfLine(bw, w, h, xi, 0, 0, 1, h), jj = -1, t;
        for (t = 0; t < col.length; t++) if (col[t].s <= y && y < col[t].s + col[t].l) { jj = t; break; }
        if (jj < 0 || !col[jj].c) continue;
        [5, 3].forEach(function (inner) {   // try full (R=6) and compact (R=4) bullseye separately
          var m = ring(runs, j, inner); if (!m) return;
          var mv = ring(col, jj, inner); if (!mv) return;
          add(cx, col[jj].s + col[jj].l / 2, (m + mv) / 2, inner === 5);
        });
      }
    }
    return cands.filter(function (c) { return c.n >= 2; }).sort(function (a, b) { return (b.full - a.full) || (b.n - a.n); }).slice(0, 24);
  }
  // Bullseye ring (distance 2) as a connected component → estimate angle and center
  function floodComponent(bw, w, h, sx, sy, limit) {
    var seen = {}, stack = [[sx, sy]], pts = [], key;
    while (stack.length && pts.length < limit) {
      var p = stack.pop(), x = p[0], y = p[1];
      if (x < 0 || y < 0 || x >= w || y >= h || !bw[y * w + x]) continue;
      key = y * w + x; if (seen[key]) continue; seen[key] = 1; pts.push(p);
      stack.push([x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]);
    }
    return pts;
  }
  function azFindRingStart(bw, w, h, cx, cy, m, ringD) {   // point on the black ring at distance ringD (runs from the center to the right)
    var y = Math.round(cy), x0 = Math.round(cx), len = Math.min(w - x0, Math.ceil(m * (ringD + 3)));
    if (y < 0 || y >= h || x0 < 0 || len < 3) return null;
    var runs = runsOfLine(bw, w, h, x0, y, 1, 0, len), nth = ringD / 2, cnt = 0;
    for (var i = 0; i < runs.length; i++) if (runs[i].c) { if (cnt === nth) return [x0 + runs[i].s + Math.floor(runs[i].l / 2), y]; cnt++; }
    return null;
  }
  var LOG = [], QLOG = [];
  function azDecodeAt(bw, w, h, cand, compact) {
    LOG.length = 0;
    var m = cand.m, cx = cand.x, cy = cand.y, R = compact ? 4 : 6;
    // Step 1: ring at distance 2 → coarse similarity mapping
    var s2 = azFindRingStart(bw, w, h, cx, cy, m, 2); if (!s2) return null;
    var pts = floodComponent(bw, w, h, s2[0], s2[1], Math.max(4000, Math.ceil(30 * m * m))); if (pts.length < 8) return null;
    var cm = [0, 0]; pts.forEach(function (p) { cm[0] += p[0]; cm[1] += p[1]; }); cm[0] /= pts.length; cm[1] /= pts.length;
    function corners(list, ax, ay, ex) {   // Extreme values in a rotated basis → 4 corners
      var tlP = null, trP = null, blP = null, brP = null, a = -1e18, b = -1e18, c = -1e18, d = -1e18;
      list.forEach(function (p) {
        var u = (p[0] - ax), v = (p[1] - ay);
        if (-(u + v) > a) { a = -(u + v); tlP = p; }
        if (u - v > b) { b = u - v; trP = p; }
        if (-u + v > c) { c = -u + v; blP = p; }
        if (u + v > d) { d = u + v; brP = p; }
      });
      return [tlP, trP, blP, brP];
    }
    var cr = corners(pts, cm[0], cm[1]);
    if (cr.some(function (p) { return !p; })) return null;
    // Outer edge of the ring: corners at ±2.5 modules
    var P1 = homography([[-2.5, -2.5], [2.5, -2.5], [-2.5, 2.5], [2.5, 2.5]], cr.map(function (p, i) {
      var o = [[-0.5, -0.5], [0.5, -0.5], [-0.5, 0.5], [0.5, 0.5]][i]; return [p[0] + o[0], p[1] + o[1]];
    }));
    if (!P1) { LOG.push('P1 null'); return null; }
    LOG.push('P1 ok, ring2 pts ' + pts.length + ' P1 u10=' + (P1(10, 0)[0] - P1(0, 0)[0]).toFixed(1) + ',' + (P1(10, 0)[1] - P1(0, 0)[1]).toFixed(1) + ' c=' + P1(0, 0).map(function (v) { return v.toFixed(1); }) + ' cr=' + JSON.stringify(cr));
    // Scale from the run width of the bullseye center (more reliable than the small ring corners)
    (function () {
      var c0 = P1(0, 0), u = [P1(1, 0)[0] - c0[0], P1(1, 0)[1] - c0[1]], phi = Math.atan2(u[1], u[0]);
      var a = Math.abs(phi) % (Math.PI / 2), th = Math.min(a, Math.PI / 2 - a), sTrue = m * Math.cos(th), sP1 = Math.hypot(u[0], u[1]);
      if (Math.abs(sP1 - sTrue) / sTrue > 0.06) {
        var cs = Math.cos(phi) * sTrue, sn = Math.sin(phi) * sTrue, src = [[-2.5, -2.5], [2.5, -2.5], [-2.5, 2.5], [2.5, 2.5]];
        var Hs = homography(src, src.map(function (q) { return [c0[0] + q[0] * cs - q[1] * sn, c0[1] + q[0] * sn + q[1] * cs]; }));
        if (Hs) { P1 = Hs; LOG.push('Maßstab aus Läufern ' + sTrue.toFixed(2) + ' statt ' + sP1.toFixed(2)); }
      }
    })();
    // Fit the rings from the inside out (distance 2, 4, 6) to straight lines one after another
    var P2 = P1, ringD;
    for (ringD = 2; ringD <= R; ringD += 2) {
      var st = azFindRingStart(bw, w, h, cx, cy, m, ringD); if (!st) continue;
      var pr = ringD === 2 ? pts : floodComponent(bw, w, h, st[0], st[1], 30000), iv = invert(P2);
      if (!iv || pr.length < 30) continue;
      var Hr = ringHomography(bw, w, h, pr, P2, iv, ringD);
      if (!Hr) { LOG.push('Ring ' + ringD + ' ohne Anpassung'); continue; }
      var scOld = (Math.hypot(P2(10, 0)[0] - P2(0, 0)[0], P2(10, 0)[1] - P2(0, 0)[1]) + Math.hypot(P2(0, 10)[0] - P2(0, 0)[0], P2(0, 10)[1] - P2(0, 0)[1])) / 2;
      var sU = Math.hypot(Hr(10, 0)[0] - Hr(0, 0)[0], Hr(10, 0)[1] - Hr(0, 0)[1]), sV = Math.hypot(Hr(0, 10)[0] - Hr(0, 0)[0], Hr(0, 10)[1] - Hr(0, 0)[1]);
      var sAvg = (sU + sV) / 2;
      if (Math.abs(sU - sV) / sAvg < 0.08 && Math.abs(sAvg - scOld) / scOld < 0.15) P2 = Hr; else LOG.push('Ring ' + ringD + ' verworfen (' + sU.toFixed(1) + '/' + sV.toFixed(1) + ' statt ' + scOld.toFixed(1) + ')');
    }
    (function () { var a = P2(0, 0), b = P2(10, 0), c2 = P2(0, 10), e = P2(10, 10); LOG.push('P2 c=' + a.map(function (v) { return v.toFixed(1); }) + ' u10=' + (b[0] - a[0]).toFixed(1) + ',' + (b[1] - a[1]).toFixed(1) + ' v10=' + (c2[0] - a[0]).toFixed(1) + ',' + (c2[1] - a[1]).toFixed(1) + ' d=' + (e[0] - a[0]).toFixed(1) + ',' + (e[1] - a[1]).toFixed(1)); })();
    // Determine the rotation (orientation marks)
    var rot, best = null, k = compact ? 5 : 7, d0 = 0.22;
    var blacks = [[-k, -k], [-k + 1, -k], [-k, -k + 1], [k, -k], [k, -k + 1], [k, k - 1]];
    var whites = [[k - 1, -k], [-k, k], [-k + 1, k], [-k, k - 1], [k, k], [k - 1, k]];
    for (rot = 0; rot < 4; rot++) {
      var Pr = rotated(P2, rot), sc = 0;
      blacks.forEach(function (q) { sc += sampleModule(bw, w, h, Pr, q[0], q[1], d0); });
      whites.forEach(function (q) { sc -= sampleModule(bw, w, h, Pr, q[0], q[1], d0); });
      if (!best || sc > best.s) best = { s: sc, rot: rot };
    }
    LOG.push('rot ' + best.rot + ' score ' + best.s);
    if (best.s < 3) return null;
    var Pm = rotated(P2, best.rot);
    var res = azRead(bw, w, h, Pm, compact);
    if (!res) return null;
    var Pf = res.P || Pm, half = res.size / 2, c0 = Pf(-half, -half), c1 = Pf(half, -half), c2 = Pf(-half, half), c3 = Pf(half, half);
    var xs = [c0[0], c1[0], c2[0], c3[0]], ys = [c0[1], c1[1], c2[1], c3[1]], x0 = Math.min.apply(null, xs), y0 = Math.min.apply(null, ys);
    return { format: 'aztec', bytes: res.bytes, box: { x: x0, y: y0, width: Math.max.apply(null, xs) - x0, height: Math.max.apply(null, ys) - y0 } };
  }
  // Edges of the outer ring by line fitting → mapping (modules → pixels)
  function ringHomography(bw, w, h, pts, P1, inv, R) {
    var mask = {}, i, sides = [[], [], [], []], cm = [0, 0];   // 0 top, 1 right, 2 bottom, 3 left
    pts.forEach(function (p) { mask[p[1] * w + p[0]] = 1; });
    var nb = [[1, 0], [-1, 0], [0, 1], [0, -1]];
    pts.forEach(function (p) {
      var g = inv(p[0], p[1]), n0 = Math.max(Math.abs(g[0]), Math.abs(g[1]));
      if (n0 > R + 0.85 || n0 < R - 0.7) return;
      for (var k = 0; k < 4; k++) {
        var qx = p[0] + nb[k][0], qy = p[1] + nb[k][1];
        if (qx < 0 || qy < 0 || qx >= w || qy >= h || mask[qy * w + qx] || bw[qy * w + qx]) continue;
        var gq = inv(qx, qy), n1 = Math.max(Math.abs(gq[0]), Math.abs(gq[1]));
        if (n1 > n0 + 0.01) {
          if (Math.min(Math.abs(g[0]), Math.abs(g[1])) > R - 0.7) break;   // leave out the corners
          var side = Math.abs(g[0]) > Math.abs(g[1]) ? (g[0] > 0 ? 1 : 3) : (g[1] > 0 ? 2 : 0);
          sides[side].push([p[0] + nb[k][0] * 0.5, p[1] + nb[k][1] * 0.5]);   // pixel edge, not pixel center
        }
        break;
      }
    });
    var lines = [];
    function fit(L) {
      var mx = 0, my = 0; L.forEach(function (q) { mx += q[0]; my += q[1]; }); mx /= L.length; my /= L.length;
      var sxx = 0, sxy = 0, syy = 0; L.forEach(function (q) { var dx = q[0] - mx, dy = q[1] - my; sxx += dx * dx; sxy += dx * dy; syy += dy * dy; });
      var ang = 0.5 * Math.atan2(2 * sxy, sxx - syy);
      return { x: mx, y: my, dx: Math.cos(ang), dy: Math.sin(ang) };
    }
    for (i = 0; i < 4; i++) {
      var L = sides[i]; if (L.length < 8) { LOG.push('Seite ' + i + ' nur ' + L.length + ' Punkte (' + sides.map(function (z) { return z.length; }) + ')'); return null; }
      var ln = fit(L);
      for (var it = 0; it < 3; it++) {   // remove outliers
        var res = L.map(function (q) { return Math.abs((q[0] - ln.x) * -ln.dy + (q[1] - ln.y) * ln.dx); });
        var sorted = res.slice().sort(function (a, b) { return a - b; }), lim = Math.max(0.8, sorted[Math.floor(sorted.length / 2)] * 2.5);
        var keep = L.filter(function (q, ix) { return res[ix] <= lim; });
        if (keep.length < 8 || keep.length === L.length) break;
        L = keep; ln = fit(L);
      }
      lines.push(ln);
    }
    function meet(a, b) {
      var det = a.dx * -b.dy - a.dy * -b.dx; if (Math.abs(det) < 1e-9) return null;
      var rx = b.x - a.x, ry = b.y - a.y, t = (rx * -b.dy - ry * -b.dx) / det;
      return [a.x + a.dx * t, a.y + a.dy * t];
    }
    var tl = meet(lines[0], lines[3]), tr = meet(lines[0], lines[1]), bl = meet(lines[2], lines[3]), br = meet(lines[2], lines[1]);
    if (!tl || !tr || !bl || !br) return null;
    var e = R + 0.5;
    return homography([[-e, -e], [e, -e], [-e, e], [e, e]], [tl, tr, bl, br]);
  }
  function invert(P) {   // inverse mapping via 4 points
    var pts = [[-3, -3], [3, -3], [-3, 3], [3, 3]], dst = pts.map(function (p) { return P(p[0], p[1]); });
    return homography(dst, pts);
  }
  function rotated(P, rot) {
    return function (u, v) {
      if (rot === 0) return P(u, v);
      if (rot === 1) return P(-v, u);
      if (rot === 2) return P(-u, -v);
      return P(v, -u);
    };
  }
  function azRead(bw, w, h, P, compact) {
    var d = 0.22;
    function smp(u, v) { return sampleModule(bw, w, h, P, u, v, d); }
    var mode = [], i, c = 0;
    if (compact) {
      for (i = 0; i < 28; i++) mode.push(0);
      for (i = 0; i < 7; i++) {
        var o = -3 + i;
        mode[i] = smp(o, -5); mode[i + 7] = smp(5, o); mode[20 - i] = smp(o, 5); mode[27 - i] = smp(-5, o);
      }
    } else {
      for (i = 0; i < 40; i++) mode.push(0);
      for (i = 0; i < 10; i++) {
        var o2 = -5 + i + Math.floor(i / 5);
        mode[i] = smp(o2, -7); mode[i + 10] = smp(7, o2); mode[29 - i] = smp(o2, 7); mode[39 - i] = smp(-7, o2);
      }
    }
    var f4 = getField(0x13, 4), words = [];
    for (i = 0; i < mode.length; i += 4) words.push((mode[i] << 3) | (mode[i + 1] << 2) | (mode[i + 2] << 1) | mode[i + 3]);
    var nd = compact ? 2 : 4, fixed = rsDecode(f4, words, words.length - nd, 1);
    if (!fixed) return null;
    var mv = 0; for (i = 0; i < nd; i++) mv = (mv << 4) | fixed[i];
    var layers, wordCount;
    if (compact) { layers = ((mv >> 6) & 3) + 1; wordCount = (mv & 63) + 1; } else { layers = ((mv >> 11) & 31) + 1; wordCount = (mv & 2047) + 1; }
    if ((compact && layers > 4) || layers > 32) return null;
    var lay = I.azLayout(compact, layers), size = lay.size, ctr = Math.floor(size / 2), ws = I.azWordSize(layers), total = I.azTotal(layers, compact);
    var bitsPerPoly = { 6: 0x43, 8: 0x12D, 10: 0x409, 12: 0x1069 }, ff = getField(bitsPerPoly[ws], ws), pad = total % ws, j;
    function readData(Pq) {
      var bits = [], q, ww = [];
      for (q = 0; q < total; q++) bits.push(sampleModule(bw, w, h, Pq, lay.pos[q][0] - ctr, lay.pos[q][1] - ctr, d));
      for (q = pad; q + ws <= total; q += ws) { var wv = 0; for (j = 0; j < ws; j++) wv = (wv << 1) | bits[q + j]; ww.push(wv); }
      if (wordCount > ww.length) return null;
      return rsDecode(ff, ww, ww.length - wordCount, 1);
    }
    function mism(Pq) { var T = root.RegoRead && root.RegoRead._truth; if (!T) return ''; var bad = 0, tot = 0, xx, yy; for (xx = 0; xx < size; xx++) for (yy = 0; yy < size; yy++) { tot++; if (sampleModule(bw, w, h, Pq, xx - ctr, yy - ctr, d) !== (T[yy][xx] ? 1 : 0)) bad++; } return ' [Fehlmodule ' + bad + '/' + tot + ']'; }
    var fixedW = readData(P);
    LOG.push('vor Feinausrichtung' + mism(P));
    LOG.push('layers ' + layers + ' words ' + wordCount + ' RS ' + (fixedW ? 'ok' : 'fehlgeschlagen'));
    if (!fixedW) {
      var pts = lay.pos.map(function (q) { return [q[0] - ctr, q[1] - ctr]; }), e0 = size / 2;
      var known = [], R0 = compact ? 4 : 6, kx, ky;
      for (kx = -R0; kx <= R0; kx++) for (ky = -R0; ky <= R0; ky++) known.push([kx, ky, Math.max(Math.abs(kx), Math.abs(ky)) % 2 === 0]);
      if (!compact) {   // Reference grid of the full Aztec: every 16th line is alternately black/white
        var hs = Math.floor(size / 2), jj, tt;
        for (jj = 0; jj <= hs; jj += 16) for (tt = -hs; tt <= hs; tt++) {
          if (jj === 0 && Math.abs(tt) <= 7) continue;
          var black = tt % 2 === 0;
          known.push([jj, tt, black]); if (jj) known.push([-jj, tt, black]);
          if (jj) { known.push([tt, jj, black]); known.push([tt, -jj, black]); } else known.push([tt, 0, black]);
        }
      }
      var P3 = refine(P, [[-e0, -e0], [e0, -e0], [-e0, e0], [e0, e0]], [], known, bw.gray, w, h, Math.hypot(P(1, 0)[0] - P(0, 0)[0], P(1, 0)[1] - P(0, 0)[1]));
      if (P3) { var P3b = refine(P3, [[-e0, -e0], [e0, -e0], [-e0, e0], [e0, e0]], pts, known, bw.gray, w, h, Math.hypot(P3(1, 0)[0] - P3(0, 0)[0], P3(1, 0)[1] - P3(0, 0)[1])); if (P3b) P3 = P3b; }
      if (P3) { fixedW = readData(P3); P = P3; LOG.push('nach Feinausrichtung RS ' + (fixedW ? 'ok' : 'fehlgeschlagen') + mism(P3)); }
    }
    if (!fixedW) return null;
    var out = [], allOnes = (1 << (ws - 1)) - 1;
    for (i = 0; i < wordCount; i++) {
      var v = fixedW[i], top = v >> 1;
      var nb = (top === 0 || top === allOnes) ? ws - 1 : ws;
      for (j = ws - 1; j >= ws - nb; j--) out.push((v >> j) & 1);
    }
    var hl = azHighLevel(out); if (!hl.length) return null;
    return { bytes: hl, size: size, P: P };
  }
  function decodeAztec(bw, w, h) {
    var cands = azCandidates(bw, w, h), i, r;
    for (i = 0; i < cands.length; i++) {
      var c = cands[i], tries = c.full ? [false, true] : [true];
      for (var k = 0; k < tries.length; k++) {
        try { r = azDecodeAt(bw, w, h, c, tries[k]); } catch (e) { r = null; }
        if (r) return r;
      }
    }
    return null;
  }

  // ---------------------------------------------------------------- Entry point
  function upscale(img, k) {   // bilinear enlargement (helps with tiny modules)
    var w = img.width, h = img.height, W = Math.round(w * k), H = Math.round(h * k), out = new Uint8ClampedArray(W * H * 4), x, y, c;
    for (y = 0; y < H; y++) {
      var fy = Math.min(h - 1.001, y / k), y0 = Math.floor(fy), ty = fy - y0;
      for (x = 0; x < W; x++) {
        var fx = Math.min(w - 1.001, x / k), x0 = Math.floor(fx), tx = fx - x0, i = (y0 * w + x0) * 4, o = (y * W + x) * 4;
        for (c = 0; c < 3; c++) out[o + c] = (img.data[i + c] * (1 - tx) + img.data[i + 4 + c] * tx) * (1 - ty) + (img.data[i + w * 4 + c] * (1 - tx) + img.data[i + w * 4 + 4 + c] * tx) * ty;
        out[o + 3] = 255;
      }
    }
    return { data: out, width: W, height: H };
  }
  function decodeOnce(img, formats) {
    var w = img.width, h = img.height, modes = ['adaptive', 'otsu'], mi, res;
    for (mi = 0; mi < modes.length; mi++) {
      var bw = binarize(img.data, w, h, modes[mi]);
      if (formats.indexOf('qr_code') >= 0) { try { res = decodeQr(bw, w, h); } catch (e) { res = null; } if (res) return res; }
      if (formats.indexOf('aztec') >= 0) { try { res = decodeAztec(bw, w, h); } catch (e) { res = null; } if (res) return res; }
    }
    return null;
  }
  function decode(img, opts) {
    var formats = (opts && opts.formats) || ['qr_code', 'aztec'], scales = (opts && opts.scales) || [1, 2], si, res;
    for (si = 0; si < scales.length; si++) {
      var k = scales[si], big = k === 1 ? img : upscale(img, k);
      if (big.width * big.height > 6e6) continue;
      res = decodeOnce(big, formats);
      if (res) {
        if (k !== 1) { var b = res.box; res.box = { x: b.x / k, y: b.y / k, width: b.width / k, height: b.height / k }; }
        return res;
      }
    }
    return null;
  }
  root.RegoRead = { _dbg: { LOG: LOG, QLOG: QLOG, azCandidates: azCandidates, azDecodeAt: azDecodeAt, qrCandidates: qrCandidates, azRead: azRead, rotated: rotated, homography: homography }, decode: decode, rsDecode: rsDecode, getField: getField, binarize: binarize, bytesToTextLatin: bytesToTextLatin };
})(typeof window !== 'undefined' ? window : typeof self !== 'undefined' ? self : globalThis);
