// Test suite for mlinterp.js — run with: node tests.js
'use strict';
const M = require('../../mlinterp.js');

function run(src, opts) {
  let out = '', errOut = ''; const figs = [];
  const res = M.run(src, Object.assign({ onStdout: s => (out += s), onStderr: s => (errOut += s), onFigure: f => figs.push(f) }, opts || {}));
  return { out, errOut, figs, res };
}
const tests = [];
function T(name, src, expect, opts) { tests.push({ name, src, expect, opts }); }
const near = (a, b, tol) => Math.abs(a - b) <= (tol || 1e-9);
const nums = s => s.trim().split(/\s+/).map(Number);

// ---------------- display formatting ----------------
T('display integer scalar', 'x = 5', 'x =\n\n     5\n\n');
T('display negative int', 'x = -4', 'x =\n\n    -4\n\n');
T('display non-integer scalar', 'y = pi', 'y =\n\n    3.1416\n\n');
T('display negative decimal', 'y = -0.5', 'y =\n\n   -0.5000\n\n');
T('display large scalar exp', 'z = 12345.678', 'z =\n\n   1.2346e+04\n\n');
T('display small scalar exp', 'z = 0.00012', 'z =\n\n   1.2000e-04\n\n');
T('display int matrix', 'A = [1 2; 3 4]', 'A =\n\n     1     2\n     3     4\n\n');
T('display decimal row', 'w = [1.5 2.25]', 'w =\n\n    1.5000    2.2500\n\n');
T('display matrix with zero', 'D = [1.5 0; 0 2]', 'D =\n\n    1.5000         0\n         0    2.0000\n\n');
T('display scale factor', 'v = [1000.5 2]', 'v =\n\n   1.0e+03 *\n\n    1.0005    0.0020\n\n');
T('display NaN Inf', 'e = [1 NaN Inf]', 'e =\n\n     1   NaN   Inf\n\n');
T('display empty', 'e = []', 'e =\n\n     []\n\n');
T('display empty row', 'e = 1:0', 'e =\n\n  1×0 empty double row vector\n\n');
T('display logical scalar', 't = true', 't =\n\n  logical\n\n   1\n\n');
T('display logical array', 't = [1 2 3] > 1', 't =\n\n  1×3 logical array\n\n   0   1   1\n\n');
T('display char', "s = 'hello'", "s =\n\n    'hello'\n\n");
T('display char matrix', "s = ['ab';'cd']", "s =\n\n  2×2 char array\n\n    'ab'\n    'cd'\n\n");
T('display string', 's = "hi"', 's = \n\n    "hi"\n\n');
T('display cell', "c = {1, 'abc', [1 2 3]}", "c =\n\n  1×3 cell array\n\n    {[1]}    {'abc'}    {[1 2 3]}\n\n");
T('display struct', "s.a = 1; s.name = 'Bob'; s", "s = \n\n  struct with fields:\n\n       a: 1\n    name: 'Bob'\n\n");
T('display struct array', "s = struct('a', {1,2}); s", "s = \n\n  1×2 struct array with fields:\n\n    a\n\n");
T('display int8', 'x = int8(5)', 'x =\n\n  int8\n\n   5\n\n');
T('display int saturation', 'x = int8(200)', 'x =\n\n  int8\n\n   127\n\n');
T('display complex', 'z = 3 + 4i', 'z =\n\n   3.0000 + 4.0000i\n\n');
T('display function handle', 'f = @(x) x.^2 + 1', 'f =\n\n  function_handle with value:\n\n    @(x)x.^2+1\n\n');
T('display ans', '3 + 4', 'ans =\n\n     7\n\n');
T('semicolon suppresses', 'x = 5;', '');
T('comma shows', 'a = 1, b = 2;', 'a =\n\n     1\n\n');
T('format long', 'format long\nx = pi', 'x =\n\n   3.141592653589793\n\n');
T('disp scalar', 'disp(5)', '     5\n');
T('disp matrix', 'disp([1 2; 3 4])', '     1     2\n     3     4\n');
T('disp string', "disp('hello world')", 'hello world\n');
T('display 3-D', 'q = zeros(1,2,2); q(:,:,2) = [1 2]; q', 'q(:,:,1) =\n\n     0     0\n\nq(:,:,2) =\n\n     1     2\n\n');
T('display large int', 'x = 2026', 'x =\n\n        2026\n\n');

