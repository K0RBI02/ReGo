// RegoScan.decode(imageData) -> Promise<{format, bytes, box}|null>. Uses a worker, otherwise the main thread.
(function (root) {
  var worker = null, pending = {}, seq = 0, failed = false;
  function start() {
    if (worker || failed || typeof Worker === 'undefined') return worker;
    try {
      worker = new Worker('/js/scan-worker.js');
      worker.onmessage = function (e) { var p = pending[e.data.id]; if (p) { delete pending[e.data.id]; p(e.data); } };
      worker.onerror = function () { failed = true; try { worker.terminate(); } catch (x) {} worker = null; Object.keys(pending).forEach(function (k) { pending[k]({ id: +k, error: 'worker' }); }); pending = {}; };
    } catch (err) { failed = true; worker = null; }
    return worker;
  }
  function decode(img, opts) {
    opts = opts || {};
    var formats = opts.formats || ['qr_code', 'aztec'], scales = opts.scales || [1, 2];
    var w = start();
    if (w) {
      return new Promise(function (resolve, reject) {
        var id = ++seq, buf = img.data.buffer.slice(0);
        pending[id] = function (m) { if (m.error === 'worker') { try { resolve(direct()); } catch (e) { reject(e); } } else if (m.error) reject(new Error(m.error)); else resolve(m.result); };
        w.postMessage({ id: id, w: img.width, h: img.height, data: buf, formats: formats, scales: scales }, [buf]);
        function direct() { return root.RegoRead ? root.RegoRead.decode(img, { formats: formats, scales: scales }) : null; }
      });
    }
    return new Promise(function (resolve, reject) {
      setTimeout(function () {
        try { resolve(root.RegoRead ? root.RegoRead.decode(img, { formats: formats, scales: scales }) : null); } catch (e) { reject(e); }
      }, 0);
    });
  }
  root.RegoScan = { decode: decode };
})(typeof window !== 'undefined' ? window : self);
