
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