// ---------------- indexing / end / logical ----------------
T('linear index', 'v = [10 20 30]; disp(v(2))', '    20\n');
T('end index', 'v = 1:10; disp(v(end))', '    10\n');
T('end arithmetic', 'v = 1:10; disp(v(end-2:end))', '     8     9    10\n');
T('2D index', 'A = magic(3); disp(A(2,3))', '     7\n');
T('colon column', 'A = [1 2; 3 4]; disp(A(:,2))', '     2\n     4\n');
T('colon all', 'A = [1 2; 3 4]; disp(A(:)\')', '     1     3     2     4\n');
T('logical indexing', 'v = [5 -1 3 -7]; disp(v(v > 0))', '     5     3\n');
T('logical assign', 'v = [5 -1 3 -7]; v(v < 0) = 0; disp(v)', '     5     0     3     0\n');
T('find', 'disp(find([0 1 0 1 1]))', '     2     4     5\n');
T('find n', 'disp(find([0 1 0 1 1], 2))', '     2     4\n');
T('deletion', 'v = 1:5; v([2 4]) = []; disp(v)', '     1     3     5\n');
T('row deletion', 'A = magic(3); A(2,:) = []; disp(size(A))', '     2     3\n');
T('auto grow', 'x(3) = 7; disp(x)', '     0     0     7\n');
T('grow matrix', 'A = [1 2]; A(2,3) = 9; disp(A)', '     1     2     0\n     0     0     9\n');
T('end+1 append', 'x = []; for k=1:4, x(end+1) = k^2; end; disp(x)', '     1     4     9    16\n');
T('index out of bounds error', 'v = [1 2 3]; y = v(5);', r => !r.res.ok && /索引超出/.test(r.res.error.message) && r.res.error.line === 1);
T('zero index error', 'v = [1 2 3]; y = v(0);', r => !r.res.ok && /正整数/.test(r.res.error.message));
T('nested struct cell index', "s.a = {1, [5 6 7]}; disp(s.a{2}(3))", '     7\n');
T('nested assign', "s.a{2}(3).b = 5; disp(s.a{2}(3).b); disp(size(s.a{2}))", '     5\n     1     3\n');
T('copy semantics', 'a = [1 2 3]; b = a; b(1) = 99; disp(a(1))', '     1\n');
T('copy semantics cell', 'x = [1 2]; c = {x}; x(1) = 9; disp(c{1})', '     1     2\n');
T('copy semantics function arg', 'a = [1 2 3]; f(a); disp(a)\nfunction f(v)\n v(1) = 100;\nend', '     1     2     3\n');

// ---------------- operators / broadcasting ----------------
T('broadcast row+col', 'disp([1 2 3] + [10; 20])', '    11    12    13\n    21    22    23\n');
T('elementwise ops', 'a = [1 2 3]; disp(a .* a); disp(a ./ 2); disp(a .^ 2)', '     1     4     9\n    0.5000    1.0000    1.5000\n     1     4     9\n');
T('matrix multiply', 'disp([1 2; 3 4] * [5; 6])', '    17\n    39\n');
T('precedence unary minus power', 'disp(-2^2)', '    -4\n');
T('power negative exponent', 'disp(2^-1)', '    0.5000\n');
T('transpose', "disp([1 2 3]')", '     1\n     2\n     3\n');
T('conj transpose', "z = [1+2i]'; disp(imag(z))", '    -2\n');
T('comparison', 'disp(3 > 2 & 1 == 1)', '   1\n');
T('short circuit', 'x = []; if isempty(x) || x(1) > 0, disp("ok"), end', 'ok\n');
T('xor', 'disp(xor(true, false))', '   1\n');
T('not', 'disp(~[1 0 2])', '   0   1   0\n');
T('range step', 'disp(10:-3:1)', '    10     7     4     1\n');
T('integer arithmetic', 'x = uint8(250) + 10; disp(x); disp(class(x))', '  255\nuint8\n');
T('int rounding', 'disp(int32(7) / 2)', '  4\n');
T('mixed int error', 'x = int8(1) + int16(1);', r => !r.res.ok && /整数/.test(r.res.error.message));
T('dimension mismatch error', 'x = [1 2 3] + [1 2];', r => !r.res.ok && /大小不兼容/.test(r.res.error.message));
T('innerdim error', 'C = ones(2,3) * ones(2,2);', r => !r.res.ok && /矩阵乘法/.test(r.res.error.message));
T('complex sqrt', 'z = sqrt(-4); disp(imag(z))', '     2\n');
T('complex arithmetic', 'z = (1+2i)*(3-1i); fprintf("%g %g\\n", real(z), imag(z))', '5 5\n');
T('abs angle', 'z = 3+4i; fprintf("%g %.4f\\n", abs(z), angle(1i))', '5 1.5708\n');

