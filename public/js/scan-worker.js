// Reads barcodes in the background so that the UI does not hang.
importScripts('/js/ticketcode.js', '/js/barcode-read.js');
self.onmessage = function (e) {
  var m = e.data, out = { id: m.id, result: null };
  try {
    var r = self.RegoRead.decode({ data: new Uint8ClampedArray(m.data), width: m.w, height: m.h }, { formats: m.formats, scales: m.scales });
    if (r) out.result = r;
  } catch (err) { out.error = String(err && err.message || err); }
  self.postMessage(out);
};
