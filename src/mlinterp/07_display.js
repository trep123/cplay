
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