// ---------------- strings ----------------
T('sprintf basic', 'disp(sprintf("%5.2f|%d|%s", pi, 42, "abc"))', ' 3.14|42|abc\n');
T('sprintf recycling', 'fprintf("%d-%d\\n", [1 2 3 4])', '1-2\n3-4\n');
T('sprintf partial', 's = sprintf("%d and %d", 1); disp(s)', '1 and \n');
T('sprintf flags', 'disp(sprintf("[%-5d][%05.1f][%+d][%x][%e]", 7, 3.14159, 5, 255, 1234.5))', '[7    ][003.1][+5][ff][1.234500e+03]\n');
T('sprintf %g', 'disp(sprintf("%g %g %g", 0.0001, 1e10, 123.456))', '0.0001 1e+10 123.456\n');
T('sprintf non-integer %d', 'disp(sprintf("%d", 1.5))', '1.500000e+00\n');
T('fprintf matrix columns', 'fprintf("%d %d\\n", [1 2; 3 4])', '1 3\n2 4\n');
T('num2str', "disp(num2str(pi)); disp(num2str(42)); disp(num2str([1 2 3]))", '3.1416\n42\n1  2  3\n');
T('num2str precision', 'disp(num2str(pi, 8))', '3.1415927\n');
T('mat2str', 'disp(mat2str([1 2; 3 4.5]))', '[1 2;3 4.5]\n');
T('str2double', 'x = str2double("3.5") * 2; disp(x)', '     7\n');
T('str2num', 'v = str2num("[1 2 3]"); disp(sum(v))', '     6\n');
T('strsplit strjoin', "c = strsplit('a,b,c', ','); disp(strjoin(c, '-'))", 'a-b-c\n');
T('strrep upper lower', "disp(upper(strrep('hello', 'l', 'L')))", 'HELLO\n');
T('strtrim', "disp(['[' strtrim('   x  ') ']'])", '[x]\n');
T('strcmp variants', "disp([strcmp('a','a') strcmpi('A','a') strncmp('abc','abd',2)])", '   1   1   1\n');
T('strcmp cell', "disp(strcmp({'a','b','a'}, 'a'))", '   1   0   1\n');
T('strfind', "disp(strfind('abcabc', 'bc'))", '     2     5\n');
T('contains startsWith', "disp([contains('hello','ell') startsWith('hello','he') endsWith('hello','lo')])", '   1   1   1\n');
T('char concat', "s = ['abc', 'def']; disp(s); disp(length(s))", 'abcdef\n     6\n');
T('string concat', 's = "abc" + "def"; disp(s)', 'abcdef\n');
T('char arithmetic', "disp(double('A') + 1); disp(char(72))", '    66\nH\n');
T('regexp match', "m = regexp('abc123def45', '\\d+', 'match'); disp(m{2})", '45\n');
T('regexp tokens', "t = regexp('key=val', '(\\w+)=(\\w+)', 'tokens'); disp(t{1}{2})", 'val\n');
T('regexp names', "n = regexp('John 25', '(?<name>\\w+) (?<age>\\d+)', 'names'); disp(n.age)", '25\n');
T('regexp once', "s = regexp('a1b22', '\\d+', 'match', 'once'); disp(s)", '1\n');
T('regexp start', "disp(regexp('abcabc', 'b'))", '     2     5\n');
T('regexp split', "p = regexp('a1b2c', '\\d', 'split'); disp(strjoin(p, '|'))", 'a|b|c\n');
T('regexprep', "disp(regexprep('hello world', '(\\w+) (\\w+)', '$2 $1'))", 'world hello\n');
T('isspace isletter isdigit', "disp(isdigit('a1 ')); disp(isspace('a1 '))", '   0   1   0\n   0   0   1\n');
T('fliplr string', "disp(fliplr('abc'))", 'cba\n');
T('upper on string type', 'disp(class(upper("abc")))', 'string\n');
T('int2str blanks', "disp(['[' blanks(2) int2str(3.7) ']'])", '[  4]\n');

