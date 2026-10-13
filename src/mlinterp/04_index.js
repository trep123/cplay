
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
