# CPlay · C 语言在线运行平台

纯前端、零服务器的 C 语言在线运行环境。打开网页就能写 C、运行 C。

在线地址：https://c.0x-z.cn

## 特点

- **完全在浏览器本地运行**：自带用 JavaScript 手写的 C 解释器（`cinterp.js`），没有后端，也不依赖 CDN。
- **Web Worker 执行**：死循环不会卡住页面，可随时点「停止」。
- **支持 C99 常用子集**：指针与指针运算、多维数组、struct / union / enum / typedef、函数指针、static 局部变量、宏（含带参宏、`#`、`##`）、`#ifdef` 等条件编译。
- **常用标准库**：`printf/sprintf/snprintf`（完整格式化）、`scanf/sscanf/getchar/fgets`、`malloc/calloc/realloc/free`、`qsort/bsearch`、`string.h`、`math.h`、`ctype.h`、`time/clock`。
- **正确的整数语义**：32 位 int 溢出回绕、无符号运算、char 有符号、`long long` 用 BigInt 保证 64 位精度。
- **中文报错 + 行号**：编译错误和运行时错误（除以零、空指针、越界、重复 free、栈溢出、超时）都会指出具体行，点击即可跳转。
- 10 个内置示例，支持导入 / 下载 `.c` 文件，支持标准输入。

## 目录

| 路径 | 说明 |
| --- | --- |
| `index.html` | 页面（编辑器 + 控制台），已内联解释器与示例 |
| `cinterp.js` | C 解释器：预处理 → 词法 → 语法分析 → 闭包编译 → 执行 |
| `src/worker-snippet.js` | Web Worker 胶水代码 |
| `src/examples.json` | 内置示例（由 `src/examples.py` 生成） |
| `tests/` | Node 测试：`node tests/tests.js`、`node tests/run_examples.js`、`node tests/perf.js` |

## 解释器 API

```js
const r = CInterp.run(source, stdinText, { onStdout: s => console.log(s), maxSteps: 5e8 });
// r = { exitCode, error: null | { kind: 'compile' | 'runtime', line, message } }
```

## 暂不支持

`goto` 与语句标签、复合字面量、变长数组、自定义头文件、位域（会被当作普通成员）。

## 本地运行

直接用浏览器打开 `index.html`，或：

```bash
npx serve .
```
