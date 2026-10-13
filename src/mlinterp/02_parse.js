
// ======================================================================
// Lexer
// ======================================================================
const KEYWORDS = new Set(['if', 'elseif', 'else', 'end', 'for', 'parfor', 'while', 'switch', 'case', 'otherwise', 'try', 'catch',
  'function', 'return', 'break', 'continue', 'global', 'persistent', 'do', 'until']);
const END_ALIASES = new Set(['endif', 'endfor', 'endwhile', 'endfunction', 'endswitch', 'end_try_catch', 'endparfor']);
const BLOCK_OPENERS = new Set(['if', 'for', 'parfor', 'while', 'switch', 'try', 'function']);
function perr(msg, line) { throw new MLError('语法错误：' + msg, 'MATLAB:parse', line, ST ? ST.parseFile : ''); }

function preprocess(src) {
  src = src.replace(/\r\n?/g, '\n');
  const lines = src.split('\n'); let depth = 0;
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (t === '%{' || t === '#{') { depth++; lines[i] = ''; continue; }
    if (depth > 0) { if (t === '%}' || t === '#}') depth--; lines[i] = ''; }
  }
  return lines.join('\n');
}

function collectAssigned(src) {
  const set = new Set();
  const re1 = /(?:^|[\n;,])\s*([A-Za-z]\w*)\s*(?:\([^\n=]*\)|\{[^\n=]*\}|\.[\w.]*)?\s*=(?!=)/g; let m;
  while ((m = re1.exec(src))) set.add(m[1]);
  const re2 = /\[([^\]\n]*)\]\s*=(?!=)/g;
  while ((m = re2.exec(src))) for (const w of m[1].split(/[\s,]+/)) if (/^[A-Za-z]\w*$/.test(w)) set.add(w);
  const re3 = /\bfor\s*\(?\s*([A-Za-z]\w*)\s*=/g;
  while ((m = re3.exec(src))) set.add(m[1]);
  const re4 = /\bfunction\b([^\n]*)/g;
  while ((m = re4.exec(src))) { const ws = m[1].match(/[A-Za-z]\w*/g) || []; for (const w of ws) set.add(w); }
  const re5 = /\b(global|persistent)\b([^\n;]*)/g;
  while ((m = re5.exec(src))) { const ws = m[2].match(/[A-Za-z]\w*/g) || []; for (const w of ws) set.add(w); }
  return set;
}

