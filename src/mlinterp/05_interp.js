
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
