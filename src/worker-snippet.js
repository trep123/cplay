/* Web Worker glue: expects cinterp.js to be concatenated before this code in the worker Blob. */
self.onmessage = function (ev) {
  var data = ev.data || {};
  var buf = '', last = 0;
  var t0 = (typeof performance !== 'undefined' ? performance : Date).now();
  function now() { return (typeof performance !== 'undefined' ? performance : Date).now(); }
  function send() { if (buf) { self.postMessage({ type: 'out', text: buf }); buf = ''; } last = now(); }
  var r = self.CInterp.run(String(data.source || ''), String(data.stdin || ''), {
    maxSteps: data.maxSteps || 2e9,
    onStdout: function (s) { buf += s; if (now() - last > 16 || buf.length > 65536) send(); }
  });
  send();
  self.postMessage({ type: 'done', exitCode: r.exitCode, error: r.error, ms: Math.round(now() - t0) });
};
