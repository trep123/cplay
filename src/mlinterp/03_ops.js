
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
