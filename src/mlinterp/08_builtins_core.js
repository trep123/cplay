
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
