#!/usr/bin/env node
// 运行 examples.json 中的全部示例：node run_examples.js [-v] [id...]
'use strict';
const fs = require('fs'), path = require('path');
const M = require('../../mlinterp.js');
const args = process.argv.slice(2);
const verbose = args.includes('-v');
const only = args.filter(a => a !== '-v');
const examples = JSON.parse(fs.readFileSync(path.join(__dirname, '../../src/mlinterp/examples.json'), 'utf8'));
const SHOW = verbose ? Infinity : 6;
let failed = 0;
for (const ex of examples) {
  if (only.length && !only.includes(ex.id)) continue;
  let out = '', err = '', figs = [];
  let res;
  const t0 = Date.now();
  try {
    res = M.run(ex.files['main.m'], {
      fileName: 'main.m', files: ex.files,
      stdinLines: ex.stdin ? ex.stdin.split('\n') : [],
      onStdout: s => (out += s), onStderr: s => (err += s), onFigure: f => figs.push(f),
    });
  } catch (e) { res = { ok: false, error: { message: 'JS 异常：' + (e && e.stack || e) } }; }
  const ms = Date.now() - t0;
  const ok = res.ok && !err.trim();
  if (!ok) failed++;
  console.log(`=== [${ex.id}] ${ex.title}`);
  const lines = out.split('\n').filter(l => l.trim() !== '');
  for (const l of lines.slice(0, SHOW)) console.log('  | ' + l);
  if (lines.length > SHOW) console.log(`  | ...（共 ${lines.length} 行非空输出）`);
  if (err.trim()) console.log('  stderr: ' + err.trim().split('\n').join('\n          '));
  if (!res.ok) console.log(`  错误：${res.error.message}（${res.error.file || ''} 第 ${res.error.line} 行）`);
  console.log(`  图形数：${figs.length}  用时：${ms} ms  ${ok ? 'OK' : 'FAIL'}\n`);
}
console.log(failed ? `${failed} 个示例失败` : '全部示例通过');
process.exit(failed ? 1 : 0);