// ---------------- cells & structs ----------------
T('cell create index', "c = {1, 'two', [3 4]}; disp(class(c{2})); disp(c{3}(2))", 'char\n     4\n');
T('cell paren index', 'c = {1, 2, 3}; d = c(2:3); disp(class(d)); disp(numel(d))', 'cell\n     2\n');
T('cell brace assign grow', "c = {}; c{3} = 'x'; disp(size(c))", '     1     3\n');
T('cs-list expansion', 'c = {1, 2, 3}; disp([c{:}])', '     1     2     3\n');
T('cs-list function args', 'c = {2, 3}; disp(max(c{:}))', '     3\n');
T('cellfun uniform', "disp(cellfun(@numel, {'ab', 'cde', ''}))", '     2     3     0\n');
T('cellfun nonuniform', "r = cellfun(@(x) x*2, {1, 2}, 'UniformOutput', false); disp(r{2})", '     4\n');
T('cellfun isempty string name', "disp(cellfun('isempty', {[], 1, ''}))", '   1   0   1\n');
T('arrayfun', 'disp(arrayfun(@(x) x^2, [1 2 3]))', '     1     4     9\n');
T('struct basic', "s.name = 'Bob'; s.age = 30; disp(s.age); disp(isfield(s, 'name'))", '    30\n   1\n');
T('struct dynamic field', "s = struct(); f = 'dyn'; s.(f) = 5; disp(s.dyn)", '     5\n');
T('struct array', "s = struct('a', {1, 2, 3}); disp(size(s)); disp([s.a])", '     1     3\n     1     2     3\n');
T('struct array assign', "s(2).v = 5; disp(size(s)); disp(isempty(s(1).v))", '     1     2\n   1\n');
T('fieldnames rmfield', "s.a = 1; s.b = 2; s = rmfield(s, 'a'); f = fieldnames(s); disp(f{1})", 'b\n');
T('structfun', "s.a = 1; s.b = 2; disp(structfun(@(x) x*10, s)')", '    10    20\n');
T('struct2cell cell2struct', "c = struct2cell(struct('x', 1, 'y', 2)); disp(c{2})", '     2\n');
T('num2cell cell2mat', 'c = num2cell([1 2 3]); disp(cell2mat(c))', '     1     2     3\n');
T('iscellstr', "disp([iscellstr({'a','b'}) iscellstr({1})])", '   1   0\n');
T('containers.Map basic', "m = containers.Map(); m('one') = 1; m('two') = 2; disp(m('two')); disp(m.Count); disp(isKey(m, 'three'))", '     2\n     2\n   0\n');
T('containers.Map keys sorted', "m = containers.Map({'b','a'}, {2, 1}); k = keys(m); disp(k{1})", 'a\n');
T('containers.Map values remove', "m = containers.Map({'a','b'}, {10, 20}); remove(m, 'a'); v = values(m); disp(v{1}); disp(m.Count)", '    20\n     1\n');
T('containers.Map numeric keys', "m = containers.Map('KeyType', 'double', 'ValueType', 'any'); m(3) = 'three'; disp(m(3))", 'three\n');
T('containers.Map missing key error', "m = containers.Map(); x = m('nope');", r => !r.res.ok && /不存在/.test(r.res.error.message));

// ---------------- control flow ----------------
T('if elseif else', 'x = 5; if x > 10, disp("big"), elseif x > 3, disp("mid"), else, disp("small"), end', 'mid\n');
T('for over matrix columns', 'for c = [1 2; 3 4], disp(c\'), end', '     1     3\n     2     4\n');
T('for over cell', "for c = {'a', 'b'}, disp(class(c)), end", 'cell\ncell\n');
T('while break continue', 'k = 0; s = 0; while true, k = k + 1; if k > 10, break; end; if mod(k,2), continue; end; s = s + k; end; disp(s)', '    30\n');
T('switch numeric', 'switch 3, case 1, disp("one"), case {2, 3}, disp("two or three"), otherwise, disp("other"), end', 'two or three\n');
T('switch string', "switch 'abc', case 'x', disp(1), case 'abc', disp(2), end", '     2\n');
T('try catch message', "try, error('my:id', 'Bad value %d', 7); catch err, disp(err.message); disp(err.identifier); end", 'Bad value 7\nmy:id\n');
T('try catch builtin error', 'try, x = [1 2](3); catch e, disp(class(e)); end', 'MException\n');
T('rethrow', "try, try, error('a:b', 'inner'); catch e, rethrow(e); end, catch e2, disp(e2.message), end", 'inner\n');
T('MException throw', "try, ME = MException('x:y', 'msg %d', 3); throw(ME); catch e, disp(e.message), end", 'msg 3\n');
T('error line number', 'x = 1;\ny = 2;\nerror("boom");', r => !r.res.ok && r.res.error.line === 3 && r.res.error.message === '错误：boom');
T('undefined variable error', 'a = 1;\nb = a + zz;', r => !r.res.ok && r.res.error.message === "错误：未定义函数或变量 'zz'。" && r.res.error.line === 2);
T('do until (Octave)', 'k = 0; do k = k + 1; until k >= 3\ndisp(k)', '     3\n');
T('warning to stderr', "warning('careful'); disp(1)", r => r.res.ok && /警告: careful/.test(r.errOut) && r.out === '     1\n');
T('maxSteps infinite loop', 'while true, end', r => !r.res.ok && /步数/.test(r.res.error.message), { maxSteps: 1e5 });
T('syntax error reported', 'x = [1 2', r => !r.res.ok && /语法错误/.test(r.res.error.message));

