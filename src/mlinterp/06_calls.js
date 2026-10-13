
// ======================================================================
// Functions, files, calls
// ======================================================================
let fnUid = 0;
function assignedNames(stmts, out) {
  for (const s of stmts) {
    switch (s.type) {
      case 'Assign': out.add(s.lhs.name); break;
      case 'Multi': for (const l of s.lhs) if (l) out.add(l.name); break;
      case 'For': out.add(s.v); assignedNames(s.body, out); break;
      case 'If': for (const c of s.clauses) assignedNames(c.body, out); if (s.els) assignedNames(s.els, out); break;
      case 'While': case 'DoUntil': assignedNames(s.body, out); break;
      case 'Switch': for (const c of s.cases) assignedNames(c.body, out); if (s.other) assignedNames(s.other, out); break;
      case 'Try': assignedNames(s.body, out); if (s.id) out.add(s.id); assignedNames(s.cbody, out); break;
      case 'Global': case 'Persistent': for (const n of s.names) out.add(n); break;
    }
  }
  return out;
}
function referencedNames(stmts) { const out = new Set(); freeIds({ type: 'X', list: stmts }, new Set(), out); assignedNames(stmts, out); return out; }
function buildFuncDef(fa, ctx, parent) {
  const def = {
    name: fa.name, params: fa.params, outs: fa.outs, line: fa.line, ctx, parent, uid: ++fnUid,
    hasVarargin: fa.params.length > 0 && fa.params[fa.params.length - 1] === 'varargin',
    hasVarargout: fa.outs.length > 0 && fa.outs[fa.outs.length - 1] === 'varargout',
    nested: Object.create(null), body: null, ast: fa, shared: null, cache: Object.create(null),
  };
  def.localVars = new Set([...fa.params, ...fa.outs, ...assignedNames(fa.body, new Set())]);
  for (const n of fa.nested) def.nested[n.name] = buildFuncDef(n, ctx, def);
  return def;
}
function finalizeShared(def) {
  if (def.parent) {
    const refs = referencedNames(def.ast.body);
    const own = new Set([...def.ast.params, ...def.ast.outs]);
    const shared = [];
    for (const r of refs) {
      if (own.has(r)) continue;
      let p = def.parent, depth = 1;
      while (p) { if (p.localVars.has(r)) { shared.push({ name: r, def: p }); break; } p = p.parent; depth++; }
    }
    def.shared = shared.length ? shared : null;
  }
  for (const k in def.nested) finalizeShared(def.nested[k]);
}
function compileFuncDef(def) {
  if (!def.body) { def.body = compileBlock(def.ast.body); }
  return def;
}
function loadFile(name, src) { // returns ctx
  const ast = parseProgram(src, name);
  const ctx = { file: name, funcs: Object.create(null), script: null, isFunctionFile: ast.isFunctionFile, main: null, cache: Object.create(null) };
  for (const fa of ast.funcs) { const d = buildFuncDef(fa, ctx, null); finalizeShared(d); if (!(fa.name in ctx.funcs)) ctx.funcs[fa.name] = d; if (!ctx.main) ctx.main = d; }
  if (!ast.isFunctionFile) ctx.scriptAst = ast.script;
  return ctx;
}
function getFileCtx(name) {
  if (ST.fileCtx[name] !== undefined) return ST.fileCtx[name];
  const fn = name + '.m';
  const src = ST.files[fn];
  if (src === undefined) { ST.fileCtx[name] = null; return null; }
  const saveLine = ST.line, saveFile = ST.file;
  ST.file = fn;
  const ctx = loadFile(fn, src);
  ST.line = saveLine; ST.file = saveFile;
  ST.fileCtx[name] = ctx;
  return ctx;
}
function resolveFn(f, name) {
  // nested functions visible from current function
  let def = f.fn;
  const cache = def ? def.cache : (f.ctx ? f.ctx.cache : null);
  if (cache) { const c = cache[name]; if (c !== undefined) return c; }
  let res = null;
  let d = def;
  while (d && !res) { if (d.nested[name]) res = { kind: 'user', def: d.nested[name] }; else if (d.name === name && d.parent) res = { kind: 'user', def: d }; d = d.parent; }
  if (!res && f.ctx && f.ctx.funcs[name]) res = { kind: 'user', def: f.ctx.funcs[name] };
  if (!res) {
    const ctx = getFileCtx(name);
    if (ctx) { if (ctx.isFunctionFile) res = { kind: 'user', def: ctx.main }; else res = { kind: 'script', ctx }; }
  }
  if (!res && BUILTINS[name]) res = { kind: 'builtin', fn: BUILTINS[name], name };
  if (cache && res) cache[name] = res;
  return res;
}
function undefinedErr(name) {
  if (ST.frame && ST.frame.fn && ST.frame.fn.params.indexOf(name) >= 0) err('输入参数的数目不足（参数 \'' + name + '\' 未提供）。', 'MATLAB:minrhs');
  err("未定义函数或变量 '" + name + "'。", 'MATLAB:UndefinedFunction');
}
function callNamed(f, name, args, nout) {
  const r = resolveFn(f, name);
  if (!r) undefinedErr(name);
  return invoke(r, f, name, args, nout);
}
function callNamedSingle(f, name, args) {
  const r = callNamed(f, name, args, 1);
  if (r.length === 0) err("函数 '" + name + "' 没有返回值，无法用于表达式。", 'MATLAB:TooManyOutputs');
  return r[0];
}
function invoke(r, f, name, args, nout, parentFrame) {
  if (r.kind === 'builtin') {
    const v = r.fn(args, nout, f);
    if (v === undefined) return [];
    if (v instanceof MR) return v.v;
    return [v];
  }
  if (r.kind === 'user') return callUser(r.def, args, nout, f, parentFrame);
  if (r.kind === 'script') {
    if (args.length) err("尝试将脚本 '" + name + "' 作为函数执行。", 'MATLAB:scriptNotAFunction');
    runScriptCtx(r.ctx, f);
    return [];
  }
  return [];
}
function runScriptCtx(ctx, f) {
  if (!ctx.scriptBody) ctx.scriptBody = compileBlock(ctx.scriptAst);
  const saveFile = ST.file, saveCtx = f.ctx;
  ST.file = ctx.file;
  f.ctx = ctx; // local functions of the script become visible
  try { ctx.scriptBody(f); } finally { ST.file = saveFile; f.ctx = saveCtx; }
}
function callBuiltinVals(name, args, nout) {
  const fn = BUILTINS[name]; if (!fn) undefinedErr(name);
  const v = fn(args, nout, ST.frame);
  if (v === undefined) return []; if (v instanceof MR) return v.v; return [v];
}
function findParentFrame(def, f) {
  let g = f;
  while (g) { if (g.fn === def.parent) return g; g = g.parentFrame; }
  return null;
}
function callUser(def, args, nout, callerFrame, parentFrame) {
  compileFuncDef(def);
  const np = def.params.length;
  const nfixed = def.hasVarargin ? np - 1 : np;
  if (args.length > nfixed && !def.hasVarargin) err("输入参数太多（函数 '" + def.name + "' 最多接受 " + np + ' 个输入）。', 'MATLAB:TooManyInputs');
  const nouts = def.outs.length;
  if (nout > nouts && !def.hasVarargout) err("输出参数太多（函数 '" + def.name + "' 最多返回 " + nouts + ' 个输出）。', 'MATLAB:TooManyOutputs');
  if (ST.depth >= ST.maxDepth) err('超出最大递归深度（' + ST.maxDepth + '）。可能存在无穷递归。', 'MATLAB:recursionLimit');
  const f = newFrame(def, def.ctx);
  f.nargin = args.length; f.nargout = nout;
  if (def.parent) {
    const pf = parentFrame || findParentFrame(def, callerFrame);
    f.parentFrame = pf;
    if (def.shared && pf) {
      for (const sh of def.shared) {
        let g = pf; while (g && g.fn !== sh.def) g = g.parentFrame;
        if (!g) continue;
        const gv = g.vars, nm = sh.name;
        Object.defineProperty(f.vars, nm, { get() { return gv[nm]; }, set(v) { gv[nm] = v; }, enumerable: true, configurable: true });
      }
    }
  }
  const nb = Math.min(args.length, nfixed);
  for (let i = 0; i < nb; i++) { const p = def.params[i]; if (p !== '~') setVar(f, p, args[i]); }
  if (def.hasVarargin) { const rest = args.slice(nfixed); setVar(f, 'varargin', mkCellRow(rest)); }
  const saveFrame = ST.frame, saveFile = ST.file, saveLine = ST.line;
  ST.frame = f; ST.file = def.ctx.file; ST.depth++;
  let outs;
  try {
    def.body(f);
    outs = [];
    const want = Math.max(nout, 1);
    for (let i = 0; i < nouts && outs.length < want; i++) {
      const o = def.outs[i];
      if (def.hasVarargout && i === nouts - 1) {
        const vo = f.vars.varargout;
        if (vo !== undefined) { if (!(vo instanceof MCell)) err('varargout 必须为元胞数组。'); for (const x of vo.data) { if (outs.length >= want) break; outs.push(x); } }
        if (outs.length < nout) err("输出参数太多（varargout 只提供了 " + (vo ? vo.data.length : 0) + ' 个值）。', 'MATLAB:TooManyOutputs');
        break;
      }
      const v = f.vars[o];
      if (v === undefined) {
        if (i < nout || (i === 0 && nout > 0)) err("在调用 '" + def.name + "' 期间，未对输出参数 '" + o + "'（可能还有其他参数）赋值。", 'MATLAB:unassignedOutputs');
        break;
      }
      outs.push(v);
    }
  } finally { ST.depth--; }
  ST.frame = saveFrame; ST.file = saveFile; ST.line = saveLine;
  return outs;
}
function callHandle(h, args, nout) {
  if (h.kind === 'anon') {
    const np = h.params.length;
    const varg = np > 0 && h.params[np - 1] === 'varargin';
    if (args.length > np && !varg) err('输入参数太多（匿名函数 ' + h.src + ' 只接受 ' + np + ' 个输入）。', 'MATLAB:TooManyInputs');
    if (ST.depth >= ST.maxDepth) err('超出最大递归深度（' + ST.maxDepth + '）。', 'MATLAB:recursionLimit');
    const f = newFrame(h.fnDef || null, h.ctx);
    f.parentFrame = h.parentFrame; f.anon = true;
    const cap = h.cap; for (const k in cap) f.vars[k] = cap[k];
    const nfix = varg ? np - 1 : np;
    for (let i = 0; i < nfix && i < args.length; i++) if (h.params[i] !== '~') f.vars[h.params[i]] = markShared(args[i]);
    if (varg) f.vars.varargin = mkCellRow(args.slice(nfix));
    f.nargin = args.length; f.nargout = nout;
    const saveFrame = ST.frame; ST.frame = f; ST.depth++;
    let r;
    try { r = h.body(f, nout); } finally { ST.depth--; }
    ST.frame = saveFrame;
    return r;
  }
  // named
  const f0 = { vars: Object.create(null), fn: h.fnDef || null, ctx: h.ctx, parentFrame: h.parentFrame, toks: Object.create(null) };
  const r = resolveFn(f0, h.name);
  if (!r) undefinedErr(h.name);
  return invoke(r, h.parentFrame || ST.frame, h.name, args, nout, r.kind === 'user' && r.def.parent ? findParentFrame(r.def, h.parentFrame) : undefined);
}
// call a function value (handle or name string) - used by builtins
function callFn(fv, args, nout) {
  if (nout === undefined) nout = 1;
  if (fv instanceof FHandle) return callHandle(fv, args, nout);
  if (isStringy(fv)) { const name = toStr(fv); return callNamed(ST.frame, name, args, nout); }
  err('参数必须为函数句柄或函数名称。', 'MATLAB:invalidFunctionHandle');
}
function callFn1(fv, args) { const r = callFn(fv, args, 1); if (!r.length) err('函数没有返回值。'); return r[0]; }
function fnScalar(fv) { // returns JS function x(number)->number
  return (x) => { const r = callFn1(fv, [x]); return toNum(r, '函数返回值'); };
}