function lex(src) {
  src = preprocess(src);
  const assigned = collectAssigned(src);
  const toks = []; let i = 0, line = 1; const n = src.length;
  const stack = []; // '[', '{' (literal), '(', 'i{' (index brace), 'a(' (anon params)
  let noCommaNext = false;
  const top = () => stack.length ? stack[stack.length - 1] : '';
  const inLiteral = () => { const t = top(); return t === '[' || t === '{'; };
  const inIndex = () => { for (let k = stack.length - 1; k >= 0; k--) { const s = stack[k]; if (s === '(' || s === 'i{') return true; } return false; };
  const push = (t, v, extra) => { const tk = { t, v, line, sp: spaceBefore }; if (extra) Object.assign(tk, extra); toks.push(tk); spaceBefore = false; return tk; };
  let spaceBefore = false;
  const prevTok = () => toks.length ? toks[toks.length - 1] : null;
  const valueEnd = tk => tk && (tk.t === 'num' || tk.t === 'str' || tk.t === 'dstr' || tk.t === 'id' || tk.t === 'endv' ||
    (tk.t === 'op' && (tk.v === ')' || tk.v === ']' || tk.v === '}' || tk.v === "'" || tk.v === ".'")));
  const atStmtStart = () => { const p = prevTok(); return !p || p.t === 'nl' || (p.t === 'op' && (p.v === ';' || p.v === ',') && stack.length === 0) || (p.t === 'kw' && (p.v === 'else' || p.v === 'try' || p.v === 'otherwise' || p.v === 'do')); };
  const isIdStart = c => (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c === '_';
  const isIdChar = c => isIdStart(c) || (c >= '0' && c <= '9');
  const isDigit = c => c >= '0' && c <= '9';
  let blockCount = 0, endCount = 0, funcCount = 0;

  function maybeInsertComma() {
    if (!inLiteral() || !spaceBefore) return;
    const p = prevTok(); if (!valueEnd(p)) return;
    if (noCommaNext) return;
    const c = src[i], c2 = src[i + 1];
    let starts = false;
    if (isIdStart(c) || isDigit(c) || c === '"' || c === "'" || c === '(' || c === '[' || c === '{' || c === '@') starts = true;
    else if (c === '.' && isDigit(c2)) starts = true;
    else if ((c === '~' || c === '!') && c2 !== '=') starts = true;
    else if ((c === '+' || c === '-') && c2 !== ' ' && c2 !== '\t' && c2 !== '=' && c2 !== '\n' && !(c === '+' && c2 === '+') && !(c === '-' && c2 === '-')) starts = true;
    if (starts) { const sp = spaceBefore; push('op', ',', { synth: true }); spaceBefore = sp; }
  }

  while (i < n) {
    const c = src[i];
    if (c === ' ' || c === '\t') { i++; spaceBefore = true; continue; }
    if (c === '.' && src[i + 1] === '.' && src[i + 2] === '.') { // continuation
      while (i < n && src[i] !== '\n') i++;
      i++; line++; spaceBefore = true; continue;
    }
    if (c === '%' || (c === '#' && !inLiteral())) { while (i < n && src[i] !== '\n') i++; continue; }
    if (c === '\n') {
      if (inLiteral()) { const p = prevTok(); if (!(p && p.t === 'op' && (p.v === ';' || p.v === '[' || p.v === '{'))) push('op', ';', { synth: true }); }
      else if (stack.length === 0) push('nl', '\n');
      i++; line++; spaceBefore = true; noCommaNext = false; continue;
    }
    maybeInsertComma(); noCommaNext = false;
    // numbers
    if (isDigit(c) || (c === '.' && isDigit(src[i + 1]))) {
      let j = i;
      if (c === '0' && (src[i + 1] === 'x' || src[i + 1] === 'X') && /[0-9a-fA-F]/.test(src[i + 2] || '')) {
        j = i + 2; while (j < n && /[0-9a-fA-F]/.test(src[j])) j++;
        push('num', parseInt(src.slice(i + 2, j), 16)); i = j; continue;
      }
      while (j < n && isDigit(src[j])) j++;
      if (src[j] === '.' && !(src[j + 1] === '*' || src[j + 1] === '/' || src[j + 1] === '\\' || src[j + 1] === '^' || src[j + 1] === "'" || (src[j + 1] === '.' && src[j + 2] === '.'))) {
        j++; while (j < n && isDigit(src[j])) j++;
      }
      if ((src[j] === 'e' || src[j] === 'E' || src[j] === 'd' || src[j] === 'D') && (isDigit(src[j + 1]) || ((src[j + 1] === '+' || src[j + 1] === '-') && isDigit(src[j + 2])))) {
        j += 2; while (j < n && isDigit(src[j])) j++;
      }
      const v = parseFloat(src.slice(i, j).replace(/[dD]/, 'e'));
      let imag = false;
      if ((src[j] === 'i' || src[j] === 'j' || src[j] === 'I' || src[j] === 'J') && !isIdChar(src[j + 1] || ' ')) { imag = true; j++; }
      push('num', v, imag ? { imag: true } : null); i = j; continue;
    }
    // identifiers / keywords
    if (isIdStart(c)) {
      let j = i; while (j < n && isIdChar(src[j])) j++;
      let w = src.slice(i, j);
      if (END_ALIASES.has(w)) w = 'end';
      if (w === 'end' && inIndex()) { push('endv', 'end'); i = j; continue; }
      if (KEYWORDS.has(w) && !(stack.length && w !== 'end')) {
        if (BLOCK_OPENERS.has(w)) blockCount++;
        if (w === 'function') funcCount++;
        if (w === 'end') endCount++;
        push('kw', w); i = j;
        continue;
      }
      // command syntax
      if (stack.length === 0 && atStmtStart() && !assigned.has(w) && (src[j] === ' ' || src[j] === '\t')) {
        let k = j; while (src[k] === ' ' || src[k] === '\t') k++;
        const d = src[k] || '';
        const d2 = src[k + 1] || '';
        let isCmd = false;
        if (isIdStart(d) || isDigit(d) || d === "'" ) isCmd = true;
        if (d === '-' && isIdStart(d2)) isCmd = true;
        if (isCmd && isIdStart(d)) { // "a b = ..." or "x in" etc: check next word isn't followed by '=' or '('
          let m = k; while (isIdChar(src[m] || '')) m++;
          let q = m; while (src[q] === ' ' || src[q] === '\t') q++;
          if (src[q] === '=' && src[q + 1] !== '=') isCmd = false;
          if (src[q] === '(' && m === q) isCmd = isCmd; // e.g. "hold on(" unlikely
        }
        if (isCmd) {
          // read args up to ; , newline or %
          const args = []; let p = k;
          while (p < n && src[p] !== '\n' && src[p] !== ';' && src[p] !== ',' && src[p] !== '%') {
            if (src[p] === ' ' || src[p] === '\t') { p++; continue; }
            let a = '';
            if (src[p] === "'") { p++; while (p < n && src[p] !== '\n') { if (src[p] === "'") { if (src[p + 1] === "'") { a += "'"; p += 2; continue; } p++; break; } a += src[p++]; } }
            else { while (p < n && !/[\s;,%]/.test(src[p])) a += src[p++]; }
            args.push(a);
          }
          push('cmd', w, { args }); i = p; continue;
        }
      }
      push('id', w); i = j; continue;
    }
    // strings / transpose
    if (c === "'") {
      const p = prevTok();
      const isTranspose = valueEnd(p) && !(spaceBefore && inLiteral()) && !(p && p.t === 'kw');
      if (isTranspose) { push('op', "'"); i++; continue; }
      let j = i + 1, s = '';
      for (;;) {
        if (j >= n || src[j] === '\n') perr('字符向量未正确终止（缺少右单引号）。', line);
        if (src[j] === "'") { if (src[j + 1] === "'") { s += "'"; j += 2; continue; } break; }
        s += src[j++];
      }
      push('str', s); i = j + 1; continue;
    }
    if (c === '"') {
      let j = i + 1, s = '';
      for (;;) {
        if (j >= n || src[j] === '\n') perr('字符串未正确终止（缺少右双引号）。', line);
        if (src[j] === '"') { if (src[j + 1] === '"') { s += '"'; j += 2; continue; } break; }
        s += src[j++];
      }
      push('dstr', s); i = j + 1; continue;
    }
    // operators
    const three = src.substr(i, 3), two = src.substr(i, 2);
    if (two === '.^' || two === ".'" || two === '.*' || two === './' || two === '.\\' || two === '==' || two === '~=' || two === '!=' ||
        two === '<=' || two === '>=' || two === '&&' || two === '||') {
      push('op', two === '!=' ? '~=' : two); i += 2; continue;
    }
    if (c === '(') {
      const p = prevTok();
      stack.push(p && p.t === 'op' && p.v === '@' ? 'a(' : '(');
      push('op', '('); i++; continue;
    }
    if (c === '[') { stack.push('['); push('op', '['); i++; continue; }
    if (c === '{') {
      const p = prevTok();
      stack.push(valueEnd(p) && !spaceBefore ? 'i{' : (valueEnd(p) && !inLiteral() ? 'i{' : '{'));
      push('op', '{'); i++; continue;
    }
    if (c === ')' || c === ']' || c === '}') {
      // remove trailing synthetic separators before closing
      while (toks.length && toks[toks.length - 1].synth && (c !== ')')) toks.pop();
      const s = stack.pop();
      push('op', c); i++;
      if (s === 'a(') noCommaNext = true;
      continue;
    }
    if ('+-*/\\^<>&|~!=:,;.@'.indexOf(c) >= 0) { push('op', c === '!' ? '~' : c); i++; continue; }
    perr("无效字符 '" + c + "'。", line);
  }
  push('nl', '\n'); push('eof', null);
  return { toks, endStyle: endCount >= blockCount && funcCount > 0, blockCount, endCount, funcCount };
}

// ======================================================================
// Parser
// ======================================================================
function parseProgram(src, fileName) {
  if (ST) ST.parseFile = fileName;
  const L = lex(src);
  const toks = L.toks; let p = 0;
  const endStyle = L.endStyle;
  const peek = (k) => toks[p + (k || 0)];
  const next = () => toks[p++];
  const isOp = (v, k) => { const t = toks[p + (k || 0)]; return t.t === 'op' && t.v === v; };
  const isKw = (v) => { const t = toks[p]; return t.t === 'kw' && t.v === v; };
  const expectOp = (v, what) => { const t = next(); if (!(t.t === 'op' && t.v === v)) perr((what || ("应为 '" + v + "'")) + tokDesc(t), t.line); return t; };
  function tokDesc(t) { if (!t || t.t === 'eof') return '，但遇到了文件末尾。'; if (t.t === 'nl') return '，但遇到了行尾。'; return "，但遇到了 '" + (t.t === 'str' ? "'" + t.v + "'" : t.v) + "'。"; }
  const skipNl = () => { while (peek().t === 'nl' || (peek().t === 'op' && (peek().v === ';' || peek().v === ','))) p++; };

  function parseBlock(terms) { // statements until one of terms keywords (not consumed)
    const body = [];
    for (;;) {
      skipNl();
      const t = peek();
      if (t.t === 'eof') return body;
      if (t.t === 'kw' && terms.indexOf(t.v) >= 0) return body;
      if (t.t === 'kw' && t.v === 'function') return body;
      body.push(parseStatement());
    }
  }
  function endStmt(st) { // consume terminator, set display flag
    const t = peek();
    if (t.t === 'op' && t.v === ';') { p++; st.disp = false; if (peek().t === 'nl') p++; }
    else if (t.t === 'op' && t.v === ',') { p++; st.disp = true; }
    else if (t.t === 'nl') { p++; st.disp = true; }
    else if (t.t === 'eof') st.disp = true;
    else if (t.t === 'kw' && (t.v === 'end' || t.v === 'else' || t.v === 'elseif' || t.v === 'case' || t.v === 'otherwise' || t.v === 'catch' || t.v === 'until')) st.disp = true;
    else perr('此处应为运算符或语句结束' + tokDesc(t), t.line);
    return st;
  }
  function expectEnd(what, line) { const t = next(); if (!(t.t === 'kw' && t.v === 'end')) perr("'" + what + "'（第 " + line + " 行）缺少对应的 'end'。", t.line); }

  function parseStatement() {
    const t = peek(); const line = t.line;
    if (t.t === 'cmd') { p++; return endStmt({ type: 'Cmd', name: t.v, args: t.args, line }); }
    if (t.t === 'kw') {
      switch (t.v) {
        case 'if': {
          p++; const clauses = []; let cond = parseExpr(); let body = parseBlock(['elseif', 'else', 'end']);
          clauses.push({ cond, body }); let els = null;
          for (;;) {
            const k = peek();
            if (k.t === 'kw' && k.v === 'elseif') { p++; cond = parseExpr(); body = parseBlock(['elseif', 'else', 'end']); clauses.push({ cond, body }); continue; }
            if (k.t === 'kw' && k.v === 'else') { p++; els = parseBlock(['end']); }
            break;
          }
          expectEnd('if', line); return endStmt({ type: 'If', clauses, els, line });
        }
        case 'for': case 'parfor': {
          p++; let paren = false;
          if (isOp('(')) { paren = true; p++; }
          const vt = next(); if (vt.t !== 'id') perr('for 循环变量无效' + tokDesc(vt), vt.line);
          let lv = { type: 'Id', name: vt.v };
          expectOp('=', "for 语句中应为 '='");
          const e = parseExpr();
          if (paren) { if (isOp(',')) { p++; parseExpr(); } expectOp(')'); }
          const body = parseBlock(['end']); expectEnd('for', line);
          return endStmt({ type: 'For', v: lv.name, e, body, line });
        }
        case 'while': { p++; const cond = parseExpr(); const body = parseBlock(['end']); expectEnd('while', line); return endStmt({ type: 'While', cond, body, line }); }
        case 'do': { p++; const body = parseBlock(['until']); const u = next(); if (!(u.t === 'kw' && u.v === 'until')) perr("'do' 缺少 'until'。", u.line); const cond = parseExpr(); return endStmt({ type: 'DoUntil', cond, body, line }); }
        case 'switch': {
          p++; const e = parseExpr(); skipNl(); const cases = []; let other = null;
          for (;;) {
            skipNl(); const k = peek();
            if (k.t === 'kw' && k.v === 'case') { p++; const ce = parseExpr(); const body = parseBlock(['case', 'otherwise', 'end']); cases.push({ e: ce, body, line: k.line }); continue; }
            if (k.t === 'kw' && k.v === 'otherwise') { p++; other = parseBlock(['case', 'otherwise', 'end']); continue; }
            break;
          }
          expectEnd('switch', line); return endStmt({ type: 'Switch', e, cases, other, line });
        }
        case 'try': {
          p++; if (isOp(',')) p++;
          const body = parseBlock(['catch', 'end']); let id = null, cbody = [];
          if (isKw('catch')) {
            const ct = next();
            if (peek().t === 'id' && peek().line === ct.line && !(toks[p + 1].t === 'op' && (toks[p + 1].v === '=' || toks[p + 1].v === '(' || toks[p + 1].v === '.'))) { id = next().v; }
            cbody = parseBlock(['end']);
          }
          expectEnd('try', line); return endStmt({ type: 'Try', body, id, cbody, line });
        }
        case 'return': p++; return endStmt({ type: 'Return', line });
        case 'break': p++; return endStmt({ type: 'Break', line });
        case 'continue': p++; return endStmt({ type: 'Continue', line });
        case 'global': case 'persistent': {
          p++; const names = []; while (peek().t === 'id') names.push(next().v);
          return endStmt({ type: t.v === 'global' ? 'Global' : 'Persistent', names, line });
        }
        default: perr("意外的关键字 '" + t.v + "'。", line);
      }
    }
    // multi assignment [a,b] = ...
    if (t.t === 'op' && t.v === '[') {
      let d = 0, k = p;
      for (; k < toks.length; k++) { const q = toks[k]; if (q.t === 'op' && (q.v === '[' || q.v === '(' || q.v === '{')) d++; else if (q.t === 'op' && (q.v === ']' || q.v === ')' || q.v === '}')) { d--; if (d === 0) break; } else if (q.t === 'nl' || q.t === 'eof') break; }
      if (toks[k + 1] && toks[k + 1].t === 'op' && toks[k + 1].v === '=') {
        p++; const lhs = [];
        while (!isOp(']')) {
          if (isOp(',')) { p++; continue; }
          if (isOp('~') && (isOp(',', 1) || isOp(']', 1))) { p++; lhs.push(null); continue; }
          const e = parsePostfix(); lhs.push(toLvalue(e, line));
        }
        p++; expectOp('=');
        const rhs = parseExpr();
        return endStmt({ type: 'Multi', lhs, rhs, line });
      }
    }
    const e = parseExpr();
    if (isOp('=')) {
      p++; const lv = toLvalue(e, line); const rhs = parseExpr();
      return endStmt({ type: 'Assign', lhs: lv, rhs, line });
    }
    return endStmt({ type: 'Expr', e, line });
  }
  function toLvalue(e, line) {
    const acc = [];
    let cur = e;
    while (cur.type === 'Index' || cur.type === 'Field' || cur.type === 'DynField') {
      if (cur.type === 'Index') acc.unshift({ k: cur.brace ? 'brace' : 'paren', args: cur.args });
      else if (cur.type === 'Field') acc.unshift({ k: 'field', name: cur.name });
      else acc.unshift({ k: 'dfield', e: cur.e });
      cur = cur.base;
    }
    if (cur.type !== 'Id') perr('赋值语句左侧无效。', line);
    return { name: cur.name, acc };
  }

  // ---- expressions ----
  function parseExpr() { return parseOrOr(); }
  function bin(op, a, b) { return { type: 'Bin', op, a, b }; }
  function parseOrOr() { let a = parseAndAnd(); while (isOp('||')) { p++; a = { type: 'OrOr', a, b: parseAndAnd() }; } return a; }
  function parseAndAnd() { let a = parseOr(); while (isOp('&&')) { p++; a = { type: 'AndAnd', a, b: parseOr() }; } return a; }
  function parseOr() { let a = parseAnd(); while (isOp('|')) { p++; a = bin('|', a, parseAnd()); } return a; }
  function parseAnd() { let a = parseCmp(); while (isOp('&')) { p++; a = bin('&', a, parseCmp()); } return a; }
  function parseCmp() {
    let a = parseRange();
    for (;;) { const t = peek(); if (t.t === 'op' && (t.v === '<' || t.v === '>' || t.v === '<=' || t.v === '>=' || t.v === '==' || t.v === '~=')) { p++; a = bin(t.v, a, parseRange()); } else return a; }
  }
  function parseRange() {
    const a = parseAdd();
    if (isOp(':') && !(isOp(')', 1) || isOp(',', 1))) {
      p++; const b = parseAdd();
      if (isOp(':') && !(isOp(')', 1) || isOp(',', 1))) { p++; const c = parseAdd(); return { type: 'Range', a, step: b, b: c }; }
      return { type: 'Range', a, step: null, b };
    }
    return a;
  }
  function parseAdd() {
    let a = parseMul();
    for (;;) { const t = peek(); if (t.t === 'op' && (t.v === '+' || t.v === '-') && !(t.synth)) { p++; a = bin(t.v, a, parseMul()); } else return a; }
  }
  function parseMul() {
    let a = parseUnary();
    for (;;) { const t = peek(); if (t.t === 'op' && (t.v === '*' || t.v === '/' || t.v === '\\' || t.v === '.*' || t.v === './' || t.v === '.\\')) { p++; a = bin(t.v, a, parseUnary()); } else return a; }
  }
  function parseUnary() {
    const t = peek();
    if (t.t === 'op' && (t.v === '-' || t.v === '+' || t.v === '~')) {
      p++; const a = parseUnary();
      if (t.v === '-' && a.type === 'Num') return { type: 'Num', v: -a.v, imag: a.imag };
      return { type: 'Un', op: t.v, a };
    }
    return parsePower();
  }
  function parsePower() {
    let a = parsePostfix();
    for (;;) {
      const t = peek();
      if (t.t === 'op' && (t.v === '^' || t.v === '.^')) {
        p++;
        let b;
        const u = peek();
        if (u.t === 'op' && (u.v === '-' || u.v === '+' || u.v === '~')) { p++; const x = parsePowOperand(); b = { type: 'Un', op: u.v, a: x }; }
        else b = parsePostfix();
        a = bin(t.v, a, b);
      } else return a;
    }
  }
  function parsePowOperand() { const u = peek(); if (u.t === 'op' && (u.v === '-' || u.v === '+' || u.v === '~')) { p++; return { type: 'Un', op: u.v, a: parsePowOperand() }; } return parsePostfix(); }
  function parseArgs(close) {
    const args = [];
    if (isOp(close)) { p++; return args; }
    for (;;) {
      if (isOp(':') && (isOp(close, 1) || isOp(',', 1))) { p++; args.push({ type: 'Colon' }); }
      else args.push(parseExpr());
      if (isOp(',')) { p++; continue; }
      if (isOp(close)) { p++; return args; }
      if (close === '}' && isOp(';')) perr("索引中不允许使用 ';'", peek().line);
      perr("应为 ',' 或 '" + close + "'" + tokDesc(peek()), peek().line);
    }
  }
  function parsePostfix() {
    let e = parsePrimary();
    for (;;) {
      const t = peek();
      if (t.t !== 'op') return e;
      if (t.v === '(' && !(t.sp && inMatrix > 0)) { p++; e = { type: 'Index', base: e, args: parseArgs(')'), brace: false }; continue; }
      if (t.v === '{' && !(t.sp && inMatrix > 0)) { p++; e = { type: 'Index', base: e, args: parseArgs('}'), brace: true }; continue; }
      if (t.v === '.' && !t.sp) {
        const u = peek(1);
        if (u.t === 'id' || u.t === 'kw' || u.t === 'cmd') { p += 2; e = { type: 'Field', base: e, name: u.v }; continue; }
        if (u.t === 'op' && u.v === '(') { p += 2; const fe = parseExpr(); expectOp(')'); e = { type: 'DynField', base: e, e: fe }; continue; }
        return e;
      }
      if (t.v === "'" || t.v === ".'") { p++; e = { type: 'Post', op: t.v, a: e }; continue; }
      return e;
    }
  }
  let inMatrix = 0;
  function parseMatrix(close) { // after '[' or '{'
    const rows = []; let row = [];
    inMatrix++;
    for (;;) {
      const t = peek();
      if (t.t === 'op' && t.v === close) { p++; break; }
      if (t.t === 'eof') perr("缺少 '" + close + "'。", t.line);
      if (t.t === 'op' && t.v === ';') { p++; if (row.length) rows.push(row); row = []; continue; }
      if (t.t === 'nl') { p++; if (row.length) rows.push(row); row = []; continue; }
      if (t.t === 'op' && t.v === ',') { p++; continue; }
      const saved = inMatrix; inMatrix = saved;
      row.push(parseExpr());
      const q = peek();
      if (!(q.t === 'op' && (q.v === ',' || q.v === ';' || q.v === close)) && q.t !== 'nl') perr("矩阵或元胞中应为 ',' 或 ';'" + tokDesc(q), q.line);
    }
    inMatrix--;
    if (row.length) rows.push(row);
    return rows;
  }
  function parsePrimary() {
    const t = next();
    switch (t.t) {
      case 'num': return { type: 'Num', v: t.v, imag: !!t.imag };
      case 'str': return { type: 'Str', v: t.v };
      case 'dstr': return { type: 'DStr', v: t.v };
      case 'id': return { type: 'Id', name: t.v, line: t.line };
      case 'endv': return { type: 'End' };
      case 'cmd': { // identifier misdetected as command inside expression: re-lex not possible; treat as id
        perr("无法解析 '" + t.v + "' 后的内容。", t.line);
      }
      case 'op':
        if (t.v === '(') { const save = inMatrix; inMatrix = 0; const e = parseExpr(); inMatrix = save; expectOp(')'); return { type: 'Paren', e }; }
        if (t.v === '[') return { type: 'Matrix', rows: parseMatrix(']') };
        if (t.v === '{') return { type: 'CellLit', rows: parseMatrix('}') };
        if (t.v === '@') {
          if (isOp('(')) {
            p++; const params = [];
            while (!isOp(')')) { const q = next(); if (q.t === 'id') params.push(q.v); else if (q.t === 'op' && q.v === '~') params.push('~'); else if (q.t === 'op' && q.v === ',') continue; else perr('匿名函数参数列表无效' + tokDesc(q), q.line); }
            p++;
            const save = inMatrix; inMatrix = 0; const body = parseExpr(); inMatrix = save;
            return { type: 'Anon', params, body };
          }
          const q = next(); if (q.t !== 'id') perr("'@' 后应为函数名或参数列表" + tokDesc(q), q.line);
          let name = q.v; while (isOp('.') && peek(1).t === 'id') { p++; name += '.' + next().v; }
          return { type: 'FuncRef', name };
        }
        if (t.v === ':') return { type: 'Colon' };
      // fallthrough
      default:
        perr('表达式无效' + tokDesc(t).replace(/^，/, '：'), t.line);
    }
  }

  // ---- functions ----
  function parseFunction(parentName) {
    const ft = next(); // 'function'
    const line = ft.line;
    let outs = [], name, params = [];
    // forms: function name, function name(args), function o = name(...), function [o1,o2] = name(...)
    if (isOp('[')) {
      p++; while (!isOp(']')) { const q = next(); if (q.t === 'id') outs.push(q.v); else if (q.t === 'op' && q.v === ',') continue; else perr('函数输出参数列表无效' + tokDesc(q), q.line); }
      p++; expectOp('='); name = next().v;
    } else {
      const q = next(); if (q.t !== 'id' && q.t !== 'cmd') perr('函数名无效' + tokDesc(q), q.line);
      if (q.t === 'cmd') { name = q.v; } // "function foo" parsed as command: no args
      else if (isOp('=')) { p++; outs = [q.v]; name = next().v; }
      else name = q.v;
    }
    while (isOp('.') && peek(1).t === 'id') { p++; name += '.' + next().v; }
    if (isOp('(')) {
      p++; while (!isOp(')')) { const q = next(); if (q.t === 'id') params.push(q.v); else if (q.t === 'op' && q.v === '~') params.push('~'); else if (q.t === 'op' && q.v === ',') continue; else perr('函数参数列表无效' + tokDesc(q), q.line); }
      p++;
    }
    const fn = { name, params, outs, line, nested: [], body: null };
    const body = [];
    for (;;) {
      skipNl();
      const k = peek();
      if (k.t === 'eof') break;
      if (k.t === 'kw' && k.v === 'function') {
        if (endStyle) { fn.nested.push(parseFunction(name)); continue; }
        break;
      }
      if (k.t === 'kw' && k.v === 'end') { if (endStyle) { p++; break; } perr("意外的 'end'。", k.line); }
      body.push(parseStatement());
    }
    fn.body = body;
    return fn;
  }

  const script = []; const funcs = [];
  for (;;) {
    skipNl();
    const t = peek();
    if (t.t === 'eof') break;
    if (t.t === 'kw' && t.v === 'function') { funcs.push(parseFunction(null)); continue; }
    if (funcs.length) perr('函数定义之后不能再有脚本语句。', t.line);
    if (t.t === 'kw' && t.v === 'end') perr("意外的 'end'（没有与之对应的 if/for/while 等语句）。", t.line);
    script.push(parseStatement());
  }
  return { script, funcs, isFunctionFile: script.length === 0 && funcs.length > 0 };
}