// ---------------- functions ----------------
T('local function', 'disp(sq(4))\nfunction y = sq(x)\n  y = x^2;\nend', '    16\n');
T('multiple returns', '[s, p] = sp([1 2 3 4]); disp([s p])\nfunction [s, p] = sp(v)\n s = sum(v); p = prod(v);\nend', '    10    24\n');
T('nargin default', 'disp(f(1)); disp(f(1, 2))\nfunction r = f(a, b)\n if nargin < 2, b = 10; end\n r = a + b;\nend', '    11\n     3\n');
T('varargin', 'disp(f(1, 2, 3))\nfunction t = f(varargin)\n t = numel(varargin) * 100 + sum([varargin{:}]);\nend', '   306\n');
T('varargout nargout', '[a, b] = f(); disp([a b])\nfunction varargout = f()\n for k = 1:nargout, varargout{k} = k; end\nend', '     1     2\n');
T('early return', 'disp(f(-1))\nfunction z = f(x)\n z = 0;\n if x < 0, return; end\n z = 1;\nend', '     0\n');
T('recursion fib', 'disp(fib(20))\nfunction r = fib(n)\n if n < 2, r = n; else, r = fib(n-1) + fib(n-2); end\nend', '        6765\n');
T('function file', 'disp(addtwo(5))', '     7\n', { files: { 'addtwo.m': 'function y = addtwo(x)\n  y = x + 2;\nend' } });
T('function file subfunction', 'disp(outer(3))', '    30\n', { files: { 'outer.m': 'function y = outer(x)\n  y = helper(x);\nend\nfunction r = helper(t)\n  r = t * 10;\nend' } });
T('nested function shares workspace', 'disp(outer(3))', '   103\n', { files: { 'outer.m': 'function y = outer(x)\n  base = 100;\n  y = inner(x);\n  function r = inner(t)\n    r = base + t;\n  end\nend' } });
T('script file call', 'helper; disp(hv)', 'from script\n    42\n', { files: { 'helper.m': "disp('from script');\nhv = 42;" } });
T('error in function file reports file', 'y = bad(1);', r => !r.res.ok && r.res.error.file === 'bad.m' && r.res.error.line === 2, { files: { 'bad.m': 'function y = bad(x)\n  y = x + nope;\nend' } });
T('persistent', 'c(); c(); disp(c())\nfunction n = c()\n persistent k\n if isempty(k), k = 0; end\n k = k + 1; n = k;\nend', '     3\n');
T('global', 'global G\nG = 5;\nshow()\nfunction show()\n global G\n disp(G)\nend', '     5\n');
T('anonymous capture', 'k = 3; f = @(x) x + k; k = 10; disp(f(1))', '     4\n');
T('function handle named', 'g = @sin; disp(g(0)); h = @plus; disp(h(2, 3))', '     0\n     5\n');
T('feval and str2func', "disp(feval('max', [3 7 1])); f = str2func('@(x) 2*x'); disp(f(4))", '     7\n     8\n');
T('func2str', 'f = @(a,b) a + b*2; disp(func2str(f))', '@(a,b)a+b*2\n');
T('handle to local function', 'h = @tw; disp(h(5))\nfunction y = tw(x)\n y = 2*x;\nend', '    10\n');
T('too many inputs error', 'f(1, 2)\nfunction f(a)\nend', r => !r.res.ok && /输入参数太多/.test(r.res.error.message));
T('command syntax', 'hold on\ngrid on\nformat long\nformat short\nx = 1', 'x =\n\n     1\n\n');
T('ans variable', '5 + 5;\ndisp(ans * 2)', '    20\n');
T('exist and clear', 'x = 1; a = exist("x"); clear x; b = exist("x"); disp([a b])', '     1     0\n');
T('eval', "eval('q = 3 + 4;'); disp(q)", '     7\n');
T('input numeric', 'x = input("Enter: "); disp(x * 2)', 'Enter: 21\n    42\n', { stdinLines: ['21'] });
T('input string', "s = input('Name: ', 's'); fprintf('Hi %s\\n', s)", 'Name: Ann\nHi Ann\n', { stdinLines: ['Ann'] });
T('tic toc', 't = tic; e = toc(t); disp(e >= 0)', '   1\n');

