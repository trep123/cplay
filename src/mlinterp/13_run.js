
// ======================================================================
// run()
// ======================================================================
// default step budget: `while true, end` stops in roughly 2–3 s in Node
const DEFAULT_MAX_STEPS = 4e7;
function run(source, opts) {
  opts = opts || {};
  const perfNow = () => (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now());
  let clockFn = perfNow, epoch = Date.now();
  if (typeof opts.now === 'function') clockFn = () => +opts.now();
  else if (typeof opts.now === 'number') epoch = opts.now;
  const files = Object.create(null);
  if (opts.files) for (const k of Object.keys(opts.files)) files[k] = String(opts.files[k]);
  const state = {
    line: 0, file: null, parseFile: null, steps: 0, maxSteps: opts.maxSteps || DEFAULT_MAX_STEPS, nextCheck: 0, timeLimitMs: +opts.timeLimitMs > 0 ? +opts.timeLimitMs : 0, wall0: Date.now(), depth: 0, maxDepth: opts.maxRecursion || 500,
    onStdout: opts.onStdout || (() => {}), onStderr: opts.onStderr || opts.onStdout || (() => {}), onFigure: opts.onFigure || null,
    outBuf: '', outTotal: 0, files, fileCtx: Object.create(null), globals: Object.create(null), persist: Object.create(null),
    stdin: Array.isArray(opts.stdinLines) ? opts.stdinLines.slice() : (typeof opts.stdinLines === 'string' ? opts.stdinLines.split('\n') : []), stdinPos: 0,
    formatLong: false, seed: 0, rng: makeRng(1), clock: clockFn, clock0: clockFn(), epoch, ticTime: null,
    figs: new Map(), curFig: 0, handles: new Map(), handleCounter: 1000, frame: null, baseFrame: null, lastErr: null, lastWarn: '', warningsOff: null,
  };
  state.nextCheck = Math.min(state.maxSteps, 4096);
  const prevST = ST; ST = state; ENDS.length = 0;
  let error = null;
  try {
    let mainName = opts.fileName || null;
    state.file = mainName; state.parseFile = mainName;
    const ctx = loadFile(mainName, String(source));
    const f = newFrame(null, ctx); state.frame = f; state.baseFrame = f;
    if (ctx.isFunctionFile) {
      const def = ctx.main;
      if (def.params.length && !def.hasVarargin) { /* call with no args anyway */ }
      callUser(def, [], 0, f);
    } else {
      ctx.scriptBody = compileBlock(ctx.scriptAst);
      ctx.scriptBody(f);
    }
  } catch (e) {
    let me = e;
    if (e instanceof RangeError && /call stack|too much recursion/i.test(e.message)) me = new MLError('超出最大递归深度（JavaScript 调用栈溢出），可能存在无穷递归。', 'MATLAB:recursionLimit', state.line, state.file);
    else if (!(e instanceof MLError)) me = new MLError('解释器内部错误：' + (e && e.message ? e.message : String(e)), 'MLInterp:internal', state.line, state.file);
    if (!me.exit) {
      let msg = me.message;
      if (!/^错误：|^语法错误：/.test(msg) || /^语法错误：/.test(msg)) msg = (/^语法错误：/.test(msg) ? '' : '错误：') + msg;
      error = { message: msg, line: me.line || 0, file: me.file || null, identifier: me.identifier || '' };
      if (opts.debugInternal && !(e instanceof MLError)) error.stack = e && e.stack;
    }
  }
  try { flushOut(); } catch (e2) { /* ignore */ }
  try { flushFigures(); } catch (e3) { /* ignore */ }
  try { flushOut(); } catch (e4) { /* ignore */ }
  ST = prevST;
  return { ok: !error, error };
}

const MLInterp = { run, version: '1.0' };
root.MLInterp = MLInterp;
if (typeof module !== 'undefined' && module.exports) module.exports = MLInterp;
})(typeof self !== 'undefined' ? self : typeof globalThis !== 'undefined' ? globalThis : this);
