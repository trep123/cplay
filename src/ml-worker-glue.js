/* MATLAB Web Worker glue: expects mlinterp.js (global MLInterp) to be concatenated before this code in the worker Blob. */
self.onmessage = function (ev) {
  var data = ev.data || {};
  var buf = '', last = 0;
  function now() { return (typeof performance !== 'undefined' ? performance : Date).now(); }
  var t0 = now();
  function send() { if (buf) { self.postMessage({ type: 'out', text: buf }); buf = ''; } last = now(); }
  var r;
  try {
    r = self.MLInterp.run(String(data.src || ''), {
      fileName: 'main.m',
      files: data.files || {},
      stdinLines: data.stdinLines || [],
      timeLimitMs: data.timeLimitMs || 10000,
      maxSteps: data.maxSteps || undefined,
      onStdout: function (s) { buf += s; if (now() - last > 16 || buf.length > 65536) send(); },
      onStderr: function (s) { send(); self.postMessage({ type: 'err', text: s }); },
      onFigure: function (f) { send(); self.postMessage({ type: 'figure', spec: f }); }
    });
  } catch (e) {
    r = { ok: false, error: { message: (e && e.message) || String(e), line: 0, file: null, internal: true } };
  }
  send();
  self.postMessage({ type: 'done', ok: !!r.ok, error: r.error || null, ms: Math.round(now() - t0) });
};
