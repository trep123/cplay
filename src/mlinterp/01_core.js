/* MLInterp: a MATLAB/Octave-compatible interpreter in plain JavaScript. No dependencies, no WASM.
 * Works as a browser global (window/self, also inside a Web Worker) and in Node (module.exports).
 * API: MLInterp.run(source, { onStdout, onStderr, onFigure, files, stdinLines, maxSteps, timeLimitMs, now })
 *        -> { ok, error: { message, line, file, identifier } | null }
 */
(function (root) {
'use strict';

// ======================================================================
// Errors
// ======================================================================
class MLError {
  constructor(message, identifier, line, file) { this.message = message; this.identifier = identifier || ''; this.line = line; this.file = file; this.stackInfo = null; }
}
class ControlSig { constructor(kind) { this.kind = kind; } }
let ST = null; // per-run interpreter state (single threaded)
function err(msg, id) { throw new MLError(msg, id || '', ST ? ST.line : 0, ST ? ST.file : ''); }

// ======================================================================
// Value types
//   double real scalar -> JS number;  logical scalar -> JS boolean
//   Tensor: numeric/char/logical arrays;  MCell; MStruct; MString; FHandle; MapObj
// ======================================================================
const SHARED = { shared: true };
class Tensor { constructor(cls, dims, re, im) { this.cls = cls; this.dims = dims; this.re = re; this.im = im || null; this._own = undefined; } }
class MCell { constructor(dims, data) { this.dims = dims; this.data = data; this._own = undefined; } }
class MStruct { constructor(dims, fields, data, cn) { this.dims = dims; this.fields = fields; this.data = data; this.cn = cn || null; this._own = undefined; } }
class MString { constructor(dims, data) { this.dims = dims; this.data = data; this._own = undefined; } }
class FHandle { constructor(o) { Object.assign(this, o); this._own = undefined; } }
class MapObj { constructor(kt, vt) { this.kt = kt || 'char'; this.vt = vt || 'any'; this.map = new Map(); this._own = undefined; } }
class MR { constructor(v) { this.v = v; } } // multiple return values from builtins
const COLON = { colon: true };

const INT_RANGES = {
  int8: [-128, 127], uint8: [0, 255], int16: [-32768, 32767], uint16: [0, 65535],
  int32: [-2147483648, 2147483647], uint32: [0, 4294967295],
  int64: [-9223372036854775808, 9223372036854775807], uint64: [0, 18446744073709551615],
};
const isIntCls = c => INT_RANGES[c] !== undefined;
function satInt(cls, x) {
  const r = INT_RANGES[cls];
  if (x !== x) return 0;
  let v = Math.round(x); if (x < 0 && x - Math.trunc(x) === -0.5) v = Math.trunc(x) - 1; // round half away from zero
  if (v < r[0]) return r[0]; if (v > r[1]) return r[1]; return v === 0 ? 0 : v;
}

function claim(v, tok) {
  if (v !== null && typeof v === 'object') { if (v._own === undefined) v._own = tok; else if (v._own !== tok) v._own = SHARED; }
  return v;
}
function markShared(v) { if (v !== null && typeof v === 'object' && v._own !== undefined) v._own = SHARED; return v; }

function normDims(d) {
  let n = d.length; while (n > 2 && d[n - 1] === 1) n--;
  if (n !== d.length) d = d.slice(0, n);
  if (d.length < 2) d = d.length === 1 ? [d[0], 1] : [0, 0];
  return d;
}
function prodDims(d) { let p = 1; for (let i = 0; i < d.length; i++) p *= d[i]; return p; }
function allZero(a) { for (let i = 0; i < a.length; i++) if (a[i] !== 0) return false; return true; }

function mk(cls, dims, re, im, keepComplex) {
  if (im && !keepComplex && allZero(im)) im = null;
  if (dims.length === 2 && dims[0] === 1 && dims[1] === 1 && !im) {
    if (cls === 'double') return re[0];
    if (cls === 'logical') return re[0] !== 0;
  }
  return new Tensor(cls, normDims(dims), re, im);
}
const num = x => x; // a double scalar is just a number
function mkStr(s) { // char row vector
  const n = s.length; const re = new Array(n);
  for (let i = 0; i < n; i++) re[i] = s.charCodeAt(i);
  return new Tensor('char', n === 0 ? [0, 0] : [1, n], re);
}
function mkStrings(arr, dims) { return new MString(dims || [1, arr.length], arr); }
function mkRow(arr, cls) { return mk(cls || 'double', [1, arr.length], arr); }
function mkCol(arr, cls) { return mk(cls || 'double', [arr.length, 1], arr); }
function mkLogicalArr(dims, re) { return mk('logical', dims, re); }
function emptyD() { return new Tensor('double', [0, 0], []); }
function mkCellRow(arr) { for (const v of arr) markShared(v); return new MCell([1, arr.length], arr); }
function mkCellCol(arr) { for (const v of arr) markShared(v); return new MCell([arr.length, 1], arr); }
function mkMat(rows, cols, re) { return mk('double', [rows, cols], re); }
function zerosArr(n) { const a = new Array(n); for (let i = 0; i < n; i++) a[i] = 0; return a; }

function toT(v) {
  if (typeof v === 'number') return new Tensor('double', [1, 1], [v]);
  if (typeof v === 'boolean') return new Tensor('logical', [1, 1], [v ? 1 : 0]);
  if (v instanceof Tensor) return v;
  err("此运算不支持 '" + classOf(v) + "' 类型的输入。", 'MATLAB:UndefinedFunction');
}
function isTensorLike(v) { return typeof v === 'number' || typeof v === 'boolean' || v instanceof Tensor; }
function dimsOf(v) {
  if (typeof v === 'number' || typeof v === 'boolean') return [1, 1];
  if (v instanceof FHandle || v instanceof MapObj) return [1, 1];
  return v.dims;
}
function numelOf(v) { if (typeof v === 'number' || typeof v === 'boolean') return 1; if (v instanceof FHandle || v instanceof MapObj) return 1; return prodDims(v.dims); }
function classOf(v) {
  if (typeof v === 'number') return 'double';
  if (typeof v === 'boolean') return 'logical';
  if (v instanceof Tensor) return v.cls;
  if (v instanceof MCell) return 'cell';
  if (v instanceof MStruct) return v.cn || 'struct';
  if (v instanceof MString) return 'string';
  if (v instanceof FHandle) return 'function_handle';
  if (v instanceof MapObj) return 'containers.Map';
  return 'unknown';
}
function isEmptyV(v) { return numelOf(v) === 0; }
function isChar(v) { return v instanceof Tensor && v.cls === 'char'; }
function isStringy(v) { return isChar(v) || (v instanceof MString && v.data.length === 1); }
function charRowsToStrings(t) { // char matrix -> array of row strings
  const r = t.dims[0], c = prodDims(t.dims) / (r || 1); const out = [];
  for (let i = 0; i < r; i++) { let s = ''; for (let j = 0; j < c; j++) s += String.fromCharCode(t.re[i + j * r]); out.push(s); }
  return out;
}
function toStr(v, what) {
  if (v instanceof Tensor && v.cls === 'char') {
    if (v.dims[0] <= 1) { let s = ''; const re = v.re; for (let i = 0; i < re.length; i++) s += String.fromCharCode(re[i]); return s; }
    return charRowsToStrings(v).join('');
  }
  if (v instanceof MString) { if (v.data.length === 1) return v.data[0]; err((what || '参数') + '必须为字符串标量或字符向量。'); }
  if (typeof v === 'number' && what === undefined) return String(v);
  err((what || '参数') + '必须为字符向量或字符串。', 'MATLAB:invalidType');
}
function toNum(v, what) {
  if (typeof v === 'number') return v;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (v instanceof Tensor && v.re.length >= 1) return v.re[0];
  err((what || '参数') + '必须为数值标量。', 'MATLAB:invalidType');
}
function toInt(v, what) { const x = toNum(v, what); return x; }
function toArr(v) { // numeric data (real parts) of any tensor-like
  if (typeof v === 'number') return [v];
  if (typeof v === 'boolean') return [v ? 1 : 0];
  if (v instanceof Tensor) return v.re;
  if (v instanceof MString) err('此处不支持 string 类型的参数。');
  err("此运算不支持 '" + classOf(v) + "' 类型的输入。");
}
function truthy(v) {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') { if (v !== v) err('NaN 不能转换为逻辑值。'); return v !== 0; }
  if (v instanceof Tensor) {
    const re = v.re; if (re.length === 0) return false;
    for (let i = 0; i < re.length; i++) { if (re[i] !== re[i]) err('NaN 不能转换为逻辑值。'); if (re[i] === 0 && !(v.im && v.im[i] !== 0)) return false; }
    return true;
  }
  if (v instanceof MString) err('string 不能用作条件表达式，请使用 strcmp 等函数。');
  err("无法将 '" + classOf(v) + "' 类型的值转换为逻辑值。");
}
function copyValue(v) { // shallow copy for copy-on-write
  if (v instanceof Tensor) return new Tensor(v.cls, v.dims.slice(), v.re.slice(), v.im ? v.im.slice() : null);
  if (v instanceof MCell) { for (const x of v.data) markShared(x); return new MCell(v.dims.slice(), v.data.slice()); }
  if (v instanceof MStruct) {
    const data = v.data.map(o => { const n = Object.create(null); for (const k in o) n[k] = markShared(o[k]); return n; });
    return new MStruct(v.dims.slice(), v.fields.slice(), data, v.cn);
  }
  if (v instanceof MString) return new MString(v.dims.slice(), v.data.slice());
  return v;
}
function scalarStruct(obj, fields, cn) { const o = Object.create(null); for (const k of fields) o[k] = markShared(obj[k]); return new MStruct([1, 1], fields.slice(), [o], cn); }
function getField(s, name) { return s.data[0][name]; }

// MException helper
function mkException(id, msg, line, file) {
  const stack = scalarStruct({ file: mkStr(file || ''), name: mkStr(''), line: line || 0 }, ['file', 'name', 'line']);
  return scalarStruct({ identifier: mkStr(id || ''), message: mkStr(msg), stack: stack }, ['identifier', 'message', 'stack'], 'MException');
}
