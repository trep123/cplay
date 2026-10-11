# CPlay · C 语言在线运行平台

纯前端、零服务器的 C 语言在线运行环境。打开网页就能写 C、运行 C。

在线地址：https://c.0x-z.cn

## 特点

- **完全在浏览器本地运行**：自带用 JavaScript 手写的 C 解释器（`cinterp.js`），没有后端，也不依赖 CDN。
- **Web Worker 执行**：死循环不会卡住页面，可随时点「停止」。
- **支持 C99 常用子集**：指针与指针运算、多维数组、struct / union / enum / typedef、函数指针、static 局部变量、宏（含带参宏、`#`、`##`、`__VA_ARGS__`、`__LINE__` / `__FILE__` / `__func__`）、`#ifdef` 等条件编译。
- **goto 与语句标签**：函数内向前 / 向后跳转、跳出多层循环、跳进循环体，以及常见的「出错后 `goto cleanup`」写法。
- **复合字面量与指定初始化**：`(struct P){1, 2}`、`(int[]){1, 2, 3}`；`.x = 1`、`[3] = 5`、嵌套写法 `.in.b = 2`、`[1].x = 4`、`.arr[2] = 3`，以及 GNU 范围写法 `[1 ... 3] = 8`。
- **变长数组（VLA）**：`int a[n];`、`int m[r][c];`，`sizeof` 在运行时求值，支持 `void f(int r, int c, int m[r][c])` 形式的参数；离开作用域或函数返回时自动释放栈空间。
- **位域**：按 GCC / x86-64 规则真实打包（含 `unsigned :0` 对齐、跨单元换行），有符号 / 无符号位域的读写与溢出语义正确，`sizeof` 与真实编译器一致。
- **多文件程序**：编辑器上方的文件标签栏可以新建 `.h` / `.c` 文件，`#include "xxx.h"` 从这些文件中查找；所有 `.c` 文件作为独立的翻译单元一起编译并链接（共享全局变量和函数，`static` 只在本文件可见）。
- **常用标准库**：`printf/sprintf/snprintf`（完整格式化）、`fprintf(stderr, …)`（错误输出在控制台中显示为红色）、`scanf/sscanf/getchar/fgets`、`malloc/calloc/realloc/free`、`qsort/bsearch`、`strtok/strtol/strtoul/strtod`、`string.h`（含 `strstr/strncpy/memmove/strspn` 等）、`math.h`、`ctype.h`、`stdarg.h`（`va_list/va_arg/vprintf`）、`assert.h`（中文提示 + 行号）、`stdbool.h`、`stdint.h`、`inttypes.h`（`PRId64` 等）、`limits.h`、`float.h`、`time/clock`、`exit/atexit`。
- **正确的整数语义**：32 位 int 溢出回绕、无符号运算、char 有符号、`long long` 用 BigInt 保证 64 位精度。
- **中文报错 + 行号**：编译错误和运行时错误（除以零、空指针、越界、重复 free、栈溢出、超时）都会指出具体行，点击即可跳转。
- 14 个内置示例（含 goto 清理、位域、变长数组矩阵、多文件模块），支持导入 / 下载文件，支持标准输入。

## 目录

| 路径 | 说明 |
| --- | --- |
| `index.html` | 页面（编辑器 + 控制台），已内联解释器与示例 |
| `cinterp.js` | C 解释器：预处理 → 词法 → 语法分析 → 闭包编译 → 执行 |
| `src/worker-snippet.js` | Web Worker 胶水代码 |
| `src/examples.json` | 内置示例（由 `src/examples.py` 生成） |
| `tests/` | Node 测试：`node tests/tests.js`（90 个用例）、`node tests/run_examples.js`、`node tests/perf.js` |

## 解释器 API

```js
const r = CInterp.run(source, stdinText, {
  onStdout: s => console.log(s),
  onStderr: s => console.error(s),   // 可选；不传时 stderr 也写到 onStdout
  files: { 'util.h': '...', 'util.c': '...' },  // 可选：多文件
  maxSteps: 5e8,
});
// r = { exitCode, error: null | { kind: 'compile' | 'runtime', line, message, file? } }
// 错误发生在 files 中的某个文件里时，error.file 是该文件名，line 是该文件内的行号。
```

## 多文件

- 页面上：点编辑器上方的「+ 新建文件」添加文件，双击文件名（或按 F2）重命名，点 × 删除。`main.c` 是固定的主文件。
- `#include "x.h"` 先在文件列表中查找（找不到时再匹配内置标准头文件）；支持 include 守卫和 `#pragma once`。
- `main.c` 以外的每个 `.c` 文件都会作为单独的翻译单元编译：各自有独立的宏、`typedef` 和 `static` 变量 / 函数；非 `static` 的全局变量和函数在所有文件之间共享（`extern` 声明可以引用其他文件中的定义）。
- 文件列表中没有被 include 的头文件时，报错「找不到头文件 "x.h"」；没有使用多文件功能时仍是原来的「不支持自定义头文件」提示。
- 运行时或编译错误发生在其他文件里时，状态栏会显示「util.c 第 3 行」，点击即可切换到该文件并跳转。

## 暂不支持

- 文件读写（`fopen` / `fread` 等）、`setjmp` / `longjmp`、信号、多线程。
- `long double` 按 `double` 处理；不支持复数、`_Generic`、`_Atomic`、宽字符函数。
- 用 `va_arg` 读取结构体参数。
- `switch` 的 `case` 标签放在内层代码块中（如 Duff's device）。
- 不检查用 `goto` 跳过变长数组声明进入其作用域这类违规写法；`switch` 语句体中直接声明的变长数组要到函数返回时才释放。
- 函数内部 `typedef` 的变长数组类型在每次使用时重新计算大小（标准规定在 `typedef` 处计算一次）。
- 同名的非 `static` 全局变量在多个文件中重复定义不会报链接错误（按同一个变量处理）。

## 本地运行

直接用浏览器打开 `index.html`，或：

```bash
npx serve .
```
