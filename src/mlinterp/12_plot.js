
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
