
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