// ---------------- builtins: construction / reductions ----------------
T('zeros ones eye', 'disp(size(zeros(2,3))); disp(sum(ones(3))); disp(trace(eye(4)))', '     2     3\n     3     3     3\n     4\n');
T('linspace', 'disp(linspace(0, 1, 5))', '         0    0.2500    0.5000    0.7500    1.0000\n');
T('repmat reshape', 'disp(repmat([1 2], 2, 2)); disp(reshape(1:6, 2, 3))', '     1     2     1     2\n     1     2     1     2\n     1     3     5\n     2     4     6\n');
T('magic sums', 'M = magic(4); disp(sum(M)); disp(sum(M, 2)\')', '    34    34    34    34\n    34    34    34    34\n');
T('magic 6', 'M = magic(6); disp(all(sum(M) == 111) && all(sum(M,2) == 111))', '   1\n');
T('meshgrid', '[X, Y] = meshgrid(1:3, 1:2); disp(X); disp(Y)', '     1     2     3\n     1     2     3\n     1     1     1\n     2     2     2\n');
T('rand seeded', 'rng(42); a = rand(1, 3); rng(42); b = rand(1, 3); disp(isequal(a, b)); disp(all(a >= 0 & a < 1))', '   1\n   1\n');
T('randi range', 'rng(1); r = randi([5 7], 1, 100); disp([min(r) >= 5, max(r) <= 7])', '   1   1\n');
T('max with index', '[m, i] = max([3 9 2]); disp([m i])', '     9     2\n');
T('min dim', 'disp(min([4 2; 1 5], [], 2)\')', '     2     1\n');
T('sort descend idx', '[s, i] = sort([3 1 2], "descend"); disp(s); disp(i)', '     3     2     1\n     1     3     2\n');
T('unique outputs', '[u, ia, ic] = unique([3 1 3 2]); disp(u); disp(ic\')', '     1     2     3\n     3     1     3     2\n');
T('cumsum cumprod', 'disp(cumsum(1:4)); disp(cumprod(1:4))', '     1     3     6    10\n     1     2     6    24\n');
T('mean median mode std var', 'x = [1 2 3 4 10]; fprintf("%g %g %g %.4f %.4f\\n", mean(x), median(x), mode([1 2 2 3]), std(x), var(x))', '4 3 2 3.5355 12.5000\n');
T('any all', 'disp([any([0 0 1]) all([1 1 0])])', '   1   0\n');
T('diff prod', 'disp(diff([1 4 9 16])); disp(prod([1 2 3 4]))', '     3     5     7\n    24\n');
T('mod rem', 'disp([mod(-7, 3) rem(-7, 3) mod(5.5, 2)])', '    2.0000   -1.0000    1.5000\n');
T('round floor ceil fix', 'disp([round(2.5) round(-2.5) floor(-1.5) ceil(-1.5) fix(-1.5)])', '     3    -3    -2    -1    -1\n');
T('gcd lcm factorial nchoosek', 'disp([gcd(12, 18) lcm(4, 6) factorial(5) nchoosek(5, 2)])', '     6    12   120    10\n');
T('primes isprime factor', 'disp(primes(20)); disp(isprime(7)); disp(factor(60))', '     2     3     5     7    11    13    17    19\n   1\n     2     2     3     5\n');
T('cross dot kron', 'disp(cross([1 0 0], [0 1 0])); disp(dot([1 2 3], [4 5 6])); disp(kron([1 2], [1; 1]))', '     0     0     1\n    32\n     1     2\n     1     2\n');
T('trapz', 'x = 0:0.5:2; disp(trapz(x, x.^2))', '    2.7500\n');
T('histcounts', 'disp(histcounts([1 2 2 3 3 3], [0.5 1.5 2.5 3.5]))', '     1     2     3\n');
T('accumarray', 'disp(accumarray([1; 2; 1], [10; 20; 30])\')', '    40    20\n');
T('ismember', '[tf, loc] = ismember([1 5 2], [2 1]); disp(tf); disp(loc)', '   1   0   1\n     2     0     1\n');
T('set ops', 'disp(intersect([1 2 3], [2 3 4])); disp(union([3 1], [2 1])); disp(setdiff([1 2 3 4], [2 4]))', '     2     3\n     1     2     3\n     1     3\n');
T('set ops cellstr', "c = intersect({'a','b','c'}, {'b','c','d'}); disp(strjoin(c, ','))", 'b,c\n');
T('size forms', 'A = zeros(3, 4); [r, c] = size(A); disp([r c size(A, 2) numel(A) ndims(A)])', '     3     4     4    12     2\n');
T('isempty isscalar isvector', 'disp([isempty([]) isscalar(5) isvector([1 2]) isrow([1;2]) iscolumn([1;2])])', '   1   1   1   0   1\n');
T('class isa', "disp(class(int8(1))); disp(isa(5, 'numeric')); disp(isa(int8(1), 'integer'))", 'int8\n   1\n   1\n');
T('intmax realmax', 'disp(intmax("int8")); disp(double(intmin("int16")))', '  127\n      -32768\n');
T('circshift fliplr flipud', 'disp(circshift(1:4, 1)); disp(flipud([1; 2])\')', '     4     1     2     3\n     2     1\n');
T('tril triu', 'disp(triu(ones(3)))', '     1     1     1\n     0     1     1\n     0     0     1\n');

