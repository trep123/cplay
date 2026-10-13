/*!
 * mlplot.js — dependency-free MATLAB-style figure renderer on <canvas>.
 * Browser global: MLPlot
 *   MLPlot.render(containerEl, figSpec, { theme, width, height, aspect }) -> handle
 *   handle = { canvas, destroy(), toPNG(), resize(), update(spec), setTheme(t), resetView() }
 */
(function (root) {
  'use strict';

  /* ------------------------------------------------------------------ constants */
  var ORDER = [[0, 0.4470, 0.7410], [0.8500, 0.3250, 0.0980], [0.9290, 0.6940, 0.1250],
    [0.4940, 0.1840, 0.5560], [0.4660, 0.6740, 0.1880], [0.3010, 0.7450, 0.9330], [0.6350, 0.0780, 0.1840]];
  var FONT_STACK = '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, ' +
    '"PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Noto Sans CJK SC", "Noto Sans SC", ' +
    '"Source Han Sans SC", "WenQuanYi Micro Hei", sans-serif';
  var THEMES = {
    light: { fig: '#f0f0f0', ax: '#ffffff', text: '#262626', axis: '#262626', grid: 'rgba(38,38,38,0.15)',
      minor: 'rgba(38,38,38,0.07)', plane: 'rgba(38,38,38,0.28)', legBg: 'rgba(255,255,255,0.94)', legEdge: '#262626',
      tipBg: 'rgba(255,255,255,0.97)', tipFg: '#1a1a1a', tipEdge: '#8c8c8c', edge: '#000000', dot: '#000' },
    dark: { fig: '#1c1d20', ax: '#26282c', text: '#dedede', axis: '#b8b8b8', grid: 'rgba(255,255,255,0.17)',
      minor: 'rgba(255,255,255,0.07)', plane: 'rgba(255,255,255,0.3)', legBg: 'rgba(38,40,44,0.94)', legEdge: '#8f8f8f',
      tipBg: 'rgba(44,46,50,0.97)', tipFg: '#f0f0f0', tipEdge: '#6a6a6a', edge: '#0a0a0a', dot: '#fff' }
  };
  var TYPES3D = { surf: 1, mesh: 1, plot3: 1, scatter3: 1 };
  var MIN_FS = 10; // px; minimum base font for tick labels (titles are 1.1x)

  /* ------------------------------------------------------------------ helpers */
  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }
  function isArr(a) { return Array.isArray(a) || (ArrayBuffer.isView(a) && !(a instanceof DataView)); }
  function isMat(a) { return isArr(a) && a.length > 0 && isArr(a[0]); }
  function N(v) { return (v === null || v === undefined || v === '') ? NaN : +v; }
  function fin(v) { return typeof v === 'number' && isFinite(v); }
  function vec(a) {
    if (a == null) return null;
    if (!isArr(a)) return [N(a)];
    var o = [], i, j;
    if (isMat(a)) { for (i = 0; i < a.length; i++) for (j = 0; j < a[i].length; j++) o.push(N(a[i][j])); return o; }
    for (i = 0; i < a.length; i++) o.push(N(a[i]));
    return o;
  }
  function mat(a) {
    if (a == null) return null;
    if (isMat(a)) return Array.prototype.map.call(a, function (r) { return Array.prototype.map.call(r, N); });
    return [vec(a)];
  }
  function seq(n, s) { var r = new Array(n); for (var i = 0; i < n; i++) r[i] = i + (s == null ? 1 : s); return r; }
  function rgb(c, a) {
    if (!c) return 'rgba(0,0,0,' + (a == null ? 1 : a) + ')';
    if (typeof c === 'string') return c;
    return 'rgba(' + Math.round(clamp01(c[0]) * 255) + ',' + Math.round(clamp01(c[1]) * 255) + ',' +
      Math.round(clamp01(c[2]) * 255) + ',' + (a == null ? 1 : a) + ')';
  }
  function colorArg(c) { // [r,g,b] | 'none' | null | 'flat'/'interp'
    if (c == null) return null;
    if (typeof c === 'string') return c;
    if (isArr(c) && c.length >= 3) return [N(c[0]), N(c[1]), N(c[2])];
    return null;
  }
  function minmax(arr, lo, hi) {
    for (var i = 0; i < arr.length; i++) { var v = arr[i]; if (fin(v)) { if (v < lo) lo = v; if (v > hi) hi = v; } }
    return [lo, hi];
  }
  function lines(t) {
    if (t == null || t === '') return [];
    if (isArr(t)) return Array.prototype.map.call(t, String).filter(function (s) { return s !== ''; });
    return String(t).split('\n');
  }
  function fmtNum(v) {
    if (!fin(v)) return String(v);
    var a = Math.abs(v);
    if (a !== 0 && (a >= 1e6 || a < 1e-4)) return v.toExponential(3).replace(/\.?0+e/, 'e');
    return String(+v.toPrecision(5));
  }

  /* ------------------------------------------------------------------ colormaps */
  var PARULA64 = [[.2081, .1663, .5292], [.2116, .1898, .5777], [.2123, .2138, .6270], [.2081, .2386, .6771], [.1959, .2645, .7279], [.1707, .2919, .7792], [.1253, .3242, .8303], [.0591, .3598, .8683], [.0117, .3875, .8820], [.0060, .4086, .8828], [.0165, .4266, .8786], [.0329, .4430, .8720], [.0498, .4586, .8641], [.0629, .4737, .8554], [.0723, .4887, .8467], [.0779, .5040, .8384], [.0793, .5200, .8312], [.0749, .5375, .8263], [.0641, .5570, .8240], [.0488, .5772, .8228], [.0343, .5966, .8199], [.0265, .6137, .8135], [.0239, .6287, .8038], [.0231, .6418, .7913], [.0228, .6535, .7768], [.0267, .6642, .7607], [.0384, .6743, .7436], [.0590, .6838, .7254], [.0843, .6928, .7062], [.1133, .7015, .6859], [.1453, .7098, .6646], [.1801, .7177, .6424], [.2178, .7250, .6193], [.2586, .7317, .5954], [.3022, .7376, .5712], [.3482, .7424, .5473], [.3953, .7459, .5244], [.4420, .7481, .5033], [.4871, .7491, .4840], [.5300, .7491, .4661], [.5709, .7485, .4494], [.6099, .7473, .4337], [.6473, .7456, .4188], [.6834, .7435, .4044], [.7184, .7411, .3905], [.7525, .7384, .3768], [.7858, .7356, .3633], [.8185, .7327, .3498], [.8507, .7299, .3360], [.8824, .7274, .3217], [.9139, .7258, .3063], [.9450, .7261, .2886], [.9739, .7314, .2666], [.9938, .7455, .2403], [.9990, .7653, .2164], [.9955, .7861, .1967], [.9880, .8066, .1794], [.9789, .8271, .1633], [.9697, .8481, .1475], [.9626, .8705, .1309], [.9589, .8949, .1132], [.9598, .9218, .0948], [.9661, .9514, .0755], [.9763, .9831, .0538]];
  var VIRIDIS9 = [[.267004, .004874, .329415], [.278826, .175490, .483397], [.229739, .322361, .545706], [.172719, .448791, .557885], [.127568, .566949, .550556], [.157851, .683765, .501686], [.369214, .788888, .382914], [.678489, .863742, .189503], [.993248, .906157, .143936]];
  function tableInterp(tab, t) {
    var f = clamp01(t) * (tab.length - 1), i = Math.floor(f), u = f - i;
    if (i >= tab.length - 1) return tab[tab.length - 1].slice();
    var a = tab[i], b = tab[i + 1];
    return [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u, a[2] + (b[2] - a[2]) * u];
  }
  function hsv2rgb(h, s, v) {
    var i = Math.floor(h * 6), f = h * 6 - i, p = v * (1 - s), q = v * (1 - f * s), t = v * (1 - (1 - f) * s);
    switch (((i % 6) + 6) % 6) {
      case 0: return [v, t, p]; case 1: return [q, v, p]; case 2: return [p, v, t];
      case 3: return [p, q, v]; case 4: return [t, p, v]; default: return [v, p, q];
    }
  }
  var CMAPS = {
    parula: function (t) { return tableInterp(PARULA64, t); },
    viridis: function (t) { return tableInterp(VIRIDIS9, t); },
    jet: function (t) { return [clamp01(1.5 - Math.abs(4 * t - 3)), clamp01(1.5 - Math.abs(4 * t - 2)), clamp01(1.5 - Math.abs(4 * t - 1))]; },
    hot: function (t) { return [clamp01(t / 0.375), clamp01((t - 0.375) / 0.375), clamp01((t - 0.75) / 0.25)]; },
    gray: function (t) { return [t, t, t]; },
    cool: function (t) { return [t, 1 - t, 1]; },
    hsv: function (t) { return hsv2rgb(t * 0.984, 1, 1); },
    turbo: function (x) {
      return [0.13572138 + x * (4.61539260 + x * (-42.66032258 + x * (132.13108234 + x * (-152.94239396 + x * 59.28637943)))),
        0.09140261 + x * (2.19418839 + x * (4.84296658 + x * (-14.18503333 + x * (4.27729857 + x * 2.82956604)))),
        0.10667330 + x * (12.64194608 + x * (-60.58204836 + x * (110.36276771 + x * (-89.90310912 + x * 27.34824973))))];
    }
  };
  var cmapCache = {};
  function getCmap(name) {
    name = String(name || 'parula');
    if (!CMAPS[name]) name = name.toLowerCase();
    if (!CMAPS[name]) name = 'parula';
    if (!cmapCache[name]) {
      var tab = [], strs = [], u8 = new Uint8ClampedArray(256 * 3);
      for (var i = 0; i < 256; i++) {
        var c = CMAPS[name](i / 255).map(clamp01);
        tab.push(c); strs.push(rgb(c));
        u8[i * 3] = c[0] * 255; u8[i * 3 + 1] = c[1] * 255; u8[i * 3 + 2] = c[2] * 255;
      }
      cmapCache[name] = { name: name, tab: tab, str: strs, u8: u8 };
    }
    return cmapCache[name];
  }
  function cmapIndex(v, lo, hi) {
    if (!fin(v)) return -1;
    var t = hi > lo ? (v - lo) / (hi - lo) : 0.5;
    return Math.round(clamp01(t) * 255);
  }

  /* ------------------------------------------------------------------ TeX-lite text */
  var TEX = { alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', epsilon: 'ε', zeta: 'ζ', eta: 'η', theta: 'θ', iota: 'ι',
    kappa: 'κ', lambda: 'λ', mu: 'μ', nu: 'ν', xi: 'ξ', pi: 'π', rho: 'ρ', sigma: 'σ', tau: 'τ', upsilon: 'υ', phi: 'φ',
    chi: 'χ', psi: 'ψ', omega: 'ω', Gamma: 'Γ', Delta: 'Δ', Theta: 'Θ', Lambda: 'Λ', Xi: 'Ξ', Pi: 'Π', Sigma: 'Σ',
    Phi: 'Φ', Psi: 'Ψ', Omega: 'Ω', infty: '∞', pm: '±', times: '×', cdot: '·', leq: '≤', geq: '≥', neq: '≠',
    approx: '≈', circ: '°', deg: '°', partial: '∂', nabla: '∇', int: '∫', sum: '∑', sqrt: '√', rightarrow: '→',
    leftarrow: '←', to: '→', in: '∈', ldots: '…', bullet: '•', prime: '′' };
  var TEX_IGNORE = { bf: 1, it: 1, rm: 1, sl: 1, fontsize: 1 };
  var texCache = {};
  function texSym(s) {
    return s.replace(/\\([a-zA-Z]+) ?/g, function (m, n) { return TEX[n] != null ? TEX[n] : TEX_IGNORE[n] ? '' : m; })
      .replace(/\\([{}_^\\])/g, '$1').replace(/[{}]/g, '');
  }
  function texRuns(s) {
    s = String(s);
    if (texCache[s]) return texCache[s];
    var runs = [];
    if (!/[\\^_{]/.test(s)) runs.push({ t: s, lv: 0 });
    else {
      var cur = '', i = 0, m;
      while (i < s.length) {
        var ch = s[i];
        if (ch === '\\') {
          m = /^\\([a-zA-Z]+ ?|.)/.exec(s.slice(i));
          if (!m) { cur += ch; i++; continue; }
          var nm = m[1].trim();
          if (/^[a-zA-Z]+$/.test(nm)) cur += TEX[nm] != null ? TEX[nm] : TEX_IGNORE[nm] ? '' : '\\' + nm;
          else cur += m[1];
          i += m[0].length; continue;
        }
        if ((ch === '^' || ch === '_') && i + 1 < s.length) {
          if (cur) runs.push({ t: cur, lv: 0 }); cur = '';
          var lv = ch === '^' ? 1 : -1, g; i++;
          if (s[i] === '{') {
            var d = 1, j = i + 1;
            while (j < s.length) { if (s[j] === '{') d++; else if (s[j] === '}') { d--; if (!d) break; } j++; }
            g = s.slice(i + 1, j); i = j + 1;
          } else if (s[i] === '\\') { m = /^\\([a-zA-Z]+|.)/.exec(s.slice(i)); g = m[0]; i += m[0].length; }
          else { g = s[i]; i++; }
          runs.push({ t: texSym(g), lv: lv }); continue;
        }
        if (ch === '{' || ch === '}') { i++; continue; }
        cur += ch; i++;
      }
      if (cur) runs.push({ t: cur, lv: 0 });
    }
    texCache[s] = runs;
    return runs;
  }
  function font(size, bold) { return (bold ? 'bold ' : '') + (+size).toFixed(1) + 'px ' + FONT_STACK; }
  function texWidth(ctx, s, size, bold) {
    var runs = texRuns(s), w = 0;
    for (var i = 0; i < runs.length; i++) { ctx.font = font(runs[i].lv ? size * 0.72 : size, bold); w += ctx.measureText(runs[i].t).width; }
    return w;
  }
  // opt: align left|center|right, base top|middle|bottom|alphabetic, bold, rot (radians)
  function drawTex(ctx, s, x, y, size, color, opt) {
    opt = opt || {};
    var runs = texRuns(s), w = texWidth(ctx, s, size, opt.bold);
    ctx.save();
    ctx.translate(x, y);
    if (opt.rot) ctx.rotate(opt.rot);
    ctx.fillStyle = color;
    ctx.textBaseline = opt.base || 'middle';
    ctx.textAlign = 'left';
    var x0 = opt.align === 'center' ? -w / 2 : opt.align === 'right' ? -w : 0;
    for (var i = 0; i < runs.length; i++) {
      var r = runs[i], sz = r.lv ? size * 0.72 : size;
      ctx.font = font(sz, opt.bold);
      ctx.fillText(r.t, x0, r.lv > 0 ? -size * 0.36 : r.lv < 0 ? size * 0.2 : 0);
      x0 += ctx.measureText(r.t).width;
    }
    ctx.restore();
    return w;
  }

  /* ------------------------------------------------------------------ ticks */
  function niceStep(lo, hi, n) {
    var raw = (hi - lo) / Math.max(1, n);
    if (!(raw > 0) || !isFinite(raw)) return 1;
    var mag = Math.pow(10, Math.floor(Math.log10(raw))), f = raw / mag;
    return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * mag;
  }
  function ticksLin(lo, hi, n) {
    var st = niceStep(lo, hi, n), a = Math.ceil(lo / st - 1e-9), b = Math.floor(hi / st + 1e-9), t = [];
    if (b - a > 200) b = a + 200;
    for (var k = a; k <= b; k++) t.push(+(k * st).toPrecision(12));
    return { t: t, step: st };
  }
  function fmtLin(t, step) {
    var mx = 0;
    for (var i = 0; i < t.length; i++) mx = Math.max(mx, Math.abs(t[i]));
    var e = 0;
    if (mx >= 1e4 || (mx > 0 && mx < 1e-3)) e = Math.floor(Math.log10(mx) + 1e-9);
    var sc = Math.pow(10, e), dec = clamp(Math.ceil(-Math.log10(step / sc) - 1e-9), 0, 10);
    return {
      labels: t.map(function (v) { var s = (v / sc).toFixed(dec); return /^-0(\.0+)?$/.test(s) ? s.slice(1) : s; }),
      exp: e
    };
  }
  function makeTicks(lo, hi, log, n) {
    if (log && lo > 0) {
      var a = Math.ceil(Math.log10(lo) - 1e-9), b = Math.floor(Math.log10(hi) + 1e-9);
      if (b - a >= 1) {
        var k = Math.max(1, Math.ceil((b - a + 1) / Math.max(2, n))), t = [], lab = [], minor = [];
        for (var e = a; e <= b; e += k) { t.push(Math.pow(10, e)); lab.push('10^{' + e + '}'); }
        if (k === 1 && b - a <= 12) {
          for (e = a - 1; e <= b; e++) for (var m = 2; m <= 9; m++) {
            var v = m * Math.pow(10, e); if (v >= lo * (1 - 1e-9) && v <= hi * (1 + 1e-9)) minor.push(v);
          }
        }
        return { t: t, labels: lab, minor: minor, exp: 0 };
      }
    }
    var r = ticksLin(lo, hi, n), f = fmtLin(r.t, r.step);
    if (log) { r.t = r.t.filter(function (v, i) { if (v <= 0) f.labels[i] = null; return v > 0; }); f.labels = f.labels.filter(function (l) { return l != null; }); }
    return { t: r.t, labels: f.labels, minor: [], exp: f.exp, step: r.step };
  }
  function autoLim(lo, hi, log, mode, n) {
    if (!(lo <= hi)) return log ? [1, 10] : [0, 1];
    if (log) {
      if (lo <= 0) lo = hi / 1000;
      if (lo === hi) { lo /= 10; hi *= 10; }
      if (mode === 'tight') return [lo, hi];
      return [Math.pow(10, Math.floor(Math.log10(lo) + 1e-9)), Math.pow(10, Math.ceil(Math.log10(hi) - 1e-9))];
    }
    if (lo === hi) { var d = lo === 0 ? 1 : Math.pow(10, Math.floor(Math.log10(Math.abs(lo)))); lo -= d; hi += d; }
    if (mode === 'tight') return [lo, hi];
    var st = niceStep(lo, hi, n);
    return [+(Math.floor(lo / st + 1e-9) * st).toPrecision(12), +(Math.ceil(hi / st - 1e-9) * st).toPrecision(12)];
  }

  /* ------------------------------------------------------------------ primitives */
  function lwPx(lw) { lw = lw == null ? 0.5 : +lw; return Math.max(0.6, 1.2 + (lw - 0.5) * 1.33); }
  function msPx(ms) { return (ms == null ? 6 : +ms) * 1.33; }
  function setLine(ctx, ls, lw) {
    ctx.lineWidth = lw;
    var k = Math.max(1, lw * 0.85);
    ctx.setLineDash(ls === '--' ? [6 * k, 4 * k] : ls === ':' ? [1.3 * k, 2.6 * k] : ls === '-.' ? [6 * k, 3 * k, 1.3 * k, 3 * k] : []);
    ctx.lineCap = ls === ':' ? 'round' : 'butt';
    ctx.lineJoin = 'round';
  }
  function polyline(ctx, xs, ys, X, Y) {
    var pen = false;
    for (var i = 0; i < xs.length; i++) {
      var px = X(xs[i]), py = Y(ys[i]);
      if (!fin(px) || !fin(py)) { pen = false; continue; }
      if (pen) ctx.lineTo(px, py); else { ctx.moveTo(px, py); pen = true; }
    }
  }
  var FILLABLE = { o: 1, s: 1, d: 1, '^': 1, v: 1, '>': 1, '<': 1, p: 1, h: 1 };
  function markerPath(ctx, m, x, y, d) {
    var r = d / 2, i, a;
    switch (m) {
      case 'o': ctx.moveTo(x + r, y); ctx.arc(x, y, r, 0, 6.2832); break;
      case 's': r *= 0.88; ctx.rect(x - r, y - r, 2 * r, 2 * r); break;
      case 'd': ctx.moveTo(x, y - r * 1.15); ctx.lineTo(x + r * 0.85, y); ctx.lineTo(x, y + r * 1.15); ctx.lineTo(x - r * 0.85, y); ctx.closePath(); break;
      case '^': ctx.moveTo(x, y - r * 1.1); ctx.lineTo(x + r, y + r * 0.7); ctx.lineTo(x - r, y + r * 0.7); ctx.closePath(); break;
      case 'v': ctx.moveTo(x, y + r * 1.1); ctx.lineTo(x + r, y - r * 0.7); ctx.lineTo(x - r, y - r * 0.7); ctx.closePath(); break;
      case '>': ctx.moveTo(x + r * 1.1, y); ctx.lineTo(x - r * 0.7, y + r); ctx.lineTo(x - r * 0.7, y - r); ctx.closePath(); break;
      case '<': ctx.moveTo(x - r * 1.1, y); ctx.lineTo(x + r * 0.7, y + r); ctx.lineTo(x + r * 0.7, y - r); ctx.closePath(); break;
      case '+': ctx.moveTo(x - r, y); ctx.lineTo(x + r, y); ctx.moveTo(x, y - r); ctx.lineTo(x, y + r); break;
      case 'x': r *= 0.75; ctx.moveTo(x - r, y - r); ctx.lineTo(x + r, y + r); ctx.moveTo(x - r, y + r); ctx.lineTo(x + r, y - r); break;
      case '*': ctx.moveTo(x - r, y); ctx.lineTo(x + r, y); ctx.moveTo(x, y - r); ctx.lineTo(x, y + r);
        r *= 0.7; ctx.moveTo(x - r, y - r); ctx.lineTo(x + r, y + r); ctx.moveTo(x - r, y + r); ctx.lineTo(x + r, y - r); break;
      case 'p': case 'h':
        var k = m === 'p' ? 5 : 6;
        for (i = 0; i < 2 * k; i++) { a = -Math.PI / 2 + i * Math.PI / k; var rr = i % 2 ? r * 0.45 : r * 1.1; if (i) ctx.lineTo(x + rr * Math.cos(a), y + rr * Math.sin(a)); else ctx.moveTo(x + rr * Math.cos(a), y + rr * Math.sin(a)); }
        ctx.closePath(); break;
      default: ctx.moveTo(x + r, y); ctx.arc(x, y, r, 0, 6.2832);
    }
  }
  function drawMarker(ctx, m, x, y, d, edge, face) {
    if (!m || m === 'none') return;
    if (m === '.') { ctx.beginPath(); ctx.arc(x, y, Math.max(1.2, d / 5), 0, 6.2832); ctx.fillStyle = edge || face; ctx.fill(); return; }
    ctx.beginPath(); markerPath(ctx, m, x, y, d);
    if (face && FILLABLE[m]) { ctx.fillStyle = face; ctx.fill(); }
    if (edge) { ctx.strokeStyle = edge; ctx.stroke(); }
  }

  /* ------------------------------------------------------------------ spec normalisation & geometry */
  function grid(s) {
    var Z = mat(s.z != null ? s.z : s.c);
    if (!Z) return null;
    var nr = Z.length, nc = Z[0].length, X, Y, r, c;
    if (isMat(s.x) && s.x.length === nr) X = mat(s.x);
    else { var xv = s.x != null ? vec(s.x) : seq(nc); if (xv.length !== nc) xv = seq(nc); X = []; for (r = 0; r < nr; r++) X.push(xv); }
    if (isMat(s.y) && s.y.length === nr) Y = mat(s.y);
    else { var yv = s.y != null ? vec(s.y) : seq(nr); if (yv.length !== nr) yv = seq(nr); Y = []; for (r = 0; r < nr; r++) { var row = new Array(nc); for (c = 0; c < nc; c++) row[c] = yv[r]; Y.push(row); } }
    var C = s.c != null && s.z != null && isMat(s.c) && s.c.length === nr ? mat(s.c) : Z;
    return { X: X, Y: Y, Z: Z, C: C, nr: nr, nc: nc };
  }
  function lineSet(s) {
    var y = s.y, x = s.x, out = [];
    if (isMat(y)) {
      var Y = mat(y), m = Y.length, n = Y[0].length, xv = x != null && !isMat(x) ? vec(x) : null, i, j;
      if (isMat(x)) { var Xm = mat(x); for (i = 0; i < m; i++) out.push({ x: Xm[i] || seq(n), y: Y[i] }); return out; }
      if (m === 1 || (xv && xv.length === n && xv.length !== m)) { for (i = 0; i < m; i++) out.push({ x: xv || seq(n), y: Y[i] }); return out; }
      for (j = 0; j < n; j++) { var col = []; for (i = 0; i < m; i++) col.push(Y[i][j]); out.push({ x: xv && xv.length === m ? xv : seq(m), y: col }); }
      return out;
    }
    var yv = vec(y) || [], xv2 = x != null ? vec(x) : seq(yv.length);
    if (y == null && x != null) { yv = xv2; xv2 = seq(yv.length); }
    out.push({ x: xv2, y: yv });
    return out;
  }
  function nextColor(A) { var c = ORDER[A._ci % ORDER.length]; A._ci++; return c; }

  function prepSeries(A, s) {
    var t = s.type, ex = s.extra || (s.extra = {}), g = {}, i, j, k;
    var col = colorArg(s.color);
    if (typeof col === 'string') col = null;
    s.lineStyle = s.lineStyle || (t === 'scatter' || t === 'scatter3' ? 'none' : '-');
    s.marker = s.marker || (t === 'scatter' || t === 'scatter3' ? 'o' : t === 'stem' ? 'o' : 'none');
    if ((t === 'scatter' || t === 'scatter3') && (s.marker === 'none' || s.marker === '')) s.marker = 'o'; // scatter always has markers
    if (ex.faceColor && !s.color) col = colorArg(ex.faceColor);
    switch (t) {
      case 'line': case 'stairs': case 'scatter': case 'stem': case 'errorbar': case 'quiver':
        g.lines = t === 'quiver' ? [] : lineSet(s);
        for (i = 0; i < g.lines.length; i++) g.lines[i].color = col || nextColor(A);
        if (t === 'stairs') g.lines.forEach(function (L) {
          var xs = [], ys = [];
          for (var q = 0; q < L.x.length; q++) {
            xs.push(L.x[q]); ys.push(L.y[q]);
            if (q + 1 < L.x.length) { xs.push(L.x[q + 1]); ys.push(L.y[q]); }
          }
          L.sx = xs; L.sy = ys;
        });
        if (t === 'errorbar') {
          var n = g.lines[0].y.length;
          var expand = function (e) { if (e == null) return null; var v = vec(e); if (v.length === 1 && n > 1) { var o = []; for (var q = 0; q < n; q++) o.push(v[0]); return o; } return v; };
          var pick = function () { for (var q = 0; q < arguments.length; q++) if (arguments[q] != null) return arguments[q]; return null; };
          g.neg = expand(pick(ex.yNeg, ex.neg, ex.err, s.u)); g.pos = expand(pick(ex.yPos, ex.pos, ex.err, s.v, ex.yNeg));
          g.xneg = expand(pick(ex.xNeg, ex.xneg)); g.xpos = expand(pick(ex.xPos, ex.xpos, ex.xNeg));
        }
        if (t === 'scatter') {
          var L0 = g.lines[0], npt = L0.x.length;
          // extra.sizes: per-point marker diameter in points (= sqrt of MATLAB's area S, as mlinterp emits);
          // extra.sizeIsArea: true means the values are MATLAB areas (points^2).
          var ms = s.markerSize, sizes = ex.sizes != null ? vec(ex.sizes) : null;
          g.d = []; for (i = 0; i < npt; i++) {
            var dia;
            if (sizes) { var sv = sizes.length === 1 ? sizes[0] : sizes[i]; dia = ex.sizeIsArea ? Math.sqrt(Math.max(0, sv)) : sv; }
            else dia = ms == null ? 6 : (ms > 20 || ex.sizeIsArea ? Math.sqrt(ms) : ms);
            g.d.push(Math.max(1.5, (fin(dia) ? dia : 6) * 1.33));
          }
          // a numeric per-point vector given as `color` is really CData
          if (s.c == null && isArr(s.color) && !isMat(s.color) && s.color.length === npt && (npt !== 3 || vec(s.color).some(function (v) { return v > 1 || v < 0; }))) { s.c = s.color; L0.color = nextColor(A); }
          if (s.c != null) {
            if (isMat(s.c) && s.c[0].length === 3 && s.c.length === npt) g.rgbs = mat(s.c);
            else if (isArr(s.c) && s.c.length === npt && !isMat(s.c)) g.cv = vec(s.c);
            else if (isArr(s.c) && s.c.length === 3 && !isMat(s.c)) L0.color = vec(s.c);
          }
        }
        if (t === 'quiver') {
          var qx = vec(s.x), qy = vec(s.y), qu = vec(s.u), qv = vec(s.v), nq = Math.min(qx.length, qy.length, qu.length, qv.length);
          var mmx = minmax(qx, Infinity, -Infinity), mmy = minmax(qy, Infinity, -Infinity);
          var side = Math.max(1, Math.sqrt(nq)), dx = (mmx[1] - mmx[0]) / Math.max(1, side - 1) || 1, dy = (mmy[1] - mmy[0]) / Math.max(1, side - 1) || 1;
          var maxl = 0;
          for (i = 0; i < nq; i++) { var l = Math.sqrt(Math.pow(qu[i] / dx, 2) + Math.pow(qv[i] / dy, 2)); if (fin(l) && l > maxl) maxl = l; }
          var sf = ex.scale === 0 || ex.autoScale === false ? 1 : (maxl > 0 ? 0.9 * (ex.scale || 1) / maxl : 1);
          g.arrows = [];
          for (i = 0; i < nq; i++) g.arrows.push([qx[i], qy[i], qx[i] + qu[i] * sf, qy[i] + qv[i] * sf]);
          g.color = col || nextColor(A);
        }
        break;
      case 'bar': case 'barh': {
        var Yb = mat(s.y), m;
        if (Yb.length === 1) { Yb = Yb[0].map(function (v) { return [v]; }); }
        m = Yb.length; var ng = Yb[0].length;
        var xb = s.x != null ? vec(s.x) : seq(m);
        if (xb.length !== m) xb = seq(m);
        var sorted = xb.filter(fin).slice().sort(function (a, b) { return a - b; }), sp = Infinity;
        for (i = 1; i < sorted.length; i++) if (sorted[i] - sorted[i - 1] > 0) sp = Math.min(sp, sorted[i] - sorted[i - 1]);
        if (!isFinite(sp)) sp = 1;
        var bw = ex.barWidth || ex.width || 0.8, base = ex.baseValue || 0, stacked = !!ex.stacked && ng > 1;
        g.colors = []; for (k = 0; k < ng; k++) g.colors.push(ex.colors && ex.colors[k] ? ex.colors[k] : (ng === 1 && col) ? col : nextColor(A));
        g.rects = []; g.sp = sp; g.base = base;
        var gc = +ex.groupCount || 1, gi = +ex.groupIndex || 0;
        if (ng === 1 && gc > 1 && !ex.stacked) { // one column of a grouped bar, emitted as its own series
          var gwg = Math.min(0.8, gc / (gc + 1.5)) * sp, wg = gwg / gc * Math.min(1, bw / 0.8);
          for (i = 0; i < m; i++) {
            var vg = Yb[i][0]; if (!fin(vg)) continue;
            var cg = xb[i] - gwg / 2 + (gi + 0.5) * gwg / gc;
            g.rects.push({ a0: cg - wg / 2, a1: cg + wg / 2, b0: base, b1: vg, k: 0, x: xb[i], v: vg });
          }
        } else if (stacked || ng === 1) {
          for (i = 0; i < m; i++) {
            var pos = base, neg = base;
            for (k = 0; k < ng; k++) {
              var v = Yb[i][k]; if (!fin(v)) continue;
              var y0, y1;
              if (stacked) { if (v >= 0) { y0 = pos; y1 = pos + v; pos = y1; } else { y0 = neg; y1 = neg + v; neg = y1; } }
              else { y0 = base; y1 = v; }
              g.rects.push({ a0: xb[i] - sp * bw / 2, a1: xb[i] + sp * bw / 2, b0: y0, b1: y1, k: k, x: xb[i], v: v });
            }
          }
        } else {
          var gw = Math.min(0.8, ng / (ng + 1.5)) * sp, w1 = gw / ng * Math.min(1, bw / 0.8);
          for (i = 0; i < m; i++) for (k = 0; k < ng; k++) {
            var vv = Yb[i][k]; if (!fin(vv)) continue;
            var cx = xb[i] - gw / 2 + (k + 0.5) * gw / ng;
            g.rects.push({ a0: cx - w1 / 2, a1: cx + w1 / 2, b0: base, b1: vv, k: k, x: xb[i], v: vv });
          }
        }
        g.ng = ng; g.x = xb;
        if (s.labels && s.labels.length === m) g.cats = s.labels.map(String);
        break;
      }
      case 'histogram': {
        var edges = vec(ex.binEdges), cnt = vec(s.y != null ? s.y : ex.counts);
        if (!edges && s.x != null && vec(s.x).length === cnt.length + 1) edges = vec(s.x);
        if (!edges) { var xc = vec(s.x) || seq(cnt.length); edges = []; for (i = 0; i < xc.length; i++) edges.push(xc[i] - 0.5); edges.push(xc[xc.length - 1] + 0.5); }
        g.rects = [];
        for (i = 0; i < cnt.length && i + 1 < edges.length; i++) g.rects.push({ a0: edges[i], a1: edges[i + 1], b0: 0, b1: cnt[i], x: (edges[i] + edges[i + 1]) / 2, v: cnt[i] });
        g.color = col || nextColor(A);
        g.horiz = ex.orientation === 'horizontal';
        break;
      }
      case 'area': {
        var Ya = mat(s.y);
        if (Ya.length === 1) Ya = Ya[0].map(function (v) { return [v]; });
        var na = Ya.length, nl = Ya[0].length, xa = s.x != null ? vec(s.x) : seq(na), basev = ex.baseValue || 0;
        var acc = []; for (i = 0; i < na; i++) acc.push(basev);
        g.layers = [];
        for (k = 0; k < nl; k++) {
          var lo = acc.slice(), hi = [];
          for (i = 0; i < na; i++) { var av = Ya[i][k]; hi.push(acc[i] + (fin(av) ? av : 0)); }
          acc = hi.slice();
          g.layers.push({ x: xa, lo: lo, hi: hi, color: (nl === 1 && col) ? col : nextColor(A) });
        }
        break;
      }
      case 'fill': {
        g.x = vec(s.x); g.y = vec(s.y);
        if (fin(N(s.c)) && !isArr(s.c)) g.cval = N(s.c);
        g.color = col || (g.cval != null ? null : nextColor(A));
        break;
      }
      case 'pie': {
        g.v = vec(s.x != null ? s.x : s.y).map(function (v) { return fin(v) && v > 0 ? v : 0; });
        if (s.x != null && s.y != null) { var fr = vec(s.y); if (fr.length === g.v.length) g.frac = fr.map(function (v) { return fin(v) && v > 0 ? v : 0; }); }
        break;
      }
      case 'contour': case 'contourf': case 'imagesc': case 'surf': case 'mesh': {
        g.grid = grid(s);
        if (!g.grid) break;
        var mm = [Infinity, -Infinity];
        g.grid.C.forEach(function (row) { mm = minmax(row, mm[0], mm[1]); });
        g.crange = mm;
        var zm = [Infinity, -Infinity]; g.grid.Z.forEach(function (row) { zm = minmax(row, zm[0], zm[1]); });
        g.zrange = zm;
        if (t === 'contour' || t === 'contourf') {
          var lv = s.levels;
          if (isArr(lv) && lv.length) { g.levels = vec(lv); if (g.levels.length === 2 && g.levels[0] === g.levels[1]) g.levels = [g.levels[0]]; }
          else {
            var nlv = fin(N(lv)) ? Math.max(1, N(lv)) : 9;
            g.levels = ticksLin(zm[0], zm[1], nlv).t.filter(function (v) { return v > zm[0] && v < zm[1]; });
            if (!g.levels.length) g.levels = [(zm[0] + zm[1]) / 2];
          }
          if (t === 'contour' && col) g.color = col;
        }
        break;
      }
      case 'plot3': case 'scatter3': {
        g.x = vec(s.x) || []; g.y = vec(s.y) || []; g.z = vec(s.z) || [];
        g.color = col || nextColor(A);
        if (t === 'scatter3') {
          var n3 = g.x.length;
          if (isArr(s.c) && s.c.length === n3 && !isMat(s.c)) g.cv = vec(s.c);
          else if (isMat(s.c) && s.c.length === n3) g.rgbs = mat(s.c);
          var ms3 = s.markerSize, sz3 = ex.sizes != null ? vec(ex.sizes) : null;
          g.d = (ms3 == null ? 6 : ms3 > 20 ? Math.sqrt(ms3) : ms3) * 1.33;
          if (sz3) g.ds = sz3.map(function (v) { return Math.max(1.5, (ex.sizeIsArea ? Math.sqrt(Math.max(0, v)) : v) * 1.33); });
        }
        break;
      }
      case 'text': {
        g.x = vec(s.x) || [0]; g.y = vec(s.y) || [0]; g.z = vec(s.z);
        var tx = s.text != null ? s.text : s.labels;
        g.text = isArr(tx) ? Array.prototype.map.call(tx, String) : [String(tx == null ? '' : tx)];
        break;
      }
    }
    s._g = g;
  }

  function legendItems(A) {
    var items = [];
    A.series.forEach(function (s) {
      var g = s._g || {}, t = s.type, name = s.displayName, ex = s.extra || {};
      var ls = s.lineStyle, mk = s.marker, lw = s.lineWidth;
      var push = function (o) { o.name = o.name != null ? o.name : name; items.push(o); };
      switch (t) {
        case 'line': case 'stairs': case 'errorbar':
          (g.lines || []).forEach(function (L, i) { push({ kind: 'line', color: L.color, ls: ls, marker: mk, lw: lw, ms: s.markerSize, name: i && ex.displayNames ? ex.displayNames[i] : (i ? null : name) }); });
          break;
        case 'stem': push({ kind: 'line', color: g.lines[0].color, ls: ls, marker: mk, lw: lw }); break;
        case 'scatter': push({ kind: 'marker', color: g.cv ? getCmap(A.colormap).tab[128] : g.lines[0].color, marker: mk, filled: !!ex.filled }); break;
        case 'scatter3': push({ kind: 'marker', color: g.cv ? getCmap(A.colormap).tab[128] : g.color, marker: mk, filled: !!ex.filled }); break;
        case 'plot3': push({ kind: 'line', color: g.color, ls: ls, marker: mk, lw: lw }); break;
        case 'quiver': push({ kind: 'line', color: g.color, ls: '-', marker: 'none', lw: lw }); break;
        case 'bar': case 'barh':
          for (var k = 0; k < g.ng; k++) push({ kind: 'patch', face: g.colors[k], edge: colorArg(s.edgeColor) || 'edge', name: ex.groupNames ? ex.groupNames[k] : (k ? null : name) });
          break;
        case 'histogram': push({ kind: 'patch', face: g.color, alpha: s.faceAlpha != null ? s.faceAlpha : 0.6, edge: 'edge' }); break;
        case 'area': g.layers.forEach(function (L, i) { push({ kind: 'patch', face: L.color, alpha: s.faceAlpha, edge: 'edge', name: ex.groupNames ? ex.groupNames[i] : (i ? null : name) }); }); break;
        case 'fill': push({ kind: 'patch', face: g.color || getCmap(A.colormap).tab[128], alpha: s.faceAlpha, edge: 'edge' }); break;
        case 'pie': {
          var cm = getCmap(A.colormap), n = g.v.length;
          g.v.forEach(function (v, i) { push({ kind: 'patch', face: cm.tab[n > 1 ? Math.round(i / (n - 1) * 255) : 0], edge: 'edge', name: s.labels && s.labels[i] != null ? String(s.labels[i]) : null, pieSlice: true }); });
          break;
        }
        case 'contour': push({ kind: 'line', color: g.color || getCmap(A.colormap).tab[128], ls: ls, marker: 'none', lw: lw }); break;
        case 'contourf': case 'surf': case 'imagesc': push({ kind: 'patch', face: getCmap(A.colormap).tab[128], edge: 'edge' }); break;
        case 'mesh': push({ kind: 'line', color: getCmap(A.colormap).tab[128], ls: '-', marker: 'none' }); break;
      }
    });
    var labs = A.legend, out = [];
    if (labs == null) return [];
    labs = isArr(labs) ? Array.prototype.map.call(labs, String) : [String(labs)];
    for (var i = 0; i < items.length; i++) {
      var nm = i < labs.length ? labs[i] : (labs.length ? null : (items[i].name != null ? items[i].name : 'data' + (i + 1)));
      if (nm == null) continue;
      items[i].name = nm; out.push(items[i]);
    }
    return out;
  }

  function normalizeSpec(spec) {
    spec = JSON.parse(JSON.stringify(spec || {}));
    spec.axes = (spec.axes || []).map(function (A) {
      A.series = (A.series || []).filter(function (s) { return s && s.type; });
      var AX = A.extra || {};
      ['xticks', 'yticks', 'xticklabels', 'yticklabels'].forEach(function (k) { if (A[k] == null && AX[k] != null) A[k] = AX[k]; });
      if (A.ydir == null && (AX.yDir || AX.ydir)) A.ydir = String(AX.yDir || AX.ydir).toLowerCase();
      if (A.clim == null && isArr(A.caxis) && A.caxis.length >= 2) A.clim = A.caxis;
      if (AX.axisVisible === false && (A.axis == null || A.axis === 'auto')) A.axis = 'off';
      if (AX.colormapData && isMat(AX.colormapData)) {
        var key = 'custom:' + JSON.stringify(AX.colormapData).length + ':' + AX.colormapData.length + ':' + AX.colormapData[0].join(','), tab = mat(AX.colormapData);
        if (!CMAPS[key]) CMAPS[key] = function (t) { var i = Math.min(tab.length - 1, Math.floor(clamp01(t) * tab.length)); return tab[i].slice(0, 3); };
        A.colormap = key;
      }
      A.colormap = A.colormap || 'parula';
      A._ci = 0;
      A._3d = !!A.is3d || A.series.some(function (s) { return TYPES3D[s.type]; });
      if (A.box == null) A.box = !A._3d;
      A.legendLocation = String(A.legendLocation || 'northeast').toLowerCase();
      A.series.forEach(function (s) { try { prepSeries(A, s); } catch (e) { s._g = null; s._err = e; } });
      A.series = A.series.filter(function (s) { return s._g; });
      var stackAcc = {};
      A.series.forEach(function (s) {
        var ex = s.extra || {};
        if ((s.type !== 'bar' && s.type !== 'barh') || !ex.stacked || !(+ex.groupCount > 1)) return;
        s._g.rects.forEach(function (r) {
          var k = String(r.x), a = stackAcc[k] || (stackAcc[k] = [s._g.base, s._g.base]);
          if (r.v >= 0) { r.b0 = a[0]; r.b1 = a[0] + r.v; a[0] = r.b1; } else { r.b0 = a[1]; r.b1 = a[1] + r.v; a[1] = r.b1; }
        });
      });
      // colour limits
      var cl = A.clim && fin(N(A.clim[0])) ? [N(A.clim[0]), N(A.clim[1])] : null;
      if (!cl) {
        var mm = [Infinity, -Infinity];
        A.series.forEach(function (s) {
          var g = s._g;
          if (s.extra && s.extra.clim) { mm = [N(s.extra.clim[0]), N(s.extra.clim[1])]; return; }
          if (g.crange && s.type !== 'contour' && s.type !== 'contourf') mm = [Math.min(mm[0], g.crange[0]), Math.max(mm[1], g.crange[1])];
          else if (g.zrange) mm = [Math.min(mm[0], g.zrange[0]), Math.max(mm[1], g.zrange[1])];
          else if (g.cv) mm = minmax(g.cv, mm[0], mm[1]);
          else if (g.cval != null) mm = [Math.min(mm[0], g.cval), Math.max(mm[1], g.cval)];
        });
        A.series.forEach(function (s) { if (s.type === 'pie' && !(mm[0] <= mm[1])) mm = [1, s._g.v.length || 1]; });
        cl = mm[0] <= mm[1] ? mm : [0, 1];
        if (cl[0] === cl[1]) cl = [cl[0] - 0.5, cl[1] + 0.5];
      }
      A._clim = cl;
      A._legend = legendItems(A);
      return A;
    });
    return spec;
  }

  /* ------------------------------------------------------------------ marching squares */
  function contourSegments(G, L) {
    var X = G.X, Y = G.Y, Z = G.Z, nr = G.nr, nc = G.nc, segs = [];
    function pt(r0, c0, r1, c1) {
      var z0 = Z[r0][c0], z1 = Z[r1][c1], t = (L - z0) / (z1 - z0);
      if (!isFinite(t)) t = 0.5;
      return [X[r0][c0] + (X[r1][c1] - X[r0][c0]) * t, Y[r0][c0] + (Y[r1][c1] - Y[r0][c0]) * t];
    }
    for (var r = 0; r < nr - 1; r++) {
      var Zr = Z[r], Zr1 = Z[r + 1];
      for (var c = 0; c < nc - 1; c++) {
        var a = Zr[c], b = Zr[c + 1], d = Zr1[c + 1], e = Zr1[c];
        if (!(fin(a) && fin(b) && fin(d) && fin(e))) continue;
        var code = (a >= L ? 1 : 0) | (b >= L ? 2 : 0) | (d >= L ? 4 : 0) | (e >= L ? 8 : 0);
        if (code === 0 || code === 15) continue;
        var E = function (k) { return k === 0 ? pt(r, c, r, c + 1) : k === 1 ? pt(r, c + 1, r + 1, c + 1) : k === 2 ? pt(r + 1, c, r + 1, c + 1) : pt(r, c, r + 1, c); };
        var pairs;
        switch (code) {
          case 1: case 14: pairs = [3, 0]; break; case 2: case 13: pairs = [0, 1]; break;
          case 3: case 12: pairs = [3, 1]; break; case 4: case 11: pairs = [1, 2]; break;
          case 6: case 9: pairs = [0, 2]; break; case 7: case 8: pairs = [3, 2]; break;
          case 5: pairs = (a + b + d + e) / 4 >= L ? [3, 2, 0, 1] : [3, 0, 1, 2]; break;
          case 10: pairs = (a + b + d + e) / 4 >= L ? [3, 0, 1, 2] : [0, 1, 2, 3]; break;
        }
        for (var q = 0; q < pairs.length; q += 2) { var p1 = E(pairs[q]), p2 = E(pairs[q + 1]); segs.push(p1[0], p1[1], p2[0], p2[1]); }
      }
    }
    return segs;
  }
  function rectilinear(G) {
    var xs = G.X[0].slice(), ys = G.Y.map(function (r) { return r[0]; });
    return { xs: xs, ys: ys };
  }
  function locate(arr, v) { // arr monotonic; returns fractional index or -1
    var n = arr.length; if (n < 2) return -1;
    var asc = arr[n - 1] >= arr[0];
    if (asc ? (v < arr[0] || v > arr[n - 1]) : (v > arr[0] || v < arr[n - 1])) return -1;
    var lo = 0, hi = n - 1;
    while (hi - lo > 1) { var mid = (lo + hi) >> 1; if (asc ? arr[mid] <= v : arr[mid] >= v) lo = mid; else hi = mid; }
    var d = arr[hi] - arr[lo];
    return lo + (d ? (v - arr[lo]) / d : 0);
  }

  /* ------------------------------------------------------------------ Figure */
  function Figure(container, spec, opts) {
    this.container = container;
    this.opts = opts || {};
    this.state = [];
    this.setSpec(spec);
    var cs = root.getComputedStyle ? root.getComputedStyle(container) : null;
    if (cs && cs.position === 'static') container.style.position = 'relative';
    var cv = this.canvas = document.createElement('canvas');
    cv.style.display = 'block'; cv.style.width = '100%'; cv.style.userSelect = 'none'; cv.style.webkitUserSelect = 'none';
    cv.setAttribute('role', 'img');
    cv.setAttribute('aria-label', spec && (spec.name || spec.sgtitle) ? String(spec.name || spec.sgtitle) : 'figure');
    container.appendChild(cv);
    this.ctx = cv.getContext('2d');
    var tip = this.tip = document.createElement('div');
    tip.style.cssText = 'position:absolute;pointer-events:none;display:none;z-index:5;padding:3px 7px;border-radius:3px;font:11px/1.35 ' +
      FONT_STACK.replace(/"/g, "'") + ';white-space:pre;box-shadow:0 1px 4px rgba(0,0,0,.25)';
    var dot = this.dot = document.createElement('div');
    dot.style.cssText = 'position:absolute;pointer-events:none;display:none;z-index:4;width:8px;height:8px;margin:-5px 0 0 -5px;border-radius:50%;border:1px solid';
    container.appendChild(dot); container.appendChild(tip);
    this._bind();
    this.draw();
    var self = this;
    if (root.ResizeObserver && !this.opts.width) {
      this._lastW = container.clientWidth;
      this.ro = new ResizeObserver(function () {
        var w = container.clientWidth;
        if (Math.abs(w - self._lastW) >= 1) { self._lastW = w; if (!self._rz) self._rz = requestAnimationFrame(function () { self._rz = 0; self.draw(); }); }
      });
      this.ro.observe(container);
    }
  }
  Figure.prototype.setSpec = function (spec) {
    this.rawSpec = spec;
    this.spec = normalizeSpec(spec);
    var nAx = this.spec.axes.length;
    while (this.state.length < nAx) this.state.push({});
    this.state.length = nAx;
  };
  Figure.prototype.theme = function () {
    var t = this.opts.theme;
    if (t === 'auto' || !t) t = root.matchMedia && root.matchMedia('(prefers-color-scheme: dark)').matches && this.opts.theme === 'auto' ? 'dark' : 'light';
    return THEMES[t] || THEMES.light;
  };

  Figure.prototype.draw = function () {
    var t0 = (root.performance || Date).now();
    var spec = this.spec, opts = this.opts, th = this.th = this.theme();
    var W = Math.max(120, Math.round(opts.width || this.container.clientWidth || 560));
    var rows = 1;
    spec.axes.forEach(function (A) { if (A.subplot) rows = Math.max(rows, +A.subplot[0] || 1); });
    var H = opts.height ? Math.round(opts.height) : Math.round(W * (opts.aspect || 0.75));
    if (!opts.height && rows > 1) H = Math.max(H, Math.min(rows * 190, Math.round(W * 1.4)));
    var dpr = Math.min(root.devicePixelRatio || 1, 3), cv = this.canvas;
    var bw = Math.round(W * dpr), bh = Math.round(H * dpr);
    if (cv.width !== bw || cv.height !== bh) { cv.width = bw; cv.height = bh; }
    cv.style.height = H + 'px';
    if (opts.width) cv.style.width = W + 'px';
    this.W = W; this.H = H; this.dpr = dpr;
    var ctx = this.ctx;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.setLineDash([]);
    ctx.fillStyle = th.fig; ctx.fillRect(0, 0, W, H);
    var top = 0;
    var sg = lines(spec.sgtitle);
    if (sg.length) {
      var sfs = clamp(W / 42, 11, 16);
      for (var i = 0; i < sg.length; i++) drawTex(ctx, sg[i], W / 2, sfs * 0.55 + i * sfs * 1.3, sfs * 1.05, th.text, { align: 'center', base: 'top', bold: true });
      top = sfs * (0.9 + 1.3 * sg.length);
    }
    var self = this;
    this.rts = [];
    var ncols = 1;
    spec.axes.forEach(function (A) { if (A.subplot) ncols = Math.max(ncols, +A.subplot[1] || 1); });
    spec.axes.forEach(function (A, idx) {
      var cell = self.cellRect(A.subplot, W, H, top);
      var rt = { idx: idx, cell: cell, picks: [], A: A };
      rt.fs = clamp(Math.min(cell.w, cell.h * 1.33) / 34, MIN_FS, 13); // floor keeps 2x2 subplot ticks legible down to ~170px cells
      self.rts.push(rt);
      ctx.save();
      ctx.beginPath(); ctx.rect(cell.x, cell.y, cell.w, cell.h); ctx.clip();
      try {
        var onlyPie = A.series.length && A.series.every(function (s) { return s.type === 'pie' || s.type === 'text'; }) && A.series.some(function (s) { return s.type === 'pie'; });
        if (A._3d) { rt.is3d = true; draw3D(self, A, rt); }
        else if (onlyPie) { rt.isPie = true; drawPie(self, A, rt); }
        else { rt.is2d = true; draw2D(self, A, rt); }
      } catch (e) {
        if (root.console) console.error('MLPlot axes ' + idx + ':', e);
        ctx.fillStyle = '#c00'; ctx.font = font(12); ctx.fillText('render error: ' + e.message, cell.x + 8, cell.y + 20);
      }
      ctx.restore();
    });
    this.lastDrawMs = (root.performance || Date).now() - t0;
  };
  Figure.prototype.cellRect = function (sp, W, H, top) {
    if (!sp || !isArr(sp) || sp.length < 3) return { x: 0, y: top, w: W, h: H - top };
    var m = +sp[0] || 1, n = +sp[1] || 1, ps = isArr(sp[2]) ? sp[2] : [sp[2]];
    if (sp.length > 3) ps = Array.prototype.slice.call(sp, 2);
    var cw = W / n, ch = (H - top) / m, x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    ps.forEach(function (p) {
      p = (+p || 1) - 1; var r = Math.floor(p / n), c = p % n;
      x0 = Math.min(x0, c * cw); y0 = Math.min(y0, top + r * ch); x1 = Math.max(x1, (c + 1) * cw); y1 = Math.max(y1, top + (r + 1) * ch);
    });
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  };

  /* ------------------------------------------------------------------ 2D */
  function bounds2D(A, logx, logy) {
    var B = { x0: Infinity, x1: -Infinity, y0: Infinity, y1: -Infinity, tightX: false, tightY: false, rev: false, cats: null, hcats: null, barX: null, barY: null };
    function px(v) { if (fin(v) && (!logx || v > 0)) { if (v < B.x0) B.x0 = v; if (v > B.x1) B.x1 = v; } }
    function py(v) { if (fin(v) && (!logy || v > 0)) { if (v < B.y0) B.y0 = v; if (v > B.y1) B.y1 = v; } }
    function each(a, f) { if (a) for (var i = 0; i < a.length; i++) f(a[i]); }
    A.series.forEach(function (s) {
      var g = s._g, t = s.type, ex = s.extra || {};
      switch (t) {
        case 'line': case 'scatter': case 'stairs':
          g.lines.forEach(function (L) { each(L.x, px); each(L.y, py); }); break;
        case 'stem':
          g.lines.forEach(function (L) { each(L.x, px); each(L.y, py); }); py(ex.baseValue || 0); break;
        case 'errorbar':
          g.lines.forEach(function (L) {
            for (var i = 0; i < L.x.length; i++) {
              px(L.x[i]); py(L.y[i]);
              if (g.neg) py(L.y[i] - g.neg[i]); if (g.pos) py(L.y[i] + g.pos[i]);
              if (g.xneg) px(L.x[i] - g.xneg[i]); if (g.xpos) px(L.x[i] + g.xpos[i]);
            }
          });
          break;
        case 'area': g.layers.forEach(function (L) { each(L.x, px); each(L.lo, py); each(L.hi, py); }); break;
        case 'fill': each(g.x, px); each(g.y, py); break;
        case 'quiver': g.arrows.forEach(function (a) { px(a[0]); px(a[2]); py(a[1]); py(a[3]); }); break;
        case 'text': each(g.x, px); each(g.y, py); break;
        case 'bar': case 'histogram': case 'barh': {
          var horiz = t === 'barh' || g.horiz;
          g.rects.forEach(function (r) { if (horiz) { py(r.a0); py(r.a1); px(r.b0); px(r.b1); } else { px(r.a0); px(r.a1); py(r.b0); py(r.b1); } });
          if (t !== 'histogram') {
            var key = horiz ? 'barY' : 'barX', ext = minmax(g.rects.map(function (r) { return r.a0; }).concat(g.rects.map(function (r) { return r.a1; })), Infinity, -Infinity);
            var pad = g.sp * 0.2, cur = B[key];
            B[key] = cur ? [Math.min(cur[0], ext[0] - pad), Math.max(cur[1], ext[1] + pad)] : [ext[0] - pad, ext[1] + pad];
            var cats = g.cats ? { pos: g.x, labels: g.cats } : null;
            if (!cats && g.x.length <= 15 && g.x.every(function (v) { return fin(v) && Math.abs(v - Math.round(v)) < 1e-9; }))
              cats = { pos: g.x, labels: g.x.map(function (v) { return String(Math.round(v)); }), auto: true };
            if (cats) { var ck = horiz ? 'hcats' : 'cats'; if (!B[ck] || (B[ck].auto && !cats.auto)) B[ck] = cats; }
          }
          break;
        }
        case 'contour': case 'contourf': case 'imagesc': {
          var G = g.grid; if (!G) break;
          if (t === 'imagesc') {
            var xe = s.x != null ? vec(s.x) : [1, G.nc], ye = s.y != null ? vec(s.y) : [1, G.nr];
            var xa = xe[0], xb = xe[xe.length - 1], ya = ye[0], yb = ye[ye.length - 1];
            var dx = G.nc > 1 ? (xb - xa) / (G.nc - 1) : 1, dy = G.nr > 1 ? (yb - ya) / (G.nr - 1) : 1;
            g.ext = [xa - dx / 2, xb + dx / 2, ya - dy / 2, yb + dy / 2];
            px(g.ext[0]); px(g.ext[1]); py(g.ext[2]); py(g.ext[3]);
            if (String(ex.yDir || ex.ydir || 'reverse').toLowerCase() !== 'normal') B.rev = true;
          } else { G.X.forEach(function (r) { each(r, px); }); G.Y.forEach(function (r) { each(r, py); }); }
          B.tightX = B.tightY = true;
          break;
        }
      }
    });
    if (A.ydir === 'reverse') B.rev = true; else if (A.ydir === 'normal') B.rev = false;
    return B;
  }

  function measureTicks(ctx, tk, fs) {
    var mw = 0;
    for (var i = 0; i < tk.labels.length; i++) mw = Math.max(mw, texWidth(ctx, tk.labels[i], fs));
    return mw;
  }
  function catTicks(c, lo, hi) {
    var t = [], l = [];
    for (var i = 0; i < c.pos.length; i++) if (c.pos[i] >= lo && c.pos[i] <= hi) { t.push(c.pos[i]); l.push(c.labels[i]); }
    return { t: t, labels: l, minor: [], exp: 0 };
  }
  function userTicks(vals, labs, lo, hi) {
    var t = [], l = [], v = vec(vals);
    var f = labs ? null : fmtLin(v, v.length > 1 ? Math.abs(v[1] - v[0]) : 1);
    for (var i = 0; i < v.length; i++) if (v[i] >= lo - 1e-12 && v[i] <= hi + 1e-12) { t.push(v[i]); l.push(labs ? String(labs[i] == null ? '' : labs[i]) : f.labels[i]); }
    return { t: t, labels: l, minor: [], exp: labs ? 0 : f.exp };
  }

  function colorbarLayout(F, A, rt, hpx) {
    var ctx = F.ctx, fs = rt.fs;
    var tk = makeTicks(A._clim[0], A._clim[1], false, Math.max(2, Math.floor(hpx / (fs * 2.6))));
    var mw = measureTicks(ctx, tk, fs);
    return { tk: tk, w: fs * 0.9 + fs * 1.1 + fs * 0.45 + mw + fs * 0.3, barW: fs * 1.1, gap: fs * 0.9 };
  }
  function drawColorbar(F, A, rt, x, y, h, cbl) {
    var ctx = F.ctx, th = F.th, fs = rt.fs, cm = getCmap(A.colormap), lo = A._clim[0], hi = A._clim[1];
    var bx = x + cbl.gap, bw = cbl.barW;
    if (!F._cbCanvas) { F._cbCanvas = document.createElement('canvas'); F._cbCanvas.width = 1; F._cbCanvas.height = 256; }
    var cc = F._cbCanvas, c2 = cc.getContext('2d'), img = c2.createImageData(1, 256);
    for (var i = 0; i < 256; i++) { var k = 255 - i; img.data[i * 4] = cm.u8[k * 3]; img.data[i * 4 + 1] = cm.u8[k * 3 + 1]; img.data[i * 4 + 2] = cm.u8[k * 3 + 2]; img.data[i * 4 + 3] = 255; }
    c2.putImageData(img, 0, 0);
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(cc, bx, y, bw, h);
    ctx.setLineDash([]); ctx.lineWidth = 1; ctx.strokeStyle = th.axis;
    ctx.strokeRect(bx + 0.5, y + 0.5, bw - 1, h - 1);
    var tk = cbl.tk;
    for (i = 0; i < tk.t.length; i++) {
      var yy = y + h - (tk.t[i] - lo) / (hi - lo) * h;
      ctx.beginPath(); ctx.moveTo(bx, yy); ctx.lineTo(bx + bw * 0.25, yy); ctx.moveTo(bx + bw, yy); ctx.lineTo(bx + bw * 0.75, yy); ctx.stroke();
      drawTex(ctx, tk.labels[i], bx + bw + fs * 0.45, yy, fs, th.text, { align: 'left', base: 'middle' });
    }
    if (tk.exp) drawTex(ctx, '\\times10^{' + tk.exp + '}', bx, y - fs * 0.5, fs, th.text, { align: 'left', base: 'bottom' });
  }

  function legendSize(F, rt, items) {
    var ctx = F.ctx, fs = rt.fs * 0.92, tw = 0;
    items.forEach(function (it) { tw = Math.max(tw, texWidth(ctx, it.name, fs)); });
    var rowH = fs * 1.45, sw = fs * 2.3, pad = fs * 0.5;
    return { w: pad * 2 + sw + fs * 0.5 + tw, h: pad * 1.1 + rowH * items.length, rowH: rowH, sw: sw, pad: pad, fs: fs };
  }
  function drawLegend(F, A, rt, items, rect) {
    if (!items.length) return;
    var ctx = F.ctx, th = F.th, L = legendSize(F, rt, items), m = rt.fs * 0.6, loc = A.legendLocation, x, y;
    if (L.h > rect.h - 2 * m && loc !== 'eastoutside') { // shrink if too tall
      rt = { fs: Math.max(8, rt.fs * (rect.h - 2 * m) / L.h) }; L = legendSize(F, rt, items);
    }
    var pos = function (lc) {
      if (lc === 'eastoutside') return [rect.x + rect.w + m * 0.8, rect.y];
      var east = lc.indexOf('east') >= 0 || lc === 'north' || lc === 'south', west = lc.indexOf('west') >= 0, south = lc.indexOf('south') === 0;
      var xx = west ? rect.x + m : (lc === 'north' || lc === 'south') ? rect.x + (rect.w - L.w) / 2 : rect.x + rect.w - L.w - m;
      var yy = south ? rect.y + rect.h - L.h - m : rect.y + m;
      if (!east && !west && lc !== 'north' && lc !== 'south') xx = rect.x + rect.w - L.w - m;
      return [xx, yy];
    };
    if (loc === 'best') {
      var best = null, bestN = Infinity;
      ['northeast', 'northwest', 'southeast', 'southwest'].forEach(function (lc) {
        var p = pos(lc), n = 0;
        rt.picks && rt.picks.forEach(function (q) { if (q.px >= p[0] && q.px <= p[0] + L.w && q.py >= p[1] && q.py <= p[1] + L.h) n++; });
        if (n < bestN) { bestN = n; best = p; }
      });
      x = best[0]; y = best[1];
    } else { var p0 = pos(loc); x = p0[0]; y = p0[1]; }
    x = Math.round(x) + 0.5; y = Math.round(y) + 0.5;
    ctx.setLineDash([]);
    ctx.fillStyle = th.legBg; ctx.fillRect(x, y, L.w, L.h);
    ctx.lineWidth = 0.8; ctx.strokeStyle = th.legEdge; ctx.strokeRect(x, y, L.w, L.h);
    items.forEach(function (it, i) {
      var cy = y + L.pad * 0.55 + L.rowH * (i + 0.5), sx = x + L.pad, sw = L.sw;
      if (it.kind === 'line') {
        if (it.ls !== 'none') { setLine(ctx, it.ls, lwPx(it.lw)); ctx.strokeStyle = rgb(it.color); ctx.beginPath(); ctx.moveTo(sx, cy); ctx.lineTo(sx + sw, cy); ctx.stroke(); }
        if (it.marker && it.marker !== 'none') { setLine(ctx, '-', 1); drawMarker(ctx, it.marker, sx + sw / 2, cy, Math.min(msPx(it.ms), L.rowH * 0.8), rgb(it.color), null); }
      } else if (it.kind === 'marker') {
        setLine(ctx, '-', 1); drawMarker(ctx, it.marker, sx + sw / 2, cy, Math.min(L.fs * 0.85, 9), rgb(it.color), it.filled ? rgb(it.color) : null);
      } else {
        var ph = L.fs * 0.85, pw = sw * 0.75;
        ctx.fillStyle = rgb(it.face, it.alpha == null ? 1 : it.alpha); ctx.fillRect(sx + (sw - pw) / 2, cy - ph / 2, pw, ph);
        ctx.setLineDash([]); ctx.lineWidth = 0.7; ctx.strokeStyle = it.edge === 'edge' ? th.edge : rgb(it.edge); ctx.strokeRect(sx + (sw - pw) / 2, cy - ph / 2, pw, ph);
      }
      drawTex(ctx, it.name, sx + sw + L.fs * 0.5, cy, L.fs, th.text, { align: 'left', base: 'middle' });
    });
  }

  function draw2D(F, A, rt) {
    var ctx = F.ctx, th = F.th, fs = rt.fs, cell = rt.cell, st = F.state[rt.idx];
    var logx = A.xscale === 'log', logy = A.yscale === 'log';
    var B = bounds2D(A, logx, logy);
    var axisOff = A.axis === 'off', tight = A.axis === 'tight' || A.axis === 'image';
    var items = A._legend, outLeg = items.length && A.legendLocation === 'eastoutside';
    var tl = lines(A.title);
    var mt = tl.length ? fs * (0.75 + 1.32 * tl.length) : fs * 0.8;
    var mb = axisOff ? fs * 0.6 : fs * 1.85 + (A.xlabel ? fs * 1.45 : 0);
    var mlFixed = axisOff ? fs * 0.6 : fs * 0.95 + (A.ylabel ? fs * 1.45 : 0);
    var mr = fs * 1.3;
    if (outLeg) mr += legendSize(F, rt, items).w + fs * 0.6;
    var cbl = null;
    if (A.colorbar) { cbl = colorbarLayout(F, A, rt, cell.h - mt - mb); mr += cbl.w - fs * 0.4; }
    // pass 1: estimated rect -> limits
    var estW = Math.max(30, cell.w - mlFixed - fs * 3 - mr), estH = Math.max(30, cell.h - mt - mb);
    var nX = clamp(Math.floor(estW / (fs * 5)), 2, 10), nY = clamp(Math.floor(estH / (fs * 2.8)), 2, 10);
    function lim(user, stl, lo, hi, log, tightAx, bar, n) {
      var L;
      if (stl) return stl.slice();
      if (user && isArr(user) && user.length >= 2) {
        var a = N(user[0]), b = N(user[1]);
        if (fin(a) && fin(b)) return [a, b];
        L = bar || autoLim(lo, hi, log, tight || tightAx ? 'tight' : 'nice', n);
        return [fin(a) ? a : L[0], fin(b) ? b : L[1]];
      }
      if (bar && !(lo < bar[0] || hi > bar[1])) return bar;
      if (bar) { lo = Math.min(lo, bar[0]); hi = Math.max(hi, bar[1]); return [lo, hi]; }
      return autoLim(lo, hi, log, tight || tightAx ? 'tight' : 'nice', n);
    }
    var xl = lim(A.xlim, st.xlim, B.x0, B.x1, logx, B.tightX, B.barX, nX);
    var yl = lim(A.ylim, st.ylim, B.y0, B.y1, logy, B.tightY, B.barY, nY);
    if (xl[0] === xl[1]) { xl = [xl[0] - 0.5, xl[1] + 0.5]; }
    if (yl[0] === yl[1]) { yl = [yl[0] - 0.5, yl[1] + 0.5]; }
    if (logx && xl[0] <= 0) xl[0] = xl[1] / 1000;
    if (logy && yl[0] <= 0) yl[0] = yl[1] / 1000;
    var ytk = function (h) {
      if (A.yticks) return userTicks(A.yticks, A.yticklabels, Math.min(yl[0], yl[1]), Math.max(yl[0], yl[1]));
      if (B.hcats && !logy) return catTicks(B.hcats, yl[0], yl[1]);
      return makeTicks(yl[0], yl[1], logy, clamp(Math.floor(h / (fs * 2.6)), 2, 10));
    };
    var yt = ytk(estH), ytw = axisOff ? 0 : measureTicks(ctx, yt, fs);
    var ml = mlFixed + ytw;
    var rect = { x: cell.x + ml, y: cell.y + mt, w: Math.max(20, cell.w - ml - mr), h: Math.max(20, cell.h - mt - mb) };
    var expShift = yt.exp && !axisOff ? (tl.length ? fs * 1.2 : fs * 0.6) : 0; // room for the ×10^n label above the y axis
    rect.y += expShift; rect.h -= expShift;
    // axis equal
    if (A.axis === 'equal' || A.axis === 'image' || A.axis === 'square') {
      if (A.axis === 'square') { var sq = Math.min(rect.w, rect.h); rect.x += (rect.w - sq) / 2; rect.y += (rect.h - sq) / 2; rect.w = rect.h = sq; }
      else if (!logx && !logy && !st.xlim) {
        var ux = (xl[1] - xl[0]) / rect.w, uy = (yl[1] - yl[0]) / rect.h;
        if (A.axis === 'image') { if (ux > uy) { var nh = (yl[1] - yl[0]) / ux; rect.y += (rect.h - nh) / 2; rect.h = nh; } else { var nw = (xl[1] - xl[0]) / uy; rect.x += (rect.w - nw) / 2; rect.w = nw; } }
        else if (ux > uy) { var cy0 = (yl[0] + yl[1]) / 2, hh = ux * rect.h / 2; yl = [cy0 - hh, cy0 + hh]; }
        else { var cx0 = (xl[0] + xl[1]) / 2, hw = uy * rect.w / 2; xl = [cx0 - hw, cx0 + hw]; }
      }
    }
    rect.x = Math.round(rect.x) + 0.5; rect.y = Math.round(rect.y) + 0.5; rect.w = Math.round(rect.w); rect.h = Math.round(rect.h);
    rt.rect = rect; rt.xl = xl; rt.yl = yl; rt.logx = logx; rt.logy = logy; rt.rev = B.rev;
    var TX = logx ? function (v) { return v > 0 ? Math.log10(v) : NaN; } : function (v) { return v; };
    var TY = logy ? function (v) { return v > 0 ? Math.log10(v) : NaN; } : function (v) { return v; };
    var tx0 = TX(xl[0]), tx1 = TX(xl[1]), ty0 = TY(yl[0]), ty1 = TY(yl[1]);
    var X = rt.X = function (v) { return rect.x + (TX(v) - tx0) / (tx1 - tx0) * rect.w; };
    var Y = rt.Y = B.rev ? function (v) { return rect.y + (TY(v) - ty0) / (ty1 - ty0) * rect.h; } : function (v) { return rect.y + rect.h - (TY(v) - ty0) / (ty1 - ty0) * rect.h; };
    rt.TX = TX; rt.TY = TY;
    rt.iX = function (p) { var u = tx0 + (p - rect.x) / rect.w * (tx1 - tx0); return logx ? Math.pow(10, u) : u; };
    rt.iY = function (p) { var f = B.rev ? (p - rect.y) / rect.h : (rect.y + rect.h - p) / rect.h, u = ty0 + f * (ty1 - ty0); return logy ? Math.pow(10, u) : u; };
    // final ticks
    yt = ytk(rect.h);
    var xt, xtw;
    if (A.xticks) xt = userTicks(A.xticks, A.xticklabels, Math.min(xl[0], xl[1]), Math.max(xl[0], xl[1]));
    else if (B.cats && !logx) xt = catTicks(B.cats, xl[0], xl[1]);
    else {
      var n = clamp(Math.floor(rect.w / (fs * 4)), 2, 11);
      for (var it = 0; it < 6; it++) {
        xt = makeTicks(xl[0], xl[1], logx, n);
        xtw = measureTicks(ctx, xt, fs);
        if (xt.t.length * (xtw + fs * 1.2) <= rect.w || n <= 2) break;
        n--;
      }
    }

    // background + grid
    if (!axisOff) { ctx.fillStyle = th.ax; ctx.fillRect(rect.x, rect.y, rect.w, rect.h); }
    var i, v;
    if (A.grid && !axisOff) {
      ctx.setLineDash([]); ctx.lineWidth = 1;
      if (xt.minor && xt.minor.length || yt.minor && yt.minor.length) {
        ctx.strokeStyle = th.minor; ctx.beginPath();
        (xt.minor || []).forEach(function (v) { var p = Math.round(X(v)) + 0.5; ctx.moveTo(p, rect.y); ctx.lineTo(p, rect.y + rect.h); });
        (yt.minor || []).forEach(function (v) { var p = Math.round(Y(v)) + 0.5; ctx.moveTo(rect.x, p); ctx.lineTo(rect.x + rect.w, p); });
        ctx.stroke();
      }
      ctx.strokeStyle = th.grid; ctx.beginPath();
      xt.t.forEach(function (v) { var p = Math.round(X(v)) + 0.5; ctx.moveTo(p, rect.y); ctx.lineTo(p, rect.y + rect.h); });
      yt.t.forEach(function (v) { var p = Math.round(Y(v)) + 0.5; ctx.moveTo(rect.x, p); ctx.lineTo(rect.x + rect.w, p); });
      ctx.stroke();
    }
    // series
    ctx.save();
    ctx.beginPath(); ctx.rect(rect.x - 0.5, rect.y - 0.5, rect.w + 1, rect.h + 1); ctx.clip();
    A.series.forEach(function (s) { drawSeries2D(F, A, rt, s); });
    ctx.restore();
    // axes
    if (!axisOff) {
      ctx.setLineDash([]); ctx.lineWidth = 1; ctx.strokeStyle = th.axis;
      var tkl = clamp(0.01 * Math.max(rect.w, rect.h), 3, 6.5);
      ctx.beginPath();
      if (A.box) ctx.rect(rect.x, rect.y, rect.w, rect.h);
      else { ctx.moveTo(rect.x, rect.y); ctx.lineTo(rect.x, rect.y + rect.h); ctx.lineTo(rect.x + rect.w, rect.y + rect.h); }
      var xB = rect.y + rect.h, yL = rect.x;
      xt.t.forEach(function (v) { var p = Math.round(X(v)) + 0.5; ctx.moveTo(p, xB); ctx.lineTo(p, xB - tkl); if (A.box) { ctx.moveTo(p, rect.y); ctx.lineTo(p, rect.y + tkl); } });
      yt.t.forEach(function (v) { var p = Math.round(Y(v)) + 0.5; ctx.moveTo(yL, p); ctx.lineTo(yL + tkl, p); if (A.box) { ctx.moveTo(rect.x + rect.w, p); ctx.lineTo(rect.x + rect.w - tkl, p); } });
      (xt.minor || []).forEach(function (v) { var p = Math.round(X(v)) + 0.5; ctx.moveTo(p, xB); ctx.lineTo(p, xB - tkl / 2); });
      (yt.minor || []).forEach(function (v) { var p = Math.round(Y(v)) + 0.5; ctx.moveTo(yL, p); ctx.lineTo(yL + tkl / 2, p); });
      ctx.stroke();
      // tick labels
      var labTop = xB + fs * 0.45, maxLabH = fs;
      for (i = 0; i < xt.t.length; i++) {
        var lw = texWidth(ctx, xt.labels[i], fs), px = X(xt.t[i]);
        px = clamp(px, cell.x + lw / 2 + 1, cell.x + cell.w - lw / 2 - 1);
        if (/\^/.test(xt.labels[i])) maxLabH = fs * 1.25;
        drawTex(ctx, xt.labels[i], px, labTop + (/\^/.test(xt.labels[i]) ? fs * 0.25 : 0), fs, th.text, { align: 'center', base: 'top' });
      }
      for (i = 0; i < yt.t.length; i++) {
        var py = Y(yt.t[i]);
        py = clamp(py, cell.y + fs * 0.55, cell.y + cell.h - fs * 0.55);
        drawTex(ctx, yt.labels[i], rect.x - fs * 0.45, py, fs, th.text, { align: 'right', base: 'middle' });
      }
      if (yt.exp) drawTex(ctx, '\\times10^{' + yt.exp + '}', rect.x, rect.y - fs * 0.35, fs, th.text, { align: 'left', base: 'bottom' });
      if (xt.exp) drawTex(ctx, '\\times10^{' + xt.exp + '}', rect.x + rect.w, labTop + fs * 1.15, fs, th.text, { align: 'right', base: 'top' });
      if (A.xlabel) {
        var xlY = labTop + maxLabH + fs * 0.35 + (xt.exp ? fs * 0.4 : 0);
        drawTex(ctx, String(A.xlabel), rect.x + rect.w / 2, xlY, fs * 1.05, th.text, { align: 'center', base: 'top' });
      }
      if (A.ylabel) {
        var ylX = rect.x - fs * 0.45 - ytw - fs * 0.45;
        drawTex(ctx, String(A.ylabel), Math.max(cell.x + fs * 1.15, ylX), rect.y + rect.h / 2, fs * 1.05, th.text, { align: 'center', base: 'bottom', rot: -Math.PI / 2 });
      }
    }
    drawTitle(F, rt, tl, rect.x + rect.w / 2, rect.y - fs * 0.5 - (tl.length ? expShift : 0));
    if (items.length) drawLegend(F, A, rt, items, rect);
    if (cbl) drawColorbar(F, A, rt, rect.x + rect.w + (outLeg ? legendSize(F, rt, items).w + fs * 0.6 : 0), rect.y, rect.h, cbl);
  }
  function drawTitle(F, rt, tl, cx, bottomY) {
    var fs = rt.fs * 1.1;
    for (var i = tl.length - 1, k = 0; i >= 0; i--, k++) {
      var w = texWidth(F.ctx, tl[i], fs, true), x = clamp(cx, rt.cell.x + w / 2 + 2, rt.cell.x + rt.cell.w - w / 2 - 2);
      drawTex(F.ctx, tl[i], x, bottomY - k * fs * 1.25, fs, F.th.text, { align: 'center', base: 'bottom', bold: true });
    }
  }

  function addPick(rt, px, py, info) { if (fin(px) && fin(py)) rt.picks.push({ px: px, py: py, info: info }); }
  function pickStride(n) { return Math.max(1, Math.ceil(n / 4000)); }

  function drawSeries2D(F, A, rt, s) {
    var ctx = F.ctx, th = F.th, X = rt.X, Y = rt.Y, g = s._g, ex = s.extra || {}, t = s.type, rect = rt.rect;
    var lw = lwPx(s.lineWidth), i, k, cm = getCmap(A.colormap), cl = A._clim;
    var edgeOf = function (def) { var e = colorArg(s.edgeColor); return e === 'none' ? null : (e && typeof e !== 'string') ? rgb(e) : def; };
    var mfc = function (col) { var f = colorArg(ex.markerFaceColor); return f === 'auto' || f === 'flat' ? rgb(col) : f && typeof f !== 'string' ? rgb(f) : null; };
    var mec = function (col) { var f = colorArg(ex.markerEdgeColor); return f && typeof f !== 'string' ? rgb(f) : f === 'none' ? null : rgb(col); };
    var Yc = function (v) { var p = Y(v); return fin(p) ? p : (rt.rev ? rect.y - 2 : rect.y + rect.h + 2); };
    var Xc = function (v) { var p = X(v); return fin(p) ? p : rect.x - 2; };
    switch (t) {
      case 'line': case 'stairs':
        g.lines.forEach(function (L) {
          var xs = t === 'stairs' ? L.sx : L.x, ys = t === 'stairs' ? L.sy : L.y;
          if (s.lineStyle !== 'none') { setLine(ctx, s.lineStyle, lw); ctx.strokeStyle = rgb(L.color); ctx.beginPath(); polyline(ctx, xs, ys, X, Y); ctx.stroke(); }
          if (s.marker !== 'none') {
            setLine(ctx, '-', Math.max(1, lw * 0.8));
            var d = msPx(s.markerSize), e = mec(L.color), f = mfc(L.color);
            for (i = 0; i < L.x.length; i++) { var px = X(L.x[i]), py = Y(L.y[i]); if (fin(px) && fin(py)) drawMarker(ctx, s.marker, px, py, d, e, f); }
          }
          var stp = pickStride(L.x.length);
          for (i = 0; i < L.x.length; i += stp) addPick(rt, X(L.x[i]), Y(L.y[i]), { x: L.x[i], y: L.y[i], name: s.displayName });
        });
        break;
      case 'scatter': {
        var L0 = g.lines[0], filled = !!ex.filled;
        setLine(ctx, '-', Math.max(1, lw * 0.8));
        var alpha = ex.markerFaceAlpha != null ? ex.markerFaceAlpha : 1;
        for (i = 0; i < L0.x.length; i++) {
          var sx = X(L0.x[i]), sy = Y(L0.y[i]);
          if (!fin(sx) || !fin(sy)) continue;
          var c = g.rgbs ? g.rgbs[i] : g.cv ? cm.tab[Math.max(0, cmapIndex(g.cv[i], cl[0], cl[1]))] : L0.color;
          drawMarker(ctx, s.marker, sx, sy, g.d[i], filled && s.marker !== '.' ? (ex.markerEdgeColor ? mec(c) : rgb(c)) : rgb(c), filled ? rgb(c, alpha) : mfc(c));
          addPick(rt, sx, sy, { x: L0.x[i], y: L0.y[i], c: g.cv ? g.cv[i] : undefined, name: s.displayName });
        }
        break;
      }
      case 'stem': {
        var base = ex.baseValue || 0;
        g.lines.forEach(function (L) {
          setLine(ctx, s.lineStyle === 'none' ? '-' : s.lineStyle, lw); ctx.strokeStyle = rgb(L.color); ctx.beginPath();
          for (i = 0; i < L.x.length; i++) { var px = X(L.x[i]), py = Y(L.y[i]); if (fin(px) && fin(py)) { ctx.moveTo(px, Yc(base)); ctx.lineTo(px, py); } }
          ctx.stroke();
          setLine(ctx, '-', Math.max(1, lw * 0.8));
          var f = ex.filled ? rgb(L.color) : mfc(L.color);
          for (i = 0; i < L.x.length; i++) { var qx = X(L.x[i]), qy = Y(L.y[i]); if (fin(qx) && fin(qy)) { drawMarker(ctx, s.marker, qx, qy, msPx(s.markerSize), rgb(L.color), f); addPick(rt, qx, qy, { x: L.x[i], y: L.y[i], name: s.displayName }); } }
        });
        if (ex.showBaseline !== false) { ctx.setLineDash([]); ctx.lineWidth = 1; ctx.strokeStyle = th.axis; ctx.beginPath(); var by = Math.round(Yc(base)) + 0.5; ctx.moveTo(rect.x, by); ctx.lineTo(rect.x + rect.w, by); ctx.stroke(); }
        break;
      }
      case 'errorbar': {
        g.lines.forEach(function (L) {
          var col = rgb(L.color), cap = (ex.capSize != null ? ex.capSize : 6) * 1.33 / 2;
          if (s.lineStyle !== 'none') { setLine(ctx, s.lineStyle, lw); ctx.strokeStyle = col; ctx.beginPath(); polyline(ctx, L.x, L.y, X, Y); ctx.stroke(); }
          setLine(ctx, '-', lw); ctx.strokeStyle = col; ctx.beginPath();
          for (i = 0; i < L.x.length; i++) {
            var px = X(L.x[i]), py = Y(L.y[i]); if (!fin(px) || !fin(py)) continue;
            if (g.neg || g.pos) {
              var y0 = Yc(L.y[i] - (g.neg ? g.neg[i] || 0 : 0)), y1 = Yc(L.y[i] + (g.pos ? g.pos[i] || 0 : 0));
              ctx.moveTo(px, y0); ctx.lineTo(px, y1); ctx.moveTo(px - cap, y0); ctx.lineTo(px + cap, y0); ctx.moveTo(px - cap, y1); ctx.lineTo(px + cap, y1);
            }
            if (g.xneg || g.xpos) {
              var x0 = Xc(L.x[i] - (g.xneg ? g.xneg[i] || 0 : 0)), x1 = Xc(L.x[i] + (g.xpos ? g.xpos[i] || 0 : 0));
              ctx.moveTo(x0, py); ctx.lineTo(x1, py); ctx.moveTo(x0, py - cap); ctx.lineTo(x0, py + cap); ctx.moveTo(x1, py - cap); ctx.lineTo(x1, py + cap);
            }
            addPick(rt, px, py, { x: L.x[i], y: L.y[i], err: g.pos ? g.pos[i] : undefined, name: s.displayName });
          }
          ctx.stroke();
          if (s.marker !== 'none') for (i = 0; i < L.x.length; i++) { var mx = X(L.x[i]), my = Y(L.y[i]); if (fin(mx) && fin(my)) drawMarker(ctx, s.marker, mx, my, msPx(s.markerSize), col, mfc(L.color)); }
        });
        break;
      }
      case 'bar': case 'barh': case 'histogram': {
        var horiz = t === 'barh' || g.horiz, alphaB = s.faceAlpha != null ? s.faceAlpha : (t === 'histogram' ? 0.6 : 1);
        var ec = edgeOf(th.edge);
        ctx.setLineDash([]); ctx.lineWidth = 0.8;
        g.rects.forEach(function (r) {
          var x0, x1, y0, y1;
          if (horiz) { y0 = Yc(r.a0); y1 = Yc(r.a1); x0 = Xc(r.b0); x1 = Xc(r.b1); }
          else { x0 = Xc(r.a0); x1 = Xc(r.a1); y0 = Yc(r.b0); y1 = Yc(r.b1); }
          var rx = Math.min(x0, x1), ry = Math.min(y0, y1), rw = Math.abs(x1 - x0), rh = Math.abs(y1 - y0);
          var col = t === 'histogram' ? g.color : g.colors[r.k];
          ctx.fillStyle = rgb(col, alphaB); ctx.fillRect(rx, ry, rw, rh);
          if (ec && (horiz ? rh : rw) > 2.5) { ctx.strokeStyle = ec; ctx.strokeRect(rx, ry, rw, rh); }
          var tipx = horiz ? X(r.b1) : X(t === 'histogram' ? r.x : (r.a0 + r.a1) / 2), tipy = horiz ? Y((r.a0 + r.a1) / 2) : Y(r.b1);
          var info = t === 'histogram' ? { x: r.x, y: r.v, bin: [r.a0, r.a1] } : horiz ? { x: r.v, y: r.x } : { x: r.x, y: r.v };
          if (g.cats) info.label = g.cats[g.x.indexOf(r.x)];
          addPick(rt, tipx, tipy, info);
        });
        break;
      }
      case 'area': {
        var ecA = edgeOf(th.edge), alphaA = s.faceAlpha != null ? s.faceAlpha : 1;
        g.layers.forEach(function (L) {
          ctx.beginPath(); var started = false, n = L.x.length;
          for (i = 0; i < n; i++) { var px = X(L.x[i]), py = Yc(L.hi[i]); if (!fin(px)) continue; if (started) ctx.lineTo(px, py); else { ctx.moveTo(px, py); started = true; } }
          for (i = n - 1; i >= 0; i--) { var qx = X(L.x[i]); if (fin(qx)) ctx.lineTo(qx, Yc(L.lo[i])); }
          ctx.closePath();
          ctx.fillStyle = rgb(L.color, alphaA); ctx.fill();
          if (ecA) { setLine(ctx, s.lineStyle === 'none' ? '-' : s.lineStyle, Math.max(0.8, lw * 0.8)); ctx.strokeStyle = ecA; ctx.beginPath(); polyline(ctx, L.x, L.hi, X, Yc); ctx.stroke(); }
          for (i = 0; i < n; i += pickStride(n)) addPick(rt, X(L.x[i]), Yc(L.hi[i]), { x: L.x[i], y: L.hi[i] });
        });
        break;
      }
      case 'fill': {
        var fc = g.color || cm.tab[Math.max(0, cmapIndex(g.cval, cl[0], cl[1]))];
        ctx.beginPath(); polyline(ctx, g.x, g.y, X, Y); ctx.closePath();
        if (colorArg(ex.faceColor) !== 'none') { ctx.fillStyle = rgb(fc, s.faceAlpha != null ? s.faceAlpha : 1); ctx.fill(); }
        var ef = edgeOf(th.edge); if (ef) { setLine(ctx, s.lineStyle === 'none' ? '-' : s.lineStyle, Math.max(0.8, lw * 0.8)); ctx.strokeStyle = ef; ctx.stroke(); }
        for (i = 0; i < g.x.length; i++) addPick(rt, X(g.x[i]), Y(g.y[i]), { x: g.x[i], y: g.y[i] });
        break;
      }
      case 'quiver': {
        setLine(ctx, s.lineStyle === 'none' ? '-' : s.lineStyle, lw); ctx.strokeStyle = rgb(g.color); ctx.beginPath();
        var head = ex.maxHeadSize != null ? ex.maxHeadSize : 0.3;
        g.arrows.forEach(function (a) {
          var x0 = X(a[0]), y0 = Y(a[1]), x1 = X(a[2]), y1 = Y(a[3]);
          if (!(fin(x0) && fin(y0) && fin(x1) && fin(y1))) return;
          ctx.moveTo(x0, y0); ctx.lineTo(x1, y1);
          var dx = x1 - x0, dy = y1 - y0, len = Math.sqrt(dx * dx + dy * dy);
          if (len > 1) { var hl = Math.min(len * head, 12), an = Math.atan2(dy, dx); ctx.moveTo(x1 - hl * Math.cos(an - 0.38), y1 - hl * Math.sin(an - 0.38)); ctx.lineTo(x1, y1); ctx.lineTo(x1 - hl * Math.cos(an + 0.38), y1 - hl * Math.sin(an + 0.38)); }
          addPick(rt, x0, y0, { x: a[0], y: a[1], u: a[2] - a[0], v: a[3] - a[1] });
        });
        ctx.stroke();
        break;
      }
      case 'text': drawTextSeries(F, rt, s, function (i) { return [X(g.x[i]), Y(g.y[i])]; }); break;
      case 'contour': case 'contourf': drawContour(F, A, rt, s); break;
      case 'imagesc': drawImagesc(F, A, rt, s); break;
    }
  }
  function drawTextSeries(F, rt, s, proj) {
    var g = s._g, ex = s.extra || {}, ctx = F.ctx;
    var fsz = ex.fontSize ? ex.fontSize * 1.33 * (rt.fs / 13) : rt.fs;
    var col = colorArg(s.color); col = col && typeof col !== 'string' ? rgb(col) : F.th.text;
    var ha = ex.horizontalAlignment || ex.HorizontalAlignment || 'left', va = ex.verticalAlignment || 'middle';
    var base = va === 'top' ? 'top' : va === 'bottom' || va === 'baseline' ? 'bottom' : 'middle';
    for (var i = 0; i < g.x.length; i++) {
      var p = proj(i); if (!p || !fin(p[0]) || !fin(p[1])) continue;
      var txt = g.text[i] != null ? g.text[i] : g.text[0], ls = lines(txt);
      for (var k = 0; k < ls.length; k++) drawTex(ctx, ls[k], p[0], p[1] + (k - (ls.length - 1) / 2) * fsz * 1.2, fsz, col, { align: ha, base: base, bold: ex.fontWeight === 'bold', rot: ex.rotation ? -ex.rotation * Math.PI / 180 : 0 });
    }
  }

  function drawContour(F, A, rt, s) {
    var ctx = F.ctx, g = s._g, G = g.grid, cm = getCmap(A.colormap), rect = rt.rect, X = rt.X, Y = rt.Y, ex = s.extra || {};
    if (!G || G.nr < 2 || G.nc < 2) return;
    var zr = g.zrange, levels = g.levels, i;
    var clo = A._clim[0], chi = A._clim[1];
    if (s.type === 'contourf') {
      var dpr = F.dpr, key = [rect.x, rect.y, rect.w, rect.h, rt.xl, rt.yl, dpr, cm.name, clo, chi, rt.rev].join(',');
      if (!g.cache || g.cacheKey !== key) {
        var R = rectilinear(G), sc = Math.min(dpr, 1.5);
        var w = Math.max(1, Math.round(rect.w * sc)), h = Math.max(1, Math.round(rect.h * sc));
        var oc = g.cache || document.createElement('canvas'); oc.width = w; oc.height = h;
        var oc2 = oc.getContext('2d'), img = oc2.createImageData(w, h), D = img.data;
        var colX = new Float64Array(w), rowY = new Float64Array(h);
        for (i = 0; i < w; i++) colX[i] = locate(R.xs, rt.iX(rect.x + (i + 0.5) / sc));
        for (i = 0; i < h; i++) rowY[i] = locate(R.ys, rt.iY(rect.y + (i + 0.5) / sc));
        var bandIdx = [cmapIndex(zr[0], clo, chi)];
        for (i = 0; i < levels.length; i++) bandIdx.push(cmapIndex(levels[i], clo, chi));
        var Z = G.Z;
        for (var yy = 0; yy < h; yy++) {
          var fy = rowY[yy]; if (fy < 0) continue;
          var r0 = Math.min(Math.floor(fy), G.nr - 2), uy = fy - r0, Zr = Z[r0], Zr1 = Z[r0 + 1];
          for (var xx = 0; xx < w; xx++) {
            var fx = colX[xx]; if (fx < 0) continue;
            var c0 = Math.min(Math.floor(fx), G.nc - 2), ux = fx - c0;
            var z = (Zr[c0] * (1 - ux) + Zr[c0 + 1] * ux) * (1 - uy) + (Zr1[c0] * (1 - ux) + Zr1[c0 + 1] * ux) * uy;
            if (!fin(z)) continue;
            var b = 0; while (b < levels.length && z >= levels[b]) b++;
            var ci = bandIdx[b], o = (yy * w + xx) * 4;
            if (ci < 0) ci = 0;
            D[o] = cm.u8[ci * 3]; D[o + 1] = cm.u8[ci * 3 + 1]; D[o + 2] = cm.u8[ci * 3 + 2]; D[o + 3] = 255;
          }
        }
        oc2.putImageData(img, 0, 0);
        g.cache = oc; g.cacheKey = key;
      }
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(g.cache, rect.x, rect.y, rect.w, rect.h);
    }
    var lineCol = colorArg(s.edgeColor) || colorArg(s.color);
    if (s.type === 'contourf' && lineCol === null) lineCol = F.th.edge;
    if (lineCol === 'none' || s.lineStyle === 'none') lineCol = 'none';
    if (!g.segs) { g.segs = levels.map(function (L) { return contourSegments(G, L); }); }
    if (lineCol !== 'none') {
      setLine(ctx, s.lineStyle || '-', s.type === 'contourf' ? Math.max(0.7, lwPx(s.lineWidth) * 0.75) : lwPx(s.lineWidth));
      levels.forEach(function (L, li) {
        var sg = g.segs[li];
        ctx.strokeStyle = lineCol && typeof lineCol !== 'string' ? rgb(lineCol) : typeof lineCol === 'string' && lineCol[0] === '#' ? lineCol : cm.str[Math.max(0, cmapIndex(L, clo, chi))];
        ctx.beginPath();
        for (var q = 0; q < sg.length; q += 4) { ctx.moveTo(X(sg[q]), Y(sg[q + 1])); ctx.lineTo(X(sg[q + 2]), Y(sg[q + 3])); }
        ctx.stroke();
        if (s.type === 'contour') { var stp = Math.max(4, Math.ceil(sg.length / 200) * 4); for (q = 0; q < sg.length; q += stp) addPick(rt, X(sg[q]), Y(sg[q + 1]), { x: sg[q], y: sg[q + 1], level: L }); }
      });
    }
    rt.valueAt = rt.valueAt || [];
    rt.valueAt.push(function (px, py) {
      var R = rectilinear(G), fx = locate(R.xs, rt.iX(px)), fy = locate(R.ys, rt.iY(py));
      if (fx < 0 || fy < 0) return null;
      var c0 = Math.min(Math.floor(fx), G.nc - 2), r0 = Math.min(Math.floor(fy), G.nr - 2), ux = fx - c0, uy = fy - r0, Z = G.Z;
      var z = (Z[r0][c0] * (1 - ux) + Z[r0][c0 + 1] * ux) * (1 - uy) + (Z[r0 + 1][c0] * (1 - ux) + Z[r0 + 1][c0 + 1] * ux) * uy;
      return { x: rt.iX(px), y: rt.iY(py), z: z };
    });
  }

  function drawImagesc(F, A, rt, s) {
    var ctx = F.ctx, g = s._g, G = g.grid, cm = getCmap(A.colormap), cl = A._clim, ex = s.extra || {};
    if (!G) return;
    var key = [cm.name, cl[0], cl[1]].join(',');
    if (!g.cache || g.cacheKey !== key) {
      var oc = g.cache || document.createElement('canvas'); oc.width = G.nc; oc.height = G.nr;
      var o2 = oc.getContext('2d'), img = o2.createImageData(G.nc, G.nr), D = img.data, C = G.C;
      var rgbImg = isMat(s.c) && isMat(s.c[0]);
      for (var r = 0; r < G.nr; r++) for (var c = 0; c < G.nc; c++) {
        var o = (r * G.nc + c) * 4, ci = cmapIndex(C[r][c], cl[0], cl[1]);
        if (ci < 0) { D[o + 3] = 0; continue; }
        D[o] = cm.u8[ci * 3]; D[o + 1] = cm.u8[ci * 3 + 1]; D[o + 2] = cm.u8[ci * 3 + 2]; D[o + 3] = 255;
      }
      void rgbImg;
      o2.putImageData(img, 0, 0);
      g.cache = oc; g.cacheKey = key;
    }
    var e = g.ext, x0 = rt.X(e[0]), x1 = rt.X(e[1]), y0 = rt.Y(e[2]), y1 = rt.Y(e[3]);
    ctx.save();
    ctx.imageSmoothingEnabled = false;
    ctx.globalAlpha = s.faceAlpha != null ? s.faceAlpha : (ex.alpha != null ? ex.alpha : 1);
    // row 0 of the image is at data y = e[2]; draw with transform so orientation follows the axis direction
    ctx.translate(x0, y0); ctx.scale((x1 - x0) / G.nc, (y1 - y0) / G.nr);
    ctx.drawImage(g.cache, 0, 0);
    ctx.restore();
    rt.valueAt = rt.valueAt || [];
    rt.valueAt.push(function (px, py) {
      var fx = (px - x0) / (x1 - x0) * G.nc, fy = (py - y0) / (y1 - y0) * G.nr;
      if (fx < 0 || fy < 0 || fx >= G.nc || fy >= G.nr) return null;
      var c = Math.floor(fx), r = Math.floor(fy), dx = (e[1] - e[0]) / G.nc, dy = (e[3] - e[2]) / G.nr;
      return { x: +(e[0] + (c + 0.5) * dx).toPrecision(10), y: +(e[2] + (r + 0.5) * dy).toPrecision(10), index: '[' + (r + 1) + ',' + (c + 1) + ']', value: G.C[r][c] };
    });
  }

  /* ------------------------------------------------------------------ pie */
  function drawPie(F, A, rt) {
    var ctx = F.ctx, th = F.th, fs = rt.fs, cell = rt.cell, cm = getCmap(A.colormap);
    var tl = lines(A.title), mt = tl.length ? fs * (0.8 + 1.32 * tl.length) : fs * 0.6;
    var items = A._legend, outLeg = items.length && A.legendLocation === 'eastoutside';
    var mr = outLeg ? legendSize(F, rt, items).w + fs : 0;
    var area = { x: cell.x + fs * 0.5, y: cell.y + mt, w: cell.w - fs - mr, h: cell.h - mt - fs * 0.6 };
    var s = A.series.filter(function (q) { return q.type === 'pie'; })[0], g = s._g, ex = s.extra || {};
    var vals = g.v, sum = vals.reduce(function (a, b) { return a + b; }, 0), frac = g.frac || vals.map(function (v) { return sum >= 1 || ex.normalize ? v / (sum || 1) : v; });
    var labels = vals.map(function (v, i) {
      if (s.labels && s.labels[i] != null && A.legend == null) return String(s.labels[i]);
      var p = frac[i] * 100; return (p < 1 && p > 0 ? '<1' : String(Math.round(p))) + '%';
    });
    var lw = 0; labels.forEach(function (l) { lw = Math.max(lw, texWidth(ctx, l, fs)); });
    var R = Math.max(10, Math.min(area.w / 2 - lw - fs * 0.8, area.h / 2 - fs * 1.4));
    var cx = area.x + area.w / 2, cy = area.y + area.h / 2;
    rt.rect = { x: cx - R, y: cy - R, w: 2 * R, h: 2 * R };
    var a = -Math.PI / 2 + 0, n = vals.length;
    var explode = ex.explode ? vec(ex.explode) : null;
    ctx.setLineDash([]); ctx.lineWidth = 0.9; ctx.strokeStyle = th.edge;
    var angles = [];
    for (var i = 0; i < n; i++) {
      var da = frac[i] * Math.PI * 2, mid = a - da / 2;
      // MATLAB draws slices counter-clockwise starting at 12 o'clock
      var off = explode && explode[i] ? R * 0.1 : 0, ox = Math.cos(mid) * off, oy = Math.sin(mid) * off;
      ctx.beginPath(); ctx.moveTo(cx + ox, cy + oy); ctx.arc(cx + ox, cy + oy, R, a, a - da, true); ctx.closePath();
      ctx.fillStyle = cm.str[n > 1 ? Math.round(i / (n - 1) * 255) : 0]; ctx.fill(); ctx.stroke();
      angles.push(mid);
      addPick(rt, cx + ox + Math.cos(mid) * R * 0.6, cy + oy + Math.sin(mid) * R * 0.6, { value: vals[i], percent: (frac[i] * 100).toFixed(1) + '%', label: s.labels ? s.labels[i] : undefined });
      a -= da;
    }
    for (i = 0; i < n; i++) {
      if (!frac[i]) continue;
      var m = angles[i], off2 = explode && explode[i] ? R * 0.1 : 0, lx = cx + Math.cos(m) * (R * 1.1 + off2), ly = cy + Math.sin(m) * (R * 1.1 + off2);
      var c = Math.cos(m);
      drawTex(ctx, labels[i], lx, ly, fs, th.text, { align: c > 0.2 ? 'left' : c < -0.2 ? 'right' : 'center', base: 'middle' });
    }
    drawTitle(F, rt, tl, cx, cell.y + mt - fs * 0.5);
    if (items.length) drawLegend(F, A, rt, items, outLeg ? rt.rect : { x: area.x, y: area.y, w: area.w, h: area.h });
    A.series.forEach(function (q) { if (q.type === 'text') drawTextSeries(F, rt, q, function (k) { return [cx + q._g.x[k] * R, cy - q._g.y[k] * R]; }); });
  }

  /* ------------------------------------------------------------------ 3D */
  function bounds3D(A) {
    var b = { x: [Infinity, -Infinity], y: [Infinity, -Infinity], z: [Infinity, -Infinity] };
    A.series.forEach(function (s) {
      var g = s._g;
      if (g.grid) {
        g.grid.X.forEach(function (r) { b.x = minmax(r, b.x[0], b.x[1]); });
        g.grid.Y.forEach(function (r) { b.y = minmax(r, b.y[0], b.y[1]); });
        if (s.type === 'imagesc' || s.type === 'contour' || s.type === 'contourf') b.z = minmax([0], b.z[0], b.z[1]);
        else g.grid.Z.forEach(function (r) { b.z = minmax(r, b.z[0], b.z[1]); });
      } else if (g.lines) {
        g.lines.forEach(function (L) { b.x = minmax(L.x, b.x[0], b.x[1]); b.y = minmax(L.y, b.y[0], b.y[1]); });
        b.z = minmax([0], b.z[0], b.z[1]);
      } else if (g.x) {
        b.x = minmax(g.x, b.x[0], b.x[1]); b.y = minmax(g.y, b.y[0], b.y[1]);
        if (g.z) b.z = minmax(g.z, b.z[0], b.z[1]);
      }
    });
    return b;
  }

  function draw3D(F, A, rt) {
    var ctx = F.ctx, th = F.th, fs = rt.fs, cell = rt.cell, st = F.state[rt.idx], cm = getCmap(A.colormap), cl = A._clim;
    var b = bounds3D(A), tight = A.axis === 'tight';
    var lim = function (user, bb) {
      if (user && isArr(user) && fin(N(user[0])) && fin(N(user[1])) && N(user[0]) !== N(user[1])) return [N(user[0]), N(user[1])];
      return autoLim(bb[0], bb[1], false, tight ? 'tight' : 'nice', 5);
    };
    var xl = lim(A.xlim, b.x), yl = lim(A.ylim, b.y), zl = lim(A.zlim, b.z);
    var view = st.view || (A.view && isArr(A.view) && A.view.length >= 2 ? [N(A.view[0]), N(A.view[1])] : (A.view === 2 ? [0, 90] : [-37.5, 30]));
    rt.view = view;
    var az = view[0] * Math.PI / 180, el = view[1] * Math.PI / 180;
    var ca = Math.cos(az), sa = Math.sin(az), ce = Math.cos(el), se = Math.sin(el);
    var xr = xl[1] - xl[0], yr = yl[1] - yl[0], zr = zl[1] - zl[0];
    var ax = 1, ay = 1, azz = 1;
    if (A.axis === 'equal') { var mxr = Math.max(xr, yr, zr); ax = xr / mxr; ay = yr / mxr; azz = zr / mxr; }
    var xc = (xl[0] + xl[1]) / 2, yc = (yl[0] + yl[1]) / 2, zc = (zl[0] + zl[1]) / 2;
    var kx = 2 * ax / xr, ky = 2 * ay / yr, kz = 2 * azz / zr;
    // view matrix (MATLAB viewmtx)
    var m00 = ca, m01 = sa, m10 = -se * sa, m11 = se * ca, m12 = ce, m20 = ce * sa, m21 = -ce * ca, m22 = se;
    var tl = lines(A.title);
    var mt = tl.length ? fs * (1.0 + 1.32 * tl.length) : fs * 1.2;
    var cbl = A.colorbar ? colorbarLayout(F, A, rt, cell.h * 0.7) : null;
    var items = A._legend, outLeg = items.length && A.legendLocation === 'eastoutside';
    var mr = fs * 2.4 + (cbl ? cbl.w : 0) + (outLeg ? legendSize(F, rt, items).w + fs : 0);
    var ml = fs * 4.6, mb = fs * 3.6;
    var rect = { x: cell.x + ml, y: cell.y + mt, w: Math.max(20, cell.w - ml - mr), h: Math.max(20, cell.h - mt - mb) };
    rt.rect = rect;
    // fit corners
    var u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity, sx, sy, sz;
    for (sx = -1; sx <= 1; sx += 2) for (sy = -1; sy <= 1; sy += 2) for (sz = -1; sz <= 1; sz += 2) {
      var U = m00 * sx * ax + m01 * sy * ay, V = m10 * sx * ax + m11 * sy * ay + m12 * sz * azz;
      u0 = Math.min(u0, U); u1 = Math.max(u1, U); v0 = Math.min(v0, V); v1 = Math.max(v1, V);
    }
    var S = Math.min(rect.w / Math.max(1e-6, u1 - u0), rect.h / Math.max(1e-6, v1 - v0));
    var ox = rect.x + rect.w / 2 - S * (u0 + u1) / 2, oy = rect.y + rect.h / 2 + S * (v0 + v1) / 2;
    function Pn(nx, ny, nz) { return [ox + S * (m00 * nx + m01 * ny), oy - S * (m10 * nx + m11 * ny + m12 * nz), m20 * nx + m21 * ny + m22 * nz]; }
    function P(x, y, z) { return Pn((x - xc) * kx, (y - yc) * ky, (z - zc) * kz); }
    rt.P = P;
    var fast = !!F.fast && F.slow3d;
    // back planes
    var xB = m20 > 1e-9 ? -ax : ax, yB = m21 > 1e-9 ? -ay : ay, zB = m22 > 1e-9 ? -azz : azz;
    if (Math.abs(m20) <= 1e-9) xB = -ax; if (Math.abs(m21) <= 1e-9) yB = ay;
    var quad = function (a, b2, c, d) { ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b2[0], b2[1]); ctx.lineTo(c[0], c[1]); ctx.lineTo(d[0], d[1]); ctx.closePath(); };
    var planes = [
      [Pn(xB, -ay, -azz), Pn(xB, ay, -azz), Pn(xB, ay, azz), Pn(xB, -ay, azz)],
      [Pn(-ax, yB, -azz), Pn(ax, yB, -azz), Pn(ax, yB, azz), Pn(-ax, yB, azz)],
      [Pn(-ax, -ay, zB), Pn(ax, -ay, zB), Pn(ax, ay, zB), Pn(-ax, ay, zB)]
    ];
    if (A.axis !== 'off') {
      ctx.fillStyle = th.ax;
      planes.forEach(function (p) { quad(p[0], p[1], p[2], p[3]); ctx.fill(); });
    }
    // ticks
    function edgeLen(a, b2) { return Math.sqrt(Math.pow(a[0] - b2[0], 2) + Math.pow(a[1] - b2[1], 2)); }
    var xa0 = Pn(-ax, -yB, zB), xa1 = Pn(ax, -yB, zB), ya0 = Pn(-xB, -ay, zB), ya1 = Pn(-xB, ay, zB);
    var zcx = -ax, zcy = -ay, best = Infinity;
    [[-ax, -ay], [ax, -ay], [ax, ay], [-ax, ay]].forEach(function (c) { var u = m00 * c[0] + m01 * c[1]; if (u < best - 1e-9) { best = u; zcx = c[0]; zcy = c[1]; } });
    var za0 = Pn(zcx, zcy, -azz), za1 = Pn(zcx, zcy, azz);
    var nT = function (len) { return clamp(Math.floor(len / (fs * 3.4)), 2, 7); };
    var mt3 = function (l, len) { var n = nT(len), tk = makeTicks(l[0], l[1], false, n); for (var q = 0; q < 3 && tk.t.length < 3; q++) tk = makeTicks(l[0], l[1], false, ++n); return tk; }; // at least 3 ticks per 3D axis
    var xtk = mt3(xl, edgeLen(xa0, xa1)), ytk = mt3(yl, edgeLen(ya0, ya1)), ztk = mt3(zl, edgeLen(za0, za1));
    if (A.axis !== 'off') {
      if (A.grid !== 'off' && A.grid !== false || A.grid === undefined || A.grid === false) {
        ctx.setLineDash([]); ctx.lineWidth = 1; ctx.strokeStyle = th.grid; ctx.beginPath();
        var gl = function (a, b2) { ctx.moveTo(a[0], a[1]); ctx.lineTo(b2[0], b2[1]); };
        if (A.grid !== 'off') {
          xtk.t.forEach(function (v) { var n = (v - xc) * kx; gl(Pn(n, -ay, zB), Pn(n, ay, zB)); gl(Pn(n, yB, -azz), Pn(n, yB, azz)); });
          ytk.t.forEach(function (v) { var n = (v - yc) * ky; gl(Pn(-ax, n, zB), Pn(ax, n, zB)); gl(Pn(xB, n, -azz), Pn(xB, n, azz)); });
          ztk.t.forEach(function (v) { var n = (v - zc) * kz; gl(Pn(xB, -ay, n), Pn(xB, ay, n)); gl(Pn(-ax, yB, n), Pn(ax, yB, n)); });
        }
        ctx.stroke();
      }
      ctx.strokeStyle = th.plane; ctx.lineWidth = 1; ctx.beginPath();
      planes.forEach(function (p) { quad(p[0], p[1], p[2], p[3]); }); ctx.stroke();
      ctx.strokeStyle = th.axis; ctx.beginPath();
      ctx.moveTo(xa0[0], xa0[1]); ctx.lineTo(xa1[0], xa1[1]); ctx.moveTo(ya0[0], ya0[1]); ctx.lineTo(ya1[0], ya1[1]); ctx.moveTo(za0[0], za0[1]); ctx.lineTo(za1[0], za1[1]);
      ctx.stroke();
    }
    // surfaces (painter's algorithm over all surf/mesh quads)
    var surfs = A.series.filter(function (s) { return (s.type === 'surf' || s.type === 'mesh') && s._g.grid; });
    var total = 0;
    surfs.forEach(function (s) {
      var g = s._g, G = g.grid, n = G.nr * G.nc, key = [xl, yl, zl, ax, ay, azz].join(',');
      if (g.nkey !== key) {
        g.nx = new Float64Array(n); g.ny = new Float64Array(n); g.nz = new Float64Array(n);
        for (var r = 0; r < G.nr; r++) for (var c = 0; c < G.nc; c++) { var q = r * G.nc + c; g.nx[q] = (G.X[r][c] - xc) * kx; g.ny[q] = (G.Y[r][c] - yc) * ky; g.nz[q] = (G.Z[r][c] - zc) * kz; }
        g.nkey = key;
      }
      var ckey = cm.name + cl.join(',');
      if (g.ckey !== ckey) {
        var nq = (G.nr - 1) * (G.nc - 1), cols = new Array(nq), C = G.C;
        for (r = 0; r < G.nr - 1; r++) for (c = 0; c < G.nc - 1; c++) {
          var mv = (C[r][c] + C[r][c + 1] + C[r + 1][c] + C[r + 1][c + 1]) / 4, ci = cmapIndex(mv, cl[0], cl[1]);
          cols[r * (G.nc - 1) + c] = ci < 0 ? null : cm.str[ci];
        }
        g.cols = cols; g.ckey = ckey;
      }
      if (!g.px || g.px.length !== n) { g.px = new Float64Array(n); g.py = new Float64Array(n); g.pd = new Float64Array(n); }
      for (var k = 0; k < n; k++) {
        var nx = g.nx[k], ny = g.ny[k], nz = g.nz[k];
        g.px[k] = ox + S * (m00 * nx + m01 * ny); g.py[k] = oy - S * (m10 * nx + m11 * ny + m12 * nz); g.pd[k] = m20 * nx + m21 * ny + m22 * nz;
      }
      total += (G.nr - 1) * (G.nc - 1);
    });
    if (total) {
      var qs = new Int32Array(total), qd = new Float64Array(total), qsIdx = new Int32Array(total), cnt = 0;
      surfs.forEach(function (s, si) {
        var g = s._g, G = g.grid, nc = G.nc;
        for (var r = 0; r < G.nr - 1; r++) for (var c = 0; c < nc - 1; c++) {
          var i0 = r * nc + c, d = g.pd[i0] + g.pd[i0 + 1] + g.pd[i0 + nc] + g.pd[i0 + nc + 1];
          if (!fin(d)) continue;
          qs[cnt] = r * (nc - 1) + c; qd[cnt] = d; qsIdx[cnt] = si; cnt++;
        }
      });
      var order = new Array(cnt); for (var q = 0; q < cnt; q++) order[q] = q;
      order.sort(function (a, b2) { return qd[a] - qd[b2]; });
      ctx.setLineDash([]); ctx.lineJoin = 'round';
      var styles = surfs.map(function (s) {
        var ex = s.extra || {}, ec = colorArg(s.edgeColor), fcA = colorArg(ex.faceColor);
        var shadingInterp = ex.shading === 'interp' || ex.shading === 'flat';
        var mesh = s.type === 'mesh';
        return {
          mesh: mesh, alpha: s.faceAlpha != null ? s.faceAlpha : 1,
          face: mesh ? (fcA && typeof fcA !== 'string' ? rgb(fcA) : fcA === 'none' ? null : th.ax) : (fcA === 'none' ? null : fcA && typeof fcA !== 'string' ? rgb(fcA) : 'cmap'),
          edge: mesh ? (ec && typeof ec !== 'string' ? rgb(ec) : ec === 'none' ? null : 'cmap') : (shadingInterp || ec === 'none' ? null : ec && typeof ec !== 'string' ? rgb(ec) : ec === 'flat' || ec === 'interp' ? 'cmap' : th.edge),
          lw: s.lineWidth != null ? lwPx(s.lineWidth) * 0.6 : (mesh ? 1 : 0.55)
        };
      });
      for (q = 0; q < cnt; q++) {
        var o = order[q], si = qsIdx[o], s = surfs[si], g = s._g, nc2 = g.grid.nc, qi = qs[o];
        var r0 = Math.floor(qi / (nc2 - 1)), c0 = qi % (nc2 - 1), i00 = r0 * nc2 + c0, i01 = i00 + 1, i10 = i00 + nc2, i11 = i10 + 1;
        var col = g.cols[qi], sty = styles[si];
        if (col == null) continue;
        ctx.beginPath(); ctx.moveTo(g.px[i00], g.py[i00]); ctx.lineTo(g.px[i01], g.py[i01]); ctx.lineTo(g.px[i11], g.py[i11]); ctx.lineTo(g.px[i10], g.py[i10]); ctx.closePath();
        if (sty.face) {
          ctx.globalAlpha = sty.alpha;
          ctx.fillStyle = sty.face === 'cmap' ? col : sty.face; ctx.fill();
          ctx.globalAlpha = 1;
        }
        if (sty.edge && !(fast && !sty.mesh)) { ctx.lineWidth = sty.lw; ctx.strokeStyle = sty.edge === 'cmap' ? col : sty.edge; ctx.stroke(); }
        else if (sty.face && !fast && sty.alpha === 1) { ctx.lineWidth = 0.6; ctx.strokeStyle = sty.face === 'cmap' ? col : sty.face; ctx.stroke(); }
      }
      // picks (subsampled vertices)
      surfs.forEach(function (s) {
        var g = s._g, G = g.grid, n = G.nr * G.nc, stp = Math.max(1, Math.ceil(n / 2500));
        for (var k = 0; k < n; k += stp) { var r = Math.floor(k / G.nc), c = k % G.nc; addPick(rt, g.px[k], g.py[k], { x: G.X[r][c], y: G.Y[r][c], z: G.Z[r][c] }); }
      });
    }
    // lines & scatter
    A.series.forEach(function (s) {
      var g = s._g, ex = s.extra || {}, i;
      if (s.type === 'plot3' || (s.type === 'line' && g.lines)) {
        var xs = g.x || g.lines[0].x, ys = g.y || g.lines[0].y, zs = g.z || xs.map(function () { return zl[0] < 0 && zl[1] > 0 ? 0 : zl[0]; });
        var col = rgb(g.color || g.lines[0].color), pts = [];
        for (i = 0; i < xs.length; i++) pts.push(fin(xs[i]) && fin(ys[i]) && fin(zs[i]) ? P(xs[i], ys[i], zs[i]) : null);
        if (s.lineStyle !== 'none') {
          setLine(ctx, s.lineStyle, lwPx(s.lineWidth)); ctx.strokeStyle = col; ctx.beginPath(); var pen = false;
          pts.forEach(function (p) { if (!p) { pen = false; return; } if (pen) ctx.lineTo(p[0], p[1]); else { ctx.moveTo(p[0], p[1]); pen = true; } });
          ctx.stroke();
        }
        if (s.marker !== 'none') { setLine(ctx, '-', 1); pts.forEach(function (p) { if (p) drawMarker(ctx, s.marker, p[0], p[1], msPx(s.markerSize), col, null); }); }
        var stp = pickStride(pts.length);
        for (i = 0; i < pts.length; i += stp) if (pts[i]) addPick(rt, pts[i][0], pts[i][1], { x: xs[i], y: ys[i], z: zs[i] });
      } else if (s.type === 'scatter3') {
        var arr = [];
        for (i = 0; i < g.x.length; i++) if (fin(g.x[i]) && fin(g.y[i]) && fin(g.z[i])) { var p = P(g.x[i], g.y[i], g.z[i]); p.push(i); arr.push(p); }
        arr.sort(function (a, b2) { return a[2] - b2[2]; });
        setLine(ctx, '-', 1);
        arr.forEach(function (p) {
          var i2 = p[3], c = g.rgbs ? g.rgbs[i2] : g.cv ? cm.tab[Math.max(0, cmapIndex(g.cv[i2], cl[0], cl[1]))] : g.color;
          drawMarker(ctx, s.marker, p[0], p[1], g.ds ? (g.ds.length === 1 ? g.ds[0] : g.ds[i2]) : g.d, rgb(c), ex.filled ? rgb(c) : null);
          addPick(rt, p[0], p[1], { x: g.x[i2], y: g.y[i2], z: g.z[i2] });
        });
      } else if (s.type === 'text') {
        drawTextSeries(F, rt, s, function (k) { return P(g.x[k], g.y[k], g.z && fin(g.z[k]) ? g.z[k] : zl[0]); });
      }
    });
    if (A.box && A.axis !== 'off') {
      ctx.setLineDash([]); ctx.lineWidth = 1; ctx.strokeStyle = th.axis; ctx.beginPath();
      var cs = []; for (sx = -1; sx <= 1; sx += 2) for (sy = -1; sy <= 1; sy += 2) for (sz = -1; sz <= 1; sz += 2) cs.push([sx, sy, sz]);
      cs.forEach(function (a) { cs.forEach(function (b2) { var d = Math.abs(a[0] - b2[0]) + Math.abs(a[1] - b2[1]) + Math.abs(a[2] - b2[2]); if (d === 2 && a < b2) { var p1 = Pn(a[0] * ax, a[1] * ay, a[2] * azz), p2 = Pn(b2[0] * ax, b2[1] * ay, b2[2] * azz); ctx.moveTo(p1[0], p1[1]); ctx.lineTo(p2[0], p2[1]); } }); });
      ctx.stroke();
    }
    // tick labels
    if (A.axis !== 'off') {
      var ctr = Pn(0, 0, 0);
      var axisLabels = function (tk, a0, a1, mapN, toPt, label, isZ) {
        var len = edgeLen(a0, a1); if (len < fs * 1.5) return;
        var mid = [(a0[0] + a1[0]) / 2, (a0[1] + a1[1]) / 2];
        var dx = mid[0] - ctr[0], dy = mid[1] - ctr[1];
        if (isZ) { dx = -1; dy = 0; }
        var dl = Math.sqrt(dx * dx + dy * dy) || 1; dx /= dl; dy /= dl;
        var ha = dx > 0.35 ? 'left' : dx < -0.35 ? 'right' : 'center', vb = dy > 0.35 ? 'top' : dy < -0.35 ? 'bottom' : 'middle';
        var mw = 0;
        ctx.strokeStyle = th.axis; ctx.lineWidth = 1; ctx.beginPath();
        tk.t.forEach(function (v, i) {
          var p = toPt(mapN(v));
          ctx.moveTo(p[0], p[1]); ctx.lineTo(p[0] + dx * fs * 0.35, p[1] + dy * fs * 0.35);
          var w = drawTex(ctx, tk.labels[i], p[0] + dx * fs * 0.6, p[1] + dy * fs * 0.6, fs, th.text, { align: ha, base: vb });
          mw = Math.max(mw, w);
        });
        ctx.stroke();
        if (tk.exp) drawTex(ctx, '\\times10^{' + tk.exp + '}', a1[0] + dx * fs, a1[1] + dy * fs - fs * 0.2, fs * 0.9, th.text, { align: ha, base: 'bottom' });
        if (label) {
          var ext = fs * 0.6 + Math.abs(dx) * mw + Math.abs(dy) * fs + fs * 0.75;
          var lx = mid[0] + dx * ext, ly = mid[1] + dy * ext, ang;
          if (isZ) ang = -Math.PI / 2;
          else { ang = Math.atan2(a1[1] - a0[1], a1[0] - a0[0]); if (ang > Math.PI / 2) ang -= Math.PI; if (ang < -Math.PI / 2) ang += Math.PI; }
          drawTex(ctx, String(label), lx, ly, fs * 1.05, th.text, { align: 'center', base: isZ ? 'bottom' : 'middle', rot: ang });
        }
      };
      axisLabels(xtk, xa0, xa1, function (v) { return (v - xc) * kx; }, function (n) { return Pn(n, -yB, zB); }, A.xlabel);
      axisLabels(ytk, ya0, ya1, function (v) { return (v - yc) * ky; }, function (n) { return Pn(-xB, n, zB); }, A.ylabel);
      if (Math.abs(ce) > 0.08) axisLabels(ztk, za0, za1, function (v) { return (v - zc) * kz; }, function (n) { return Pn(zcx, zcy, n); }, A.zlabel, true);
    }
    var topY = Math.min(rect.y, Pn(0, 0, azz)[1]);
    drawTitle(F, rt, tl, rect.x + rect.w / 2, Math.max(cell.y + fs * 1.3 * (tl.length || 1), Math.min(rect.y - fs * 0.3, topY - fs * 0.6)));
    if (cbl) drawColorbar(F, A, rt, cell.x + cell.w - cbl.w - (outLeg ? legendSize(F, rt, items).w + fs : 0), rect.y + rect.h * 0.08, rect.h * 0.84, cbl);
    if (items.length) drawLegend(F, A, rt, items, outLeg ? { x: cell.x + cell.w - legendSize(F, rt, items).w - fs * 1.4, y: rect.y, w: 0, h: rect.h } : rect);
  }

  /* ------------------------------------------------------------------ interaction */
  Figure.prototype._pos = function (e) {
    var r = this.canvas.getBoundingClientRect();
    return [(e.clientX - r.left) * (this.W / (r.width || this.W)), (e.clientY - r.top) * (this.H / (r.height || this.H))];
  };
  Figure.prototype._hit = function (x, y) {
    var rts = this.rts || [];
    for (var i = rts.length - 1; i >= 0; i--) { var c = rts[i].cell; if (x >= c.x && x <= c.x + c.w && y >= c.y && y <= c.y + c.h) return rts[i]; }
    return null;
  };
  Figure.prototype._schedule = function () {
    var self = this;
    if (this._raf) return;
    this._raf = requestAnimationFrame(function () {
      self._raf = 0; self.fast = true; self.draw(); self.fast = false;
      if (self.lastDrawMs > 14) self.slow3d = true;
    });
  };
  Figure.prototype._hideTip = function () { this.tip.style.display = 'none'; this.dot.style.display = 'none'; };
  Figure.prototype._showTip = function (x, y, touch) {
    var rt = this._hit(x, y);
    if (!rt) { this._hideTip(); return; }
    var best = null, bd = touch ? 28 : 18, info = null, px, py;
    rt.picks.forEach(function (p) { var d = Math.hypot(p.px - x, p.py - y); if (d < bd) { bd = d; best = p; } });
    if (best) { info = best.info; px = best.px; py = best.py; }
    else if (rt.valueAt && rt.rect && x >= rt.rect.x && x <= rt.rect.x + rt.rect.w && y >= rt.rect.y && y <= rt.rect.y + rt.rect.h) {
      for (var i = rt.valueAt.length - 1; i >= 0 && !info; i--) info = rt.valueAt[i](x, y);
      px = x; py = y;
    }
    if (!info) { this._hideTip(); return; }
    var th = this.th, txt = [];
    if (info.label != null) txt.push(String(info.label));
    var keys = { x: 'X', y: 'Y', z: 'Z', value: 'Value', c: 'C', level: 'Level', index: 'Index', percent: 'Percent', u: 'U', v: 'V', err: '±' };
    Object.keys(keys).forEach(function (k) { if (info[k] !== undefined && info[k] !== null) txt.push(keys[k] + ' ' + (typeof info[k] === 'number' ? fmtNum(info[k]) : info[k])); });
    if (info.bin) txt.push('Bin [' + fmtNum(info.bin[0]) + ', ' + fmtNum(info.bin[1]) + ')');
    var tip = this.tip, cw = this.canvas.getBoundingClientRect().width || this.W, k = cw / this.W;
    tip.textContent = txt.join('\n');
    tip.style.background = th.tipBg; tip.style.color = th.tipFg; tip.style.border = '1px solid ' + th.tipEdge;
    tip.style.display = 'block';
    var ox = this.canvas.offsetLeft, oy = this.canvas.offsetTop;
    var tw = tip.offsetWidth, thh = tip.offsetHeight, left = ox + px * k + 10, top = oy + py * k - thh - 8;
    if (left + tw > ox + cw - 2) left = ox + px * k - tw - 10;
    if (left < ox + 2) left = ox + 2;
    if (top < oy + 2) top = oy + py * k + 12;
    tip.style.left = left + 'px'; tip.style.top = top + 'px';
    if (best) { this.dot.style.display = 'block'; this.dot.style.left = (ox + px * k) + 'px'; this.dot.style.top = (oy + py * k) + 'px'; this.dot.style.borderColor = th.dot; this.dot.style.background = 'transparent'; }
    else this.dot.style.display = 'none';
  };
  Figure.prototype.resetView = function (idx) {
    var self = this;
    this.state.forEach(function (s, i) { if (idx == null || idx === i) { self.state[i] = {}; } });
    this.draw();
  };
  Figure.prototype._bind = function () {
    var self = this, cv = this.canvas, drag = null, lastTap = { t: 0, x: 0, y: 0 };
    var has3d = this.spec.axes.some(function (A) { return A._3d; });
    cv.style.touchAction = has3d ? 'none' : 'pan-y pinch-zoom';
    this._h = {
      down: function (e) {
        var p = self._pos(e), rt = self._hit(p[0], p[1]);
        self.active = true;
        if (!rt) return;
        drag = { rt: rt, x0: p[0], y0: p[1], moved: false, id: e.pointerId, type: e.pointerType };
        if (rt.is3d) { drag.mode = 'rot'; drag.view0 = (rt.view || [-37.5, 30]).slice(); }
        else if (rt.is2d && e.pointerType === 'mouse' && e.button === 0) { drag.mode = 'pan'; drag.xl = rt.xl.slice(); drag.yl = rt.yl.slice(); }
        else drag.mode = 'tap';
        if (drag.mode !== 'tap' && cv.setPointerCapture) { try { cv.setPointerCapture(e.pointerId); } catch (er) { /* ignore */ } }
      },
      move: function (e) {
        var p = self._pos(e);
        if (drag && drag.id === e.pointerId) {
          var dx = p[0] - drag.x0, dy = p[1] - drag.y0;
          if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
          if (!drag.moved) return;
          var st = self.state[drag.rt.idx];
          if (drag.mode === 'rot') {
            self._hideTip();
            var az = drag.view0[0] - dx * 0.5, el = clamp(drag.view0[1] + dy * 0.5, -90, 90);
            st.view = [((az + 180) % 360 + 360) % 360 - 180, el];
            self._schedule(); e.preventDefault && e.preventDefault();
          } else if (drag.mode === 'pan') {
            self._hideTip();
            var rt = drag.rt, r = rt.rect;
            var sh = function (lim, d, len, log) {
              var a = log ? Math.log10(lim[0]) : lim[0], b = log ? Math.log10(lim[1]) : lim[1], k = d / len * (b - a);
              return log ? [Math.pow(10, a - k), Math.pow(10, b - k)] : [a - k, b - k];
            };
            st.xlim = sh(drag.xl, dx, r.w, rt.logx);
            st.ylim = sh(drag.yl, rt.rev ? dy : -dy, r.h, rt.logy);
            self._schedule();
          }
          return;
        }
        if (e.pointerType === 'mouse') self._showTip(p[0], p[1], false);
      },
      up: function (e) {
        if (!drag || drag.id !== e.pointerId) return;
        var p = self._pos(e), d = drag; drag = null;
        if (d.moved) { self.fast = false; self.draw(); return; }
        var now = Date.now();
        if (now - lastTap.t < 320 && Math.hypot(p[0] - lastTap.x, p[1] - lastTap.y) < 30) {
          lastTap.t = 0; self._hideTip(); self.resetView(d.rt.idx); return;
        }
        lastTap = { t: now, x: p[0], y: p[1] };
        self._showTip(p[0], p[1], d.type !== 'mouse');
      },
      cancel: function () { drag = null; },
      leave: function (e) { if (e.pointerType === 'mouse') { self._hideTip(); self.active = false; } },
      dbl: function (e) { var p = self._pos(e), rt = self._hit(p[0], p[1]); if (rt) self.resetView(rt.idx); },
      wheel: function (e) {
        if (!self.active) return;
        var p = self._pos(e), rt = self._hit(p[0], p[1]);
        if (!rt || !rt.is2d || !rt.rect) return;
        var r = rt.rect; if (p[0] < r.x || p[0] > r.x + r.w || p[1] < r.y || p[1] > r.y + r.h) return;
        e.preventDefault();
        var f = Math.exp(clamp(e.deltaY, -200, 200) * 0.0018), st = self.state[rt.idx];
        var z = function (lim, c, log) {
          var a = log ? Math.log10(lim[0]) : lim[0], b = log ? Math.log10(lim[1]) : lim[1], cc = log ? Math.log10(c) : c;
          var na = cc + (a - cc) * f, nb = cc + (b - cc) * f;
          return log ? [Math.pow(10, na), Math.pow(10, nb)] : [na, nb];
        };
        st.xlim = z(rt.xl, rt.iX(p[0]), rt.logx); st.ylim = z(rt.yl, rt.iY(p[1]), rt.logy);
        self._hideTip(); self._schedule();
      }
    };
    cv.addEventListener('pointerdown', this._h.down);
    cv.addEventListener('pointermove', this._h.move);
    cv.addEventListener('pointerup', this._h.up);
    cv.addEventListener('pointercancel', this._h.cancel);
    cv.addEventListener('pointerleave', this._h.leave);
    cv.addEventListener('dblclick', this._h.dbl);
    cv.addEventListener('wheel', this._h.wheel, { passive: false });
  };
  Figure.prototype.destroy = function () {
    var cv = this.canvas, h = this._h;
    if (this.ro) this.ro.disconnect();
    if (this._raf) cancelAnimationFrame(this._raf);
    if (h) {
      cv.removeEventListener('pointerdown', h.down); cv.removeEventListener('pointermove', h.move);
      cv.removeEventListener('pointerup', h.up); cv.removeEventListener('pointercancel', h.cancel);
      cv.removeEventListener('pointerleave', h.leave); cv.removeEventListener('dblclick', h.dbl);
      cv.removeEventListener('wheel', h.wheel);
    }
    [cv, this.tip, this.dot].forEach(function (el) { if (el && el.parentNode) el.parentNode.removeChild(el); });
    this.rts = [];
  };

  /* ------------------------------------------------------------------ public API */
  function render(container, spec, opts) {
    if (typeof container === 'string') container = document.querySelector(container);
    if (!container) throw new Error('MLPlot.render: container element not found');
    var F = new Figure(container, spec, opts || {});
    var handle = {
      canvas: F.canvas,
      figure: F,
      destroy: function () { F.destroy(); },
      toPNG: function () { if (F._raf) { cancelAnimationFrame(F._raf); F._raf = 0; F.draw(); } return F.canvas.toDataURL('image/png'); },
      resize: function () { F.draw(); },
      update: function (s) { F.setSpec(s); var has3d = F.spec.axes.some(function (A) { return A._3d; }); F.canvas.style.touchAction = has3d ? 'none' : 'pan-y pinch-zoom'; F.draw(); },
      setTheme: function (t) { F.opts.theme = t; F.draw(); },
      resetView: function (i) { F.resetView(i); },
      getView: function (i) { var rt = F.rts && F.rts[i || 0]; return rt && rt.view ? rt.view.slice() : null; }
    };
    return handle;
  }
  function colormap(name, n) {
    n = n || 64; var out = [];
    for (var i = 0; i < n; i++) out.push(CMAPS[CMAPS[name] ? name : 'parula'](n > 1 ? i / (n - 1) : 0).map(clamp01));
    return out;
  }

  root.MLPlot = {
    version: '1.0.0',
    render: render,
    colormap: colormap,
    colormaps: Object.keys(CMAPS),
    defaultColorOrder: ORDER.map(function (c) { return c.slice(); }),
    _internal: { niceStep: niceStep, makeTicks: makeTicks, autoLim: autoLim, contourSegments: contourSegments, texRuns: texRuns, normalizeSpec: normalizeSpec }
  };
})(typeof window !== 'undefined' ? window : this);
