
// ======================================================================
// Misc builtins: errors, control, environment, set ops, time, input
// ======================================================================
function fmtMsg(a, start) { // error/warning message formatting
  if (a.length - start <= 1) return toStr(a[start]);
  return doSprintf(toStr(a[start]), a.slice(start + 1));
}
function isIdent(s) { return /^[A-Za-z][\w-]*(:[\w-]+)+$/.test(s); }
B.error = (a) => {
  if (!a.length) return undefined;
  if (a[0] instanceof MStruct) { const s = a[0]; const msg = toStr(s.data[0].message || mkStr('')); const id = s.data[0].identifier ? toStr(s.data[0].identifier) : ''; throw new MLError(msg, id, ST.line, ST.file); }
  let id = '', msg;
  if (a.length >= 2 && isStringy(a[0]) && isIdent(toStr(a[0]))) { id = toStr(a[0]); msg = fmtMsg(a, 1); }
  else if (a.length === 1) { msg = toStr(a[0]); }
  else msg = fmtMsg(a, 0);
  if (msg === '' && a.length === 1) return undefined;
  throw new MLError(msg, id, ST.line, ST.file);
};
B.warning = (a) => {
  if (!a.length) return undefined;
  const first = toStr(a[0]);
  if (first === 'off' || first === 'on') { const id = a.length > 1 ? toStr(a[1]) : 'all'; ST.warningsOff = ST.warningsOff || {}; if (first === 'off') ST.warningsOff[id] = true; else delete ST.warningsOff[id]; if (id === 'all' && first === 'on') ST.warningsOff = {}; return undefined; }
  if (first === 'query') return undefined;
  let id = '', msg;
  if (a.length >= 2 && isIdent(first)) { id = first; msg = fmtMsg(a, 1); } else msg = a.length === 1 ? first : fmtMsg(a, 0);
  warnMsg(msg, id);
  return undefined;
};
B.MException = (a) => { const id = toStr(a[0]); const msg = a.length > 1 ? fmtMsg(a, 1) : ''; return mkException(id, msg, ST.line, ST.file); };
function throwExc(e) { if (!(e instanceof MStruct)) err('参数必须为 MException 对象。'); const me = new MLError(toStr(e.data[0].message), toStr(e.data[0].identifier), ST.line, ST.file); me.exc = e; throw me; }
B.throw = (a) => throwExc(a[0]);
B.rethrow = (a) => { const e = a[0]; if (e instanceof MStruct) { const st = e.data[0].stack; const line = st instanceof MStruct ? toNum(st.data[0].line || 0) : ST.line; const me = new MLError(toStr(e.data[0].message), toStr(e.data[0].identifier || mkStr('')), line || ST.line, ST.file); me.exc = e; throw me; } err('rethrow 的参数必须为 MException 或结构体。'); };
B.throwAsCaller = B.throw;
B.getReport = (a) => mkStr(toStr(a[0].data[0].message));
B.addCause = (a) => a[0];
B.lasterr = () => mkStr(ST.lastErr ? ST.lastErr.message : '');
B.lastwarn = () => mkStr(ST.lastWarn || '');
B.assert = (a) => {
  if (truthy(a[0])) return undefined;
  if (a.length === 1) err('断言失败。', 'MATLAB:assertion:failed');
  if (a.length >= 3 && isIdent(toStr(a[1]))) throw new MLError(fmtMsg(a, 2), toStr(a[1]), ST.line, ST.file);
  throw new MLError(fmtMsg(a, 1), '', ST.line, ST.file);
};
B.nargin = (a) => { if (a.length) { const r = resolveFn(ST.frame, toStr(a[0])); if (r && r.kind === 'user') return r.def.hasVarargin ? -r.def.params.length : r.def.params.length; return -1; } return ST.frame.nargin; };
B.nargout = (a) => { if (a.length) { const r = resolveFn(ST.frame, toStr(a[0])); if (r && r.kind === 'user') return r.def.hasVarargout ? -r.def.outs.length : r.def.outs.length; return 1; } return ST.frame.nargout; };
B.narginchk = (a) => { const lo = toNum(a[0]), hi = toNum(a[1]); const n = ST.frame.nargin; if (n < lo) err('输入参数太少。', 'MATLAB:narginchk:notEnoughInputs'); if (n > hi) err('输入参数太多。', 'MATLAB:narginchk:tooManyInputs'); };
B.nargoutchk = () => undefined;
B.validateattributes = () => undefined;
B.inputname = () => mkStr('');
B.exist = (a) => {
  const name = toStr(a[0]); const type = a.length > 1 ? toStr(a[1]) : '';
  if ((type === '' || type === 'var') && ST.frame.vars[name] !== undefined) return 1;
  if (type === 'var') return 0;
  if (type === '' || type === 'file') { if (ST.files[name] !== undefined || ST.files[name + '.m'] !== undefined) return 2; }
  if (type === '' || type === 'builtin') { if (BUILTINS[name]) return type === 'builtin' ? 5 : (BUILTINS[name] ? 5 : 2); }
  return 0;
};
B.isvarname = (a) => { const s = toStr(a[0]); return /^[A-Za-z]\w{0,62}$/.test(s) && !KEYWORDS.has(s); };
B.iskeyword = (a) => (a.length ? KEYWORDS.has(toStr(a[0])) : mkCellCol(Array.from(KEYWORDS).map(mkStr)));
B.matlab = undefined; delete B.matlab;
B.clear = (a, nout, f) => {
  f = ST.frame;
  const names = a.map(x => toStr(x));
  if (!names.length || names.includes('all') || names.includes('variables') || names.includes('-all')) { for (const k of Object.keys(f.vars)) delete f.vars[k]; if (names.includes('all') || names.includes('-all')) ST.globals = Object.create(null); return undefined; }
  if (names[0] === 'global' || names[0] === '-global') { for (const n of names.slice(1)) delete ST.globals[n]; return undefined; }
  for (const n of names) {
    if (n.includes('*')) { const re = new RegExp('^' + n.replace(/\*/g, '.*') + '$'); for (const k of Object.keys(f.vars)) if (re.test(k)) delete f.vars[k]; }
    else delete f.vars[n];
  }
  return undefined;
};
B.clearvars = B.clear;
B.clc = () => undefined;
B.home = () => undefined;
B.more = () => undefined;
B.beep = () => undefined;
B.diary = () => undefined;
B.fflush = () => undefined;
B.stdout = () => 1; B.stderr = () => 2;
B.format = (a) => { const m = a.length ? toStr(a[0]).toLowerCase() : 'short'; if (m === 'long' || m === 'longg' || m === 'long g') ST.formatLong = true; else if (m === 'short' || m === 'shortg' || m === 'short g' || m === 'default') ST.formatLong = false; else if (m === 'compact' || m === 'loose') { /* ignored */ } return undefined; };
B.who = (a, nout) => { const ks = Object.keys(ST.frame.vars).sort(); if (nout > 0) return mkCellCol(ks.map(mkStr)); if (ks.length) out('您的变量为:\n\n' + ks.join('  ') + '\n\n'); return undefined; };
B.whos = (a) => {
  const ks = Object.keys(ST.frame.vars).sort(); if (!ks.length) return undefined;
  const rows = ks.map(k => { const v = ST.frame.vars[k]; return [k, dimStr(dimsOf(v)), String(numelOf(v) * (classOf(v) === 'char' ? 2 : 8)), classOf(v)]; });
  const w = [4, 4, 5, 5]; for (const r of rows) r.forEach((c, i) => (w[i] = Math.max(w[i], c.length)));
  let s = '  ' + padR('Name', w[0]) + '      ' + padR('Size', w[1]) + '            ' + padL('Bytes', w[2]) + '  ' + 'Class\n\n';
  for (const r of rows) s += '  ' + padR(r[0], w[0]) + '      ' + padR(r[1], w[1]) + '            ' + padL(r[2], w[2]) + '  ' + r[3] + '\n';
  out(s + '\n'); return undefined;
};
function evalString(src, f, quiet) {
  const ast = parseProgram(src, ST.file);
  const saveFile = ST.file;
  if (ast.funcs.length) err('eval 中不能定义函数。');
  const body = compileBlock(ast.script);
  const r = body(f);
  return r;
}
B.eval = (a, nout) => {
  const src = toStr(a[0]);
  const f = ST.frame; const saveLine = ST.line;
  if (nout > 0) { // value of expression
    const ast = parseProgram('__eval_tmp__ = ' + src + ';', ST.file); const body = compileBlock(ast.script);
    body(f); ST.line = saveLine; const v = f.vars.__eval_tmp__; delete f.vars.__eval_tmp__; return v;
  }
  if (a.length > 1) { try { evalString(src, f); } catch (e) { if (!(e instanceof MLError) || e.uncatchable) throw e; ST.lastErr = e; evalString(toStr(a[1]), f); } ST.line = saveLine; return undefined; }
  evalString(src, f); ST.line = saveLine;
  return undefined;
};
B.evalin = (a, nout) => B.eval(a.slice(1), nout);
B.assignin = (a) => { setVar(ST.baseFrame || ST.frame, toStr(a[1]), a[2]); return undefined; };
B.feval = (a, nout) => { nargchk(a, 1, undefined, 'feval'); const r = callFn(a[0], a.slice(1), nout); if (!r.length) return undefined; return r.length === 1 ? r[0] : new MR(r); };
B.func2str = (a) => { const h = a[0]; if (!(h instanceof FHandle)) err('func2str 的参数必须为函数句柄。'); return mkStr(h.kind === 'anon' ? h.src : h.name); };
B.str2func = (a) => {
  const s = toStr(a[0]);
  if (s.startsWith('@')) { const ast = parseProgram('__f__ = ' + s + ';', ST.file); const e = compileExpr(ast.script[0].rhs); const f0 = newFrame(null, ST.frame.ctx); return e(f0); }
  return new FHandle({ kind: 'named', name: s, ctx: ST.frame.ctx, parentFrame: ST.frame, fnDef: ST.frame.fn });
};
B.functions = (a) => { const h = a[0]; return scalarStruct({ function: mkStr(fhStr(h)), type: mkStr(h.kind === 'anon' ? 'anonymous' : 'simple'), file: mkStr('') }, ['function', 'type', 'file']); };
B.ismember = (a, nout) => {
  const x = a[0], s = a[1];
  if (isStringy(x) && (s instanceof MCell || s instanceof MString)) { const arr = cellOfStrings(s); const k = arr.indexOf(toStr(x)); return nout > 1 ? new MR([k >= 0, k + 1]) : k >= 0; }
  if ((x instanceof MCell || x instanceof MString) && (s instanceof MCell || s instanceof MString || isStringy(s))) {
    const arr = cellOfStrings(s); const xs = cellOfStrings(x); const idx = xs.map(v => arr.indexOf(v));
    const L = mk('logical', dimsOf(x).slice(), idx.map(k => (k >= 0 ? 1 : 0))); return nout > 1 ? new MR([L, mk('double', dimsOf(x).slice(), idx.map(k => k + 1))]) : L;
  }
  const rowsOpt = a.length > 2 && toStr(a[2]) === 'rows';
  const X = toT(x), S = toT(s);
  if (rowsOpt) {
    const R = X.dims[0], C = X.dims[1], RS = S.dims[0]; const res = [], loc = [];
    for (let i = 0; i < R; i++) { let found = 0; for (let j = 0; j < RS && !found; j++) { let eq = true; for (let c = 0; c < C; c++) if (X.re[i + c * R] !== S.re[j + c * RS]) { eq = false; break; } if (eq) found = j + 1; } res.push(found ? 1 : 0); loc.push(found); }
    return nout > 1 ? new MR([mkCol(res).cls ? mk('logical', [R, 1], res) : mk('logical', [R, 1], res), mkCol(loc)]) : mk('logical', [R, 1], res);
  }
  const map = new Map(); for (let i = S.re.length - 1; i >= 0; i--) map.set(S.re[i], i + 1);
  for (let i = 0; i < S.re.length; i++) if (!map.has(S.re[i]) || map.get(S.re[i]) > i + 1) map.set(S.re[i], Math.min(map.get(S.re[i]) || Infinity, i + 1));
  const res = X.re.map(v => (map.has(v) ? 1 : 0)), loc = X.re.map(v => map.get(v) || 0);
  const L = mk('logical', X.dims.slice(), res); return nout > 1 ? new MR([L, mk('double', X.dims.slice(), loc)]) : L;
};
function setOp(a, nout, kind) {
  const x = a[0], y = a[1];
  const stable = a.slice(2).some(v => isStringy(v) && toStr(v) === 'stable');
  const strMode = x instanceof MCell || y instanceof MCell || x instanceof MString || y instanceof MString;
  let xs, ys;
  if (strMode) { xs = x instanceof MCell || x instanceof MString ? cellOfStrings(x) : (isStringy(x) ? [toStr(x)] : []); ys = y instanceof MCell || y instanceof MString ? cellOfStrings(y) : (isStringy(y) ? [toStr(y)] : []); }
  else { xs = toArr(x).slice(); ys = toArr(y).slice(); }
  const cmp = strMode ? (p, q) => (p < q ? -1 : p > q ? 1 : 0) : (p, q) => p - q;
  const ySet = new Set(ys), xSet = new Set(xs);
  let res = [], ia = [], ib = [];
  const firstIdx = (arr) => { const m = new Map(); arr.forEach((v, i) => { if (!m.has(v)) m.set(v, i); }); return m; };
  const fx = firstIdx(xs), fy = firstIdx(ys);
  if (kind === 'intersect') { for (const v of fx.keys()) if (ySet.has(v)) res.push(v); }
  else if (kind === 'union') { for (const v of fx.keys()) res.push(v); for (const v of fy.keys()) if (!xSet.has(v)) res.push(v); }
  else if (kind === 'setdiff') { for (const v of fx.keys()) if (!ySet.has(v)) res.push(v); }
  else if (kind === 'setxor') { for (const v of fx.keys()) if (!ySet.has(v)) res.push(v); for (const v of fy.keys()) if (!xSet.has(v)) res.push(v); }
  if (!stable) res.sort(cmp);
  ia = res.map(v => (fx.has(v) ? fx.get(v) + 1 : 0)); ib = res.map(v => (fy.has(v) ? fy.get(v) + 1 : 0));
  const colIn = dimsOf(x)[1] === 1 && dimsOf(x)[0] > 1 && (kind !== 'union' || (dimsOf(y)[1] === 1 && dimsOf(y)[0] > 1));
  let R;
  if (strMode) R = (x instanceof MString || y instanceof MString) ? new MString(colIn ? [res.length, 1] : [1, res.length], res) : (colIn ? mkCellCol(res.map(mkStr)) : mkCellRow(res.map(mkStr)));
  else { const cls = classOf(x) === classOf(y) ? classOf(x) : 'double'; R = mk(cls === 'logical' ? 'double' : cls, colIn ? [res.length, 1] : [1, res.length], res); }
  if (nout > 1) { const toV = arr => (colIn ? mkCol(arr) : mkCol(arr)); const outs = [R]; if (kind === 'union') { outs.push(mkCol(ia.filter(v => v > 0))); outs.push(mkCol(res.map((v, i) => (ia[i] ? 0 : ib[i])).filter(v => v > 0))); } else if (kind === 'setdiff') outs.push(mkCol(ia)); else { outs.push(mkCol(ia)); outs.push(mkCol(ib)); } return new MR(outs); }
  return R;
}
B.intersect = (a, nout) => setOp(a, nout, 'intersect');
B.union = (a, nout) => setOp(a, nout, 'union');
B.setdiff = (a, nout) => setOp(a, nout, 'setdiff');
B.setxor = (a, nout) => setOp(a, nout, 'setxor');
// ---- time ----
B.tic = (a, nout) => { const t = ST.clock(); ST.ticTime = t; if (nout > 0) return Math.round(t * 1000); return undefined; };
B.toc = (a, nout) => {
  const start = a.length ? toNum(a[0]) / 1000 : ST.ticTime;
  if (start === undefined || start === null) err('您必须先调用 tic，然后再调用 toc。', 'MATLAB:toc:callTicFirst');
  const el = (ST.clock() - start) / 1000;
  if (nout > 0) return el;
  out('历时 ' + el.toFixed(6) + ' 秒。\n'); return undefined;
};
function nowDate() { return new Date(ST.epoch + (ST.clock() - ST.clock0)); }
B.clock = () => { const d = nowDate(); return mkRow([d.getFullYear(), d.getMonth() + 1, d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds() + d.getMilliseconds() / 1000]); };
B.cputime = () => ST.clock() / 1000;
B.now = () => { const d = nowDate(); return datenumOf(d); };
function datenumOf(d) { return 719529 + (Date.UTC(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds(), d.getMilliseconds())) / 86400000; }
B.date = () => { const d = nowDate(); const M = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']; return mkStr(String(d.getDate()).padStart(2, '0') + '-' + M[d.getMonth()] + '-' + d.getFullYear()); };
B.datestr = (a) => {
  const d = a.length && !isStringy(a[0]) ? (numelOf(a[0]) >= 3 ? (() => { const v = toArr(a[0]); return new Date(v[0], v[1] - 1, v[2], v[3] || 0, v[4] || 0, Math.floor(v[5] || 0)); })() : new Date((toNum(a[0]) - 719529) * 86400000 + new Date().getTimezoneOffset() * 60000)) : nowDate();
  const M = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const p2 = x => String(x).padStart(2, '0');
  let fmt = a.length > 1 ? toStr(a[1]) : 'dd-mmm-yyyy HH:MM:SS';
  if (fmt === '31' || fmt === 31) fmt = 'yyyy-mm-dd HH:MM:SS';
  const s = fmt.replace(/yyyy|yy|mmmm|mmm|mm|dd|HH|MM|SS|PM|AM/g, t => ({ yyyy: d.getFullYear(), yy: p2(d.getFullYear() % 100), mmmm: M[d.getMonth()], mmm: M[d.getMonth()], mm: p2(d.getMonth() + 1), dd: p2(d.getDate()), HH: p2(d.getHours()), MM: p2(d.getMinutes()), SS: p2(d.getSeconds()), PM: d.getHours() >= 12 ? 'PM' : 'AM', AM: d.getHours() >= 12 ? 'PM' : 'AM' })[t]);
  return mkStr(String(s));
};
B.pause = () => { flushFigures(); flushOut(); return undefined; };
B.drawnow = () => { flushFigures(); flushOut(); return undefined; };
B.input = (a) => {
  const prompt = a.length ? toStr(a[0]) : '';
  const asStr = a.length > 1 && toStr(a[1]) === 's';
  out(prompt);
  if (ST.stdinPos >= ST.stdin.length) { out('\n'); err('没有更多的输入：input() 需要输入，但提供的输入行已用完。', 'MLInterp:noInput'); }
  const line = String(ST.stdin[ST.stdinPos++]);
  out(line + '\n');
  if (asStr) return mkStr(line);
  if (line.trim() === '') return emptyD();
  const f = ST.frame; const saveLine = ST.line;
  const ast = parseProgram('__input_tmp__ = ' + line + ';', ST.file);
  compileBlock(ast.script)(f); ST.line = saveLine;
  const v = f.vars.__input_tmp__; delete f.vars.__input_tmp__; return v;
};
B.keyboard = () => undefined;
B.version = () => mkStr('9.0.0 (MLInterp JS)');
B.ver = () => { out('MLInterp - 浏览器中的 MATLAB/Octave 兼容解释器\n'); return undefined; };
B.computer = () => mkStr('JS');
B.ispc = () => false; B.isunix = () => true; B.ismac = () => false;
B.usejava = () => false;
B.exit = B.quit = () => { const e = new MLError('', 'MLInterp:exit', ST.line, ST.file); e.exit = true; e.uncatchable = true; throw e; };
B.onCleanup = (a) => a[0];
B.typecast = (a) => a[0];
B.swapbytes = (a) => a[0];
B.bitand = (a) => elementwise(a[0], a[1], (x, y) => Number(BigInt(Math.trunc(x)) & BigInt(Math.trunc(y))), null, arithClass(a[0], a[1]));
B.bitor = (a) => elementwise(a[0], a[1], (x, y) => Number(BigInt(Math.trunc(x)) | BigInt(Math.trunc(y))), null, arithClass(a[0], a[1]));
B.bitxor = (a) => elementwise(a[0], a[1], (x, y) => Number(BigInt(Math.trunc(x)) ^ BigInt(Math.trunc(y))), null, arithClass(a[0], a[1]));
B.bitshift = (a) => elementwise(a[0], a[1], (x, n) => (n >= 0 ? x * Math.pow(2, n) : Math.floor(x / Math.pow(2, -n))), null, arithClass(a[0], a[1]));
B.ans = undefined; delete B.ans;
B.isspace && 0;
B.peaks = (a, nout) => {
  let X, Y;
  if (a.length === 0 || (a.length === 1 && numelOf(a[0]) === 1)) {
    const n = a.length ? toNum(a[0]) : 49; const v = []; for (let i = 0; i < n; i++) v.push(-3 + 6 * i / (n - 1));
    const g = B.meshgrid([mkRow(v)]).v; X = toT(g[0]); Y = toT(g[1]);
  } else if (a.length === 1) { const g = B.meshgrid([a[0]]).v; X = toT(g[0]); Y = toT(g[1]); }
  else { X = toT(a[0]); Y = toT(a[1]); if (isVecDims(X.dims) && isVecDims(Y.dims) && X.re.length !== Y.re.length || (isVecDims(X.dims) && X.dims[0] === 1 && Y.dims[1] === 1)) { const g = B.meshgrid([X, Y]).v; X = toT(g[0]); Y = toT(g[1]); } }
  const Z = X.re.map((x, i) => { const y = Y.re[i]; return 3 * (1 - x) * (1 - x) * Math.exp(-x * x - (y + 1) * (y + 1)) - 10 * (x / 5 - x * x * x - Math.pow(y, 5)) * Math.exp(-x * x - y * y) - 1 / 3 * Math.exp(-(x + 1) * (x + 1) - y * y); });
  const Zt = mk('double', X.dims.slice(), Z);
  if (nout <= 1) { if (nout === 0) { B.surf([Zt]); return undefined; } return Zt; }
  return new MR([mk('double', X.dims.slice(), X.re.slice()), mk('double', Y.dims.slice(), Y.re.slice()), Zt]);
};
