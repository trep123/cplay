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

// ======================================================================
// Lexer
// ======================================================================
const KEYWORDS = new Set(['if', 'elseif', 'else', 'end', 'for', 'parfor', 'while', 'switch', 'case', 'otherwise', 'try', 'catch',
  'function', 'return', 'break', 'continue', 'global', 'persistent', 'do', 'until']);
const END_ALIASES = new Set(['endif', 'endfor', 'endwhile', 'endfunction', 'endswitch', 'end_try_catch', 'endparfor']);
const BLOCK_OPENERS = new Set(['if', 'for', 'parfor', 'while', 'switch', 'try', 'function']);
function perr(msg, line) { throw new MLError('语法错误：' + msg, 'MATLAB:parse', line, ST ? ST.parseFile : ''); }

function preprocess(src) {
  src = src.replace(/\r\n?/g, '\n');
  const lines = src.split('\n'); let depth = 0;
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (t === '%{' || t === '#{') { depth++; lines[i] = ''; continue; }
    if (depth > 0) { if (t === '%}' || t === '#}') depth--; lines[i] = ''; }
  }
  return lines.join('\n');
}

function collectAssigned(src) {
  const set = new Set();
  const re1 = /(?:^|[\n;,])\s*([A-Za-z]\w*)\s*(?:\([^\n=]*\)|\{[^\n=]*\}|\.[\w.]*)?\s*=(?!=)/g; let m;
  while ((m = re1.exec(src))) set.add(m[1]);
  const re2 = /\[([^\]\n]*)\]\s*=(?!=)/g;
  while ((m = re2.exec(src))) for (const w of m[1].split(/[\s,]+/)) if (/^[A-Za-z]\w*$/.test(w)) set.add(w);
  const re3 = /\bfor\s*\(?\s*([A-Za-z]\w*)\s*=/g;
  while ((m = re3.exec(src))) set.add(m[1]);
  const re4 = /\bfunction\b([^\n]*)/g;
  while ((m = re4.exec(src))) { const ws = m[1].match(/[A-Za-z]\w*/g) || []; for (const w of ws) set.add(w); }
  const re5 = /\b(global|persistent)\b([^\n;]*)/g;
  while ((m = re5.exec(src))) { const ws = m[2].match(/[A-Za-z]\w*/g) || []; for (const w of ws) set.add(w); }
  return set;
}

function lex(src) {
  src = preprocess(src);
  const assigned = collectAssigned(src);
  const toks = []; let i = 0, line = 1; const n = src.length;
  const stack = []; // '[', '{' (literal), '(', 'i{' (index brace), 'a(' (anon params)
  let noCommaNext = false;
  const top = () => stack.length ? stack[stack.length - 1] : '';
  const inLiteral = () => { const t = top(); return t === '[' || t === '{'; };
  const inIndex = () => { for (let k = stack.length - 1; k >= 0; k--) { const s = stack[k]; if (s === '(' || s === 'i{') return true; } return false; };
  const push = (t, v, extra) => { const tk = { t, v, line, sp: spaceBefore }; if (extra) Object.assign(tk, extra); toks.push(tk); spaceBefore = false; return tk; };
  let spaceBefore = false;
  const prevTok = () => toks.length ? toks[toks.length - 1] : null;
  const valueEnd = tk => tk && (tk.t === 'num' || tk.t === 'str' || tk.t === 'dstr' || tk.t === 'id' || tk.t === 'endv' ||
    (tk.t === 'op' && (tk.v === ')' || tk.v === ']' || tk.v === '}' || tk.v === "'" || tk.v === ".'")));
  const atStmtStart = () => { const p = prevTok(); return !p || p.t === 'nl' || (p.t === 'op' && (p.v === ';' || p.v === ',') && stack.length === 0) || (p.t === 'kw' && (p.v === 'else' || p.v === 'try' || p.v === 'otherwise' || p.v === 'do')); };
  const isIdStart = c => (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c === '_';
  const isIdChar = c => isIdStart(c) || (c >= '0' && c <= '9');
  const isDigit = c => c >= '0' && c <= '9';
  let blockCount = 0, endCount = 0, funcCount = 0;

  function maybeInsertComma() {
    if (!inLiteral() || !spaceBefore) return;
    const p = prevTok(); if (!valueEnd(p)) return;
    if (noCommaNext) return;
    const c = src[i], c2 = src[i + 1];
    let starts = false;
    if (isIdStart(c) || isDigit(c) || c === '"' || c === "'" || c === '(' || c === '[' || c === '{' || c === '@') starts = true;
    else if (c === '.' && isDigit(c2)) starts = true;
    else if ((c === '~' || c === '!') && c2 !== '=') starts = true;
    else if ((c === '+' || c === '-') && c2 !== ' ' && c2 !== '\t' && c2 !== '=' && c2 !== '\n' && !(c === '+' && c2 === '+') && !(c === '-' && c2 === '-')) starts = true;
    if (starts) { const sp = spaceBefore; push('op', ',', { synth: true }); spaceBefore = sp; }
  }

  while (i < n) {
    const c = src[i];
    if (c === ' ' || c === '\t') { i++; spaceBefore = true; continue; }
    if (c === '.' && src[i + 1] === '.' && src[i + 2] === '.') { // continuation
      while (i < n && src[i] !== '\n') i++;
      i++; line++; spaceBefore = true; continue;
    }
    if (c === '%' || (c === '#' && !inLiteral())) { while (i < n && src[i] !== '\n') i++; continue; }
    if (c === '\n') {
      if (inLiteral()) { const p = prevTok(); if (!(p && p.t === 'op' && (p.v === ';' || p.v === '[' || p.v === '{'))) push('op', ';', { synth: true }); }
      else if (stack.length === 0) push('nl', '\n');
      i++; line++; spaceBefore = true; noCommaNext = false; continue;
    }
    maybeInsertComma(); noCommaNext = false;
    // numbers
    if (isDigit(c) || (c === '.' && isDigit(src[i + 1]))) {
      let j = i;
      if (c === '0' && (src[i + 1] === 'x' || src[i + 1] === 'X') && /[0-9a-fA-F]/.test(src[i + 2] || '')) {
        j = i + 2; while (j < n && /[0-9a-fA-F]/.test(src[j])) j++;
        push('num', parseInt(src.slice(i + 2, j), 16)); i = j; continue;
      }
      while (j < n && isDigit(src[j])) j++;
      if (src[j] === '.' && !(src[j + 1] === '*' || src[j + 1] === '/' || src[j + 1] === '\\' || src[j + 1] === '^' || src[j + 1] === "'" || (src[j + 1] === '.' && src[j + 2] === '.'))) {
        j++; while (j < n && isDigit(src[j])) j++;
      }
      if ((src[j] === 'e' || src[j] === 'E' || src[j] === 'd' || src[j] === 'D') && (isDigit(src[j + 1]) || ((src[j + 1] === '+' || src[j + 1] === '-') && isDigit(src[j + 2])))) {
        j += 2; while (j < n && isDigit(src[j])) j++;
      }
      const v = parseFloat(src.slice(i, j).replace(/[dD]/, 'e'));
      let imag = false;
      if ((src[j] === 'i' || src[j] === 'j' || src[j] === 'I' || src[j] === 'J') && !isIdChar(src[j + 1] || ' ')) { imag = true; j++; }
      push('num', v, imag ? { imag: true } : null); i = j; continue;
    }
    // identifiers / keywords
    if (isIdStart(c)) {
      let j = i; while (j < n && isIdChar(src[j])) j++;
      let w = src.slice(i, j);
      if (END_ALIASES.has(w)) w = 'end';
      if (w === 'end' && inIndex()) { push('endv', 'end'); i = j; continue; }
      if (KEYWORDS.has(w) && !(stack.length && w !== 'end')) {
        if (BLOCK_OPENERS.has(w)) blockCount++;
        if (w === 'function') funcCount++;
        if (w === 'end') endCount++;
        push('kw', w); i = j;
        continue;
      }
      // command syntax
      if (stack.length === 0 && atStmtStart() && !assigned.has(w) && (src[j] === ' ' || src[j] === '\t')) {
        let k = j; while (src[k] === ' ' || src[k] === '\t') k++;
        const d = src[k] || '';
        const d2 = src[k + 1] || '';
        let isCmd = false;
        if (isIdStart(d) || isDigit(d) || d === "'" ) isCmd = true;
        if (d === '-' && isIdStart(d2)) isCmd = true;
        if (isCmd && isIdStart(d)) { // "a b = ..." or "x in" etc: check next word isn't followed by '=' or '('
          let m = k; while (isIdChar(src[m] || '')) m++;
          let q = m; while (src[q] === ' ' || src[q] === '\t') q++;
          if (src[q] === '=' && src[q + 1] !== '=') isCmd = false;
          if (src[q] === '(' && m === q) isCmd = isCmd; // e.g. "hold on(" unlikely
        }
        if (isCmd) {
          // read args up to ; , newline or %
          const args = []; let p = k;
          while (p < n && src[p] !== '\n' && src[p] !== ';' && src[p] !== ',' && src[p] !== '%') {
            if (src[p] === ' ' || src[p] === '\t') { p++; continue; }
            let a = '';
            if (src[p] === "'") { p++; while (p < n && src[p] !== '\n') { if (src[p] === "'") { if (src[p + 1] === "'") { a += "'"; p += 2; continue; } p++; break; } a += src[p++]; } }
            else { while (p < n && !/[\s;,%]/.test(src[p])) a += src[p++]; }
            args.push(a);
          }
          push('cmd', w, { args }); i = p; continue;
        }
      }
      push('id', w); i = j; continue;
    }
    // strings / transpose
    if (c === "'") {
      const p = prevTok();
      const isTranspose = valueEnd(p) && !(spaceBefore && inLiteral()) && !(p && p.t === 'kw');
      if (isTranspose) { push('op', "'"); i++; continue; }
      let j = i + 1, s = '';
      for (;;) {
        if (j >= n || src[j] === '\n') perr('字符向量未正确终止（缺少右单引号）。', line);
        if (src[j] === "'") { if (src[j + 1] === "'") { s += "'"; j += 2; continue; } break; }
        s += src[j++];
      }
      push('str', s); i = j + 1; continue;
    }
    if (c === '"') {
      let j = i + 1, s = '';
      for (;;) {
        if (j >= n || src[j] === '\n') perr('字符串未正确终止（缺少右双引号）。', line);
        if (src[j] === '"') { if (src[j + 1] === '"') { s += '"'; j += 2; continue; } break; }
        s += src[j++];
      }
      push('dstr', s); i = j + 1; continue;
    }
    // operators
    const three = src.substr(i, 3), two = src.substr(i, 2);
    if (two === '.^' || two === ".'" || two === '.*' || two === './' || two === '.\\' || two === '==' || two === '~=' || two === '!=' ||
        two === '<=' || two === '>=' || two === '&&' || two === '||') {
      push('op', two === '!=' ? '~=' : two); i += 2; continue;
    }
    if (c === '(') {
      const p = prevTok();
      stack.push(p && p.t === 'op' && p.v === '@' ? 'a(' : '(');
      push('op', '('); i++; continue;
    }
    if (c === '[') { stack.push('['); push('op', '['); i++; continue; }
    if (c === '{') {
      const p = prevTok();
      stack.push(valueEnd(p) && !spaceBefore ? 'i{' : (valueEnd(p) && !inLiteral() ? 'i{' : '{'));
      push('op', '{'); i++; continue;
    }
    if (c === ')' || c === ']' || c === '}') {
      // remove trailing synthetic separators before closing
      while (toks.length && toks[toks.length - 1].synth && (c !== ')')) toks.pop();
      const s = stack.pop();
      push('op', c); i++;
      if (s === 'a(') noCommaNext = true;
      continue;
    }
    if ('+-*/\\^<>&|~!=:,;.@'.indexOf(c) >= 0) { push('op', c === '!' ? '~' : c); i++; continue; }
    perr("无效字符 '" + c + "'。", line);
  }
  push('nl', '\n'); push('eof', null);
  return { toks, endStyle: endCount >= blockCount && funcCount > 0, blockCount, endCount, funcCount };
}

// ======================================================================
// Parser
// ======================================================================
function parseProgram(src, fileName) {
  if (ST) ST.parseFile = fileName;
  const L = lex(src);
  const toks = L.toks; let p = 0;
  const endStyle = L.endStyle;
  const peek = (k) => toks[p + (k || 0)];
  const next = () => toks[p++];
  const isOp = (v, k) => { const t = toks[p + (k || 0)]; return t.t === 'op' && t.v === v; };
  const isKw = (v) => { const t = toks[p]; return t.t === 'kw' && t.v === v; };
  const expectOp = (v, what) => { const t = next(); if (!(t.t === 'op' && t.v === v)) perr((what || ("应为 '" + v + "'")) + tokDesc(t), t.line); return t; };
  function tokDesc(t) { if (!t || t.t === 'eof') return '，但遇到了文件末尾。'; if (t.t === 'nl') return '，但遇到了行尾。'; return "，但遇到了 '" + (t.t === 'str' ? "'" + t.v + "'" : t.v) + "'。"; }
  const skipNl = () => { while (peek().t === 'nl' || (peek().t === 'op' && (peek().v === ';' || peek().v === ','))) p++; };

  function parseBlock(terms) { // statements until one of terms keywords (not consumed)
    const body = [];
    for (;;) {
      skipNl();
      const t = peek();
      if (t.t === 'eof') return body;
      if (t.t === 'kw' && terms.indexOf(t.v) >= 0) return body;
      if (t.t === 'kw' && t.v === 'function') return body;
      body.push(parseStatement());
    }
  }
  function endStmt(st) { // consume terminator, set display flag
    const t = peek();
    if (t.t === 'op' && t.v === ';') { p++; st.disp = false; if (peek().t === 'nl') p++; }
    else if (t.t === 'op' && t.v === ',') { p++; st.disp = true; }
    else if (t.t === 'nl') { p++; st.disp = true; }
    else if (t.t === 'eof') st.disp = true;
    else if (t.t === 'kw' && (t.v === 'end' || t.v === 'else' || t.v === 'elseif' || t.v === 'case' || t.v === 'otherwise' || t.v === 'catch' || t.v === 'until')) st.disp = true;
    else perr('此处应为运算符或语句结束' + tokDesc(t), t.line);
    return st;
  }
  function expectEnd(what, line) { const t = next(); if (!(t.t === 'kw' && t.v === 'end')) perr("'" + what + "'（第 " + line + " 行）缺少对应的 'end'。", t.line); }

  function parseStatement() {
    const t = peek(); const line = t.line;
    if (t.t === 'cmd') { p++; return endStmt({ type: 'Cmd', name: t.v, args: t.args, line }); }
    if (t.t === 'kw') {
      switch (t.v) {
        case 'if': {
          p++; const clauses = []; let cond = parseExpr(); let body = parseBlock(['elseif', 'else', 'end']);
          clauses.push({ cond, body }); let els = null;
          for (;;) {
            const k = peek();
            if (k.t === 'kw' && k.v === 'elseif') { p++; cond = parseExpr(); body = parseBlock(['elseif', 'else', 'end']); clauses.push({ cond, body }); continue; }
            if (k.t === 'kw' && k.v === 'else') { p++; els = parseBlock(['end']); }
            break;
          }
          expectEnd('if', line); return endStmt({ type: 'If', clauses, els, line });
        }
        case 'for': case 'parfor': {
          p++; let paren = false;
          if (isOp('(')) { paren = true; p++; }
          const vt = next(); if (vt.t !== 'id') perr('for 循环变量无效' + tokDesc(vt), vt.line);
          let lv = { type: 'Id', name: vt.v };
          expectOp('=', "for 语句中应为 '='");
          const e = parseExpr();
          if (paren) { if (isOp(',')) { p++; parseExpr(); } expectOp(')'); }
          const body = parseBlock(['end']); expectEnd('for', line);
          return endStmt({ type: 'For', v: lv.name, e, body, line });
        }
        case 'while': { p++; const cond = parseExpr(); const body = parseBlock(['end']); expectEnd('while', line); return endStmt({ type: 'While', cond, body, line }); }
        case 'do': { p++; const body = parseBlock(['until']); const u = next(); if (!(u.t === 'kw' && u.v === 'until')) perr("'do' 缺少 'until'。", u.line); const cond = parseExpr(); return endStmt({ type: 'DoUntil', cond, body, line }); }
        case 'switch': {
          p++; const e = parseExpr(); skipNl(); const cases = []; let other = null;
          for (;;) {
            skipNl(); const k = peek();
            if (k.t === 'kw' && k.v === 'case') { p++; const ce = parseExpr(); const body = parseBlock(['case', 'otherwise', 'end']); cases.push({ e: ce, body, line: k.line }); continue; }
            if (k.t === 'kw' && k.v === 'otherwise') { p++; other = parseBlock(['case', 'otherwise', 'end']); continue; }
            break;
          }
          expectEnd('switch', line); return endStmt({ type: 'Switch', e, cases, other, line });
        }
        case 'try': {
          p++; if (isOp(',')) p++;
          const body = parseBlock(['catch', 'end']); let id = null, cbody = [];
          if (isKw('catch')) {
            const ct = next();
            if (peek().t === 'id' && peek().line === ct.line && !(toks[p + 1].t === 'op' && (toks[p + 1].v === '=' || toks[p + 1].v === '(' || toks[p + 1].v === '.'))) { id = next().v; }
            cbody = parseBlock(['end']);
          }
          expectEnd('try', line); return endStmt({ type: 'Try', body, id, cbody, line });
        }
        case 'return': p++; return endStmt({ type: 'Return', line });
        case 'break': p++; return endStmt({ type: 'Break', line });
        case 'continue': p++; return endStmt({ type: 'Continue', line });
        case 'global': case 'persistent': {
          p++; const names = []; while (peek().t === 'id') names.push(next().v);
          return endStmt({ type: t.v === 'global' ? 'Global' : 'Persistent', names, line });
        }
        default: perr("意外的关键字 '" + t.v + "'。", line);
      }
    }
    // multi assignment [a,b] = ...
    if (t.t === 'op' && t.v === '[') {
      let d = 0, k = p;
      for (; k < toks.length; k++) { const q = toks[k]; if (q.t === 'op' && (q.v === '[' || q.v === '(' || q.v === '{')) d++; else if (q.t === 'op' && (q.v === ']' || q.v === ')' || q.v === '}')) { d--; if (d === 0) break; } else if (q.t === 'nl' || q.t === 'eof') break; }
      if (toks[k + 1] && toks[k + 1].t === 'op' && toks[k + 1].v === '=') {
        p++; const lhs = [];
        while (!isOp(']')) {
          if (isOp(',')) { p++; continue; }
          if (isOp('~') && (isOp(',', 1) || isOp(']', 1))) { p++; lhs.push(null); continue; }
          const e = parsePostfix(); lhs.push(toLvalue(e, line));
        }
        p++; expectOp('=');
        const rhs = parseExpr();
        return endStmt({ type: 'Multi', lhs, rhs, line });
      }
    }
    const e = parseExpr();
    if (isOp('=')) {
      p++; const lv = toLvalue(e, line); const rhs = parseExpr();
      return endStmt({ type: 'Assign', lhs: lv, rhs, line });
    }
    return endStmt({ type: 'Expr', e, line });
  }
  function toLvalue(e, line) {
    const acc = [];
    let cur = e;
    while (cur.type === 'Index' || cur.type === 'Field' || cur.type === 'DynField') {
      if (cur.type === 'Index') acc.unshift({ k: cur.brace ? 'brace' : 'paren', args: cur.args });
      else if (cur.type === 'Field') acc.unshift({ k: 'field', name: cur.name });
      else acc.unshift({ k: 'dfield', e: cur.e });
      cur = cur.base;
    }
    if (cur.type !== 'Id') perr('赋值语句左侧无效。', line);
    return { name: cur.name, acc };
  }

  // ---- expressions ----
  function parseExpr() { return parseOrOr(); }
  function bin(op, a, b) { return { type: 'Bin', op, a, b }; }
  function parseOrOr() { let a = parseAndAnd(); while (isOp('||')) { p++; a = { type: 'OrOr', a, b: parseAndAnd() }; } return a; }
  function parseAndAnd() { let a = parseOr(); while (isOp('&&')) { p++; a = { type: 'AndAnd', a, b: parseOr() }; } return a; }
  function parseOr() { let a = parseAnd(); while (isOp('|')) { p++; a = bin('|', a, parseAnd()); } return a; }
  function parseAnd() { let a = parseCmp(); while (isOp('&')) { p++; a = bin('&', a, parseCmp()); } return a; }
  function parseCmp() {
    let a = parseRange();
    for (;;) { const t = peek(); if (t.t === 'op' && (t.v === '<' || t.v === '>' || t.v === '<=' || t.v === '>=' || t.v === '==' || t.v === '~=')) { p++; a = bin(t.v, a, parseRange()); } else return a; }
  }
  function parseRange() {
    const a = parseAdd();
    if (isOp(':') && !(isOp(')', 1) || isOp(',', 1))) {
      p++; const b = parseAdd();
      if (isOp(':') && !(isOp(')', 1) || isOp(',', 1))) { p++; const c = parseAdd(); return { type: 'Range', a, step: b, b: c }; }
      return { type: 'Range', a, step: null, b };
    }
    return a;
  }
  function parseAdd() {
    let a = parseMul();
    for (;;) { const t = peek(); if (t.t === 'op' && (t.v === '+' || t.v === '-') && !(t.synth)) { p++; a = bin(t.v, a, parseMul()); } else return a; }
  }
  function parseMul() {
    let a = parseUnary();
    for (;;) { const t = peek(); if (t.t === 'op' && (t.v === '*' || t.v === '/' || t.v === '\\' || t.v === '.*' || t.v === './' || t.v === '.\\')) { p++; a = bin(t.v, a, parseUnary()); } else return a; }
  }
  function parseUnary() {
    const t = peek();
    if (t.t === 'op' && (t.v === '-' || t.v === '+' || t.v === '~')) {
      p++; const a = parseUnary();
      if (t.v === '-' && a.type === 'Num') return { type: 'Num', v: -a.v, imag: a.imag };
      return { type: 'Un', op: t.v, a };
    }
    return parsePower();
  }
  function parsePower() {
    let a = parsePostfix();
    for (;;) {
      const t = peek();
      if (t.t === 'op' && (t.v === '^' || t.v === '.^')) {
        p++;
        let b;
        const u = peek();
        if (u.t === 'op' && (u.v === '-' || u.v === '+' || u.v === '~')) { p++; const x = parsePowOperand(); b = { type: 'Un', op: u.v, a: x }; }
        else b = parsePostfix();
        a = bin(t.v, a, b);
      } else return a;
    }
  }
  function parsePowOperand() { const u = peek(); if (u.t === 'op' && (u.v === '-' || u.v === '+' || u.v === '~')) { p++; return { type: 'Un', op: u.v, a: parsePowOperand() }; } return parsePostfix(); }
  function parseArgs(close) {
    const args = [];
    if (isOp(close)) { p++; return args; }
    for (;;) {
      if (isOp(':') && (isOp(close, 1) || isOp(',', 1))) { p++; args.push({ type: 'Colon' }); }
      else args.push(parseExpr());
      if (isOp(',')) { p++; continue; }
      if (isOp(close)) { p++; return args; }
      if (close === '}' && isOp(';')) perr("索引中不允许使用 ';'", peek().line);
      perr("应为 ',' 或 '" + close + "'" + tokDesc(peek()), peek().line);
    }
  }
  function parsePostfix() {
    let e = parsePrimary();
    for (;;) {
      const t = peek();
      if (t.t !== 'op') return e;
      if (t.v === '(' && !(t.sp && inMatrix > 0)) { p++; e = { type: 'Index', base: e, args: parseArgs(')'), brace: false }; continue; }
      if (t.v === '{' && !(t.sp && inMatrix > 0)) { p++; e = { type: 'Index', base: e, args: parseArgs('}'), brace: true }; continue; }
      if (t.v === '.' && !t.sp) {
        const u = peek(1);
        if (u.t === 'id' || u.t === 'kw' || u.t === 'cmd') { p += 2; e = { type: 'Field', base: e, name: u.v }; continue; }
        if (u.t === 'op' && u.v === '(') { p += 2; const fe = parseExpr(); expectOp(')'); e = { type: 'DynField', base: e, e: fe }; continue; }
        return e;
      }
      if (t.v === "'" || t.v === ".'") { p++; e = { type: 'Post', op: t.v, a: e }; continue; }
      return e;
    }
  }
  let inMatrix = 0;
  function parseMatrix(close) { // after '[' or '{'
    const rows = []; let row = [];
    inMatrix++;
    for (;;) {
      const t = peek();
      if (t.t === 'op' && t.v === close) { p++; break; }
      if (t.t === 'eof') perr("缺少 '" + close + "'。", t.line);
      if (t.t === 'op' && t.v === ';') { p++; if (row.length) rows.push(row); row = []; continue; }
      if (t.t === 'nl') { p++; if (row.length) rows.push(row); row = []; continue; }
      if (t.t === 'op' && t.v === ',') { p++; continue; }
      const saved = inMatrix; inMatrix = saved;
      row.push(parseExpr());
      const q = peek();
      if (!(q.t === 'op' && (q.v === ',' || q.v === ';' || q.v === close)) && q.t !== 'nl') perr("矩阵或元胞中应为 ',' 或 ';'" + tokDesc(q), q.line);
    }
    inMatrix--;
    if (row.length) rows.push(row);
    return rows;
  }
  function parsePrimary() {
    const t = next();
    switch (t.t) {
      case 'num': return { type: 'Num', v: t.v, imag: !!t.imag };
      case 'str': return { type: 'Str', v: t.v };
      case 'dstr': return { type: 'DStr', v: t.v };
      case 'id': return { type: 'Id', name: t.v, line: t.line };
      case 'endv': return { type: 'End' };
      case 'cmd': { // identifier misdetected as command inside expression: re-lex not possible; treat as id
        perr("无法解析 '" + t.v + "' 后的内容。", t.line);
      }
      case 'op':
        if (t.v === '(') { const save = inMatrix; inMatrix = 0; const e = parseExpr(); inMatrix = save; expectOp(')'); return { type: 'Paren', e }; }
        if (t.v === '[') return { type: 'Matrix', rows: parseMatrix(']') };
        if (t.v === '{') return { type: 'CellLit', rows: parseMatrix('}') };
        if (t.v === '@') {
          if (isOp('(')) {
            p++; const params = [];
            while (!isOp(')')) { const q = next(); if (q.t === 'id') params.push(q.v); else if (q.t === 'op' && q.v === '~') params.push('~'); else if (q.t === 'op' && q.v === ',') continue; else perr('匿名函数参数列表无效' + tokDesc(q), q.line); }
            p++;
            const save = inMatrix; inMatrix = 0; const body = parseExpr(); inMatrix = save;
            return { type: 'Anon', params, body };
          }
          const q = next(); if (q.t !== 'id') perr("'@' 后应为函数名或参数列表" + tokDesc(q), q.line);
          let name = q.v; while (isOp('.') && peek(1).t === 'id') { p++; name += '.' + next().v; }
          return { type: 'FuncRef', name };
        }
        if (t.v === ':') return { type: 'Colon' };
      // fallthrough
      default:
        perr('表达式无效' + tokDesc(t).replace(/^，/, '：'), t.line);
    }
  }

  // ---- functions ----
  function parseFunction(parentName) {
    const ft = next(); // 'function'
    const line = ft.line;
    let outs = [], name, params = [];
    // forms: function name, function name(args), function o = name(...), function [o1,o2] = name(...)
    if (isOp('[')) {
      p++; while (!isOp(']')) { const q = next(); if (q.t === 'id') outs.push(q.v); else if (q.t === 'op' && q.v === ',') continue; else perr('函数输出参数列表无效' + tokDesc(q), q.line); }
      p++; expectOp('='); name = next().v;
    } else {
      const q = next(); if (q.t !== 'id' && q.t !== 'cmd') perr('函数名无效' + tokDesc(q), q.line);
      if (q.t === 'cmd') { name = q.v; } // "function foo" parsed as command: no args
      else if (isOp('=')) { p++; outs = [q.v]; name = next().v; }
      else name = q.v;
    }
    while (isOp('.') && peek(1).t === 'id') { p++; name += '.' + next().v; }
    if (isOp('(')) {
      p++; while (!isOp(')')) { const q = next(); if (q.t === 'id') params.push(q.v); else if (q.t === 'op' && q.v === '~') params.push('~'); else if (q.t === 'op' && q.v === ',') continue; else perr('函数参数列表无效' + tokDesc(q), q.line); }
      p++;
    }
    const fn = { name, params, outs, line, nested: [], body: null };
    const body = [];
    for (;;) {
      skipNl();
      const k = peek();
      if (k.t === 'eof') break;
      if (k.t === 'kw' && k.v === 'function') {
        if (endStyle) { fn.nested.push(parseFunction(name)); continue; }
        break;
      }
      if (k.t === 'kw' && k.v === 'end') { if (endStyle) { p++; break; } perr("意外的 'end'。", k.line); }
      body.push(parseStatement());
    }
    fn.body = body;
    return fn;
  }

  const script = []; const funcs = [];
  for (;;) {
    skipNl();
    const t = peek();
    if (t.t === 'eof') break;
    if (t.t === 'kw' && t.v === 'function') { funcs.push(parseFunction(null)); continue; }
    if (funcs.length) perr('函数定义之后不能再有脚本语句。', t.line);
    if (t.t === 'kw' && t.v === 'end') perr("意外的 'end'（没有与之对应的 if/for/while 等语句）。", t.line);
    script.push(parseStatement());
  }
  return { script, funcs, isFunctionFile: script.length === 0 && funcs.length > 0 };
}

// ======================================================================
// Arithmetic & elementwise operations
// ======================================================================
function arithClass(a, b, op) {
  const ca = classOf(a), cb = classOf(b);
  const ia = isIntCls(ca), ib = isIntCls(cb);
  if (ia || ib) {
    if (ia && ib && ca !== cb) err('整数只能与同类整数或双精度标量值组合使用。', 'MATLAB:mixedClasses');
    return ia ? ca : cb;
  }
  if (ca === 'single' || cb === 'single') return 'single';
  return 'double';
}
function bcastDims(da, db) {
  const n = Math.max(da.length, db.length), out = new Array(n);
  for (let i = 0; i < n; i++) {
    const x = i < da.length ? da[i] : 1, y = i < db.length ? db[i] : 1;
    if (x === y || y === 1) out[i] = x; else if (x === 1) out[i] = y;
    else err('对于此运算，数组的大小不兼容。', 'MATLAB:sizeDimensionsMustMatch');
  }
  return out;
}
// returns [outDims, ia array, ib array] index mapping for general broadcast (only used when shapes differ and neither scalar)
function bcastIndex(da, db, dc) {
  const n = dc.length, total = prodDims(dc);
  const ia = new Int32Array(total), ib = new Int32Array(total);
  const sa = new Array(n), sb = new Array(n); let pa = 1, pb = 1;
  for (let k = 0; k < n; k++) { const x = k < da.length ? da[k] : 1, y = k < db.length ? db[k] : 1; sa[k] = x === 1 ? 0 : pa; sb[k] = y === 1 ? 0 : pb; pa *= x; pb *= y; }
  const cnt = new Array(n).fill(0); let ja = 0, jb = 0;
  for (let t = 0; t < total; t++) {
    ia[t] = ja; ib[t] = jb;
    for (let k = 0; k < n; k++) { cnt[k]++; ja += sa[k]; jb += sb[k]; if (cnt[k] < dc[k]) break; ja -= sa[k] * dc[k]; jb -= sb[k] * dc[k]; cnt[k] = 0; }
  }
  return [ia, ib];
}
// generic elementwise: fr(x,y) real kernel; fc(ar,ai,br,bi) -> [r,i] complex kernel (optional)
function elementwise(a, b, fr, fc, outCls, opname) {
  const A = toT(a), B = toT(b);
  const na = A.re.length, nb = B.re.length;
  let dc, ia = null, ib = null;
  if (na === 1 && nb !== 1) dc = B.dims.slice();
  else if (nb === 1) dc = A.dims.slice();
  else if (sameDims(A.dims, B.dims)) dc = A.dims.slice();
  else { dc = bcastDims(A.dims, B.dims); [ia, ib] = bcastIndex(A.dims, B.dims, dc); }
  const total = prodDims(dc);
  const complex = (A.im || B.im) && fc;
  const re = new Array(total);
  let im = null;
  if (!complex) {
    const ar = A.re, br = B.re;
    if (ia) for (let t = 0; t < total; t++) re[t] = fr(ar[ia[t]], br[ib[t]]);
    else if (na === 1 && nb !== 1) { const x = ar[0]; for (let t = 0; t < total; t++) re[t] = fr(x, br[t]); }
    else if (nb === 1) { const y = br[0]; for (let t = 0; t < total; t++) re[t] = fr(ar[t], y); }
    else for (let t = 0; t < total; t++) re[t] = fr(ar[t], br[t]);
  } else {
    im = new Array(total);
    const ar = A.re, br = B.re, ai = A.im, bi = B.im;
    for (let t = 0; t < total; t++) {
      const x = ia ? ia[t] : (na === 1 ? 0 : t), y = ib ? ib[t] : (nb === 1 ? 0 : t);
      const r = fc(ar[x], ai ? ai[x] : 0, br[y], bi ? bi[y] : 0);
      re[t] = r[0]; im[t] = r[1];
    }
  }
  if (isIntCls(outCls)) { for (let t = 0; t < total; t++) re[t] = satInt(outCls, re[t]); im = null; }
  else if (outCls === 'single') { for (let t = 0; t < total; t++) re[t] = Math.fround(re[t]); if (im) for (let t = 0; t < total; t++) im[t] = Math.fround(im[t]); }
  return mk(outCls, dc, re, im);
}
function sameDims(a, b) { if (a.length !== b.length) return false; for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false; return true; }

const cmul = (a, b, c, d) => [a * c - b * d, a * d + b * c];
const cdiv = (a, b, c, d) => {
  if (d === 0) return b === 0 ? [a / c, 0] : [a / c, b / c];
  if (Math.abs(c) >= Math.abs(d)) { const r = d / c, den = c + d * r; return [(a + b * r) / den, (b - a * r) / den]; }
  const r = c / d, den = c * r + d; return [(a * r + b) / den, (b * r - a) / den];
};
function cpow(a, b, c, d) {
  if (a === 0 && b === 0) { if (c === 0 && d === 0) return [1, 0]; return [0, 0]; }
  if (b === 0 && d === 0 && (a >= 0 || Number.isInteger(c))) return [Math.pow(a, c), 0];
  const lr = Math.log(Math.hypot(a, b)), th = Math.atan2(b, a);
  const er = c * lr - d * th, ei = d * lr + c * th; const m = Math.exp(er);
  return [m * Math.cos(ei), m * Math.sin(ei)];
}
function powReal(x, y) { return Math.pow(x, y); }

function stringBinop(op, a, b) {
  const toSA = v => { if (v instanceof MString) return v; if (isChar(v)) return mkStrings([toStr(v)]); if (v instanceof MCell) return new MString(v.dims, v.data.map(x => toStr(x))); if (isTensorLike(v)) { const t = toT(v); return new MString(t.dims, t.re.map(x => fmtG(x))); } err('无法将该类型与 string 组合。'); };
  const A = toSA(a), B = toSA(b);
  const na = A.data.length, nb = B.data.length;
  const dims = na === 1 ? B.dims : A.dims; const n = Math.max(na, nb);
  if (na !== 1 && nb !== 1 && na !== nb) err('对于此运算，数组的大小不兼容。');
  const out = new Array(n);
  for (let i = 0; i < n; i++) {
    const x = A.data[na === 1 ? 0 : i], y = B.data[nb === 1 ? 0 : i];
    switch (op) {
      case '+': out[i] = x + y; break;
      case '==': out[i] = x === y ? 1 : 0; break; case '~=': out[i] = x !== y ? 1 : 0; break;
      case '<': out[i] = x < y ? 1 : 0; break; case '>': out[i] = x > y ? 1 : 0; break;
      case '<=': out[i] = x <= y ? 1 : 0; break; case '>=': out[i] = x >= y ? 1 : 0; break;
      default: err("未定义 string 类型的运算符 '" + op + "'。");
    }
  }
  if (op === '+') return new MString(dims.slice(), out);
  return mk('logical', dims.slice(), out);
}

function binop(op, a, b) {
  if (typeof a === 'number' && typeof b === 'number') {
    switch (op) {
      case '+': return a + b; case '-': return a - b;
      case '*': case '.*': return a * b;
      case '/': case './': return a / b;
      case '\\': case '.\\': return b / a;
      case '^': case '.^': { if (a < 0 && !Number.isInteger(b)) break; return Math.pow(a, b); }
      case '<': return a < b; case '>': return a > b; case '<=': return a <= b; case '>=': return a >= b;
      case '==': return a === b; case '~=': return a !== b;
      case '&': if (a !== a || b !== b) err('NaN 不能转换为逻辑值。'); return a !== 0 && b !== 0;
      case '|': if (a !== a || b !== b) err('NaN 不能转换为逻辑值。'); return a !== 0 || b !== 0;
    }
  }
  if (a instanceof MString || b instanceof MString) return stringBinop(op, a, b);
  if (!isTensorLike(a) || !isTensorLike(b)) {
    const bad = !isTensorLike(a) ? a : b;
    err("未定义与 '" + classOf(bad) + "' 类型的输入参数相对应的运算符 '" + op + "'。", 'MATLAB:UndefinedFunction');
  }
  switch (op) {
    case '+': return elementwise(a, b, (x, y) => x + y, (p, q, r, s) => [p + r, q + s], arithClass(a, b));
    case '-': return elementwise(a, b, (x, y) => x - y, (p, q, r, s) => [p - r, q - s], arithClass(a, b));
    case '.*': return elementwise(a, b, (x, y) => x * y, cmul, arithClass(a, b));
    case './': return elementwise(a, b, (x, y) => x / y, cdiv, arithClass(a, b));
    case '.\\': return elementwise(a, b, (x, y) => y / x, (p, q, r, s) => cdiv(r, s, p, q), arithClass(a, b));
    case '.^': {
      const cls = arithClass(a, b);
      // negative base with fractional exponent -> complex
      const A = toT(a), B = toT(b);
      let needC = !!(A.im || B.im);
      if (!needC && !isIntCls(cls)) { const ar = A.re, br = B.re; outer: for (let i = 0; i < ar.length; i++) if (ar[i] < 0) { for (let j = 0; j < br.length; j++) if (!Number.isInteger(br[j])) { needC = true; break outer; } } }
      if (needC) { const Ac = A.im ? A : new Tensor(A.cls, A.dims, A.re, zerosArr(A.re.length)); return elementwise(Ac, B, powReal, cpow, cls); }
      return elementwise(a, b, powReal, cpow, cls);
    }
    case '*': if (numelOf(a) === 1 || numelOf(b) === 1) return binop('.*', a, b); return mtimes(a, b);
    case '/': if (numelOf(b) === 1) return binop('./', a, b); return mrdivide(a, b);
    case '\\': if (numelOf(a) === 1) return binop('.\\', a, b); return mldivide(a, b);
    case '^': return mpower(a, b);
    case '<': return elementwise(a, b, (x, y) => x < y ? 1 : 0, null, 'logical');
    case '>': return elementwise(a, b, (x, y) => x > y ? 1 : 0, null, 'logical');
    case '<=': return elementwise(a, b, (x, y) => x <= y ? 1 : 0, null, 'logical');
    case '>=': return elementwise(a, b, (x, y) => x >= y ? 1 : 0, null, 'logical');
    case '==': return elementwise(a, b, (x, y) => x === y ? 1 : 0, (p, q, r, s) => [p === r && q === s ? 1 : 0, 0], 'logical');
    case '~=': return elementwise(a, b, (x, y) => x !== y ? 1 : 0, (p, q, r, s) => [p !== r || q !== s ? 1 : 0, 0], 'logical');
    case '&': return elementwise(a, b, (x, y) => { if (x !== x || y !== y) err('NaN 不能转换为逻辑值。'); return x !== 0 && y !== 0 ? 1 : 0; }, null, 'logical');
    case '|': return elementwise(a, b, (x, y) => { if (x !== x || y !== y) err('NaN 不能转换为逻辑值。'); return x !== 0 || y !== 0 ? 1 : 0; }, null, 'logical');
  }
  err('未知运算符 ' + op);
}
function unop(op, a) {
  if (typeof a === 'number') { if (op === '-') return -a; if (op === '+') return a; if (a !== a) err('NaN 不能转换为逻辑值。'); return a === 0; }
  if (typeof a === 'boolean') { if (op === '~') return !a; return op === '-' ? (a ? -1 : 0) : (a ? 1 : 0); }
  if (!(a instanceof Tensor)) err("未定义与 '" + classOf(a) + "' 类型的输入参数相对应的运算符 '" + op + "'。");
  if (op === '~') return mk('logical', a.dims.slice(), a.re.map(x => { if (x !== x) err('NaN 不能转换为逻辑值。'); return x === 0 ? 1 : 0; }));
  const cls = (a.cls === 'logical' || a.cls === 'char') ? 'double' : a.cls;
  if (op === '+') return mk(cls, a.dims.slice(), a.re.slice(), a.im ? a.im.slice() : null);
  const re = a.re.map(x => -x);
  if (isIntCls(cls)) for (let i = 0; i < re.length; i++) re[i] = satInt(cls, re[i]);
  return mk(cls, a.dims.slice(), re, a.im ? a.im.map(x => -x) : null);
}
function transpose(a, conj) {
  if (typeof a === 'number' || typeof a === 'boolean') return a;
  if (a instanceof FHandle || a instanceof MapObj) return a;
  const d = a.dims; if (d.length > 2) err('未定义 N 维数组的转置。请使用 permute。');
  const r = d[0], c = d[1];
  const perm = (src) => { const out = new Array(src.length); for (let i = 0; i < r; i++) for (let j = 0; j < c; j++) out[j + i * c] = src[i + j * r]; return out; };
  if (a instanceof Tensor) {
    let im = a.im ? perm(a.im) : null;
    if (im && conj) im = im.map(x => -x);
    return mk(a.cls, [c, r], perm(a.re), im, !!a.im);
  }
  if (a instanceof MCell) { for (const x of a.data) markShared(x); return new MCell([c, r], perm(a.data)); }
  if (a instanceof MString) return new MString([c, r], perm(a.data));
  if (a instanceof MStruct) { const s = copyValue(a); s.dims = [c, r]; s.data = perm(s.data); return s; }
  return a;
}

// ======================================================================
// Matrix operations
// ======================================================================
function matOf(a) { const t = toT(a); if (t.dims.length > 2) err('参数必须为二维矩阵。'); return t; }
function mtimes(a, b) {
  const A = matOf(a), B = matOf(b);
  const m = A.dims[0], k = A.dims[1], k2 = B.dims[0], n = B.dims[1];
  if (k !== k2) err('用于矩阵乘法的维度不正确。请检查并确保第一个矩阵中的列数与第二个矩阵中的行数匹配。要执行按元素相乘，请使用 \'.*\'。', 'MATLAB:innerdim');
  const cls = arithClass(a, b);
  const ar = A.re, br = B.re;
  const re = new Array(m * n).fill(0);
  if (!A.im && !B.im) {
    for (let j = 0; j < n; j++) for (let p = 0; p < k; p++) { const bv = br[p + j * k]; if (bv === 0) continue; const off = p * m, oo = j * m; for (let i = 0; i < m; i++) re[i + oo] += ar[i + off] * bv; }
    // handle NaN/Inf times zero correctly
    if (hasNonFinite(ar) || hasNonFinite(br)) { for (let i = 0; i < m; i++) for (let j = 0; j < n; j++) { let s = 0; for (let p = 0; p < k; p++) s += ar[i + p * m] * br[p + j * k]; re[i + j * m] = s; } }
    if (isIntCls(cls)) for (let i = 0; i < re.length; i++) re[i] = satInt(cls, re[i]);
    return mk(cls, [m, n], re);
  }
  const ai = A.im || zerosArr(ar.length), bi = B.im || zerosArr(br.length); const im = new Array(m * n).fill(0);
  for (let i = 0; i < m; i++) for (let j = 0; j < n; j++) { let sr = 0, si = 0; for (let p = 0; p < k; p++) { const x = ar[i + p * m], y = ai[i + p * m], u = br[p + j * k], v = bi[p + j * k]; sr += x * u - y * v; si += x * v + y * u; } re[i + j * m] = sr; im[i + j * m] = si; }
  return mk(cls, [m, n], re, im);
}
function hasNonFinite(a) { for (let i = 0; i < a.length; i++) if (!isFinite(a[i])) return true; return false; }
// dense helpers: column-major arrays
function getMat(a) { const t = matOf(a); if (t.im) err('该函数暂不支持复数矩阵。'); return { m: t.dims[0], n: t.dims[1], a: t.re.slice() }; }
function luDecomp(A, n) { // in place, returns {piv, sign, singular}
  const piv = new Array(n); for (let i = 0; i < n; i++) piv[i] = i; let sign = 1, singular = false;
  for (let k = 0; k < n; k++) {
    let p = k, mx = Math.abs(A[k + k * n]);
    for (let i = k + 1; i < n; i++) { const v = Math.abs(A[i + k * n]); if (v > mx) { mx = v; p = i; } }
    if (mx === 0) { singular = true; continue; }
    if (p !== k) { for (let j = 0; j < n; j++) { const t = A[k + j * n]; A[k + j * n] = A[p + j * n]; A[p + j * n] = t; } const t = piv[k]; piv[k] = piv[p]; piv[p] = t; sign = -sign; }
    const d = A[k + k * n];
    for (let i = k + 1; i < n; i++) { const f = (A[i + k * n] /= d); if (f !== 0) for (let j = k + 1; j < n; j++) A[i + j * n] -= f * A[k + j * n]; }
  }
  return { piv, sign, singular };
}
function rcondEst(LU, n, Aorig) {
  // crude: ratio of min/max abs diagonal of U
  let mn = Infinity, mx = 0; for (let i = 0; i < n; i++) { const v = Math.abs(LU[i + i * n]); if (v < mn) mn = v; if (v > mx) mx = v; }
  return mx === 0 ? 0 : mn / mx;
}
function luSolve(LU, n, piv, B, nrhs) {
  const X = new Array(n * nrhs);
  for (let c = 0; c < nrhs; c++) {
    for (let i = 0; i < n; i++) X[i + c * n] = B[piv[i] + c * n];
    for (let i = 0; i < n; i++) { let s = X[i + c * n]; for (let j = 0; j < i; j++) s -= LU[i + j * n] * X[j + c * n]; X[i + c * n] = s; }
    for (let i = n - 1; i >= 0; i--) { let s = X[i + c * n]; for (let j = i + 1; j < n; j++) s -= LU[i + j * n] * X[j + c * n]; X[i + c * n] = s / LU[i + i * n]; }
  }
  return X;
}
function warnSingular(rc) { if (rc === 0) warnMsg('矩阵为奇异工作精度。'); else warnMsg('矩阵接近奇异值，或者缩放错误。结果可能不准确。RCOND = ' + fmtE(rc, 6) + '。'); }
function mldivide(a, b) {
  const A = getMat(a), B = getMat(b);
  if (A.m !== B.m) err('矩阵维度必须一致。', 'MATLAB:dimagree');
  const nrhs = B.n;
  if (A.m === A.n) {
    const n = A.n; const LU = A.a.slice(); const f = luDecomp(LU, n);
    const rc = rcondEst(LU, n);
    if (f.singular || rc < 1e-15) { warnSingular(f.singular ? 0 : rc); if (f.singular) { return mk('double', [n, nrhs], luSolveSingular(LU, n, f.piv, B.a, nrhs)); } }
    return mk('double', [n, nrhs], luSolve(LU, n, f.piv, B.a, nrhs));
  }
  return mk('double', [A.n, nrhs], lstsq(A.a, A.m, A.n, B.a, nrhs));
}
function luSolveSingular(LU, n, piv, B, nrhs) { const X = luSolve(LU, n, piv, B, nrhs); return X.map(v => (v !== v ? Infinity : v)); }
function mrdivide(a, b) { return transpose(mldivide(transpose(b), transpose(a))); }
// Householder QR least squares: A m x n (col-major), B m x nrhs
function householderQR(A, m, n) {
  const R = A.slice(); const vs = []; const betas = [];
  const kmax = Math.min(m - 1, n);
  for (let k = 0; k < Math.min(m, n); k++) {
    let norm = 0; for (let i = k; i < m; i++) norm += R[i + k * m] * R[i + k * m]; norm = Math.sqrt(norm);
    const v = new Array(m).fill(0);
    if (norm === 0 || k >= kmax + (m > n ? 0 : 0) && k === m - 1) { vs.push(null); betas.push(0); continue; }
    const alpha = R[k + k * m] > 0 ? -norm : norm;
    for (let i = k; i < m; i++) v[i] = R[i + k * m]; v[k] -= alpha;
    let vn = 0; for (let i = k; i < m; i++) vn += v[i] * v[i];
    if (vn === 0) { vs.push(null); betas.push(0); continue; }
    const beta = 2 / vn;
    for (let j = k; j < n; j++) { let s = 0; for (let i = k; i < m; i++) s += v[i] * R[i + j * m]; s *= beta; for (let i = k; i < m; i++) R[i + j * m] -= s * v[i]; }
    vs.push(v); betas.push(beta);
  }
  return { R, vs, betas };
}
function applyQt(qr, B, m, nrhs) {
  const X = B.slice();
  for (let k = 0; k < qr.vs.length; k++) { const v = qr.vs[k]; if (!v) continue; const beta = qr.betas[k];
    for (let c = 0; c < nrhs; c++) { let s = 0; for (let i = k; i < m; i++) s += v[i] * X[i + c * m]; s *= beta; for (let i = k; i < m; i++) X[i + c * m] -= s * v[i]; } }
  return X;
}
function lstsq(A, m, n, B, nrhs) {
  if (m >= n) {
    const qr = householderQR(A, m, n); const QtB = applyQt(qr, B, m, nrhs); const R = qr.R;
    let rankDef = false; let mx = 0; for (let i = 0; i < n; i++) mx = Math.max(mx, Math.abs(R[i + i * m]));
    const X = new Array(n * nrhs).fill(0);
    for (let c = 0; c < nrhs; c++) for (let i = n - 1; i >= 0; i--) { let s = QtB[i + c * m]; for (let j = i + 1; j < n; j++) s -= R[i + j * m] * X[j + c * n]; const d = R[i + i * m]; if (Math.abs(d) <= mx * 1e-13) { rankDef = true; X[i + c * n] = 0; } else X[i + c * n] = s / d; }
    if (rankDef) warnMsg('秩亏，结果可能不准确。');
    return X;
  }
  // underdetermined: minimum norm via pinv
  const P = pinvRaw(A, m, n); const X = new Array(n * nrhs).fill(0);
  for (let c = 0; c < nrhs; c++) for (let i = 0; i < n; i++) { let s = 0; for (let k = 0; k < m; k++) s += P[i + k * n] * B[k + c * m]; X[i + c * n] = s; }
  return X;
}
function invRaw(A, n) {
  const LU = A.slice(); const f = luDecomp(LU, n); const I = new Array(n * n).fill(0); for (let i = 0; i < n; i++) I[i + i * n] = 1;
  if (f.singular) { warnSingular(0); return new Array(n * n).fill(Infinity); }
  const rc = rcondEst(LU, n); if (rc < 1e-15) warnSingular(rc);
  return luSolve(LU, n, f.piv, I, n);
}
function mpower(a, b) {
  if (numelOf(a) === 1 && numelOf(b) === 1) return binop('.^', a, b);
  if (numelOf(b) === 1) {
    const A = matOf(a); if (A.dims[0] !== A.dims[1]) err('用于求矩阵幂的输入必须为方阵。要执行按元素求幂，请使用 \'.^\'。');
    let p = toNum(b); const n = A.dims[0];
    if (!Number.isInteger(p)) { // via eig for symmetric
      const E = eigSym(A.re.slice(), n); const D = E.d.map(x => Math.pow(x, p));
      const V = E.V; const R = new Array(n * n).fill(0);
      for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) { let s = 0; for (let k = 0; k < n; k++) s += V[i + k * n] * D[k] * V[j + k * n]; R[i + j * n] = s; }
      return mk('double', [n, n], R);
    }
    let base = A; if (p < 0) { base = mk('double', [n, n], invRaw(A.re.slice(), n)); p = -p; }
    let result = null; let cur = base;
    while (p > 0) { if (p & 1) result = result === null ? cur : mtimes(result, cur); p = Math.floor(p / 2); if (p) cur = mtimes(cur, cur); }
    if (result === null) { const I = new Array(n * n).fill(0); for (let i = 0; i < n; i++) I[i + i * n] = 1; return mk('double', [n, n], I); }
    return result;
  }
  err('不支持标量的矩阵次幂运算（请使用 expm）。');
}

// ======================================================================
// Colon / ranges
// ======================================================================
function rangeCount(a, s, b) {
  if (s === 0 || (s > 0 && a > b) || (s < 0 && a < b) || a !== a || s !== s || b !== b) return 0;
  const n = Math.floor((b - a) / s * (1 + 1e-15) + 1e-10) + 1;
  return n;
}
function makeRange(a, s, b) {
  const cls = [a, s, b].map(classOf);
  const isc = cls.find(isIntCls);
  const av = toNum(a), sv = toNum(s), bv = toNum(b);
  const n = rangeCount(av, sv, bv);
  if (!isFinite(n) || n > 2e8) err('超出最大可能数组大小。');
  const re = new Array(Math.max(n, 0));
  for (let k = 0; k < n; k++) re[k] = av + k * sv;
  if (n > 0 && sv !== 0 && !Number.isInteger(sv)) { // symmetric correction for last element
    const last = av + (n - 1) * sv; if (Math.abs(last - bv) < Math.abs(sv) * 1e-10) re[n - 1] = bv;
  }
  if (isChar(a) && isChar(b)) return mk('char', [1, n], re);
  if (isc) return mk(isc, [1, n], re.map(x => satInt(isc, x)));
  return new Tensor('double', [1, n], re).re.length === 1 ? re[0] : new Tensor('double', [1, n], re);
}

// ======================================================================
// Concatenation
// ======================================================================
function catGeneric(dim, vals) { // dim: 1 (vertical) or 2 (horizontal) or n
  // drop [] (0x0) entries
  let items = vals.filter(v => !(isTensorLike(v) && dimsOf(v).length === 2 && dimsOf(v)[0] === 0 && dimsOf(v)[1] === 0 && !(v instanceof Tensor && v.cls === 'char' && false)));
  if (items.length === 0) {
    if (vals.length && vals.some(v => v instanceof MCell)) return new MCell([0, 0], []);
    if (vals.some(v => v instanceof MString)) return new MString([0, 0], []);
    if (vals.length && vals.every(v => isChar(v))) return new Tensor('char', [0, 0], []);
    return emptyD();
  }
  if (items.length === 1 && vals.length === 1) return items[0];
  const anyCell = items.some(v => v instanceof MCell), anyStruct = items.some(v => v instanceof MStruct);
  const anyStr = items.some(v => v instanceof MString);
  if (items.some(v => v instanceof FHandle)) err('不能串联函数句柄，请使用元胞数组。');
  if (anyCell) items = items.map(v => (v instanceof MCell ? v : new MCell([1, 1], [v]))).filter(v => !(v.dims[0] === 0 && v.dims[1] === 0) || items.length === 1);
  else if (anyStr) items = items.map(v => (v instanceof MString ? v : isChar(v) ? new MString([1, 1], [toStr(v)]) : isTensorLike(v) ? new MString(dimsOf(v).slice(), toArr(v).map(x => fmtG(x))) : err('无法将该类型串联到 string 数组。')));
  else if (anyStruct) { if (!items.every(v => v instanceof MStruct)) err('无法将结构体与其他类型串联。'); }
  if (items.length === 0) return anyCell ? new MCell([0, 0], []) : emptyD();
  // dims check
  const d0 = items[0].dims ? items[0].dims : dimsOf(items[0]);
  const nd = Math.max(dim, ...items.map(v => dimsOf(v).length));
  const getd = (v, k) => { const d = dimsOf(v); return k < d.length ? d[k] : 1; };
  let total = 0;
  for (const v of items) {
    for (let k = 0; k < nd; k++) if (k !== dim - 1 && getd(v, k) !== getd(items[0], k)) err('要串联的数组的维度不一致。', 'MATLAB:catenate:dimensionMismatch');
    total += getd(v, dim - 1);
  }
  const outDims = []; for (let k = 0; k < nd; k++) outDims.push(k === dim - 1 ? total : getd(items[0], k));
  // block sizes
  let inner = 1; for (let k = 0; k < dim - 1; k++) inner *= outDims[k];
  let outer = 1; for (let k = dim; k < nd; k++) outer *= outDims[k];
  const n = prodDims(outDims);
  if (anyCell || anyStr || anyStruct) {
    const data = new Array(n); let off = 0;
    for (const v of items) { const w = getd(v, dim - 1) * inner; for (let o = 0; o < outer; o++) for (let t = 0; t < w; t++) data[o * total * inner + off + t] = v.data[o * w + t]; off += w; }
    if (anyCell) { for (const x of data) markShared(x); return new MCell(outDims, data); }
    if (anyStr) return new MString(outDims, data);
    const fields = items[0].fields.slice();
    for (const v of items) for (const f of v.fields) if (fields.indexOf(f) < 0) fields.push(f);
    const nd2 = data.map(o => { const c = Object.create(null); for (const f of fields) c[f] = o[f] !== undefined ? markShared(o[f]) : emptyD(); return c; });
    return new MStruct(outDims, fields, nd2);
  }
  // tensors
  let cls;
  const clss = items.map(classOf);
  if (clss.some(c => c === 'char')) cls = 'char';
  else if (clss.some(isIntCls)) cls = clss.find(isIntCls);
  else if (clss.some(c => c === 'single')) cls = 'single';
  else if (clss.every(c => c === 'logical')) cls = 'logical';
  else cls = 'double';
  const ts = items.map(toT);
  const complex = ts.some(t => t.im);
  const re = new Array(n), im = complex ? new Array(n).fill(0) : null; let off = 0;
  for (const t of ts) {
    const w = getd(t, dim - 1) * inner;
    for (let o = 0; o < outer; o++) { const base = o * total * inner + off, sb = o * w; for (let k = 0; k < w; k++) re[base + k] = t.re[sb + k]; if (complex && t.im) for (let k = 0; k < w; k++) im[base + k] = t.im[sb + k]; }
    off += w;
  }
  if (isIntCls(cls)) for (let k = 0; k < n; k++) re[k] = satInt(cls, re[k]);
  return mk(cls, outDims, re, im);
}
function horzcat(vals) {
  if (vals.length === 1) return vals[0];
  let allNum = true; for (let i = 0; i < vals.length; i++) if (typeof vals[i] !== 'number') { allNum = false; break; }
  if (allNum) return new Tensor('double', [1, vals.length], vals.slice());
  return catGeneric(2, vals);
}
function vertcat(vals) {
  if (vals.length === 1) return vals[0];
  // char rows of different lengths -> error like MATLAB
  return catGeneric(1, vals);
}

// ======================================================================
// Indexing
// ======================================================================
function idxErrPositive(x) {
  if (x === 0) err('索引超出范围；数组索引必须为正整数或逻辑值（索引为 0）。', 'MATLAB:index:outOfBounds');
  err('数组索引必须为正整数或逻辑值。', 'MATLAB:badsubscript');
}
// convert one subscript to list of 0-based positions. len = extent of that dimension (for colon & logical)
function subList(arg, len) {
  if (arg === COLON) { const a = new Array(len); for (let i = 0; i < len; i++) a[i] = i; return a; }
  if (typeof arg === 'number') { if (!(arg >= 1) || arg !== Math.floor(arg)) idxErrPositive(arg); return [arg - 1]; }
  if (typeof arg === 'boolean') return arg ? [0] : [];
  if (arg instanceof Tensor) {
    if (arg.cls === 'logical') {
      const re = arg.re; const out = [];
      for (let i = 0; i < re.length; i++) if (re[i]) { if (i >= len) err('索引超出数组边界。逻辑索引包含超出数组边界的 true 值。', 'MATLAB:badsubscript'); out.push(i); }
      return out;
    }
    if (arg.cls === 'char' && arg.re.length === 1 && arg.re[0] === 58) return subList(COLON, len);
    const re = arg.re; const out = new Array(re.length);
    for (let i = 0; i < re.length; i++) { const x = re[i]; if (!(x >= 1) || x !== Math.floor(x)) idxErrPositive(x); out[i] = x - 1; }
    return out;
  }
  err('索引类型无效（' + classOf(arg) + '）。', 'MATLAB:badsubscript');
}
function isVecDims(d) { return d.length === 2 && (d[0] === 1 || d[1] === 1); }
// compute linear indices & output dims for reading
function computeIndex(dims, args, forAssign) {
  const N = prodDims(dims);
  if (args.length === 1) {
    const a = args[0];
    const lin = subList(a, N);
    let odims;
    if (a === COLON) odims = [N, 1];
    else if (typeof a === 'number' || typeof a === 'boolean') odims = [1, lin.length];
    else if (a.cls === 'logical') {
      if (dims.length === 2 && dims[0] === 1 && (a.dims.length === 2 && a.dims[0] === 1 || true) && isVecDims(dims) && dims[0] === 1) odims = [1, lin.length];
      else if (isVecDims(a.dims) && a.dims[0] === 1 && isVecDims(dims) && dims[0] === 1) odims = [1, lin.length];
      else odims = [lin.length, 1];
      if (N === 1 && a.dims[0] === 1) odims = [1, lin.length];
    } else if (a.cls === 'char' && a.re.length === 1 && a.re[0] === 58) odims = [N, 1];
    else {
      const id = a.dims;
      if (isVecDims(id) && isVecDims(dims) && N !== 1) odims = dims[0] === 1 ? [1, lin.length] : [lin.length, 1];
      else odims = id.slice();
    }
    return { lin, odims, maxIdx: maxOf(lin) };
  }
  const na = args.length;
  const ed = new Array(na);
  for (let k = 0; k < na; k++) ed[k] = k < na - 1 ? (k < dims.length ? dims[k] : 1) : prodDims(dims.slice(k));
  const lists = new Array(na); const odims = new Array(na);
  for (let k = 0; k < na; k++) { lists[k] = subList(args[k], ed[k]); odims[k] = lists[k].length; }
  return { lists, odims, ed };
}
function maxOf(a) { let m = -1; for (let i = 0; i < a.length; i++) if (a[i] > m) m = a[i]; return m; }
function outOfRange(idx, n) { err('索引超出数组元素的数目。索引不能超过 ' + n + '。（索引为 ' + idx + '）', 'MATLAB:index:outOfBounds'); }

function listsToLinear(lists, ed) {
  const na = lists.length; let total = 1; for (const l of lists) total *= l.length;
  const lin = new Array(total);
  const strides = new Array(na); let s = 1; for (let k = 0; k < na; k++) { strides[k] = s; s *= ed[k]; }
  if (na === 2) { const L0 = lists[0], L1 = lists[1], s1 = strides[1]; let t = 0; for (let j = 0; j < L1.length; j++) { const b = L1[j] * s1; for (let i = 0; i < L0.length; i++) lin[t++] = L0[i] + b; } return lin; }
  const cnt = new Array(na).fill(0);
  for (let t = 0; t < total; t++) {
    let li = 0; for (let k = 0; k < na; k++) li += lists[k][cnt[k]] * strides[k];
    lin[t] = li;
    for (let k = 0; k < na; k++) { cnt[k]++; if (cnt[k] < lists[k].length) break; cnt[k] = 0; }
  }
  return lin;
}
function gather(v, lin, odims) {
  if (v instanceof Tensor) {
    const re = v.re, n = lin.length, out = new Array(n);
    for (let i = 0; i < n; i++) out[i] = re[lin[i]];
    let im = null; if (v.im) { im = new Array(n); for (let i = 0; i < n; i++) im[i] = v.im[lin[i]]; }
    return mk(v.cls, odims, out, im);
  }
  if (v instanceof MCell) { const out = lin.map(i => markShared(v.data[i])); return new MCell(normDims(odims), out); }
  if (v instanceof MString) return new MString(normDims(odims), lin.map(i => v.data[i]));
  if (v instanceof MStruct) {
    const data = lin.map(i => { const o = v.data[i], c = Object.create(null); for (const k in o) c[k] = markShared(o[k]); return c; });
    return new MStruct(normDims(odims), v.fields.slice(), data, v.cn);
  }
  err('无法索引该类型的值。');
}
function indexValue(v, args) {
  // fast paths
  if (v instanceof Tensor) {
    if (args.length === 1 && typeof args[0] === 'number') {
      const i = args[0];
      if (i >= 1 && i <= v.re.length && i === (i | 0)) {
        const x = v.re[i - 1];
        if (v.cls === 'double' && !v.im) return x;
        if (v.cls === 'logical') return x !== 0;
        return mk(v.cls, [1, 1], [x], v.im ? [v.im[i - 1]] : null);
      }
    } else if (args.length === 2 && typeof args[0] === 'number' && typeof args[1] === 'number' && v.dims.length === 2) {
      const i = args[0], j = args[1], r = v.dims[0];
      if (i >= 1 && j >= 1 && i <= r && j <= v.dims[1] && i === (i | 0) && j === (j | 0)) {
        const k = i - 1 + (j - 1) * r; const x = v.re[k];
        if (v.cls === 'double' && !v.im) return x;
        if (v.cls === 'logical') return x !== 0;
        return mk(v.cls, [1, 1], [x], v.im ? [v.im[k]] : null);
      }
    }
  }
  if (typeof v === 'number' || typeof v === 'boolean') {
    let ok = true; for (const a of args) if (!(a === 1 || a === COLON || a === true)) { ok = false; break; }
    if (ok && args.length > 0) return v;
    v = toT(v);
  }
  if (v instanceof FHandle) err('函数句柄不能被索引，请用括号调用。');
  if (v instanceof MapObj) err('containers.Map 索引需要一个键。');
  const dims = v.dims;
  if (args.length === 0) return v;
  const ci = computeIndex(dims, args);
  if (args.length === 1) {
    const N = prodDims(dims);
    if (ci.maxIdx >= N) outOfRange(ci.maxIdx + 1, N);
    return gather(v, ci.lin, ci.odims);
  }
  for (let k = 0; k < ci.lists.length; k++) { const m = maxOf(ci.lists[k]); if (m >= ci.ed[k]) err('索引超出数组边界。位置 ' + (k + 1) + ' 处的索引超出范围（不能超过 ' + ci.ed[k] + '）。', 'MATLAB:index:outOfBounds'); }
  return gather(v, listsToLinear(ci.lists, ci.ed), ci.odims);
}
function braceIndex(v, args) { // returns array (cs-list)
  if (!(v instanceof MCell)) {
    if (v instanceof MString) { const r = indexValue(v, args); return r.data.map(s => mkStr(s)); }
    err('此类型的变量不支持使用花括号进行索引。', 'MATLAB:cellRefFromNonCell');
  }
  if (args.length === 1 && typeof args[0] === 'number') {
    const i = args[0]; if (i >= 1 && i <= v.data.length && i === (i | 0)) return [v.data[i - 1]];
  }
  const r = indexValue(v, args);
  return r.data.slice();
}
function fieldGet(v, name) { // returns cs-list
  if (v instanceof MStruct) {
    if (v.fields.indexOf(name) < 0) {
      if (v.cn === 'MException' && name === 'stack') return [v.data[0].stack];
      err("无法识别的字段名称 \"" + name + "\"。", 'MATLAB:nonExistentField');
    }
    return v.data.map(o => o[name]);
  }
  if (v instanceof MapObj) {
    if (name === 'Count') return [v.map.size];
    if (name === 'KeyType') return [mkStr(v.kt)];
    if (name === 'ValueType') return [mkStr(v.vt)];
    err("containers.Map 没有属性 '" + name + "'。");
  }
  err("点索引仅适用于结构体（当前为 '" + classOf(v) + "'）。", 'MATLAB:structRefFromNonStruct');
}

// ======================================================================
// Indexed assignment
// ======================================================================
function defaultFill(v) { if (v instanceof MCell) return emptyD(); if (v instanceof MString) return ''; return 0; }
function emptyLike(rhs) {
  if (rhs instanceof MCell) return new MCell([0, 0], []);
  if (rhs instanceof MStruct) return new MStruct([0, 0], rhs.fields.slice(), [], rhs.cn);
  if (rhs instanceof MString) return new MString([0, 0], []);
  if (rhs instanceof FHandle) return null;
  const t = toT(rhs); return new Tensor(t.cls, [0, 0], [], null);
}
function dataOf(v) { return v instanceof Tensor ? v.re : v.data; }
// resize v to newDims (column-major relayout), padding with fill
function resizeTo(v, newDims) {
  const od = v.dims, n = prodDims(newDims);
  const fillv = v instanceof Tensor ? 0 : v instanceof MCell ? null : v instanceof MString ? '' : null;
  const src = dataOf(v);
  const out = new Array(n);
  const isStruct = v instanceof MStruct;
  const mkFill = () => { if (v instanceof MCell) return emptyD(); if (isStruct) { const o = Object.create(null); for (const f of v.fields) o[f] = emptyD(); return o; } return fillv; };
  for (let i = 0; i < n; i++) out[i] = undefined;
  let im = null; if (v instanceof Tensor && v.im) im = new Array(n).fill(0);
  // map old coords
  const on = prodDims(od);
  if (od.length === 2 && newDims.length === 2) {
    const r0 = od[0], r1 = newDims[0];
    for (let j = 0; j < od[1]; j++) for (let i = 0; i < r0; i++) { out[i + j * r1] = src[i + j * r0]; if (im) im[i + j * r1] = v.im[i + j * r0]; }
  } else {
    const cnt = new Array(od.length).fill(0);
    for (let t = 0; t < on; t++) {
      let li = 0, s = 1; for (let k = 0; k < newDims.length; k++) { li += (k < od.length ? cnt[k] : 0) * s; s *= newDims[k]; }
      out[li] = src[t]; if (im) im[li] = v.im[t];
      for (let k = 0; k < od.length; k++) { cnt[k]++; if (cnt[k] < od[k]) break; cnt[k] = 0; }
    }
  }
  for (let i = 0; i < n; i++) if (out[i] === undefined) out[i] = mkFill();
  if (v instanceof Tensor) { v.re = out; v.im = im; }
  else v.data = out;
  v.dims = normDims(newDims.slice());
}
function convertForAssign(cur, rhs) {
  // returns [cur (possibly converted, owned), rhsTensorOrValue]
  if (cur instanceof Tensor) {
    if (rhs instanceof MCell) { if (cur.re.length === 0) return [new MCell(cur.dims.slice(), []), rhs]; err('无法从 cell 转换为 ' + cur.cls + '。'); }
    if (rhs instanceof MStruct) { if (cur.re.length === 0) return [new MStruct(cur.dims.slice(), rhs.fields.slice(), [], rhs.cn), rhs]; err('无法从 struct 转换为 ' + cur.cls + '。'); }
    if (rhs instanceof MString) { if (cur.re.length === 0 || cur.cls === 'char') return [new MString(cur.dims.slice(), cur.re.length ? [toStr(cur)] : []), rhs]; return [new MString(cur.dims.slice(), cur.re.map(x => fmtG(x))), rhs]; }
    if (rhs instanceof FHandle) err('不能将函数句柄存入数组，请使用元胞数组。');
    const rt = toT(rhs);
    let cls = cur.cls;
    if (cur.re.length === 0 && cur.cls === 'double') cls = rt.cls;
    else if (cls === 'logical' && rt.cls !== 'logical') cls = rt.cls === 'char' ? 'double' : rt.cls;
    else if (cls === 'char' && rt.cls !== 'char') cls = rt.cls === 'logical' ? 'double' : (isIntCls(rt.cls) ? rt.cls : (cur.re.length === 0 ? rt.cls : 'char'));
    else if (cls === 'double' && isIntCls(rt.cls)) cls = rt.cls;
    else if (cls === 'double' && rt.cls === 'single') cls = 'single';
    if (cls !== cur.cls) { cur.cls = cls; if (isIntCls(cls)) cur.re = cur.re.map(x => satInt(cls, x)); }
    if (rt.im && !cur.im) cur.im = new Array(cur.re.length).fill(0);
    return [cur, rt];
  }
  if (cur instanceof MCell) { if (!(rhs instanceof MCell)) err('无法从 ' + classOf(rhs) + ' 转换为 cell。请使用花括号 {} 进行元胞内容赋值。', 'MATLAB:conversionToCellNotPossible'); return [cur, rhs]; }
  if (cur instanceof MStruct) {
    if (!(rhs instanceof MStruct)) { if (isTensorLike(rhs) && numelOf(rhs) === 0) return [cur, rhs]; err('无法将 ' + classOf(rhs) + ' 赋值给结构体数组元素。'); }
    for (const f of rhs.fields) if (cur.fields.indexOf(f) < 0) { cur.fields.push(f); for (const o of cur.data) o[f] = emptyD(); }
    return [cur, rhs];
  }
  if (cur instanceof MString) {
    if (rhs instanceof MString) return [cur, rhs];
    if (isChar(rhs)) return [cur, new MString([1, 1], [toStr(rhs)])];
    if (rhs instanceof MCell) return [cur, new MString(rhs.dims, rhs.data.map(x => toStr(x)))];
    const t = toT(rhs); return [cur, new MString(t.dims, t.re.map(x => fmtG(x)))];
  }
  err('无法对 ' + classOf(cur) + ' 类型进行索引赋值。');
}
function assignIndex(cur, args, rhs, tok) {
  // fast path: owned real double tensor, scalar number index, number rhs
  if (cur instanceof Tensor && cur._own === tok && typeof rhs === 'number' && !cur.im) {
    if (args.length === 1 && typeof args[0] === 'number') {
      const i = args[0];
      if (i === (i | 0) && i >= 1) {
        const n = cur.re.length;
        if (i <= n && cur.cls === 'double') { cur.re[i - 1] = rhs; return cur; }
        if (i === n + 1 && cur.cls === 'double' && cur.dims.length === 2 && (cur.dims[0] === 1 || n === 0) ) { cur.re.push(rhs); cur.dims = [1, n + 1]; return cur; }
        if (i === n + 1 && cur.cls === 'double' && cur.dims.length === 2 && cur.dims[1] === 1 && n > 0) { cur.re.push(rhs); cur.dims = [n + 1, 1]; return cur; }
      }
    } else if (args.length === 2 && typeof args[0] === 'number' && typeof args[1] === 'number' && cur.cls === 'double' && cur.dims.length === 2) {
      const i = args[0], j = args[1];
      if (i >= 1 && j >= 1 && i <= cur.dims[0] && j <= cur.dims[1] && i === (i | 0) && j === (j | 0)) { cur.re[i - 1 + (j - 1) * cur.dims[0]] = rhs; return cur; }
    }
  }
  if (cur === undefined || cur === null) {
    if (isTensorLike(rhs) && numelOf(rhs) === 0 && !(rhs instanceof MCell)) { // x(idx) = [] on undefined
      cur = emptyD();
    } else cur = emptyLike(rhs);
    if (cur === null) { if (args.every(a => a === 1)) return rhs; err('不能将函数句柄存入数组，请使用元胞数组。'); }
    cur._own = tok;
  } else if (typeof cur === 'number' || typeof cur === 'boolean') { cur = toT(cur); cur = new Tensor(cur.cls, [1, 1], cur.re.slice()); cur._own = tok; }
  else if (cur instanceof FHandle) { if (args.length && args.every(a => a === 1)) return rhs; err('不能对函数句柄进行索引赋值。'); }
  else if (cur instanceof MapObj) { mapSet(cur, args, rhs); return cur; }
  else if (cur._own !== tok) { cur = copyValue(cur); cur._own = tok; }
  // deletion
  if (rhs instanceof Tensor && rhs.cls === 'double' && rhs.re.length === 0 && rhs.dims.length === 2 && rhs.dims[0] === 0 && rhs.dims[1] === 0) {
    return deleteElems(cur, args);
  }
  let rv;
  [cur, rv] = convertForAssign(cur, rhs);
  const dims = cur.dims;
  let lin, count;
  if (args.length === 1) {
    const a = args[0];
    let N = prodDims(dims);
    if (a === COLON && N === 0) { // x(:) = rhs on empty
      const rn = numelOf(rv); resizeTo(cur, isVecDims(dimsOf(rv)) ? dimsOf(rv).slice() : [rn, 1]); N = rn;
    }
    lin = subList(a, N);
    const mx = maxOf(lin);
    if (mx >= N) {
      if (N === 0 && dims.length === 2 && dims[0] === 0 && dims[1] === 0) resizeTo(cur, [1, mx + 1]);
      else if (dims.length === 2 && dims[0] === 1) resizeTo(cur, [1, mx + 1]);
      else if (dims.length === 2 && dims[1] === 1) resizeTo(cur, [mx + 1, 1]);
      else if (N === 0) resizeTo(cur, [dims[0] === 0 ? 1 : dims[0], mx + 1]);
      else err('试图沿模糊的维度增大数组（无法使用线性索引扩展矩阵）。', 'MATLAB:indexed:matrixDimension');
    }
    count = lin.length;
  } else {
    const na = args.length;
    // colon on empty dims: take extent from rhs
    const rd = dimsOf(rv);
    const ed = new Array(na);
    const newDims = new Array(Math.max(na, dims.length)).fill(1);
    for (let k = 0; k < newDims.length; k++) newDims[k] = k < dims.length ? dims[k] : 1;
    if (na < dims.length) { // collapse trailing
      const coll = prodDims(dims.slice(na - 1)); newDims.length = na; newDims[na - 1] = coll;
    }
    const lists = new Array(na);
    const nonSingRhs = rd.filter(x => x !== 1);
    let rhsDimPtr = 0;
    for (let k = 0; k < na; k++) {
      const a = args[k];
      if (a === COLON && newDims[k] === 0 || (a === COLON && prodDims(dims) === 0)) {
        // infer from rhs
        let ext;
        if (numelOf(rv) === 1) ext = Math.max(newDims[k], 1);
        else { ext = rd[k] !== undefined ? rd[k] : 1; if (rd.length === 2 && isVecDims(rd) && args.filter(x => x === COLON).length === 1) ext = nonSingRhs[0] || 1; }
        if (newDims[k] === 0 || prodDims(dims) === 0) newDims[k] = ext;
        lists[k] = subList(COLON, newDims[k]);
      } else {
        lists[k] = subList(a, newDims[k]);
        const m = maxOf(lists[k]); if (m + 1 > newDims[k]) newDims[k] = m + 1;
      }
    }
    if (na < dims.length && !sameDims(normDims(newDims.slice()), normDims([...dims.slice(0, na - 1), prodDims(dims.slice(na - 1))]))) err('试图沿模糊的维度增大数组。');
    if (!(na < dims.length)) {
      let grow = false; for (let k = 0; k < newDims.length; k++) if (newDims[k] !== (k < dims.length ? dims[k] : 1)) grow = true;
      if (grow) {
        // empty dims with zero become at least extent of other
        for (let k = 0; k < newDims.length; k++) if (newDims[k] === 0) newDims[k] = 0;
        resizeTo(cur, newDims);
      }
    }
    for (let k = 0; k < na; k++) ed[k] = k < na - 1 ? newDims[k] : prodDims(na < dims.length ? [newDims[k]] : newDims.slice(k));
    lin = listsToLinear(lists, ed);
    count = lin.length;
  }
  // write
  const rn = numelOf(rv);
  if (rn !== 1 && rn !== count) err('无法执行赋值，因为左侧和右侧的元素数目不同。', 'MATLAB:subsassignnumelmismatch');
  if (cur instanceof Tensor) {
    const re = cur.re, rr = rv.re, ri = rv.im; const intc = isIntCls(cur.cls) ? cur.cls : null;
    if (rn === 1) { let x = rr[0]; if (intc) x = satInt(intc, x); for (let t = 0; t < count; t++) re[lin[t]] = x; if (cur.im) { const y = ri ? ri[0] : 0; for (let t = 0; t < count; t++) cur.im[lin[t]] = y; } }
    else { for (let t = 0; t < count; t++) re[lin[t]] = intc ? satInt(intc, rr[t]) : rr[t]; if (cur.im) for (let t = 0; t < count; t++) cur.im[lin[t]] = ri ? ri[t] : 0; }
    if (cur.cls === 'logical') for (let t = 0; t < count; t++) re[lin[t]] = re[lin[t]] !== 0 ? 1 : 0;
    if (cur.cls === 'single') for (let t = 0; t < count; t++) re[lin[t]] = Math.fround(re[lin[t]]);
    if (cur.im && allZero(cur.im)) cur.im = null;
  } else if (cur instanceof MStruct) {
    if (!(rv instanceof MStruct)) { // s(i) = [] handled earlier; other
      err('无法将该值赋给结构体数组元素。');
    }
    for (let t = 0; t < count; t++) { const src = rv.data[rn === 1 ? 0 : t]; const o = Object.create(null); for (const f of cur.fields) o[f] = src[f] !== undefined ? claim(src[f], o) : emptyD(); cur.data[lin[t]] = o; markSharedAll(o); }
  } else {
    const data = cur.data, rdat = rv.data;
    for (let t = 0; t < count; t++) data[lin[t]] = rn === 1 ? markShared(rdat[0]) : markShared(rdat[t]);
  }
  return cur;
}
function markSharedAll(o) { for (const k in o) markShared(o[k]); }
function deleteElems(cur, args) {
  const dims = cur.dims, N = prodDims(dims);
  const data = dataOf(cur);
  const keepMask = (len, list) => { const del = new Uint8Array(len); for (const i of list) { if (i >= len) err('索引超出数组边界，无法删除。'); del[i] = 1; } return del; };
  if (args.length === 1) {
    if (args[0] === COLON) { const e = cur instanceof Tensor ? new Tensor(cur.cls, [0, 0], []) : cur instanceof MCell ? new MCell([0, 0], []) : cur instanceof MStruct ? new MStruct([0, 0], cur.fields, [], cur.cn) : new MString([0, 0], []); e._own = cur._own; return e; }
    const list = subList(args[0], N); const del = keepMask(N, list);
    const out = [], oim = []; for (let i = 0; i < N; i++) if (!del[i]) { out.push(data[i]); if (cur.im) oim.push(cur.im[i]); }
    const nd = (dims.length === 2 && dims[1] === 1 && dims[0] !== 1) ? [out.length, 1] : [1, out.length];
    if (cur instanceof Tensor) { cur.re = out; cur.im = cur.im ? oim : null; } else cur.data = out;
    cur.dims = nd; return cur;
  }
  // find the single non-colon dim
  const na = args.length; let dk = -1;
  const ed = new Array(na); for (let k = 0; k < na; k++) ed[k] = k < na - 1 ? (k < dims.length ? dims[k] : 1) : prodDims(dims.slice(k));
  for (let k = 0; k < na; k++) {
    const a = args[k];
    if (a === COLON) continue;
    const l = subList(a, ed[k]);
    const full = l.length === ed[k] && l.every((x, i) => x === i);
    if (full) continue;
    if (dk >= 0) err('删除操作中，只能有一个索引不是冒号（:）。', 'MATLAB:nullAssignmentMultipleIndices');
    dk = k;
  }
  if (dk < 0) { // delete everything
    const nd = ed.slice(); nd[na - 1] = 0;
    if (cur instanceof Tensor) { cur.re = []; cur.im = null; } else cur.data = [];
    cur.dims = normDims(nd.length >= 2 ? [0, ed[1] === undefined ? 0 : ed[1]] : [0, 0]); cur.dims = [0, 0]; return cur;
  }
  const del = keepMask(ed[dk], subList(args[dk], ed[dk]));
  const nd = ed.slice(); let kept = 0; for (let i = 0; i < ed[dk]; i++) if (!del[i]) kept++; nd[dk] = kept;
  let inner = 1; for (let k = 0; k < dk; k++) inner *= ed[k];
  const outer = N / (inner * ed[dk]);
  const out = [], oim = [];
  for (let o = 0; o < outer; o++) for (let j = 0; j < ed[dk]; j++) { if (del[j]) continue; const base = o * ed[dk] * inner + j * inner; for (let i = 0; i < inner; i++) { out.push(data[base + i]); if (cur.im) oim.push(cur.im[base + i]); } }
  if (cur instanceof Tensor) { cur.re = out; cur.im = cur.im ? oim : null; } else cur.data = out;
  cur.dims = normDims(nd); return cur;
}

// ======================================================================
// Interpreter: compile AST to closures
// ======================================================================
const SIG_BREAK = 1, SIG_CONT = 2, SIG_RET = 3;
let frameCounter = 0;
function newFrame(fn, ctx) { return { vars: Object.create(null), toks: Object.create(null), fn, ctx, nargin: 0, nargout: 0, parentFrame: null, id: ++frameCounter }; }
function tokOf(f, name) { let t = f.toks[name]; if (t === undefined) { t = { n: name }; f.toks[name] = t; } return t; }
function setVar(f, name, v) {
  if (v !== null && typeof v === 'object') claim(v, tokOf(f, name));
  f.vars[name] = v;
}
// Called from the hot path only when ST.steps passes ST.nextCheck (at most every 4096 steps):
// enforces maxSteps and the optional wall-clock timeLimitMs, then schedules the next check.
function stepLimit() {
  if (ST.steps > ST.maxSteps) { const e = new MLError('程序运行步数超过上限（' + ST.maxSteps + ' 步），可能存在死循环，已终止。', 'MLInterp:maxSteps', ST.line, ST.file); e.uncatchable = true; throw e; }
  if (ST.timeLimitMs > 0 && Date.now() - ST.wall0 > ST.timeLimitMs) { const e = new MLError('运行超时（超过 ' + ST.timeLimitMs + ' 毫秒），已终止。', 'MLInterp:timeLimit', ST.line, ST.file); e.uncatchable = true; throw e; }
  ST.nextCheck = Math.min(ST.maxSteps, ST.steps + 4096);
}
const ENDS = [];
function endValue() {
  const c = ENDS[ENDS.length - 1];
  if (!c) err("'end' 只能在索引表达式中使用。");
  const v = c.v; const d = dimsOf(v);
  if (v instanceof MapObj) return v.map.size;
  if (c.n === 1) return prodDims(d);
  if (c.k < c.n - 1) return c.k < d.length ? d[c.k] : 1;
  return prodDims(d.slice(c.k));
}
function hasEnd(node) {
  if (!node || typeof node !== 'object') return false;
  if (node.type === 'End') return true;
  if (node.type === 'Index') return hasEnd(node.base); // inner index has its own end context
  if (node.type === 'Anon') return false;
  for (const k in node) { const v = node[k]; if (Array.isArray(v)) { for (const x of v) { if (Array.isArray(x)) { for (const y of x) if (hasEnd(y)) return true; } else if (hasEnd(x)) return true; } } else if (v && typeof v === 'object' && v.type && hasEnd(v)) return true; }
  return false;
}
function mayCsList(node) { return node.type === 'Index' && node.brace || node.type === 'Field' || node.type === 'DynField' || (node.type === 'Index' && (node.base.type === 'Field' || node.base.type === 'DynField' || node.base.type === 'Index')); }

function compileExpr(node) {
  switch (node.type) {
    case 'Num': { const v = node.v; if (node.imag) { const t = new Tensor('double', [1, 1], [0], [v]); return () => t; } return () => v; }
    case 'Str': { const s = node.v; return () => mkStr(s); }
    case 'DStr': { const s = node.v; return () => new MString([1, 1], [s]); }
    case 'Paren': { const e = compileExpr(node.e); return e; }
    case 'Colon': return () => mkStr(':');
    case 'End': return () => endValue();
    case 'Id': {
      const name = node.name;
      return (f) => { const v = f.vars[name]; if (v !== undefined) return v; return callNamedSingle(f, name, []); };
    }
    case 'Bin': {
      const a = compileExpr(node.a), b = compileExpr(node.b), op = node.op;
      switch (op) {
        case '+': return (f) => { const x = a(f), y = b(f); return (typeof x === 'number' && typeof y === 'number') ? x + y : binop('+', x, y); };
        case '-': return (f) => { const x = a(f), y = b(f); return (typeof x === 'number' && typeof y === 'number') ? x - y : binop('-', x, y); };
        case '*': case '.*': return (f) => { const x = a(f), y = b(f); return (typeof x === 'number' && typeof y === 'number') ? x * y : binop(op, x, y); };
        case '/': case './': return (f) => { const x = a(f), y = b(f); return (typeof x === 'number' && typeof y === 'number') ? x / y : binop(op, x, y); };
        case '<': return (f) => { const x = a(f), y = b(f); return (typeof x === 'number' && typeof y === 'number') ? x < y : binop(op, x, y); };
        case '>': return (f) => { const x = a(f), y = b(f); return (typeof x === 'number' && typeof y === 'number') ? x > y : binop(op, x, y); };
        case '<=': return (f) => { const x = a(f), y = b(f); return (typeof x === 'number' && typeof y === 'number') ? x <= y : binop(op, x, y); };
        case '>=': return (f) => { const x = a(f), y = b(f); return (typeof x === 'number' && typeof y === 'number') ? x >= y : binop(op, x, y); };
        case '==': return (f) => { const x = a(f), y = b(f); return (typeof x === 'number' && typeof y === 'number') ? x === y : binop(op, x, y); };
        case '~=': return (f) => { const x = a(f), y = b(f); return (typeof x === 'number' && typeof y === 'number') ? x !== y : binop(op, x, y); };
        default: return (f) => binop(op, a(f), b(f));
      }
    }
    case 'AndAnd': case 'OrOr': {
      const a = compileExpr(node.a), b = compileExpr(node.b), isAnd = node.type === 'AndAnd';
      const lg = (v) => { if (typeof v === 'boolean') return v; if (typeof v === 'number') { if (v !== v) err('NaN 不能转换为逻辑值。'); return v !== 0; } if (numelOf(v) !== 1 && !(isTensorLike(v) && numelOf(v) === 0 && false)) err("|| 和 && 运算符的操作数必须能够转换为逻辑标量值。", 'MATLAB:nonLogicalConditional'); return truthy(v); };
      return isAnd ? (f) => lg(a(f)) && lg(b(f)) : (f) => lg(a(f)) || lg(b(f));
    }
    case 'Un': { const a = compileExpr(node.a), op = node.op; return op === '-' ? (f) => { const x = a(f); return typeof x === 'number' ? -x : unop('-', x); } : (f) => unop(op, a(f)); }
    case 'Post': { const a = compileExpr(node.a), conj = node.op === "'"; return (f) => { const x = a(f); if (typeof x === 'number') return x; if (conj && x instanceof Tensor && x.im) return transpose(x, true); return transpose(x, false); }; }
    case 'Range': {
      const a = compileExpr(node.a), b = compileExpr(node.b), s = node.step ? compileExpr(node.step) : null;
      return (f) => { const x = a(f); const st = s ? s(f) : 1; const y = b(f); return makeRange(x, st, y); };
    }
    case 'Matrix': return compileMatrix(node);
    case 'CellLit': return compileCell(node);
    case 'Anon': return compileAnon(node);
    case 'FuncRef': { const name = node.name; return (f) => new FHandle({ kind: 'named', name, ctx: f.ctx, parentFrame: f, fnDef: f.fn }); }
    case 'Index': case 'Field': case 'DynField': {
      const m = compileChain(node);
      if (m.single) return m.single;
      return (f) => { const r = m(f, 1); if (r.length === 0) emptyResultErr(node); return r[0]; };
    }
  }
  err('内部错误：未知表达式类型 ' + node.type);
}
function emptyResultErr(node) {
  if (node.type === 'Index' && node.base.type === 'Id') err("函数 '" + node.base.name + "' 没有返回值，无法用于表达式（或索引产生了空列表）。", 'MATLAB:TooManyOutputs');
  err('表达式没有产生值（逗号分隔列表为空）。');
}
function compileMulti(node) {
  if (node.type === 'Index' || node.type === 'Field' || node.type === 'DynField') return compileChain(node);
  if (node.type === 'Id') {
    const name = node.name;
    return (f, nout) => { const v = f.vars[name]; if (v !== undefined) return [v]; return callNamed(f, name, [], nout); };
  }
  const e = compileExpr(node); return (f) => [e(f)];
}
function compileArg(node) { // returns (f) -> array of values
  if (node.type === 'Colon') return () => [COLON];
  if (mayCsList(node)) { const m = compileChain(node); return (f) => m(f, -1); }
  const e = compileExpr(node); return (f) => [e(f)];
}
function compileArgs(nodes) {
  const fns = nodes.map(compileArg);
  const anyEnd = nodes.some(hasEnd);
  const simple = nodes.every(n => !mayCsList(n));
  const sfns = simple ? nodes.map(n => n.type === 'Colon' ? () => COLON : compileExpr(n)) : null;
  return { fns, anyEnd, simple, sfns, n: nodes.length };
}
function evalArgs(f, A, v) { // with end context v (undefined -> no end allowed)
  if (A.n === 0) return [];
  if (A.simple && !A.anyEnd) {
    const s = A.sfns; if (A.n === 1) return [s[0](f)]; if (A.n === 2) return [s[0](f), s[1](f)];
    const out = new Array(A.n); for (let i = 0; i < A.n; i++) out[i] = s[i](f); return out;
  }
  const ctx = { v: v === undefined ? null : v, k: 0, n: A.n };
  if (v === undefined) ENDS.push(null); else ENDS.push(ctx);
  try {
    const out = [];
    for (let k = 0; k < A.n; k++) { ctx.k = k; const r = A.fns[k](f); for (let j = 0; j < r.length; j++) out.push(r[j]); }
    return out;
  } finally { ENDS.pop(); }
}
function flattenChain(node) {
  const accs = []; let cur = node;
  while (cur.type === 'Index' || cur.type === 'Field' || cur.type === 'DynField') {
    if (cur.type === 'Index') accs.unshift({ k: cur.brace ? 'brace' : 'paren', A: compileArgs(cur.args) });
    else if (cur.type === 'Field') accs.unshift({ k: 'field', name: cur.name });
    else accs.unshift({ k: 'dfield', e: compileExpr(cur.e) });
    cur = cur.base;
  }
  return { base: cur, accs };
}
const MAP_METHODS = new Set(['keys', 'values', 'isKey', 'remove', 'length']);
function applyAccs(f, v, accs, start, nout) {
  let vals = [v];
  for (let i = start; i < accs.length; i++) {
    if (vals.length !== 1) { if (vals.length === 0) err('索引表达式产生了空的逗号分隔列表，无法继续索引。'); err('中间的花括号 {} 或点索引产生了逗号分隔列表，无法继续索引（需要单个值）。', 'MATLAB:index:expected_one_output_from_intermediate_indexing'); }
    const cur = vals[0]; const a = accs[i]; const last = i === accs.length - 1;
    if (a.k === 'paren') {
      if (cur instanceof FHandle) { const args = evalArgs(f, a.A); vals = callHandle(cur, args, last ? nout : 1); continue; }
      if (cur instanceof MapObj) { const args = evalArgs(f, a.A, cur); vals = [mapGet(cur, args)]; continue; }
      const args = evalArgs(f, a.A, cur);
      vals = [indexValue(cur, args)];
    } else if (a.k === 'brace') {
      const args = evalArgs(f, a.A, cur);
      vals = braceIndex(cur, args);
    } else {
      const name = a.k === 'field' ? a.name : toStr(a.e(f), '动态字段名');
      if (cur instanceof MapObj && MAP_METHODS.has(name)) {
        let args = [];
        if (i + 1 < accs.length && accs[i + 1].k === 'paren') { args = evalArgs(f, accs[i + 1].A); i++; }
        vals = callBuiltinVals(name, [cur, ...args], 1); continue;
      }
      vals = fieldGet(cur, name);
    }
  }
  return vals;
}
function compileChain(node) {
  const { base, accs } = flattenChain(node);
  let fn;
  if (base.type === 'Id') {
    const name = base.name;
    if (name === 'containers' && accs.length && accs[0].k === 'field' && accs[0].name === 'Map') {
      fn = (f, nout) => {
        if (f.vars.containers !== undefined) return applyAccs(f, f.vars.containers, accs, 0, nout);
        let args = [], st = 1;
        if (accs.length > 1 && accs[1].k === 'paren') { args = evalArgs(f, accs[1].A); st = 2; }
        const m = newMap(args);
        return applyAccs(f, m, accs, st, nout);
      };
    } else {
      const a0 = accs[0];
      fn = (f, nout) => {
        const v = f.vars[name];
        if (v !== undefined) return applyAccs(f, v, accs, 0, nout);
        if (a0.k === 'paren') {
          const args = evalArgs(f, a0.A);
          const r = callNamed(f, name, args, accs.length === 1 ? nout : 1);
          if (accs.length === 1) return r;
          if (r.length === 0) emptyResultErr(node);
          return applyAccs(f, r[0], accs, 1, nout);
        }
        const r = callNamed(f, name, [], 1);
        if (r.length === 0) emptyResultErr(node);
        return applyAccs(f, r[0], accs, 0, nout);
      };
      // single-value fast path: x(i) / x(i,j) with simple args
      if (accs.length === 1 && a0.k === 'paren' && a0.A.simple && !a0.A.anyEnd && (a0.A.n === 1 || a0.A.n === 2)) {
        const s0 = a0.A.sfns[0], s1 = a0.A.n === 2 ? a0.A.sfns[1] : null;
        fn.single = (f) => {
          const v = f.vars[name];
          if (v instanceof Tensor && v.cls === 'double' && !v.im) {
            if (s1 === null) { const i = s0(f); if (typeof i === 'number' && i >= 1 && i <= v.re.length && i === (i | 0)) return v.re[i - 1]; return indexValue(v, [i]); }
            const i = s0(f), j = s1(f);
            if (typeof i === 'number' && typeof j === 'number' && v.dims.length === 2 && i >= 1 && j >= 1 && i <= v.dims[0] && j <= v.dims[1] && i === (i | 0) && j === (j | 0)) return v.re[i - 1 + (j - 1) * v.dims[0]];
            return indexValue(v, [i, j]);
          }
          const r = fn(f, 1); if (r.length === 0) emptyResultErr(node); return r[0];
        };
      }
    }
  } else {
    const b = compileExpr(base);
    fn = (f, nout) => applyAccs(f, b(f), accs, 0, nout);
  }
  return fn;
}
function compileMatrix(node) {
  const rows = node.rows.map(r => r.map(compileArg));
  if (rows.length === 0) return () => emptyD();
  // all-numeric-literal fast path
  const allNum = node.rows.every(r => r.every(e => e.type === 'Num' && !e.imag));
  if (allNum) {
    const R = node.rows.length, C = node.rows[0].length;
    if (node.rows.every(r => r.length === C)) {
      const re = new Array(R * C); for (let i = 0; i < R; i++) for (let j = 0; j < C; j++) re[i + j * R] = node.rows[i][j].v;
      return () => (R * C === 1 ? re[0] : new Tensor('double', [R, C], re.slice()));
    }
  }
  return (f) => {
    const rv = new Array(rows.length);
    for (let i = 0; i < rows.length; i++) {
      const vals = []; const r = rows[i];
      for (let j = 0; j < r.length; j++) { const x = r[j](f); for (let k = 0; k < x.length; k++) vals.push(x[k]); }
      rv[i] = vals.length === 0 ? emptyD() : horzcat(vals);
    }
    if (rv.length === 1) { const v = rv[0]; return v; }
    // vertical concat; char rows of differing length -> error
    return vertcat(rv);
  };
}
function compileCell(node) {
  const rows = node.rows.map(r => r.map(compileArg));
  return (f) => {
    const rv = [];
    for (const r of rows) {
      const items = [];
      for (const a of r) { const x = a(f); for (const v of x) items.push(v instanceof MCell ? v : new MCell([1, 1], [markShared(v)])); }
      if (items.length) rv.push(items.length === 1 ? items[0] : catGeneric(2, items));
    }
    if (rv.length === 0) return new MCell([0, 0], []);
    const r = rv.length === 1 ? rv[0] : catGeneric(1, rv);
    return r instanceof MCell ? r : new MCell([1, 1], [r]);
  };
}
function freeIds(node, bound, out) {
  if (!node || typeof node !== 'object') return out;
  if (node.type === 'Id') { if (!bound.has(node.name)) out.add(node.name); return out; }
  if (node.type === 'Anon') { const b2 = new Set(bound); for (const p of node.params) b2.add(p); freeIds(node.body, b2, out); return out; }
  for (const k in node) {
    const v = node[k];
    if (Array.isArray(v)) for (const x of v) { if (Array.isArray(x)) x.forEach(y => freeIds(y, bound, out)); else freeIds(x, bound, out); }
    else if (v && typeof v === 'object' && v.type) freeIds(v, bound, out);
  }
  return out;
}
function compileAnon(node) {
  const params = node.params;
  const body = compileMulti(node.body);
  const free = Array.from(freeIds(node.body, new Set(params), new Set()));
  const src = '@(' + params.join(',') + ')' + unparse(node.body);
  return (f) => {
    const cap = Object.create(null);
    for (const n of free) { const v = f.vars[n]; if (v !== undefined) cap[n] = markShared(v); }
    return new FHandle({ kind: 'anon', params, body, cap, ctx: f.ctx, src, parentFrame: f, fnDef: f.fn });
  };
}
// ---------------- unparse (for func2str / display) ----------------
const PREC = { '||': 1, '&&': 2, '|': 3, '&': 4, '<': 5, '>': 5, '<=': 5, '>=': 5, '==': 5, '~=': 5, ':': 6, '+': 7, '-': 7, '*': 8, '/': 8, '\\': 8, '.*': 8, './': 8, '.\\': 8, '^': 10, '.^': 10 };
function unparse(n, parentPrec) {
  parentPrec = parentPrec || 0;
  const wrap = (s, p) => (p < parentPrec ? '(' + s + ')' : s);
  switch (n.type) {
    case 'Num': return (n.imag ? fmtNumLit(n.v) + 'i' : fmtNumLit(n.v));
    case 'Str': return "'" + n.v.replace(/'/g, "''") + "'";
    case 'DStr': return '"' + n.v.replace(/"/g, '""') + '"';
    case 'Id': return n.name;
    case 'End': return 'end';
    case 'Colon': return ':';
    case 'Paren': return '(' + unparse(n.e) + ')';
    case 'Bin': { const p = PREC[n.op]; return wrap(unparse(n.a, p) + n.op + unparse(n.b, p + 1), p); }
    case 'AndAnd': return wrap(unparse(n.a, 2) + '&&' + unparse(n.b, 3), 2);
    case 'OrOr': return wrap(unparse(n.a, 1) + '||' + unparse(n.b, 2), 1);
    case 'Un': return wrap(n.op + unparse(n.a, 9), 9);
    case 'Post': return unparse(n.a, 11) + n.op;
    case 'Range': return wrap(unparse(n.a, 7) + ':' + (n.step ? unparse(n.step, 7) + ':' : '') + unparse(n.b, 7), 6);
    case 'Matrix': return '[' + n.rows.map(r => r.map(e => unparse(e)).join(',')).join(';') + ']';
    case 'CellLit': return '{' + n.rows.map(r => r.map(e => unparse(e)).join(',')).join(';') + '}';
    case 'Anon': return '@(' + n.params.join(',') + ')' + unparse(n.body);
    case 'FuncRef': return '@' + n.name;
    case 'Index': return unparse(n.base, 11) + (n.brace ? '{' : '(') + n.args.map(a => unparse(a)).join(',') + (n.brace ? '}' : ')');
    case 'Field': return unparse(n.base, 11) + '.' + n.name;
    case 'DynField': return unparse(n.base, 11) + '.(' + unparse(n.e) + ')';
  }
  return '?';
}
function fmtNumLit(v) { if (Number.isInteger(v) && Math.abs(v) < 1e15) return String(v); let s = String(v); return s; }

// ---------------- statements ----------------
function compileBlock(stmts) {
  const fns = stmts.map(compileStmt);
  const n = fns.length;
  if (n === 1) { const a = fns[0]; return a; }
  return (f) => { for (let i = 0; i < n; i++) { const s = fns[i](f); if (s) return s; } return 0; };
}
function compileStmt(s) {
  const line = s.line;
  const disp = s.disp;
  switch (s.type) {
    case 'Expr': {
      const e = s.e;
      if (e.type === 'Id') {
        const name = e.name;
        return (f) => {
          ST.line = line; if (++ST.steps > ST.nextCheck) stepLimit();
          const v = f.vars[name];
          if (v !== undefined) { if (disp) displayVar(name, v); return 0; }
          const r = callNamed(f, name, [], 0);
          if (r.length) { setVar(f, 'ans', r[0]); if (disp) displayVar('ans', r[0]); }
          return 0;
        };
      }
      const m = compileMulti(e);
      return (f) => {
        ST.line = line; if (++ST.steps > ST.nextCheck) stepLimit();
        const r = m(f, 0);
        for (let i = 0; i < r.length; i++) { setVar(f, 'ans', r[i]); if (disp) displayVar('ans', r[i]); }
        return 0;
      };
    }
    case 'Cmd': {
      const name = s.name, args = s.args;
      return (f) => {
        ST.line = line; if (++ST.steps > ST.nextCheck) stepLimit();
        if (f.vars[name] !== undefined && args.length === 0) { if (disp) displayVar(name, f.vars[name]); return 0; }
        const r = callNamed(f, name, args.map(mkStr), 0);
        if (r.length) { setVar(f, 'ans', r[0]); if (disp) displayVar('ans', r[0]); }
        return 0;
      };
    }
    case 'Assign': {
      const lhs = s.lhs, name = lhs.name;
      const rhsNode = s.rhs;
      const rhs = compileExpr(rhsNode);
      if (lhs.acc.length === 0) {
        return (f) => {
          ST.line = line; if (++ST.steps > ST.nextCheck) stepLimit();
          const v = rhs(f);
          if (typeof v === 'object') claim(v, tokOf(f, name));
          f.vars[name] = v;
          if (disp) displayVar(name, v);
          return 0;
        };
      }
      const accs = compileLAccs(lhs.acc);
      const isDel = rhsNode.type === 'Matrix' && rhsNode.rows.length === 0;
      return (f) => {
        ST.line = line; if (++ST.steps > ST.nextCheck) stepLimit();
        const v = rhs(f);
        const tok = tokOf(f, name);
        const cur = f.vars[name];
        const nv = assignChain(f, cur, accs, 0, v, tok, isDel);
        if (nv !== cur) { if (typeof nv === 'object') claim(nv, tok); f.vars[name] = nv; }
        if (disp) displayVar(name, f.vars[name]);
        return 0;
      };
    }
    case 'Multi': {
      const rhs = compileMulti(s.rhs);
      const lhs = s.lhs.map(l => (l ? { name: l.name, accs: compileLAccs(l.acc) } : null));
      const nl = lhs.length;
      return (f) => {
        ST.line = line; if (++ST.steps > ST.nextCheck) stepLimit();
        const vals = rhs(f, nl);
        if (vals.length < nl) {
          // allow trailing ~
          let need = nl; while (need > 0 && lhs[need - 1] === null) need--;
          if (vals.length < need) err(vals.length === 0 ? '等号右侧的表达式没有返回值。' : '输出参数太多（右侧只提供了 ' + vals.length + ' 个值）。', 'MATLAB:TooManyOutputs');
        }
        for (let i = 0; i < nl; i++) {
          const l = lhs[i]; if (!l || i >= vals.length) continue;
          const tok = tokOf(f, l.name);
          if (l.accs.length === 0) setVar(f, l.name, vals[i]);
          else { const nv = assignChain(f, f.vars[l.name], l.accs, 0, vals[i], tok, false); claim(nv, tok); f.vars[l.name] = nv; }
        }
        if (disp) for (let i = 0; i < nl; i++) if (lhs[i] && i < vals.length) displayVar(lhs[i].name, f.vars[lhs[i].name]);
        return 0;
      };
    }
    case 'If': {
      const cl = s.clauses.map(c => ({ cond: compileExpr(c.cond), body: compileBlock(c.body) }));
      const els = s.els ? compileBlock(s.els) : null;
      const lines = s.clauses.map(c => c.cond.line || line);
      return (f) => {
        ST.line = line; if (++ST.steps > ST.nextCheck) stepLimit();
        for (let i = 0; i < cl.length; i++) {
          const c = cl[i].cond(f);
          if (c === true || (c !== false && truthy(c))) return cl[i].body(f);
        }
        if (els) return els(f);
        return 0;
      };
    }
    case 'While': {
      const cond = compileExpr(s.cond), body = compileBlock(s.body);
      return (f) => {
        for (;;) {
          ST.line = line; if (++ST.steps > ST.nextCheck) stepLimit();
          const c = cond(f);
          if (!(c === true || (c !== false && truthy(c)))) break;
          const r = body(f);
          if (r === SIG_BREAK) break; if (r === SIG_RET) return r;
        }
        return 0;
      };
    }
    case 'DoUntil': {
      const cond = compileExpr(s.cond), body = compileBlock(s.body);
      return (f) => {
        for (;;) {
          ST.line = line; if (++ST.steps > ST.nextCheck) stepLimit();
          const r = body(f);
          if (r === SIG_BREAK) break; if (r === SIG_RET) return r;
          if (truthy(cond(f))) break;
        }
        return 0;
      };
    }
    case 'For': {
      const name = s.v, body = compileBlock(s.body);
      if (s.e.type === 'Range') {
        const a = compileExpr(s.e.a), b = compileExpr(s.e.b), st = s.e.step ? compileExpr(s.e.step) : null;
        return (f) => {
          ST.line = line; if (++ST.steps > ST.nextCheck) stepLimit();
          const av = a(f), sv = st ? st(f) : 1, bv = b(f);
          if (typeof av !== 'number' || typeof sv !== 'number' || typeof bv !== 'number') return forOver(f, name, makeRange(av, sv, bv), body, line);
          const n = rangeCount(av, sv, bv);
          if (n <= 0) { f.vars[name] = new Tensor('double', [1, 0], []); return 0; }
          const lastFix = !Number.isInteger(sv);
          for (let k = 0; k < n; k++) {
            let v = av + k * sv; if (lastFix && k === n - 1 && Math.abs(v - bv) < Math.abs(sv) * 1e-10) v = bv;
            f.vars[name] = v;
            const r = body(f);
            if (r === SIG_BREAK) break; if (r === SIG_RET) return r;
            ST.line = line; if (++ST.steps > ST.nextCheck) stepLimit();
          }
          return 0;
        };
      }
      const e = compileExpr(s.e);
      return (f) => { ST.line = line; if (++ST.steps > ST.nextCheck) stepLimit(); return forOver(f, name, e(f), body, line); };
    }
    case 'Switch': {
      const e = compileExpr(s.e);
      const cases = s.cases.map(c => ({ e: compileExpr(c.e), body: compileBlock(c.body) }));
      const other = s.other ? compileBlock(s.other) : null;
      return (f) => {
        ST.line = line; if (++ST.steps > ST.nextCheck) stepLimit();
        const v = e(f);
        for (const c of cases) { const cv = c.e(f); if (switchMatch(v, cv)) return c.body(f); }
        if (other) return other(f);
        return 0;
      };
    }
    case 'Try': {
      const body = compileBlock(s.body), cbody = compileBlock(s.cbody), id = s.id;
      return (f) => {
        ST.line = line; if (++ST.steps > ST.nextCheck) stepLimit();
        const saveFrame = ST.frame, saveFile = ST.file, saveDepth = ST.depth, saveEnds = ENDS.length;
        try { return body(f); }
        catch (e) {
          let me = e;
          if (e instanceof RangeError) me = new MLError('超出最大递归深度，可能存在无穷递归。', 'MATLAB:recursionLimit', ST.line, ST.file);
          if (!(me instanceof MLError) || me.uncatchable) throw e;
          ST.frame = saveFrame; ST.file = saveFile; ST.depth = saveDepth; ENDS.length = saveEnds;
          ST.lastErr = me;
          if (id) setVar(f, id, me.exc || mkException(me.identifier, me.message, me.line, me.file));
          return cbody(f);
        }
      };
    }
    case 'Break': return () => { ST.line = line; return SIG_BREAK; };
    case 'Continue': return () => { ST.line = line; return SIG_CONT; };
    case 'Return': return () => { ST.line = line; return SIG_RET; };
    case 'Global': {
      const names = s.names;
      return (f) => { ST.line = line; for (const n of names) bindGlobal(f, n); return 0; };
    }
    case 'Persistent': {
      const names = s.names;
      return (f) => {
        ST.line = line;
        const key = f.fn ? f.fn.uid : 'script';
        let store = ST.persist[key]; if (!store) store = ST.persist[key] = Object.create(null);
        for (const n of names) {
          if (!(n in store)) store[n] = emptyD();
          Object.defineProperty(f.vars, n, { get() { return store[n]; }, set(v) { store[n] = v; }, enumerable: true, configurable: true });
        }
        return 0;
      };
    }
  }
  err('内部错误：未知语句类型 ' + s.type);
}
function bindGlobal(f, n) {
  const G = ST.globals;
  if (!(n in G)) G[n] = f.vars[n] !== undefined ? f.vars[n] : emptyD();
  Object.defineProperty(f.vars, n, { get() { return G[n]; }, set(v) { G[n] = v; }, enumerable: true, configurable: true });
}
function forOver(f, name, val, body, line) {
  const d = dimsOf(val);
  const rows = d[0]; const cols = rows === 0 ? 0 : numelOf(val) / rows;
  if (numelOf(val) === 0) { setVar(f, name, emptyD()); return 0; }
  for (let j = 0; j < cols; j++) {
    let v;
    if (typeof val === 'number' || typeof val === 'boolean') v = val;
    else if (rows === 1) v = indexValue(val, [j + 1]);
    else v = indexValue(val, [COLON, j + 1]);
    if (val instanceof MCell && rows === 1) v = new MCell([1, 1], [markShared(val.data[j])]);
    setVar(f, name, v);
    const r = body(f);
    if (r === SIG_BREAK) break; if (r === SIG_RET) return r;
    ST.line = line; if (++ST.steps > ST.nextCheck) stepLimit();
  }
  return 0;
}
function switchMatch(v, cv) {
  if (cv instanceof MCell) { for (const x of cv.data) if (switchMatch(v, x)) return true; return false; }
  if (isStringy(v) || isStringy(cv)) { if (!(isStringy(v) && isStringy(cv))) return false; return toStr(v) === toStr(cv); }
  if (isTensorLike(v) && isTensorLike(cv)) {
    if (numelOf(cv) === 0 || numelOf(v) === 0) return false;
    if (numelOf(v) !== 1) err('SWITCH 表达式必须为标量或字符向量。');
    return toNum(v) === toNum(cv);
  }
  return false;
}
function compileLAccs(acc) {
  return acc.map(a => {
    if (a.k === 'paren' || a.k === 'brace') return { k: a.k, A: compileArgs(a.args) };
    if (a.k === 'field') return { k: 'field', name: a.name };
    return { k: 'dfield', e: compileExpr(a.e) };
  });
}
function isEmptyNumeric(v) { return v instanceof Tensor && v.re.length === 0 && v.cls !== 'char'; }
function assignChain(f, cur, accs, i, rhs, tok, isDel) {
  const a = accs[i]; const last = i === accs.length - 1;
  if (a.k === 'paren') {
    if (cur instanceof MapObj) {
      const args = evalArgs(f, a.A, cur);
      if (last) { mapSet(cur, args, rhs); return cur; }
      const sub = mapGet(cur, args); const t2 = {}; if (sub && typeof sub === 'object' && sub._own === undefined) sub._own = t2;
      mapSet(cur, args, assignChain(f, sub, accs, i + 1, rhs, t2)); return cur;
    }
    const args = evalArgs(f, a.A, cur === undefined ? emptyD() : cur);
    if (last) {
      return assignIndex(cur, args, rhs, tok);
    }
    let sub;
    if (cur !== undefined && !(isEmptyNumeric(cur))) {
      let inRange = true;
      try { sub = indexValue(cur, args); } catch (e) { if (!(e instanceof MLError)) throw e; inRange = false; sub = undefined; }
      if (inRange && numelOf(sub) !== 1 && !(sub instanceof MStruct)) err('索引赋值的中间结果必须为单个元素。');
    }
    if (sub === undefined && cur instanceof MStruct) { const o = Object.create(null); for (const fn of cur.fields) o[fn] = emptyD(); sub = new MStruct([1, 1], cur.fields.slice(), [o], cur.cn); }
    const t2 = {}; if (sub && typeof sub === 'object') sub._own = t2;
    const nsub = assignChain(f, sub, accs, i + 1, rhs, t2);
    return assignIndex(cur, args, nsub, tok);
  }
  if (a.k === 'brace') {
    if (cur === undefined || isEmptyNumeric(cur)) { cur = new MCell([0, 0], []); cur._own = tok; }
    if (!(cur instanceof MCell)) err('无法对非元胞数组使用花括号 {} 赋值。', 'MATLAB:cellAssToNonCell');
    const args = evalArgs(f, a.A, cur);
    let prior;
    if (!last) { try { const r = braceIndex(cur, args); if (r.length === 1) prior = r[0]; } catch (e) { if (!(e instanceof MLError)) throw e; } }
    const c2 = assignIndex(cur, args, new MCell([1, 1], [PLACEHOLDER]), tok);
    const ci = computeIndex(c2.dims, args);
    const lin = args.length === 1 ? ci.lin : listsToLinear(ci.lists, ci.ed);
    if (lin.length !== 1) {
      if (last) { for (const k of lin) c2.data[k] = markShared(rhs); return c2; }
      err('花括号赋值的目标必须为单个元胞元素。');
    }
    const k = lin[0];
    if (last) { c2.data[k] = claim(rhs, c2); return c2; }
    const nsub = assignChain(f, prior, accs, i + 1, rhs, c2);
    c2.data[k] = claim(nsub, c2);
    return c2;
  }
  // field
  const name = a.k === 'field' ? a.name : toStr(a.e(f), '动态字段名');
  if (cur === undefined || isEmptyNumeric(cur)) { cur = new MStruct([1, 1], [], [Object.create(null)]); cur._own = tok; }
  if (cur instanceof MapObj) err('containers.Map 的属性是只读的。');
  if (!(cur instanceof MStruct)) err("无法对 '" + classOf(cur) + "' 类型的变量进行字段赋值（点索引赋值需要结构体）。", 'MATLAB:invalidStructAssignment');
  if (cur.data.length !== 1) {
    if (cur.data.length === 0) { cur = cur._own === tok ? cur : copyValue(cur); cur._own = tok; const o = Object.create(null); for (const fn of cur.fields) o[fn] = emptyD(); cur.data = [o]; cur.dims = [1, 1]; }
    else err('结构体数组的字段赋值需要使用索引，例如 s(2).' + name + ' = ...。', 'MATLAB:structFieldAssignmentOnArray');
  }
  if (cur._own !== tok) { cur = copyValue(cur); cur._own = tok; }
  const obj = cur.data[0];
  if (cur.fields.indexOf(name) < 0) { if (!/^[A-Za-z]\w*$/.test(name)) err("无效的字段名称 '" + name + "'。"); cur.fields.push(name); for (const o of cur.data) if (!(name in o)) o[name] = emptyD(); }
  if (last) { obj[name] = claim(rhs, obj); return cur; }
  const nsub = assignChain(f, obj[name], accs, i + 1, rhs, obj);
  obj[name] = claim(nsub, obj);
  return cur;
}
const PLACEHOLDER = new Tensor('double', [0, 0], []);

// ======================================================================
// Functions, files, calls
// ======================================================================
let fnUid = 0;
function assignedNames(stmts, out) {
  for (const s of stmts) {
    switch (s.type) {
      case 'Assign': out.add(s.lhs.name); break;
      case 'Multi': for (const l of s.lhs) if (l) out.add(l.name); break;
      case 'For': out.add(s.v); assignedNames(s.body, out); break;
      case 'If': for (const c of s.clauses) assignedNames(c.body, out); if (s.els) assignedNames(s.els, out); break;
      case 'While': case 'DoUntil': assignedNames(s.body, out); break;
      case 'Switch': for (const c of s.cases) assignedNames(c.body, out); if (s.other) assignedNames(s.other, out); break;
      case 'Try': assignedNames(s.body, out); if (s.id) out.add(s.id); assignedNames(s.cbody, out); break;
      case 'Global': case 'Persistent': for (const n of s.names) out.add(n); break;
    }
  }
  return out;
}
function referencedNames(stmts) { const out = new Set(); freeIds({ type: 'X', list: stmts }, new Set(), out); assignedNames(stmts, out); return out; }
function buildFuncDef(fa, ctx, parent) {
  const def = {
    name: fa.name, params: fa.params, outs: fa.outs, line: fa.line, ctx, parent, uid: ++fnUid,
    hasVarargin: fa.params.length > 0 && fa.params[fa.params.length - 1] === 'varargin',
    hasVarargout: fa.outs.length > 0 && fa.outs[fa.outs.length - 1] === 'varargout',
    nested: Object.create(null), body: null, ast: fa, shared: null, cache: Object.create(null),
  };
  def.localVars = new Set([...fa.params, ...fa.outs, ...assignedNames(fa.body, new Set())]);
  for (const n of fa.nested) def.nested[n.name] = buildFuncDef(n, ctx, def);
  return def;
}
function finalizeShared(def) {
  if (def.parent) {
    const refs = referencedNames(def.ast.body);
    const own = new Set([...def.ast.params, ...def.ast.outs]);
    const shared = [];
    for (const r of refs) {
      if (own.has(r)) continue;
      let p = def.parent, depth = 1;
      while (p) { if (p.localVars.has(r)) { shared.push({ name: r, def: p }); break; } p = p.parent; depth++; }
    }
    def.shared = shared.length ? shared : null;
  }
  for (const k in def.nested) finalizeShared(def.nested[k]);
}
function compileFuncDef(def) {
  if (!def.body) { def.body = compileBlock(def.ast.body); }
  return def;
}
function loadFile(name, src) { // returns ctx
  const ast = parseProgram(src, name);
  const ctx = { file: name, funcs: Object.create(null), script: null, isFunctionFile: ast.isFunctionFile, main: null, cache: Object.create(null) };
  for (const fa of ast.funcs) { const d = buildFuncDef(fa, ctx, null); finalizeShared(d); if (!(fa.name in ctx.funcs)) ctx.funcs[fa.name] = d; if (!ctx.main) ctx.main = d; }
  if (!ast.isFunctionFile) ctx.scriptAst = ast.script;
  return ctx;
}
function getFileCtx(name) {
  if (ST.fileCtx[name] !== undefined) return ST.fileCtx[name];
  const fn = name + '.m';
  const src = ST.files[fn];
  if (src === undefined) { ST.fileCtx[name] = null; return null; }
  const saveLine = ST.line, saveFile = ST.file;
  ST.file = fn;
  const ctx = loadFile(fn, src);
  ST.line = saveLine; ST.file = saveFile;
  ST.fileCtx[name] = ctx;
  return ctx;
}
function resolveFn(f, name) {
  // nested functions visible from current function
  let def = f.fn;
  const cache = def ? def.cache : (f.ctx ? f.ctx.cache : null);
  if (cache) { const c = cache[name]; if (c !== undefined) return c; }
  let res = null;
  let d = def;
  while (d && !res) { if (d.nested[name]) res = { kind: 'user', def: d.nested[name] }; else if (d.name === name && d.parent) res = { kind: 'user', def: d }; d = d.parent; }
  if (!res && f.ctx && f.ctx.funcs[name]) res = { kind: 'user', def: f.ctx.funcs[name] };
  if (!res) {
    const ctx = getFileCtx(name);
    if (ctx) { if (ctx.isFunctionFile) res = { kind: 'user', def: ctx.main }; else res = { kind: 'script', ctx }; }
  }
  if (!res && BUILTINS[name]) res = { kind: 'builtin', fn: BUILTINS[name], name };
  if (cache && res) cache[name] = res;
  return res;
}
function undefinedErr(name) {
  if (ST.frame && ST.frame.fn && ST.frame.fn.params.indexOf(name) >= 0) err('输入参数的数目不足（参数 \'' + name + '\' 未提供）。', 'MATLAB:minrhs');
  err("未定义函数或变量 '" + name + "'。", 'MATLAB:UndefinedFunction');
}
function callNamed(f, name, args, nout) {
  const r = resolveFn(f, name);
  if (!r) undefinedErr(name);
  return invoke(r, f, name, args, nout);
}
function callNamedSingle(f, name, args) {
  const r = callNamed(f, name, args, 1);
  if (r.length === 0) err("函数 '" + name + "' 没有返回值，无法用于表达式。", 'MATLAB:TooManyOutputs');
  return r[0];
}
function invoke(r, f, name, args, nout, parentFrame) {
  if (r.kind === 'builtin') {
    const v = r.fn(args, nout, f);
    if (v === undefined) return [];
    if (v instanceof MR) return v.v;
    return [v];
  }
  if (r.kind === 'user') return callUser(r.def, args, nout, f, parentFrame);
  if (r.kind === 'script') {
    if (args.length) err("尝试将脚本 '" + name + "' 作为函数执行。", 'MATLAB:scriptNotAFunction');
    runScriptCtx(r.ctx, f);
    return [];
  }
  return [];
}
function runScriptCtx(ctx, f) {
  if (!ctx.scriptBody) ctx.scriptBody = compileBlock(ctx.scriptAst);
  const saveFile = ST.file, saveCtx = f.ctx;
  ST.file = ctx.file;
  f.ctx = ctx; // local functions of the script become visible
  try { ctx.scriptBody(f); } finally { ST.file = saveFile; f.ctx = saveCtx; }
}
function callBuiltinVals(name, args, nout) {
  const fn = BUILTINS[name]; if (!fn) undefinedErr(name);
  const v = fn(args, nout, ST.frame);
  if (v === undefined) return []; if (v instanceof MR) return v.v; return [v];
}
function findParentFrame(def, f) {
  let g = f;
  while (g) { if (g.fn === def.parent) return g; g = g.parentFrame; }
  return null;
}
function callUser(def, args, nout, callerFrame, parentFrame) {
  compileFuncDef(def);
  const np = def.params.length;
  const nfixed = def.hasVarargin ? np - 1 : np;
  if (args.length > nfixed && !def.hasVarargin) err("输入参数太多（函数 '" + def.name + "' 最多接受 " + np + ' 个输入）。', 'MATLAB:TooManyInputs');
  const nouts = def.outs.length;
  if (nout > nouts && !def.hasVarargout) err("输出参数太多（函数 '" + def.name + "' 最多返回 " + nouts + ' 个输出）。', 'MATLAB:TooManyOutputs');
  if (ST.depth >= ST.maxDepth) err('超出最大递归深度（' + ST.maxDepth + '）。可能存在无穷递归。', 'MATLAB:recursionLimit');
  const f = newFrame(def, def.ctx);
  f.nargin = args.length; f.nargout = nout;
  if (def.parent) {
    const pf = parentFrame || findParentFrame(def, callerFrame);
    f.parentFrame = pf;
    if (def.shared && pf) {
      for (const sh of def.shared) {
        let g = pf; while (g && g.fn !== sh.def) g = g.parentFrame;
        if (!g) continue;
        const gv = g.vars, nm = sh.name;
        Object.defineProperty(f.vars, nm, { get() { return gv[nm]; }, set(v) { gv[nm] = v; }, enumerable: true, configurable: true });
      }
    }
  }
  const nb = Math.min(args.length, nfixed);
  for (let i = 0; i < nb; i++) { const p = def.params[i]; if (p !== '~') setVar(f, p, args[i]); }
  if (def.hasVarargin) { const rest = args.slice(nfixed); setVar(f, 'varargin', mkCellRow(rest)); }
  const saveFrame = ST.frame, saveFile = ST.file, saveLine = ST.line;
  ST.frame = f; ST.file = def.ctx.file; ST.depth++;
  let outs;
  try {
    def.body(f);
    outs = [];
    const want = Math.max(nout, 1);
    for (let i = 0; i < nouts && outs.length < want; i++) {
      const o = def.outs[i];
      if (def.hasVarargout && i === nouts - 1) {
        const vo = f.vars.varargout;
        if (vo !== undefined) { if (!(vo instanceof MCell)) err('varargout 必须为元胞数组。'); for (const x of vo.data) { if (outs.length >= want) break; outs.push(x); } }
        if (outs.length < nout) err("输出参数太多（varargout 只提供了 " + (vo ? vo.data.length : 0) + ' 个值）。', 'MATLAB:TooManyOutputs');
        break;
      }
      const v = f.vars[o];
      if (v === undefined) {
        if (i < nout || (i === 0 && nout > 0)) err("在调用 '" + def.name + "' 期间，未对输出参数 '" + o + "'（可能还有其他参数）赋值。", 'MATLAB:unassignedOutputs');
        break;
      }
      outs.push(v);
    }
  } finally { ST.depth--; }
  ST.frame = saveFrame; ST.file = saveFile; ST.line = saveLine;
  return outs;
}
function callHandle(h, args, nout) {
  if (h.kind === 'anon') {
    const np = h.params.length;
    const varg = np > 0 && h.params[np - 1] === 'varargin';
    if (args.length > np && !varg) err('输入参数太多（匿名函数 ' + h.src + ' 只接受 ' + np + ' 个输入）。', 'MATLAB:TooManyInputs');
    if (ST.depth >= ST.maxDepth) err('超出最大递归深度（' + ST.maxDepth + '）。', 'MATLAB:recursionLimit');
    const f = newFrame(h.fnDef || null, h.ctx);
    f.parentFrame = h.parentFrame; f.anon = true;
    const cap = h.cap; for (const k in cap) f.vars[k] = cap[k];
    const nfix = varg ? np - 1 : np;
    for (let i = 0; i < nfix && i < args.length; i++) if (h.params[i] !== '~') f.vars[h.params[i]] = markShared(args[i]);
    if (varg) f.vars.varargin = mkCellRow(args.slice(nfix));
    f.nargin = args.length; f.nargout = nout;
    const saveFrame = ST.frame; ST.frame = f; ST.depth++;
    let r;
    try { r = h.body(f, nout); } finally { ST.depth--; }
    ST.frame = saveFrame;
    return r;
  }
  // named
  const f0 = { vars: Object.create(null), fn: h.fnDef || null, ctx: h.ctx, parentFrame: h.parentFrame, toks: Object.create(null) };
  const r = resolveFn(f0, h.name);
  if (!r) undefinedErr(h.name);
  return invoke(r, h.parentFrame || ST.frame, h.name, args, nout, r.kind === 'user' && r.def.parent ? findParentFrame(r.def, h.parentFrame) : undefined);
}
// call a function value (handle or name string) - used by builtins
function callFn(fv, args, nout) {
  if (nout === undefined) nout = 1;
  if (fv instanceof FHandle) return callHandle(fv, args, nout);
  if (isStringy(fv)) { const name = toStr(fv); return callNamed(ST.frame, name, args, nout); }
  err('参数必须为函数句柄或函数名称。', 'MATLAB:invalidFunctionHandle');
}
function callFn1(fv, args) { const r = callFn(fv, args, 1); if (!r.length) err('函数没有返回值。'); return r[0]; }
function fnScalar(fv) { // returns JS function x(number)->number
  return (x) => { const r = callFn1(fv, [x]); return toNum(r, '函数返回值'); };
}

// ======================================================================
// Number formatting & display
// ======================================================================
function fmtE(x, p) { // MATLAB-style exponent with 2+ digits
  if (!isFinite(x)) return x !== x ? 'NaN' : (x > 0 ? 'Inf' : '-Inf');
  let s = x.toExponential(p);
  return s.replace(/e([+-])(\d)$/, 'e$10$2');
}
function fmtG(x, p) { // like %g (p significant digits, default 5 for num2str-ish shortest)
  if (x !== x) return 'NaN';
  if (!isFinite(x)) return x > 0 ? 'Inf' : '-Inf';
  if (p === undefined) { if (Number.isInteger(x) && Math.abs(x) < 1e15) return String(x); p = 15; }
  return cfmtG(x, p, false);
}
function cfmtG(x, p, alt) {
  if (x === 0) return '0';
  if (p === 0) p = 1;
  const e = Math.floor(Math.log10(Math.abs(x)));
  let ex = parseInt(x.toExponential(p - 1).split('e')[1], 10);
  if (ex < -4 || ex >= p) {
    let s = x.toExponential(p - 1);
    let [m, ee] = s.split('e');
    if (!alt && m.indexOf('.') >= 0) m = m.replace(/0+$/, '').replace(/\.$/, '');
    const sign = ee[0] === '-' ? '-' : '+'; let d = ee.replace(/^[+-]/, ''); if (d.length < 2) d = '0' + d;
    return m + 'e' + sign + d;
  }
  let s = x.toFixed(Math.max(0, p - 1 - ex));
  if (!alt && s.indexOf('.') >= 0) s = s.replace(/0+$/, '').replace(/\.$/, '');
  return s;
}
function isIntVal(x) { return x === Math.floor(x) && isFinite(x); }
function padL(s, w) { return s.length >= w ? s : ' '.repeat(w - s.length) + s; }
function padR(s, w) { return s.length >= w ? s : s + ' '.repeat(w - s.length); }
function nonFiniteStr(x) { return x !== x ? 'NaN' : x > 0 ? 'Inf' : '-Inf'; }

// format a real array (column-major) of r x c; returns {lines:[...], header: scale line or null}
function formatRealMatrix(re, r, c, cls) {
  const long = ST && ST.formatLong;
  const n = re.length;
  let allInt = true, maxAbs = 0, minAbs = Infinity, anyNeg = false, anyFinite = false;
  for (let i = 0; i < n; i++) { const x = re[i]; if (!isFinite(x)) { if (x === -Infinity) anyNeg = true; continue; } anyFinite = true; if (x !== Math.floor(x)) allInt = false; const a = Math.abs(x); if (a > maxAbs) maxAbs = a; if (a < minAbs && a !== 0) minAbs = a; if (x < 0) anyNeg = true; }
  const strs = new Array(n); let header = null; let w;
  if (isIntCls(cls) || cls === 'logical' || cls === 'char') {
    for (let i = 0; i < n; i++) strs[i] = String(re[i]);
    let ml = 1; for (const s of strs) ml = Math.max(ml, s.length);
    // logical/char: 3 leading spaces; integer classes: width = max digits + 2
    w = isIntCls(cls) ? ml + 2 : ml + 3;
  } else if (allInt && maxAbs < 1e9) {
    for (let i = 0; i < n; i++) { const x = re[i]; strs[i] = isFinite(x) ? String(x === 0 ? 0 : x) : nonFiniteStr(x); }
    let ml = 1; for (const s of strs) ml = Math.max(ml, s.length);
    w = (maxAbs < 1000 && ml <= 4) ? 6 : Math.max(12, ml + 3);
    if (long) w = Math.max(ml + 3, 6);
    if (n === 1 && w < ml + 3) w = ml + 3;
  } else {
    const dec = long ? (cls === 'single' ? 7 : 15) : 4;
    let scale = 1;
    if (anyFinite && (maxAbs >= 1000 || maxAbs < 0.001) && maxAbs > 0) {
      if (n === 1) { // scalar -> exponent format
        const x = re[0]; strs[0] = isFinite(x) ? fmtE(x, dec) : nonFiniteStr(x);
        return { lines: [padL(strs[0], strs[0].length + 3)], header: null, w: strs[0].length + 3, strs };
      }
      const e = Math.floor(Math.log10(maxAbs));
      if (maxAbs >= 1e5 * (minAbs === Infinity ? 1 : 1) || maxAbs < 0.001 || true) scale = Math.pow(10, e);
      header = '   1.0e' + (e < 0 ? '-' : '+') + padL(String(Math.abs(e)), 2).replace(/ /g, '0') + ' *';
    }
    for (let i = 0; i < n; i++) { const x = re[i]; strs[i] = isFinite(x) ? (x / scale).toFixed(dec) : nonFiniteStr(x); }
    // show exact zeros as 0 like MATLAB
    for (let i = 0; i < n; i++) if (re[i] === 0 && n > 1) strs[i] = '0';
    let ml = 1; for (const s of strs) ml = Math.max(ml, s.length);
    w = long ? ml + 3 : Math.max(10, ml + 2);
  }
  const lines = [];
  for (let i = 0; i < r; i++) { let s = ''; for (let j = 0; j < c; j++) s += padL(strs[i + j * r], w); lines.push(s); }
  return { lines, header, w, strs };
}
function fmtComplexParts(re, im, dec) {
  const one = (x) => isFinite(x) ? x.toFixed(dec) : nonFiniteStr(x);
  const out = []; for (let i = 0; i < re.length; i++) { const a = re[i], b = im[i]; out.push(one(a) + (b < 0 || Object.is(b, -0) ? ' - ' : ' + ') + one(Math.abs(b)) + 'i'); }
  return out;
}
function formatComplexMatrix(t, r, c) {
  const long = ST && ST.formatLong; const dec = long ? 15 : 4;
  let maxAbs = 0; for (let i = 0; i < t.re.length; i++) { maxAbs = Math.max(maxAbs, isFinite(t.re[i]) ? Math.abs(t.re[i]) : 0, isFinite(t.im[i]) ? Math.abs(t.im[i]) : 0); }
  let header = null, scale = 1;
  if (maxAbs >= 1000 && t.re.length > 1) { const e = Math.floor(Math.log10(maxAbs)); scale = Math.pow(10, e); header = '   1.0e+' + padL(String(e), 2).replace(/ /g, '0') + ' *'; }
  let strs;
  if (maxAbs >= 1e5 && t.re.length === 1) strs = [fmtE(t.re[0], dec) + (t.im[0] < 0 ? ' - ' : ' + ') + fmtE(Math.abs(t.im[0]), dec) + 'i'];
  else strs = fmtComplexParts(t.re.map(x => x / scale), t.im.map(x => x / scale), dec);
  let ml = 0; for (const s of strs) ml = Math.max(ml, s.length);
  const w = ml + 3; const lines = [];
  for (let i = 0; i < r; i++) { let s = ''; for (let j = 0; j < c; j++) s += padL(strs[i + j * r], w); lines.push(s); }
  return { lines, header };
}
function dimStr(d) { return d.join('×'); }
function shapeWord(d) { if (d.length === 2 && d[0] === 1 && d[1] !== 1) return 'row vector'; if (d.length === 2 && d[1] === 1 && d[0] !== 1) return 'column vector'; return d.length > 2 ? 'array' : 'matrix'; }
// body lines for a 2-D tensor (no name)
function tensorBody(t) {
  const d = t.dims; const r = d[0], c = d[1];
  if (t.cls === 'char') return { lines: charRowsToStrings(t).map(s => s), header: null };
  if (t.im) return formatComplexMatrix(t, r, c);
  return formatRealMatrix(t.re, r, c, t.cls);
}
function out(s) { ST.outBuf += s; ST.outTotal += s.length; if (ST.outTotal > 8 * 1024 * 1024) { const e = new MLError('输出过多（超过 8 MB），程序已终止。', 'MLInterp:outputLimit', ST.line, ST.file); e.uncatchable = true; throw e; } if (ST.outBuf.length > 8192) flushOut(); }
function flushOut() { if (ST.outBuf) { const s = ST.outBuf; ST.outBuf = ''; ST.onStdout(s); } }
function errOut(s) { flushOut(); ST.onStderr(s); }
function warnMsg(msg, id) {
  if (ST.warningsOff && (ST.warningsOff.all || (id && ST.warningsOff[id]))) return;
  ST.lastWarn = msg;
  errOut('警告: ' + msg + '\n');
}

// short inline representation used in cells and struct fields
function inlineRepr(v, inCell) {
  if (typeof v === 'number') return inCell ? '[' + scalarShort(v) + ']' : scalarShort(v);
  if (typeof v === 'boolean') return inCell ? '[' + (v ? 1 : 0) + ']' : String(v ? 1 : 0);
  if (v instanceof Tensor) {
    const d = v.dims, n = v.re.length;
    if (v.cls === 'char') { if (d.length === 2 && d[0] === 1) return "'" + toStr(v) + "'"; if (n === 0) return inCell ? "''" : "''"; return dimStr(d) + ' char'; }
    if (n === 0) return (inCell ? '' : '[') + (d[0] === 0 && d[1] === 0 && !inCell ? ']' : '') + (inCell || !(d[0] === 0 && d[1] === 0) ? (inCell ? dimStr(d) + ' ' + v.cls : dimStr(d) + ' ' + v.cls + ']') : '');
    if (n === 1) { const s = v.im ? fmtComplexParts(v.re, v.im, 4)[0] : (isIntCls(v.cls) || v.cls === 'logical' ? String(v.re[0]) : scalarShort(v.re[0])); return inCell ? '[' + s + ']' : s; }
    if (d.length === 2 && d[0] === 1 && n <= 10 && !v.im) {
      const ints = isIntCls(v.cls) || v.cls === 'logical' || v.re.every(isIntVal);
      const parts = v.re.map(x => ints ? String(x) : (isFinite(x) ? scalarShort(x) : nonFiniteStr(x)));
      return '[' + parts.join(' ') + ']';
    }
    return (inCell ? '' : '[') + dimStr(d) + ' ' + v.cls + (v.im ? ' (complex)' : '') + (inCell ? '' : ']');
  }
  if (v instanceof MCell) return (inCell ? '' : '{') + dimStr(v.dims) + ' cell' + (inCell ? '' : '}');
  if (v instanceof MStruct) return (inCell ? '' : '[') + dimStr(v.dims) + ' ' + (v.cn || 'struct') + (inCell ? '' : ']');
  if (v instanceof MString) { if (v.data.length === 1) return inCell ? '["' + v.data[0] + '"]' : '"' + v.data[0] + '"'; return (inCell ? '' : '[') + dimStr(v.dims) + ' string' + (inCell ? '' : ']'); }
  if (v instanceof FHandle) return fhStr(v);
  if (v instanceof MapObj) return (inCell ? '' : '[') + '1×1 containers.Map' + (inCell ? '' : ']');
  return '?';
}
function scalarShort(x) {
  if (!isFinite(x)) return nonFiniteStr(x);
  if (isIntVal(x) && Math.abs(x) < 1e9) return String(x);
  const long = ST && ST.formatLong;
  const a = Math.abs(x);
  if (a >= 1000 && a < 1e5 && !long) return x.toFixed(4).replace(/\.?0+$/, '') === String(Math.round(x)) ? x.toFixed(4) : (a < 1e5 ? fmtE(x, 4) : fmtE(x, 4));
  if (a >= 1e5 || a < 0.001) return fmtE(x, long ? 15 : 4);
  return x.toFixed(long ? 15 : 4);
}
function fhStr(h) { return h.kind === 'anon' ? h.src : '@' + h.name; }
function cellBodyLines(c) {
  const d = c.dims; const r = d[0], cols = prodDims(d) / (r || 1);
  const strs = c.data.map(v => '{' + inlineRepr(v, true) + '}');
  const w = new Array(cols).fill(0);
  for (let j = 0; j < cols; j++) for (let i = 0; i < r; i++) w[j] = Math.max(w[j], strs[i + j * r].length);
  const lines = [];
  for (let i = 0; i < r; i++) { let s = ''; for (let j = 0; j < cols; j++) s += '    ' + (j < cols - 1 ? padR(strs[i + j * r], w[j]) : strs[i + j * r]); lines.push(s); }
  return lines;
}
function structFieldLines(s, indent) {
  const o = s.data[0]; const fs = s.fields;
  let ml = 0; for (const f of fs) ml = Math.max(ml, f.length);
  return fs.map(f => padL(f, ml + (indent || 4)) + ': ' + inlineRepr(o[f], false));
}
function stringArrayLines(v) {
  const d = v.dims; const r = d[0], c = prodDims(d) / (r || 1);
  const strs = v.data.map(s => (s === null ? '<missing>' : '"' + s + '"'));
  const w = new Array(c).fill(0); for (let j = 0; j < c; j++) for (let i = 0; i < r; i++) w[j] = Math.max(w[j], strs[i + j * r].length);
  const lines = []; for (let i = 0; i < r; i++) { let s = ''; for (let j = 0; j < c; j++) s += '    ' + padR(strs[i + j * r], w[j]); lines.push(s.replace(/\s+$/, '')); }
  return lines;
}
// MATLAB-style "name = ..." display
function displayText(name, v) {
  const L = [];
  if (typeof v === 'number') {
    const b = formatRealMatrix([v], 1, 1, 'double');
    return name + ' =\n\n' + b.lines[0] + '\n\n';
  }
  if (typeof v === 'boolean') return name + ' =\n\n  logical\n\n   ' + (v ? 1 : 0) + '\n\n';
  if (v instanceof Tensor) {
    const d = v.dims, n = v.re.length;
    if (n === 0) {
      if (v.cls === 'char' && d[0] === 0 && d[1] === 0) return name + ' =\n\n    0×0 empty char array\n\n';
      if (d.length === 2 && d[0] === 0 && d[1] === 0 && v.cls === 'double') return name + ' =\n\n     []\n\n';
      return name + ' =\n\n  ' + dimStr(d) + ' empty ' + v.cls + ' ' + (shapeWord(d) === 'array' ? 'array' : (d[0] === 1 ? 'row vector' : d[1] === 1 ? 'column vector' : 'matrix')) + '\n\n';
    }
    if (d.length > 2) return ndDisplay(name, v);
    if (v.cls === 'char') {
      const rows = charRowsToStrings(v);
      if (d[0] === 1) return name + ' =\n\n    \'' + rows[0] + '\'\n\n';
      return name + ' =\n\n  ' + dimStr(d) + ' char array\n\n' + rows.map(s => "    '" + s + "'\n").join('') + '\n';
    }
    let head = '';
    if (v.cls === 'logical') head = n === 1 ? '  logical\n\n' : '  ' + dimStr(d) + ' logical array\n\n';
    else if (isIntCls(v.cls) || v.cls === 'single') head = n === 1 ? '  ' + v.cls + '\n\n' : '  ' + dimStr(d) + ' ' + v.cls + ' ' + shapeWord(d) + '\n\n';
    const b = tensorBody(v);
    // named display of an integer scalar keeps 3 leading spaces (x = int8(5) -> '   5'); disp() uses max digits + 2
    if (n === 1 && isIntCls(v.cls) && !v.im) b.lines = ['   ' + b.strs[0]];
    let s = name + ' =\n\n' + head;
    if (b.header) s += b.header + '\n\n';
    s += b.lines.join('\n') + '\n\n';
    return s;
  }
  if (v instanceof MCell) {
    if (v.data.length === 0) return name + ' =\n\n  ' + dimStr(v.dims) + ' empty cell array\n\n';
    if (v.dims.length > 2) return name + ' =\n\n  ' + dimStr(v.dims) + ' cell array\n\n';
    return name + ' =\n\n  ' + dimStr(v.dims) + ' cell array\n\n' + cellBodyLines(v).join('\n') + '\n\n';
  }
  if (v instanceof MStruct) {
    if (v.cn === 'MException') return name + ' = \n\n  MException with properties:\n\n' + structFieldLines(v, 4).join('\n') + '\n\n';
    if (v.data.length === 1) {
      if (v.fields.length === 0) return name + ' = \n\n  struct with no fields.\n\n';
      return name + ' = \n\n  struct with fields:\n\n' + structFieldLines(v).join('\n') + '\n\n';
    }
    return name + ' = \n\n  ' + dimStr(v.dims) + ' struct array ' + (v.fields.length ? 'with fields:\n\n' + v.fields.map(f => '    ' + f).join('\n') + '\n\n' : 'with no fields.\n\n');
  }
  if (v instanceof MString) {
    if (v.data.length === 1) return name + ' = \n\n    "' + v.data[0] + '"\n\n';
    if (v.data.length === 0) return name + ' = \n\n  ' + dimStr(v.dims) + ' empty string array\n\n';
    return name + ' = \n\n  ' + dimStr(v.dims) + ' string array\n\n' + stringArrayLines(v).join('\n') + '\n\n';
  }
  if (v instanceof FHandle) return name + ' =\n\n  function_handle with value:\n\n    ' + fhStr(v) + '\n\n';
  if (v instanceof MapObj) return name + ' = \n\n  Map with properties:\n\n        Count: ' + v.map.size + '\n      KeyType: ' + v.kt + '\n    ValueType: ' + v.vt + '\n\n';
  return name + ' = ?\n';
}
function ndDisplay(name, v) {
  const d = v.dims; const page = d[0] * d[1]; const np = prodDims(d) / page;
  let s = '';
  for (let p = 0; p < np; p++) {
    const idx = []; let q = p; for (let k = 2; k < d.length; k++) { idx.push(q % d[k] + 1); q = Math.floor(q / d[k]); }
    const sub = new Tensor(v.cls, [d[0], d[1]], v.re.slice(p * page, (p + 1) * page), v.im ? v.im.slice(p * page, (p + 1) * page) : null);
    const b = tensorBody(sub);
    s += name + '(:,:,' + idx.join(',') + ') =\n\n' + (b.header ? b.header + '\n\n' : '') + b.lines.join('\n') + '\n\n';
  }
  return s;
}
function displayVar(name, v) { out(displayText(name, v)); }
// disp(): value without name
function dispText(v) {
  if (typeof v === 'number') return formatRealMatrix([v], 1, 1, 'double').lines[0] + '\n';
  if (typeof v === 'boolean') return '   ' + (v ? 1 : 0) + '\n';
  if (v instanceof Tensor) {
    if (v.re.length === 0) return v.cls === 'char' ? '' : '';
    if (v.cls === 'char') return charRowsToStrings(v).join('\n') + '\n';
    if (v.dims.length > 2) return ndDisplay('ans', v);
    const b = tensorBody(v);
    return (b.header ? b.header + '\n\n' : '') + b.lines.join('\n') + '\n';
  }
  if (v instanceof MCell) { if (v.data.length === 0) return ''; return cellBodyLines(v).join('\n') + '\n'; }
  if (v instanceof MStruct) { if (v.data.length === 1) return structFieldLines(v).join('\n') + '\n'; return '  ' + dimStr(v.dims) + ' struct array with fields:\n\n' + v.fields.map(f => '    ' + f).join('\n') + '\n'; }
  if (v instanceof MString) { if (v.data.length === 1) return v.data[0] + '\n'; return stringArrayLines(v).join('\n') + '\n'; }
  if (v instanceof FHandle) return '    ' + fhStr(v) + '\n';
  if (v instanceof MapObj) return '  Map with properties:\n\n        Count: ' + v.map.size + '\n      KeyType: ' + v.kt + '\n    ValueType: ' + v.vt + '\n';
  return '\n';
}

// ======================================================================
// sprintf / fprintf
// ======================================================================
function processEscapes(s) {
  return s.replace(/\\(x[0-9a-fA-F]{1,4}|[0-7]{1,3}|.)/g, (m, c) => {
    switch (c[0]) {
      case 'n': return '\n'; case 't': return '\t'; case 'r': return '\r'; case 'a': return '\x07'; case 'b': return '\b'; case 'f': return '\f'; case 'v': return '\v';
      case '\\': return '\\'; case 'x': return String.fromCharCode(parseInt(c.slice(1), 16));
      default: if (/[0-7]/.test(c[0])) return String.fromCharCode(parseInt(c, 8)); return c === "'" ? "'" : c === '"' ? '"' : '\\' + c;
    }
  });
}
function fmtArgsQueue(args) {
  const q = [];
  for (const a of args) {
    if (isChar(a)) q.push({ s: toStr(a) });
    else if (a instanceof MString) for (const s of a.data) q.push({ s });
    else if (a instanceof MCell) err('sprintf/fprintf 不支持元胞数组参数，请使用 c{:} 展开。', 'MATLAB:sprintf:InvalidInputType');
    else if (typeof a === 'number') q.push(a);
    else if (typeof a === 'boolean') q.push(a ? 1 : 0);
    else if (a instanceof Tensor) { if (a.im) { for (let i = 0; i < a.re.length; i++) q.push(a.re[i]); } else for (let i = 0; i < a.re.length; i++) q.push(a.re[i]); }
    else if (a instanceof FHandle) err('sprintf 不支持函数句柄参数。');
    else if (a instanceof MStruct) err('sprintf 不支持结构体参数。');
  }
  return q;
}
function applyFlagsWidth(s, flags, width, isNum) {
  if (width && s.length < width) {
    if (flags.indexOf('-') >= 0) return s + ' '.repeat(width - s.length);
    if (flags.indexOf('0') >= 0 && isNum && !/[a-zA-Z]{3}/.test(s)) { const neg = /^[+\- ]/.test(s) ? s[0] : ''; const body = neg ? s.slice(1) : s; return neg + '0'.repeat(width - s.length) + body; }
    return ' '.repeat(width - s.length) + s;
  }
  return s;
}
function fmtNumConv(conv, x, flags, prec) {
  let s;
  const plus = flags.indexOf('+') >= 0 ? '+' : flags.indexOf(' ') >= 0 ? ' ' : '';
  if (!isFinite(x)) { s = x !== x ? 'NaN' : (x > 0 ? 'Inf' : '-Inf'); if (x > 0 && plus) s = plus + s; return s; }
  switch (conv) {
    case 'd': case 'i': case 'u':
      if (!Number.isInteger(x)) { return fmtNumConv(prec !== undefined ? 'f' : 'e', x, flags, prec); }
      s = Math.abs(x).toFixed(0); if (prec !== undefined && s.length < prec) s = '0'.repeat(prec - s.length) + s; break;
    case 'f': case 'F': s = Math.abs(x).toFixed(prec === undefined ? 6 : prec); if (flags.indexOf('#') >= 0 && prec === 0) s += '.'; break;
    case 'e': case 'E': s = fmtE(Math.abs(x), prec === undefined ? 6 : prec); if (conv === 'E') s = s.toUpperCase(); break;
    case 'g': case 'G': s = cfmtG(Math.abs(x), prec === undefined ? 6 : prec, flags.indexOf('#') >= 0); if (conv === 'G') s = s.toUpperCase(); break;
    case 'x': case 'X': s = Math.abs(Math.trunc(x)).toString(16); if (conv === 'X') s = s.toUpperCase(); if (!Number.isInteger(x)) return fmtNumConv('e', x, flags, prec); break;
    case 'o': s = Math.abs(Math.trunc(x)).toString(8); break;
    default: s = String(x);
  }
  const neg = x < 0 || Object.is(x, -0) && false;
  return (neg ? '-' : plus) + s;
}
function doSprintf(fmtRaw, args) {
  const fmt = processEscapes(fmtRaw);
  const q = fmtArgsQueue(args);
  // tokenize format
  const parts = []; const re = /%(%|([-+ 0#]*)(\*|\d+)?(?:\.(\*|\d+))?([lhL]?)([diouxXfFeEgGcs]))/g; let last = 0, m;
  while ((m = re.exec(fmt))) {
    if (m.index > last) parts.push({ lit: fmt.slice(last, m.index) });
    if (m[1] === '%') parts.push({ lit: '%' }); else parts.push({ flags: m[2] || '', width: m[3], prec: m[4], conv: m[6] });
    last = re.lastIndex;
  }
  if (last < fmt.length) parts.push({ lit: fmt.slice(last) });
  const nconv = parts.filter(p => !p.lit && p.lit !== '').length;
  let outS = ''; let qi = 0;
  const take = () => q[qi++];
  if (nconv === 0) { return parts.map(p => p.lit).join(''); }
  if (q.length === 0) { // print up to first conversion, literal text only
    for (const p of parts) { if (p.lit !== undefined) outS += p.lit; else { if (p.conv === 's' || p.conv === 'c') continue; break; } }
    return outS;
  }
  let guard = 0;
  while (qi < q.length && guard++ < 1e7) {
    for (let pi = 0; pi < parts.length; pi++) {
      const p = parts[pi];
      if (p.lit !== undefined) { outS += p.lit; continue; }
      if (qi >= q.length) return outS;
      let width = p.width, prec = p.prec;
      if (width === '*') { const w = take(); width = typeof w === 'number' ? w : 0; if (qi >= q.length) return outS; }
      if (prec === '*') { const w = take(); prec = typeof w === 'number' ? w : 0; if (qi >= q.length) return outS; }
      width = width !== undefined ? +width : 0; prec = prec !== undefined ? +prec : undefined;
      let item = take();
      let s;
      if (p.conv === 's') {
        if (typeof item === 'object') s = item.s; else s = Number.isInteger(item) ? fmtG(item) : cfmtG(item, prec !== undefined ? Math.max(prec, 1) : 5, false);
        if (typeof item !== 'object' && false) s = String.fromCharCode(item);
        if (prec !== undefined && typeof item === 'object') s = s.slice(0, prec);
        s = applyFlagsWidth(s, p.flags, width, false);
      } else if (p.conv === 'c') {
        if (typeof item === 'object') s = item.s; else s = String.fromCharCode(item);
        s = applyFlagsWidth(s, p.flags, width, false);
      } else {
        if (typeof item === 'object') { // string given to numeric conversion: MATLAB prints the chars as numbers... print as string
          const str = item.s;
          if (str.length === 0) { s = ''; }
          else { s = str; s = applyFlagsWidth(s, p.flags, width, false); }
        } else s = applyFlagsWidth(fmtNumConv(p.conv, item, p.flags, prec), p.flags, width, true);
      }
      outS += s;
    }
    if (qi === 0) break;
  }
  return outS;
}

// ======================================================================
// Builtins: construction, types, size, elementwise math, reductions
// ======================================================================
const BUILTINS = Object.create(null);
const B = BUILTINS;
function nargchk(a, lo, hi, name) {
  if (a.length < lo) err("输入参数太少（函数 '" + name + "' 至少需要 " + lo + ' 个输入）。', 'MATLAB:minrhs');
  if (hi !== undefined && a.length > hi) err("输入参数太多（函数 '" + name + "' 最多接受 " + hi + ' 个输入）。', 'MATLAB:TooManyInputs');
}
const CLASS_NAMES = new Set(['double', 'single', 'logical', 'char', 'int8', 'uint8', 'int16', 'uint16', 'int32', 'uint32', 'int64', 'uint64']);
function parseDimsArgs(a, name) { // returns {dims, cls}
  let cls = 'double'; let args = a.slice();
  while (args.length && isStringy(args[args.length - 1])) {
    const s = toStr(args[args.length - 1]);
    if (CLASS_NAMES.has(s)) { cls = s; args.pop(); }
    else if (args.length >= 2 && isStringy(args[args.length - 2]) && toStr(args[args.length - 2]) === 'like') { cls = classOf(args[args.length - 1]); args.splice(args.length - 2, 2); }
    else break;
  }
  if (args.length >= 2 && isStringy(args[args.length - 2]) && toStr(args[args.length - 2]) === 'like') { cls = classOf(args[args.length - 1]); args.splice(args.length - 2, 2); }
  let dims;
  if (args.length === 0) dims = [1, 1];
  else if (args.length === 1) { const v = toArr(args[0]); if (v.length === 1) dims = [v[0], v[0]]; else dims = v.slice(); }
  else dims = args.map(x => toNum(x, '维度'));
  dims = dims.map(x => { if (x !== x) err('维度参数不能为 NaN。'); if (x < 0) return 0; if (!Number.isInteger(x)) err('大小输入必须为整数。', 'MATLAB:NonIntegerInput'); return x; });
  if (prodDims(dims) > 5e7) err('请求的数组太大（超出内存限制）。', 'MATLAB:array:SizeLimitExceeded');
  return { dims: normDims(dims), cls };
}
function filled(dims, val, cls) { const n = prodDims(dims); const re = new Array(n); for (let i = 0; i < n; i++) re[i] = val; return mk(cls || 'double', dims, re); }
B.zeros = (a) => { const { dims, cls } = parseDimsArgs(a); return filled(dims, 0, cls); };
B.ones = (a) => { const { dims, cls } = parseDimsArgs(a); return filled(dims, 1, cls); };
B.Inf = B.inf = (a) => { const { dims } = parseDimsArgs(a); return filled(dims, Infinity); };
B.NaN = B.nan = B.NA = (a) => { const { dims } = parseDimsArgs(a); return filled(dims, NaN); };
B.pi = (a) => { if (!a.length) return Math.PI; const { dims } = parseDimsArgs(a); return filled(dims, Math.PI); };
B.e = (a) => { if (!a.length) return Math.E; const { dims } = parseDimsArgs(a); return filled(dims, Math.E); };
B.eps = (a) => {
  if (a.length === 1 && !isStringy(a[0])) { const t = toT(a[0]); return mk('double', t.dims.slice(), t.re.map(x => { x = Math.abs(x); if (!isFinite(x)) return NaN; if (x < 2.2250738585072014e-308) return 4.9406564584124654e-324; const e = Math.floor(Math.log2(x)); let p = Math.pow(2, e - 52); if (Math.pow(2, e) > x) p /= 2; return p; })); }
  if (a.length === 1 && isStringy(a[0]) && toStr(a[0]) === 'single') return mk('single', [1, 1], [1.1920928955078125e-07]);
  return 2.220446049250313e-16;
};
B.i = B.j = B.I = B.J = (a) => new Tensor('double', [1, 1], [0], [1]);
B.true = (a) => { const { dims } = parseDimsArgs(a); return filled(dims, 1, 'logical'); };
B.false = (a) => { const { dims } = parseDimsArgs(a); return filled(dims, 0, 'logical'); };
B.realmax = (a) => (a.length && toStr(a[0]) === 'single' ? mk('single', [1, 1], [3.4028234663852886e38]) : Number.MAX_VALUE);
B.realmin = (a) => (a.length && toStr(a[0]) === 'single' ? mk('single', [1, 1], [1.1754943508222875e-38]) : 2.2250738585072014e-308);
B.flintmax = () => 9007199254740992;
B.intmax = (a) => { const c = a.length ? toStr(a[0]) : 'int32'; if (!isIntCls(c)) err('intmax 的参数必须为整数类名。'); return mk(c, [1, 1], [INT_RANGES[c][1]]); };
B.intmin = (a) => { const c = a.length ? toStr(a[0]) : 'int32'; if (!isIntCls(c)) err('intmin 的参数必须为整数类名。'); return mk(c, [1, 1], [INT_RANGES[c][0]]); };
B.eye = (a) => { const { dims, cls } = parseDimsArgs(a); const r = dims[0], c = dims[1]; const re = zerosArr(r * c); for (let i = 0; i < Math.min(r, c); i++) re[i + i * r] = 1; return mk(cls, [r, c], re); };
// ---- random numbers: seeded Mersenne-Twister-like (xorshift128+ here), rng(seed) ----
function makeRng(seed) {
  let s = (seed >>> 0) || 5489; // splitmix32 init
  const st = new Uint32Array(4);
  for (let k = 0; k < 4; k++) { s = (s + 0x9E3779B9) >>> 0; let z = s; z = Math.imul(z ^ (z >>> 16), 0x85EBCA6B) >>> 0; z = Math.imul(z ^ (z >>> 13), 0xC2B2AE35) >>> 0; st[k] = (z ^ (z >>> 16)) >>> 0; }
  return {
    next() { // xoshiro128**
      const r = Math.imul(((st[1] * 5) << 7 | (st[1] * 5) >>> 25) >>> 0, 9) >>> 0;
      const t = st[1] << 9; st[2] ^= st[0]; st[3] ^= st[1]; st[1] ^= st[2]; st[0] ^= st[3]; st[2] ^= t; st[3] = (st[3] << 11) | (st[3] >>> 21);
      return r >>> 0;
    },
    rand() { const a = this.next() >>> 5, b = this.next() >>> 6; return (a * 67108864 + b + 0.5) / 9007199254740992; },
    spare: null,
    randn() { if (this.spare !== null) { const s = this.spare; this.spare = null; return s; } let u, v, q; do { u = 2 * this.rand() - 1; v = 2 * this.rand() - 1; q = u * u + v * v; } while (q >= 1 || q === 0); const f = Math.sqrt(-2 * Math.log(q) / q); this.spare = v * f; return u * f; },
  };
}
B.rng = (a) => {
  if (!a.length) return scalarStruct({ Type: mkStr('twister'), Seed: ST.seed, State: emptyD() }, ['Type', 'Seed', 'State']);
  let s = a[0];
  if (isStringy(s)) { const w = toStr(s); if (w === 'shuffle') { ST.seed = Math.floor(ST.clock() * 1000) >>> 0; } else if (w === 'default') ST.seed = 0; }
  else if (s instanceof MStruct) ST.seed = toNum(getField(s, 'Seed'));
  else ST.seed = toNum(s);
  ST.rng = makeRng(ST.seed + 1);
  return undefined;
};
B.rand = (a) => { const { dims } = parseDimsArgs(a); const n = prodDims(dims); const re = new Array(n); for (let i = 0; i < n; i++) re[i] = ST.rng.rand(); return mk('double', dims, re); };
B.randn = (a) => { const { dims } = parseDimsArgs(a); const n = prodDims(dims); const re = new Array(n); for (let i = 0; i < n; i++) re[i] = ST.rng.randn(); return mk('double', dims, re); };
B.randi = (a) => {
  nargchk(a, 1, undefined, 'randi');
  const r = toArr(a[0]); let lo = 1, hi; if (r.length === 1) hi = r[0]; else { lo = r[0]; hi = r[1]; }
  const { dims, cls } = parseDimsArgs(a.slice(1)); const n = prodDims(dims); const re = new Array(n);
  for (let i = 0; i < n; i++) re[i] = lo + Math.floor(ST.rng.rand() * (hi - lo + 1));
  return mk(cls, dims, re);
};
B.randperm = (a) => { const n = toNum(a[0]); const k = a.length > 1 ? toNum(a[1]) : n; const p = []; for (let i = 1; i <= n; i++) p.push(i); for (let i = n - 1; i > 0; i--) { const j = Math.floor(ST.rng.rand() * (i + 1)); const t = p[i]; p[i] = p[j]; p[j] = t; } return mkRow(p.slice(0, k)); };
B.linspace = (a) => {
  nargchk(a, 2, 3, 'linspace');
  const x0 = toNum(a[0]), x1 = toNum(a[1]); const n = a.length > 2 ? Math.floor(toNum(a[2])) : 100;
  if (n < 1) return new Tensor('double', [1, 0], []);
  if (n === 1) return x1;
  const re = new Array(n); for (let i = 0; i < n; i++) re[i] = x0 + (x1 - x0) * i / (n - 1); re[0] = x0; re[n - 1] = x1;
  return mkRow(re);
};
B.logspace = (a) => { const x0 = toNum(a[0]), x1 = toNum(a[1]); const n = a.length > 2 ? toNum(a[2]) : 50; const re = []; for (let i = 0; i < n; i++) re.push(Math.pow(10, n === 1 ? x1 : x0 + (x1 - x0) * i / (n - 1))); return mkRow(re); };
B.colon = (a) => (a.length === 2 ? makeRange(a[0], 1, a[1]) : makeRange(a[0], a[1], a[2]));
B.repmat = (a) => {
  nargchk(a, 2, undefined, 'repmat');
  let reps = a.length === 2 ? toArr(a[1]).slice() : a.slice(1).map(x => toNum(x));
  if (reps.length === 1) reps = [reps[0], reps[0]];
  const v = a[0]; const vd = dimsOf(v);
  const nd = Math.max(reps.length, vd.length);
  const od = []; for (let k = 0; k < nd; k++) od.push((vd[k] || 1) * (reps[k] === undefined ? 1 : reps[k]));
  const n = prodDims(od);
  const lin = new Array(n); const cnt = new Array(nd).fill(0);
  for (let t = 0; t < n; t++) {
    let li = 0, s = 1; for (let k = 0; k < nd; k++) { const dk = vd[k] || 1; li += (cnt[k] % dk) * s; s *= dk; }
    lin[t] = li;
    for (let k = 0; k < nd; k++) { cnt[k]++; if (cnt[k] < od[k]) break; cnt[k] = 0; }
  }
  const base = (typeof v === 'number' || typeof v === 'boolean') ? toT(v) : v;
  if (base instanceof FHandle) err('repmat 不支持函数句柄。');
  return gather(base, lin, od);
};
function reshapeVal(v, dims) {
  const n = numelOf(v);
  if (prodDims(dims) !== n) err('重构数组时，元素数不能更改。请使用 [] 作为大小输入之一，以自动计算该维度的适当大小。', 'MATLAB:getReshapeDims:notSameNumel');
  dims = normDims(dims);
  if (typeof v === 'number' || typeof v === 'boolean') return v;
  if (v instanceof Tensor) return mk(v.cls, dims, v.re.slice(), v.im ? v.im.slice() : null);
  const c = copyValue(v); c.dims = dims; return c;
}
B.reshape = (a) => {
  nargchk(a, 2, undefined, 'reshape');
  let dims;
  if (a.length === 2) dims = toArr(a[1]).slice();
  else {
    dims = []; let emptyAt = -1;
    for (let k = 1; k < a.length; k++) { if (isTensorLike(a[k]) && numelOf(a[k]) === 0) { emptyAt = k - 1; dims.push(1); } else dims.push(toNum(a[k])); }
    if (emptyAt >= 0) { const p = prodDims(dims); dims[emptyAt] = numelOf(a[0]) / p; if (!Number.isInteger(dims[emptyAt])) err('无法均匀重构数组：元素数 ' + numelOf(a[0]) + ' 不能被 ' + p + ' 整除。'); }
  }
  return reshapeVal(a[0], dims);
};
B.cat = (a) => { const d = toNum(a[0]); return catGeneric(d, a.slice(1)); };
B.horzcat = (a) => (a.length ? catGeneric(2, a) : emptyD());
B.vertcat = (a) => (a.length ? catGeneric(1, a) : emptyD());
B.meshgrid = (a, nout) => {
  const x = toArr(a[0]), y = a.length > 1 ? toArr(a[1]) : x;
  if (a.length > 2 || nout > 2) {
    const z = a.length > 2 ? toArr(a[2]) : x; const nx = x.length, ny = y.length, nz = z.length;
    const X = [], Y = [], Z = []; for (let k = 0; k < nz; k++) for (let j = 0; j < nx; j++) for (let i = 0; i < ny; i++) { X.push(x[j]); Y.push(y[i]); Z.push(z[k]); }
    return new MR([mk('double', [ny, nx, nz], X), mk('double', [ny, nx, nz], Y), mk('double', [ny, nx, nz], Z)]);
  }
  const nx = x.length, ny = y.length; const X = new Array(nx * ny), Y = new Array(nx * ny);
  for (let j = 0; j < nx; j++) for (let i = 0; i < ny; i++) { X[i + j * ny] = x[j]; Y[i + j * ny] = y[i]; }
  return new MR([mk('double', [ny, nx], X), mk('double', [ny, nx], Y)]);
};
B.ndgrid = (a, nout) => {
  const x = toArr(a[0]), y = a.length > 1 ? toArr(a[1]) : x;
  const nx = x.length, ny = y.length; const X = new Array(nx * ny), Y = new Array(nx * ny);
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) { X[i + j * nx] = x[i]; Y[i + j * nx] = y[j]; }
  return new MR([mk('double', [nx, ny], X), mk('double', [nx, ny], Y)]);
};
B.diag = (a) => {
  const t = toT(a[0]); const k = a.length > 1 ? toNum(a[1]) : 0; const d = t.dims;
  if (d[0] === 1 || d[1] === 1) {
    const n = t.re.length, m = n + Math.abs(k); const re = zerosArr(m * m); const im = t.im ? zerosArr(m * m) : null;
    for (let i = 0; i < n; i++) { const r = k >= 0 ? i : i - k, c = k >= 0 ? i + k : i; re[r + c * m] = t.re[i]; if (im) im[r + c * m] = t.im[i]; }
    return mk(t.cls, [m, m], re, im);
  }
  const out = [], oim = []; const r = d[0], c = d[1];
  for (let i = 0; ; i++) { const row = k >= 0 ? i : i - k, col = k >= 0 ? i + k : i; if (row >= r || col >= c) break; out.push(t.re[row + col * r]); if (t.im) oim.push(t.im[row + col * r]); }
  return mk(t.cls, [out.length, 1], out, t.im ? oim : null);
};
B.magic = (a) => {
  const n = toNum(a[0]); if (n < 1) return emptyD(); if (n === 2) return mkMat(2, 2, [4, 3, 1, 2]);
  const M = []; for (let i = 0; i < n; i++) M.push(new Array(n).fill(0));
  if (n % 2 === 1) { let i = 0, j = (n - 1) / 2; for (let k = 1; k <= n * n; k++) { M[i][j] = k; const ni = (i - 1 + n) % n, nj = (j + 1) % n; if (M[ni][nj]) i = (i + 1) % n; else { i = ni; j = nj; } } }
  else if (n % 4 === 0) { for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) { const v = i * n + j + 1; const keep = ((i % 4 === 0 || i % 4 === 3) && (j % 4 === 0 || j % 4 === 3)) || ((i % 4 === 1 || i % 4 === 2) && (j % 4 === 1 || j % 4 === 2)); M[i][j] = keep ? n * n + 1 - v : v; } }
  else { // singly even: MATLAB's algorithm
    const p = n / 2; const A = toT(B.magic([p])); const sub = (i, j) => A.re[i + j * p];
    for (let i = 0; i < p; i++) for (let j = 0; j < p; j++) { const v = sub(i, j); M[i][j] = v; M[i][j + p] = v + 2 * p * p; M[i + p][j] = v + 3 * p * p; M[i + p][j + p] = v + p * p; }
    const k = (n - 2) / 4; const cols = []; for (let j = 0; j < k; j++) cols.push(j); for (let j = n - k + 1; j < n; j++) cols.push(j);
    for (let i = 0; i < p; i++) for (const j of cols) { const t = M[i][j]; M[i][j] = M[i + p][j]; M[i + p][j] = t; }
    for (const j of [0, k]) { const t = M[k][j]; M[k][j] = M[k + p][j]; M[k + p][j] = t; }
  }
  const re = new Array(n * n); for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) re[i + j * n] = M[i][j];
  return mkMat(n, n, re);
};
// ---- types ----
function castTo(v, cls) {
  if (v instanceof MString) { if (cls === 'double' || cls === 'single') return mk(cls, v.dims.slice(), v.data.map(s => parseNumStr(s))); err('无法转换 string。'); }
  if (v instanceof MCell) err("无法将 cell 转换为 " + cls + "。", 'MATLAB:invalidConversion');
  if (v instanceof MStruct) err("无法将 struct 转换为 " + cls + "。", 'MATLAB:invalidConversion');
  const t = toT(v);
  let re;
  if (isIntCls(cls)) re = t.re.map(x => satInt(cls, x));
  else if (cls === 'single') re = t.re.map(x => Math.fround(x));
  else if (cls === 'logical') re = t.re.map(x => { if (x !== x) err('NaN 不能转换为逻辑值。'); return x !== 0 ? 1 : 0; });
  else re = t.re.slice();
  return mk(cls, t.dims.slice(), re, (cls === 'double' || cls === 'single') && t.im ? t.im.slice() : null);
}
for (const c of ['double', 'single', 'int8', 'uint8', 'int16', 'uint16', 'int32', 'uint32', 'int64', 'uint64']) B[c] = (a) => { if (!a.length) return castTo(0, c); return castTo(a[0], c); };
B.logical = (a) => castTo(a[0], 'logical');
B.cast = (a) => castTo(a[0], toStr(a[1]));
B.char = (a) => {
  if (a.length === 0) return new Tensor('char', [0, 0], []);
  if (a.length > 1 || a[0] instanceof MCell || (a[0] instanceof MString && a[0].data.length !== 1)) {
    const strs = [];
    for (const x of a) { if (x instanceof MCell) for (const y of x.data) strs.push(toStr(y)); else if (x instanceof MString) strs.push(...x.data); else if (isChar(x) && x.dims[0] > 1) strs.push(...charRowsToStrings(x)); else strs.push(isChar(x) ? toStr(x) : String.fromCharCode(...toArr(x))); }
    return charMatrix(strs);
  }
  const v = a[0];
  if (v instanceof MString) return mkStr(v.data[0]);
  const t = toT(v); return mk('char', t.dims.slice(), t.re.map(x => Math.max(0, Math.round(x))));
};
function charMatrix(strs) {
  const w = strs.reduce((m, s) => Math.max(m, s.length), 0); const r = strs.length;
  const re = new Array(r * w);
  for (let i = 0; i < r; i++) for (let j = 0; j < w; j++) re[i + j * r] = j < strs[i].length ? strs[i].charCodeAt(j) : 32;
  return new Tensor('char', r === 0 ? [0, 0] : [r, w], re);
}
B.class = (a) => mkStr(classOf(a[0]));
B.isa = (a) => {
  const c = classOf(a[0]), t = toStr(a[1]);
  if (t === c) return true;
  if (t === 'numeric') return isNumericV(a[0]);
  if (t === 'float') return c === 'double' || c === 'single';
  if (t === 'integer') return isIntCls(c);
  return false;
};
function isNumericV(v) { const c = classOf(v); return c === 'double' || c === 'single' || isIntCls(c); }
B.isnumeric = (a) => isNumericV(a[0]);
B.ischar = (a) => isChar(a[0]);
B.iscell = (a) => a[0] instanceof MCell;
B.isstruct = (a) => a[0] instanceof MStruct && !a[0].cn;
B.islogical = (a) => classOf(a[0]) === 'logical';
B.isfloat = (a) => { const c = classOf(a[0]); return c === 'double' || c === 'single'; };
B.isinteger = (a) => isIntCls(classOf(a[0]));
B.isreal = (a) => !(a[0] instanceof Tensor && a[0].im);
B.isstring = (a) => a[0] instanceof MString;
B.is_function_handle = (a) => a[0] instanceof FHandle;
B.isobject = (a) => a[0] instanceof MapObj;
B.iscellstr = (a) => a[0] instanceof MCell && a[0].data.every(x => isChar(x) && x.dims[0] <= 1);
B.isempty = (a) => numelOf(a[0]) === 0 && !(a[0] instanceof MapObj ? a[0].map.size !== 0 : false) || (a[0] instanceof MapObj && a[0].map.size === 0);
B.isscalar = (a) => numelOf(a[0]) === 1;
B.isvector = (a) => { const d = dimsOf(a[0]); return d.length === 2 && (d[0] === 1 || d[1] === 1) && prodDims(d) >= 1; };
B.ismatrix = (a) => dimsOf(a[0]).length === 2;
B.isrow = (a) => { const d = dimsOf(a[0]); return d.length === 2 && d[0] === 1; };
B.iscolumn = (a) => { const d = dimsOf(a[0]); return d.length === 2 && d[1] === 1; };
B.issquare = (a) => { const d = dimsOf(a[0]); return d.length === 2 && d[0] === d[1]; };
B.isequal = (a) => { for (let i = 1; i < a.length; i++) if (!valEqual(a[0], a[i], false)) return false; return true; };
B.isequaln = (a) => { for (let i = 1; i < a.length; i++) if (!valEqual(a[0], a[i], true)) return false; return true; };
function valEqual(x, y, nanEq) {
  if (isTensorLike(x) && isTensorLike(y)) {
    const X = toT(x), Y = toT(y);
    if (!sameDims(X.dims, Y.dims)) return false;
    for (let i = 0; i < X.re.length; i++) { const p = X.re[i], q = Y.re[i]; if (p !== q && !(nanEq && p !== p && q !== q)) return false; }
    const xi = X.im, yi = Y.im; if (xi || yi) for (let i = 0; i < X.re.length; i++) if ((xi ? xi[i] : 0) !== (yi ? yi[i] : 0)) return false;
    return true;
  }
  if ((x instanceof MString || isChar(x)) && (y instanceof MString || isChar(y))) { if (x instanceof MString && y instanceof MString) return x.data.length === y.data.length && x.data.every((s, i) => s === y.data[i]); return toStr(x) === toStr(y); }
  if (x instanceof MCell && y instanceof MCell) return sameDims(x.dims, y.dims) && x.data.every((v, i) => valEqual(v, y.data[i], nanEq));
  if (x instanceof MStruct && y instanceof MStruct) {
    if (!sameDims(x.dims, y.dims) || x.fields.length !== y.fields.length) return false;
    for (const f of x.fields) if (y.fields.indexOf(f) < 0) return false;
    return x.data.every((o, i) => x.fields.every(f => valEqual(o[f], y.data[i][f], nanEq)));
  }
  if (x instanceof FHandle && y instanceof FHandle) return x === y;
  if (x instanceof MapObj && y instanceof MapObj) return x === y;
  return false;
}
// ---- size ----
B.size = (a, nout) => {
  nargchk(a, 1, undefined, 'size');
  const d = dimsOf(a[0]);
  if (a.length > 1) {
    if (a.length === 2) { const ks = toArr(a[1]); if (ks.length === 1) { const k = ks[0]; return k <= d.length ? d[k - 1] : 1; } return mkRow(ks.map(k => (k <= d.length ? d[k - 1] : 1))); }
    return new MR(a.slice(1).map(x => { const k = toNum(x); return k <= d.length ? d[k - 1] : 1; }));
  }
  if (nout <= 1) return mkRow(d.slice());
  const outv = []; for (let k = 0; k < nout; k++) { if (k < nout - 1) outv.push(k < d.length ? d[k] : 1); else outv.push(prodDims(d.slice(k))); }
  return new MR(outv);
};
B.length = (a) => { if (a[0] instanceof MapObj) return a[0].map.size; const d = dimsOf(a[0]); return prodDims(d) === 0 ? 0 : Math.max(...d); };
B.numel = (a) => (a[0] instanceof MapObj ? a[0].map.size : numelOf(a[0]));
B.ndims = (a) => dimsOf(a[0]).length;
B.rows = (a) => dimsOf(a[0])[0];
B.columns = (a) => dimsOf(a[0])[1];
// ---- elementwise math ----
function mapUnary(v, fr, fc, opt) {
  // opt: {keepInt: bool, toComplex: x=>bool (needs complex for real x), outCls}
  if (typeof v === 'number' && !(opt && opt.toComplex && opt.toComplex(v))) return opt && opt.logical ? !!fr(v) : fr(v);
  if (!isTensorLike(v)) err("未定义与 '" + classOf(v) + "' 类型的输入参数对应的函数。", 'MATLAB:UndefinedFunction');
  const t = toT(v); const n = t.re.length;
  let cls = (t.cls === 'single') ? 'single' : 'double';
  if (opt && opt.keepInt && isIntCls(t.cls)) cls = t.cls;
  if (opt && opt.logical) cls = 'logical';
  let needC = !!t.im;
  if (!needC && opt && opt.toComplex) for (let i = 0; i < n; i++) if (opt.toComplex(t.re[i])) { needC = true; break; }
  if (!needC || !fc) {
    const re = new Array(n); for (let i = 0; i < n; i++) re[i] = fr(t.re[i]);
    if (isIntCls(cls)) for (let i = 0; i < n; i++) re[i] = satInt(cls, re[i]);
    return mk(cls, t.dims.slice(), re);
  }
  const re = new Array(n), im = new Array(n);
  for (let i = 0; i < n; i++) { const r = fc(t.re[i], t.im ? t.im[i] : 0); re[i] = r[0]; im[i] = r[1]; }
  if (opt && opt.realOut) return mk(cls, t.dims.slice(), re);
  return mk(cls, t.dims.slice(), re, im);
}
const csqrt = (a, b) => { if (b === 0) return a >= 0 ? [Math.sqrt(a), 0] : [0, Math.sqrt(-a)]; const m = Math.hypot(a, b); const r = Math.sqrt((m + a) / 2); const i = Math.sign(b) * Math.sqrt((m - a) / 2); return [r, i]; };
const cexp = (a, b) => { const m = Math.exp(a); return [m * Math.cos(b), m * Math.sin(b)]; };
const clog = (a, b) => [Math.log(Math.hypot(a, b)), Math.atan2(b, a)];
const csin = (a, b) => [Math.sin(a) * Math.cosh(b), Math.cos(a) * Math.sinh(b)];
const ccos = (a, b) => [Math.cos(a) * Math.cosh(b), -Math.sin(a) * Math.sinh(b)];
function defMath(name, fr, fc, opt) { B[name] = (a) => { nargchk(a, 1, 1, name); return mapUnary(a[0], fr, fc, opt); }; }
defMath('sqrt', Math.sqrt, csqrt, { toComplex: x => x < 0 });
defMath('exp', Math.exp, cexp);
defMath('log', Math.log, clog, { toComplex: x => x < 0 });
defMath('log2', Math.log2, (a, b) => { const r = clog(a, b); return [r[0] / Math.LN2, r[1] / Math.LN2]; }, { toComplex: x => x < 0 });
defMath('log10', Math.log10, (a, b) => { const r = clog(a, b); return [r[0] / Math.LN10, r[1] / Math.LN10]; }, { toComplex: x => x < 0 });
defMath('log1p', Math.log1p); defMath('expm1', Math.expm1);
defMath('sin', Math.sin, csin); defMath('cos', Math.cos, ccos);
defMath('tan', Math.tan, (a, b) => cdiv(...csin(a, b), ...ccos(a, b)));
defMath('sec', x => 1 / Math.cos(x)); defMath('csc', x => 1 / Math.sin(x)); defMath('cot', x => 1 / Math.tan(x));
defMath('asin', Math.asin, (a, b) => { // -i*log(iz + sqrt(1-z^2))
  const z2 = cmul(a, b, a, b); const s = csqrt(1 - z2[0], -z2[1]); const l = clog(-b + s[0], a + s[1]); return [l[1], -l[0]]; }, { toComplex: x => Math.abs(x) > 1 });
defMath('acos', Math.acos, (a, b) => { const z2 = cmul(a, b, a, b); const s = csqrt(1 - z2[0], -z2[1]); const l = clog(a - s[1], b + s[0]); return [l[1], -l[0]]; }, { toComplex: x => Math.abs(x) > 1 });
defMath('atan', Math.atan); defMath('sinh', Math.sinh); defMath('cosh', Math.cosh); defMath('tanh', Math.tanh);
defMath('asinh', Math.asinh); defMath('acosh', Math.acosh); defMath('atanh', Math.atanh);
defMath('sind', x => { if (Number.isInteger(x / 180)) return 0; return Math.sin(x * Math.PI / 180); });
defMath('cosd', x => { if (Number.isInteger((x - 90) / 180)) return 0; return Math.cos(x * Math.PI / 180); });
defMath('tand', x => Math.tan(x * Math.PI / 180));
defMath('asind', x => Math.asin(x) * 180 / Math.PI); defMath('acosd', x => Math.acos(x) * 180 / Math.PI); defMath('atand', x => Math.atan(x) * 180 / Math.PI);
defMath('deg2rad', x => x * Math.PI / 180); defMath('rad2deg', x => x * 180 / Math.PI);
defMath('cbrt', Math.cbrt);
defMath('gamma', gammaFn); defMath('gammaln', x => Math.log(Math.abs(gammaFn(x))));
defMath('erf', erf); defMath('erfc', x => 1 - erf(x));
function gammaFn(x) {
  if (Number.isInteger(x)) { if (x <= 0) return Infinity; if (x < 171) { let r = 1; for (let k = 2; k < x; k++) r *= k; return r; } return Infinity; }
  if (x < 0.5) return Math.PI / (Math.sin(Math.PI * x) * gammaFn(1 - x));
  x -= 1; const g = 7, c = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
  let s = c[0]; for (let i = 1; i < g + 2; i++) s += c[i] / (x + i); const t = x + g + 0.5;
  return Math.sqrt(2 * Math.PI) * Math.pow(t, x + 0.5) * Math.exp(-t) * s;
}
function erf(x) { // Abramowitz-Stegun 7.1.26 refined with series for small x
  const s = Math.sign(x); x = Math.abs(x);
  if (x < 3) { let sum = x, term = x, k = 0; while (Math.abs(term) > 1e-17 * Math.abs(sum) && k < 200) { k++; term *= -x * x / k; sum += term / (2 * k + 1); } return s * 2 / Math.sqrt(Math.PI) * sum; }
  // continued fraction for erfc
  let f = 0; for (let k = 60; k >= 1; k--) f = k / 2 / (x + f); const erfc = Math.exp(-x * x) / Math.sqrt(Math.PI) / (x + f);
  return s * (1 - erfc);
}
B.abs = (a) => { const v = a[0]; if (typeof v === 'number') return Math.abs(v); return mapUnary(v, Math.abs, (p, q) => [Math.hypot(p, q), 0], { keepInt: true, realOut: true }); };
B.sign = (a) => mapUnary(a[0], x => (x > 0 ? 1 : x < 0 ? -1 : x === 0 ? 0 : NaN), null, { keepInt: true });
const roundHalfAway = x => (x < 0 ? -Math.round(-x) : Math.round(x));
B.round = (a) => {
  if (a.length > 1) { const d = toNum(a[1]); const p = Math.pow(10, d); return mapUnary(a[0], x => roundHalfAway(x * p) / p, null, { keepInt: true }); }
  return mapUnary(a[0], roundHalfAway, (p, q) => [roundHalfAway(p), roundHalfAway(q)], { keepInt: true });
};
B.floor = (a) => mapUnary(a[0], Math.floor, (p, q) => [Math.floor(p), Math.floor(q)], { keepInt: true });
B.ceil = (a) => mapUnary(a[0], Math.ceil, (p, q) => [Math.ceil(p), Math.ceil(q)], { keepInt: true });
B.fix = (a) => mapUnary(a[0], Math.trunc, (p, q) => [Math.trunc(p), Math.trunc(q)], { keepInt: true });
B.real = (a) => { const v = a[0]; if (typeof v === 'number') return v; const t = toT(v); return mk(t.cls === 'logical' || t.cls === 'char' ? 'double' : t.cls, t.dims.slice(), t.re.slice()); };
B.imag = (a) => { const v = a[0]; if (typeof v === 'number') return 0; const t = toT(v); return mk('double', t.dims.slice(), t.im ? t.im.slice() : zerosArr(t.re.length)); };
B.conj = (a) => { const t = toT(a[0]); if (!t.im) return a[0]; return mk(t.cls, t.dims.slice(), t.re.slice(), t.im.map(x => -x)); };
B.angle = (a) => mapUnary(a[0], x => (x < 0 ? Math.PI : 0), (p, q) => [Math.atan2(q, p), 0], { realOut: true });
B.complex = (a) => { const r = toT(a[0]); const im = a.length > 1 ? toT(a[1]) : toT(0); const res = elementwise(r, im, (x) => x, (p, q, s, t) => [p, s], 'double'); const R = toT(res); const n = R.re.length; const imv = a.length > 1 ? (im.re.length === 1 ? new Array(n).fill(im.re[0]) : im.re.slice()) : zerosArr(n); return new Tensor('double', R.dims.slice(), toT(a[0]).re.length === 1 ? new Array(n).fill(toT(a[0]).re[0]) : toT(a[0]).re.slice(), imv); };
B.isnan = (a) => { const v = a[0]; if (typeof v === 'number') return v !== v; return mapUnary(v, x => (x !== x ? 1 : 0), null, { logical: true }); };
B.isinf = (a) => { const v = a[0]; if (typeof v === 'number') return v === Infinity || v === -Infinity; return mapUnary(v, x => (x === Infinity || x === -Infinity ? 1 : 0), null, { logical: true }); };
B.isfinite = (a) => { const v = a[0]; if (typeof v === 'number') return isFinite(v); return mapUnary(v, x => (isFinite(x) ? 1 : 0), null, { logical: true }); };
function bin2(name, fr, cls) { B[name] = (a) => { nargchk(a, 2, 2, name); const c = cls || arithClass(a[0], a[1]); if (typeof a[0] === 'number' && typeof a[1] === 'number' && c === 'double') return fr(a[0], a[1]); return elementwise(a[0], a[1], fr, null, c); }; }
bin2('atan2', Math.atan2, 'double');
bin2('hypot', Math.hypot, 'double');
bin2('mod', (x, y) => { if (y === 0) return x; if (!isFinite(x)) return NaN; if (!isFinite(y)) return (x === 0 || Math.sign(x) === Math.sign(y)) ? x : y; const r = x - Math.floor(x / y) * y; if (Math.abs(r - y) < Math.abs(y) * 1e-15) return 0; return r; });
bin2('rem', (x, y) => { if (y === 0) return NaN; if (!isFinite(x)) return NaN; if (!isFinite(y)) return x; return x - Math.trunc(x / y) * y; });
bin2('idivide', (x, y) => Math.trunc(x / y));
function gcd2(a, b) { a = Math.abs(a); b = Math.abs(b); while (b) { const t = a % b; a = b; b = t; } return a; }
bin2('gcd', gcd2);
bin2('lcm', (a, b) => (a === 0 || b === 0 ? 0 : Math.abs(a * b) / gcd2(a, b)));
B.power = (a) => binop('.^', a[0], a[1]); B.mpower = (a) => binop('^', a[0], a[1]);
B.plus = (a) => binop('+', a[0], a[1]); B.minus = (a) => binop('-', a[0], a[1]);
B.times = (a) => binop('.*', a[0], a[1]); B.mtimes = (a) => binop('*', a[0], a[1]);
B.rdivide = (a) => binop('./', a[0], a[1]); B.ldivide = (a) => binop('.\\', a[0], a[1]);
B.mrdivide = (a) => binop('/', a[0], a[1]); B.mldivide = (a) => binop('\\', a[0], a[1]);
B.uminus = (a) => unop('-', a[0]); B.uplus = (a) => a[0]; B.not = (a) => unop('~', a[0]);
B.eq = (a) => binop('==', a[0], a[1]); B.ne = (a) => binop('~=', a[0], a[1]);
B.lt = (a) => binop('<', a[0], a[1]); B.gt = (a) => binop('>', a[0], a[1]);
B.le = (a) => binop('<=', a[0], a[1]); B.ge = (a) => binop('>=', a[0], a[1]);
B.and = (a) => { let r = a[0]; for (let i = 1; i < a.length; i++) r = binop('&', r, a[i]); return r; };
B.or = (a) => { let r = a[0]; for (let i = 1; i < a.length; i++) r = binop('|', r, a[i]); return r; };
B.xor = (a) => elementwise(a[0], a[1], (x, y) => ((x !== 0) !== (y !== 0) ? 1 : 0), null, 'logical');
B.transpose = (a) => transpose(a[0], false); B.ctranspose = (a) => transpose(a[0], true);
B.nthroot = (a) => elementwise(a[0], a[1], (x, n) => (x < 0 && n % 2 === 1 ? -Math.pow(-x, 1 / n) : Math.pow(x, 1 / n)), null, 'double');
B.factorial = (a) => mapUnary(a[0], n => { if (n < 0 || !Number.isInteger(n)) err('N 必须为由非负整数组成的数组。'); let r = 1; for (let k = 2; k <= n; k++) r *= k; return r; });
B.nchoosek = (a) => {
  const nv = a[0], k = toNum(a[1]);
  if (numelOf(nv) === 1) { const n = toNum(nv); let r = 1; for (let i = 1; i <= k; i++) r = r * (n - k + i) / i; return Math.round(r); }
  const v = toArr(nv); const res = [];
  const rec = (start, combo) => { if (combo.length === k) { res.push(combo.slice()); return; } for (let i = start; i < v.length; i++) { combo.push(v[i]); rec(i + 1, combo); combo.pop(); } };
  rec(0, []); const R = res.length; const re = new Array(R * k); for (let i = 0; i < R; i++) for (let j = 0; j < k; j++) re[i + j * R] = res[i][j];
  return mkMat(R, k, re);
};
B.perms = (a) => {
  const v = toArr(a[0]); const res = [];
  const rec = (arr, cur) => { if (!arr.length) { res.push(cur); return; } for (let i = arr.length - 1; i >= 0; i--) rec(arr.slice(0, i).concat(arr.slice(i + 1)), cur.concat([arr[i]])); };
  rec(v.slice(), []); const R = res.length, k = v.length; const re = new Array(R * k); for (let i = 0; i < R; i++) for (let j = 0; j < k; j++) re[i + j * R] = res[i][j];
  return mkMat(R, k, re);
};
function isPrimeN(n) { if (n < 2 || !Number.isInteger(n)) return false; if (n < 4) return true; if (n % 2 === 0) return false; for (let k = 3; k * k <= n; k += 2) if (n % k === 0) return false; return true; }
B.isprime = (a) => mapUnary(a[0], x => (isPrimeN(x) ? 1 : 0), null, { logical: true });
B.primes = (a) => { const n = toNum(a[0]); const s = new Uint8Array(Math.max(n + 1, 2)); const out = []; for (let i = 2; i <= n; i++) { if (!s[i]) { out.push(i); for (let j = i * i; j <= n; j += i) s[j] = 1; } } return mkRow(out); };
B.factor = (a) => { let n = toNum(a[0]); const out = []; if (n < 4) return mkRow([n]); for (let p = 2; p * p <= n; p++) while (n % p === 0) { out.push(p); n /= p; } if (n > 1) out.push(n); return mkRow(out); };

// ---- reductions ----
function firstNonSingleton(d) { for (let k = 0; k < d.length; k++) if (d[k] !== 1) return k; return 0; }
function getDim(a, idx, d) { if (a.length > idx && !(isTensorLike(a[idx]) && numelOf(a[idx]) === 0)) { if (isStringy(a[idx])) { const s = toStr(a[idx]); if (s === 'all') return 'all'; return firstNonSingleton(d); } return toNum(a[idx]) - 1; } return firstNonSingleton(d); }
// reduce tensor t along dim k with fn(values array) -> number ; returns tensor with dims[k]=1
function reduceAlong(t, k, fn, cls, emptyVal) {
  const d = t.dims.slice(); while (d.length <= k) d.push(1);
  const len = d[k]; let inner = 1; for (let i = 0; i < k; i++) inner *= d[i]; let outer = 1; for (let i = k + 1; i < d.length; i++) outer *= d[i];
  const od = d.slice(); od[k] = 1;
  if (t.re.length === 0 && emptyVal !== undefined && prodDims(t.dims) === 0 && t.dims.length === 2 && t.dims[0] === 0 && t.dims[1] === 0) return mk(cls || 'double', [1, 1], [emptyVal]);
  const re = new Array(inner * outer); const buf = new Array(len);
  for (let o = 0; o < outer; o++) for (let i = 0; i < inner; i++) {
    const base = o * len * inner + i; for (let j = 0; j < len; j++) buf[j] = t.re[base + j * inner];
    re[o * inner + i] = fn(buf, len);
  }
  return mk(cls || 'double', od, re);
}
function cumAlong(t, k, fn) {
  const d = t.dims; const len = k < d.length ? d[k] : 1; let inner = 1; for (let i = 0; i < k; i++) inner *= d[i]; const outer = t.re.length / (inner * len || 1);
  const re = t.re.slice();
  for (let o = 0; o < outer; o++) for (let i = 0; i < inner; i++) { const base = o * len * inner + i; let acc; for (let j = 0; j < len; j++) { const idx = base + j * inner; acc = j === 0 ? re[idx] : fn(acc, re[idx]); re[idx] = acc; } }
  return re;
}
function redCls(t) { return isIntCls(t.cls) ? t.cls : (t.cls === 'single' ? 'single' : 'double'); }
function sumLike(name, fn, init) {
  B[name] = (a) => {
    nargchk(a, 1, 3, name);
    let v = a[0];
    if (typeof v === 'number') return v;
    const t = toT(v);
    let k = getDim(a, 1, t.dims);
    let opts = a.slice(1).filter(isStringy).map(x => toStr(x));
    const omit = opts.indexOf('omitnan') >= 0;
    if (k === 'all') { return B[name]([mk(t.cls, [t.re.length, 1], t.re.slice(), t.im ? t.im.slice() : null), ...(omit ? [mkStr('omitnan')] : [])]); }
    if (t.im && name === 'sum') { const R = reduceAlong(new Tensor('double', t.dims, t.re), k, (b, n) => { let s = 0; for (let i = 0; i < n; i++) s += b[i]; return s; }); const I = reduceAlong(new Tensor('double', t.dims, t.im), k, (b, n) => { let s = 0; for (let i = 0; i < n; i++) s += b[i]; return s; }); const r = toT(R), im = toT(I); return mk('double', r.dims, r.re, im.re); }
    const cls = redCls(t);
    const res = reduceAlong(t, k, (b, n) => { let s = init; for (let i = 0; i < n; i++) { const x = b[i]; if (omit && x !== x) continue; s = fn(s, x); } return s; }, cls, init);
    if (isIntCls(cls)) { const r = toT(res); return mk(cls, r.dims, r.re.map(x => satInt(cls, x))); }
    return res;
  };
}
sumLike('sum', (s, x) => s + x, 0);
sumLike('prod', (s, x) => s * x, 1);
B.nnz = (a) => { const t = toT(a[0]); let c = 0; for (const x of t.re) if (x !== 0) c++; return c; };
function cumLike(name, fn) { B[name] = (a) => { const t = toT(a[0]); const k = getDim(a, 1, t.dims); return mk(redCls(t), t.dims.slice(), cumAlong(t, k, fn)); }; }
cumLike('cumsum', (s, x) => s + x); cumLike('cumprod', (s, x) => s * x);
cumLike('cummax', (s, x) => (x > s || s !== s ? x : s)); cumLike('cummin', (s, x) => (x < s || s !== s ? x : s));
B.mean = (a) => {
  const v = a[0]; if (typeof v === 'number') return v;
  const t = toT(v); if (t.re.length === 0 && t.dims[0] === 0 && t.dims[1] === 0) return NaN;
  const k = getDim(a, 1, t.dims); const omit = a.slice(1).some(x => isStringy(x) && toStr(x) === 'omitnan');
  if (k === 'all') return B.mean([mk('double', [t.re.length, 1], t.re.slice())]);
  if (t.im) { const r = toT(reduceAlong(new Tensor('double', t.dims, t.re), k, (b, n) => b.slice(0, n).reduce((s, x) => s + x, 0) / n)); const i = toT(reduceAlong(new Tensor('double', t.dims, t.im), k, (b, n) => b.slice(0, n).reduce((s, x) => s + x, 0) / n)); return mk('double', r.dims, r.re, i.re); }
  return reduceAlong(t, k, (b, n) => { let s = 0, c = 0; for (let i = 0; i < n; i++) { if (omit && b[i] !== b[i]) continue; s += b[i]; c++; } return s / c; }, t.cls === 'single' ? 'single' : 'double');
};
B.median = (a) => {
  const t = toT(a[0]); if (t.re.length === 0) return NaN; const k = getDim(a, 1, t.dims);
  if (k === 'all') return B.median([mk('double', [t.re.length, 1], t.re.slice())]);
  return reduceAlong(t, k, (b, n) => { const s = b.slice(0, n); if (s.some(x => x !== x)) return NaN; s.sort((x, y) => x - y); return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2; });
};
B.mode = (a) => {
  const t = toT(a[0]); const k = getDim(a, 1, t.dims);
  return reduceAlong(t, k, (b, n) => { const s = b.slice(0, n).sort((x, y) => x - y); let best = s[0], bc = 0, i = 0; while (i < n) { let j = i; while (j < n && s[j] === s[i]) j++; if (j - i > bc) { bc = j - i; best = s[i]; } i = j; } return best; });
};
function varFn(b, n, w) { if (n === 1) return 0; let m = 0; for (let i = 0; i < n; i++) m += b[i]; m /= n; let s = 0; for (let i = 0; i < n; i++) s += (b[i] - m) * (b[i] - m); return s / (w === 1 ? n : n - 1); }
B.var = (a) => { const t = toT(a[0]); const w = a.length > 1 && numelOf(a[1]) ? toNum(a[1]) : 0; const k = getDim(a, 2, t.dims); if (k === 'all') return B.var([mk('double', [t.re.length, 1], t.re.slice()), w]); return reduceAlong(t, k, (b, n) => varFn(b, n, w)); };
B.std = (a) => { const t = toT(a[0]); const w = a.length > 1 && numelOf(a[1]) ? toNum(a[1]) : 0; const k = getDim(a, 2, t.dims); if (k === 'all') return B.std([mk('double', [t.re.length, 1], t.re.slice()), w]); return reduceAlong(t, k, (b, n) => Math.sqrt(varFn(b, n, w))); };
function minmax(name, better) {
  B[name] = (a, nout) => {
    nargchk(a, 1, 4, name);
    if (a.length >= 2 && numelOf(a[1]) > 0) { // elementwise with second arg
      if (typeof a[0] === 'number' && typeof a[1] === 'number') { const x = a[0], y = a[1]; if (x !== x) return y; if (y !== y) return x; return better(y, x) ? y : x; }
      return elementwise(a[0], a[1], (x, y) => (x !== x ? y : y !== y ? x : better(y, x) ? y : x), null, arithClass(a[0], a[1]));
    }
    const v = a[0];
    if (typeof v === 'number') return nout > 1 ? new MR([v, 1]) : v;
    const t = toT(v);
    if (t.re.length === 0) return nout > 1 ? new MR([emptyD(), emptyD()]) : emptyD();
    let k = getDim(a, 2, t.dims);
    if (k === 'all') return B[name]([mk(t.cls, [t.re.length, 1], t.re.slice())], nout);
    const mag = t.im ? t.re.map((x, i) => Math.hypot(x, t.im[i])) : null;
    const d = t.dims.slice(); while (d.length <= k) d.push(1);
    const len = d[k]; let inner = 1; for (let i = 0; i < k; i++) inner *= d[i]; const outer = t.re.length / (inner * len);
    const od = d.slice(); od[k] = 1; const n = inner * outer;
    const re = new Array(n), im = t.im ? new Array(n) : null, idx = new Array(n);
    for (let o = 0; o < outer; o++) for (let i = 0; i < inner; i++) {
      const base = o * len * inner + i; let bi = -1, bv = NaN;
      for (let j = 0; j < len; j++) { const p = base + j * inner; const x = mag ? mag[p] : t.re[p]; if (x !== x) continue; if (bi < 0 || better(x, bv)) { bi = j; bv = x; } }
      if (bi < 0) bi = 0;
      const p = base + bi * inner; re[o * inner + i] = t.re[p]; if (im) im[o * inner + i] = t.im[p]; idx[o * inner + i] = bi + 1;
    }
    const cls = t.cls === 'logical' || t.cls === 'char' ? 'double' : t.cls;
    const m = mk(cls, od, re, im);
    return nout > 1 ? new MR([m, mk('double', od.slice(), idx)]) : m;
  };
}
minmax('max', (x, y) => x > y); minmax('min', (x, y) => x < y);
B.range = (a) => binop('-', B.max([a[0]]), B.min([a[0]]));
B.any = (a) => { const v = a[0]; if (typeof v === 'number') return v !== 0 && v === v; if (typeof v === 'boolean') return v; const t = toT(v); if (t.re.length === 0) return false; const k = getDim(a, 1, t.dims); if (k === 'all') return t.re.some(x => x !== 0 && x === x); return reduceAlong(t, k, (b, n) => { for (let i = 0; i < n; i++) if (b[i] !== 0 && b[i] === b[i]) return 1; return 0; }, 'logical'); };
B.all = (a) => { const v = a[0]; if (typeof v === 'number') return v !== 0; if (typeof v === 'boolean') return v; const t = toT(v); if (t.re.length === 0) return true; const k = getDim(a, 1, t.dims); if (k === 'all') return t.re.every(x => x !== 0); return reduceAlong(t, k, (b, n) => { for (let i = 0; i < n; i++) if (b[i] === 0) return 0; return 1; }, 'logical'); };
B.find = (a, nout) => {
  const t = toT(a[0]); let lim = a.length > 1 ? toNum(a[1]) : Infinity; const dir = a.length > 2 ? toStr(a[2]) : 'first';
  let idx = []; for (let i = 0; i < t.re.length; i++) if (t.re[i] !== 0 || (t.im && t.im[i] !== 0)) idx.push(i);
  if (idx.length > lim) idx = dir === 'last' ? idx.slice(idx.length - lim) : idx.slice(0, lim);
  const row = t.dims.length === 2 && t.dims[0] === 1 && t.dims[1] !== 1;
  const shape = (arr) => (row ? mk('double', [1, arr.length], arr) : mk('double', [arr.length, idx.length === 0 && t.re.length === 0 ? 0 : 1], arr));
  if (nout <= 1) { const r = shape(idx.map(i => i + 1)); if (idx.length === 0) return row ? new Tensor('double', [1, 0], []) : new Tensor('double', [0, t.re.length === 0 && t.dims[0] === 0 ? 0 : 1], []); return r; }
  const R = t.dims[0]; const rows = idx.map(i => (i % R) + 1), cols = idx.map(i => Math.floor(i / R) + 1);
  const outs = [shape(rows), shape(cols)]; if (nout > 2) outs.push(shape(idx.map(i => t.re[i])));
  return new MR(outs);
};
function sortIdx(vals, desc, cmpMag) {
  const n = vals.length; const idx = new Array(n); for (let i = 0; i < n; i++) idx[i] = i;
  idx.sort((i, j) => { const x = vals[i], y = vals[j]; const xn = x !== x, yn = y !== y; if (xn || yn) { if (xn && yn) return i - j; return desc ? (xn ? -1 : 1) : (xn ? 1 : -1); } if (x === y) return i - j; return desc ? (y - x) : (x - y); });
  return idx;
}
B.sort = (a, nout) => {
  let v = a[0];
  let desc = false; const rest = a.slice(1).filter(x => { if (isStringy(x)) { const s = toStr(x).toLowerCase(); if (s === 'descend') desc = true; return false; } return true; });
  if (v instanceof MCell) { // cellstr sort
    const strs = v.data.map(x => toStr(x)); const idx = strs.map((s, i) => i).sort((i, j) => (strs[i] < strs[j] ? -1 : strs[i] > strs[j] ? 1 : i - j)); if (desc) idx.reverse();
    const r = new MCell(v.dims.slice(), idx.map(i => v.data[i])); return nout > 1 ? new MR([r, mk('double', v.dims.slice(), idx.map(i => i + 1))]) : r;
  }
  if (v instanceof MString) { const idx = v.data.map((s, i) => i).sort((i, j) => (v.data[i] < v.data[j] ? -1 : v.data[i] > v.data[j] ? 1 : i - j)); if (desc) idx.reverse(); const r = new MString(v.dims.slice(), idx.map(i => v.data[i])); return nout > 1 ? new MR([r, mk('double', v.dims.slice(), idx.map(i => i + 1))]) : r; }
  if (typeof v === 'number') return nout > 1 ? new MR([v, 1]) : v;
  const t = toT(v); const k = rest.length ? toNum(rest[0]) - 1 : firstNonSingleton(t.dims);
  const d = t.dims.slice(); while (d.length <= k) d.push(1);
  const len = d[k]; let inner = 1; for (let i = 0; i < k; i++) inner *= d[i]; const outer = t.re.length / (inner * len || 1);
  const re = t.re.slice(), im = t.im ? t.im.slice() : null, ix = new Array(t.re.length);
  const mag = t.im ? t.re.map((x, i) => Math.hypot(x, t.im[i])) : t.re;
  for (let o = 0; o < outer; o++) for (let i = 0; i < inner; i++) {
    const base = o * len * inner + i; const vals = new Array(len); for (let j = 0; j < len; j++) vals[j] = mag[base + j * inner];
    const id = sortIdx(vals, desc);
    for (let j = 0; j < len; j++) { re[base + j * inner] = t.re[base + id[j] * inner]; if (im) im[base + j * inner] = t.im[base + id[j] * inner]; ix[base + j * inner] = id[j] + 1; }
  }
  const r = mk(t.cls, t.dims.slice(), re, im);
  return nout > 1 ? new MR([r, mk('double', t.dims.slice(), ix)]) : r;
};
B.sortrows = (a, nout) => {
  const v = a[0];
  if (v instanceof MCell) {
    const R = v.dims[0], C = v.dims[1]; let col = a.length > 1 ? toNum(a[1]) : 1; const desc = col < 0; col = Math.abs(col) - 1;
    const idx = []; for (let i = 0; i < R; i++) idx.push(i);
    const key = i => v.data[i + col * R]; idx.sort((i, j) => { const x = key(i), y = key(j); let c; if (isStringy(x)) { const s = toStr(x), u = toStr(y); c = s < u ? -1 : s > u ? 1 : 0; } else c = toNum(x) - toNum(y); return (desc ? -c : c) || i - j; });
    const data = new Array(R * C); for (let r = 0; r < R; r++) for (let c = 0; c < C; c++) data[r + c * R] = v.data[idx[r] + c * R];
    const out = new MCell([R, C], data); return nout > 1 ? new MR([out, mkCol(idx.map(i => i + 1))]) : out;
  }
  const t = toT(v); const R = t.dims[0], C = t.dims[1];
  let cols = a.length > 1 ? toArr(a[1]).slice() : null;
  if (a.length > 1 && isStringy(a[1])) cols = toStr(a[1]) === 'descend' ? Array.from({ length: C }, (_, i) => -(i + 1)) : null;
  if (!cols) cols = Array.from({ length: C }, (_, i) => i + 1);
  const idx = []; for (let i = 0; i < R; i++) idx.push(i);
  idx.sort((i, j) => { for (const c0 of cols) { const c = Math.abs(c0) - 1; const x = t.re[i + c * R], y = t.re[j + c * R]; if (x !== y) return c0 > 0 ? x - y : y - x; } return i - j; });
  const re = new Array(R * C); for (let r = 0; r < R; r++) for (let c = 0; c < C; c++) re[r + c * R] = t.re[idx[r] + c * R];
  const outv = mk(t.cls, [R, C], re); return nout > 1 ? new MR([outv, mkCol(idx.map(i => i + 1))]) : outv;
};
B.unique = (a, nout) => {
  const v = a[0]; const stable = a.slice(1).some(x => isStringy(x) && toStr(x) === 'stable');
  const rowsOpt = a.slice(1).some(x => isStringy(x) && toStr(x) === 'rows');
  if (v instanceof MCell || v instanceof MString) {
    const strs = v instanceof MCell ? v.data.map(x => toStr(x)) : v.data.slice();
    const order = strs.map((s, i) => i); if (!stable) order.sort((i, j) => (strs[i] < strs[j] ? -1 : strs[i] > strs[j] ? 1 : i - j));
    const seen = new Map(); const uniq = []; const firstIdx = [];
    for (const i of order) if (!seen.has(strs[i])) { seen.set(strs[i], uniq.length); uniq.push(strs[i]); firstIdx.push(i); }
    if (!stable) { /* MATLAB returns last occurrence index by default; use first */ }
    const jc = strs.map(s => seen.get(s) + 1);
    const isRow = dimsOf(v)[0] === 1;
    const res = v instanceof MCell ? (isRow ? mkCellRow(uniq.map(mkStr)) : mkCellCol(uniq.map(mkStr))) : new MString(isRow ? [1, uniq.length] : [uniq.length, 1], uniq);
    return nout > 1 ? new MR([res, mkCol(firstIdx.map(i => i + 1)), mkCol(jc)]) : res;
  }
  const t = toT(v);
  if (rowsOpt && t.dims[0] > 0) {
    const R = t.dims[0], C = t.dims[1]; const rowsArr = []; for (let i = 0; i < R; i++) { const r = []; for (let c = 0; c < C; c++) r.push(t.re[i + c * R]); rowsArr.push(r); }
    const order = rowsArr.map((r, i) => i); if (!stable) order.sort((i, j) => { for (let c = 0; c < C; c++) if (rowsArr[i][c] !== rowsArr[j][c]) return rowsArr[i][c] - rowsArr[j][c]; return i - j; });
    const keys = new Map(); const uniq = []; const fi = [];
    for (const i of order) { const k = rowsArr[i].join(','); if (!keys.has(k)) { keys.set(k, uniq.length); uniq.push(rowsArr[i]); fi.push(i); } }
    const U = uniq.length; const re = new Array(U * C); for (let i = 0; i < U; i++) for (let c = 0; c < C; c++) re[i + c * U] = uniq[i][c];
    const res = mk(t.cls, [U, C], re); return nout > 1 ? new MR([res, mkCol(fi.map(i => i + 1)), mkCol(rowsArr.map(r => keys.get(r.join(',')) + 1))]) : res;
  }
  const vals = t.re; const order = vals.map((x, i) => i);
  if (!stable) order.sort((i, j) => (vals[i] - vals[j]) || i - j);
  const uniq = [], fi = [], map = new Map();
  for (const i of order) { const x = vals[i]; if (x !== x) { uniq.push(x); fi.push(i); continue; } if (!map.has(x)) { map.set(x, uniq.length); uniq.push(x); fi.push(i); } }
  const isRow = t.dims.length === 2 && t.dims[0] === 1;
  const res = isRow ? mk(t.cls, [1, uniq.length], uniq) : mk(t.cls, [uniq.length, 1], uniq);
  if (nout > 1) { const jc = vals.map(x => map.get(x) + 1); return new MR([res, mkCol(fi.map(i => i + 1)), mkCol(jc)]); } // ia, ic are always column vectors (MATLAB)
  return res;
};
B.diff = (a) => {
  let t = toT(a[0]); let n = a.length > 1 ? toNum(a[1]) : 1;
  for (let r = 0; r < n; r++) {
    const k = a.length > 2 ? toNum(a[2]) - 1 : firstNonSingleton(t.dims);
    const d = t.dims.slice(); while (d.length <= k) d.push(1);
    const len = d[k]; if (len <= 1) { const od = d.slice(); od[k] = 0; return new Tensor('double', normDims(od), []); }
    let inner = 1; for (let i = 0; i < k; i++) inner *= d[i]; const outer = t.re.length / (inner * len);
    const od = d.slice(); od[k] = len - 1; const re = new Array(prodDims(od));
    for (let o = 0; o < outer; o++) for (let j = 0; j < len - 1; j++) for (let i = 0; i < inner; i++) re[o * (len - 1) * inner + j * inner + i] = t.re[o * len * inner + (j + 1) * inner + i] - t.re[o * len * inner + j * inner + i];
    t = new Tensor('double', normDims(od), re);
  }
  return mk('double', t.dims, t.re);
};
B.cross = (a) => { const x = toArr(a[0]), y = toArr(a[1]); if (x.length !== 3 || y.length !== 3) err('A 和 B 的长度必须为 3。'); const r = [x[1] * y[2] - x[2] * y[1], x[2] * y[0] - x[0] * y[2], x[0] * y[1] - x[1] * y[0]]; return mk('double', dimsOf(a[0]).slice(), r); };
B.dot = (a) => {
  const X = toT(a[0]), Y = toT(a[1]);
  if (X.re.length !== Y.re.length) err('A 和 B 的大小必须相同。');
  if (isVecDims(X.dims)) { let s = 0; for (let i = 0; i < X.re.length; i++) s += X.re[i] * Y.re[i]; return s; }
  return B.sum([binop('.*', X, Y)]);
};
B.kron = (a) => {
  const A = matOf(a[0]), Bm = matOf(a[1]); const m = A.dims[0], n = A.dims[1], p = Bm.dims[0], q = Bm.dims[1];
  const re = new Array(m * p * n * q);
  for (let i = 0; i < m; i++) for (let j = 0; j < n; j++) for (let k = 0; k < p; k++) for (let l = 0; l < q; l++) re[(i * p + k) + (j * q + l) * m * p] = A.re[i + j * m] * Bm.re[k + l * p];
  return mkMat(m * p, n * q, re);
};
B.trapz = (a) => {
  if (a.length === 1) { const y = toArr(a[0]); let s = 0; for (let i = 1; i < y.length; i++) s += (y[i] + y[i - 1]) / 2; return s; }
  const x = toArr(a[0]), y = toArr(a[1]); let s = 0; for (let i = 1; i < y.length; i++) s += (x[i] - x[i - 1]) * (y[i] + y[i - 1]) / 2; return s;
};
B.cumtrapz = (a) => {
  const x = a.length > 1 ? toArr(a[0]) : null, y = toArr(a.length > 1 ? a[1] : a[0]); const r = [0];
  for (let i = 1; i < y.length; i++) r.push(r[i - 1] + (x ? x[i] - x[i - 1] : 1) * (y[i] + y[i - 1]) / 2);
  return mk('double', dimsOf(a.length > 1 ? a[1] : a[0]).slice(), r);
};
B.fliplr = (a) => { const v = a[0]; const d = dimsOf(v); const R = d[0], C = d[1]; const lin = []; for (let j = C - 1; j >= 0; j--) for (let i = 0; i < R; i++) lin.push(i + j * R); const lin2 = []; for (let j = 0; j < C; j++) for (let i = 0; i < R; i++) lin2.push(i + (C - 1 - j) * R); return gather(typeof v === 'object' ? v : toT(v), lin2, [R, C]); };
B.flipud = (a) => { const v = a[0]; const d = dimsOf(v); const R = d[0], C = d[1]; const lin = []; for (let j = 0; j < C; j++) for (let i = 0; i < R; i++) lin.push((R - 1 - i) + j * R); return gather(typeof v === 'object' ? v : toT(v), lin, [R, C]); };
B.flip = (a) => { const d = dimsOf(a[0]); const k = a.length > 1 ? toNum(a[1]) : firstNonSingleton(d) + 1; return k === 1 ? B.flipud([a[0]]) : B.fliplr([a[0]]); };
B.rot90 = (a) => { let k = a.length > 1 ? toNum(a[1]) : 1; k = ((k % 4) + 4) % 4; let v = a[0]; for (let i = 0; i < k; i++) v = B.flipud([transpose(v, false)]); return v; };
B.circshift = (a) => {
  const v = a[0]; const d = dimsOf(v); let sh = toArr(a[1]).slice(); let dimArg = a.length > 2 ? toNum(a[2]) - 1 : -1;
  let shifts = new Array(d.length).fill(0);
  if (dimArg >= 0) shifts[dimArg] = sh[0]; else if (sh.length === 1) shifts[firstNonSingleton(d)] = sh[0]; else sh.forEach((s, i) => (shifts[i] = s));
  const n = prodDims(d); const lin = new Array(n); const cnt = new Array(d.length).fill(0);
  for (let t = 0; t < n; t++) { let li = 0, s = 1; for (let k = 0; k < d.length; k++) { const src = ((cnt[k] - shifts[k]) % d[k] + d[k]) % d[k]; li += src * s; s *= d[k]; } lin[t] = li; for (let k = 0; k < d.length; k++) { cnt[k]++; if (cnt[k] < d[k]) break; cnt[k] = 0; } }
  return gather(typeof v === 'object' ? v : toT(v), lin, d.slice());
};
B.permute = (a) => {
  const v = a[0]; const d = dimsOf(v).slice(); const p = toArr(a[1]).map(x => x - 1); while (d.length < p.length) d.push(1);
  const od = p.map(k => d[k]); const n = prodDims(d); const lin = new Array(n); const cnt = new Array(od.length).fill(0);
  const strides = []; let s = 1; for (let k = 0; k < d.length; k++) { strides.push(s); s *= d[k]; }
  for (let t = 0; t < n; t++) { let li = 0; for (let k = 0; k < od.length; k++) li += cnt[k] * strides[p[k]]; lin[t] = li; for (let k = 0; k < od.length; k++) { cnt[k]++; if (cnt[k] < od[k]) break; cnt[k] = 0; } }
  return gather(typeof v === 'object' ? v : toT(v), lin, od);
};
B.squeeze = (a) => { const v = a[0]; const d = dimsOf(v); if (d.length <= 2) return v; const nd = d.filter(x => x !== 1); while (nd.length < 2) nd.push(1); return reshapeVal(v, nd); };
B.tril = (a) => { const t = toT(a[0]); const k = a.length > 1 ? toNum(a[1]) : 0; const R = t.dims[0]; return mk(t.cls, t.dims.slice(), t.re.map((x, idx) => ((Math.floor(idx / R) - idx % R) <= k ? x : 0))); };
B.triu = (a) => { const t = toT(a[0]); const k = a.length > 1 ? toNum(a[1]) : 0; const R = t.dims[0]; return mk(t.cls, t.dims.slice(), t.re.map((x, idx) => ((Math.floor(idx / R) - idx % R) >= k ? x : 0))); };
B.histc = (a) => {
  const x = toArr(a[0]), e = toArr(a[1]); const c = zerosArr(e.length);
  for (const v of x) { if (v === e[e.length - 1]) { c[e.length - 1]++; continue; } for (let k = 0; k < e.length - 1; k++) if (v >= e[k] && v < e[k + 1]) { c[k]++; break; } }
  return mk('double', dimsOf(a[1]).slice(), c);
};
B.histcounts = (a, nout) => {
  const x = toArr(a[0]).filter(v => v === v);
  let edges;
  if (a.length > 1 && numelOf(a[1]) > 1) edges = toArr(a[1]).slice();
  else edges = autoBinEdges(x, a.length > 1 ? toNum(a[1]) : null);
  const c = binCounts(x, edges);
  return nout > 1 ? new MR([mkRow(c), mkRow(edges)]) : mkRow(c);
};
function binCounts(x, edges) {
  const n = edges.length - 1; const c = zerosArr(Math.max(n, 0));
  for (const v of x) { if (v < edges[0] || v > edges[n]) continue; let lo = 0, hi = n - 1; if (v === edges[n]) { c[n - 1]++; continue; } while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (edges[mid] <= v) lo = mid; else hi = mid - 1; } c[lo]++; }
  return c;
}
function niceNum(x) { const e = Math.floor(Math.log10(x)); const f = x / Math.pow(10, e); let nf; if (f <= 1) nf = 1; else if (f <= 2) nf = 2; else if (f <= 5) nf = 5; else nf = 10; return nf * Math.pow(10, e); }
function autoBinEdges(x, nbins) {
  if (x.length === 0) return [0, 1];
  let lo = Infinity, hi = -Infinity; for (const v of x) { if (v < lo) lo = v; if (v > hi) hi = v; }
  if (nbins) { if (lo === hi) { lo -= 0.5; hi += 0.5; } const w = (hi - lo) / nbins; const e = []; for (let i = 0; i <= nbins; i++) e.push(lo + i * w); e[nbins] = hi; return e; }
  if (lo === hi) return [lo - 0.5, lo + 0.5];
  const n = x.length; let m = 0; for (const v of x) m += v; m /= n; let s = 0; for (const v of x) s += (v - m) * (v - m); s = Math.sqrt(s / Math.max(n - 1, 1));
  let w = 3.5 * s * Math.pow(n, -1 / 3); if (!(w > 0)) w = (hi - lo) / 10;
  if ((hi - lo) / w > 1000) w = (hi - lo) / 1000;
  w = niceNum(w);
  const start = Math.floor(lo / w) * w; let end = Math.ceil(hi / w) * w; if (end === hi && false) end += w;
  const e = []; for (let v = start, k = 0; v <= end + w * 1e-9 && k < 2000; k++, v = start + k * w) e.push(Math.round(v / w) * w);
  if (e.length < 2) e.push(e[0] + w);
  return e;
}
B.accumarray = (a) => {
  const subs = toT(a[0]), vals = toT(a[1]);
  const fn = a.length > 3 && a[3] instanceof FHandle ? a[3] : null;
  if (subs.dims[1] === 1 || subs.dims[0] === 1 && subs.dims.length === 2 && subs.dims[1] !== 2) {
    const s = subs.re; let n = a.length > 2 && numelOf(a[2]) ? toArr(a[2])[0] : Math.max(...s);
    const groups = new Array(n).fill(null).map(() => []);
    for (let i = 0; i < s.length; i++) groups[s[i] - 1].push(vals.re.length === 1 ? vals.re[0] : vals.re[i]);
    const re = groups.map(g => (g.length === 0 ? 0 : fn ? toNum(callFn1(fn, [mkCol(g)])) : g.reduce((x, y) => x + y, 0)));
    return mkCol(re);
  }
  const R = subs.dims[0]; let nr = 0, nc = 0; for (let i = 0; i < R; i++) { nr = Math.max(nr, subs.re[i]); nc = Math.max(nc, subs.re[i + R]); }
  if (a.length > 2 && numelOf(a[2])) { const sz = toArr(a[2]); nr = sz[0]; nc = sz[1]; }
  const re = zerosArr(nr * nc); for (let i = 0; i < R; i++) re[(subs.re[i] - 1) + (subs.re[i + R] - 1) * nr] += vals.re.length === 1 ? vals.re[0] : vals.re[i];
  return mkMat(nr, nc, re);
};

// ======================================================================
// Linear algebra
// ======================================================================
function sqMat(v, name) { const M = getMat(v); if (M.m !== M.n) err('矩阵必须为方阵。', 'MATLAB:square'); return M; }
B.det = (a) => { const M = sqMat(a[0]); const n = M.n; if (n === 0) return 1; const LU = M.a; const f = luDecomp(LU, n); if (f.singular) return 0; let d = f.sign; for (let i = 0; i < n; i++) d *= LU[i + i * n]; return d; };
B.inv = (a) => { const M = sqMat(a[0]); return mkMat(M.n, M.n, invRaw(M.a, M.n)); };
B.trace = (a) => { const M = getMat(a[0]); let s = 0; for (let i = 0; i < Math.min(M.m, M.n); i++) s += M.a[i + i * M.m]; return s; };
B.lu = (a, nout) => {
  const M = sqMat(a[0]); const n = M.n; const LU = M.a; const f = luDecomp(LU, n);
  const L = zerosArr(n * n), U = zerosArr(n * n), P = zerosArr(n * n);
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) { if (i > j) L[i + j * n] = LU[i + j * n]; else { U[i + j * n] = LU[i + j * n]; if (i === j) L[i + j * n] = 1; } }
  for (let i = 0; i < n; i++) P[i + f.piv[i] * n] = 1;
  if (nout >= 3) return new MR([mkMat(n, n, L), mkMat(n, n, U), mkMat(n, n, P)]);
  // L = P'*L
  const PL = toT(mtimes(transpose(mkMat(n, n, P)), mkMat(n, n, L)));
  if (nout <= 1) { const Y = zerosArr(n * n); for (let k = 0; k < n * n; k++) Y[k] = LU[k]; return mkMat(n, n, Y); }
  return new MR([PL, mkMat(n, n, U)]);
};
function qrFull(A, m, n) {
  const qr = householderQR(A, m, n);
  const I = zerosArr(m * m); for (let i = 0; i < m; i++) I[i + i * m] = 1;
  // Q = H1 H2 ... ; apply to identity from the right: Q = (Q^T)^T where Q^T I = applyQt
  const Qt = applyQt(qr, I, m, m);
  const Q = new Array(m * m); for (let i = 0; i < m; i++) for (let j = 0; j < m; j++) Q[i + j * m] = Qt[j + i * m];
  const R = qr.R.slice(); for (let j = 0; j < n; j++) for (let i = j + 1; i < m; i++) R[i + j * m] = 0;
  return { Q, R };
}
B.qr = (a, nout) => {
  const M = getMat(a[0]); const m = M.m, n = M.n; const { Q, R } = qrFull(M.a, m, n);
  const econ = a.length > 1;
  if (econ && m > n) { const Q2 = Q.slice(0, m * n); const R2 = new Array(n * n); for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) R2[i + j * n] = R[i + j * m]; return nout > 1 ? new MR([mkMat(m, n, Q2), mkMat(n, n, R2)]) : mkMat(n, n, R2); }
  if (nout <= 1) return mkMat(m, n, R);
  return new MR([mkMat(m, m, Q), mkMat(m, n, R)]);
};
B.chol = (a, nout) => {
  const M = sqMat(a[0]); const n = M.n; const A = M.a; const R = zerosArr(n * n);
  for (let j = 0; j < n; j++) {
    let s = A[j + j * n]; for (let k = 0; k < j; k++) s -= R[k + j * n] * R[k + j * n];
    if (s <= 0) { if (nout > 1) return new MR([mkMat(j, j, R.slice(0, 0)), j + 1]); err('矩阵必须为正定矩阵。', 'MATLAB:posdef'); }
    const d = Math.sqrt(s); R[j + j * n] = d;
    for (let i = j + 1; i < n; i++) { let t = A[j + i * n]; for (let k = 0; k < j; k++) t -= R[k + j * n] * R[k + i * n]; R[j + i * n] = t / d; }
  }
  return nout > 1 ? new MR([mkMat(n, n, R), 0]) : mkMat(n, n, R);
};
// symmetric eigen: cyclic Jacobi. A col-major n x n. returns {d (ascending), V}
function eigSym(A, n) {
  const a = A.slice(); const V = zerosArr(n * n); for (let i = 0; i < n; i++) V[i + i * n] = 1;
  for (let sweep = 0; sweep < 100; sweep++) {
    let off = 0; for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) off += a[i + j * n] * a[i + j * n];
    if (off < 1e-30) break;
    for (let p = 0; p < n; p++) for (let q = p + 1; q < n; q++) {
      const apq = a[p + q * n]; if (Math.abs(apq) < 1e-300) continue;
      const app = a[p + p * n], aqq = a[q + q * n];
      const th = (aqq - app) / (2 * apq); const t = Math.sign(th || 1) / (Math.abs(th) + Math.sqrt(th * th + 1));
      const c = 1 / Math.sqrt(t * t + 1), s = t * c;
      for (let k = 0; k < n; k++) { const akp = a[k + p * n], akq = a[k + q * n]; a[k + p * n] = c * akp - s * akq; a[k + q * n] = s * akp + c * akq; }
      for (let k = 0; k < n; k++) { const apk = a[p + k * n], aqk = a[q + k * n]; a[p + k * n] = c * apk - s * aqk; a[q + k * n] = s * apk + c * aqk; }
      for (let k = 0; k < n; k++) { const vkp = V[k + p * n], vkq = V[k + q * n]; V[k + p * n] = c * vkp - s * vkq; V[k + q * n] = s * vkp + c * vkq; }
    }
  }
  const d = []; for (let i = 0; i < n; i++) d.push(a[i + i * n]);
  const idx = d.map((x, i) => i).sort((i, j) => d[i] - d[j]);
  const V2 = new Array(n * n); const d2 = idx.map(i => d[i]);
  for (let j = 0; j < n; j++) { const src = idx[j]; let sgn = 1; // normalize sign: make largest component... MATLAB-like: first nonzero negative? keep
    for (let i = 0; i < n; i++) V2[i + j * n] = V[i + src * n] * sgn; }
  return { d: d2, V: V2 };
}
// general real eigenvalues via Hessenberg + shifted QR (Francis double shift)
function eigGeneral(Ain, n) {
  const a = []; for (let i = 0; i < n; i++) { a.push([]); for (let j = 0; j < n; j++) a[i].push(Ain[i + j * n]); }
  // balance skipped; reduce to Hessenberg
  for (let m = 1; m < n - 1; m++) {
    let x = 0, i = m;
    for (let j = m; j < n; j++) if (Math.abs(a[j][m - 1]) > Math.abs(x)) { x = a[j][m - 1]; i = j; }
    if (i !== m) { for (let j = m - 1; j < n; j++) { const t = a[i][j]; a[i][j] = a[m][j]; a[m][j] = t; } for (let j = 0; j < n; j++) { const t = a[j][i]; a[j][i] = a[j][m]; a[j][m] = t; } }
    if (x !== 0) for (i = m + 1; i < n; i++) { let y = a[i][m - 1]; if (y !== 0) { y /= x; a[i][m - 1] = y; for (let j = m; j < n; j++) a[i][j] -= y * a[m][j]; for (let j = 0; j < n; j++) a[j][m] += y * a[j][i]; } }
  }
  for (let i = 2; i < n; i++) for (let j = 0; j < i - 1; j++) a[i][j] = 0;
  // hqr (Numerical Recipes)
  const wr = new Array(n).fill(0), wi = new Array(n).fill(0);
  let nn = n - 1, anorm = 0, t = 0;
  for (let i = 0; i < n; i++) for (let j = Math.max(i - 1, 0); j < n; j++) anorm += Math.abs(a[i][j]);
  while (nn >= 0) {
    let its = 0, l;
    do {
      for (l = nn; l >= 1; l--) { const s = Math.abs(a[l - 1][l - 1]) + Math.abs(a[l][l]); if (Math.abs(a[l][l - 1]) + (s === 0 ? anorm : s) === (s === 0 ? anorm : s)) { a[l][l - 1] = 0; break; } }
      const x = a[nn][nn];
      if (l === nn) { wr[nn] = x + t; wi[nn--] = 0; }
      else {
        const y = a[nn - 1][nn - 1], w = a[nn][nn - 1] * a[nn - 1][nn];
        if (l === nn - 1) {
          const p = 0.5 * (y - x), q = p * p + w, z = Math.sqrt(Math.abs(q)); let xx = x + t;
          if (q >= 0) { const zz = p + (p >= 0 ? Math.abs(z) : -Math.abs(z)); wr[nn - 1] = wr[nn] = xx + zz; if (zz) wr[nn] = xx - w / zz; wi[nn - 1] = wi[nn] = 0; }
          else { wr[nn - 1] = wr[nn] = xx + p; wi[nn - 1] = -(wi[nn] = z); }
          nn -= 2;
        } else {
          if (its === 60) err('eig 未收敛。');
          let xx = x, yy = y, ww = w;
          if (its === 10 || its === 20) { t += xx; for (let i = 0; i <= nn; i++) a[i][i] -= xx; const s = Math.abs(a[nn][nn - 1]) + Math.abs(a[nn - 1][nn - 2]); yy = xx = 0.75 * s; ww = -0.4375 * s * s; }
          ++its;
          let m, p, q, r, z;
          for (m = nn - 2; m >= l; m--) {
            z = a[m][m]; r = xx - z; const s = yy - z;
            p = (r * s - ww) / a[m + 1][m] + a[m][m + 1]; q = a[m + 1][m + 1] - z - r - s; r = a[m + 2][m + 1];
            const sc = Math.abs(p) + Math.abs(q) + Math.abs(r); p /= sc; q /= sc; r /= sc;
            if (m === l) break;
            const u = Math.abs(a[m][m - 1]) * (Math.abs(q) + Math.abs(r));
            const v = Math.abs(p) * (Math.abs(a[m - 1][m - 1]) + Math.abs(z) + Math.abs(a[m + 1][m + 1]));
            if (u + v === v) break;
          }
          for (let i = m + 2; i <= nn; i++) { a[i][i - 2] = 0; if (i !== m + 2) a[i][i - 3] = 0; }
          for (let k = m; k <= nn - 1; k++) {
            if (k !== m) { p = a[k][k - 1]; q = a[k + 1][k - 1]; r = 0; if (k !== nn - 1) r = a[k + 2][k - 1]; xx = Math.abs(p) + Math.abs(q) + Math.abs(r); if (xx !== 0) { p /= xx; q /= xx; r /= xx; } }
            const s = (p >= 0 ? 1 : -1) * Math.sqrt(p * p + q * q + r * r);
            if (s !== 0) {
              if (k === m) { if (l !== m) a[k][k - 1] = -a[k][k - 1]; } else a[k][k - 1] = -s * xx;
              p += s; xx = p / s; yy = q / s; z = r / s; q /= p; r /= p;
              for (let j = k; j <= nn; j++) { p = a[k][j] + q * a[k + 1][j]; if (k !== nn - 1) { p += r * a[k + 2][j]; a[k + 2][j] -= p * z; } a[k + 1][j] -= p * yy; a[k][j] -= p * xx; }
              const mmin = nn < k + 3 ? nn : k + 3;
              for (let i = l; i <= mmin; i++) { p = xx * a[i][k] + yy * a[i][k + 1]; if (k !== nn - 1) { p += z * a[i][k + 2]; a[i][k + 2] -= p * r; } a[i][k + 1] -= p * q; a[i][k] -= p; }
            }
          }
        }
      }
    } while (l < nn - 1);
  }
  return { wr, wi };
}
function isSymmetric(A, n) { let mx = 0; for (const x of A) mx = Math.max(mx, Math.abs(x)); for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) if (Math.abs(A[i + j * n] - A[j + i * n]) > 1e-12 * (mx || 1)) return false; return true; }
function nullVec(A, n, lam) { // inverse iteration for real eigenvalue
  const M = A.slice(); for (let i = 0; i < n; i++) M[i + i * n] -= lam + 1e-10 * (Math.abs(lam) + 1);
  const LU = M.slice(); const f = luDecomp(LU, n);
  for (let i = 0; i < n; i++) if (LU[i + i * n] === 0) LU[i + i * n] = 1e-14;
  let v = new Array(n).fill(1).map((x, i) => 1 + i * 0.1);
  for (let it = 0; it < 3; it++) { v = luSolve(LU, n, f.piv, v, 1); let nr = Math.hypot(...v); v = v.map(x => x / nr); }
  // sign convention: make the largest-magnitude component... keep MATLAB-ish: first nonzero component negative? use: largest abs component positive is not MATLAB; leave
  return v;
}
B.eig = (a, nout) => {
  const M = sqMat(a[0]); const n = M.n; const A = M.a;
  if (a.length > 1 && !isStringy(a[1])) { // generalized eig(A,B): solve inv(B)*A
    const Bm = sqMat(a[1]); const BA = toT(mldivide(mkMat(n, n, Bm.a), mkMat(n, n, A))); return B.eig([BA], nout);
  }
  if (isSymmetric(A, n)) {
    const E = eigSym(A, n);
    // MATLAB normalizes eigenvectors; sign: make the component with largest |x| ... we choose last component positive for 2x2 consistency? Use: first nonzero component negative if... leave as is but make columns deterministic: largest abs comp positive
    for (let j = 0; j < n; j++) { let last = 0; for (let i = n - 1; i >= 0; i--) if (Math.abs(E.V[i + j * n]) > 1e-12) { last = E.V[i + j * n]; break; } if (last < 0) for (let i = 0; i < n; i++) E.V[i + j * n] = -E.V[i + j * n]; }
    if (nout <= 1) return mkCol(E.d);
    const D = zerosArr(n * n); for (let i = 0; i < n; i++) D[i + i * n] = E.d[i];
    return new MR([mkMat(n, n, E.V), mkMat(n, n, D)]);
  }
  const { wr, wi } = eigGeneral(A, n);
  // order: MATLAB returns in Hessenberg-QR order; we sort by real part ascending then imag
  const idx = wr.map((x, i) => i).sort((i, j) => (wr[i] - wr[j]) || (wi[i] - wi[j]));
  const er = idx.map(i => wr[i]), ei = idx.map(i => wi[i]);
  const complex = ei.some(x => Math.abs(x) > 0);
  if (nout <= 1) return mk('double', [n, 1], er, complex ? ei : null);
  if (complex) err('eig：暂不支持非对称矩阵的复特征向量（特征值可用 eig(A) 求得）。');
  const V = []; for (let j = 0; j < n; j++) { const v = nullVec(A, n, er[j]); V.push(...v); }
  const D = zerosArr(n * n); for (let i = 0; i < n; i++) D[i + i * n] = er[i];
  return new MR([mkMat(n, n, V), mkMat(n, n, D)]);
};
// SVD via one-sided Jacobi. returns {U (m x k), s (k), V (n x k)} with k = min(m,n), sorted desc
function svdRaw(A, m, n) {
  let trans = false; let M = A.slice(), mm = m, nn = n;
  if (m < n) { trans = true; M = new Array(m * n); for (let i = 0; i < m; i++) for (let j = 0; j < n; j++) M[j + i * n] = A[i + j * m]; mm = n; nn = m; }
  const U = M.slice(); const V = zerosArr(nn * nn); for (let i = 0; i < nn; i++) V[i + i * nn] = 1;
  for (let sweep = 0; sweep < 75; sweep++) {
    let conv = true;
    for (let p = 0; p < nn; p++) for (let q = p + 1; q < nn; q++) {
      let alpha = 0, beta = 0, gamma = 0;
      for (let i = 0; i < mm; i++) { const up = U[i + p * mm], uq = U[i + q * mm]; alpha += up * up; beta += uq * uq; gamma += up * uq; }
      if (Math.abs(gamma) <= 1e-15 * Math.sqrt(alpha * beta) || gamma === 0) continue;
      conv = false;
      const zeta = (beta - alpha) / (2 * gamma); const t = Math.sign(zeta || 1) / (Math.abs(zeta) + Math.sqrt(1 + zeta * zeta));
      const c = 1 / Math.sqrt(1 + t * t), s = c * t;
      for (let i = 0; i < mm; i++) { const up = U[i + p * mm], uq = U[i + q * mm]; U[i + p * mm] = c * up - s * uq; U[i + q * mm] = s * up + c * uq; }
      for (let i = 0; i < nn; i++) { const vp = V[i + p * nn], vq = V[i + q * nn]; V[i + p * nn] = c * vp - s * vq; V[i + q * nn] = s * vp + c * vq; }
    }
    if (conv) break;
  }
  const s = []; for (let j = 0; j < nn; j++) { let t = 0; for (let i = 0; i < mm; i++) t += U[i + j * mm] * U[i + j * mm]; s.push(Math.sqrt(t)); }
  const idx = s.map((x, i) => i).sort((i, j) => s[j] - s[i]);
  const k = nn; const Uo = new Array(mm * k), Vo = new Array(nn * k), so = [];
  for (let jj = 0; jj < k; jj++) { const j = idx[jj]; so.push(s[j]); for (let i = 0; i < mm; i++) Uo[i + jj * mm] = s[j] > 1e-300 ? U[i + j * mm] / s[j] : 0; for (let i = 0; i < nn; i++) Vo[i + jj * nn] = V[i + j * nn]; }
  // fill null columns of U with orthonormal completion (Gram-Schmidt)
  for (let jj = 0; jj < k; jj++) if (so[jj] <= 1e-300) { for (let tries = 0; tries < mm; tries++) { const v = zerosArr(mm); v[(jj + tries) % mm] = 1; for (let c = 0; c < k; c++) if (c !== jj && (so[c] > 1e-300 || c < jj)) { let d = 0; for (let i = 0; i < mm; i++) d += v[i] * Uo[i + c * mm]; for (let i = 0; i < mm; i++) v[i] -= d * Uo[i + c * mm]; } const nr = Math.hypot(...v); if (nr > 1e-8) { for (let i = 0; i < mm; i++) Uo[i + jj * mm] = v[i] / nr; break; } } }
  if (trans) return { U: Vo, s: so, V: Uo, m: n, n: m, k, um: nn, vm: mm, trans: true };
  return { U: Uo, s: so, V: Vo, k, um: mm, vm: nn };
}
function completeBasis(Q, m, k) { // extend m x k orthonormal columns to m x m
  const out = Q.slice(0, m * k);
  let cols = k;
  for (let e = 0; e < m && cols < m; e++) {
    const v = zerosArr(m); v[e] = 1;
    for (let c = 0; c < cols; c++) { let d = 0; for (let i = 0; i < m; i++) d += v[i] * out[i + c * m]; for (let i = 0; i < m; i++) v[i] -= d * out[i + c * m]; }
    const nr = Math.hypot(...v); if (nr > 1e-8) { for (let i = 0; i < m; i++) out.push(v[i] / nr); cols++; }
  }
  return out;
}
B.svd = (a, nout) => {
  const M = getMat(a[0]); const m = M.m, n = M.n; const r = svdRaw(M.a, m, n);
  if (nout <= 1) return mkCol(r.s);
  const k = r.k; const econ = a.length > 1;
  if (econ) { const S = zerosArr(k * k); for (let i = 0; i < k; i++) S[i + i * k] = r.s[i]; return new MR([mkMat(m, k, r.U), mkMat(k, k, S), mkMat(n, k, r.V)]); }
  const U = completeBasis(r.U, m, k), V = completeBasis(r.V, n, k);
  const S = zerosArr(m * n); for (let i = 0; i < k; i++) S[i + i * m] = r.s[i];
  return new MR([mkMat(m, m, U), mkMat(m, n, S), mkMat(n, n, V)]);
};
function pinvRaw(A, m, n) {
  const r = svdRaw(A, m, n); const tol = Math.max(m, n) * (r.s[0] || 0) * 2.220446049250313e-16;
  const P = zerosArr(n * m);
  for (let c = 0; c < r.k; c++) { if (r.s[c] <= tol) continue; const inv = 1 / r.s[c]; for (let i = 0; i < n; i++) for (let j = 0; j < m; j++) P[i + j * n] += r.V[i + c * n] * inv * r.U[j + c * m]; }
  return P;
}
B.pinv = (a) => { const M = getMat(a[0]); return mkMat(M.n, M.m, pinvRaw(M.a, M.m, M.n)); };
B.rank = (a) => { const M = getMat(a[0]); if (M.a.length === 0) return 0; const r = svdRaw(M.a, M.m, M.n); const tol = a.length > 1 ? toNum(a[1]) : Math.max(M.m, M.n) * r.s[0] * 2.220446049250313e-16; return r.s.filter(x => x > tol).length; };
B.cond = (a) => { const M = getMat(a[0]); const r = svdRaw(M.a, M.m, M.n); return r.s[r.s.length - 1] === 0 ? Infinity : r.s[0] / r.s[r.s.length - 1]; };
B.null = (a) => { const M = getMat(a[0]); const m = M.m, n = M.n; const r = svdRaw(M.a, m, n); const V = completeBasis(r.V, n, r.k); const tol = Math.max(m, n) * (r.s[0] || 0) * 2.220446049250313e-16; const rank = r.s.filter(x => x > tol).length; return mkMat(n, n - rank, V.slice(rank * n)); };
B.orth = (a) => { const M = getMat(a[0]); const r = svdRaw(M.a, M.m, M.n); const tol = Math.max(M.m, M.n) * (r.s[0] || 0) * 2.220446049250313e-16; const rank = r.s.filter(x => x > tol).length; return mkMat(M.m, rank, r.U.slice(0, rank * M.m)); };
B.norm = (a) => {
  const v = a[0]; const t = toT(v); let p = a.length > 1 ? a[1] : 2;
  const ps = isStringy(p) ? toStr(p) : null; if (!ps) p = toNum(p);
  const absv = t.im ? t.re.map((x, i) => Math.hypot(x, t.im[i])) : t.re.map(Math.abs);
  if (isVecDims(t.dims) || t.re.length === 0) {
    if (ps === 'fro' || p === 2) { let s = 0, sc = 0; for (const x of absv) sc = Math.max(sc, x); if (sc === 0) return 0; for (const x of absv) s += (x / sc) * (x / sc); return sc * Math.sqrt(s); }
    if (ps === 'inf' || p === Infinity) return Math.max(...absv);
    if (p === -Infinity) return Math.min(...absv);
    if (p === 1) return absv.reduce((s, x) => s + x, 0);
    return Math.pow(absv.reduce((s, x) => s + Math.pow(x, p), 0), 1 / p);
  }
  const m = t.dims[0], n = t.dims[1];
  if (ps === 'fro') return Math.sqrt(absv.reduce((s, x) => s + x * x, 0));
  if (p === 1) { let mx = 0; for (let j = 0; j < n; j++) { let s = 0; for (let i = 0; i < m; i++) s += absv[i + j * m]; mx = Math.max(mx, s); } return mx; }
  if (ps === 'inf' || p === Infinity) { let mx = 0; for (let i = 0; i < m; i++) { let s = 0; for (let j = 0; j < n; j++) s += absv[i + j * m]; mx = Math.max(mx, s); } return mx; }
  const r = svdRaw(t.re, m, n); return r.s[0];
};
B.expm = (a) => {
  const M = sqMat(a[0]); const n = M.n; let A = mkMat(n, n, M.a);
  const nrm = B.norm([A, Infinity]); let s = Math.max(0, Math.ceil(Math.log2(nrm)) + 1);
  A = binop('/', A, Math.pow(2, s));
  const c = [1, 0.5, 0.12, 1.833333333333333e-2, 1.992753623188406e-3, 1.630434782608696e-4, 1.035196687370600e-5];
  const I = B.eye([n]); let X = A; let N = binop('+', I, binop('*', c[1], A)); let D = binop('-', I, binop('*', c[1], A));
  let positive = true;
  for (let k = 2; k <= 6; k++) { X = mtimes(A, X); const cX = binop('*', c[k], X); N = binop('+', N, cX); D = positive ? binop('+', D, cX) : binop('-', D, cX); positive = !positive; }
  let E = mldivide(D, N);
  for (let k = 0; k < s; k++) E = mtimes(E, E);
  return E;
};
// ======================================================================
// Polynomials & numerics
// ======================================================================
B.polyval = (a) => {
  const p = toArr(a[0]);
  const ev = (x) => { let y = 0; for (let i = 0; i < p.length; i++) y = y * x + p[i]; return y; };
  if (typeof a[1] === 'number') return ev(a[1]);
  const x = toT(a[1]); return mk('double', x.dims.slice(), x.re.map(ev));
};
B.polyfit = (a, nout) => {
  const x = toArr(a[0]), y = toArr(a[1]), n = toNum(a[2]); const m = x.length;
  if (y.length !== m) err('X 和 Y 向量的大小必须相同。');
  const V = new Array(m * (n + 1)); for (let i = 0; i < m; i++) for (let j = 0; j <= n; j++) V[i + j * m] = Math.pow(x[i], n - j);
  if (m < n + 1) warnMsg('多项式未正确设置条件。请增加数据点，或减少多项式的次数。');
  const p = lstsq(V, m, n + 1, y.slice(), 1);
  const P = mkRow(p);
  if (nout > 1) { const yh = x.map(xx => p.reduce((s, c) => s * xx + c, 0)); const normr = Math.sqrt(yh.reduce((s, v, i) => s + (v - y[i]) * (v - y[i]), 0)); return new MR([P, scalarStruct({ normr, df: Math.max(0, m - n - 1) }, ['normr', 'df'])]); }
  return P;
};
B.roots = (a) => {
  let p = toArr(a[0]).slice();
  while (p.length && p[0] === 0) p.shift();
  let nz = 0; while (p.length && p[p.length - 1] === 0) { p.pop(); nz++; }
  const n = p.length - 1;
  if (n < 1) return nz ? mkCol(zerosArr(nz)) : new Tensor('double', [0, 1], []);
  const C = zerosArr(n * n);
  for (let j = 0; j < n; j++) C[0 + j * n] = -p[j + 1] / p[0];
  for (let i = 1; i < n; i++) C[i + (i - 1) * n] = 1;
  const { wr, wi } = eigGeneral(C, n);
  // MATLAB order: descending magnitude roughly; we sort by real desc then imag desc
  const idx = wr.map((x, i) => i).sort((i, j) => (wr[j] - wr[i]) || (wi[j] - wi[i]));
  const re = idx.map(i => wr[i]).concat(zerosArr(nz)), im = idx.map(i => wi[i]).concat(zerosArr(nz));
  return mk('double', [re.length, 1], re, im.some(x => x !== 0) ? im : null);
};
B.poly = (a) => {
  const t = toT(a[0]); let r;
  if (t.dims[0] === t.dims[1] && t.dims[0] > 1) { const E = toT(B.eig([t])); r = { re: E.re, im: E.im || zerosArr(E.re.length) }; }
  else r = { re: t.re, im: t.im || zerosArr(t.re.length) };
  let cr = [1], ci = [0];
  for (let k = 0; k < r.re.length; k++) { const nr = cr.concat([0]), ni = ci.concat([0]); for (let j = 1; j < nr.length; j++) { const pr = cr[j - 1], pi = ci[j - 1]; nr[j] -= pr * r.re[k] - pi * r.im[k]; ni[j] -= pr * r.im[k] + pi * r.re[k]; } cr = nr; ci = ni; }
  return mk('double', [1, cr.length], cr, ci.some(x => Math.abs(x) > 1e-12) ? ci : null);
};
B.conv = (a) => {
  const u = toArr(a[0]), v = toArr(a[1]); if (!u.length || !v.length) return emptyD();
  const r = zerosArr(u.length + v.length - 1); for (let i = 0; i < u.length; i++) for (let j = 0; j < v.length; j++) r[i + j] += u[i] * v[j];
  let shape = a.length > 2 ? toStr(a[2]) : 'full';
  let res = r;
  if (shape === 'same') { const st = Math.floor(v.length / 2); res = r.slice(st, st + u.length); }
  else if (shape === 'valid') res = u.length >= v.length ? r.slice(v.length - 1, u.length) : [];
  const col = dimsOf(a[0])[1] === 1 && dimsOf(a[0])[0] > 1;
  return col ? mkCol(res) : mkRow(res);
};
B.deconv = (a, nout) => {
  const y = toArr(a[0]).slice(), d = toArr(a[1]); if (d[0] === 0) err('分母多项式首项不能为 0。');
  const nq = y.length - d.length + 1; if (nq < 1) return new MR([0, mkRow(y)]);
  const q = zerosArr(nq), r = y.slice();
  for (let i = 0; i < nq; i++) { q[i] = r[i] / d[0]; for (let j = 0; j < d.length; j++) r[i + j] -= q[i] * d[j]; }
  for (let i = 0; i < nq; i++) r[i] = 0;
  return nout > 1 ? new MR([mkRow(q), mkRow(r)]) : mkRow(q);
};
B.polyder = (a) => { const p = toArr(a[0]); const n = p.length - 1; if (n < 1) return 0; const r = []; for (let i = 0; i < n; i++) r.push(p[i] * (n - i)); return mkRow(r); };
B.polyint = (a) => { const p = toArr(a[0]); const k = a.length > 1 ? toNum(a[1]) : 0; const n = p.length; const r = []; for (let i = 0; i < n; i++) r.push(p[i] / (n - i)); r.push(k); return mkRow(r); };
// cubic spline (not-a-knot) coefficients
function splineCoefs(x, y) {
  const n = x.length;
  if (n === 2) return { b: [(y[1] - y[0]) / (x[1] - x[0])], c: [0], d: [0] };
  if (n === 3) { // parabola through 3 points (MATLAB not-a-knot with 3 points)
    const h0 = x[1] - x[0], h1 = x[2] - x[1]; const d0 = (y[1] - y[0]) / h0, d1 = (y[2] - y[1]) / h1; const c2 = (d1 - d0) / (h0 + h1);
    const b0 = d0 - c2 * h0; return { b: [b0, b0 + 2 * c2 * h0], c: [c2, c2], d: [0, 0] };
  }
  const h = []; for (let i = 0; i < n - 1; i++) h.push(x[i + 1] - x[i]);
  // solve for second-derivative-like c (M_i/2) with not-a-knot: full system n x n
  const A = zerosArr(n * n), rhs = zerosArr(n);
  for (let i = 1; i < n - 1; i++) { A[i + (i - 1) * n] = h[i - 1]; A[i + i * n] = 2 * (h[i - 1] + h[i]); A[i + (i + 1) * n] = h[i]; rhs[i] = 3 * ((y[i + 1] - y[i]) / h[i] - (y[i] - y[i - 1]) / h[i - 1]); }
  A[0] = h[1]; A[0 + 1 * n] = -(h[0] + h[1]); A[0 + 2 * n] = h[0];
  A[(n - 1) + (n - 3) * n] = h[n - 2]; A[(n - 1) + (n - 2) * n] = -(h[n - 3] + h[n - 2]); A[(n - 1) + (n - 1) * n] = h[n - 3];
  const LU = A.slice(); const f = luDecomp(LU, n); const c = luSolve(LU, n, f.piv, rhs, 1);
  const b = [], d = [];
  for (let i = 0; i < n - 1; i++) { b.push((y[i + 1] - y[i]) / h[i] - h[i] * (2 * c[i] + c[i + 1]) / 3); d.push((c[i + 1] - c[i]) / (3 * h[i])); }
  return { b, c: c.slice(0, n - 1), d };
}
function interpCore(x, y, xi, method, extrap) {
  const n = x.length; const out = new Array(xi.length);
  let order = x.map((v, i) => i); if (n > 1 && x[1] < x[0]) { order.reverse(); x = order.map(i => x[i]); y = order.map(i => y[i]); }
  let sp = null; if (method === 'spline' || method === 'pchip' || method === 'cubic') sp = splineCoefs(x, y);
  for (let k = 0; k < xi.length; k++) {
    const v = xi[k];
    if (v !== v) { out[k] = NaN; continue; }
    const outside = v < x[0] || v > x[n - 1];
    if (outside && !sp && extrap === undefined) { out[k] = NaN; continue; }
    if (outside && extrap !== undefined && extrap !== 'extrap') { out[k] = extrap; continue; }
    let lo = 0, hi = n - 2; while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (x[mid] <= v) lo = mid; else hi = mid - 1; }
    let i = Math.max(0, Math.min(lo, n - 2));
    if (method === 'nearest') { out[k] = (v - x[i] < x[i + 1] - v) ? y[i] : y[i + 1]; continue; }
    if (method === 'previous') { out[k] = v >= x[i + 1] ? y[i + 1] : y[i]; continue; }
    if (method === 'next') { out[k] = v <= x[i] ? y[i] : y[i + 1]; continue; }
    if (sp) { const dx = v - x[i]; out[k] = y[i] + dx * (sp.b[i] + dx * (sp.c[i] + dx * sp.d[i])); continue; }
    const t = (v - x[i]) / (x[i + 1] - x[i]); out[k] = y[i] + t * (y[i + 1] - y[i]);
  }
  return out;
}
B.interp1 = (a) => {
  let x, y, xi, rest;
  if (a.length === 2 || (a.length >= 3 && isStringy(a[2]))) { y = toArr(a[0]); x = y.map((v, i) => i + 1); xi = a[1]; rest = a.slice(2); }
  else { x = toArr(a[0]); y = a[1]; xi = a[2]; rest = a.slice(3); }
  let method = 'linear', extrap;
  for (const r of rest) { if (isStringy(r)) { const s = toStr(r).toLowerCase(); if (s === 'extrap') extrap = 'extrap'; else method = s.replace(/^\*/, ''); } else extrap = toNum(r); }
  if (method === 'linear' && extrap === 'extrap') method = 'linear';
  const xiT = toT(xi);
  const Y = toT(y);
  if (isVecDims(Y.dims)) {
    let res = interpCore(x.slice(), Y.re.slice(), xiT.re, method, extrap);
    if (extrap === 'extrap' && method === 'linear') { const n = x.length; res = res.map((v, k) => { const q = xiT.re[k]; if (q < x[0]) return Y.re[0] + (q - x[0]) * (Y.re[1] - Y.re[0]) / (x[1] - x[0]); if (q > x[n - 1]) return Y.re[n - 1] + (q - x[n - 1]) * (Y.re[n - 1] - Y.re[n - 2]) / (x[n - 1] - x[n - 2]); return v; }); }
    return mk('double', xiT.dims.slice(), res);
  }
  const R = Y.dims[0], C = Y.dims[1]; const nq = xiT.re.length; const out = new Array(nq * C);
  for (let c = 0; c < C; c++) { const col = Y.re.slice(c * R, (c + 1) * R); const r = interpCore(x.slice(), col, xiT.re, method, extrap); for (let k = 0; k < nq; k++) out[k + c * nq] = r[k]; }
  return mkMat(nq, C, out);
};
B.spline = (a) => { const x = toArr(a[0]), y = toArr(a[1]); const xi = toT(a[2]); return mk('double', xi.dims.slice(), interpCore(x.slice(), y.slice(), xi.re, 'spline')); };
B.pchip = B.spline;
function getOpt(opts, name, def) { if (!(opts instanceof MStruct)) return def; const v = opts.data[0][name]; if (v === undefined || numelOf(v) === 0) return def; return v; }
B.optimset = (a) => { const o = Object.create(null); const fields = []; for (let i = 0; i + 1 < a.length; i += 2) { const k = toStr(a[i]); fields.push(k); o[k] = a[i + 1]; } return new MStruct([1, 1], fields, [o]); };
B.odeset = B.optimset; B.optimoptions = (a) => B.optimset(a.slice(1));
B.fzero = (a, nout) => {
  const f = fnScalar(a[0]); const x0 = toArr(a[1]);
  const tolx = toNum(getOpt(a[2], 'TolX', 2.220446049250313e-16));
  let lo, hi, flo, fhi;
  if (x0.length >= 2) { lo = x0[0]; hi = x0[1]; flo = f(lo); fhi = f(hi); if (flo * fhi > 0) err('fzero: 区间端点处的函数值必须具有不同的符号。', 'MATLAB:fzero:ValuesAtEndPtsSameSign'); }
  else {
    const x = x0[0]; const fx = f(x); if (fx === 0) return nout > 1 ? new MR([x, 0, 1]) : x;
    let dx = x === 0 ? 0.02 : Math.abs(x) * 0.02; let found = false;
    for (let k = 0; k < 200; k++) {
      lo = x - dx; hi = x + dx; flo = f(lo); fhi = f(hi);
      if (flo * fx <= 0) { hi = x; fhi = fx; found = true; break; }
      if (fhi * fx <= 0) { lo = x; flo = fx; found = true; break; }
      if (flo * fhi <= 0) { found = true; break; }
      dx *= Math.SQRT2;
      if (!isFinite(flo) || !isFinite(fhi)) break;
    }
    if (!found) err('fzero: 在搜索区间内未找到变号点，无法求零点。', 'MATLAB:fzero:NoSignChange');
  }
  // Brent's method
  let a1 = lo, b1 = hi, fa = flo, fb = fhi, c = a1, fc = fa, d = b1 - a1, e = d;
  for (let it = 0; it < 200; it++) {
    if ((fb > 0 && fc > 0) || (fb < 0 && fc < 0)) { c = a1; fc = fa; d = b1 - a1; e = d; }
    if (Math.abs(fc) < Math.abs(fb)) { a1 = b1; b1 = c; c = a1; fa = fb; fb = fc; fc = fa; }
    const tol = 2 * 2.220446049250313e-16 * Math.abs(b1) + 0.5 * tolx; const m = 0.5 * (c - b1);
    if (Math.abs(m) <= tol || fb === 0) break;
    if (Math.abs(e) >= tol && Math.abs(fa) > Math.abs(fb)) {
      let p, q, r; const s = fb / fa;
      if (a1 === c) { p = 2 * m * s; q = 1 - s; } else { q = fa / fc; r = fb / fc; p = s * (2 * m * q * (q - r) - (b1 - a1) * (r - 1)); q = (q - 1) * (r - 1) * (s - 1); }
      if (p > 0) q = -q; else p = -p;
      if (2 * p < Math.min(3 * m * q - Math.abs(tol * q), Math.abs(e * q))) { e = d; d = p / q; } else { d = m; e = m; }
    } else { d = m; e = m; }
    a1 = b1; fa = fb; b1 += Math.abs(d) > tol ? d : (m > 0 ? tol : -tol); fb = f(b1);
  }
  return nout > 1 ? new MR([b1, fb, 1]) : b1;
};
B.fminbnd = (a, nout) => {
  const f = fnScalar(a[0]); let lo = toNum(a[1]), hi = toNum(a[2]); const g = (Math.sqrt(5) - 1) / 2;
  let c = hi - g * (hi - lo), d = lo + g * (hi - lo), fc = f(c), fd = f(d);
  for (let it = 0; it < 200 && Math.abs(hi - lo) > 1e-10 * (1 + Math.abs(c)); it++) { if (fc < fd) { hi = d; d = c; fd = fc; c = hi - g * (hi - lo); fc = f(c); } else { lo = c; c = d; fc = fd; d = lo + g * (hi - lo); fd = f(d); } }
  const x = (lo + hi) / 2; return nout > 1 ? new MR([x, f(x)]) : x;
};
B.fminsearch = (a, nout) => {
  const fv = a[0]; const x0 = toT(a[1]); const n = x0.re.length; const shape = x0.dims.slice();
  const opts = a[2];
  const tolx = toNum(getOpt(opts, 'TolX', 1e-4)), tolf = toNum(getOpt(opts, 'TolFun', 1e-4));
  const maxIter = toNum(getOpt(opts, 'MaxIter', 200 * n)), maxFun = toNum(getOpt(opts, 'MaxFunEvals', 200 * n));
  let nf = 0;
  const F = (x) => { nf++; return toNum(callFn1(fv, [mk('double', shape.slice(), x.slice())])); };
  const simplex = [x0.re.slice()];
  for (let i = 0; i < n; i++) { const p = x0.re.slice(); p[i] = p[i] !== 0 ? 1.05 * p[i] : 0.00025; simplex.push(p); }
  let fs = simplex.map(F);
  let it = 0;
  const sortS = () => { const idx = fs.map((v, i) => i).sort((i, j) => fs[i] - fs[j]); const s2 = idx.map(i => simplex[i]), f2 = idx.map(i => fs[i]); for (let i = 0; i <= n; i++) { simplex[i] = s2[i]; fs[i] = f2[i]; } };
  sortS();
  while (it < maxIter && nf < maxFun) {
    let maxdx = 0, maxdf = 0;
    for (let i = 1; i <= n; i++) { maxdf = Math.max(maxdf, Math.abs(fs[i] - fs[0])); for (let j = 0; j < n; j++) maxdx = Math.max(maxdx, Math.abs(simplex[i][j] - simplex[0][j])); }
    if (maxdx <= tolx && maxdf <= tolf) break;
    it++;
    const xbar = zerosArr(n); for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) xbar[j] += simplex[i][j] / n;
    const xr = xbar.map((v, j) => 2 * v - simplex[n][j]); const fr = F(xr);
    if (fr < fs[0]) {
      const xe = xbar.map((v, j) => 3 * v - 2 * simplex[n][j]); const fe = F(xe);
      if (fe < fr) { simplex[n] = xe; fs[n] = fe; } else { simplex[n] = xr; fs[n] = fr; }
    } else if (fr < fs[n - 1]) { simplex[n] = xr; fs[n] = fr; }
    else {
      let shrink = false;
      if (fr < fs[n]) { const xc = xbar.map((v, j) => 1.5 * v - 0.5 * simplex[n][j]); const fc = F(xc); if (fc <= fr) { simplex[n] = xc; fs[n] = fc; } else shrink = true; }
      else { const xcc = xbar.map((v, j) => 0.5 * v + 0.5 * simplex[n][j]); const fcc = F(xcc); if (fcc < fs[n]) { simplex[n] = xcc; fs[n] = fcc; } else shrink = true; }
      if (shrink) for (let i = 1; i <= n; i++) { simplex[i] = simplex[i].map((v, j) => simplex[0][j] + 0.5 * (v - simplex[0][j])); fs[i] = F(simplex[i]); }
    }
    sortS();
  }
  const x = mk('double', shape, simplex[0].slice());
  return nout > 1 ? new MR([x, fs[0], it < maxIter && nf < maxFun ? 1 : 0]) : x;
};
function adaptiveIntegrate(f, a, b, tol) {
  // Gauss-Kronrod 7-15 adaptive
  const xgk = [0.991455371120812639, 0.949107912342758525, 0.864864423359769073, 0.741531185599394440, 0.586087235467691130, 0.405845151377397167, 0.207784955007898468, 0];
  const wgk = [0.022935322010529225, 0.063092092629978553, 0.104790010322250184, 0.140653259715525919, 0.169004726639267903, 0.190350578064785410, 0.204432940075298892, 0.209482141084727828];
  const wg = [0.129484966168869693, 0.279705391489276668, 0.381830050505118945, 0.417959183673469388];
  function gk(lo, hi) {
    const c = (lo + hi) / 2, h = (hi - lo) / 2; const fc = f(c); let rk = fc * wgk[7], rg = fc * wg[3];
    for (let j = 0; j < 7; j++) { const dx = h * xgk[j]; const s = f(c - dx) + f(c + dx); rk += wgk[j] * s; if (j % 2 === 1) rg += wg[(j - 1) / 2] * s; }
    return [rk * h, Math.abs((rk - rg) * h)];
  }
  let infTrans = null;
  if (!isFinite(a) || !isFinite(b)) { // transform x = t/(1-t^2)
    const g = f; const A = a, Bb = b;
    f = (t) => { const x = t / (1 - t * t); const dx = (1 + t * t) / ((1 - t * t) * (1 - t * t)); const v = g(x) * dx; return isFinite(v) ? v : 0; };
    a = A === -Infinity ? -1 : (A === Infinity ? 1 : solveT(A)); b = Bb === Infinity ? 1 : (Bb === -Infinity ? -1 : solveT(Bb));
    function solveT(x) { if (x === 0) return 0; return (-1 + Math.sqrt(1 + 4 * x * x)) / (2 * x); }
  }
  const stack = [[a, b]]; let total = 0, errSum = 0, count = 0;
  const segs = []; const [r0, e0] = gk(a, b); segs.push({ lo: a, hi: b, r: r0, e: e0 });
  total = r0; errSum = e0;
  while (errSum > Math.max(tol.abs, tol.rel * Math.abs(total)) && count < 2000) {
    // split segment with largest error
    let mi = 0; for (let i = 1; i < segs.length; i++) if (segs[i].e > segs[mi].e) mi = i;
    const s = segs[mi]; const mid = (s.lo + s.hi) / 2;
    const [r1, e1] = gk(s.lo, mid), [r2, e2] = gk(mid, s.hi);
    segs.splice(mi, 1, { lo: s.lo, hi: mid, r: r1, e: e1 }, { lo: mid, hi: s.hi, r: r2, e: e2 });
    total = 0; errSum = 0; for (const g of segs) { total += g.r; errSum += g.e; }
    count++;
  }
  return total;
}
B.integral = (a) => {
  const fv = a[0]; const lo = toNum(a[1]), hi = toNum(a[2]);
  let rel = 1e-6, abs = 1e-10, arrayValued = false;
  for (let i = 3; i + 1 < a.length; i += 2) { const k = toStr(a[i]).toLowerCase(); if (k === 'reltol') rel = toNum(a[i + 1]); else if (k === 'abstol') abs = toNum(a[i + 1]); else if (k === 'arrayvalued') arrayValued = truthy(a[i + 1]); }
  return adaptiveIntegrate(fnScalar(fv), lo, hi, { rel, abs });
};
B.quad = B.quadgk = B.quadl = (a) => { const r = adaptiveIntegrate(fnScalar(a[0]), toNum(a[1]), toNum(a[2]), { rel: 1e-8, abs: a.length > 3 && numelOf(a[3]) ? toNum(a[3]) : 1e-10 }); return r; };
B.integral2 = (a) => {
  const fv = a[0]; const xa = toNum(a[1]), xb = toNum(a[2]);
  const yaF = a[3] instanceof FHandle ? (x) => toNum(callFn1(a[3], [x])) : () => toNum(a[3]);
  const ybF = a[4] instanceof FHandle ? (x) => toNum(callFn1(a[4], [x])) : () => toNum(a[4]);
  return adaptiveIntegrate((x) => adaptiveIntegrate((y) => toNum(callFn1(fv, [x, y])), yaF(x), ybF(x), { rel: 1e-8, abs: 1e-10 }), xa, xb, { rel: 1e-6, abs: 1e-10 });
};
// ODE: Dormand-Prince 5(4)
function odeSolve(a, nout, method) {
  const fv = a[0]; const tspan = toArr(a[1]); const y0T = toT(a[2]); const opts = a[3];
  const n = y0T.re.length;
  const rtol = toNum(getOpt(opts, 'RelTol', 1e-3)), atol = toArr(getOpt(opts, 'AbsTol', 1e-6));
  const atolOf = i => (atol.length > 1 ? atol[i] : atol[0]);
  const maxStepOpt = getOpt(opts, 'MaxStep', null); const initStep = getOpt(opts, 'InitialStep', null);
  const t0 = tspan[0], tf = tspan[tspan.length - 1]; const dir = tf >= t0 ? 1 : -1;
  const ydim = y0T.dims.slice();
  const F = (t, y) => { const r = callFn1(fv, [t, mk('double', [n, 1], y.slice())]); const arr = toArr(r); if (arr.length !== n) err('ODE 函数返回的向量长度 (' + arr.length + ') 与初始条件长度 (' + n + ') 不一致。'); return arr.slice(); };
  const C = [0, 1 / 5, 3 / 10, 4 / 5, 8 / 9, 1, 1];
  const A = [[], [1 / 5], [3 / 40, 9 / 40], [44 / 45, -56 / 15, 32 / 9], [19372 / 6561, -25360 / 2187, 64448 / 6561, -212 / 729], [9017 / 3168, -355 / 33, 46732 / 5247, 49 / 176, -5103 / 18656], [35 / 384, 0, 500 / 1113, 125 / 192, -2187 / 6784, 11 / 84]];
  const Bh = [35 / 384, 0, 500 / 1113, 125 / 192, -2187 / 6784, 11 / 84, 0];
  const E = [71 / 57600, 0, -71 / 16695, 71 / 1920, -17253 / 339200, 22 / 525, -1 / 40];
  let t = t0, y = y0T.re.slice(); let f0 = F(t, y);
  const span = Math.abs(tf - t0); const hmax = maxStepOpt ? toNum(maxStepOpt) : span / 10;
  let h;
  if (initStep) h = toNum(initStep);
  else { let nrm = 0; for (let i = 0; i < n; i++) nrm = Math.max(nrm, Math.abs(f0[i]) / Math.max(Math.abs(y[i]), atolOf(i) / rtol)); h = Math.min(hmax, span); const rh = nrm / (0.8 * Math.pow(rtol, 0.2)); if (h * rh > 1) h = 1 / rh; h = Math.max(h, 16 * 2.2e-16 * Math.abs(t)); }
  const T = [t0], Y = [y.slice()];
  const outT = tspan.length > 2 ? tspan : null; let outIdx = 1;
  const refine = 4;
  let steps = 0;
  while (dir * (tf - t) > 0) {
    if (++steps > 200000) err('ode45：步数过多，积分未完成。');
    if (ST && ++ST.steps > ST.nextCheck) stepLimit();
    if (h > hmax) h = hmax;
    if (1.1 * h >= Math.abs(tf - t)) h = Math.abs(tf - t);
    const hs = dir * h;
    const K = [f0];
    for (let s = 1; s < 7; s++) { const yt = y.slice(); for (let j = 0; j < s; j++) { const c = A[s][j]; if (c) for (let i = 0; i < n; i++) yt[i] += hs * c * K[j][i]; } K.push(F(t + C[s] * hs, yt)); }
    const ynew = y.slice(); for (let s = 0; s < 7; s++) if (Bh[s]) for (let i = 0; i < n; i++) ynew[i] += hs * Bh[s] * K[s][i];
    let errn = 0;
    for (let i = 0; i < n; i++) { let e = 0; for (let s = 0; s < 7; s++) e += E[s] * K[s][i]; e *= hs; const sc = Math.max(Math.abs(y[i]), Math.abs(ynew[i]), atolOf(i) / rtol) * rtol; errn = Math.max(errn, Math.abs(e) / Math.max(sc, 1e-300) * rtol / rtol); }
    errn = errn; // already relative to tolerance scale
    if (errn <= 1) {
      const tnew = t + hs; const fnew = K[6];
      // dense output via cubic Hermite
      const herm = (s) => { const s2 = s * s, s3 = s2 * s; const h00 = 2 * s3 - 3 * s2 + 1, h10 = s3 - 2 * s2 + s, h01 = -2 * s3 + 3 * s2, h11 = s3 - s2; const r = new Array(n); for (let i = 0; i < n; i++) r[i] = h00 * y[i] + h10 * hs * f0[i] + h01 * ynew[i] + h11 * hs * fnew[i]; return r; };
      if (outT) { while (outIdx < outT.length && dir * (outT[outIdx] - tnew) <= 0) { const s = (outT[outIdx] - t) / hs; T.push(outT[outIdx]); Y.push(outIdx === outT.length - 1 && Math.abs(outT[outIdx] - tnew) < 1e-12 * Math.max(1, Math.abs(tnew)) ? ynew.slice() : herm(s)); outIdx++; } }
      else { for (let r = 1; r < refine; r++) { const s = r / refine; T.push(t + s * hs); Y.push(herm(s)); } T.push(tnew); Y.push(ynew.slice()); }
      t = tnew; y = ynew; f0 = fnew;
      const fac = errn === 0 ? 5 : Math.min(5, 0.9 * Math.pow(errn, -0.2)); h = h * Math.max(fac, 0.2);
    } else {
      h = h * Math.max(0.1, 0.9 * Math.pow(errn, -0.2));
      if (h < 16 * 2.2e-16 * Math.abs(t)) err('ode45：步长过小，无法满足积分容差（t = ' + t + '）。');
    }
  }
  const m = T.length; const Yre = new Array(m * n); for (let k = 0; k < m; k++) for (let i = 0; i < n; i++) Yre[k + i * m] = Y[k][i];
  if (nout <= 1) { // solution struct
    return scalarStruct({ solver: mkStr(method), x: mkRow(T), y: mkMat(n, m, transposeArr(Yre, m, n)) }, ['solver', 'x', 'y']);
  }
  return new MR([mkCol(T), mkMat(m, n, Yre)]);
}
function transposeArr(a, r, c) { const o = new Array(r * c); for (let i = 0; i < r; i++) for (let j = 0; j < c; j++) o[j + i * c] = a[i + j * r]; return o; }
B.ode45 = (a, nout) => odeSolve(a, nout, 'ode45');
B.ode23 = (a, nout) => odeSolve(a, nout, 'ode23');
B.ode113 = (a, nout) => odeSolve(a, nout, 'ode113');
B.ode15s = (a, nout) => odeSolve(a, nout, 'ode15s');
B.deval = (a) => { const sol = a[0]; const xi = toT(a[1]); const x = toArr(getField(sol, 'x')); const Y = toT(getField(sol, 'y')); const n = Y.dims[0], m = Y.dims[1]; const out = new Array(n * xi.re.length); for (let i = 0; i < n; i++) { const row = []; for (let k = 0; k < m; k++) row.push(Y.re[i + k * n]); const r = interpCore(x.slice(), row, xi.re, 'linear'); for (let k = 0; k < r.length; k++) out[i + k * n] = r[k]; } return mkMat(n, xi.re.length, out); };

// ======================================================================
// Strings
// ======================================================================
function parseNumStr(s) {
  s = String(s).trim(); if (s === '') return NaN;
  const low = s.toLowerCase();
  if (low === 'inf' || low === '+inf') return Infinity; if (low === '-inf') return -Infinity; if (low === 'nan') return NaN;
  if (/^[+-]?(\d+\.?\d*|\.\d+)([eEdD][+-]?\d+)?$/.test(s)) return parseFloat(s.replace(/[dD]/, 'e'));
  if (/^[+-]?\d{1,3}(,\d{3})+(\.\d*)?$/.test(s)) return parseFloat(s.replace(/,/g, ''));
  return NaN;
}
function cellOfStrings(v) { // char/string/cellstr -> array of JS strings
  if (v instanceof MCell) return v.data.map(x => toStr(x));
  if (v instanceof MString) return v.data.slice();
  if (isChar(v)) return v.dims[0] > 1 ? charRowsToStrings(v) : [toStr(v)];
  err('参数必须为字符向量、字符串数组或字符向量元胞数组。');
}
// wrap result of per-string op with same container type as input
function strMap(v, fn) {
  if (v instanceof MCell) return new MCell(v.dims.slice(), v.data.map(x => mkStr(fn(toStr(x)))));
  if (v instanceof MString) return new MString(v.dims.slice(), v.data.map(fn));
  if (isChar(v) && v.dims[0] > 1) return charMatrix(charRowsToStrings(v).map(fn));
  return mkStr(fn(toStr(v)));
}
function strPred(v, fn) { // returns logical with container shape
  if (v instanceof MCell) return mk('logical', v.dims.slice(), v.data.map(x => (fn(toStr(x)) ? 1 : 0)));
  if (v instanceof MString) return mk('logical', v.dims.slice(), v.data.map(x => (fn(x) ? 1 : 0)));
  return fn(toStr(v));
}
function num2strVal(v, fmtArg) {
  if (isChar(v)) return v;
  if (v instanceof MString) return mkStr(v.data[0]);
  if (fmtArg !== undefined) {
    if (isStringy(fmtArg)) { const t = toT(v); const R = t.dims[0] || 1, C = t.re.length / R; const rows = []; for (let i = 0; i < R; i++) { let s = ''; for (let j = 0; j < C; j++) s += doSprintf(toStr(fmtArg), [t.re[i + j * R]]); rows.push(s); } return rows.length === 1 ? mkStr(rows[0]) : charMatrix(rows); }
    const prec = toNum(fmtArg); const t = toT(v); return mkStr(t.re.map(x => cfmtG(x, prec, false)).join('  '));
  }
  const t = toT(v);
  if (t.re.length === 0) return mkStr('');
  const R = t.dims[0], C = t.re.length / R;
  const fmtOne = (x, i) => {
    if (t.im) { const re = x, im = t.im[i]; return numStrScalar(re) + (im < 0 ? '-' : '+') + numStrScalar(Math.abs(im)) + 'i'; }
    return numStrScalar(x, t.cls);
  };
  if (t.re.length === 1) return mkStr(fmtOne(t.re[0], 0));
  // matrix
  const allInt = t.re.every(x => !isFinite(x) || Number.isInteger(x)) || t.cls === 'logical' || isIntCls(t.cls);
  let strs;
  if (allInt) strs = t.re.map(x => (isFinite(x) ? String(x) : nonFiniteStr(x)));
  else {
    let mx = 0; for (const x of t.re) if (isFinite(x)) mx = Math.max(mx, Math.abs(x));
    const nd = Math.max(Math.floor(Math.log10(mx || 1)) + 5, 5);
    strs = t.re.map(x => (isFinite(x) ? cfmtG(x, nd, false) : nonFiniteStr(x)));
  }
  let w = 0; for (const s of strs) w = Math.max(w, s.length);
  const rows = [];
  for (let i = 0; i < R; i++) { let s = ''; for (let j = 0; j < C; j++) s += padL(strs[i + j * R], w + 2); rows.push(s); }
  // strip common leading whitespace
  let lead = Infinity; for (const r of rows) lead = Math.min(lead, r.match(/^ */)[0].length);
  const out = rows.map(r => r.slice(lead).replace(/\s+$/, ''));
  return out.length === 1 ? mkStr(out[0]) : charMatrix(out);
}
function numStrScalar(x, cls) {
  if (!isFinite(x)) return nonFiniteStr(x);
  if (Number.isInteger(x) || isIntCls(cls)) return String(x);
  const nd = Math.max(Math.floor(Math.log10(Math.abs(x))) + 5, 5);
  return cfmtG(x, Math.min(nd, 16), false);
}
B.num2str = (a) => { nargchk(a, 1, 2, 'num2str'); return num2strVal(a[0], a[1]); };
B.int2str = (a) => num2strVal(B.round([a[0]]));
B.str2double = (a) => {
  const v = a[0];
  if (v instanceof MCell) return mk('double', v.dims.slice(), v.data.map(x => (isStringy(x) ? parseNumStr(toStr(x)) : NaN)));
  if (v instanceof MString) return mk('double', v.dims.slice(), v.data.map(parseNumStr));
  if (!isChar(v)) return NaN;
  return parseNumStr(toStr(v));
};
B.str2num = (a, nout) => {
  const s = toStr(a[0]);
  try { const r = evalString('__str2num_tmp__ = [' + s + '];', ST.frame, true); const v = ST.frame.vars.__str2num_tmp__; delete ST.frame.vars.__str2num_tmp__; return nout > 1 ? new MR([v, true]) : v; }
  catch (e) { if (!(e instanceof MLError)) throw e; return nout > 1 ? new MR([emptyD(), false]) : emptyD(); }
};
B.sprintf = (a) => { nargchk(a, 1, undefined, 'sprintf'); const f = a[0] instanceof MString ? a[0].data[0] : toStr(a[0], '格式'); const s = doSprintf(f, a.slice(1)); return a[0] instanceof MString ? new MString([1, 1], [s]) : mkStr(s); };
B.fprintf = (a, nout) => {
  let fid = 1, args = a;
  if (a.length && isTensorLike(a[0]) && !isChar(a[0]) && numelOf(a[0]) === 1 && a.length >= 1 && (a.length > 1 || true)) {
    if (a.length === 1) { fid = 1; args = [mkStr('%g\n'), a[0]]; if (true) { out(doSprintf('%s', [num2strVal(a[0])])); return undefined; } }
    else { fid = toNum(a[0]); args = a.slice(1); }
  }
  if (!args.length) return undefined;
  const fmt = args[0] instanceof MString ? args[0].data[0] : toStr(args[0], '格式');
  const s = doSprintf(fmt, args.slice(1));
  if (fid === 2) errOut(s); else if (fid === 1) out(s); else err('无效的文件标识符。在线环境仅支持 1 (stdout) 和 2 (stderr)。', 'MATLAB:FileIO:InvalidFid');
  return nout > 0 ? s.length : undefined;
};
B.printf = (a) => B.fprintf(a, 0);
B.puts = B.fputs = B.fdisp = (a) => { const v = a.length > 1 ? a[1] : a[0]; if (isStringy(v)) out(toStr(v)); else out(dispText(v)); };
B.disp = (a) => { nargchk(a, 1, 1, 'disp'); out(dispText(a[0])); };
B.display = (a) => { out(displayText(ST.dispName || 'ans', a[0])); };
B.mat2str = (a) => {
  const v = a[0]; const prec = a.length > 1 ? toNum(a[1]) : 15;
  if (isChar(v)) { const rows = charRowsToStrings(v); return mkStr(rows.length === 1 ? "'" + rows[0] + "'" : '[' + rows.map(r => "'" + r + "'").join(';') + ']'); }
  const t = toT(v); const R = t.dims[0], C = t.dims[1];
  const f = (x, i) => { let s = isFinite(x) ? cfmtG(x, prec, false) : nonFiniteStr(x); if (t.im) { const y = t.im[i]; s += (y < 0 ? '-' : '+') + (isFinite(y) ? cfmtG(Math.abs(y), prec, false) : 'Inf') + 'i'; } return t.cls === 'logical' ? (x ? 'true' : 'false') : s; };
  if (t.re.length === 1) return mkStr(f(t.re[0], 0));
  const rows = []; for (let i = 0; i < R; i++) { const r = []; for (let j = 0; j < C; j++) r.push(f(t.re[i + j * R], i + j * R)); rows.push(r.join(' ')); }
  return mkStr('[' + rows.join(';') + ']');
};
B.strcat = (a) => {
  if (a.some(x => x instanceof MCell)) {
    const n = Math.max(...a.map(x => (x instanceof MCell ? x.data.length : 1))); const dims = a.find(x => x instanceof MCell).dims.slice();
    const res = []; for (let i = 0; i < n; i++) res.push(mkStr(a.map(x => (x instanceof MCell ? toStr(x.data[x.data.length === 1 ? 0 : i]) : toStr(x))).join('')));
    return new MCell(dims, res);
  }
  if (a.some(x => x instanceof MString)) return new MString([1, 1], [a.map(x => toStr(x)).join('')]);
  return mkStr(a.map(x => (isChar(x) ? toStr(x).replace(/[ \t\n]+$/, '') : toStr(x))).join(''));
};
B.strvcat = (a) => charMatrix(a.flatMap(x => cellOfStrings(x)).filter(s => s.length));
B.strsplit = (a) => {
  const s = toStr(a[0]); let delims = a.length > 1 ? cellOfStrings(a[1]) : [' ', '\f', '\n', '\r', '\t', '\v'];
  delims = delims.map(d => processEscapes(d));
  let collapse = true; for (let i = 2; i + 1 < a.length; i += 2) if (toStr(a[i]).toLowerCase() === 'collapsedelimiters') collapse = truthy(a[i + 1]);
  const re = new RegExp('(?:' + delims.map(escRe).join('|') + ')' + (collapse ? '+' : ''), 'g');
  return mkCellRow(s.split(re).map(mkStr));
};
function escRe(s) { return s.replace(/[.*+?^${}()|[\]\\\/]/g, '\\$&'); }
B.strjoin = (a) => { const c = cellOfStrings(a[0]); const d = a.length > 1 ? processEscapes(toStr(a[1])) : ' '; return mkStr(c.join(d)); };
B.join = (a) => { const c = cellOfStrings(a[0]); const d = a.length > 1 ? toStr(a[1]) : ' '; return a[0] instanceof MString ? new MString([1, 1], [c.join(d)]) : mkStr(c.join(d)); };
B.strrep = (a) => { const f = toStr(a[1]), r = toStr(a[2]); return strMap(a[0], s => (f === '' ? s : s.split(f).join(r))); };
B.replace = B.strrep;
B.erase = (a) => { const f = cellOfStrings(a[1]); return strMap(a[0], s => { for (const x of f) s = s.split(x).join(''); return s; }); };
B.strtrim = (a) => strMap(a[0], s => s.replace(/^[\s\0]+|[\s\0]+$/g, ''));
B.deblank = (a) => strMap(a[0], s => s.replace(/[\s\0]+$/g, ''));
B.upper = (a) => strMap(a[0], s => s.toUpperCase());
B.lower = (a) => strMap(a[0], s => s.toLowerCase());
B.fliplr_str = null; delete B.fliplr_str;
function strCompare(a, fn) {
  const x = a[0], y = a[1];
  const isS = v => isChar(v) && v.dims[0] <= 1 || (v instanceof MString && v.data.length === 1);
  if ((x instanceof MCell || (x instanceof MString && x.data.length !== 1)) || (y instanceof MCell || (y instanceof MString && y.data.length !== 1))) {
    const A = x instanceof MCell || x instanceof MString ? x : null, Bv = y instanceof MCell || y instanceof MString ? y : null;
    const ref = A || Bv; const n = (ref.data).length;
    const get = (v, i) => { if (v instanceof MCell) { const e = v.data[v.data.length === 1 ? 0 : i]; return isStringy(e) ? toStr(e) : null; } if (v instanceof MString) return v.data[v.data.length === 1 ? 0 : i]; return isS(v) ? toStr(v) : null; };
    const res = []; for (let i = 0; i < n; i++) { const p = get(x, i), q = get(y, i); res.push(p !== null && q !== null && fn(p, q) ? 1 : 0); }
    return mk('logical', ref.dims.slice(), res);
  }
  if (!isS(x) || !isS(y)) { if (isChar(x) && isChar(y)) return fn(charRowsToStrings(x).join('\n'), charRowsToStrings(y).join('\n')) && sameDims(x.dims, y.dims); return false; }
  return fn(toStr(x), toStr(y));
}
B.strcmp = (a) => { nargchk(a, 2, 2, 'strcmp'); return strCompare(a, (p, q) => p === q); };
B.strcmpi = (a) => strCompare(a, (p, q) => p.toLowerCase() === q.toLowerCase());
B.strncmp = (a) => { const n = toNum(a[2]); return strCompare(a, (p, q) => p.length >= n && q.length >= n && p.slice(0, n) === q.slice(0, n)); };
B.strncmpi = (a) => { const n = toNum(a[2]); return strCompare(a, (p, q) => p.length >= n && q.length >= n && p.slice(0, n).toLowerCase() === q.slice(0, n).toLowerCase()); };
function patOpts(a, start) { let ic = false; for (let i = start; i + 1 < a.length; i += 2) if (toStr(a[i]).toLowerCase() === 'ignorecase') ic = truthy(a[i + 1]); return ic; }
B.contains = (a) => { const pats = cellOfStrings(a[1]); const ic = patOpts(a, 2); return strPred(a[0], s => pats.some(p => (ic ? s.toLowerCase().includes(p.toLowerCase()) : s.includes(p)))); };
B.startsWith = (a) => { const pats = cellOfStrings(a[1]); const ic = patOpts(a, 2); return strPred(a[0], s => pats.some(p => (ic ? s.toLowerCase().startsWith(p.toLowerCase()) : s.startsWith(p)))); };
B.endsWith = (a) => { const pats = cellOfStrings(a[1]); const ic = patOpts(a, 2); return strPred(a[0], s => pats.some(p => (ic ? s.toLowerCase().endsWith(p.toLowerCase()) : s.endsWith(p)))); };
B.strfind = (a) => {
  const pat = toStr(a[1]);
  const find = (s) => { const r = []; if (pat.length === 0) return new Tensor('double', [1, 0], []); for (let i = s.indexOf(pat); i >= 0; i = s.indexOf(pat, i + 1)) r.push(i + 1); return r.length ? mkRow(r) : new Tensor('double', [1, 0], []); };
  if (a[0] instanceof MCell) return new MCell(a[0].dims.slice(), a[0].data.map(x => find(toStr(x))));
  return find(toStr(a[0]));
};
B.strtok = (a, nout) => {
  const s = toStr(a[0]); const d = a.length > 1 ? toStr(a[1]) : ' \t\n\v\f\r\0';
  let i = 0; while (i < s.length && d.includes(s[i])) i++; let j = i; while (j < s.length && !d.includes(s[j])) j++;
  return nout > 1 ? new MR([mkStr(s.slice(i, j)), mkStr(s.slice(j))]) : mkStr(s.slice(i, j));
};
B.strlength = (a) => { const v = a[0]; if (v instanceof MCell || v instanceof MString) return mk('double', v.dims.slice(), cellOfStrings(v).map(s => s.length)); return toStr(v).length; };
B.extractAfter = (a) => { const p = a[1]; return strMap(a[0], s => { if (isStringy(p)) { const k = s.indexOf(toStr(p)); return k < 0 ? '' : s.slice(k + toStr(p).length); } return s.slice(toNum(p)); }); };
B.extractBefore = (a) => { const p = a[1]; return strMap(a[0], s => { if (isStringy(p)) { const k = s.indexOf(toStr(p)); return k < 0 ? '' : s.slice(0, k); } return s.slice(0, toNum(p) - 1); }); };
B.extractBetween = (a) => { const p = toStr(a[1]), q = toStr(a[2]); return strMap(a[0], s => { const i = s.indexOf(p); if (i < 0) return ''; const j = s.indexOf(q, i + p.length); return j < 0 ? '' : s.slice(i + p.length, j); }); };
B.split = (a) => { const s = toStr(a[0]); const d = a.length > 1 ? cellOfStrings(a[1]) : [' ']; const parts = s.split(new RegExp(d.map(escRe).join('|'))); return a[0] instanceof MString ? new MString([parts.length, 1], parts) : new MCell([parts.length, 1], parts.map(mkStr)); };
B.pad = (a) => { const n = a.length > 1 && !isStringy(a[1]) ? toNum(a[1]) : null; const strs = cellOfStrings(a[0]); const w = n || Math.max(...strs.map(s => s.length)); return strMap(a[0], s => padR(s, w)); };
B.count = (a) => { const pats = cellOfStrings(a[1]); const cnt = (str) => { let c = 0; for (const p of pats) { if (!p) continue; let i = str.indexOf(p); while (i >= 0) { c++; i = str.indexOf(p, i + p.length); } } return c; }; const v = a[0]; if (v instanceof MCell || (v instanceof MString && v.data.length !== 1)) return mk('double', v.dims.slice(), cellOfStrings(v).map(cnt)); return cnt(toStr(v)); };
B.reverse = (a) => strMap(a[0], s => s.split('').reverse().join(''));
B.isspace = (a) => { const t = toT(a[0]); return mk('logical', t.dims.slice(), t.re.map(c => (c === 32 || (c >= 9 && c <= 13) ? 1 : 0))); };
B.isletter = (a) => { if (!isChar(a[0])) return mk('logical', dimsOf(a[0]).slice(), zerosArr(numelOf(a[0]))); const t = a[0]; return mk('logical', t.dims.slice(), t.re.map(c => (/\p{L}/u.test(String.fromCharCode(c)) ? 1 : 0))); };
B.isdigit = (a) => { const t = toT(a[0]); return mk('logical', t.dims.slice(), t.re.map(c => (c >= 48 && c <= 57 ? 1 : 0))); };
B.isstrprop = (a) => {
  const t = toT(a[0]); const p = toStr(a[1]);
  const tests = { alpha: c => /\p{L}/u.test(c), digit: c => /[0-9]/.test(c), alphanum: c => /[\p{L}0-9]/u.test(c), wspace: c => /\s/.test(c), upper: c => /\p{Lu}/u.test(c), lower: c => /\p{Ll}/u.test(c), punct: c => /[!-\/:-@\[-`{-~]/.test(c), cntrl: c => c.charCodeAt(0) < 32, xdigit: c => /[0-9a-fA-F]/.test(c) };
  const f = tests[p]; if (!f) err("isstrprop：未知类别 '" + p + "'。");
  return mk('logical', t.dims.slice(), t.re.map(c => (f(String.fromCharCode(c)) ? 1 : 0)));
};
B.blanks = (a) => mkStr(' '.repeat(toNum(a[0])));
B.newline = () => mkStr('\n');
B.string = (a) => {
  if (!a.length) return new MString([1, 1], ['']);
  const v = a[0];
  if (v instanceof MString) return v;
  if (isChar(v)) return v.dims[0] > 1 ? new MString([v.dims[0], 1], charRowsToStrings(v)) : new MString([1, 1], [toStr(v)]);
  if (v instanceof MCell) return new MString(v.dims.slice(), v.data.map(x => (isStringy(x) ? toStr(x) : fmtG(toNum(x)))));
  const t = toT(v); return new MString(t.dims.slice(), t.re.map(x => (t.cls === 'logical' ? (x ? 'true' : 'false') : numStrScalar(x))));
};
B.strings = (a) => { const { dims } = parseDimsArgs(a); return new MString(dims, new Array(prodDims(dims)).fill('')); };
B.cellstr = (a) => { const v = a[0]; if (v instanceof MCell) return v; if (v instanceof MString) return new MCell(v.dims.slice(), v.data.map(mkStr)); return mkCellCol(cellOfStrings(v).map(s => mkStr(s.replace(/\s+$/, '')))); };
B.dec2bin = (a) => { const t = toT(a[0]); const n = a.length > 1 ? toNum(a[1]) : 0; const strs = t.re.map(x => Math.round(x).toString(2)); const w = Math.max(n, ...strs.map(s => s.length)); const rows = strs.map(s => s.padStart(w, '0')); return rows.length === 1 ? mkStr(rows[0]) : charMatrix(rows); };
B.bin2dec = (a) => { const s = cellOfStrings(a[0]).map(x => parseInt(x.replace(/\s/g, ''), 2)); return s.length === 1 ? s[0] : mkCol(s); };
B.dec2hex = (a) => { const t = toT(a[0]); const n = a.length > 1 ? toNum(a[1]) : 0; const rows = t.re.map(x => Math.round(x).toString(16).toUpperCase().padStart(n, '0')); return rows.length === 1 ? mkStr(rows[0]) : charMatrix(rows); };
B.hex2dec = (a) => { const s = cellOfStrings(a[0]).map(x => parseInt(x, 16)); return s.length === 1 ? s[0] : mkCol(s); };
B.dec2base = (a) => mkStr(Math.round(toNum(a[0])).toString(toNum(a[1])).toUpperCase());
B.base2dec = (a) => parseInt(toStr(a[0]), toNum(a[1]));
B.fliplr && 0;
// ---- regular expressions ----
function convertRegex(pat) {
  // MATLAB regex -> JS: (?<name>...) same; \< \> word boundaries; (?i) not supported in JS -> flag
  let flags = '';
  if (pat.startsWith('(?i)')) { pat = pat.slice(4); flags += 'i'; }
  pat = pat.replace(/\\<|\\>/g, '\\b');
  return { pat, flags };
}
function regexpImpl(a, nout, forceIC) {
  nargchk(a, 2, undefined, 'regexp');
  const strIn = a[0], patIn = a[1];
  if (strIn instanceof MCell || (strIn instanceof MString && strIn.data.length > 1)) {
    const strs = cellOfStrings(strIn); const results = strs.map(s => regexpImpl([mkStr(s), ...a.slice(1)], nout, forceIC));
    const k = Math.max(nout, 1); const outs = [];
    for (let i = 0; i < k; i++) outs.push(new MCell(dimsOf(strIn).slice(), results.map(r => (r instanceof MR ? r.v[i] : r))));
    return k === 1 ? outs[0] : new MR(outs);
  }
  const str = toStr(strIn); const cv = convertRegex(toStr(patIn));
  let once = false, ic = forceIC, sel = [];
  for (let i = 2; i < a.length; i++) {
    const o = toStr(a[i]).toLowerCase();
    if (o === 'once') once = true; else if (o === 'ignorecase') ic = true; else if (o === 'matchcase') ic = false;
    else if (['match', 'tokens', 'names', 'start', 'end', 'split', 'tokenextents'].includes(o)) sel.push(o);
    else if (o === 'lineanchors' || o === 'dotall' || o === 'dotexceptnewline' || o === 'freespacing' || o === 'emptymatch' || o === 'noemptymatch') { if (o === 'lineanchors') cv.flags += 'm'; if (o === 'dotall') cv.flags += 's'; }
    else err("regexp：无效的选项 '" + o + "'。");
  }
  let re;
  try { re = new RegExp(cv.pat, 'g' + (ic ? 'i' : '') + cv.flags.replace('i', '') + 'u'); }
  catch (e) { try { re = new RegExp(cv.pat, 'g' + (ic ? 'i' : '') + cv.flags.replace('i', '')); } catch (e2) { err('正则表达式无效：' + e2.message); } }
  const matches = []; let m;
  while ((m = re.exec(str)) !== null) { matches.push(m); if (m[0].length === 0) re.lastIndex++; if (once) break; }
  const order = sel.length ? sel : ['start', 'end', 'tokenextents', 'match', 'tokens', 'names', 'split'];
  const build = (what) => {
    switch (what) {
      case 'start': return once ? (matches.length ? matches[0].index + 1 : emptyD()) : (matches.length ? mkRow(matches.map(x => x.index + 1)) : new Tensor('double', [1, 0], []));
      case 'end': return once ? (matches.length ? matches[0].index + matches[0][0].length : emptyD()) : (matches.length ? mkRow(matches.map(x => x.index + x[0].length)) : new Tensor('double', [1, 0], []));
      case 'match': return once ? (matches.length ? mkStr(matches[0][0]) : mkStr('')) : (matches.length ? mkCellRow(matches.map(x => mkStr(x[0]))) : new MCell([1, 0], []));
      case 'tokens': {
        const tk = (x) => { const toks = x.length > 1 ? x.slice(1).map(t => mkStr(t === undefined ? '' : t)) : [mkStr(x[0])]; return mkCellRow(toks); };
        return once ? (matches.length ? tk(matches[0]) : new MCell([1, 0], [])) : (matches.length ? mkCellRow(matches.map(tk)) : new MCell([1, 0], []));
      }
      case 'names': {
        const names = []; const nre = /\(\?<([A-Za-z]\w*)>/g; let q; while ((q = nre.exec(cv.pat))) names.push(q[1]);
        if (!matches.length) return names.length ? new MStruct([0, 0], names, []) : new MStruct([1, 1], [], [Object.create(null)]);
        const ms = once ? [matches[0]] : matches;
        const data = ms.map(x => { const o = Object.create(null); for (const nm of names) o[nm] = mkStr((x.groups && x.groups[nm]) || ''); return o; });
        return new MStruct([1, data.length], names, data);
      }
      case 'split': { const parts = []; let last = 0; for (const x of matches) { parts.push(mkStr(str.slice(last, x.index))); last = x.index + x[0].length; } parts.push(mkStr(str.slice(last))); return mkCellRow(parts); }
      case 'tokenextents': { const te = (x) => { const r = []; let pos = x.index; for (let k = 1; k < x.length; k++) { const t = x[k] || ''; const i = str.indexOf(t, pos); r.push(i + 1, i + t.length); } return mkMat(r.length / 2, 2, r.length ? [...r.filter((_, i) => i % 2 === 0), ...r.filter((_, i) => i % 2 === 1)] : []); }; return once ? (matches.length ? te(matches[0]) : emptyD()) : mkCellRow(matches.map(te)); }
    }
  };
  const k = Math.max(nout, 1); const outs = [];
  for (let i = 0; i < k && i < order.length; i++) outs.push(build(order[i]));
  return k === 1 ? outs[0] : new MR(outs);
}
B.regexp = (a, nout) => regexpImpl(a, nout, false);
B.regexpi = (a, nout) => regexpImpl(a, nout, true);
B.regexprep = (a) => {
  const cv = convertRegex(toStr(a[1]));
  let rep = toStr(a[2]).replace(/\$0/g, '$$&').replace(/\$\{(\w+)\}/g, '$<$1>');
  rep = processEscapes(rep.replace(/\\\$/g, '$$$$'));
  let ic = false, once = false;
  for (let i = 3; i < a.length; i++) { const o = toStr(a[i]).toLowerCase(); if (o === 'ignorecase') ic = true; if (o === 'once') once = true; }
  let re; try { re = new RegExp(cv.pat, (once ? '' : 'g') + (ic || cv.flags.includes('i') ? 'i' : '')); } catch (e) { err('正则表达式无效：' + e.message); }
  return strMap(a[0], s => s.replace(re, rep));
};
B.validatestring = (a) => { const s = toStr(a[0]); const opts = cellOfStrings(a[1]); const m = opts.find(o => o.toLowerCase().startsWith(s.toLowerCase())); if (!m) err("'" + s + "' 与以下任何有效值都不匹配：" + opts.join(', ')); return mkStr(m); };

// ======================================================================
// Cells & structs
// ======================================================================
B.cell = (a) => { const { dims } = parseDimsArgs(a); const n = prodDims(dims); const data = new Array(n); for (let i = 0; i < n; i++) data[i] = emptyD(); return new MCell(dims, data); };
B.struct = (a) => {
  if (a.length === 0) return new MStruct([1, 1], [], [Object.create(null)]);
  if (a.length % 2) err('struct 的输入参数必须为字段名/值对。', 'MATLAB:struct:InvalidArgs');
  const fields = [], vals = [];
  for (let i = 0; i < a.length; i += 2) { const f = toStr(a[i], '字段名'); if (!/^[A-Za-z]\w*$/.test(f)) err("无效的字段名称 '" + f + "'。"); fields.push(f); vals.push(a[i + 1]); }
  let n = 1, dims = [1, 1];
  for (const v of vals) if (v instanceof MCell && v.data.length !== 1) { n = v.data.length; dims = v.dims.slice(); break; }
  const data = [];
  for (let k = 0; k < n; k++) { const o = Object.create(null); fields.forEach((f, i) => { const v = vals[i]; o[f] = markShared(v instanceof MCell ? (v.data.length === 1 ? v.data[0] : v.data[k]) : v); }); data.push(o); }
  if (n === 0) return new MStruct(dims, fields, []);
  return new MStruct(dims, fields, data);
};
B.fieldnames = (a) => { const s = a[0]; if (s instanceof MapObj) return mkCellCol(['Count', 'KeyType', 'ValueType'].map(mkStr)); if (!(s instanceof MStruct)) err('fieldnames 的输入必须为结构体。'); return mkCellCol(s.fields.map(mkStr)); };
B.isfield = (a) => {
  const s = a[0]; if (!(s instanceof MStruct)) return a[1] instanceof MCell ? mk('logical', a[1].dims.slice(), zerosArr(a[1].data.length)) : false;
  if (a[1] instanceof MCell) return mk('logical', a[1].dims.slice(), a[1].data.map(x => (isStringy(x) && s.fields.includes(toStr(x)) ? 1 : 0)));
  return isStringy(a[1]) && s.fields.includes(toStr(a[1]));
};
B.rmfield = (a) => {
  const s = copyValue(a[0]); const names = cellOfStrings(a[1]);
  for (const n of names) { if (!s.fields.includes(n)) err("无法删除不存在的字段 '" + n + "'。"); s.fields = s.fields.filter(f => f !== n); for (const o of s.data) delete o[n]; }
  return s;
};
B.setfield = (a) => { const s = a[0] instanceof MStruct ? copyValue(a[0]) : new MStruct([1, 1], [], [Object.create(null)]); const f = toStr(a[1]); if (!s.fields.includes(f)) { s.fields.push(f); for (const o of s.data) o[f] = emptyD(); } s.data[0][f] = markShared(a[2]); return s; };
B.getfield = (a) => { const s = a[0]; const f = toStr(a[1]); return fieldGet(s, f)[0]; };
B.orderfields = (a) => { const s = copyValue(a[0]); s.fields.sort(); return s; };
B.struct2cell = (a) => { const s = a[0]; return new MCell([s.fields.length, 1], s.fields.map(f => markShared(s.data[0][f]))); };
B.cell2struct = (a) => {
  const c = a[0]; const f = cellOfStrings(a[1]); const dim = a.length > 2 ? toNum(a[2]) : 1;
  if (dim === 1 && (c.dims[1] === 1 || c.data.length === f.length)) { const o = Object.create(null); f.forEach((n, i) => (o[n] = markShared(c.data[i]))); return new MStruct([1, 1], f, [o]); }
  // dim 2: each row a struct
  const R = c.dims[0]; const data = []; for (let r = 0; r < R; r++) { const o = Object.create(null); f.forEach((n, j) => (o[n] = markShared(c.data[r + j * R]))); data.push(o); }
  return new MStruct([R, 1], f, data);
};
B.num2cell = (a) => { const v = a[0]; if (v instanceof MCell) return new MCell(v.dims.slice(), v.data.map(x => new MCell([1, 1], [x]))); const t = toT(v); const d = t.dims.slice(); const data = []; for (let i = 0; i < t.re.length; i++) data.push(mk(t.cls, [1, 1], [t.re[i]], t.im ? [t.im[i]] : null)); return new MCell(d, data); };
B.cell2mat = (a) => {
  const c = a[0]; if (!(c instanceof MCell)) err('cell2mat 的输入必须为元胞数组。');
  if (c.data.length === 0) return emptyD();
  const R = c.dims[0], C = c.data.length / R; const rows = [];
  for (let i = 0; i < R; i++) { const items = []; for (let j = 0; j < C; j++) items.push(c.data[i + j * R]); rows.push(catGeneric(2, items)); }
  return rows.length === 1 ? rows[0] : catGeneric(1, rows);
};
B.deal = (a, nout) => { const n = Math.max(nout, 1); if (a.length === 1) return new MR(new Array(n).fill(a[0])); if (a.length !== n) err('输入参数的数目必须与输出参数的数目相同（或为 1）。'); return new MR(a.slice()); };
function parseUniform(a, start) {
  let uniform = true, errHandler = null; const rest = [];
  for (let i = start; i < a.length; i++) {
    if (isStringy(a[i]) && i + 1 < a.length) { const k = toStr(a[i]).toLowerCase(); if (k === 'uniformoutput') { uniform = truthy(a[i + 1]); i++; continue; } if (k === 'errorhandler') { errHandler = a[i + 1]; i++; continue; } }
    rest.push(a[i]);
  }
  return { uniform, rest, errHandler };
}
function funApply(fv, n, getArgs, nout, uniform, dims, name) {
  const k = Math.max(nout, 1);
  const results = []; for (let j = 0; j < k; j++) results.push(new Array(n));
  for (let i = 0; i < n; i++) {
    const r = callFn(fv, getArgs(i), nout === 0 ? (uniform ? 1 : 1) : k);
    if (nout === 0 && r.length === 0) { results.length = 0; continue; }
    if (r.length < k) err(name + '：函数返回的输出参数不足。');
    for (let j = 0; j < k; j++) {
      const v = r[j];
      if (uniform) { if (!(isTensorLike(v) && numelOf(v) === 1)) err(name + "：函数的返回值必须为标量，否则请设置 'UniformOutput' 为 false。", 'MATLAB:' + name + ':NotAScalarOutput'); }
      results[j][i] = v;
    }
  }
  if (results.length === 0) return undefined;
  const outs = results.map(arr => {
    if (!uniform) return new MCell(dims.slice(), arr.map(markShared));
    if (n === 0) return new Tensor('double', dims.slice(), []);
    const cls = arr.every(v => typeof v === 'boolean' || classOf(v) === 'logical') ? 'logical' : (arr.find(v => classOf(v) !== 'double' && classOf(v) !== 'logical') ? classOf(arr.find(v => classOf(v) !== 'double' && classOf(v) !== 'logical')) : 'double');
    const re = arr.map(v => toT(v).re[0]); const anyIm = arr.some(v => v instanceof Tensor && v.im);
    return mk(cls === 'char' ? 'char' : cls, dims.slice(), re, anyIm ? arr.map(v => (v instanceof Tensor && v.im ? v.im[0] : 0)) : null);
  });
  return outs.length === 1 ? outs[0] : new MR(outs);
}
B.cellfun = (a, nout) => {
  nargchk(a, 2, undefined, 'cellfun');
  let fv = a[0]; const { uniform, rest } = parseUniform(a, 1);
  if (isStringy(fv)) { const nm = toStr(fv); const legacy = { isempty: c => numelOf(c) === 0, length: c => B.length([c]), numel: numelOf, isreal: c => !(c instanceof Tensor && c.im), islogical: c => classOf(c) === 'logical', isclass: null, ndims: c => dimsOf(c).length, prodofsize: numelOf };
    if (legacy[nm]) { const c = rest[0]; return mk(nm.startsWith('is') ? 'logical' : 'double', c.dims.slice(), c.data.map(x => +legacy[nm](x))); }
    fv = new FHandle({ kind: 'named', name: nm, ctx: ST.frame.ctx, parentFrame: ST.frame });
  }
  for (const c of rest) if (!(c instanceof MCell)) err('cellfun 的输入必须为元胞数组。', 'MATLAB:cellfun:NotACell');
  const n = rest[0].data.length;
  for (const c of rest) if (c.data.length !== n) err('cellfun：所有输入元胞数组的大小必须相同。');
  return funApply(fv, n, i => rest.map(c => c.data[i]), nout, uniform, rest[0].dims, 'cellfun');
};
B.arrayfun = (a, nout) => {
  nargchk(a, 2, undefined, 'arrayfun');
  const fv = a[0]; const { uniform, rest } = parseUniform(a, 1);
  const n = numelOf(rest[0]);
  const elem = (v, i) => { if (v instanceof MStruct) return gather(v, [i], [1, 1]); if (v instanceof MCell) return new MCell([1, 1], [v.data[i]]); if (v instanceof MString) return new MString([1, 1], [v.data[i]]); return indexValue(v, [i + 1]); };
  for (const v of rest) if (numelOf(v) !== n) err('arrayfun：所有输入数组的大小必须相同。');
  return funApply(fv, n, i => rest.map(v => elem(v, i)), nout, uniform, dimsOf(rest[0]), 'arrayfun');
};
B.structfun = (a, nout) => {
  const fv = a[0]; const { uniform, rest } = parseUniform(a, 1); const s = rest[0];
  const n = s.fields.length;
  const r = funApply(fv, n, i => [s.data[0][s.fields[i]]], nout, uniform, [n, 1], 'structfun');
  if (!uniform && r instanceof MCell) { const o = Object.create(null); s.fields.forEach((f, i) => (o[f] = r.data[i])); return new MStruct([1, 1], s.fields.slice(), [o]); }
  return r;
};
// ---- containers.Map ----
function mapKey(m, k) {
  if (m.kt === 'char' || m.kt === 'string') { if (!isStringy(k)) err('指定的键类型与此容器所需的类型不匹配。', 'MATLAB:Containers:TypeMismatch'); return toStr(k); }
  if (!isTensorLike(k) || numelOf(k) !== 1) err('指定的键类型与此容器所需的类型不匹配。', 'MATLAB:Containers:TypeMismatch');
  return toNum(k);
}
function newMap(args) {
  let kt = 'char', vt = 'any', keys = null, vals = null, uniform = true;
  let i = 0;
  if (args.length && !(isStringy(args[0]) && ['KeyType', 'ValueType', 'UniformValues'].includes(toStr(args[0])))) { keys = args[0]; vals = args[1]; i = 2; }
  for (; i + 1 < args.length; i += 2) { const k = toStr(args[i]); if (k === 'KeyType') kt = toStr(args[i + 1]); else if (k === 'ValueType') vt = toStr(args[i + 1]); else if (k === 'UniformValues') uniform = truthy(args[i + 1]); }
  if (keys !== null) {
    const kl = keys instanceof MCell ? keys.data : (isStringy(keys) ? [keys] : toArr(keys).map(x => x));
    if (kl.length && !isStringy(kl[0])) kt = kt === 'char' ? 'double' : kt;
    const vl = keys instanceof MCell || (!isStringy(keys) && numelOf(keys) > 1) ? (vals instanceof MCell ? vals.data : toArr(vals).map(x => x)) : [vals];
    if (kl.length !== vl.length) err('键的数目和值的数目必须相同。', 'MATLAB:Containers:Map:KeyValueNumberMismatch');
    const m = new MapObj(kt, vt);
    kl.forEach((k, j) => m.map.set(mapKey(m, k), markShared(vl[j])));
    if (vl.length && vl.every(v => typeof v === 'number') && vt === 'any') m.vt = 'any';
    return m;
  }
  return new MapObj(kt, vt);
}
function mapGet(m, args) {
  if (args.length !== 1) err('containers.Map 只支持一个键作为索引。');
  const k = mapKey(m, args[0]);
  if (!m.map.has(k)) err("指定的键 '" + k + "' 不存在。", 'MATLAB:Containers:Map:NoKey');
  return m.map.get(k);
}
function mapSet(m, args, v) { if (args.length !== 1) err('containers.Map 只支持一个键作为索引。'); m.map.set(mapKey(m, args[0]), markShared(v)); }
function sortedKeys(m) { const ks = Array.from(m.map.keys()); if (m.kt === 'char' || m.kt === 'string') ks.sort((x, y) => (x < y ? -1 : x > y ? 1 : 0)); else ks.sort((x, y) => x - y); return ks; }
B.keys = (a) => { const m = a[0]; if (!(m instanceof MapObj)) err('keys 的输入必须为 containers.Map。'); return mkCellRow(sortedKeys(m).map(k => (typeof k === 'string' ? mkStr(k) : k))); };
B.values = (a) => {
  const m = a[0]; if (!(m instanceof MapObj)) err('values 的输入必须为 containers.Map。');
  if (a.length > 1) { const ks = a[1].data; return mkCellRow(ks.map(k => mapGet(m, [k]))); }
  return mkCellRow(sortedKeys(m).map(k => m.map.get(k)));
};
B.isKey = (a) => { const m = a[0]; if (a[1] instanceof MCell) return mk('logical', a[1].dims.slice(), a[1].data.map(k => (m.map.has(mapKey(m, k)) ? 1 : 0))); return m.map.has(mapKey(m, a[1])); };
B.remove = (a) => { const m = a[0]; const ks = a[1] instanceof MCell ? a[1].data : [a[1]]; for (const k of ks) { const kk = mapKey(m, k); if (!m.map.has(kk)) err("指定的键 '" + kk + "' 不存在。", 'MATLAB:Containers:Map:NoKey'); m.map.delete(kk); } return m; };

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

// ======================================================================
// Plotting state -> figSpec (no rendering here)
// ======================================================================
const COLOR_ORDER = [[0, 0.4470, 0.7410], [0.8500, 0.3250, 0.0980], [0.9290, 0.6940, 0.1250], [0.4940, 0.1840, 0.5560], [0.4660, 0.6740, 0.1880], [0.3010, 0.7450, 0.9330], [0.6350, 0.0780, 0.1840]];
const COLOR_LETTERS = { r: [1, 0, 0], g: [0, 1, 0], b: [0, 0, 1], c: [0, 1, 1], m: [1, 0, 1], y: [1, 1, 0], k: [0, 0, 0], w: [1, 1, 1] };
const COLOR_NAMES = { red: 'r', green: 'g', blue: 'b', cyan: 'c', magenta: 'm', yellow: 'y', black: 'k', white: 'w' };
const MARKERS = { o: 'o', '+': '+', '*': '*', '.': '.', x: 'x', s: 's', d: 'd', '^': '^', v: 'v', '<': '<', '>': '>', p: 'p', h: 'h' };
function newFig(id) { return { id, name: '', axes: [], cur: -1, sgtitle: null, dirty: true, emitted: false, colormap: 'parula' }; }
function newAxes(sub) {
  return { subplot: sub, title: '', xlabel: '', ylabel: '', zlabel: '', grid: false, box: true, hold: false, legend: null, legendLocation: 'northeast', legendShow: false,
    xlim: null, ylim: null, zlim: null, axis: 'auto', view: null, is3d: false, colormap: null, colorbar: false, xscale: 'linear', yscale: 'linear', series: [], ci: 0, caxis: null, extra: {} };
}
function curFig(create) {
  if (create === undefined) create = true;
  let f = ST.figs.get(ST.curFig);
  if (!f && create) { const id = ST.curFig || 1; f = newFig(id); ST.figs.set(id, f); ST.curFig = id; }
  return f;
}
function gcaObj() {
  const f = curFig(); f.dirty = true;
  if (f.cur < 0 || !f.axes[f.cur]) { f.axes.push(newAxes(null)); f.cur = f.axes.length - 1; }
  return f.axes[f.cur];
}
function prepAxes() { // for high-level plotting commands
  const ax = gcaObj();
  if (!ax.hold) { ax.series = []; ax.ci = 0; ax.legend = null; ax.legendShow = false; ax.is3d = false; ax.view = null; ax.xscale = 'linear'; ax.yscale = 'linear'; ax.colorbar = ax.colorbar && false; }
  return ax;
}
function nextColor(ax) { const c = COLOR_ORDER[ax.ci % COLOR_ORDER.length]; ax.ci++; return c.slice(); }
function jnum(x) { if (x !== x) return null; if (x === Infinity) return 'Inf'; if (x === -Infinity) return '-Inf'; return x; }
function jarr(v) { const t = toT(v); return t.re.map(jnum); }
function jmat(v) { const t = toT(v); const R = t.dims[0], C = prodDims(t.dims) / (R || 1); const out = []; for (let i = 0; i < R; i++) { const row = new Array(C); for (let j = 0; j < C; j++) row[j] = jnum(t.re[i + j * R]); out.push(row); } return out; }
function parseLineSpec(s) {
  if (typeof s !== 'string' || s.length === 0 || s.length > 6) return null;
  let i = 0; const r = { color: null, lineStyle: null, marker: null };
  while (i < s.length) {
    const c = s[i], c2 = s.substr(i, 2);
    if (c2 === '--' || c2 === '-.') { if (r.lineStyle) return null; r.lineStyle = c2; i += 2; continue; }
    if (c === '-' || c === ':') { if (r.lineStyle) return null; r.lineStyle = c; i++; continue; }
    if (COLOR_LETTERS[c]) { if (r.color) return null; r.color = COLOR_LETTERS[c].slice(); i++; continue; }
    if (MARKERS[c]) { if (r.marker) return null; r.marker = MARKERS[c]; i++; continue; }
    return null;
  }
  return r;
}
function parseColor(v) {
  if (isStringy(v)) { let s = toStr(v).toLowerCase(); if (COLOR_NAMES[s]) s = COLOR_NAMES[s]; if (COLOR_LETTERS[s]) return COLOR_LETTERS[s].slice(); if (s === 'none') return null; if (/^#[0-9a-f]{6}$/.test(s)) return [1, 3, 5].map(k => parseInt(s.substr(k, 2), 16) / 255); err("无效的颜色 '" + s + "'。"); }
  const t = toArr(v); if (t.length === 3) return t.slice(); err('颜色必须为 RGB 三元组或颜色名称。');
}
const PROP_MAP = { linewidth: 'lineWidth', color: 'color', markersize: 'markerSize', displayname: 'displayName', linestyle: 'lineStyle', marker: 'marker', markerfacecolor: 'markerFaceColor', markeredgecolor: 'markerEdgeColor', facealpha: 'faceAlpha', edgecolor: 'edgeColor', facecolor: 'faceColor', barwidth: 'barWidth', edgealpha: 'edgeAlpha', fontsize: 'fontSize', horizontalalignment: 'horizontalAlignment', autoscale: 'autoScale', maxheadsize: 'maxHeadSize', levellist: 'levels', linespec: 'lineSpec', normalization: 'normalization', binwidth: 'binWidth', numbins: 'numBins', binedges: 'binEdges', showtext: 'showText', alignvertexcenters: null, cdata: 'c', sizedata: 'sizes', colormap: null, labels: 'labels' };
function applyProps(series, props) {
  for (const [k, v] of props) {
    const key = PROP_MAP[k.toLowerCase()];
    if (key === undefined) continue; if (key === null) continue;
    if (key === 'color' || key === 'markerFaceColor' || key === 'markerEdgeColor' || key === 'edgeColor' || key === 'faceColor') {
      if (isStringy(v) && ['flat', 'interp', 'auto', 'none'].includes(toStr(v).toLowerCase())) { if (key === 'color') series.color = null; else series.extra[key] = toStr(v).toLowerCase(); continue; }
      const c = parseColor(v); if (key === 'color') series.color = c; else if (key === 'edgeColor') series.edgeColor = c; else if (key === 'faceColor') { series.color = c; series.extra.faceColor = c; } else series.extra[key] = c;
    } else if (key === 'lineWidth' || key === 'markerSize' || key === 'faceAlpha' || key === 'barWidth' || key === 'fontSize') { const n = toNum(v); if (key === 'barWidth' || key === 'fontSize') series.extra[key] = n; else series[key] = n; }
    else if (key === 'displayName') series.displayName = toStr(v);
    else if (key === 'lineStyle') series.lineStyle = toStr(v);
    else if (key === 'marker') { const m = toStr(v).toLowerCase(); series.marker = { square: 's', diamond: 'd', circle: 'o', none: 'none' }[m] || m; }
    else series.extra[key] = isStringy(v) ? toStr(v) : (isTensorLike(v) ? (numelOf(v) === 1 ? toNum(v) : jarr(v)) : null);
  }
}
function splitProps(args, knownFlags) { // trailing Name/Value pairs
  const props = []; let end = args.length;
  for (let i = 0; i < args.length; i++) {
    if (isStringy(args[i]) && PROP_MAP[toStr(args[i]).toLowerCase()] !== undefined && i + 1 < args.length && !(parseLineSpec(toStr(args[i])) && i === args.length - 1)) { end = Math.min(end, i); }
  }
  for (let i = end; i + 1 < args.length; i += 2) props.push([toStr(args[i]), args[i + 1]]);
  return { main: args.slice(0, end), props };
}
function mkSeries(type, ax, o) {
  const s = { type, x: [], y: [], z: null, c: null, u: null, v: null, labels: null, color: null, lineStyle: '-', marker: 'none', lineWidth: 0.5, markerSize: 6, displayName: '', faceAlpha: 1, edgeColor: null, levels: null, text: null, extra: {} };
  Object.assign(s, o || {});
  s.handle = ++ST.handleCounter; ST.handles.set(s.handle, { kind: 'series', obj: s });
  ax.series.push(s);
  return s;
}
function isNumericArg(v) { return isTensorLike(v) && !isChar(v); }
function plotXY(a, type, nout) {
  const ax = prepAxes();
  const { main, props } = splitProps(a);
  const handles = [];
  let i = 0;
  while (i < main.length) {
    let x = main[i], y = null, spec = null;
    if (!isNumericArg(x)) err('plot：数据参数必须为数值。', 'MATLAB:plot:invalidData');
    if (i + 1 < main.length && isNumericArg(main[i + 1])) { y = main[i + 1]; i += 2; } else { y = x; x = null; i += 1; }
    if (i < main.length && isStringy(main[i])) { spec = parseLineSpec(toStr(main[i])); if (!spec) err("plot：无效的线型参数 '" + toStr(main[i]) + "'。"); i++; }
    let Y = toT(y);
    if (x === null && Y.im) { x = mk('double', Y.dims, Y.re.slice()); Y = mk('double', Y.dims, Y.im.slice()); Y = toT(Y); }
    let X = x === null ? null : toT(x);
    // columns
    const cols = [];
    const isVec = d => d.length === 2 && (d[0] === 1 || d[1] === 1);
    if (isVec(Y.dims) || Y.re.length <= 1) cols.push([X ? X.re : Y.re.map((_, k) => k + 1), Y.re]);
    else {
      const R = Y.dims[0], C = Y.dims[1];
      if (X && isVec(X.dims) && X.re.length !== R && X.re.length === C) { // rows are series
        for (let r = 0; r < R; r++) { const yy = []; for (let c = 0; c < C; c++) yy.push(Y.re[r + c * R]); cols.push([X.re, yy]); }
      } else for (let c = 0; c < C; c++) { const yy = Y.re.slice(c * R, (c + 1) * R); let xx; if (!X) xx = yy.map((_, k) => k + 1); else if (isVec(X.dims)) xx = X.re; else xx = X.re.slice(c * R, (c + 1) * R); cols.push([xx, yy]); }
    }
    if (X && isVec(Y.dims) && !isVec(X.dims) && X.re.length > 1) { cols.length = 0; const R = X.dims[0], C = X.dims[1]; for (let c = 0; c < C; c++) cols.push([X.re.slice(c * R, (c + 1) * R), Y.re]); }
    for (const [xx, yy] of cols) {
      if (xx.length !== yy.length) err('plot：向量长度必须相同（x 有 ' + xx.length + ' 个元素，y 有 ' + yy.length + ' 个）。', 'MATLAB:plot:XYLengthMismatch');
      const s = mkSeries(type || 'line', ax, { x: xx.map(jnum), y: yy.map(jnum) });
      s.color = spec && spec.color ? spec.color : nextColor(ax);
      if (spec) { if (spec.lineStyle) s.lineStyle = spec.lineStyle; else if (spec.marker) s.lineStyle = 'none'; if (spec.marker) s.marker = spec.marker; }
      applyProps(s, props);
      handles.push(s.handle);
    }
  }
  return nout > 0 ? (handles.length === 1 ? handles[0] : mkCol(handles)) : undefined;
}
B.plot = (a, nout) => { nargchk(a, 1, undefined, 'plot'); return plotXY(a, 'line', nout); };
B.line = (a, nout) => { const ax = gcaObj(); const h = ax.hold; ax.hold = true; const r = plotXY(a, 'line', nout); ax.hold = h; return r; };
B.semilogx = (a, nout) => { const r = plotXY(a, 'line', nout); const ax = gcaObj(); ax.xscale = 'log'; return r; };
B.semilogy = (a, nout) => { const r = plotXY(a, 'line', nout); const ax = gcaObj(); ax.yscale = 'log'; return r; };
B.loglog = (a, nout) => { const r = plotXY(a, 'line', nout); const ax = gcaObj(); ax.xscale = 'log'; ax.yscale = 'log'; return r; };
B.stairs = (a, nout) => plotXY(a, 'stairs', nout);
B.stem = (a, nout) => { const filled = a.some(x => isStringy(x) && toStr(x) === 'filled'); const r = plotXY(a.filter(x => !(isStringy(x) && toStr(x) === 'filled')), 'stem', nout); const ax = gcaObj(); for (const s of ax.series) if (s.type === 'stem') { if (s.marker === 'none') s.marker = 'o'; if (filled) s.extra.filled = true; } return r; };
B.area = (a, nout) => { const r = plotXY(a, 'area', nout); const ax = gcaObj(); for (const s of ax.series) if (s.type === 'area') { s.faceAlpha = s.faceAlpha; s.extra.baseValue = 0; } return r; };
B.plot3 = (a, nout) => {
  const ax = prepAxes(); const { main, props } = splitProps(a); let i = 0; const hs = [];
  while (i + 2 < main.length + 0 && i < main.length) {
    const X = toT(main[i]), Y = toT(main[i + 1]), Z = toT(main[i + 2]); i += 3; let spec = null;
    if (i < main.length && isStringy(main[i])) { spec = parseLineSpec(toStr(main[i])); i++; }
    const s = mkSeries('plot3', ax, { x: jarr(X), y: jarr(Y), z: jarr(Z) });
    s.color = spec && spec.color ? spec.color : nextColor(ax);
    if (spec) { if (spec.lineStyle) s.lineStyle = spec.lineStyle; else if (spec.marker) s.lineStyle = 'none'; if (spec.marker) s.marker = spec.marker; }
    applyProps(s, props); hs.push(s.handle);
  }
  ax.is3d = true; if (!ax.view) ax.view = [-37.5, 30];
  return nout > 0 ? hs[0] : undefined;
};
B.scatter = (a, nout) => {
  const ax = prepAxes(); let args = a.slice(); let filled = false;
  args = args.filter(x => { if (isStringy(x) && toStr(x) === 'filled') { filled = true; return false; } return true; });
  const { main, props } = splitProps(args);
  const X = toT(main[0]), Y = toT(main[1]);
  const s = mkSeries('scatter', ax, { x: jarr(X), y: jarr(Y), lineStyle: 'none', marker: 'o' });
  let k = 2;
  if (main.length > k && isNumericArg(main[k])) { const S = toT(main[k]); if (S.re.length === 1) s.markerSize = Math.sqrt(S.re[0]); else if (S.re.length) s.extra.sizes = S.re.map(v => Math.sqrt(v)); k++; }
  s.color = null;
  if (main.length > k && !(isStringy(main[k]) && parseLineSpec(toStr(main[k])) && !COLOR_LETTERS[toStr(main[k])])) {
    const C = main[k]; if (isStringy(C)) s.color = parseColor(C); else { const t = toT(C); if (t.re.length === 3 && !(t.dims[0] === X.re.length && t.dims[0] === 3 && false)) s.color = t.re.slice(); else s.c = jarr(t); } k++;
  }
  if (main.length > k && isStringy(main[k])) { const sp = parseLineSpec(toStr(main[k])); if (sp && sp.marker) s.marker = sp.marker; if (sp && sp.color) s.color = sp.color; }
  if (!s.color && !s.c) s.color = nextColor(ax);
  if (filled) s.extra.filled = true;
  applyProps(s, props);
  return nout > 0 ? s.handle : undefined;
};
B.scatter3 = (a, nout) => {
  const ax = prepAxes(); let filled = false; const args = a.filter(x => { if (isStringy(x) && toStr(x) === 'filled') { filled = true; return false; } return true; });
  const { main, props } = splitProps(args);
  const s = mkSeries('scatter3', ax, { x: jarr(main[0]), y: jarr(main[1]), z: jarr(main[2]), lineStyle: 'none', marker: 'o' });
  if (main.length > 3 && isNumericArg(main[3]) && numelOf(main[3])) { const S = toT(main[3]); if (S.re.length === 1) s.markerSize = Math.sqrt(S.re[0]); else s.extra.sizes = S.re.map(Math.sqrt); }
  if (main.length > 4) { const C = main[4]; if (isStringy(C)) s.color = parseColor(C); else { const t = toT(C); if (t.re.length === 3) s.color = t.re.slice(); else s.c = jarr(t); } }
  if (!s.color && !s.c) s.color = nextColor(ax);
  if (filled) s.extra.filled = true;
  applyProps(s, props); ax.is3d = true; if (!ax.view) ax.view = [-37.5, 30];
  return nout > 0 ? s.handle : undefined;
};
function barImpl(a, type, nout) {
  const ax = prepAxes(); let stacked = false;
  const args = a.filter(x => { if (isStringy(x)) { const s = toStr(x); if (s === 'stacked') { stacked = true; return false; } if (s === 'grouped' || s === 'hist' || s === 'histc') return false; } return true; });
  const { main, props } = splitProps(args);
  let X = null, Y, width = 0.8, color = null; let k = 0;
  if (main.length >= 2 && isNumericArg(main[1])) { X = toT(main[0]); Y = toT(main[1]); k = 2; } else { Y = toT(main[0]); k = 1; }
  if (main.length > k && isNumericArg(main[k])) { width = toNum(main[k]); k++; }
  if (main.length > k && isStringy(main[k])) { const sp = parseLineSpec(toStr(main[k])); if (sp && sp.color) color = sp.color; }
  const isVec = Y.dims[0] === 1 || Y.dims[1] === 1;
  const hs = [];
  if (isVec) {
    const xs = X ? X.re : Y.re.map((_, i) => i + 1);
    const s = mkSeries(type, ax, { x: xs.map(jnum), y: jarr(Y), extra: { barWidth: width } });
    s.color = color || nextColor(ax); applyProps(s, props); hs.push(s.handle);
  } else {
    const R = Y.dims[0], C = Y.dims[1]; const xs = X ? X.re : Array.from({ length: R }, (_, i) => i + 1);
    for (let c = 0; c < C; c++) {
      const s = mkSeries(type, ax, { x: xs.map(jnum), y: Y.re.slice(c * R, (c + 1) * R).map(jnum), extra: { barWidth: width, groupIndex: c, groupCount: C, stacked } });
      s.color = nextColor(ax); applyProps(s, props); hs.push(s.handle);
    }
  }
  return nout > 0 ? (hs.length === 1 ? hs[0] : mkRow(hs)) : undefined;
}
B.bar = (a, nout) => barImpl(a, 'bar', nout);
B.barh = (a, nout) => barImpl(a, 'barh', nout);
B.histogram = (a, nout) => {
  const ax = prepAxes(); const { main, props } = splitProps(a);
  const data = toArr(main[0]).filter(v => v === v);
  let edges = null; const pm = {}; for (const [k, v] of props) pm[k.toLowerCase()] = v;
  if (pm.binedges) edges = toArr(pm.binedges).slice();
  else if (main.length > 1 && numelOf(main[1]) > 1) edges = toArr(main[1]).slice();
  else if (pm.binwidth) { const w = toNum(pm.binwidth); let lo = Math.min(...data), hi = Math.max(...data); const st = Math.floor(lo / w) * w; edges = []; for (let v = st; v <= hi + w * 1e-9 || edges.length < 2; v += w) { edges.push(v); if (edges.length > 5000) break; } if (edges[edges.length - 1] < hi) edges.push(edges[edges.length - 1] + w); }
  else edges = autoBinEdges(data, main.length > 1 ? toNum(main[1]) : (pm.numbins ? toNum(pm.numbins) : null));
  let counts = binCounts(data, edges);
  const norm = pm.normalization ? toStr(pm.normalization).toLowerCase() : 'count';
  if (norm === 'probability') counts = counts.map(c => c / data.length);
  else if (norm === 'pdf') counts = counts.map((c, i) => c / data.length / (edges[i + 1] - edges[i]));
  else if (norm === 'cdf') { let s = 0; counts = counts.map(c => (s += c) / data.length); }
  else if (norm === 'cumcount') { let s = 0; counts = counts.map(c => (s += c)); }
  const s = mkSeries('histogram', ax, { x: edges.map(jnum), y: counts.map(jnum), faceAlpha: 0.6, extra: { binEdges: edges.map(jnum), counts: counts.map(jnum), normalization: norm } });
  s.color = nextColor(ax); s.edgeColor = [0, 0, 0];
  applyProps(s, props.filter(([k]) => !['binedges', 'binwidth', 'numbins', 'normalization'].includes(k.toLowerCase())));
  return nout > 0 ? s.handle : undefined;
};
B.hist = (a, nout) => {
  const data = toArr(a[0]).filter(v => v === v);
  let centers;
  if (a.length > 1 && numelOf(a[1]) > 1) centers = toArr(a[1]).slice();
  else { const n = a.length > 1 ? toNum(a[1]) : 10; let lo = Math.min(...data), hi = Math.max(...data); if (lo === hi) { lo -= 0.5; hi += 0.5; } const w = (hi - lo) / n; centers = []; for (let i = 0; i < n; i++) centers.push(lo + w * (i + 0.5)); }
  const edges = [-Infinity]; for (let i = 0; i < centers.length - 1; i++) edges.push((centers[i] + centers[i + 1]) / 2); edges.push(Infinity);
  const counts = zerosArr(centers.length);
  for (const v of data) { for (let k = 0; k < centers.length; k++) if (v >= edges[k] && (v < edges[k + 1] || (k === centers.length - 1))) { counts[k]++; break; } }
  if (nout > 0) return new MR([mkRow(counts), mkRow(centers)]);
  const ax = prepAxes();
  const w = centers.length > 1 ? centers[1] - centers[0] : 1;
  const pe = [centers[0] - w / 2]; for (let i = 0; i < centers.length - 1; i++) pe.push((centers[i] + centers[i + 1]) / 2); pe.push(centers[centers.length - 1] + w / 2);
  const s = mkSeries('histogram', ax, { x: pe.map(jnum), y: counts, extra: { binEdges: pe.map(jnum), counts, centers } });
  s.color = nextColor(ax); s.edgeColor = [0, 0, 0];
  return undefined;
};
B.pie = (a, nout) => {
  const ax = prepAxes(); const vals = toArr(a[0]).slice(); let explode = null, labels = null;
  for (let i = 1; i < a.length; i++) { if (a[i] instanceof MCell || a[i] instanceof MString) labels = cellOfStrings(a[i]); else if (isNumericArg(a[i])) explode = toArr(a[i]).map(x => (x ? 1 : 0)); }
  const tot = vals.reduce((s, v) => s + v, 0);
  const frac = tot > 1 ? vals.map(v => v / tot) : vals.slice();
  if (!labels) labels = frac.map(f => { const p = f * 100; return (p < 1 && p > 0 ? '< 1' : String(Math.round(p))) + '%'; });
  const s = mkSeries('pie', ax, { x: vals.map(jnum), y: frac.map(jnum), labels, extra: { explode, colors: vals.map((_, i) => COLOR_ORDER[i % 7]) } });
  s.color = null; ax.axis = 'off'; ax.box = false;
  return nout > 0 ? s.handle : undefined;
};
B.pie3 = B.pie;
B.errorbar = (a, nout) => {
  const ax = prepAxes(); const { main, props } = splitProps(a);
  let spec = null; const nums = main.filter(v => { if (isStringy(v)) { spec = parseLineSpec(toStr(v)); return false; } return true; });
  let x, y, neg, pos;
  if (nums.length === 2) { y = toArr(nums[0]); x = y.map((_, i) => i + 1); neg = pos = toArr(nums[1]); }
  else if (nums.length === 3) { x = toArr(nums[0]); y = toArr(nums[1]); neg = pos = toArr(nums[2]); }
  else { x = toArr(nums[0]); y = toArr(nums[1]); neg = toArr(nums[2]); pos = toArr(nums[3]); }
  const ex = (arr) => (arr.length === 1 ? y.map(() => arr[0]) : arr);
  const s = mkSeries('errorbar', ax, { x: x.map(jnum), y: y.map(jnum), extra: { yNeg: ex(neg).map(jnum), yPos: ex(pos).map(jnum) } });
  s.u = s.extra.yNeg; s.v = s.extra.yPos;
  s.color = spec && spec.color ? spec.color : nextColor(ax);
  if (spec) { if (spec.lineStyle) s.lineStyle = spec.lineStyle; else if (spec.marker) s.lineStyle = 'none'; if (spec.marker) s.marker = spec.marker; }
  applyProps(s, props); return nout > 0 ? s.handle : undefined;
};
B.fill = (a, nout) => {
  const ax = prepAxes(); const { main, props } = splitProps(a); const hs = [];
  for (let i = 0; i + 1 < main.length; i += 3) {
    const s = mkSeries('fill', ax, { x: jarr(main[i]), y: jarr(main[i + 1]), edgeColor: [0, 0, 0] });
    const c = main[i + 2]; if (c !== undefined) { if (isStringy(c)) s.color = parseColor(c); else { const t = toT(c); if (t.re.length === 3) s.color = t.re.slice(); else { s.c = jarr(t); s.color = null; } } } else s.color = nextColor(ax);
    applyProps(s, props); hs.push(s.handle);
  }
  return nout > 0 ? hs[0] : undefined;
};
B.patch = (a, nout) => { const ax = gcaObj(); const h = ax.hold; ax.hold = true; const r = B.fill(a, nout); ax.hold = h; return r; };
function gridArgs(main) { // returns {X,Y,Z} as tensors (matrices)
  let X, Y, Z;
  if (main.length < 3) { Z = toT(main[0]); const R = Z.dims[0], C = Z.dims[1]; const g = B.meshgrid([mkRow(Array.from({ length: C }, (_, i) => i + 1)), mkRow(Array.from({ length: R }, (_, i) => i + 1))]).v; X = toT(g[0]); Y = toT(g[1]); }
  else {
    X = toT(main[0]); Y = toT(main[1]); Z = toT(main[2]);
    if (isVecDims(X.dims) && isVecDims(Y.dims) && !(sameDims(X.dims, Z.dims))) { const g = B.meshgrid([X, Y]).v; X = toT(g[0]); Y = toT(g[1]); }
  }
  return { X, Y, Z };
}
function surfImpl(a, type, nout) {
  const ax = prepAxes(); const { main, props } = splitProps(a);
  const nums = main.filter(isNumericArg);
  const { X, Y, Z } = gridArgs(nums);
  const s = mkSeries(type, ax, { x: jmat(X), y: jmat(Y), z: jmat(Z), c: nums.length > 3 ? jmat(nums[3]) : null, edgeColor: type === 'mesh' ? null : [0, 0, 0] });
  applyProps(s, props);
  ax.is3d = true; if (!ax.view) ax.view = [-37.5, 30];
  return nout > 0 ? s.handle : undefined;
}
B.surf = (a, nout) => surfImpl(a, 'surf', nout);
B.surfc = B.surf;
B.mesh = (a, nout) => surfImpl(a, 'mesh', nout);
B.meshc = B.mesh;
B.waterfall = B.mesh;
function autoLevels(zmin, zmax, n) {
  if (!(zmax > zmin)) return [zmin];
  if (n) { const out = []; for (let i = 1; i <= n; i++) out.push(zmin + (zmax - zmin) * i / (n + 1)); return out; }
  const step = niceNum((zmax - zmin) / 8); const out = []; for (let v = Math.ceil(zmin / step) * step; v <= zmax + 1e-12; v += step) out.push(Math.round(v / step) * step);
  return out;
}
function contourImpl(a, type, nout) {
  const ax = prepAxes(); const { main, props } = splitProps(a);
  let spec = null; const nums = main.filter(v => { if (isStringy(v)) { spec = parseLineSpec(toStr(v)); return false; } return true; });
  let levArg = null;
  if (nums.length === 2 || nums.length === 4) levArg = nums.pop();
  const { X, Y, Z } = gridArgs(nums);
  let zmin = Infinity, zmax = -Infinity; for (const v of Z.re) if (isFinite(v)) { zmin = Math.min(zmin, v); zmax = Math.max(zmax, v); }
  let levels;
  if (levArg) { const L = toArr(levArg); levels = L.length === 1 ? autoLevels(zmin, zmax, L[0]) : L.slice(); if (L.length === 2 && L[0] === L[1]) levels = [L[0]]; }
  else levels = autoLevels(zmin, zmax, null);
  const s = mkSeries(type, ax, { x: jmat(X), y: jmat(Y), z: jmat(Z), levels: levels.map(jnum) });
  if (spec && spec.color) s.color = spec.color; if (spec && spec.lineStyle) s.lineStyle = spec.lineStyle;
  applyProps(s, props);
  if (type === 'contour3') { ax.is3d = true; if (!ax.view) ax.view = [-37.5, 30]; }
  return nout > 0 ? new MR([emptyD(), s.handle]) : undefined;
}
B.contour = (a, nout) => contourImpl(a, 'contour', nout);
B.contourf = (a, nout) => contourImpl(a, 'contourf', nout);
B.contour3 = (a, nout) => contourImpl(a, 'contour', nout);
B.clabel = () => undefined;
function imageImpl(a, type, nout) {
  const ax = prepAxes(); const { main, props } = splitProps(a); const nums = main.filter(isNumericArg);
  let C, xr, yr;
  if (nums.length >= 3) { C = toT(nums[2]); const xv = toArr(nums[0]), yv = toArr(nums[1]); xr = [xv[0], xv[xv.length - 1]]; yr = [yv[0], yv[yv.length - 1]]; }
  else { C = toT(nums[0]); xr = [1, C.dims[1]]; yr = [1, C.dims[0]]; }
  if (nums.length === 2 && type === 'imagesc') { const cl = toArr(nums[1]); ax.caxis = [cl[0], cl[1]]; }
  const s = mkSeries('imagesc', ax, { x: xr.map(jnum), y: yr.map(jnum), z: C.dims.length > 2 ? null : jmat(C), extra: { yDir: 'reverse', direct: type === 'image' } });
  if (C.dims.length > 2) { const R = C.dims[0], Cc = C.dims[1]; const rgb = []; for (let i = 0; i < R; i++) { const row = []; for (let j = 0; j < Cc; j++) row.push([0, 1, 2].map(k => jnum(C.re[i + j * R + k * R * Cc]))); rgb.push(row); } s.extra.rgb = rgb; }
  applyProps(s, props); ax.extra.yDir = 'reverse';
  return nout > 0 ? s.handle : undefined;
}
B.imagesc = (a, nout) => imageImpl(a, 'imagesc', nout);
B.image = (a, nout) => imageImpl(a, 'image', nout);
B.imshow = (a, nout) => { const r = imageImpl([a[0]], 'image', nout); const ax = gcaObj(); ax.axis = 'equal'; ax.extra.axisVisible = false; ax.colormap = 'gray'; return r; };
B.pcolor = (a, nout) => { const r = surfImpl(a, 'surf', nout); const ax = gcaObj(); ax.is3d = false; ax.view = [0, 90]; return r; };
B.quiver = (a, nout) => {
  const ax = prepAxes(); const { main, props } = splitProps(a); let spec = null;
  const nums = main.filter(v => { if (isStringy(v)) { spec = parseLineSpec(toStr(v)); return false; } return true; });
  let X, Y, U, V, scale = 1;
  if (nums.length <= 3) { U = toT(nums[0]); V = toT(nums[1]); const R = U.dims[0], C = U.dims[1]; const g = B.meshgrid([mkRow(Array.from({ length: C }, (_, i) => i + 1)), mkRow(Array.from({ length: R }, (_, i) => i + 1))]).v; X = toT(g[0]); Y = toT(g[1]); if (nums.length === 3) scale = toNum(nums[2]); }
  else { X = toT(nums[0]); Y = toT(nums[1]); U = toT(nums[2]); V = toT(nums[3]); if (nums.length > 4) scale = toNum(nums[4]); if (isVecDims(X.dims) && isVecDims(Y.dims) && X.re.length * Y.re.length === U.re.length && X.re.length !== U.re.length) { const g = B.meshgrid([X, Y]).v; X = toT(g[0]); Y = toT(g[1]); } }
  const s = mkSeries('quiver', ax, { x: jarr(X), y: jarr(Y), u: jarr(U), v: jarr(V), extra: { scale } });
  s.color = spec && spec.color ? spec.color : nextColor(ax); applyProps(s, props);
  return nout > 0 ? s.handle : undefined;
};
B.text = (a, nout) => {
  const ax = gcaObj(); const is3 = a.length >= 4 && isNumericArg(a[2]) && !isStringy(a[2]);
  const x = toArr(a[0]), y = toArr(a[1]); const z = is3 ? toArr(a[2]) : null; const strv = a[is3 ? 3 : 2];
  const txt = strv instanceof MCell || strv instanceof MString ? cellOfStrings(strv).join('\n') : toStr(strv);
  const s = mkSeries('text', ax, { x: x.map(jnum), y: y.map(jnum), z: z ? z.map(jnum) : null, text: txt, color: [0, 0, 0] });
  applyProps(s, splitProps(a.slice(is3 ? 4 : 3)).props.concat(pairs(a.slice(is3 ? 4 : 3))));
  return nout > 0 ? s.handle : undefined;
};
function pairs(arr) { const p = []; for (let i = 0; i + 1 < arr.length; i += 2) if (isStringy(arr[i])) p.push([toStr(arr[i]), arr[i + 1]]); return p; }
function labelText(v) { if (v instanceof MCell || (v instanceof MString && v.data.length > 1)) return cellOfStrings(v).join('\n'); if (isChar(v) && v.dims[0] > 1) return charRowsToStrings(v).join('\n'); if (isStringy(v)) return toStr(v); if (isTensorLike(v)) return num2strVal(v) ? toStr(num2strVal(v)) : ''; return ''; }
B.title = (a) => { const ax = gcaObj(); ax.title = a.length ? labelText(a[0]) : ''; return undefined; };
B.subtitle = (a) => { const ax = gcaObj(); ax.extra.subtitle = labelText(a[0]); return undefined; };
B.xlabel = (a) => { gcaObj().xlabel = labelText(a[0]); return undefined; };
B.ylabel = (a) => { gcaObj().ylabel = labelText(a[0]); return undefined; };
B.zlabel = (a) => { gcaObj().zlabel = labelText(a[0]); return undefined; };
B.sgtitle = B.suptitle = (a) => { const f = curFig(); f.sgtitle = labelText(a[0]); f.dirty = true; return undefined; };
B.legend = (a) => {
  const ax = gcaObj(); let labels = []; let i = 0;
  const kw = a.length ? (isStringy(a[0]) ? toStr(a[0]).toLowerCase() : null) : null;
  if (kw === 'off' || kw === 'hide') { ax.legend = null; ax.legendShow = false; return undefined; }
  if (kw === 'show' || kw === 'boxoff' || kw === 'boxon' || kw === 'toggle') { ax.legendShow = true; if (kw === 'boxoff') ax.extra.legendBox = false; return undefined; }
  for (; i < a.length; i++) {
    const v = a[i];
    if (v instanceof MCell || (v instanceof MString && v.data.length > 1)) { labels.push(...cellOfStrings(v)); continue; }
    if (isStringy(v)) {
      const s = toStr(v);
      if (/^(location|orientation|fontsize|box|textcolor|numcolumns|autoupdate|interpreter)$/i.test(s) && i + 1 < a.length) { if (/^location$/i.test(s)) ax.legendLocation = toStr(a[i + 1]).toLowerCase(); i++; continue; }
      labels.push(s);
    }
  }
  if (labels.length) {
    const ser = ax.series.filter(s => s.type !== 'text');
    labels.forEach((l, k) => { if (ser[k]) ser[k].displayName = l; });
  }
  ax.legendShow = true;
  ax.legend = labels.length ? labels : null;
  return undefined;
};
function onOff(a, cur) { if (!a.length) return !cur; const s = toStr(a[0]).toLowerCase(); return s === 'on' || s === 'minor'; }
B.grid = (a) => { const ax = gcaObj(); ax.grid = onOff(a, ax.grid); if (a.length && toStr(a[0]) === 'minor') ax.extra.minorGrid = true; return undefined; };
B.box = (a) => { const ax = gcaObj(); ax.box = onOff(a, ax.box); return undefined; };
B.hold = (a) => {
  const ax = gcaObj();
  if (!a.length) ax.hold = !ax.hold; else { const s = toStr(a[0]).toLowerCase(); ax.hold = s === 'on' || s === 'all'; }
  return undefined;
};
B.ishold = () => gcaObj().hold;
B.axis = (a, nout) => {
  const ax = gcaObj();
  if (!a.length) { if (nout > 0) return mkRow([...(ax.xlim || [0, 1]), ...(ax.ylim || [0, 1])]); return undefined; }
  for (const v of a) {
    if (isStringy(v)) {
      const s = toStr(v).toLowerCase();
      if (s === 'equal' || s === 'image' || s === 'square') { ax.axis = 'equal'; if (s === 'square') ax.extra.square = true; }
      else if (s === 'tight') ax.axis = 'tight';
      else if (s === 'off') ax.axis = 'off';
      else if (s === 'on') { if (ax.axis === 'off') ax.axis = 'auto'; }
      else if (s === 'auto' || s === 'normal') { ax.axis = 'auto'; ax.xlim = ax.ylim = ax.zlim = null; }
      else if (s === 'ij') ax.extra.yDir = 'reverse';
      else if (s === 'xy') ax.extra.yDir = 'normal';
      else if (s === 'vis3d') ax.extra.vis3d = true;
    } else {
      const l = toArr(v); if (l.length >= 4) { ax.xlim = [jnum(l[0]), jnum(l[1])]; ax.ylim = [jnum(l[2]), jnum(l[3])]; } if (l.length >= 6) ax.zlim = [jnum(l[4]), jnum(l[5])];
    }
  }
  return undefined;
};
function limFn(key) {
  return (a, nout) => {
    const ax = gcaObj();
    if (!a.length) { return ax[key] ? mkRow(ax[key].map(x => (typeof x === 'number' ? x : x === 'Inf' ? Infinity : -Infinity))) : mkRow([0, 1]); }
    if (isStringy(a[0])) { const s = toStr(a[0]); if (s === 'auto') ax[key] = null; return undefined; }
    const l = toArr(a[0]); ax[key] = [jnum(l[0]), jnum(l[1])]; return undefined;
  };
}
B.xlim = limFn('xlim'); B.ylim = limFn('ylim'); B.zlim = limFn('zlim');
B.view = (a) => {
  const ax = gcaObj();
  if (!a.length) return mkRow(ax.view || [0, 90]);
  if (a.length === 1) { const v = toArr(a[0]); if (v.length === 1) ax.view = v[0] === 2 ? [0, 90] : [-37.5, 30]; else ax.view = [v[0], v[1]]; }
  else ax.view = [toNum(a[0]), toNum(a[1])];
  if (!(ax.view[0] === 0 && ax.view[1] === 90)) ax.is3d = true;
  return undefined;
};
B.rotate3d = () => undefined;
B.colormap = (a) => {
  const f = curFig(); const ax = gcaObj();
  if (!a.length) return mkStr(ax.colormap || f.colormap);
  let v = a[a.length - 1];
  if (isStringy(v)) { const s = toStr(v).toLowerCase(); ax.colormap = s; f.colormap = s; }
  else { ax.colormap = 'custom'; ax.extra.colormapData = jmat(v); }
  return undefined;
};
for (const cm of ['parula', 'jet', 'hot', 'cool', 'gray', 'bone', 'copper', 'hsv', 'spring', 'summer', 'autumn', 'winter', 'turbo', 'viridis', 'pink', 'lines']) {
  if (B[cm]) continue;
  B[cm] = (a) => { const n = a.length ? toNum(a[0]) : 64; const re = new Array(n * 3).fill(0); for (let i = 0; i < n; i++) { const t = n === 1 ? 0 : i / (n - 1); const c = cm === 'gray' ? [t, t, t] : cm === 'hot' ? [Math.min(1, 3 * t), Math.min(1, Math.max(0, 3 * t - 1)), Math.max(0, 3 * t - 2)] : cm === 'cool' ? [t, 1 - t, 1] : cm === 'lines' ? COLOR_ORDER[i % 7] : [Math.max(0, Math.min(1, 1.5 - Math.abs(4 * t - 3))), Math.max(0, Math.min(1, 1.5 - Math.abs(4 * t - 2))), Math.max(0, Math.min(1, 1.5 - Math.abs(4 * t - 1)))]; for (let k = 0; k < 3; k++) re[i + k * n] = c[k]; } const r = mkMat(n, 3, re); r.cmName = cm; return r; };
}
B.colorbar = (a) => { const ax = gcaObj(); ax.colorbar = !(a.length && toStr(a[0]) === 'off'); return undefined; };
B.caxis = B.clim = (a) => { const ax = gcaObj(); if (a.length && !isStringy(a[0])) { const l = toArr(a[0]); ax.caxis = [l[0], l[1]]; } return undefined; };
B.shading = (a) => { const ax = gcaObj(); ax.extra.shading = a.length ? toStr(a[0]) : 'faceted'; return undefined; };
B.lighting = B.material = B.camlight = B.light = () => undefined;
B.alpha = (a) => { const ax = gcaObj(); const v = toNum(a[a.length - 1]); for (const s of ax.series) s.faceAlpha = v; return undefined; };
B.daspect = B.pbaspect = (a) => { gcaObj().axis = 'equal'; return undefined; };
B.xticks = (a) => { gcaObj().extra.xticks = jarr(a[0]); return undefined; };
B.yticks = (a) => { gcaObj().extra.yticks = jarr(a[0]); return undefined; };
B.zticks = (a) => { gcaObj().extra.zticks = jarr(a[0]); return undefined; };
B.xticklabels = (a) => { gcaObj().extra.xticklabels = cellOfStrings(a[0]); return undefined; };
B.yticklabels = (a) => { gcaObj().extra.yticklabels = cellOfStrings(a[0]); return undefined; };
B.xtickangle = B.ytickangle = () => undefined;
B.figure = (a, nout) => {
  let id = null; const props = [];
  if (a.length && isNumericArg(a[0])) { id = toNum(a[0]); a = a.slice(1); }
  else if (a.length === 1 && isStringy(a[0]) && /^\d+$/.test(toStr(a[0]))) { id = +toStr(a[0]); a = []; }
  if (id === null) { id = 1; for (const k of ST.figs.keys()) if (k >= id) id = k + 1; } // next number after the highest open figure
  let f = ST.figs.get(id); if (!f) { f = newFig(id); ST.figs.set(id, f); }
  for (let i = 0; i + 1 < a.length; i += 2) { const k = toStr(a[i]).toLowerCase(); if (k === 'name') f.name = toStr(a[i + 1]); else if (k === 'color') f.color = parseColor(a[i + 1]); }
  ST.curFig = id; f.dirty = true;
  return nout > 0 ? id : undefined;
};
B.gcf = () => { curFig(); return ST.curFig; };
B.gca = () => { const f = curFig(); gcaObj(); return f.cur + 1 + ST.curFig * 100; };
B.clf = () => { const f = curFig(); f.axes = []; f.cur = -1; f.sgtitle = null; f.dirty = true; return undefined; };
B.cla = () => { const ax = gcaObj(); ax.series = []; ax.ci = 0; return undefined; };
B.close = (a) => {
  const closeFig = (id) => { const f = ST.figs.get(id); if (!f) return; if (f.emitted && ST.onFigure) ST.onFigure({ id, closed: true }); ST.figs.delete(id); if (ST.curFig === id) { const ks = Array.from(ST.figs.keys()); ST.curFig = ks.length ? ks[ks.length - 1] : 0; } };
  if (!a.length) { closeFig(ST.curFig); return undefined; }
  if (isStringy(a[0]) && toStr(a[0]) === 'all') { for (const id of Array.from(ST.figs.keys())) closeFig(id); ST.curFig = 0; return undefined; }
  for (const v of a) for (const id of toArr(v)) closeFig(id);
  return undefined;
};
B.subplot = (a, nout) => {
  let m, n, p;
  if (a.length === 1) { const v = Math.floor(toNum(a[0])); m = Math.floor(v / 100); n = Math.floor(v / 10) % 10; p = v % 10; }
  else { m = toNum(a[0]); n = toNum(a[1]); const pv = toArr(a[2]); p = pv.length === 1 ? pv[0] : pv.slice(); }
  const f = curFig(); f.dirty = true;
  if (typeof p === 'number' && (p < 1 || p > m * n)) err('subplot 索引超出范围（必须在 1 到 ' + m * n + ' 之间）。');
  // remove non-subplot axes
  f.axes = f.axes.filter(x => x.subplot !== null);
  const key = JSON.stringify([m, n, p]);
  let idx = f.axes.findIndex(x => JSON.stringify(x.subplot) === key);
  if (idx < 0) { const ax = newAxes([m, n, p]); f.axes.push(ax); idx = f.axes.length - 1; }
  f.cur = idx;
  return nout > 0 ? idx + 1 + ST.curFig * 100 : undefined;
};
B.tiledlayout = (a) => { const f = curFig(); f.tiled = [toNum(a[0]), toNum(a[1] || 1)]; f.tileNext = 1; f.axes = []; f.cur = -1; return undefined; };
B.nexttile = (a) => { const f = curFig(); if (!f.tiled) f.tiled = [1, 1]; const p = a.length ? toNum(a[0]) : f.tileNext++; return B.subplot([f.tiled[0], f.tiled[1], p], 0); };
B.set = (a) => {
  const h = toNum(a[0]); const info = ST.handles.get(h);
  const props = pairs(a.slice(1));
  if (info && info.kind === 'series') { applyProps(info.obj, props); markAllDirty(); return undefined; }
  // axes or figure handle: apply common axes props
  const ax = gcaObj();
  for (const [k, v] of props) {
    const kl = k.toLowerCase();
    if (kl === 'xlim' || kl === 'ylim' || kl === 'zlim') { const l = toArr(v); ax[kl] = [jnum(l[0]), jnum(l[1])]; }
    else if (kl === 'xscale' || kl === 'yscale') ax[kl] = toStr(v);
    else if (kl === 'xgrid' || kl === 'ygrid') ax.grid = toStr(v) === 'on';
    else if (kl === 'box') ax.box = toStr(v) === 'on';
    else if (kl === 'xtick') ax.extra.xticks = jarr(v); else if (kl === 'ytick') ax.extra.yticks = jarr(v);
    else if (kl === 'xticklabel') ax.extra.xticklabels = cellOfStrings(v); else if (kl === 'yticklabel') ax.extra.yticklabels = cellOfStrings(v);
    else if (kl === 'name') curFig().name = toStr(v);
    else if (kl === 'ydir') ax.extra.yDir = toStr(v);
    else if (kl === 'fontsize') ax.extra.fontSize = toNum(v);
  }
  return undefined;
};
B.get = (a) => { const h = toNum(a[0]); const info = ST.handles.get(h); if (info && a.length > 1) { const k = PROP_MAP[toStr(a[1]).toLowerCase()]; const v = info.obj[k]; if (Array.isArray(v)) return mkRow(v.map(x => (x === null ? NaN : x))); if (typeof v === 'string') return mkStr(v); if (typeof v === 'number') return v; } return emptyD(); };
B.ishandle = B.isgraphics = (a) => { const h = toNum(a[0]); return ST.handles.has(h) || ST.figs.has(h); };
B.delete = (a) => { const h = toNum(a[0]); const info = ST.handles.get(h); if (info) { for (const f of ST.figs.values()) for (const ax of f.axes) { const i = ax.series.indexOf(info.obj); if (i >= 0) ax.series.splice(i, 1); } markAllDirty(); } return undefined; };
B.saveas = B.print = B.exportgraphics = () => { warnMsg('在线环境不支持保存图像文件，已忽略。'); return undefined; };
function markAllDirty() { const f = curFig(false); if (f) f.dirty = true; }
function axesSpec(ax) {
  const ser = ax.series.map((s, k) => {
    const o = { type: s.type, x: s.x, y: s.y, z: s.z, c: s.c, u: s.u, v: s.v, labels: s.labels, color: s.color, lineStyle: s.lineStyle, marker: s.marker, lineWidth: s.lineWidth, markerSize: s.markerSize, displayName: s.displayName, faceAlpha: s.faceAlpha, edgeColor: s.edgeColor, levels: s.levels, text: s.text, extra: s.extra };
    return o;
  });
  let legend = null;
  if (ax.legendShow) { const named = ax.series.filter(s => s.type !== 'text'); legend = named.map((s, i) => s.displayName || ('data' + (i + 1))); if (ax.legend && ax.legend.length < legend.length) legend = legend.slice(0, Math.max(ax.legend.length, 0)); }
  return { subplot: ax.subplot, title: ax.title, xlabel: ax.xlabel, ylabel: ax.ylabel, zlabel: ax.zlabel, grid: ax.grid, box: ax.box, hold: ax.hold, legend, legendLocation: ax.legendLocation, xlim: ax.xlim, ylim: ax.ylim, zlim: ax.zlim, axis: ax.axis, view: ax.view, is3d: ax.is3d, colormap: ax.colormap || 'parula', colorbar: ax.colorbar, xscale: ax.xscale, yscale: ax.yscale, caxis: ax.caxis, extra: ax.extra, series: ser };
}
function figSpec(f) { return { id: f.id, name: f.name, sgtitle: f.sgtitle, axes: f.axes.map(axesSpec) }; }
function flushFigures() {
  if (!ST.onFigure) { for (const f of ST.figs.values()) f.dirty = false; return; }
  for (const f of ST.figs.values()) {
    if (!f.dirty) continue;
    f.dirty = false; f.emitted = true;
    let spec; try { spec = JSON.parse(JSON.stringify(figSpec(f))); } catch (e) { spec = figSpec(f); }
    flushOut();
    ST.onFigure(spec);
  }
}

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
