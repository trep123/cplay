/* CInterp: a small C99-subset interpreter in plain JavaScript. No dependencies. */
(function (root) {
'use strict';

// ---------------- errors ----------------
class CErr extends Error { constructor(kind, line, msg) { super(msg); this.kind = kind; this.line = line; this.cmsg = msg; } }
class ExitSig { constructor(code) { this.code = code; } }
let cLine = 0;
function cerr(msg, line) { throw new CErr('compile', line != null ? line : cLine, msg); }

// ---------------- types ----------------
function IT(name, size, uns) { return { k: 'int', name, size, uns: !!uns }; }
const T = {
  void: { k: 'void', name: 'void', size: 1 },
  char: IT('char', 1), uchar: IT('unsigned char', 1, 1), short: IT('short', 2), ushort: IT('unsigned short', 2, 1),
  int: IT('int', 4), uint: IT('unsigned int', 4, 1), long: IT('long', 8), ulong: IT('unsigned long', 8, 1),
  bool: { k: 'int', name: '_Bool', size: 1, uns: true, bool: true },
  float: { k: 'float', name: 'float', size: 4 }, double: { k: 'float', name: 'double', size: 8 },
};
const ptr = t => ({ k: 'ptr', to: t, size: 8 });
const arr = (t, n) => ({ k: 'arr', of: t, n: n });
const alignUp = (v, a) => Math.ceil(v / a) * a;
function sizeOf(t) {
  switch (t.k) {
    case 'arr': if (t.vexpr || t.vslot != null) cerr('变长数组的大小只能在运行时确定'); return t.n == null ? 0 : sizeOf(t.of) * t.n;
    case 'struct': if (!t.complete) cerr('结构体类型 ' + (t.tag || '') + ' 不完整'); return t.size;
    case 'func': return 1;
    default: return t.size;
  }
}
function alignOf(t) {
  if (t.k === 'arr') return alignOf(t.of);
  if (t.k === 'struct') return t.complete ? t.align : 1;
  if (t.k === 'func' || t.k === 'void') return 1;
  return t.size;
}
const isInt = t => t.k === 'int', isArith = t => t.k === 'int' || t.k === 'float', isPtr = t => t.k === 'ptr';
const isScalar = t => isArith(t) || isPtr(t);
const isVla = t => t.k === 'arr' && (t.vexpr != null || t.vslot != null || isVla(t.of));
function sameStruct(a, b) {
  if (a === b) return true;
  if (a.k !== 'struct' || b.k !== 'struct' || a.union !== b.union || a.tag !== b.tag || !a.complete || !b.complete || a.size !== b.size || a.fields.length !== b.fields.length) return false;
  for (let i = 0; i < a.fields.length; i++) if (a.fields[i].name !== b.fields[i].name || a.fields[i].off !== b.fields[i].off) return false;
  return true;
}
function typeName(t) {
  switch (t.k) {
    case 'ptr': return typeName(t.to) + '*';
    case 'arr': return typeName(t.of) + '[' + (t.n == null ? '' : t.n) + ']';
    case 'struct': return (t.union ? 'union ' : 'struct ') + (t.tag || '<匿名>');
    case 'func': return '函数';
    default: return t.name;
  }
}
function promote(t) { return (t.k === 'int' && t.size < 4) ? T.int : t; }
function usual(a, b) {
  if (a.k === 'float' || b.k === 'float') {
    if ((a.k === 'float' && a.size === 8) || (b.k === 'float' && b.size === 8)) return T.double;
    return T.float;
  }
  a = promote(a); b = promote(b);
  if (a.size === 8 || b.size === 8) return ((a.size === 8 && a.uns) || (b.size === 8 && b.uns)) ? T.ulong : T.long;
  if (a.uns || b.uns) return T.uint;
  return T.int;
}
const BMAX = BigInt(Number.MAX_SAFE_INTEGER), BMIN = -BMAX;
const toB = v => typeof v === 'bigint' ? v : BigInt(Number.isFinite(v) ? Math.trunc(v) : 0);
const fromB = b => (b >= BMIN && b <= BMAX) ? Number(b) : b;
const toN = v => typeof v === 'bigint' ? Number(v) : v;
function w64s(v) { return fromB(BigInt.asIntN(64, toB(v))); }
function w64u(v) { return fromB(BigInt.asUintN(64, toB(v))); }
const lo32 = v => typeof v === 'bigint' ? Number(BigInt.asIntN(32, v)) : v;
function normFor(t) {
  if (t.k === 'int') {
    if (t.bool) return v => v ? 1 : 0;
    switch (t.size) {
      case 1: return t.uns ? v => lo32(v) & 255 : v => (lo32(v) << 24) >> 24;
      case 2: return t.uns ? v => lo32(v) & 65535 : v => (lo32(v) << 16) >> 16;
      case 4: return t.uns ? v => lo32(v) >>> 0 : v => lo32(v) | 0;
      case 8: return t.uns ? v => (Number.isSafeInteger(v) && v >= 0) ? v : w64u(v) : v => Number.isSafeInteger(v) ? v : w64s(v);
    }
  }
  if (t.k === 'float') return t.size === 4 ? v => Math.fround(toN(v)) : toN;
  return v => toN(v);
}
function castFn(from, to) {
  if (from === to) return null;
  if (to.k === 'int') {
    if (to.bool) return v => v ? 1 : 0;
    const n = normFor(to);
    if (from.k === 'float') return v => n(Number.isFinite(v) ? Math.trunc(v) : 0);
    if (from.k === 'int') {
      if (from.size === 8 && to.size === 8) return n;
      if (from.size < to.size && (from.uns || !to.uns)) return null;
      if (from.size === to.size && from.uns === to.uns) return null;
      return n;
    }
    if (from.k === 'ptr') return n;
    return null;
  }
  if (to.k === 'float') {
    if (to.size === 4) return (from.k === 'float' && from.size === 4) ? null : v => Math.fround(toN(v));
    if (from.k === 'int' && from.size === 8) return toN;
    return null;
  }
  return null;
}

// ---------------- lexer ----------------
const ENC = new TextEncoder();
const utf8 = s => Array.from(ENC.encode(s));
const P3 = new Set(['>>=', '<<=', '...']);
const P2 = new Set(['->', '++', '--', '<<', '>>', '<=', '>=', '==', '!=', '&&', '||', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '##']);
const P1 = new Set('#()[]{},;:?.+-*/%&|^!~<>='.split(''));
const isDigit = c => c >= 48 && c <= 57;
const isIdStart = c => (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95 || c === 36;
const isIdChar = c => isIdStart(c) || isDigit(c);
function readEsc(s, i) {
  const ch = s[i];
  const simple = { n: 10, t: 9, r: 13, a: 7, b: 8, f: 12, v: 11, e: 27, '\\': 92, "'": 39, '"': 34, '?': 63 };
  if (ch in simple) return [simple[ch], i + 1];
  if (ch >= '0' && ch <= '7') { let j = i, v = 0; while (j < i + 3 && s[j] >= '0' && s[j] <= '7') { v = v * 8 + (s.charCodeAt(j) - 48); j++; } return [v & 255, j]; }
  if (ch === 'x') { let j = i + 1, h = ''; while (/[0-9a-fA-F]/.test(s[j] || '')) h += s[j++]; return [parseInt(h || '0', 16) & 255, j]; }
  return [s.charCodeAt(i), i + 1];
}
function numTok(body, suf, line, raw) {
  const hex = /^0[xX]/.test(body), bin = /^0[bB]/.test(body);
  const isF = !hex && !bin && /[.eE]/.test(body);
  if (isF) {
    let v = parseFloat(body); const fl = /f/i.test(suf);
    if (fl) v = Math.fround(v);
    return { t: 'num', v, type: fl ? T.float : T.double, line, s: raw };
  }
  const bv = hex ? BigInt(body) : bin ? BigInt(body) : (body.length > 1 && body[0] === '0') ? BigInt('0o' + body.slice(1)) : BigInt(body);
  const v = fromB(BigInt.asUintN(64, bv));
  const u = /u/i.test(suf), l = /l/i.test(suf);
  let type;
  if (!l && !u && v <= 2147483647) type = T.int;
  else if (!l && (u || hex || body[0] === '0') && v <= 4294967295) type = T.uint;
  else type = (u || bv > 9223372036854775807n) ? T.ulong : T.long;
  return { t: 'num', v: type === T.long ? fromB(BigInt.asIntN(64, bv)) : v, type, line, s: raw };
}
function lexLine(s, line, out) {
  let i = 0, sp = true; const n = s.length;
  while (i < n) {
    const c = s.charCodeAt(i);
    if (c === 32 || c === 9 || c === 13 || c === 11 || c === 12) { i++; sp = true; continue; }
    const st = i;
    if (isIdStart(c)) {
      while (i < n && isIdChar(s.charCodeAt(i))) i++;
      out.push({ t: 'id', v: s.slice(st, i), line, sp, s: s.slice(st, i) }); sp = false; continue;
    }
    if (isDigit(c) || (c === 46 && isDigit(s.charCodeAt(i + 1)))) {
      const rest = s.slice(i);
      const m = /^(?:0[xX][0-9a-fA-F]+|0[bB][01]+|(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)/.exec(rest);
      const body = m[0]; const suf = /^[uUlLfF]*/.exec(rest.slice(body.length))[0];
      i += body.length + suf.length;
      if (i < n && isIdChar(s.charCodeAt(i))) cerr('数字常量格式错误: ' + s.slice(st, i + 1), line);
      const tk = numTok(body, suf, line, s.slice(st, i)); tk.sp = sp; out.push(tk); sp = false; continue;
    }
    if (c === 39) {
      i++; let v;
      if (s[i] === '\\') { const r = readEsc(s, i + 1); v = r[0]; i = r[1]; }
      else if (s[i] === "'" || i >= n) cerr('空的字符常量', line);
      else { const cp = s.codePointAt(i); const b = utf8(String.fromCodePoint(cp)); v = b.length === 1 ? b[0] : cp; i += cp > 0xffff ? 2 : 1; }
      if (s[i] !== "'") cerr('字符常量缺少结束的单引号', line);
      i++;
      out.push({ t: 'chr', v: v < 256 ? (v << 24) >> 24 : v, line, sp, s: s.slice(st, i) }); sp = false; continue;
    }
    if (c === 34) {
      i++; const bytes = [];
      while (i < n && s[i] !== '"') {
        if (s[i] === '\\') { const r = readEsc(s, i + 1); bytes.push(r[0] & 255); i = r[1]; }
        else { const cp = s.codePointAt(i); const len = cp > 0xffff ? 2 : 1; for (const b of utf8(s.substr(i, len))) bytes.push(b); i += len; }
      }
      if (i >= n) cerr('字符串缺少结束的双引号', line);
      i++;
      out.push({ t: 'str', v: bytes, line, sp, s: s.slice(st, i) }); sp = false; continue;
    }
    const t3 = s.substr(i, 3), t2 = s.substr(i, 2);
    let p = null;
    if (P3.has(t3)) p = t3; else if (P2.has(t2)) p = t2; else if (P1.has(s[i])) p = s[i];
    if (!p) {
      const ch = s[i];
      if (/[\uff08\uff09\uff1b\uff0c\u201c\u201d\u2018\u2019\uff1a\u3002\uff01\uff1d]/.test(ch)) cerr("非法字符 '" + ch + "'（这是中文标点，请改用英文标点）", line);
      cerr("非法字符 '" + ch + "'", line);
    }
    i += p.length;
    out.push({ t: 'p', v: p, line, sp, s: p }); sp = false;
  }
}

// ---------------- preprocessor ----------------
const HEADERS = new Set(['stdio.h', 'stdlib.h', 'string.h', 'math.h', 'ctype.h', 'stdbool.h', 'limits.h', 'time.h', 'stdint.h', 'stddef.h', 'stdarg.h', 'assert.h', 'float.h', 'inttypes.h', 'errno.h', 'iso646.h', 'tgmath.h', 'wchar.h', 'locale.h', 'signal.h', 'setjmp.h', 'unistd.h', 'malloc.h', 'memory.h', 'strings.h', 'conio.h', 'windows.h']);
const PREDEF = {
  NULL: '((void*)0)', EOF: '(-1)', true: '1', false: '0', bool: '_Bool',
  INT_MAX: '2147483647', INT_MIN: '(-2147483647-1)', UINT_MAX: '4294967295U',
  LONG_MAX: '9223372036854775807L', LONG_MIN: '(-9223372036854775807L-1)', LLONG_MAX: '9223372036854775807L', LLONG_MIN: '(-9223372036854775807L-1)', ULONG_MAX: '18446744073709551615UL',
  CHAR_MAX: '127', CHAR_MIN: '(-128)', SCHAR_MAX: '127', SCHAR_MIN: '(-128)', UCHAR_MAX: '255', SHRT_MAX: '32767', SHRT_MIN: '(-32768)', USHRT_MAX: '65535', CHAR_BIT: '8',
  INT32_MAX: '2147483647', INT32_MIN: '(-2147483647-1)', UINT32_MAX: '4294967295U', INT64_MAX: '9223372036854775807L', INT64_MIN: '(-9223372036854775807L-1)', SIZE_MAX: '18446744073709551615UL',
  RAND_MAX: '2147483647', EXIT_SUCCESS: '0', EXIT_FAILURE: '1', CLOCKS_PER_SEC: '1000000L',
  M_PI: '3.14159265358979323846', M_E: '2.7182818284590452354', M_SQRT2: '1.41421356237309504880', M_LN2: '0.69314718055994530942',
  INFINITY: '(1e999)', HUGE_VAL: '(1e999)', NAN: '(0.0/0.0)', DBL_MAX: '1.7976931348623157e308', DBL_MIN: '2.2250738585072014e-308', DBL_EPSILON: '2.220446049250313e-16', FLT_MAX: '3.402823466e38F', FLT_EPSILON: '1.192092896e-7F',
  __STDC__: '1', __STDC_VERSION__: '199901L', PRId64: '"lld"', PRIu64: '"llu"', PRId32: '"d"',
  PRIi64: '"lli"', PRIx64: '"llx"', PRIX64: '"llX"', PRIo64: '"llo"', PRIi32: '"i"', PRIu32: '"u"', PRIx32: '"x"', PRIX32: '"X"', PRIo32: '"o"',
  PRId8: '"d"', PRId16: '"d"', PRIu8: '"u"', PRIu16: '"u"', PRIx8: '"x"', PRIx16: '"x"', PRIdMAX: '"jd"', PRIuMAX: '"ju"', PRIdPTR: '"ld"', PRIuPTR: '"lu"', PRIxPTR: '"lx"',
  SCNd64: '"lld"', SCNu64: '"llu"', SCNx64: '"llx"', SCNd32: '"d"', SCNu32: '"u"', SCNi64: '"lli"',
  INT8_MIN: '(-128)', INT8_MAX: '127', UINT8_MAX: '255', INT16_MIN: '(-32768)', INT16_MAX: '32767', UINT16_MAX: '65535', UINT64_MAX: '18446744073709551615UL', ULLONG_MAX: '18446744073709551615UL',
  INTMAX_MAX: '9223372036854775807L', INTMAX_MIN: '(-9223372036854775807L-1)', UINTMAX_MAX: '18446744073709551615UL', INTPTR_MAX: '9223372036854775807L', INTPTR_MIN: '(-9223372036854775807L-1)', UINTPTR_MAX: '18446744073709551615UL',
  PTRDIFF_MAX: '9223372036854775807L', PTRDIFF_MIN: '(-9223372036854775807L-1)', WCHAR_MAX: '2147483647', WCHAR_MIN: '(-2147483647-1)', LONG_BIT: '64', WORD_BIT: '32',
  FLT_MIN: '1.175494351e-38F', FLT_DIG: '6', DBL_DIG: '15', FLT_MANT_DIG: '24', DBL_MANT_DIG: '53', FLT_RADIX: '2', FLT_MAX_EXP: '128', DBL_MAX_EXP: '1024', FLT_MIN_EXP: '(-125)', DBL_MIN_EXP: '(-1021)',
  FLT_MAX_10_EXP: '38', DBL_MAX_10_EXP: '308', LDBL_MAX: '1.7976931348623157e308', LDBL_MIN: '2.2250738585072014e-308', LDBL_EPSILON: '2.220446049250313e-16', LDBL_DIG: '15', DECIMAL_DIG: '17', FLT_TRUE_MIN: '1.40129846e-45F', DBL_TRUE_MIN: '4.9406564584124654e-324',
  M_PI_2: '1.57079632679489661923', M_PI_4: '0.78539816339744830962', M_1_PI: '0.31830988618379067154', M_2_PI: '0.63661977236758134308', M_LN10: '2.30258509299404568402', M_LOG2E: '1.4426950408889634074', M_LOG10E: '0.43429448190325182765', M_SQRT1_2: '0.70710678118654752440',
  __bool_true_false_are_defined: '1', EDOM: '33', ERANGE: '34', EINVAL: '22', ENOMEM: '12', SEEK_SET: '0', SEEK_CUR: '1', SEEK_END: '2', BUFSIZ: '8192',
};
const PREDEF_FN = { INT8_C: 'x', INT16_C: 'x', INT32_C: 'x', UINT8_C: 'x', UINT16_C: 'x', UINT32_C: 'x ## U', INT64_C: 'x ## L', UINT64_C: 'x ## UL', INTMAX_C: 'x ## L', UINTMAX_C: 'x ## UL',
  isnan: '__isnan(x)', isinf: '__isinf(x)', isfinite: '__isfinite(x)', signbit: '__signbit(x)' };
function tokText(t) { return t.s != null ? t.s : String(t.v); }

const LB = 1000000; // line numbers are encoded as fileIndex * LB + line
const hasOwn = (o, k) => o != null && Object.prototype.hasOwnProperty.call(o, k);
function preprocess(src, ctx) {
  ctx = ctx || { files: null, fileNames: ['main.c'], idx: 0 };
  const macros = new Map();
  for (const name in PREDEF) { const b = []; lexLine(PREDEF[name], 0, b); macros.set(name, { body: b }); }
  for (const name in PREDEF_FN) { const b = []; lexLine(PREDEF_FN[name], 0, b); macros.set(name, { params: ['x'], body: b }); }
  const defAssert = (off) => { const b = []; lexLine(off ? '((void)0)' : '((e) ? (void)0 : __assert_fail(#e, __LINE__, __FILE__))', 0, b); macros.set('assert', { params: ['e'], body: b }); };
  defAssert(false);
  for (const [nm, ps, body] of [['va_start', ['ap', 'last'], '__va_start(&(ap))'], ['va_end', ['ap'], '__va_end(&(ap))'], ['va_copy', ['d', 's'], '__va_copy(&(d), (s))'], ['static_assert', ['e', 'm'], '_Static_assert(e, m)']]) { const b = []; lexLine(body, 0, b); macros.set(nm, { params: ps, body: b }); }
  const result = []; let pend = [];
  const once = new Set(); let incDepth = 0;

  function expand(tl, hide) {
    const res = [];
    for (let i2 = 0; i2 < tl.length; i2++) {
      const tk = tl[i2];
      if (tk.t === 'id' && (tk.v === '__LINE__' || tk.v === '__FILE__') && !macros.has(tk.v)) {
        if (tk.v === '__LINE__') res.push({ t: 'num', v: tk.line % LB, type: T.int, line: tk.line, s: String(tk.line % LB) });
        else { const fname = ctx.fileNames[Math.floor(tk.line / LB)] || 'main.c'; res.push({ t: 'str', v: utf8(fname), line: tk.line, s: JSON.stringify(fname) }); }
        continue;
      }
      if (tk.t === 'id' && macros.has(tk.v) && !hide.has(tk.v)) {
        const m = macros.get(tk.v);
        if (!m.params) {
          const h = new Set(hide); h.add(tk.v);
          for (const x of expand(m.body.map(b => Object.assign({}, b, { line: tk.line })), h)) res.push(x);
          continue;
        }
        const nx = tl[i2 + 1];
        if (nx && nx.t === 'p' && nx.v === '(') {
          let j = i2 + 2, depth = 0; let args = [[]];
          for (; j < tl.length; j++) {
            const a = tl[j];
            if (a.t === 'p') {
              if (a.v === '(' || a.v === '[' || a.v === '{') depth++;
              else if (a.v === ')' || a.v === ']' || a.v === '}') { if (depth === 0) break; depth--; }
              else if (a.v === ',' && depth === 0) { args.push([]); continue; }
            }
            args[args.length - 1].push(a);
          }
          if (j >= tl.length) cerr('宏 ' + tk.v + ' 的参数没有闭合', tk.line);
          if (m.params.length === 0 && args.length === 1 && args[0].length === 0) args = [];
          const vi = m.params.indexOf('__VA_ARGS__');
          if (vi >= 0 && vi === m.params.length - 1 && args.length > m.params.length) { const rest = args.splice(vi); const joined = []; rest.forEach((r, k) => { if (k) joined.push({ t: 'p', v: ',', line: tk.line, s: ',' }); for (const x of r) joined.push(x); }); args.push(joined); }
          if (vi >= 0 && args.length === m.params.length - 1) args.push([]);
          if (args.length !== m.params.length && !(m.params.length === 1 && args.length === 0)) cerr('宏 ' + tk.v + ' 的参数个数不对', tk.line);
          const body = [];
          for (let k = 0; k < m.body.length; k++) {
            const b = m.body[k];
            if (b.t === 'p' && b.v === '#' && m.body[k + 1]) {
              const pi = m.params.indexOf(m.body[k + 1].v);
              if (pi >= 0) { const txt = (args[pi] || []).map(tokText).join(' '); body.push({ t: 'str', v: utf8(txt), line: tk.line, s: JSON.stringify(txt) }); k++; continue; }
            }
            const pi = b.t === 'id' ? m.params.indexOf(b.v) : -1;
            if (pi >= 0) {
              const adj = (m.body[k - 1] && m.body[k - 1].v === '##') || (m.body[k + 1] && m.body[k + 1].v === '##');
              const a = args[pi] || [];
              for (const x of (adj ? a : expand(a, hide))) body.push(Object.assign({}, x, { line: tk.line }));
            } else body.push(Object.assign({}, b, { line: tk.line }));
          }
          const pasted = [];
          for (let k = 0; k < body.length; k++) {
            if (body[k].t === 'p' && body[k].v === '##' && pasted.length && body[k + 1]) {
              const prev = pasted.pop(); const txt = tokText(prev) + tokText(body[k + 1]); const nt = []; lexLine(txt, tk.line, nt);
              for (const x of nt) pasted.push(x); k++;
            } else pasted.push(body[k]);
          }
          const h = new Set(hide); h.add(tk.v);
          for (const x of expand(pasted, h)) res.push(x);
          i2 = j; continue;
        }
      }
      res.push(tk);
    }
    return res;
  }
  function flushPend() { if (pend.length) { for (const x of expand(pend, new Set())) result.push(x); pend = []; } }
  function evalIf(tl, ln) {
    const t2 = [];
    for (let k = 0; k < tl.length; k++) {
      if (tl[k].t === 'id' && tl[k].v === 'defined') {
        let name;
        if (tl[k + 1] && tl[k + 1].v === '(') { name = tl[k + 2] && tl[k + 2].v; k += 3; } else { name = tl[k + 1] && tl[k + 1].v; k += 1; }
        t2.push({ t: 'num', v: macros.has(name) ? 1 : 0, type: T.int, line: ln });
      } else t2.push(tl[k]);
    }
    const ex = expand(t2, new Set());
    if (!ex.length) cerr('#if 缺少表达式', ln);
    const p = new Parser(ex); const e = p.parseCond();
    return constEval(e, null, true) ? true : false;
  }
  function processText(src, fidx, fname) {
    const base = fidx * LB;
    // strip comments, keep newlines
    let out = ''; let i = 0; const n = src.length; let nl = 0;
    while (i < n) {
      const c = src[i];
      if (c === '/' && src[i + 1] === '/') { while (i < n && src[i] !== '\n') i++; continue; }
      if (c === '/' && src[i + 1] === '*') {
        const startLine = base + nl + 1; i += 2;
        while (i < n && !(src[i] === '*' && src[i + 1] === '/')) { if (src[i] === '\n') { out += '\n'; nl++; } i++; }
        if (i >= n) cerr('注释 /* 没有闭合', startLine);
        i += 2; out += ' '; continue;
      }
      if (c === '"' || c === "'") {
        const q = c; out += c; i++;
        while (i < n && src[i] !== q && src[i] !== '\n') { if (src[i] === '\\' && i + 1 < n && src[i + 1] !== '\n') { out += src[i] + src[i + 1]; i += 2; continue; } out += src[i++]; }
        if (i < n && src[i] === q) { out += q; i++; }
        continue;
      }
      if (c === '\n') nl++;
      out += c; i++;
    }
    const raw = out.split('\n');
    const lines = [];
    for (let k = 0; k < raw.length; k++) {
      let text = raw[k]; const ln = base + k + 1;
      while (/\\\s*$/.test(text) && k + 1 < raw.length) { text = text.replace(/\\\s*$/, '') + ' ' + raw[++k]; }
      lines.push([text, ln]);
    }
    const cond = [];
    const active = () => cond.length === 0 || cond[cond.length - 1].act;
    for (const [text, ln] of lines) {
      const tr = text.replace(/^\s+/, '');
      if (tr[0] === '#') {
        const lt = []; lexLine(tr.slice(1), ln, lt);
        const d = lt[0] ? lt[0].v : '';
        if (d === 'if' || d === 'ifdef' || d === 'ifndef') {
          const par = active(); let v = false;
          if (par) { if (d === 'if') v = evalIf(lt.slice(1), ln); else { if (!lt[1]) cerr('#' + d + ' 缺少宏名', ln); v = macros.has(lt[1].v) === (d === 'ifdef'); } }
          cond.push({ act: par && v, taken: v, par }); continue;
        }
        if (d === 'elif') { const c = cond[cond.length - 1]; if (!c) cerr('#elif 没有对应的 #if', ln); if (c.taken || !c.par) c.act = false; else { const v = evalIf(lt.slice(1), ln); c.act = v; c.taken = v; } continue; }
        if (d === 'else') { const c = cond[cond.length - 1]; if (!c) cerr('#else 没有对应的 #if', ln); c.act = c.par && !c.taken; c.taken = true; continue; }
        if (d === 'endif') { if (!cond.length) cerr('#endif 没有对应的 #if', ln); cond.pop(); continue; }
        if (!active()) continue;
        flushPend();
        if (d === 'define') {
          const nm = lt[1]; if (!nm || nm.t !== 'id') cerr('#define 缺少宏名', ln);
          if (lt[2] && lt[2].t === 'p' && lt[2].v === '(' && !lt[2].sp) {
            const params = []; let k = 3;
            while (k < lt.length && lt[k].v !== ')') { if (lt[k].t === 'id') params.push(lt[k].v); else if (lt[k].v === '...') params.push('__VA_ARGS__'); k++; }
            macros.set(nm.v, { params, body: lt.slice(k + 1) });
          } else macros.set(nm.v, { body: lt.slice(2) });
          continue;
        }
        if (d === 'undef') { if (lt[1]) macros.delete(lt[1].v); continue; }
        if (d === 'include') {
          const rest = tr.slice(1).replace(/^\s*include\s*/, '');
          const m = /^<([^>]+)>/.exec(rest) || /^"([^"]+)"/.exec(rest);
          if (!m) cerr('#include 格式错误', ln);
          const name = m[1].trim(), angle = rest[0] === '<';
          let key = hasOwn(ctx.files, name) ? name : null;
          if (key == null && ctx.files && name.indexOf('/') >= 0) { const bn = name.slice(name.lastIndexOf('/') + 1); if (hasOwn(ctx.files, bn)) key = bn; }
          if (key != null && !(angle && HEADERS.has(name))) {
            if (once.has(key)) continue;
            if (++incDepth > 64) cerr('头文件嵌套包含太深（可能存在循环包含）', ln);
            processText(String(ctx.files[key]), ctx.fileNames.indexOf(key), key);
            incDepth--; continue;
          }
          if (HEADERS.has(name)) { if (name === 'assert.h') defAssert(macros.has('NDEBUG')); continue; }
          if (angle) cerr('不支持的头文件 <' + name + '>', ln);
          if (ctx.files && Object.keys(ctx.files).length) cerr('找不到头文件 "' + name + '"（文件列表中没有这个文件）', ln);
          cerr('不支持自定义头文件 "' + name + '"（浏览器中只有一个源文件）', ln);
        }
        if (d === 'error') cerr('#error ' + lt.slice(1).map(tokText).join(' '), ln);
        if (d === 'pragma') { if (lt[1] && lt[1].v === 'once') once.add(fname); continue; }
        if (d === 'line' || d === 'warning' || d === '') continue;
        cerr('未知的预处理指令 #' + d, ln);
      }
      if (!active()) continue;
      lexLine(text, ln, pend);
    }
    if (cond.length) cerr('#if 缺少对应的 #endif', base + lines.length);
    flushPend();
  }
  processText(src, ctx.idx || 0, ctx.fileNames[ctx.idx || 0]);
  flushPend();
  return result;
}

// ---------------- parser ----------------
const TYPEKW = new Set(['void', 'char', 'short', 'int', 'long', 'float', 'double', 'signed', 'unsigned', '_Bool', 'struct', 'union', 'enum', 'const', 'volatile', 'static', 'extern', 'register', 'inline', 'auto', 'typedef', 'restrict', '__inline', '__restrict']);
const KW = new Set([...TYPEKW, 'if', 'else', 'while', 'for', 'do', 'return', 'break', 'continue', 'switch', 'case', 'default', 'sizeof', 'goto']);
const ASSIGN = new Set(['=', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '<<=', '>>=']);
const BINP = { '||': 1, '&&': 2, '|': 3, '^': 4, '&': 5, '==': 6, '!=': 6, '<': 7, '>': 7, '<=': 7, '>=': 7, '<<': 8, '>>': 8, '+': 9, '-': 9, '*': 10, '/': 10, '%': 10 };
const PRE_TYPEDEFS = [['size_t', T.ulong], ['ssize_t', T.long], ['ptrdiff_t', T.long], ['intptr_t', T.long], ['uintptr_t', T.ulong],
  ['int8_t', T.char], ['uint8_t', T.uchar], ['int16_t', T.short], ['uint16_t', T.ushort], ['int32_t', T.int], ['uint32_t', T.uint],
  ['int64_t', T.long], ['uint64_t', T.ulong], ['intmax_t', T.long], ['uintmax_t', T.ulong],
  ['int_least8_t', T.char], ['uint_least8_t', T.uchar], ['int_least16_t', T.short], ['uint_least16_t', T.ushort], ['int_least32_t', T.int], ['uint_least32_t', T.uint], ['int_least64_t', T.long], ['uint_least64_t', T.ulong],
  ['int_fast8_t', T.char], ['uint_fast8_t', T.uchar], ['int_fast16_t', T.long], ['uint_fast16_t', T.ulong], ['int_fast32_t', T.long], ['uint_fast32_t', T.ulong], ['int_fast64_t', T.long], ['uint_fast64_t', T.ulong],
  ['off_t', T.long], ['errno_t', T.int], ['time_t', T.long], ['clock_t', T.long], ['FILE', T.void], ['wchar_t', T.int], ['va_list', ptr(T.void)]];
function tokDesc(t) { return t.t === 'eof' ? '文件末尾' : tokText(t); }

class Parser {
  constructor(toks) {
    this.toks = toks; this.p = 0; this.last = null;
    this.typedefs = new Map(PRE_TYPEDEFS); this.tags = new Map(); this.enums = new Map();
    this.eof = { t: 'eof', v: '', line: toks.length ? toks[toks.length - 1].line : 1 };
  }
  peek(o) { return this.toks[this.p + (o || 0)] || this.eof; }
  next() { const t = this.peek(); if (t !== this.eof) this.p++; this.last = t; cLine = t.line; return t; }
  is(v, o) { const t = this.peek(o); return (t.t === 'p' || t.t === 'id') && t.v === v; }
  accept(v) { if (this.is(v)) { this.next(); return true; } return false; }
  expect(v) {
    if (!this.accept(v)) {
      const ln = (v === ';' || v === ')') && this.last ? this.last.line : this.peek().line;
      cerr("缺少 '" + v + "'（在 '" + tokDesc(this.peek()) + "' 之前）", ln);
    }
  }
  isTypeStart(t) { t = t || this.peek(); return t.t === 'id' && (TYPEKW.has(t.v) || this.typedefs.has(t.v)); }
  constExpr() { return constEval(this.parseCond(), this, false); }

  parseSpecs() {
    let storage = null, base = null, nlong = 0, uns = null, short = false, sawInt = false, sawChar = false, any = false;
    for (;;) {
      const t = this.peek(); if (t.t !== 'id') break; const v = t.v;
      if (v === 'typedef' || v === 'static' || v === 'extern' || v === 'register' || v === 'auto') { this.next(); if (v === 'typedef' || v === 'static' || v === 'extern') storage = v; any = true; continue; }
      if (v === 'const' || v === 'volatile' || v === 'inline' || v === 'restrict' || v === '__inline' || v === '__restrict') { this.next(); any = true; continue; }
      if (v === 'unsigned') { this.next(); uns = true; any = true; continue; }
      if (v === 'signed') { this.next(); uns = false; any = true; continue; }
      if (v === 'long') { this.next(); nlong++; any = true; continue; }
      if (v === 'short') { this.next(); short = true; any = true; continue; }
      if (v === 'int') { this.next(); sawInt = true; any = true; continue; }
      if (v === 'char') { this.next(); sawChar = true; any = true; continue; }
      if (v === 'void' || v === 'float' || v === 'double' || v === '_Bool') { this.next(); base = v === 'void' ? T.void : v === 'float' ? T.float : v === 'double' ? T.double : T.bool; any = true; continue; }
      if (v === 'struct' || v === 'union') { base = this.parseStruct(); any = true; continue; }
      if (v === 'enum') { base = this.parseEnum(); any = true; continue; }
      if (!base && !sawInt && !sawChar && !nlong && !short && uns === null && this.typedefs.has(v)) { this.next(); base = this.typedefs.get(v); any = true; continue; }
      break;
    }
    if (!any) return null;
    if (!base) {
      if (sawChar) base = uns ? T.uchar : T.char;
      else if (short) base = uns ? T.ushort : T.short;
      else if (nlong) base = uns ? T.ulong : T.long;
      else base = uns ? T.uint : T.int;
    }
    return { base, storage };
  }
  parseStruct() {
    const isU = this.next().v === 'union'; let tag = null;
    if (this.peek().t === 'id' && !KW.has(this.peek().v)) tag = this.next().v;
    const key = (isU ? 'u:' : 's:') + tag;
    let st = tag ? this.tags.get(key) : null;
    if (this.is('{')) {
      if (!st || st.complete) { st = { k: 'struct', tag, union: isU, fields: [], complete: false, size: 0, align: 1 }; if (tag) this.tags.set(key, st); }
      this.next();
      const fields = [];
      while (!this.accept('}')) {
        if (this.peek().t === 'eof') cerr('结构体定义缺少 }');
        const sp = this.parseSpecs(); if (!sp) cerr("结构体成员声明错误：'" + tokDesc(this.peek()) + "'");
        if (this.accept(';')) { if (sp.base.k === 'struct' && sp.base.complete && !sp.base.tag) fields.push({ name: null, type: sp.base }); continue; }
        do {
          const d = this.parseDeclarator(true); const ft = d.apply(sp.base); let bitw = null;
          if (this.accept(':')) {
            bitw = this.constExpr();
            if (ft.k !== 'int') cerr("位域 '" + (d.name || '') + "' 必须是整数类型");
            if (!(bitw >= 0) || bitw !== Math.floor(bitw)) cerr('位域宽度必须是非负整数');
            if (bitw > ft.size * 8) cerr("位域 '" + (d.name || '') + "' 的宽度 " + bitw + ' 超过了类型 ' + typeName(ft) + ' 的位数');
            if (bitw === 0 && d.name) cerr("有名字的位域 '" + d.name + "' 宽度不能为 0");
          } else if (!d.name) cerr("缺少名称（在 '" + tokDesc(this.peek()) + "' 之前）");
          if (isVla(ft)) cerr('结构体成员不能是变长数组');
          fields.push({ name: d.name, type: ft, bitw });
        } while (this.accept(','));
        this.expect(';');
      }
      let boff = 0, al = 1; const flat = []; // boff: current offset in bits
      for (const f of fields) {
        const a = alignOf(f.type), s = sizeOf(f.type);
        if (f.bitw != null) {
          const U = s * 8;
          if (f.bitw === 0) { if (!isU) boff = alignUp(boff, U); continue; }
          let start = isU ? 0 : boff;
          if (Math.floor(start / U) !== Math.floor((start + f.bitw - 1) / U)) start = alignUp(start, U);
          const unit = Math.floor(start / U) * s;
          if (f.name !== null) { flat.push({ name: f.name, type: f.type, off: unit, bits: { pos: start - unit * 8, w: f.bitw, us: s } }); al = Math.max(al, a); }
          boff = isU ? Math.max(boff, f.bitw) : start + f.bitw;
          continue;
        }
        const fo = isU ? 0 : alignUp(Math.ceil(boff / 8), a);
        if (f.name === null) { for (const sf of f.type.fields) flat.push({ name: sf.name, type: sf.type, off: fo + sf.off, bits: sf.bits }); }
        else flat.push({ name: f.name, type: f.type, off: fo });
        boff = isU ? Math.max(boff, s * 8) : (fo + s) * 8;
        al = Math.max(al, a);
      }
      st.fields = flat; st.align = al; st.size = alignUp(Math.max(Math.ceil(boff / 8), 1), al); st.complete = true;
      return st;
    }
    if (!tag) cerr('结构体缺少名字或定义');
    if (!st) { st = { k: 'struct', tag, union: isU, fields: [], complete: false, size: 0, align: 1 }; this.tags.set(key, st); }
    return st;
  }
  parseEnum() {
    this.next(); if (this.peek().t === 'id' && !KW.has(this.peek().v)) this.next();
    if (this.accept('{')) {
      let v = 0;
      while (!this.accept('}')) {
        const nt = this.next(); if (nt.t !== 'id') cerr('枚举常量名错误');
        if (this.accept('=')) v = this.constExpr();
        this.enums.set(nt.v, v); v++;
        if (!this.accept(',')) { this.expect('}'); break; }
      }
    }
    return T.int;
  }
  parseDeclarator(abstract) {
    let ptrs = 0;
    while (this.accept('*')) { ptrs++; while (this.is('const') || this.is('volatile') || this.is('restrict') || this.is('__restrict')) this.next(); }
    let name = null, inner = null; const line = this.peek().line;
    if (this.peek().t === 'id' && !KW.has(this.peek().v)) name = this.next().v;
    else if (this.is('(') && (this.is('*', 1) || this.is('(', 1))) { this.next(); inner = this.parseDeclarator(abstract); this.expect(')'); name = inner.name; }
    const suf = [];
    for (;;) {
      if (this.accept('[')) {
        while (this.is('static') || this.is('const')) this.next();
        if (this.accept(']')) suf.push({ a: true, n: null });
        else if (this.is('*') && this.is(']', 1)) { this.next(); this.next(); suf.push({ a: true, n: null }); }
        else {
          const e = this.parseAssign(); let n = null, vexpr = null;
          try { n = constEval(e, this, false); } catch (er) { if (!(er instanceof CErr)) throw er; vexpr = e; }
          if (vexpr == null && !(n >= 0)) cerr('数组大小必须是非负整数');
          if (vexpr == null && n !== Math.floor(n)) cerr('数组大小必须是整数');
          this.expect(']'); suf.push({ a: true, n, vexpr });
        }
      } else if (this.is('(')) { this.next(); suf.push({ f: this.parseParams() }); }
      else break;
    }
    if (!name && !abstract) cerr("缺少名称（在 '" + tokDesc(this.peek()) + "' 之前）");
    return {
      name, line, inner,
      apply: (base) => {
        let t = base;
        for (let i = 0; i < ptrs; i++) t = ptr(t);
        for (let i = suf.length - 1; i >= 0; i--) {
          const s = suf[i];
          if (s.a) { t = arr(t, s.n); if (s.vexpr) t.vexpr = s.vexpr; }
          else t = { k: 'func', ret: t, params: s.f.params, names: s.f.names, variadic: s.f.variadic, unspecified: s.f.unspecified, size: 1 };
        }
        if (inner) t = inner.apply(t);
        return t;
      }
    };
  }
  parseParams() {
    const params = [], names = []; let variadic = false;
    if (this.accept(')')) return { params, names, variadic: false, unspecified: true };
    if (this.is('void') && this.is(')', 1)) { this.next(); this.next(); return { params, names, variadic: false }; }
    do {
      if (this.accept('...')) { variadic = true; break; }
      const sp = this.parseSpecs(); if (!sp) cerr("参数类型错误：'" + tokDesc(this.peek()) + "'");
      const d = this.parseDeclarator(true); let t = d.apply(sp.base);
      if (t.k === 'arr') t = ptr(t.of); else if (t.k === 'func') t = ptr(t);
      params.push(t); names.push(d.name);
    } while (this.accept(','));
    this.expect(')');
    return { params, names, variadic };
  }
  parseTypeName() { const sp = this.parseSpecs(); if (!sp) cerr('需要类型名'); return this.parseDeclarator(true).apply(sp.base); }

  parseStaticAssert() {
    const line = this.next().line; this.expect('('); const v = this.constExpr(); let msg = '';
    if (this.accept(',')) { const st = this.next(); if (st.t !== 'str') cerr('_Static_assert 的第二个参数必须是字符串'); msg = new TextDecoder().decode(new Uint8Array(st.v)); }
    this.expect(')'); this.expect(';');
    if (!v) cerr('静态断言失败' + (msg ? '：' + msg : ''), line);
    return { k: 'empty', line };
  }
  parseProgram() {
    const items = [];
    while (this.peek().t !== 'eof') {
      if (this.accept(';')) continue;
      if (this.is('_Static_assert')) { this.parseStaticAssert(); continue; }
      if (!this.isTypeStart()) {
        // allow old-style implicit int "main() {...}"
        if (this.peek().t === 'id' && this.is('(', 1)) { items.push(this.parseDecl(true, { base: T.int, storage: null })); continue; }
        cerr("无法识别的声明：'" + tokDesc(this.peek()) + "'");
      }
      items.push(this.parseDecl(true));
    }
    return items;
  }
  parseDecl(top, spIn) {
    const line = this.peek().line;
    const sp = spIn || this.parseSpecs();
    if (this.accept(';')) return { k: 'decl', decls: [], line };
    const decls = [];
    do {
      const d = this.parseDeclarator(false); const t = d.apply(sp.base);
      if (t.k === 'func' && this.is('{')) {
        if (!top) cerr('不能在函数内部定义函数');
        if (decls.length) cerr('函数定义格式错误');
        const body = this.parseBlock();
        return { k: 'func', name: d.name, type: t, body, line: d.line, storage: sp.storage };
      }
      if (sp.storage === 'typedef') { this.typedefs.set(d.name, t); continue; }
      let init = null; if (this.accept('=')) init = this.parseInit();
      decls.push({ name: d.name, type: t, init, storage: sp.storage, line: d.line });
    } while (this.accept(','));
    this.expect(';');
    return { k: 'decl', decls, line };
  }
  parseInit() {
    const line = this.peek().line;
    if (this.accept('{')) {
      const items = [];
      while (!this.accept('}')) {
        let desig = null;
        if (this.is('.') || this.is('[')) {
          desig = [];
          for (;;) {
            if (this.accept('.')) { const nt = this.next(); if (nt.t !== 'id') cerr("'.' 后面需要成员名"); desig.push({ field: nt.v }); }
            else if (this.accept('[')) {
              const idx = this.constExpr(); let end = null;
              if (this.accept('...')) end = this.constExpr();
              if (!(idx >= 0) || (end != null && end < idx)) cerr('指定初始化的数组下标无效');
              this.expect(']'); desig.push({ index: idx, end });
            } else break;
          }
          this.expect('=');
        }
        const it = this.parseInit(); it.desig = desig; items.push(it);
        if (!this.accept(',')) { this.expect('}'); break; }
      }
      return { k: 'init', items, line };
    }
    return this.parseAssign();
  }
  parseBlock() {
    const line = this.peek().line; this.expect('{'); const items = [];
    while (!this.accept('}')) { if (this.peek().t === 'eof') cerr("缺少 '}'", this.last ? this.last.line : line); items.push(this.parseStmt()); }
    return { k: 'block', items, line };
  }
  parseStmt() {
    const t = this.peek(), line = t.line;
    if (t.t === 'p' && t.v === '{') return this.parseBlock();
    if (t.t === 'p' && t.v === ';') { this.next(); return { k: 'empty', line }; }
    if (t.t === 'id') {
      switch (t.v) {
        case 'if': { this.next(); this.expect('('); const c = this.parseExpr(); this.expect(')'); const th = this.parseStmt(); const el = this.accept('else') ? this.parseStmt() : null; return { k: 'if', c, t: th, f: el, line }; }
        case 'while': { this.next(); this.expect('('); const c = this.parseExpr(); this.expect(')'); return { k: 'while', c, body: this.parseStmt(), line }; }
        case 'do': { this.next(); const body = this.parseStmt(); if (!this.accept('while')) cerr("do 语句缺少 'while'"); this.expect('('); const c = this.parseExpr(); this.expect(')'); this.expect(';'); return { k: 'do', c, body, line }; }
        case 'for': {
          this.next(); this.expect('(');
          let init = null;
          if (!this.accept(';')) { if (this.isTypeStart()) init = this.parseDecl(false); else { init = { k: 'expr', e: this.parseExpr(), line }; this.expect(';'); } }
          const c = this.is(';') ? null : this.parseExpr(); this.expect(';');
          const step = this.is(')') ? null : this.parseExpr(); this.expect(')');
          return { k: 'for', init, c, step, body: this.parseStmt(), line };
        }
        case 'return': { this.next(); const e = this.is(';') ? null : this.parseExpr(); this.expect(';'); return { k: 'ret', e, line }; }
        case 'break': this.next(); this.expect(';'); return { k: 'break', line };
        case 'continue': this.next(); this.expect(';'); return { k: 'cont', line };
        case 'switch': { this.next(); this.expect('('); const e = this.parseExpr(); this.expect(')'); return { k: 'switch', e, body: this.parseStmt(), line }; }
        case 'case': { this.next(); const v = this.constExpr(); this.expect(':'); const s = this.is('}') ? { k: 'empty', line } : this.parseStmt(); return { k: 'case', v, stmt: s, line }; }
        case 'default': { this.next(); this.expect(':'); const s = this.is('}') ? { k: 'empty', line } : this.parseStmt(); return { k: 'default', stmt: s, line }; }
        case '_Static_assert': return this.parseStaticAssert();
        case 'goto': { this.next(); const nt = this.next(); if (nt.t !== 'id' || KW.has(nt.v)) cerr('goto 后面需要标签名'); this.expect(';'); return { k: 'goto', name: nt.v, line }; }
      }
      if (this.isTypeStart()) return this.parseDecl(false);
      if (this.is(':', 1) && !KW.has(t.v)) { this.next(); this.next(); const s = this.is('}') ? { k: 'empty', line } : this.parseStmt(); return { k: 'label', name: t.v, stmt: s, line }; }
    }
    const e = this.parseExpr(); this.expect(';');
    return { k: 'expr', e, line };
  }
  parseExpr() { let e = this.parseAssign(); while (this.is(',')) { const line = this.next().line; e = { k: 'comma', a: e, b: this.parseAssign(), line }; } return e; }
  parseAssign() {
    const a = this.parseCond(); const t = this.peek();
    if (t.t === 'p' && ASSIGN.has(t.v)) { this.next(); return { k: 'assign', op: t.v, a, b: this.parseAssign(), line: t.line }; }
    return a;
  }
  parseCond() {
    const c = this.parseBin(1);
    if (this.is('?')) { const line = this.next().line; const a = this.parseExpr(); this.expect(':'); const b = this.parseCond(); return { k: 'cond', c, a, b, line }; }
    return c;
  }
  parseBin(min) {
    let a = this.parseUnary();
    for (;;) {
      const t = this.peek(); const pr = t.t === 'p' ? BINP[t.v] : undefined;
      if (!pr || pr < min) return a;
      this.next(); const b = this.parseBin(pr + 1);
      a = { k: 'bin', op: t.v, a, b, line: t.line };
    }
  }
  parseUnary() {
    const t = this.peek(), line = t.line;
    if (t.t === 'p') {
      if (t.v === '++' || t.v === '--') { this.next(); return { k: 'pre', op: t.v, a: this.parseUnary(), line }; }
      if (t.v.length === 1 && '&*+-!~'.indexOf(t.v) >= 0) { this.next(); return { k: 'un', op: t.v, a: this.parseUnary(), line }; }
      if (t.v === '(' && this.isTypeStart(this.peek(1))) {
        this.next(); const ty = this.parseTypeName(); this.expect(')');
        if (this.is('{')) return this.parsePostfix({ k: 'compound', type: ty, init: this.parseInit(), line });
        return { k: 'cast', type: ty, a: this.parseUnary(), line };
      }
    }
    if (t.t === 'id' && t.v === 'sizeof') {
      this.next();
      if (this.is('(') && this.isTypeStart(this.peek(1))) {
        this.next(); const ty = this.parseTypeName(); this.expect(')');
        if (this.is('{')) return { k: 'sizeof_e', a: this.parsePostfix({ k: 'compound', type: ty, init: this.parseInit(), line }), line };
        return { k: 'sizeof_t', type: ty, line };
      }
      return { k: 'sizeof_e', a: this.parseUnary(), line };
    }
    return this.parsePostfix();
  }
  parsePostfix(e0) {
    let e = e0 || this.parsePrimary();
    for (;;) {
      const t = this.peek(); if (t.t !== 'p') return e;
      if (t.v === '[') { this.next(); const i = this.parseExpr(); this.expect(']'); e = { k: 'idx', a: e, i, line: t.line }; }
      else if (t.v === '(') { this.next(); const args = []; if (!this.accept(')')) { do { args.push(this.parseAssign()); } while (this.accept(',')); this.expect(')'); } e = { k: 'call', f: e, args, line: t.line }; }
      else if (t.v === '.' || t.v === '->') { this.next(); const n = this.next(); if (n.t !== 'id') cerr("'" + t.v + "' 后面需要成员名"); e = { k: 'mem', a: e, name: n.v, arrow: t.v === '->', line: t.line }; }
      else if (t.v === '++' || t.v === '--') { this.next(); e = { k: 'post', op: t.v, a: e, line: t.line }; }
      else return e;
    }
  }
  parsePrimary() {
    const t = this.next();
    if (t.t === 'num') return { k: 'num', v: t.v, type: t.type, line: t.line };
    if (t.t === 'chr') return { k: 'num', v: t.v, type: T.int, line: t.line };
    if (t.t === 'str') { let bytes = t.v.slice(); while (this.peek().t === 'str') bytes = bytes.concat(this.next().v); return { k: 'str', v: bytes, line: t.line }; }
    if (t.t === 'id' && t.v === 'va_arg' && this.is('(')) {
      this.next(); const ap = this.parseAssign(); this.expect(','); const type = this.parseTypeName(); this.expect(')');
      return { k: 'va_arg', ap, type, line: t.line };
    }
    if (t.t === 'id' && !KW.has(t.v)) return { k: 'id', name: t.v, line: t.line };
    if (t.t === 'p' && t.v === '(') { const e = this.parseExpr(); this.expect(')'); return e; }
    cerr("表达式错误：意外的 '" + tokDesc(t) + "'", t.line);
  }
}

function constEval(e, P, idZero) {
  const ev = x => constEval(x, P, idZero);
  switch (e.k) {
    case 'num': return e.v;
    case 'id': if (P && P.enums.has(e.name)) return P.enums.get(e.name); if (idZero) return 0; cerr("'" + e.name + "' 不是常量", e.line); break;
    case 'un': { const v = ev(e.a); switch (e.op) { case '-': return -v; case '+': return v; case '!': return v ? 0 : 1; case '~': return ~v; } break; }
    case 'bin': {
      const a = ev(e.a);
      if (e.op === '&&') return a && ev(e.b) ? 1 : 0;
      if (e.op === '||') return a || ev(e.b) ? 1 : 0;
      const b = ev(e.b);
      switch (e.op) {
        case '+': return a + b; case '-': return a - b; case '*': return a * b;
        case '/': if (b === 0) cerr('常量表达式除以零', e.line); return Number.isInteger(a) && Number.isInteger(b) ? Math.trunc(a / b) : a / b;
        case '%': if (b === 0) cerr('常量表达式除以零', e.line); return a % b;
        case '<<': return a * Math.pow(2, b); case '>>': return Math.floor(a / Math.pow(2, b));
        case '<': return a < b ? 1 : 0; case '>': return a > b ? 1 : 0; case '<=': return a <= b ? 1 : 0; case '>=': return a >= b ? 1 : 0;
        case '==': return a === b ? 1 : 0; case '!=': return a !== b ? 1 : 0;
        case '&': return a & b; case '|': return a | b; case '^': return a ^ b;
      }
      break;
    }
    case 'cond': return ev(e.c) ? ev(e.a) : ev(e.b);
    case 'cast': { const v = ev(e.a); return isInt(e.type) ? normFor(e.type)(Math.trunc(v)) : v; }
    case 'sizeof_t': return sizeOf(e.type);
    case 'comma': ev(e.a); return ev(e.b);
  }
  cerr('这里需要常量表达式', e.line);
}

// ---------------- compiler + runtime ----------------
const FBASE = 0x40000000;
const SIGS = {
  printf: 'i:c...', fprintf: 'i:pc...', sprintf: 'i:cc...', snprintf: 'i:czc...', puts: 'i:c', fputs: 'i:cp', putchar: 'i:i', putc: 'i:ip', fputc: 'i:ip',
  scanf: 'i:c...', sscanf: 'i:cc...', fscanf: 'i:pc...', getchar: 'i:', getc: 'i:p', fgetc: 'i:p', fgets: 'c:cip', gets: 'c:c', fflush: 'i:p',
  malloc: 'p:z', calloc: 'p:zz', realloc: 'p:pz', free: 'v:p', exit: 'v:i', abort: 'v:', system: 'i:c',
  abs: 'i:i', labs: 'l:l', llabs: 'l:l', atoi: 'i:c', atol: 'l:c', atoll: 'l:c', atof: 'd:c', strtol: 'l:cpi', strtoll: 'l:cpi', strtoul: 'z:cpi', strtod: 'd:cp',
  rand: 'i:', srand: 'v:u', qsort: 'v:pzzp', bsearch: 'p:ppzzp',
  strlen: 'z:c', strcpy: 'c:cc', strncpy: 'c:ccz', strcat: 'c:cc', strncat: 'c:ccz', strcmp: 'i:cc', strncmp: 'i:ccz', strchr: 'c:ci', strrchr: 'c:ci', strstr: 'c:cc', strdup: 'c:c',
  memset: 'p:piz', memcpy: 'p:ppz', memmove: 'p:ppz', memcmp: 'i:ppz',
  isdigit: 'i:i', isalpha: 'i:i', isalnum: 'i:i', isspace: 'i:i', isupper: 'i:i', islower: 'i:i', ispunct: 'i:i', isxdigit: 'i:i', isprint: 'i:i', toupper: 'i:i', tolower: 'i:i',
  sqrt: 'd:d', sin: 'd:d', cos: 'd:d', tan: 'd:d', asin: 'd:d', acos: 'd:d', atan: 'd:d', exp: 'd:d', log: 'd:d', log10: 'd:d', log2: 'd:d', floor: 'd:d', ceil: 'd:d', fabs: 'd:d', round: 'd:d', trunc: 'd:d', cbrt: 'd:d', sinh: 'd:d', cosh: 'd:d', tanh: 'd:d',
  sqrtf: 'f:f', fabsf: 'f:f', floorf: 'f:f', ceilf: 'f:f', powf: 'f:ff',
  pow: 'd:dd', atan2: 'd:dd', fmod: 'd:dd', hypot: 'd:dd', fmax: 'd:dd', fmin: 'd:dd',
  time: 'l:p', clock: 'l:', assert: 'v:i', getpid: 'i:', sleep: 'i:u', Sleep: 'v:u', usleep: 'i:u',
  strtoull: 'z:cpi', strtof: 'f:cp', strtold: 'd:cp', strtok: 'c:cc', strspn: 'z:cc', strcspn: 'z:cc', strpbrk: 'c:cc', memchr: 'p:piz', strnlen: 'z:cz',
  strcasecmp: 'i:cc', strncasecmp: 'i:ccz', stricmp: 'i:cc', strerror: 'c:i', perror: 'v:c', fwrite: 'z:pzzp', ungetc: 'i:ip', atexit: 'i:p',
  __va_start: 'v:p', __va_end: 'v:p', __va_copy: 'v:pp', vprintf: 'i:cp', vfprintf: 'i:pcp', vsprintf: 'i:ccp', vsnprintf: 'i:czcp',
  isgraph: 'i:i', iscntrl: 'i:i', isblank: 'i:i', isascii: 'i:i', __isnan: 'i:d', __isinf: 'i:d', __isfinite: 'i:d', __signbit: 'i:d', __assert_fail: 'v:cic',
  lround: 'l:d', llround: 'l:d', lrint: 'l:d', rint: 'd:d', nearbyint: 'd:d', exp2: 'd:d', expm1: 'd:d', log1p: 'd:d', asinh: 'd:d', acosh: 'd:d', atanh: 'd:d', fdim: 'd:dd', copysign: 'd:dd', ldexp: 'd:di', modf: 'd:dp', frexp: 'd:dp',
  expf: 'f:f', logf: 'f:f', sinf: 'f:f', cosf: 'f:f', tanf: 'f:f', roundf: 'f:f', truncf: 'f:f', fmodf: 'f:ff', fmaxf: 'f:ff', fminf: 'f:ff', atan2f: 'f:ff', hypotf: 'f:ff', log10f: 'f:f', log2f: 'f:f', cbrtf: 'f:f',
};
const KIND = { v: T.void, i: T.int, u: T.uint, l: T.long, z: T.ulong, d: T.double, f: T.float, p: ptr(T.void), c: ptr(T.char) };
function sigType(sig) {
  const [r, a] = sig.split(':'); const variadic = a.endsWith('...');
  const ps = (variadic ? a.slice(0, -3) : a).split('').map(k => KIND[k]);
  return { k: 'func', ret: KIND[r], params: ps, names: [], variadic, size: 1 };
}

function run(source, stdinText, opts) {
  opts = opts || {};
  const onStdout = opts.onStdout || (() => {});
  const MAXSTEPS = opts.maxSteps || 5e8;
  const MAXDEPTH = opts.maxDepth || 200000;
  const MEMSZ = 16 * 1024 * 1024, STACK_LIMIT = MEMSZ - 4 * 1024 * 1024;
  const buf = new ArrayBuffer(MEMSZ), dv = new DataView(buf), u8 = new Uint8Array(buf);
  const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
  const t0 = now();
  let dataTop = 4096, heapTop = 0, fp = MEMSZ, sp = MEMSZ, line = 0, steps = 0, depth = 0, retVal = 0, rs = 1;
  const funcs = [];
  const dec = new TextDecoder('utf-8');
  let ob = [], lastFlush = now(), outTotal = 0;
  function flush(final) {
    if (ob.length) { const s = dec.decode(new Uint8Array(ob), { stream: !final }); ob = []; if (s) onStdout(s); }
    else if (final) { const s = dec.decode(); if (s) onStdout(s); }
    lastFlush = now();
  }
  function outBytes(b) {
    for (let i = 0; i < b.length; i++) ob.push(b[i]);
    outTotal += b.length;
    if (outTotal > 8 * 1024 * 1024) { flush(); rerr('输出过多（超过 8 MB），程序已终止'); }
    if (ob.length > 8192 || now() - lastFlush > 30) flush();
  }
  const onStderr = opts.onStderr || onStdout; const decErr = new TextDecoder('utf-8');
  function errBytes(b) {
    flush(); outTotal += b.length;
    if (outTotal > 8 * 1024 * 1024) rerr('输出过多（超过 8 MB），程序已终止');
    const s = decErr.decode(new Uint8Array(b), { stream: true }); if (s) onStderr(s);
  }
  const outTo = (f, b) => { if (f === 18) errBytes(b); else outBytes(b); };
  let tokSave = 0, errnoAddr = 0; const atexitFns = [];
  const vaStack = [], vaTab = [null], vaFree = [];
  function vaGet(h) { const st = vaTab[h]; if (!st) rerr('va_list 没有用 va_start 初始化'); return st; }
  function vaNew(st) { const h = vaFree.length ? vaFree.pop() : vaTab.length; vaTab[h] = st; return h; }
  function stPtr(a, v) { chk(a, 8); dv.setUint32(a, v, true); dv.setUint32(a + 4, 0, true); }
  const inb = ENC.encode(stdinText || ''); let ip = 0;
  const stdinSrc = { peek: () => ip < inb.length ? inb[ip] : -1, get: () => ip < inb.length ? inb[ip++] : -1 };

  function rerr(m) { throw new CErr('runtime', line, m); }
  function tmo() { rerr('执行超时：可能存在死循环'); }
  function chk(a, n) {
    if (!(a >= 4096 && a + n <= MEMSZ)) {
      if (a === 0) rerr('空指针解引用（访问了 NULL）');
      if (a >= FBASE && a < FBASE + funcs.length) rerr('不能把函数当作数据访问');
      rerr('越界内存访问（地址 0x' + (a >>> 0).toString(16) + '）');
    }
  }
  function loader(t, checked) {
    if (t.k === 'int') {
      switch (t.size) {
        case 1: return t.uns ? (checked ? a => { chk(a, 1); return u8[a]; } : a => u8[a]) : (checked ? a => { chk(a, 1); return dv.getInt8(a); } : a => dv.getInt8(a));
        case 2: return t.uns ? (checked ? a => { chk(a, 2); return dv.getUint16(a, true); } : a => dv.getUint16(a, true)) : (checked ? a => { chk(a, 2); return dv.getInt16(a, true); } : a => dv.getInt16(a, true));
        case 4: return t.uns ? (checked ? a => { chk(a, 4); return dv.getUint32(a, true); } : a => dv.getUint32(a, true)) : (checked ? a => { chk(a, 4); return dv.getInt32(a, true); } : a => dv.getInt32(a, true));
        case 8: return t.uns ? a => { if (checked) chk(a, 8); const hi = dv.getUint32(a + 4, true); if (hi === 0) return dv.getUint32(a, true); return fromB(dv.getBigUint64(a, true)); } : a => { if (checked) chk(a, 8); const lo = dv.getUint32(a, true), hi = dv.getInt32(a + 4, true); if ((hi === 0 && lo < 0x80000000) || (hi === -1 && lo >= 0x80000000)) return hi === 0 ? lo : lo - 4294967296; return fromB(dv.getBigInt64(a, true)); };
      }
    }
    if (t.k === 'float') return t.size === 4 ? (checked ? a => { chk(a, 4); return dv.getFloat32(a, true); } : a => dv.getFloat32(a, true)) : (checked ? a => { chk(a, 8); return dv.getFloat64(a, true); } : a => dv.getFloat64(a, true));
    if (t.k === 'ptr') return checked ? a => { chk(a, 8); return dv.getUint32(a, true); } : a => dv.getUint32(a, true);
    if (t.k === 'arr' || t.k === 'struct' || t.k === 'func') return a => a;
    cerr('不能使用 void 类型的值');
  }
  function storer(t) {
    if (t.k === 'int') {
      if (t.bool) return (a, v) => { chk(a, 1); u8[a] = v ? 1 : 0; };
      switch (t.size) {
        case 1: return (a, v) => { chk(a, 1); u8[a] = lo32(v) & 255; };
        case 2: return (a, v) => { chk(a, 2); dv.setInt16(a, lo32(v), true); };
        case 4: return (a, v) => { chk(a, 4); dv.setInt32(a, lo32(v), true); };
        case 8: return (a, v) => { chk(a, 8); if (typeof v === 'number' && v >= -2147483648 && v <= 4294967295 && Number.isInteger(v)) { dv.setUint32(a, v >>> 0, true); dv.setInt32(a + 4, v < 0 ? -1 : 0, true); } else dv.setBigInt64(a, BigInt.asIntN(64, toB(v)), true); };
      }
    }
    if (t.k === 'float') return t.size === 4 ? (a, v) => { chk(a, 4); dv.setFloat32(a, toN(v), true); } : (a, v) => { chk(a, 8); dv.setFloat64(a, toN(v), true); };
    if (t.k === 'ptr') return (a, v) => { chk(a, 8); dv.setUint32(a, lo32(v) >>> 0, true); dv.setUint32(a + 4, 0, true); };
    cerr('无法给 ' + typeName(t) + ' 类型赋值');
  }
  function stInt(a, size, big) { // big: BigInt
    chk(a, size);
    if (size === 8) dv.setBigInt64(a, BigInt.asIntN(64, big), true);
    else if (size === 4) dv.setInt32(a, Number(BigInt.asIntN(32, big)), true);
    else if (size === 2) dv.setInt16(a, Number(BigInt.asIntN(16, big)), true);
    else u8[a] = Number(BigInt.asUintN(8, big));
  }
  function dalloc(size, al) { dataTop = alignUp(dataTop, Math.max(al || 1, 1)); const a = dataTop; dataTop += Math.max(size, 1); if (dataTop > STACK_LIMIT - 1024 * 1024) cerr('全局数据太大（超过可用内存）'); return a; }
  const strTab = new Map();
  function strAddr(bytes) {
    const key = bytes.join(','); let a = strTab.get(key);
    if (a == null) { a = dalloc(bytes.length + 1, 1); u8.set(bytes, a); u8[a + bytes.length] = 0; strTab.set(key, a); }
    return a;
  }
  // heap
  const freeList = []; const MAGIC = 0xA110C, FREED = 0xF7EE;
  function setHdr(a, s) { dv.setUint32(a - 8, s, true); dv.setUint32(a - 4, MAGIC, true); }
  function malloc(n) {
    if (!(n >= 0)) return 0;
    n = Math.max(16, alignUp(n, 16));
    for (let i = 0; i < freeList.length; i++) {
      const fa = freeList[i][0], fs = freeList[i][1];
      if (fs >= n) {
        freeList.splice(i, 1);
        if (fs - n >= 64) { setHdr(fa, n); const na = fa + n + 16; setHdr(na, fs - n - 16); dv.setUint32(na - 4, FREED, true); freeList.push([na, fs - n - 16]); }
        else setHdr(fa, fs);
        return fa;
      }
    }
    const a = heapTop + 16; if (a + n > STACK_LIMIT) return 0;
    heapTop = a + n; setHdr(a, n); return a;
  }
  function validBlock(a) { return a >= 4096 + 16 && a < STACK_LIMIT && dv.getUint32(a - 4, true) === MAGIC; }
  function free(a) {
    if (!a) return;
    if (!validBlock(a)) rerr(a >= 4096 + 16 && a < STACK_LIMIT && dv.getUint32(a - 4, true) === FREED ? 'free() 重复释放了同一块内存' : 'free() 了一个不是 malloc 得到的指针');
    dv.setUint32(a - 4, FREED, true); freeList.push([a, dv.getUint32(a - 8, true)]);
  }
  // C strings
  function cstr(a) { chk(a, 1); const end = u8.indexOf(0, a); if (end < 0) rerr('字符串没有结尾的 \\0'); return Array.from(u8.subarray(a, end)); }
  function cstrLen(a) { chk(a, 1); const end = u8.indexOf(0, a); if (end < 0) rerr('字符串没有结尾的 \\0'); return end - a; }
  function writeBytes(a, b) { chk(a, b.length + 1); u8.set(b, a); u8[a + b.length] = 0; }
  const ascii = s => { const r = new Array(s.length); for (let i = 0; i < s.length; i++) r[i] = s.charCodeAt(i); return r; };
  const jsStr = b => new TextDecoder().decode(new Uint8Array(b));

  // ---- printf ----
  function fltStr(v, conv, prec, flags) {
    const lower = conv.toLowerCase(), up = conv !== lower;
    let sign = (v < 0 || Object.is(v, -0)) ? '-' : flags.indexOf('+') >= 0 ? '+' : flags.indexOf(' ') >= 0 ? ' ' : '';
    if (!Number.isFinite(v)) { const s = Number.isNaN(v) ? 'nan' : 'inf'; if (Number.isNaN(v)) sign = flags.indexOf('+') >= 0 ? '+' : ''; return sign + (up ? s.toUpperCase() : s); }
    const a = Math.abs(v); let p = prec == null ? 6 : prec; let s;
    const fixed = (x, d) => x >= 1e21 ? BigInt(Math.round(x)).toString() + (d > 0 ? '.' + '0'.repeat(d) : '') : x.toFixed(Math.min(d, 100));
    const expo = (x, d) => { const t = x.toExponential(Math.min(d, 100)); const m = /^(.*)e([+-])(\d+)$/.exec(t); return m[1] + 'e' + m[2] + (m[3].length < 2 ? '0' + m[3] : m[3]); };
    if (lower === 'f') s = fixed(a, p);
    else if (lower === 'e') s = expo(a, p);
    else if (lower === 'a') s = a.toString(16);
    else {
      const P = p === 0 ? 1 : p; let X = 0;
      if (a !== 0) X = parseInt(a.toExponential(P - 1).split('e')[1], 10);
      if (P > X && X >= -4) s = fixed(a, P - 1 - X); else s = expo(a, P - 1);
      if (flags.indexOf('#') < 0) {
        const m = /^([^e]*)(e.*)?$/.exec(s); let mant = m[1];
        if (mant.indexOf('.') >= 0) mant = mant.replace(/0+$/, '').replace(/\.$/, '');
        s = mant + (m[2] || '');
      }
    }
    if (flags.indexOf('#') >= 0 && s.indexOf('.') < 0 && lower !== 'g') s = s.replace(/^(\d+)/, '$1.');
    if (up) s = s.toUpperCase();
    return sign + s;
  }
  function fmt(fa, args, ai) {
    const f = cstr(fa); const out = []; let i = 0;
    const nextArg = () => { if (ai >= args.length) rerr('printf 的参数比格式说明符少'); return args[ai++]; };
    while (i < f.length) {
      const c = f[i++];
      if (c !== 37) { out.push(c); continue; }
      if (f[i] === 37) { out.push(37); i++; continue; }
      let flags = ''; while (i < f.length && '-+ #0'.indexOf(String.fromCharCode(f[i])) >= 0) flags += String.fromCharCode(f[i++]);
      let width = 0;
      if (f[i] === 42) { width = nextArg() | 0; i++; if (width < 0) { flags += '-'; width = -width; } }
      else { let w = ''; while (f[i] >= 48 && f[i] <= 57) w += String.fromCharCode(f[i++]); if (w) width = +w; }
      let prec = null;
      if (f[i] === 46) { i++; if (f[i] === 42) { prec = nextArg() | 0; i++; if (prec < 0) prec = null; } else { let p = ''; while (f[i] >= 48 && f[i] <= 57) p += String.fromCharCode(f[i++]); prec = p ? +p : 0; } }
      let len = ''; while (i < f.length && 'hlLqjzt'.indexOf(String.fromCharCode(f[i])) >= 0) len += String.fromCharCode(f[i++]);
      if (i >= f.length) { out.push(37); break; }
      const conv = String.fromCharCode(f[i++]);
      const big = /l|j|z|t|q|L/.test(len);
      let body, numeric = false, prefixLen = 0;
      switch (conv) {
        case 'd': case 'i': {
          let v = nextArg(); v = big ? (typeof v === 'number' ? Math.trunc(v) : v) : len === 'hh' ? (lo32(v) << 24) >> 24 : len === 'h' ? (lo32(v) << 16) >> 16 : lo32(v) | 0;
          let digits = (typeof v === 'bigint' || Math.abs(v) >= 1e15) ? (v < 0 ? (-toB(v)).toString() : toB(v).toString()) : String(Math.abs(v));
          if (prec != null) { if (prec === 0 && v === 0) digits = ''; while (digits.length < prec) digits = '0' + digits; }
          const sg = v < 0 ? '-' : flags.indexOf('+') >= 0 ? '+' : flags.indexOf(' ') >= 0 ? ' ' : '';
          body = ascii(sg + digits); numeric = prec == null; prefixLen = sg.length; break;
        }
        case 'u': case 'x': case 'X': case 'o': {
          let v = nextArg(); let bv;
          if (big) bv = BigInt.asUintN(64, toB(v));
          else { v = lo32(v); bv = BigInt(len === 'hh' ? v & 255 : len === 'h' ? v & 65535 : v >>> 0); }
          const base = conv === 'u' ? 10 : conv === 'o' ? 8 : 16;
          let digits = bv.toString(base); if (conv === 'X') digits = digits.toUpperCase();
          if (prec != null) { if (prec === 0 && bv === 0n) digits = ''; while (digits.length < prec) digits = '0' + digits; }
          let pre = '';
          if (flags.indexOf('#') >= 0 && bv !== 0n) { if (conv === 'x') pre = '0x'; else if (conv === 'X') pre = '0X'; else if (conv === 'o' && digits[0] !== '0') pre = '0'; }
          body = ascii(pre + digits); numeric = prec == null; prefixLen = pre.length; break;
        }
        case 'c': body = [lo32(nextArg()) & 255]; break;
        case 's': { const a = nextArg(); let b = a ? cstr(a) : ascii('(null)'); if (prec != null) b = b.slice(0, prec); body = b; break; }
        case 'f': case 'F': case 'e': case 'E': case 'g': case 'G': case 'a': case 'A': {
          const v = toN(nextArg()); const s = fltStr(v, conv, prec, flags); body = ascii(s); numeric = Number.isFinite(v); prefixLen = /^[-+ ]/.test(s) ? 1 : 0; break;
        }
        case 'p': { const v = nextArg(); body = ascii(v ? '0x' + (v >>> 0).toString(16) : '(nil)'); break; }
        case 'n': nextArg(); body = []; break;
        default: body = ascii('%' + conv);
      }
      if (width && body.length < width) {
        const padn = width - body.length;
        if (flags.indexOf('-') >= 0) { for (let k = 0; k < padn; k++) body.push(32); }
        else if (flags.indexOf('0') >= 0 && numeric) { const z = new Array(padn).fill(48); body = body.slice(0, prefixLen).concat(z, body.slice(prefixLen)); }
        else body = new Array(padn).fill(32).concat(body);
      }
      for (let k = 0; k < body.length; k++) out.push(body[k]);
    }
    return out;
  }
  // ---- scanf ----
  function strSrc(a) { let p = a; return { peek: () => { chk(p, 1); return u8[p] === 0 ? -1 : u8[p]; }, get: () => { chk(p, 1); return u8[p] === 0 ? -1 : u8[p++]; } }; }
  const isWs = c => c === 32 || (c >= 9 && c <= 13);
  function scan(fa, args, ai, src) {
    const f = cstr(fa); let i = 0, count = 0, started = false;
    while (i < f.length) {
      const c = f[i];
      if (isWs(c)) { while (isWs(src.peek())) src.get(); i++; continue; }
      if (c !== 37 || f[i + 1] === 37) {
        if (c === 37) { i++; while (isWs(src.peek())) src.get(); }
        if (src.peek() === c) { src.get(); i++; continue; }
        if (src.peek() < 0 && !started) return -1;
        break;
      }
      i++;
      let suppress = false; if (f[i] === 42) { suppress = true; i++; }
      let w = ''; while (f[i] >= 48 && f[i] <= 57) w += String.fromCharCode(f[i++]);
      let width = w ? +w : Infinity;
      let len = ''; while (i < f.length && 'hlLqjzt'.indexOf(String.fromCharCode(f[i])) >= 0) len += String.fromCharCode(f[i++]);
      const conv = String.fromCharCode(f[i++]);
      let set = null, neg = false;
      if (conv === '[') {
        set = new Set(); if (f[i] === 94) { neg = true; i++; }
        if (f[i] === 93) { set.add(93); i++; }
        while (i < f.length && f[i] !== 93) { if (f[i + 1] === 45 && f[i + 2] && f[i + 2] !== 93) { for (let k = f[i]; k <= f[i + 2]; k++) set.add(k); i += 3; } else set.add(f[i++]); }
        i++;
      }
      if (conv === 'n') { if (!suppress) { stInt(args[ai++], 4, BigInt(0)); } continue; }
      if (conv !== 'c' && conv !== '[') while (isWs(src.peek())) src.get();
      if (src.peek() < 0) return (count === 0 && !started) ? -1 : count;
      started = true;
      const take = () => { width--; return src.get(); };
      if ('diuxXo'.indexOf(conv) >= 0) {
        let s = '';
        if ((src.peek() === 45 || src.peek() === 43) && width > 0) s += String.fromCharCode(take());
        let base = conv === 'x' || conv === 'X' ? 16 : conv === 'o' ? 8 : 10;
        const isD = ch => base === 16 ? /[0-9a-fA-F]/.test(String.fromCharCode(ch)) : base === 8 ? ch >= 48 && ch <= 55 : isDigit(ch);
        if (conv === 'i' && src.peek() === 48) { base = 8; s += String.fromCharCode(take()); if ((src.peek() === 120 || src.peek() === 88) && width > 0) { take(); base = 16; s = s.slice(0, -1); } }
        else if (base === 16 && src.peek() === 48) { s += String.fromCharCode(take()); if ((src.peek() === 120 || src.peek() === 88) && width > 0) { take(); s = s.slice(0, -1); } }
        while (width > 0 && src.peek() >= 0 && isD(src.peek())) s += String.fromCharCode(take());
        const sg = s[0] === '-' ? -1n : 1n; const digits = s.replace(/^[+-]/, '');
        if (!digits) return count;
        const val = sg * BigInt((base === 16 ? '0x' : base === 8 ? '0o' : '') + digits);
        if (!suppress) { const sz = /ll|l|j|z|q|t/.test(len) ? 8 : len === 'hh' ? 1 : len === 'h' ? 2 : 4; stInt(args[ai++], sz, val); count++; }
      } else if ('fFeEgGa'.indexOf(conv) >= 0) {
        let s = '';
        const pk = () => String.fromCharCode(src.peek());
        if ((pk() === '-' || pk() === '+') && width > 0) s += String.fromCharCode(take());
        while (width > 0 && isDigit(src.peek())) s += String.fromCharCode(take());
        if (width > 0 && pk() === '.') { s += String.fromCharCode(take()); while (width > 0 && isDigit(src.peek())) s += String.fromCharCode(take()); }
        if (/\d/.test(s) && width > 0 && (pk() === 'e' || pk() === 'E')) { s += String.fromCharCode(take()); if (pk() === '-' || pk() === '+') s += String.fromCharCode(take()); while (width > 0 && isDigit(src.peek())) s += String.fromCharCode(take()); }
        if (!/\d/.test(s)) return count;
        const v = parseFloat(s);
        if (!suppress) { const a = args[ai++]; if (len === 'l' || len === 'L') { chk(a, 8); dv.setFloat64(a, v, true); } else { chk(a, 4); dv.setFloat32(a, v, true); } count++; }
      } else if (conv === 's' || conv === '[') {
        const b = [];
        while (width > 0 && src.peek() >= 0) { const ch = src.peek(); if (conv === 's' ? isWs(ch) : (set.has(ch) === neg)) break; b.push(take()); }
        if (!b.length) return count;
        if (!suppress) { writeBytes(args[ai++], b); count++; }
      } else if (conv === 'c') {
        if (width === Infinity) width = 1;
        const b = []; while (width > 0 && src.peek() >= 0) b.push(take());
        if (!suppress) { const a = args[ai++]; chk(a, b.length); u8.set(b, a); count++; }
      } else rerr('scanf 不支持格式 %' + conv);
    }
    return count;
  }
  function parseIntPrefix(b, base) {
    let i = 0; while (isWs(b[i])) i++;
    let sg = 1n; if (b[i] === 45) { sg = -1n; i++; } else if (b[i] === 43) i++;
    if ((base === 0 || base === 16) && b[i] === 48 && (b[i + 1] === 120 || b[i + 1] === 88)) { base = 16; i += 2; }
    else if (base === 0 && b[i] === 48) base = 8; else if (base === 0) base = 10;
    let v = 0n, any = false; const B = BigInt(base);
    for (;;) { const ch = b[i]; let d = ch >= 48 && ch <= 57 ? ch - 48 : ch >= 97 && ch <= 122 ? ch - 87 : ch >= 65 && ch <= 90 ? ch - 55 : 99; if (ch === undefined || d >= base) break; v = v * B + BigInt(d); i++; any = true; }
    return { v: sg * v, end: any ? i : 0 };
  }
  function parseFloatPrefix(b) {
    const s = jsStr(b); const m = /^\s*[+-]?(?:inf(?:inity)?|nan|(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)/i.exec(s);
    if (!m) return { v: 0, end: 0 };
    const t = m[0].trim().toLowerCase(); const v = t.indexOf('inf') >= 0 ? (t[0] === '-' ? -Infinity : Infinity) : t.indexOf('nan') >= 0 ? NaN : parseFloat(t);
    return { v, end: utf8(m[0]).length };
  }
  function cmpBytes(a, b) { const n = Math.min(a.length, b.length); for (let i = 0; i < n; i++) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1; return a.length === b.length ? 0 : a.length < b.length ? -1 : 1; }
  function readLine(a, n, keepNl) {
    if (stdinSrc.peek() < 0) return 0;
    const b = [];
    while ((keepNl ? b.length < n - 1 : true) && stdinSrc.peek() >= 0) { const ch = stdinSrc.get(); if (ch === 10) { if (keepNl) b.push(10); break; } b.push(ch); }
    writeBytes(a, b); return a;
  }
  function callAny(f, args) { return f.builtin ? f.builtin(args) : callUser(f, args); }
  const fnFromPtr = v => { const f = funcs[v - FBASE]; if (!f) rerr('无效的函数指针'); return f; };
  const ctype = (fn) => a => { const c = a[0]; return c >= 0 && c < 128 && fn(String.fromCharCode(c)) ? 1 : 0; };
  const M1 = fn => a => fn(a[0]);
  const lc = c => (c >= 65 && c <= 90) ? c + 32 : c;
  const rintJ = x => { const r = Math.round(x); return (Math.abs(x % 1) === 0.5 && r % 2 !== 0) ? r - 1 : r; };
  function setEnd(pp, v) { if (pp) { chk(pp, 8); dv.setUint32(pp, v, true); dv.setUint32(pp + 4, 0, true); } }
  function errMsg(n) { return ({ 0: 'Success', 2: 'No such file or directory', 12: 'Cannot allocate memory', 22: 'Invalid argument', 33: 'Numerical argument out of domain', 34: 'Numerical result out of range' })[n] || ('Unknown error ' + n); }
  const IMPL = {
    printf: a => { const b = fmt(a[0], a, 1); outBytes(b); return b.length; },
    fprintf: a => { const b = fmt(a[1], a, 2); outTo(a[0], b); return b.length; },
    sprintf: a => { const b = fmt(a[1], a, 2); writeBytes(a[0], b); return b.length; },
    snprintf: a => { const b = fmt(a[2], a, 3); if (a[1] > 0) writeBytes(a[0], b.slice(0, a[1] - 1)); return b.length; },
    puts: a => { outBytes(cstr(a[0])); outBytes([10]); return 1; },
    fputs: a => { outTo(a[1], cstr(a[0])); return 1; },
    putchar: a => { outBytes([a[0] & 255]); return a[0] & 255; },
    putc: a => { outTo(a[1], [a[0] & 255]); return a[0] & 255; },
    fputc: a => { outTo(a[1], [a[0] & 255]); return a[0] & 255; },
    fwrite: a => { const n = toN(a[1]) * toN(a[2]); if (n <= 0) return 0; chk(a[0], n); outTo(a[3], Array.from(u8.subarray(a[0], a[0] + n))); return a[2]; },
    perror: a => { const m = a[0] ? cstr(a[0]) : []; errBytes(m.length ? m.concat(ascii(': '), ascii(errMsg(errnoAddr ? dv.getInt32(errnoAddr, true) : 0)), [10]) : ascii(errMsg(errnoAddr ? dv.getInt32(errnoAddr, true) : 0) + '\n')); return 0; },
    strerror: a => strAddr(ascii(errMsg(a[0]))),
    ungetc: a => { if (a[0] >= 0 && ip > 0) { ip--; return a[0]; } return -1; },
    atexit: a => { atexitFns.push(fnFromPtr(a[0])); return 0; },
    __va_start: a => { if (!vaStack.length) rerr('va_start 只能在可变参数函数中使用'); stPtr(a[0], vaNew({ a: vaStack[vaStack.length - 1], i: 0 })); return 0; },
    __va_end: a => { chk(a[0], 8); const h = dv.getUint32(a[0], true); if (vaTab[h]) { vaTab[h] = null; vaFree.push(h); } stPtr(a[0], 0); return 0; },
    __va_copy: a => { const st = vaGet(a[1]); stPtr(a[0], vaNew({ a: st.a, i: st.i })); return 0; },
    vprintf: a => { const st = vaGet(a[1]); const b = fmt(a[0], st.a, st.i); outBytes(b); return b.length; },
    vfprintf: a => { const st = vaGet(a[2]); const b = fmt(a[1], st.a, st.i); outTo(a[0], b); return b.length; },
    vsprintf: a => { const st = vaGet(a[2]); const b = fmt(a[1], st.a, st.i); writeBytes(a[0], b); return b.length; },
    vsnprintf: a => { const st = vaGet(a[3]); const b = fmt(a[2], st.a, st.i); if (a[1] > 0) writeBytes(a[0], b.slice(0, a[1] - 1)); return b.length; },
    __assert_fail: a => { rerr('断言失败：' + jsStr(cstr(a[0])) + '（' + jsStr(cstr(a[2])) + ' 第 ' + a[1] + ' 行）'); },
    strtoll: a => { const r = parseIntPrefix(cstr(a[0]), a[2]); setEnd(a[1], a[0] + r.end); return fromB(BigInt.asIntN(64, r.v)); },
    strtoul: a => { const r = parseIntPrefix(cstr(a[0]), a[2]); setEnd(a[1], a[0] + r.end); return fromB(BigInt.asUintN(64, r.v)); },
    strtoull: a => { const r = parseIntPrefix(cstr(a[0]), a[2]); setEnd(a[1], a[0] + r.end); return fromB(BigInt.asUintN(64, r.v)); },
    strtof: a => { const r = parseFloatPrefix(cstr(a[0])); setEnd(a[1], a[0] + r.end); return Math.fround(r.v); },
    strtold: a => { const r = parseFloatPrefix(cstr(a[0])); setEnd(a[1], a[0] + r.end); return r.v; },
    strtok: a => {
      let p = a[0] || tokSave; if (!p) return 0;
      const del = new Set(cstr(a[1]));
      chk(p, 1); while (u8[p] && del.has(u8[p])) { p++; chk(p, 1); }
      if (!u8[p]) { tokSave = 0; return 0; }
      const start = p; while (u8[p] && !del.has(u8[p])) { p++; chk(p, 1); }
      if (u8[p]) { u8[p] = 0; tokSave = p + 1; } else tokSave = 0;
      return start;
    },
    strspn: a => { const s1 = cstr(a[0]), set = new Set(cstr(a[1])); let k = 0; while (k < s1.length && set.has(s1[k])) k++; return k; },
    strcspn: a => { const s1 = cstr(a[0]), set = new Set(cstr(a[1])); let k = 0; while (k < s1.length && !set.has(s1[k])) k++; return k; },
    strpbrk: a => { const s1 = cstr(a[0]), set = new Set(cstr(a[1])); for (let k = 0; k < s1.length; k++) if (set.has(s1[k])) return a[0] + k; return 0; },
    memchr: a => { const n = toN(a[2]); if (n > 0) chk(a[0], n); const c = a[1] & 255; for (let k = 0; k < n; k++) if (u8[a[0] + k] === c) return a[0] + k; return 0; },
    strnlen: a => { const n = toN(a[1]); let k = 0; while (k < n) { chk(a[0] + k, 1); if (!u8[a[0] + k]) break; k++; } return k; },
    strcasecmp: a => cmpBytes(cstr(a[0]).map(lc), cstr(a[1]).map(lc)),
    stricmp: a => cmpBytes(cstr(a[0]).map(lc), cstr(a[1]).map(lc)),
    strncasecmp: a => cmpBytes(cstr(a[0]).slice(0, a[2]).map(lc), cstr(a[1]).slice(0, a[2]).map(lc)),
    isgraph: ctype(c => c > ' ' && c <= '~'), iscntrl: a => (a[0] >= 0 && a[0] < 32) || a[0] === 127 ? 1 : 0, isblank: ctype(c => c === ' ' || c === '\t'), isascii: a => a[0] >= 0 && a[0] < 128 ? 1 : 0,
    __isnan: a => Number.isNaN(a[0]) ? 1 : 0, __isinf: a => a[0] === Infinity ? 1 : a[0] === -Infinity ? -1 : 0, __isfinite: a => Number.isFinite(a[0]) ? 1 : 0, __signbit: a => (a[0] < 0 || Object.is(a[0], -0)) ? 1 : 0,
    lround: a => w64s(a[0] < 0 ? -Math.round(-a[0]) : Math.round(a[0])), llround: a => w64s(a[0] < 0 ? -Math.round(-a[0]) : Math.round(a[0])),
    lrint: a => w64s(rintJ(a[0])), rint: a => rintJ(a[0]), nearbyint: a => rintJ(a[0]),
    exp2: a => Math.pow(2, a[0]), expm1: M1(Math.expm1), log1p: M1(Math.log1p), asinh: M1(Math.asinh), acosh: M1(Math.acosh), atanh: M1(Math.atanh),
    fdim: a => a[0] > a[1] ? a[0] - a[1] : 0, copysign: a => { const m = Math.abs(a[0]); return (a[1] < 0 || Object.is(a[1], -0)) ? -m : m; },
    ldexp: a => a[0] * Math.pow(2, a[1]),
    modf: a => { const ip2 = Math.trunc(a[0]); if (a[1]) { chk(a[1], 8); dv.setFloat64(a[1], ip2, true); } return a[0] - ip2; },
    frexp: a => { let x = a[0], e = 0; if (x !== 0 && Number.isFinite(x)) { e = Math.floor(Math.log2(Math.abs(x))) + 1; let m = x / Math.pow(2, e); while (Math.abs(m) >= 1) { m /= 2; e++; } while (Math.abs(m) < 0.5) { m *= 2; e--; } x = m; } if (a[1]) { chk(a[1], 4); dv.setInt32(a[1], e, true); } return x; },
    expf: M1(Math.exp), logf: M1(Math.log), sinf: M1(Math.sin), cosf: M1(Math.cos), tanf: M1(Math.tan), roundf: M1(x => x < 0 ? -Math.round(-x) : Math.round(x)), truncf: M1(Math.trunc),
    fmodf: a => a[0] % a[1], fmaxf: a => Math.max(a[0], a[1]), fminf: a => Math.min(a[0], a[1]), atan2f: a => Math.atan2(a[0], a[1]), hypotf: a => Math.hypot(a[0], a[1]), log10f: M1(Math.log10), log2f: M1(Math.log2), cbrtf: M1(Math.cbrt),
    scanf: a => scan(a[0], a, 1, stdinSrc),
    fscanf: a => scan(a[1], a, 2, stdinSrc),
    sscanf: a => scan(a[1], a, 2, strSrc(a[0])),
    getchar: () => stdinSrc.get(), getc: () => stdinSrc.get(), fgetc: () => stdinSrc.get(),
    fgets: a => readLine(a[0], a[1], true),
    gets: a => readLine(a[0], Infinity, false),
    fflush: () => { flush(); return 0; },
    malloc: a => malloc(toN(a[0])),
    calloc: a => { const n = a[0] * a[1]; const p = malloc(n); if (p) u8.fill(0, p, p + n); return p; },
    realloc: a => {
      if (!a[0]) return malloc(a[1]);
      if (!validBlock(a[0])) rerr('realloc() 了一个无效指针');
      const old = dv.getUint32(a[0] - 8, true); if (a[1] <= old) return a[0];
      const p = malloc(a[1]); if (!p) return 0; u8.copyWithin(p, a[0], a[0] + old); free(a[0]); return p;
    },
    free: a => { free(a[0]); return 0; },
    exit: a => { throw new ExitSig(a[0] | 0); },
    abort: () => { rerr('程序调用了 abort()'); },
    system: () => 0,
    abs: a => Math.abs(a[0]) | 0, labs: a => w64s(toB(a[0]) < 0n ? -toB(a[0]) : toB(a[0])), llabs: a => w64s(toB(a[0]) < 0n ? -toB(a[0]) : toB(a[0])),
    atoi: a => Number(BigInt.asIntN(32, parseIntPrefix(cstr(a[0]), 10).v)),
    atol: a => fromB(BigInt.asIntN(64, parseIntPrefix(cstr(a[0]), 10).v)),
    atoll: a => fromB(BigInt.asIntN(64, parseIntPrefix(cstr(a[0]), 10).v)),
    atof: a => parseFloatPrefix(cstr(a[0])).v,
    strtol: a => { const r = parseIntPrefix(cstr(a[0]), a[2]); if (a[1]) { chk(a[1], 8); dv.setUint32(a[1], a[0] + r.end, true); dv.setUint32(a[1] + 4, 0, true); } return fromB(BigInt.asIntN(64, r.v)); },
    strtod: a => { const r = parseFloatPrefix(cstr(a[0])); if (a[1]) { chk(a[1], 8); dv.setUint32(a[1], a[0] + r.end, true); dv.setUint32(a[1] + 4, 0, true); } return r.v; },
    rand: () => { rs = (Math.imul(rs, 1103515245) + 12345) >>> 0; return (rs >>> 1) & 0x3fffffff | ((rs & 1) << 30); },
    srand: a => { rs = a[0] >>> 0; return 0; },
    qsort: a => {
      const base = a[0], n = a[1], size = a[2], f = fnFromPtr(a[3]);
      if (n <= 1) return 0; chk(base, n * size);
      const tmp = malloc(n * size); if (!tmp) rerr('内存不足');
      u8.copyWithin(tmp, base, base + n * size);
      const idx = []; for (let k = 0; k < n; k++) idx.push(k);
      idx.sort((x, y) => callAny(f, [tmp + x * size, tmp + y * size]) | 0);
      for (let k = 0; k < n; k++) u8.copyWithin(base + k * size, tmp + idx[k] * size, tmp + idx[k] * size + size);
      free(tmp); return 0;
    },
    bsearch: a => {
      const key = a[0], base = a[1], n = a[2], size = a[3], f = fnFromPtr(a[4]);
      let lo = 0, hi = n - 1;
      while (lo <= hi) { const mid = (lo + hi) >> 1; const r = callAny(f, [key, base + mid * size]) | 0; if (r === 0) return base + mid * size; if (r < 0) hi = mid - 1; else lo = mid + 1; }
      return 0;
    },
    strlen: a => cstrLen(a[0]),
    strcpy: a => { writeBytes(a[0], cstr(a[1])); return a[0]; },
    strncpy: a => { const b = cstr(a[1]); const n = a[2]; chk(a[0], n); for (let k = 0; k < n; k++) u8[a[0] + k] = k < b.length ? b[k] : 0; return a[0]; },
    strcat: a => { writeBytes(a[0] + cstrLen(a[0]), cstr(a[1])); return a[0]; },
    strncat: a => { writeBytes(a[0] + cstrLen(a[0]), cstr(a[1]).slice(0, a[2])); return a[0]; },
    strcmp: a => cmpBytes(cstr(a[0]), cstr(a[1])),
    strncmp: a => cmpBytes(cstr(a[0]).slice(0, a[2]), cstr(a[1]).slice(0, a[2])),
    strchr: a => { const c = a[1] & 255; for (let p = a[0]; ; p++) { chk(p, 1); if (u8[p] === c) return p; if (!u8[p]) return 0; } },
    strrchr: a => { const c = a[1] & 255; let r = 0; for (let p = a[0]; ; p++) { chk(p, 1); if (u8[p] === c) r = p; if (!u8[p]) return r; } },
    strstr: a => { const h = cstr(a[0]), nd = cstr(a[1]); if (!nd.length) return a[0]; outer: for (let k = 0; k + nd.length <= h.length; k++) { for (let j = 0; j < nd.length; j++) if (h[k + j] !== nd[j]) continue outer; return a[0] + k; } return 0; },
    strdup: a => { const b = cstr(a[0]); const p = malloc(b.length + 1); writeBytes(p, b); return p; },
    memset: a => { if (a[2] > 0) { chk(a[0], a[2]); u8.fill(a[1] & 255, a[0], a[0] + a[2]); } return a[0]; },
    memcpy: a => { if (a[2] > 0) { chk(a[0], a[2]); chk(a[1], a[2]); u8.copyWithin(a[0], a[1], a[1] + a[2]); } return a[0]; },
    memmove: a => { if (a[2] > 0) { chk(a[0], a[2]); chk(a[1], a[2]); u8.copyWithin(a[0], a[1], a[1] + a[2]); } return a[0]; },
    memcmp: a => { chk(a[0], a[2]); chk(a[1], a[2]); for (let k = 0; k < a[2]; k++) { const x = u8[a[0] + k], y = u8[a[1] + k]; if (x !== y) return x < y ? -1 : 1; } return 0; },
    isdigit: ctype(c => /[0-9]/.test(c)), isalpha: ctype(c => /[A-Za-z]/.test(c)), isalnum: ctype(c => /[A-Za-z0-9]/.test(c)),
    isspace: ctype(c => /[ \t\n\v\f\r]/.test(c)), isupper: ctype(c => /[A-Z]/.test(c)), islower: ctype(c => /[a-z]/.test(c)),
    ispunct: ctype(c => /[!-\/:-@\[-`{-~]/.test(c)), isxdigit: ctype(c => /[0-9a-fA-F]/.test(c)), isprint: ctype(c => c >= ' ' && c <= '~'),
    toupper: a => (a[0] >= 97 && a[0] <= 122) ? a[0] - 32 : a[0], tolower: a => (a[0] >= 65 && a[0] <= 90) ? a[0] + 32 : a[0],
    sqrt: M1(Math.sqrt), sin: M1(Math.sin), cos: M1(Math.cos), tan: M1(Math.tan), asin: M1(Math.asin), acos: M1(Math.acos), atan: M1(Math.atan),
    exp: M1(Math.exp), log: M1(Math.log), log10: M1(Math.log10), log2: M1(Math.log2), floor: M1(Math.floor), ceil: M1(Math.ceil), fabs: M1(Math.abs),
    round: M1(x => x < 0 ? -Math.round(-x) : Math.round(x)), trunc: M1(Math.trunc), cbrt: M1(Math.cbrt), sinh: M1(Math.sinh), cosh: M1(Math.cosh), tanh: M1(Math.tanh),
    sqrtf: M1(Math.sqrt), fabsf: M1(Math.abs), floorf: M1(Math.floor), ceilf: M1(Math.ceil), powf: a => Math.pow(a[0], a[1]),
    pow: a => Math.pow(a[0], a[1]), atan2: a => Math.atan2(a[0], a[1]), fmod: a => a[0] % a[1], hypot: a => Math.hypot(a[0], a[1]), fmax: a => Math.max(a[0], a[1]), fmin: a => Math.min(a[0], a[1]),
    time: a => { const t = Math.floor(Date.now() / 1000); if (a[0]) stInt(a[0], 8, BigInt(t)); return t; },
    clock: () => Math.round((now() - t0) * 1000),
    assert: a => { if (!a[0]) rerr('断言失败（assert）'); return 0; },
    getpid: () => 4242, sleep: () => 0, Sleep: () => 0, usleep: () => 0,
  };

  // ---- compile state ----
  const G = new Map(); let TU = new Map(); const scopes = [G, TU]; let cur = null; let loopD = 0, swD = 0;
  let gotoL = null, blockVla = [];
  const globalInits = [];
  let P;
  function lookup(n) {
    for (let i = scopes.length - 1; i >= 0; i--) { const v = scopes[i].get(n); if (v) return v; }
    if (P.enums.has(n)) return { kind: 'e', v: P.enums.get(n) };
    if (n === 'errno') { if (!errnoAddr) errnoAddr = dalloc(4, 4); const e = { kind: 'g', t: T.int, addr: errnoAddr }; G.set('errno', e); return e; }
    if (n === 'stdin' || n === 'stdout' || n === 'stderr') return { kind: 'e', v: n === 'stdin' ? 16 : n === 'stdout' ? 17 : 18, t: ptr(T.void) };
    if (SIGS[n]) return builtinEntry(n);
    return null;
  }
  function builtinEntry(n) {
    const fn = { name: n, type: sigType(SIGS[n]), id: funcs.length, builtin: IMPL[n] };
    funcs.push(fn); const e = { kind: 'f', fn }; G.set(n, e); return e;
  }
  function declare(name, info, ln) {
    const s = scopes[scopes.length - 1];
    if (s.has(name)) cerr("重复定义了 '" + name + "'", ln);
    s.set(name, info);
  }
  function getFunc(name, type, ln, storage) {
    let e = TU.get(name);
    if (!e && storage !== 'static') e = G.get(name);
    if (e) { if (e.kind !== 'f') cerr("'" + name + "' 已被定义为变量", ln); if (e.fn.builtin && type) { e.fn.builtin = null; e.fn.type = type; } return e.fn; }
    const fn = { name, type, id: funcs.length, body: null, params: null, frameSize: 0 };
    funcs.push(fn); (storage === 'static' ? TU : G).set(name, { kind: 'f', fn }); return fn;
  }
  function vlaIn(t) { while (t.k === 'ptr' || t.k === 'arr') { if (t.k === 'arr' && t.vexpr) return true; t = t.k === 'ptr' ? t.to : t.of; } return false; }
  function labelsOf(s) {
    if (s._lb) return s._lb;
    const r = new Set(); const add = x => { if (x) for (const l of labelsOf(x)) r.add(l); };
    switch (s.k) {
      case 'label': r.add(s.name); add(s.stmt); break;
      case 'block': s.items.forEach(add); break;
      case 'if': add(s.t); add(s.f); break;
      case 'while': case 'do': case 'for': case 'switch': add(s.body); break;
      case 'case': case 'default': add(s.stmt); break;
    }
    s._lb = r; return r;
  }
  function checkLabels(s, seen) {
    if (!s) return;
    switch (s.k) {
      case 'label': if (seen.has(s.name)) cerr("标签 '" + s.name + "' 重复定义", s.line); seen.add(s.name); checkLabels(s.stmt, seen); break;
      case 'block': s.items.forEach(x => checkLabels(x, seen)); break;
      case 'if': checkLabels(s.t, seen); checkLabels(s.f, seen); break;
      case 'while': case 'do': case 'for': case 'switch': checkLabels(s.body, seen); break;
      case 'case': case 'default': checkLabels(s.stmt, seen); break;
    }
  }
  function allocLocal(t) {
    const a = Math.max(alignOf(t), 1); cur.frame = alignUp(cur.frame, a); const off = cur.frame; cur.frame += Math.max(sizeOf(t), 1); return off;
  }
  const id = v => v;
  function rv(x) {
    if (x.t.k === 'arr') return { t: ptr(x.t.of), f: x.f };
    if (x.t.k === 'func') return { t: ptr(x.t), f: x.f, fn: x.fn };
    return x;
  }
  function mkLv(t, af) {
    if (t.k === 'arr' || t.k === 'struct' || t.k === 'func') return { t, f: af, lv: af };
    if (t.k === 'void') return { t, f: () => rerr('不能解引用 void 指针'), lv: af };
    const ld = loader(t, true);
    return { t, f: () => ld(af()), lv: af };
  }
  function elemSize(pt) { const t = pt.to; if (t.k === 'void' || t.k === 'func') return 1; if (isVla(t)) return rtSize(t); return sizeOf(t); }
  // runtime size of a (possibly variable-length) type, as a function
  function rtSize(t) {
    if (t.k !== 'arr' || !isVla(t)) { const c = sizeOf(t); return () => c; }
    const inner = rtSize(t.of);
    if (t.vslot != null) { const sl = t.vslot; return () => dv.getUint32(fp + sl, true) * inner(); }
    if (t.vexpr) {
      const E = rv(ex(t.vexpr)); if (!isInt(E.t)) cerr('数组大小必须是整数'); const nf = E.f;
      return () => { const n = toN(nf()); if (n < 0) rerr('变长数组的大小不能是负数（' + n + '）'); return n * inner(); };
    }
    const n = t.n || 0; return () => n * inner();
  }
  // replace size expressions in a declared type by frame slots evaluated once at declaration time
  function instVla(t, ops) {
    if (t.k === 'ptr') { const i = instVla(t.to, ops); return i === t.to ? t : ptr(i); }
    if (t.k !== 'arr' || !isVla(t)) return t;
    const inner = instVla(t.of, ops);
    if (!t.vexpr) return arr(inner, t.n);
    const E = rv(ex(t.vexpr)); if (!isInt(E.t)) cerr('数组大小必须是整数'); const nf = E.f;
    const slot = allocLocal(T.long);
    ops.push(() => { const n = toN(nf()); if (n < 0) rerr('变长数组的大小不能是负数（' + n + '）'); if (n > MEMSZ) rerr('变长数组太大（' + n + '）'); dv.setUint32(fp + slot, n, true); });
    const r = arr(inner, null); r.vslot = slot; return r;
  }
  // bit-field accessors: get(unitAddr) / put(unitAddr, value)
  function bfAccess(fd) {
    if (fd.bfa) return fd.bfa;
    const { pos, w, us } = fd.bits; const ft = fd.type; const sgn = !ft.uns && !ft.bool;
    const rt = (ft.size <= 4 || w <= 32) && (sgn ? w <= 32 : w < 32) ? T.int : ft;
    let get, put;
    if (us === 8) {
      const P = BigInt(pos), M = (1n << BigInt(w)) - 1n;
      get = a => { chk(a, 8); const x = (dv.getBigUint64(a, true) >> P) & M; return fromB(sgn ? BigInt.asIntN(w, x) : x); };
      put = (a, v) => { chk(a, 8); const x = ft.bool ? (v ? 1n : 0n) : toB(v) & M; dv.setBigUint64(a, (dv.getBigUint64(a, true) & ~(M << P)) | (x << P), true); };
    } else {
      const ld = us === 1 ? a => u8[a] : us === 2 ? a => dv.getUint16(a, true) : a => dv.getUint32(a, true);
      const stu = us === 1 ? (a, v) => { u8[a] = v & 255; } : us === 2 ? (a, v) => dv.setUint16(a, v & 65535, true) : (a, v) => dv.setUint32(a, v >>> 0, true);
      const sh1 = 32 - pos - w, sh2 = 32 - w; const M = w === 32 ? -1 : (1 << w) - 1; const MP = M << pos;
      get = sgn ? a => { chk(a, us); return (ld(a) << sh1) >> sh2; } : a => { chk(a, us); return (ld(a) << sh1) >>> sh2; };
      put = (a, v) => { chk(a, us); const x = (ft.bool ? (v ? 1 : 0) : lo32(v)) & M; stu(a, (ld(a) & ~MP) | (x << pos)); };
    }
    fd.bfa = { get, put, rt, type: ft };
    return fd.bfa;
  }
  function wrap2(f, cx, cy) { if (!cx && !cy) return f; if (!cy) return (x, y) => f(cx(x), y); if (!cx) return (x, y) => f(x, cy(y)); return (x, y) => f(cx(x), cy(y)); }
  const CMPF = { '<': (x, y) => x < y ? 1 : 0, '>': (x, y) => x > y ? 1 : 0, '<=': (x, y) => x <= y ? 1 : 0, '>=': (x, y) => x >= y ? 1 : 0, '==': (x, y) => x === y ? 1 : 0, '!=': (x, y) => x !== y ? 1 : 0 };
  const divz = () => rerr('整数除以零');
  function arithFn(op, C) {
    if (C.k === 'float') {
      const r = C.size === 4 ? Math.fround : null;
      switch (op) {
        case '+': return r ? (a, b) => r(a + b) : (a, b) => a + b;
        case '-': return r ? (a, b) => r(a - b) : (a, b) => a - b;
        case '*': return r ? (a, b) => r(a * b) : (a, b) => a * b;
        case '/': return r ? (a, b) => r(a / b) : (a, b) => a / b;
      }
    }
    if (C.size === 4) {
      if (!C.uns) switch (op) {
        case '+': return (a, b) => (a + b) | 0; case '-': return (a, b) => (a - b) | 0; case '*': return Math.imul;
        case '/': return (a, b) => { if (b === 0) divz(); return (a / b) | 0; };
        case '%': return (a, b) => { if (b === 0) divz(); return (a % b) | 0; };
        case '&': return (a, b) => a & b; case '|': return (a, b) => a | b; case '^': return (a, b) => a ^ b;
      }
      switch (op) {
        case '+': return (a, b) => (a + b) >>> 0; case '-': return (a, b) => (a - b) >>> 0; case '*': return (a, b) => Math.imul(a, b) >>> 0;
        case '/': return (a, b) => { if (b === 0) divz(); return Math.floor(a / b) >>> 0; };
        case '%': return (a, b) => { if (b === 0) divz(); return a % b; };
        case '&': return (a, b) => (a & b) >>> 0; case '|': return (a, b) => (a | b) >>> 0; case '^': return (a, b) => (a ^ b) >>> 0;
      }
    }
    const U = C.uns;
    const BW = U ? v => fromB(BigInt.asUintN(64, v)) : v => fromB(BigInt.asIntN(64, v));
    const ok = r => Number.isSafeInteger(r) && (!U || r >= 0);
    const num2 = (a, b) => typeof a === 'number' && typeof b === 'number';
    const isZ = b => b === 0 || b === 0n;
    switch (op) {
      case '+': return (a, b) => { if (num2(a, b)) { const r = a + b; if (ok(r)) return r; } return BW(toB(a) + toB(b)); };
      case '-': return (a, b) => { if (num2(a, b)) { const r = a - b; if (ok(r)) return r; } return BW(toB(a) - toB(b)); };
      case '*': return (a, b) => { if (num2(a, b)) { const r = a * b; if (ok(r)) return r; } return BW(toB(a) * toB(b)); };
      case '/': return (a, b) => { if (isZ(b)) divz(); if (num2(a, b)) return Math.trunc(a / b) + 0; return BW(toB(a) / toB(b)); };
      case '%': return (a, b) => { if (isZ(b)) divz(); if (num2(a, b)) return (a % b) + 0; return BW(toB(a) % toB(b)); };
      case '&': return (a, b) => (num2(a, b) && (a | 0) === a && (b | 0) === b && !U) ? (a & b) : BW(toB(a) & toB(b));
      case '|': return (a, b) => (num2(a, b) && (a | 0) === a && (b | 0) === b && !U) ? (a | b) : BW(toB(a) | toB(b));
      case '^': return (a, b) => (num2(a, b) && (a | 0) === a && (b | 0) === b && !U) ? (a ^ b) : BW(toB(a) ^ toB(b));
    }
  }
  function buildBin(op, lt, rt) {
    if (op === '+' || op === '-') {
      if (isPtr(lt) && isInt(rt) && isVla(lt.to)) { const sf = rtSize(lt.to); return { t: lt, fn: op === '+' ? (x, y) => x + toN(y) * sf() : (x, y) => x - toN(y) * sf() }; }
      if (isInt(lt) && isPtr(rt) && op === '+' && isVla(rt.to)) { const sf = rtSize(rt.to); return { t: rt, fn: (x, y) => y + toN(x) * sf() }; }
      if (isPtr(lt) && isPtr(rt) && op === '-' && isVla(lt.to)) { const sf = rtSize(lt.to); return { t: T.long, fn: (x, y) => Math.trunc((x - y) / (sf() || 1)) }; }
      if (isPtr(lt) && isInt(rt)) { const s = elemSize(lt); return { t: lt, fn: op === '+' ? (x, y) => x + toN(y) * s : (x, y) => x - toN(y) * s }; }
      if (isInt(lt) && isPtr(rt) && op === '+') { const s = elemSize(rt); return { t: rt, fn: (x, y) => y + toN(x) * s }; }
      if (isPtr(lt) && isPtr(rt) && op === '-') { const s = elemSize(lt) || 1; return { t: T.long, fn: (x, y) => Math.trunc((x - y) / s) }; }
    }
    if (CMPF[op]) {
      let cx = null, cy = null;
      if (isArith(lt) && isArith(rt)) { const C = usual(lt, rt); cx = castFn(lt, C); cy = castFn(rt, C); }
      else if (!(isScalar(lt) && isScalar(rt))) cerr("无法用 '" + op + "' 比较 " + typeName(lt) + ' 和 ' + typeName(rt));
      return { t: T.int, fn: wrap2(CMPF[op], cx, cy) };
    }
    if (!isArith(lt) || !isArith(rt)) cerr("运算符 '" + op + "' 不能用于 " + typeName(lt) + ' 和 ' + typeName(rt));
    if (op === '<<' || op === '>>') {
      if (!isInt(lt) || !isInt(rt)) cerr("运算符 '" + op + "' 只能用于整数");
      const C = promote(lt); const cx = castFn(lt, C); let f;
      if (C.size === 4) {
        if (op === '<<') f = C.uns ? (x, y) => (x << (y & 31)) >>> 0 : (x, y) => x << (y & 31);
        else f = C.uns ? (x, y) => x >>> (y & 31) : (x, y) => x >> (y & 31);
      } else if (op === '<<') f = C.uns ? (x, y) => fromB(BigInt.asUintN(64, toB(x) << BigInt(lo32(y) & 63))) : (x, y) => fromB(BigInt.asIntN(64, toB(x) << BigInt(lo32(y) & 63)));
      else f = (x, y) => fromB(toB(x) >> BigInt(lo32(y) & 63));
      if (C.size === 4 && rt.size === 8) { const g = f; f = (x, y) => g(x, lo32(y)); }
      return { t: C, fn: wrap2(f, cx, null) };
    }
    const C = usual(lt, rt);
    if ((op === '%' || op === '&' || op === '|' || op === '^') && C.k === 'float') cerr("运算符 '" + op + "' 不能用于浮点数");
    return { t: C, fn: wrap2(arithFn(op, C), castFn(lt, C), castFn(rt, C)) };
  }
  function convTo(E, t, what) {
    if ((t.k === 'struct') !== (E.t.k === 'struct') || (t.k === 'struct' && !sameStruct(t, E.t))) cerr((what || '赋值') + '类型不兼容：' + typeName(E.t) + ' → ' + typeName(t));
    if (E.t.k === 'void') cerr('void 值不能被使用');
    if (isPtr(t) && E.t.k === 'float') cerr('不能把浮点数赋给指针');
    const c = castFn(E.t, t); const f = E.f; return c ? () => c(f()) : f;
  }

  function ex(e) {
    cLine = e.line;
    switch (e.k) {
      case 'num': { const v = e.v; return { t: e.type, f: () => v }; }
      case 'str': { const a = strAddr(e.v); return { t: arr(T.char, e.v.length + 1), f: () => a }; }
      case 'id': {
        const s = lookup(e.name);
        if (!s && e.name === '__func__' && cur) { const a = strAddr(utf8(cur.name)); return { t: arr(T.char, utf8(cur.name).length + 1), f: () => a }; }
        if (!s) cerr("未声明的标识符 '" + e.name + "'");
        if (s.kind === 'e') { const v = s.v; return { t: s.t || T.int, f: () => v }; }
        if (s.kind === 'f') { const v = FBASE + s.fn.id; return { t: s.fn.type, f: () => v, fn: s.fn }; }
        const t = s.t;
        if (s.kind === 'g') {
          const a = s.addr; const af = () => a;
          if (t.k === 'arr' || t.k === 'struct') return { t, f: af, lv: af };
          const ld = loader(t, false); return { t, f: () => ld(a), lv: af };
        }
        const o = s.off;
        if (s.ind) { const af = () => dv.getUint32(fp + o, true); return { t, f: af, lv: af }; }
        const af = () => fp + o;
        if (t.k === 'arr' || t.k === 'struct') return { t, f: af, lv: af };
        if (t === T.int) return { t, f: () => dv.getInt32(fp + o, true), lv: af };
        const ld = loader(t, false); return { t, f: () => ld(fp + o), lv: af };
      }
      case 'idx': {
        let A = rv(ex(e.a)), I = rv(ex(e.i));
        if (isInt(A.t) && isPtr(I.t)) { const tmp = A; A = I; I = tmp; }
        if (!isPtr(A.t)) cerr('下标运算 [] 需要数组或指针');
        if (!isInt(I.t)) cerr('数组下标必须是整数');
        const et = A.t.to; if (et.k === 'void') cerr('不能对 void* 做下标运算');
        const pf = A.f, xf = I.f;
        if (isVla(et)) { const sf = rtSize(et); return mkLv(et, () => pf() + toN(xf()) * sf()); }
        const s = sizeOf(et);
        if (I.t.size === 8) return mkLv(et, () => pf() + toN(xf()) * s);
        return mkLv(et, () => pf() + xf() * s);
      }
      case 'mem': {
        let base, st;
        if (e.arrow) { const A = rv(ex(e.a)); if (!isPtr(A.t) || A.t.to.k !== 'struct') cerr("'->' 左边必须是结构体指针"); st = A.t.to; base = A.f; }
        else { const A = ex(e.a); if (A.t.k !== 'struct') cerr("'.' 左边必须是结构体" + (isPtr(A.t) && A.t.to.k === 'struct' ? "（指针请用 '->'）" : '')); st = A.t; base = A.f; }
        if (!st.complete) cerr('结构体类型不完整');
        const fd = st.fields.find(x => x.name === e.name);
        if (!fd) cerr(typeName(st) + " 没有成员 '" + e.name + "'");
        const off = fd.off;
        if (fd.bits) { const B = bfAccess(fd); const af = off ? () => base() + off : base; const g = B.get; return { t: B.rt, f: () => g(af()), lv: af, bf: B }; }
        return mkLv(fd.type, off ? () => base() + off : base);
      }
      case 'un': {
        if (e.op === '*') {
          const A = rv(ex(e.a)); if (!isPtr(A.t)) cerr('不能对非指针类型 ' + typeName(A.t) + ' 解引用');
          const t = A.t.to; if (t.k === 'func') return { t, f: A.f, fn: A.fn };
          return mkLv(t, A.f);
        }
        if (e.op === '&') {
          const A = ex(e.a); if (A.t.k === 'func') return { t: ptr(A.t), f: A.f, fn: A.fn };
          if (A.bf) cerr('不能对位域成员取地址');
          if (!A.lv) cerr("'&' 需要一个变量（左值）"); return { t: ptr(A.t), f: A.lv };
        }
        if (e.op === '!') { const A = rv(ex(e.a)); if (!isScalar(A.t)) cerr("'!' 的操作数类型无效"); const af = A.f; return { t: T.int, f: () => af() ? 0 : 1 }; }
        const A = rv(ex(e.a)); if (!isArith(A.t)) cerr("一元 '" + e.op + "' 的操作数必须是数值");
        if (e.op === '~' && !isInt(A.t)) cerr("'~' 只能用于整数");
        const t = promote(A.t); const cv = castFn(A.t, t) || id; const n = normFor(t); const af = A.f;
        if (e.op === '+') return { t, f: () => cv(af()) };
        if (e.op === '-') { if (t === T.int) return { t, f: () => (-af()) | 0 }; return { t, f: () => n(-cv(af())) }; }
        if (t.size === 8) return { t, f: () => n(~toB(cv(af()))) };
        return { t, f: () => n(~cv(af())) };
      }
      case 'pre': case 'post': {
        const A = ex(e.a); if (!A.lv || A.t.k === 'arr' || A.t.k === 'struct') cerr("'" + e.op + "' 需要可修改的变量");
        const t = A.t, af = A.lv;
        if (A.bf) {
          const g = A.bf.get, pu = A.bf.put, d = e.op === '++' ? 1 : -1;
          const add = o => typeof o === 'bigint' ? o + BigInt(d) : o + d;
          if (e.k === 'pre') return { t, f: () => { const a = af(); pu(a, add(g(a))); return g(a); } };
          return { t, f: () => { const a = af(); const o = g(a); pu(a, add(o)); return o; } };
        }
        const ld = loader(t, true), stf = storer(t);
        if (isPtr(t) && isVla(t.to)) {
          const sf = rtSize(t.to), sg = e.op === '++' ? 1 : -1;
          if (e.k === 'pre') return { t, f: () => { const a = af(); const v = ld(a) + sg * sf(); stf(a, v); return v; } };
          return { t, f: () => { const a = af(); const o = ld(a); stf(a, o + sg * sf()); return o; } };
        }
        const d = (isPtr(t) ? elemSize(t) : 1) * (e.op === '++' ? 1 : -1); const n = normFor(t);
        const add = (t.k === 'int' && t.size === 8) ? (o => typeof o === 'bigint' ? o + BigInt(d) : o + d) : (o => o + d);
        if (e.k === 'pre') return { t, f: () => { const a = af(); const v = n(add(ld(a))); stf(a, v); return v; } };
        return { t, f: () => { const a = af(); const o = ld(a); stf(a, n(add(o))); return o; } };
      }
      case 'bin': {
        if (e.op === '&&' || e.op === '||') {
          const A = rv(ex(e.a)), B = rv(ex(e.b)); const af = A.f, bf = B.f;
          if (!isScalar(A.t) || !isScalar(B.t)) cerr("'" + e.op + "' 的操作数类型无效");
          return { t: T.int, f: e.op === '&&' ? () => (af() ? (bf() ? 1 : 0) : 0) : () => (af() ? 1 : (bf() ? 1 : 0)) };
        }
        const A = rv(ex(e.a)), B = rv(ex(e.b)); const Bn = buildBin(e.op, A.t, B.t);
        const fn = Bn.fn, af = A.f, bf = B.f;
        return { t: Bn.t, f: () => fn(af(), bf()) };
      }
      case 'assign': {
        const A = ex(e.a);
        if (A.t.k === 'arr') cerr('数组不能被整体赋值（字符串请用 strcpy）');
        if (!A.lv || A.t.k === 'func') cerr('赋值号左边必须是可修改的变量');
        const B = rv(ex(e.b)); const t = A.t, af = A.lv;
        if (A.bf) {
          const g = A.bf.get, pu = A.bf.put, ft = A.bf.type;
          if (e.op === '=') { const cv = convTo(B, ft); return { t, f: () => { const a = af(); pu(a, cv()); return g(a); } }; }
          const Bn = buildBin(e.op.slice(0, -1), t, B.t); const c2 = castFn(Bn.t, ft) || id; const bf = B.f, fn = Bn.fn;
          return { t, f: () => { const a = af(); const r = bf(); pu(a, c2(fn(g(a), r))); return g(a); } };
        }
        if (t.k === 'struct') {
          if (e.op !== '=') cerr('结构体不支持复合赋值');
          if (!sameStruct(B.t, t)) cerr('结构体赋值类型不匹配');
          const sz = sizeOf(t), bf = B.f; return { t, f: () => { const a = af(); const s = bf(); u8.copyWithin(a, s, s + sz); return a; } };
        }
        const stf = storer(t);
        if (e.op === '=') { const cv = convTo(B, t); return { t, f: () => { const a = af(); const v = cv(); stf(a, v); return v; } }; }
        const Bn = buildBin(e.op.slice(0, -1), t, B.t); const cv = castFn(Bn.t, t) || id; const ld = loader(t, true); const bf = B.f, fn = Bn.fn;
        return { t, f: () => { const a = af(); const r = bf(); const v = cv(fn(ld(a), r)); stf(a, v); return v; } };
      }
      case 'cond': {
        const C = rv(ex(e.c)), A = rv(ex(e.a)), B = rv(ex(e.b)); let t;
        if (isArith(A.t) && isArith(B.t)) t = usual(A.t, B.t); else if (isPtr(A.t)) t = A.t; else if (isPtr(B.t)) t = B.t; else t = A.t;
        const ca = castFn(A.t, t) || id, cb = castFn(B.t, t) || id; const cf = C.f, af = A.f, bf = B.f;
        return { t, f: () => cf() ? ca(af()) : cb(bf()) };
      }
      case 'comma': { const A = ex(e.a), B = rv(ex(e.b)); const af = A.f, bf = B.f; return { t: B.t, f: () => { af(); return bf(); } }; }
      case 'cast': {
        const A = rv(ex(e.a)); const t = e.type;
        if (t.k === 'void') return { t, f: A.f };
        if (t.k === 'struct' || t.k === 'arr') cerr('无效的类型转换');
        if (isPtr(t) && A.t.k === 'float') cerr('不能把浮点数转换为指针');
        const cv = castFn(A.t, t); const af = A.f; return { t, f: cv ? () => cv(af()) : af };
      }
      case 'sizeof_t': { if (isVla(e.type)) return { t: T.ulong, f: rtSize(e.type) }; const sz = sizeOf(e.type); return { t: T.ulong, f: () => sz }; }
      case 'sizeof_e': {
        const A = ex(e.a); if (A.bf) cerr('不能对位域成员使用 sizeof');
        if (isVla(A.t)) return { t: T.ulong, f: rtSize(A.t) };
        if (A.t.k === 'func') cerr('不能对函数使用 sizeof');
        const sz = sizeOf(A.t); return { t: T.ulong, f: () => sz };
      }
      case 'va_arg': {
        const A = ex(e.ap); if (!A.lv) cerr('va_arg 的第一个参数必须是 va_list 变量');
        const t = e.type; if (t.k === 'void' || t.k === 'arr' || t.k === 'func') cerr('va_arg 的类型无效');
        if (t.k === 'struct') cerr('暂不支持用 va_arg 读取结构体');
        const af = A.lv; const n = t.k === 'int' ? normFor(t) : t.k === 'float' ? (t.size === 4 ? v => Math.fround(toN(v)) : toN) : v => lo32(v) >>> 0;
        return { t, f: () => { chk(af(), 8); const st = vaGet(dv.getUint32(af(), true)); if (st.i >= st.a.length) rerr('va_arg 读取的参数比实际传入的多'); return n(st.a[st.i++]); } };
      }
      case 'compound': {
        let t = e.type;
        if (isVla(t)) cerr('复合字面量不能是变长数组');
        if (t.k === 'arr' && t.n == null) t = arr(t.of, inferLen(t, e.init));
        if (t.k === 'void' || t.k === 'func') cerr('复合字面量的类型无效');
        const w = initWriter(t, e.init.k === 'init' ? e.init : { k: 'init', items: [e.init], line: e.line });
        let af;
        if (cur) { const off = allocLocal(t); af = () => { const a = fp + off; w(a); return a; }; }
        else { const a = dalloc(sizeOf(t), alignOf(t)); af = () => { w(a); return a; }; }
        if (t.k === 'arr' || t.k === 'struct') return { t, f: af, lv: af };
        const ld = loader(t, false); return { t, f: () => ld(af()), lv: af };
      }
      case 'call': return compileCall(e);
      case 'init': cerr('这里不能使用 { } 初始化列表');
    }
    cerr('无法编译的表达式');
  }
  function compileCall(e) {
    let F;
    if (e.f.k === 'id' && !lookup(e.f.name)) cerr("未声明的函数 '" + e.f.name + "'", e.line);
    F = rv(ex(e.f));
    if (!(F.t.k === 'ptr' && F.t.to.k === 'func')) cerr('被调用的对象不是函数', e.line);
    const ft = F.t.to; const fname = F.fn ? "'" + F.fn.name + "'" : '';
    if (e.args.length < ft.params.length && !ft.unspecified) cerr('调用函数 ' + fname + ' 的参数太少（需要 ' + ft.params.length + ' 个）', e.line);
    if (e.args.length > ft.params.length && !ft.variadic && !ft.unspecified) cerr('调用函数 ' + fname + ' 的参数太多（需要 ' + ft.params.length + ' 个）', e.line);
    const argsC = e.args.map((a, i) => {
      const A = rv(ex(a));
      if (i < ft.params.length) return convTo(A, ft.params[i], '第 ' + (i + 1) + ' 个参数');
      if (A.t.k === 'void') cerr('void 值不能作为参数');
      const t2 = A.t.k === 'float' ? T.double : isInt(A.t) ? promote(A.t) : A.t;
      const c = castFn(A.t, t2); const af = A.f; return c ? () => c(af()) : af;
    });
    const n = argsC.length; const fn = F.fn; const ret = ft.ret; const L = e.line;
    const getArgs = () => { const a = new Array(n); for (let i = 0; i < n; i++) a[i] = argsC[i](); return a; };
    let call;
    if (fn && fn.builtin) { const b = fn.builtin; call = () => { const a = getArgs(); line = L; return b(a); }; }
    else if (fn) call = () => callUser(fn, getArgs());
    else { const ff = F.f; call = () => { const f = fnFromPtr(ff()); const a = getArgs(); return callAny(f, a); }; }
    if (ret.k === 'struct') {
      if (!cur) cerr('全局初始化中不能调用返回结构体的函数');
      const sz = sizeOf(ret); const off = allocLocal(ret);
      return { t: ret, f: () => { const r = call(); const d = fp + off; u8.copyWithin(d, r, r + sz); return d; } };
    }
    return { t: ret, f: call };
  }
  function callUser(fn, args) {
    if (!fn.body) {
      if (fn.builtin) return fn.builtin(args);
      if (SIGS[fn.name]) { fn.builtin = IMPL[fn.name]; return fn.builtin(args); }
      rerr("函数 '" + fn.name + "' 只有声明，没有定义");
    }
    if (++depth > MAXDEPTH) rerr('栈溢出：递归太深');
    if (++steps > MAXSTEPS) tmo();
    const ofp = fp, osp = sp, oline = line;
    const nsp = (sp - fn.frameSize) & ~15;
    if (nsp < STACK_LIMIT) rerr('栈溢出：递归太深或局部变量太大');
    sp = fp = nsp;
    const ps = fn.params;
    for (let i = 0; i < ps.length; i++) { const p = ps[i]; if (p.store) p.store(fp + p.off, args[i]); else u8.copyWithin(fp + p.off, args[i], args[i] + p.size); }
    if (fn.va) vaStack.push(args.slice(ps.length));
    const sig = fn.body();
    const r = sig === 3 ? retVal : 0;
    if (fn.va) vaStack.pop();
    fp = ofp; sp = osp; depth--; line = oline;
    return r;
  }

  // ---- initializers ----
  let lastCount = 0;
  function isStructExpr(it, t) { return it.k !== 'init' && sameStruct(ex(it).t, t); }
  function subItems(items, pos, it) { const items2 = items.slice(); items2[pos] = Object.assign({}, it, { desig: it.desig.slice(1) }); return items2; }
  function fillAgg(t, items, pos, off, ops, full, firstDesig) {
    if (t.k === 'arr') {
      const et = t.of, es = sizeOf(et); let i = 0, mx = 0, first = true;
      while (pos < items.length) {
        const it = items[pos];
        if (it.desig) {
          if (!full && !(first && firstDesig)) break;
          const d = it.desig[0];
          if (d.index == null) cerr('数组初始化不能用 .成员 指定', it.line);
          i = d.index;
          const last = d.end != null ? d.end : i;
          if (t.n != null && last >= t.n) cerr('指定初始化的下标 ' + last + ' 超出了数组大小 ' + t.n, it.line);
          if (it.desig.length > 1) {
            if (d.end != null) cerr('暂不支持范围指定后再嵌套指定', it.line);
            if (et.k !== 'arr' && et.k !== 'struct') cerr('无效的嵌套指定初始化', it.line);
            pos = fillAgg(et, subItems(items, pos, it), pos, off + i * es, ops, false, true);
            i++; if (i > mx) mx = i; first = false; continue;
          }
          if (d.end != null) {
            for (let k = i; k <= d.end; k++) fillOne(et, items, pos, off + k * es, ops);
            pos++; i = d.end + 1; if (i > mx) mx = i; first = false; continue;
          }
        }
        first = false;
        if (t.n != null && i >= t.n) { if (full) cerr('初始化项太多（数组只有 ' + t.n + ' 个元素）', it.line); break; }
        pos = fillOne(et, items, pos, off + i * es, ops); i++; if (i > mx) mx = i;
      }
      lastCount = mx; return pos;
    }
    if (t.k === 'struct') {
      let fi = 0, first = true; const fs = t.fields; const lim = t.union ? 1 : fs.length;
      while (pos < items.length) {
        const it = items[pos];
        if (it.desig) {
          if (!full && !(first && firstDesig)) break;
          const d = it.desig[0];
          if (d.field == null) cerr('结构体初始化不能用 [下标] 指定', it.line);
          fi = fs.findIndex(f => f.name === d.field); if (fi < 0) cerr(typeName(t) + " 没有成员 '" + d.field + "'", it.line);
          if (it.desig.length > 1) {
            const ft = fs[fi].type;
            if (ft.k !== 'arr' && ft.k !== 'struct') cerr("成员 '" + d.field + "' 不是数组或结构体，不能继续指定", it.line);
            pos = fillAgg(ft, subItems(items, pos, it), pos, off + fs[fi].off, ops, false, true);
            fi++; first = false; continue;
          }
        }
        else if (fi >= lim) { if (full) cerr('结构体初始化项太多', it.line); break; }
        first = false;
        const f = fs[fi];
        if (f.bits) {
          const src = it.k === 'init' ? (it.items[0] || { k: 'num', v: 0, type: T.int, line: it.line }) : it;
          const cv = convTo(rv(ex(src)), f.type, '初始化'); const put = bfAccess(f).put; const o = off + f.off;
          ops.push(b => put(b + o, cv())); pos++; fi++; continue;
        }
        pos = fillOne(f.type, items, pos, off + f.off, ops); fi++;
      }
      return pos;
    }
    cerr('无效的初始化');
  }
  function fillOne(et, items, pos, off, ops) {
    const it = items[pos];
    if (it.k === 'init') {
      if (isScalar(et) || bracedStr(et, it)) { const w = initWriter(et, isScalar(et) ? (it.items[0] || { k: 'num', v: 0, type: T.int, line: it.line }) : it); ops.push(b => w(b + off)); }
      else fillAgg(et, it.items, 0, off, ops, true);
      return pos + 1;
    }
    if (et.k === 'arr' && it.k === 'str' && isInt(et.of) && et.of.size === 1) { const w = initWriter(et, it); ops.push(b => w(b + off)); return pos + 1; }
    if (et.k === 'arr' || (et.k === 'struct' && !isStructExpr(it, et))) return fillAgg(et, items, pos, off, ops, false);
    const w = initWriter(et, it); ops.push(b => w(b + off)); return pos + 1;
  }
  const bracedStr = (t, init) => init.k === 'init' && t.k === 'arr' && isInt(t.of) && t.of.size === 1 && init.items.length === 1 && init.items[0].k === 'str' && !init.items[0].desig;
  function initWriter(t, init) {
    if (bracedStr(t, init)) init = init.items[0];
    if (init.k !== 'init') {
      if (t.k === 'arr') {
        if (init.k === 'str' && isInt(t.of) && t.of.size === 1) {
          const bytes = init.v, n = t.n;
          if (bytes.length > n) cerr('字符串太长，超出了数组大小 ' + n, init.line);
          return b => { u8.set(bytes, b); u8.fill(0, b + bytes.length, b + n); };
        }
        cerr('数组初始化需要使用 { }', init.line);
      }
      const E = rv(ex(init));
      if (t.k === 'struct') { if (!sameStruct(E.t, t)) cerr('结构体初始化类型不匹配', init.line); const sz = t.size, ef = E.f; return b => { const s = ef(); u8.copyWithin(b, s, s + sz); }; }
      const cv = convTo(E, t, '初始化'); const stf = storer(t);
      return b => stf(b, cv());
    }
    if (isScalar(t)) return initWriter(t, init.items[0] || { k: 'num', v: 0, type: T.int, line: init.line });
    const ops = []; fillAgg(t, init.items, 0, 0, ops, true);
    const sz = sizeOf(t), n = ops.length;
    return b => { u8.fill(0, b, b + sz); for (let i = 0; i < n; i++) ops[i](b); };
  }
  function inferLen(t, init) {
    if (bracedStr(t, init)) init = init.items[0];
    if (init.k === 'str' && isInt(t.of) && t.of.size === 1) return init.v.length + 1;
    if (init.k !== 'init') cerr('无法推断数组大小');
    fillAgg(arr(t.of, null), init.items, 0, 0, [], true); return lastCount;
  }

  // ---- statements ----
  function zeroInit(init) { return init.k === 'init' && init.items.every(x => !x.desig && x.k === 'num' && x.v === 0); }
  function localDecl(s) {
    const ops = [];
    for (const d of s.decls) {
      cLine = d.line; let t = d.type;
      if (t.k === 'func') { const f = getFunc(d.name, t, d.line, d.storage); scopes[scopes.length - 1].set(d.name, { kind: 'f', fn: f }); continue; }
      if (d.storage === 'extern') { const g = TU.get(d.name) || G.get(d.name); if (g) { scopes[scopes.length - 1].set(d.name, g); continue; } }
      if (vlaIn(t)) {
        if (d.storage === 'static' || d.storage === 'extern') cerr("静态变量 '" + d.name + "' 不能是变长数组", d.line);
        const szOps = []; const it = instVla(t, szOps); const L = d.line; const ns0 = szOps.length;
        if (isVla(it)) {
          if (d.init && !zeroInit(d.init)) cerr("变长数组 '" + d.name + "' 不能带初始化列表（只允许 = {0}，或之后用循环赋值）", d.line);
          const zero = !!d.init;
          const addrSlot = allocLocal(ptr(T.void)), pre = allocLocal(T.long);
          if (blockVla.length) blockVla[blockVla.length - 1].push(pre);
          declare(d.name, { kind: 'l', t: it, off: addrSlot, ind: true }, d.line);
          const sf = rtSize(it);
          ops.push(() => {
            line = L; for (let i = 0; i < ns0; i++) szOps[i]();
            const size = sf(); const pv = dv.getUint32(fp + pre, true);
            if (pv) sp = pv; else dv.setUint32(fp + pre, sp, true);
            if (size > MEMSZ) rerr('栈溢出：变长数组太大');
            const ns = (sp - size) & ~15; if (ns < STACK_LIMIT) rerr('栈溢出：变长数组太大（' + size + ' 字节）');
            sp = ns; dv.setUint32(fp + addrSlot, ns, true); if (zero) u8.fill(0, ns, ns + size);
          });
          continue;
        }
        t = it; for (const o of szOps) ops.push(() => { line = L; o(); });
      }
      if (t.k === 'arr' && t.n == null) { if (!d.init) cerr("数组 '" + d.name + "' 缺少大小"); t = arr(t.of, inferLen(t, d.init)); }
      if (t.k === 'void') cerr("变量 '" + d.name + "' 不能是 void 类型");
      sizeOf(t);
      if (d.storage === 'static' || d.storage === 'extern') {
        const a = dalloc(sizeOf(t), alignOf(t)); declare(d.name, { kind: 'g', t, addr: a }, d.line);
        if (d.init) { const w = initWriter(t, d.init); globalInits.push(() => w(a)); }
        continue;
      }
      const off = allocLocal(t);
      declare(d.name, { kind: 'l', t, off }, d.line);
      if (d.init) { const w = initWriter(t, d.init); const L = d.line; ops.push(() => { line = L; w(fp + off); }); }
    }
    const n = ops.length; if (!n) return () => 0;
    if (n === 1) { const o = ops[0]; return () => { o(); return 0; }; }
    return () => { for (let i = 0; i < n; i++) ops[i](); return 0; };
  }
  function cond(e) { const C = rv(ex(e)); if (!isScalar(C.t)) cerr('条件表达式必须是数值或指针'); return C.f; }
  function st(s) {
    cLine = s.line; const L = s.line;
    switch (s.k) {
      case 'block': {
        scopes.push(new Map()); blockVla.push([]); const a = s.items.map(st); const vl = blockVla.pop(); scopes.pop(); const n = a.length;
        const lm = labelsOf(s);
        if (!lm.size && !vl.length) {
          if (n === 0) return () => 0; if (n === 1) return a[0];
          return () => { for (let i = 0; i < n; i++) { const r = a[i](); if (r) return r; } return 0; };
        }
        const idx = new Map(); s.items.forEach((it, i) => { for (const l of labelsOf(it)) idx.set(l, i); });
        const nv = vl.length;
        return () => {
          const s0 = sp; for (let k = 0; k < nv; k++) dv.setUint32(fp + vl[k], 0, true);
          let i = 0; if (gotoL !== null) { const j = idx.get(gotoL); if (j !== undefined) i = j; }
          for (; i < n; i++) {
            const r = a[i]();
            if (r) { if (r === 4) { const j = idx.get(gotoL); if (j !== undefined) { i = j - 1; continue; } } sp = s0; return r; }
          }
          sp = s0; return 0;
        };
      }
      case 'label': { const inner = st(s.stmt); const nm = s.name; return () => { if (gotoL === nm) gotoL = null; return inner(); }; }
      case 'goto': {
        if (!cur || !cur.labels.has(s.name)) cerr("goto 的目标标签 '" + s.name + "' 未定义", L);
        const nm = s.name; return () => { line = L; if (++steps > MAXSTEPS) tmo(); gotoL = nm; return 4; };
      }
      case 'empty': return () => 0;
      case 'expr': { const f = ex(s.e).f; return () => { line = L; f(); return 0; }; }
      case 'decl': return localDecl(s);
      case 'if': {
        const c = cond(s.c); const t = st(s.t); const f = s.f ? st(s.f) : null;
        if (labelsOf(s).size) { const tl = labelsOf(s.t); return () => { if (gotoL !== null) return tl.has(gotoL) ? t() : f ? f() : 0; line = L; return c() ? t() : f ? f() : 0; }; }
        return f ? () => { line = L; return c() ? t() : f(); } : () => { line = L; return c() ? t() : 0; }; }
      case 'while': {
        const c = cond(s.c); loopD++; const b = st(s.body); loopD--;
        if (labelsOf(s.body).size) return () => { let sk = gotoL !== null; for (;;) { if (sk) sk = false; else { line = L; if (!c()) return 0; } if (++steps > MAXSTEPS) tmo(); const r = b(); if (r === 1) return 0; if (r > 2) return r; } };
        return () => { for (;;) { line = L; if (!c()) return 0; if (++steps > MAXSTEPS) tmo(); const r = b(); if (r === 1) return 0; if (r > 2) return r; } };
      }
      case 'do': {
        loopD++; const b = st(s.body); loopD--; const c = cond(s.c);
        return () => { for (;;) { if (++steps > MAXSTEPS) tmo(); const r = b(); if (r === 1) return 0; if (r > 2) return r; line = L; if (!c()) return 0; } };
      }
      case 'for': {
        scopes.push(new Map());
        const init = s.init ? st(s.init) : null; const c = s.c ? cond(s.c) : null; const stp = s.step ? ex(s.step).f : null;
        loopD++; const b = st(s.body); loopD--; scopes.pop();
        if (labelsOf(s.body).size) return () => {
          let sk = gotoL !== null; if (!sk) { line = L; if (init) init(); }
          for (;;) { if (sk) sk = false; else if (c) { line = L; if (!c()) return 0; } if (++steps > MAXSTEPS) tmo(); const r = b(); if (r === 1) return 0; if (r > 2) return r; if (stp) { line = L; stp(); } }
        };
        return () => {
          line = L; if (init) init();
          for (;;) { if (c) { line = L; if (!c()) return 0; } if (++steps > MAXSTEPS) tmo(); const r = b(); if (r === 1) return 0; if (r > 2) return r; if (stp) { line = L; stp(); } }
        };
      }
      case 'ret': {
        if (!cur) cerr('return 不在函数中');
        const rt = cur.ret;
        if (!s.e) return () => { retVal = 0; return 3; };
        const E = rv(ex(s.e));
        if (rt.k === 'void') { const f = E.f; return () => { line = L; f(); retVal = 0; return 3; }; }
        const f = convTo(E, rt, '返回值');
        return () => { line = L; retVal = f(); return 3; };
      }
      case 'break': if (loopD + swD === 0) cerr('break 不在循环或 switch 中'); return () => 1;
      case 'cont': if (loopD === 0) cerr('continue 不在循环中'); return () => 2;
      case 'switch': {
        const E = rv(ex(s.e)); if (!isInt(E.t)) cerr('switch 的表达式必须是整数'); const ef = E.f;
        const items = s.body.k === 'block' ? s.body.items : [s.body];
        scopes.push(new Map()); swD++;
        const labels = new Map(); let def = -1; const code = [];
        for (const it of items) {
          let x = it;
          while (x.k === 'case' || x.k === 'default') {
            if (x.k === 'case') { if (labels.has(x.v)) cerr('重复的 case ' + x.v, x.line); labels.set(x.v, code.length); }
            else { if (def >= 0) cerr('重复的 default', x.line); def = code.length; }
            x = x.stmt;
          }
          code.push(st(x));
        }
        swD--; scopes.pop(); const n = code.length;
        const lmap = new Map(); items.forEach((it, k) => { for (const l of labelsOf(it)) lmap.set(l, k); });
        if (lmap.size) return () => {
          let i;
          if (gotoL !== null && lmap.has(gotoL)) i = lmap.get(gotoL);
          else { line = L; const v = toN(ef()); i = labels.get(v); if (i === undefined) i = def; if (i < 0) return 0; }
          for (; i < n; i++) { const r = code[i](); if (r === 1) return 0; if (r) { if (r === 4 && lmap.has(gotoL)) { i = lmap.get(gotoL) - 1; continue; } return r; } }
          return 0;
        };
        return () => {
          line = L; const v = toN(ef()); let i = labels.get(v); if (i === undefined) i = def; if (i < 0) return 0;
          for (; i < n; i++) { const r = code[i](); if (r === 1) return 0; if (r) return r; }
          return 0;
        };
      }
      case 'case': case 'default': cerr('case/default 必须直接位于 switch 中');
    }
    cerr('无法编译的语句');
  }
  function globalDecl(s, externPass) {
    for (const d of s.decls) {
      cLine = d.line; let t = d.type;
      if (t.k === 'func') continue;
      const isExt = d.storage === 'extern' && !d.init;
      if (isExt !== externPass) continue;
      if (vlaIn(t)) cerr("全局数组 '" + d.name + "' 的大小必须是常量");
      const isStatic = d.storage === 'static';
      const ex0 = TU.get(d.name) || (isStatic ? null : G.get(d.name));
      if (ex0) {
        if (ex0.kind !== 'g') cerr("重复定义了 '" + d.name + "'");
        if (d.init) { const w = initWriter(ex0.t, d.init); const a = ex0.addr; globalInits.push(() => w(a)); }
        continue;
      }
      if (t.k === 'arr' && t.n == null) { if (!d.init) cerr(isExt ? "外部数组 '" + d.name + "' 没有定义" : "数组 '" + d.name + "' 缺少大小"); t = arr(t.of, inferLen(t, d.init)); }
      if (t.k === 'void') cerr("变量 '" + d.name + "' 不能是 void 类型");
      const a = dalloc(sizeOf(t), alignOf(t)); (isStatic ? TU : G).set(d.name, { kind: 'g', t, addr: a });
      if (d.init) { const w = initWriter(t, d.init); globalInits.push(() => w(a)); }
    }
  }
  function funcDef(s) {
    const fn = getFunc(s.name, s.type, s.line, s.storage);
    if (fn.body) cerr("函数 '" + s.name + "' 重复定义", s.line);
    fn.type = s.type; fn.builtin = null; fn.va = !!s.type.variadic;
    cur = { frame: 0, ret: s.type.ret, name: s.name, labels: labelsOf(s.body) }; scopes.push(new Map()); loopD = 0; swD = 0; blockVla = []; gotoL = null;
    checkLabels(s.body, new Set());
    if (s.type.ret.k === 'struct') sizeOf(s.type.ret);
    fn.params = s.type.params.map((pt, i) => {
      const nm = s.type.names[i]; const off = allocLocal(pt);
      if (nm) declare(nm, { kind: 'l', t: pt, off }, s.line);
      return { off, store: pt.k === 'struct' ? null : storer(pt), size: sizeOf(pt) };
    });
    // variably-modified parameters such as int m[r][c]: evaluate the sizes on entry
    const pops = [];
    s.type.params.forEach((pt, i) => {
      if (!vlaIn(pt)) return; const nt = instVla(pt, pops); const nm = s.type.names[i];
      const en = nm && scopes[scopes.length - 1].get(nm); if (en) en.t = nt;
    });
    fn.body = () => 0; // placeholder so recursion compiles
    let body = st(s.body);
    if (pops.length) { const b0 = body, np = pops.length; body = () => { for (let i = 0; i < np; i++) pops[i](); return b0(); }; }
    scopes.pop(); fn.frameSize = alignUp(cur.frame, 16) + 16; fn.body = body; cur = null;
  }

  // ---- main ----
  let exitCode = 0, error = null;
  const files = opts.files && typeof opts.files === 'object' ? opts.files : null;
  const mainName = opts.mainName || 'main.c';
  const fileNames = [mainName];
  if (files) for (const k of Object.keys(files)) if (k !== mainName) fileNames.push(k);
  try {
    const units = [{ idx: 0, src: String(source) }];
    for (let i = 1; i < fileNames.length; i++) if (/\.c$/i.test(fileNames[i])) units.push({ idx: i, src: String(files[fileNames[i]]) });
    for (const u of units) {
      cLine = u.idx * LB + 1;
      const toks = preprocess(u.src, { files, fileNames, idx: u.idx });
      u.P = P = new Parser(toks); u.prog = P.parseProgram(); u.map = new Map();
    }
    const useTU = u => { P = u.P; TU = u.map; scopes.length = 1; scopes.push(TU); };
    for (const u of units) {
      useTU(u);
      for (const d of u.prog) {
        if (d.k === 'func') getFunc(d.name, d.type, d.line, d.storage);
        else for (const dd of d.decls) if (dd.type.k === 'func' && (!SIGS[dd.name] || G.has(dd.name) || TU.has(dd.name))) { cLine = dd.line; getFunc(dd.name, dd.type, dd.line, dd.storage); }
      }
    }
    for (const u of units) { useTU(u); for (const d of u.prog) if (d.k === 'decl') globalDecl(d, false); }
    for (const u of units) { useTU(u); for (const d of u.prog) if (d.k === 'decl') globalDecl(d, true); }
    for (const u of units) { useTU(u); for (const d of u.prog) if (d.k === 'func') funcDef(d); }
    const me = G.get('main');
    if (!me || me.kind !== 'f' || !me.fn.body) cerr('找不到 main 函数', 1);
    let margs = [];
    if (me.fn.params.length >= 2) {
      const s = strAddr(utf8('main')); const av = dalloc(16, 8); dv.setUint32(av, s, true); margs = [1, av];
    } else if (me.fn.params.length === 1) margs = [1];
    heapTop = alignUp(dataTop, 16);
    line = 0;
    for (const g of globalInits) g();
    try { exitCode = callUser(me.fn, margs) | 0; } catch (e1) { if (!(e1 instanceof ExitSig)) throw e1; exitCode = e1.code; }
    while (atexitFns.length) callAny(atexitFns.pop(), []);
  } catch (err) {
    const mk = (kind, ln, message) => { ln = ln || 0; const e = { kind, line: ln % LB, message }; const fi = Math.floor(ln / LB); if (fi > 0 && fileNames[fi]) e.file = fileNames[fi]; return e; };
    if (err instanceof ExitSig) exitCode = err.code;
    else if (err instanceof CErr) { error = mk(err.kind, err.line, err.cmsg); exitCode = err.kind === 'runtime' ? 139 : 1; }
    else if (err instanceof RangeError && /call stack/i.test(err.message)) { error = mk('runtime', line, '栈溢出：递归太深'); exitCode = 139; }
    else { error = mk('internal', line || cLine, '解释器内部错误：' + (err && err.message)); exitCode = 1; }
  }
  try { flush(true); } catch (e2) { /* ignore */ }
  return { exitCode, error };
}

const CInterp = { run, version: '1.1' };
root.CInterp = CInterp;
if (typeof module !== 'undefined' && module.exports) module.exports = CInterp;
})(typeof self !== 'undefined' ? self : typeof globalThis !== 'undefined' ? globalThis : this);