// ---------------- linear algebra ----------------
T('solve A\\b', 'x = [4 -2; 1 1] \\ [2; 3]; fprintf("%.6f %.6f\\n", x)', '1.333333 1.666667\n');
T('inv det', 'A = [4 7; 2 6]; Ai = inv(A); fprintf("%.4f ", Ai); fprintf("\\n%g\\n", det(A))', '0.6000 -0.2000 -0.7000 0.4000 \n10\n');
T('eig symmetric', 'e = eig([2 1; 1 2]); fprintf("%.6f ", e); fprintf("\\n")', '1.000000 3.000000 \n');
T('eig symmetric vectors', '[V, D] = eig([2 1; 1 2]); R = [2 1; 1 2] * V - V * D; disp(norm(R) < 1e-10)', '   1\n');
T('eig 3x3 symmetric', 'A = [4 1 0; 1 3 1; 0 1 2]; e = eig(A); disp(abs(sum(e) - trace(A)) < 1e-10 && abs(prod(e) - det(A)) < 1e-9)', '   1\n');
T('eig general complex', 'e = eig([0 -1; 1 0]); fprintf("%g %g\\n", real(e(1)), abs(imag(e(1))))', '0 1\n');
T('least squares', 'x = [1 1; 1 2; 1 3] \\ [1; 2; 2]; fprintf("%.4f %.4f\\n", x)', '0.6667 0.5000\n');
T('svd rank norm', 's = svd([3 0; 0 4]); disp(s\'); disp(rank(magic(4))); disp(norm([3 4]))', '     4     3\n     3\n     5\n');
T('lu reconstruct', '[L, U, P] = lu([1 2; 3 4]); disp(norm(L*U - P*[1 2; 3 4]) < 1e-12)', '   1\n');
T('qr reconstruct', 'A = [1 2; 3 4; 5 6]; [Q, R] = qr(A); disp(norm(Q*R - A) < 1e-10); disp(norm(Q\'*Q - eye(3)) < 1e-10)', '   1\n   1\n');
T('chol', 'R = chol([4 2; 2 3]); disp(norm(R\'*R - [4 2; 2 3]) < 1e-12)', '   1\n');
T('pinv', 'P = pinv([1 2; 2 4]); fprintf("%.2f ", P); fprintf("\\n")', '0.04 0.08 0.08 0.16 \n');
T('matrix power', 'disp([1 1; 1 0]^10)', '    89    55\n    55    34\n');
T('expm', 'E = expm([0 1; 0 0]); disp(E)', '     1     1\n     0     1\n');
T('singular warning', 'x = [1 2; 2 4] \\ [1; 2];', r => /警告/.test(r.errOut));

// ---------------- polynomials / numerics ----------------
T('polyfit polyval', 'p = polyfit([1 2 3 4], [3 5 7 9], 1); fprintf("%.4f %.4f\\n", p); disp(polyval([1 0 -1], 3))', '2.0000 1.0000\n     8\n');
T('polyfit quadratic', 'x = 0:5; y = 2*x.^2 - 3*x + 1; p = polyfit(x, y, 2); fprintf("%.6f ", p); fprintf("\\n")', '2.000000 -3.000000 1.000000 \n');
T('roots', 'r = roots([1 -3 2]); disp(r\')', '     2     1\n');
T('conv deconv poly', 'disp(conv([1 2], [1 3])); [q, r] = deconv([1 5 6], [1 2]); disp(q); disp(poly([2 3]))', '     1     5     6\n     1     3\n     1    -5     6\n');
T('interp1 linear', 'disp(interp1([1 2 3], [10 20 30], [1.5 2.5]))', '    15    25\n');
T('interp1 spline', 'fprintf("%.4f\\n", interp1([1 2 3 4], [1 4 9 16], 2.5, "spline"))', '6.2500\n');
T('interp1 nearest out of range', 'v = interp1([1 2 3], [10 20 30], [1.4 5], "nearest"); disp(v(1)); disp(isnan(v(2)))', '    10\n   1\n');
T('fzero bracket', 'x = fzero(@(x) x^2 - 2, [0 2]); fprintf("%.8f\\n", x)', '1.41421356\n');
T('fzero start point', 'x = fzero(@cos, 1); fprintf("%.8f\\n", x)', '1.57079633\n');
T('fminsearch', 'p = fminsearch(@(p) (p(1)-1)^2 + (p(2)-2)^2, [0 0]); fprintf("%.3f %.3f\\n", p)', '1.000 2.000\n');
T('fminbnd', 'x = fminbnd(@(x) (x-2)^2, 0, 5); fprintf("%.4f\\n", x)', '2.0000\n');
T('integral', 'fprintf("%.8f\\n", integral(@(x) x.^2, 0, 3))', '9.00000000\n');
T('integral infinite', 'fprintf("%.6f\\n", integral(@(x) exp(-x.^2), -Inf, Inf))', '1.772454\n');
T('quad', 'fprintf("%.6f\\n", quad(@sin, 0, pi))', '2.000000\n');
T('ode45 decay', '[t, y] = ode45(@(t, y) -2*y, [0 1], 1); fprintf("%d %d\\n", abs(y(end) - exp(-2)) < 1e-3, t(end) == 1)', '1 1\n');
T('ode45 system', '[t, y] = ode45(@(t, y) [y(2); -y(1)], [0 pi], [0; 1]); fprintf("%d %d\\n", abs(y(end,1)) < 1e-2, abs(y(end,2) + 1) < 1e-2)', '1 1\n');
T('ode45 tspan output', '[t, y] = ode45(@(t, y) 1, 0:0.5:2, 0); disp(t\'); disp(size(y))', '         0    0.5000    1.0000    1.5000    2.0000\n     5     1\n');

// ---------------- plotting spec ----------------
T('plot spec basic', 'x = 1:3; plot(x, x.^2, "r--o", "LineWidth", 2); title("T"); xlabel("x"); grid on', r => {
  if (!r.res.ok || r.figs.length !== 1) return false; const ax = r.figs[0].axes[0]; const s = ax.series[0];
  return ax.title === 'T' && ax.xlabel === 'x' && ax.grid === true && s.type === 'line' && s.lineStyle === '--' && s.marker === 'o' && s.lineWidth === 2 && JSON.stringify(s.color) === '[1,0,0]' && JSON.stringify(s.y) === '[1,4,9]';
});
T('plot default color order', 'plot(1:3); hold on; plot(3:-1:1);', r => { const s = r.figs[0].axes[0].series; return s.length === 2 && JSON.stringify(s[0].color) === '[0,0.447,0.741]' && JSON.stringify(s[1].color) === '[0.85,0.325,0.098]'; });
T('hold off replaces', 'plot(1:3); plot(4:6);', r => r.figs[0].axes[0].series.length === 1);
T('legend labels', 'plot(1:3); hold on; plot(2:4); legend("a", "b", "Location", "northwest")', r => { const ax = r.figs[0].axes[0]; return JSON.stringify(ax.legend) === '["a","b"]' && ax.legendLocation === 'northwest'; });
T('subplot spec', 'subplot(2,1,1); bar([1 2 3]); subplot(2,1,2); pie([1 1 2]); sgtitle("S")', r => { const f = r.figs[0]; return f.axes.length === 2 && JSON.stringify(f.axes[0].subplot) === '[2,1,1]' && f.axes[1].series[0].type === 'pie' && f.axes[1].series[0].labels[2] === '50%' && f.sgtitle === 'S'; });
T('histogram counts', 'histogram([1 2 2 3 3 3], [0.5 1.5 2.5 3.5])', r => JSON.stringify(r.figs[0].axes[0].series[0].y) === '[1,2,3]');
T('surf spec 3d', '[X, Y] = meshgrid(1:3, 1:2); surf(X, Y, X + Y); colormap jet; colorbar', r => { const ax = r.figs[0].axes[0]; const s = ax.series[0]; return ax.is3d && s.type === 'surf' && s.z.length === 2 && s.z[0].length === 3 && ax.colormap === 'jet' && ax.colorbar; });
T('contour levels', '[X, Y] = meshgrid(-1:0.5:1); contour(X, Y, X.^2 + Y.^2, [0.5 1])', r => JSON.stringify(r.figs[0].axes[0].series[0].levels) === '[0.5,1]');
T('NaN Inf serialization', 'plot([1 NaN Inf])', r => JSON.stringify(r.figs[0].axes[0].series[0].y) === '[1,null,"Inf"]');
T('figure numbers', 'figure(3); plot(1:2); figure; plot(1:2);', r => r.figs.map(f => f.id).sort().join(',') === '3,4');
T('drawnow emits', 'plot(1:2); drawnow; plot(1:3);', r => r.figs.length === 2);
T('axis and limits', 'plot(1:3); axis equal; xlim([0 5]); view(3)', r => { const ax = r.figs[0].axes[0]; return ax.axis === 'equal' && JSON.stringify(ax.xlim) === '[0,5]' && JSON.stringify(ax.view) === '[-37.5,30]'; });
T('scatter filled', 'scatter([1 2], [3 4], 50, "r", "filled")', r => { const s = r.figs[0].axes[0].series[0]; return s.type === 'scatter' && s.extra.filled && JSON.stringify(s.color) === '[1,0,0]'; });
T('peaks', 'Z = peaks(5); fprintf("%.4f\\n", Z(3,3))', '0.9810\n');
T('semilogy scale', 'semilogy(1:3, [1 10 100])', r => r.figs[0].axes[0].yscale === 'log');

// ---------------- run ----------------
let pass = 0, fail = 0; const failures = [];
for (const t of tests) {
  let ok = false, got;
  try {
    got = run(t.src, t.opts);
    if (typeof t.expect === 'function') ok = !!t.expect(got);
    else ok = got.res.ok && got.out === t.expect;
  } catch (e) { got = { out: 'JS exception: ' + e.stack }; }
  if (ok) pass++; else { fail++; failures.push({ t, got }); }
}
for (const { t, got } of failures) {
  console.log('FAIL: ' + t.name);
  console.log('  expected: ' + JSON.stringify(typeof t.expect === 'function' ? '(predicate)' : t.expect));
  console.log('  got:      ' + JSON.stringify(got.out) + (got.res && !got.res.ok ? '  error=' + JSON.stringify(got.res.error) : '') + (got.errOut ? ' stderr=' + JSON.stringify(got.errOut) : ''));
}
console.log(`\n${pass} passed, ${fail} failed, ${tests.length} total`);
process.exitCode = fail ? 1 : 0;
