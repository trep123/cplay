# CPlay · C / MATLAB 在线运行平台

纯前端、零服务器的 C 语言和 MATLAB 在线运行环境。打开网页就能写 C、写 MATLAB，并直接运行、画图。顶部的「语言」下拉框在 C 和 MATLAB 之间切换（也可以用链接 `#c` / `#matlab` 直接打开对应模式）。

在线地址：https://c.0x-z.cn

## 特点

- **手机优先的界面**：手机上顶部是「代码 | 输入 | 输出」分段切换和常驻的「运行」按钮，编辑器占满剩余高度，点运行自动切到「输出」；示例、导入、下载收进「⋯」菜单。触控目标不小于 44px，适配刘海屏安全区与软键盘（`100dvh`）。电脑上左侧编辑器、右侧输入 / 输出上下排列，中间的分隔条可拖动调整宽度（也可用方向键，双击恢复）。
- **浅色 / 深色主题**：跟随系统 `prefers-color-scheme`，编辑器配色随主题切换。
- **编辑器**：语法高亮、行号与当前行高亮、Tab 缩进 4 个空格（Shift+Tab 反缩进）、回车自动缩进、括号和引号自动补全（输入右括号会跳过已有的，退格成对删除）。
- **代码补全**：关键字、类型、标准库函数（带签名和中文说明）、当前文件及其他标签页中声明的变量 / 函数 / 结构体 / 宏、常用代码片段，`#include <` 后提示头文件，`.` / `->` 后提示结构体成员。详见下文「代码补全」。
- **控制台**：状态栏显示返回值和运行用时，stderr 与错误显示为红色，报错行号可点击跳转到对应文件和行，一键清空输出。
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
| `mlinterp.js` | MATLAB 解释器（全局 `MLInterp`，可在 Web Worker 中运行）；源码在 `src/mlinterp/`，`sh src/mlinterp/build.sh` 重新拼接 |
| `mlplot.js` | MATLAB 图形渲染器（全局 `MLPlot`，canvas 绘制，主线程使用） |
| `src/ml-worker-glue.js` | MATLAB Web Worker 胶水代码 |
| `src/mlinterp/examples/` | MATLAB 示例源文件（`node src/mlinterp/examples/build.js` 生成 `src/mlinterp/examples.json`） |
| `tests/matlab/` | MATLAB 解释器测试：`node tests/matlab/tests.js`（255 个用例）、`node tests/matlab/run_examples.js`、`node tests/matlab/bench.js` |
| `tests/page-jsdom.js` | 页面测试（jsdom，C 与 MATLAB 两种模式共 116 项）：`node tests/page-jsdom.js` |
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

## 代码补全

- **何时弹出**：输入至少 1 个字母的标识符时自动弹出；也可以按 **Ctrl + 空格** 手动打开（无前缀时列出全部候选）。在字符串和注释里不会弹出。
- **候选来源**：
  - C 关键字、类型（`int`、`size_t`、`uint32_t` …）和常量（`NULL`、`EOF`、`INT_MAX`、`M_PI` …）；
  - 解释器支持的标准库函数（`printf`、`scanf`、`malloc`、`strlen`、`qsort`、`sqrt` …），带函数签名、所属头文件和中文说明；
  - 当前文件和其他标签页中声明的变量、函数、结构体 / typedef、宏和枚举常量（用正则扫描，输入停顿 300 ms 后更新）；
  - 代码片段：`for`、`if`、`while`、`do`、`switch`、`else`、`main`、`struct`、`typedef`、`include`、`define`、`ifndef`。
- **特殊位置**：`#include <` 后提示支持的标准头文件，`#include "` 后提示你新建的 `.h` 文件；在结构体变量后输入 `.` 或 `->` 时提示它的成员（会查找变量声明的结构体类型，支持 typedef、其他标签页中定义的结构体和 `a->b->c` 链式访问；属于尽力而为，复杂表达式不提示）。
- **插入**：函数补全为 `name(|)`（已有括号时只补名字），`printf` 补全为 `printf("%d\n", |)`，`scanf` 补全为 `scanf("%d", &|)`，`main` 补全为完整的 `int main(void) { … return 0; }`；多行片段按当前行缩进，`|` 为插入后的光标位置。
- **排序**：前缀匹配最优先（区分大小写的更靠前），其中当前文件中的标识符、其次其他标签页中的标识符排在内置项前面；然后是包含匹配和模糊匹配（按顺序出现的字母）。最多显示 50 项，每项带类别标签：关键字 / 函数 / 变量 / 片段 / 类型 / 宏 / 成员 / 头文件。
- **操作**：↑ / ↓ 选择，Enter 或 Tab 确认，Esc 关闭；手机上直接点选。弹窗跟随光标，下方空间不够（例如软键盘挡住）时显示在当前行上方，不会遮住正在输入的那一行。

## 多文件

- 页面上：点编辑器上方的「+ 新建文件」添加文件，双击文件名（或按 F2；触屏上再点一次当前标签）重命名，点 × 删除（有内容的文件需要再点一次「删除？」确认）。`main.c` 是固定的主文件。
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

## MATLAB 模式

在顶部「语言」下拉框中选择 MATLAB（或打开 `…/#matlab`）。两种语言各有一套独立的文件标签页、示例和输入，切换时互不影响，切回来时原样保留；所选语言会记在 localStorage 里。

- **文件**：`main.m` 是主脚本；「+ 新建文件」默认创建 `.m` 函数文件（文件名就是函数名，例如 `area2.m` 中的 `function y = area2(x)`），主脚本里可以直接调用。
- **编辑器**：MATLAB 语法高亮（关键字、`%` 注释和 `%{ … %}` 块注释、`'…'` / `"…"` 字符串——标识符或 `)` `]` `'` 后面的 `'` 识别为转置、数字、常用内置函数）；在 `for` / `if` / `while` / `function` / `switch` / `try` / `else` / `elseif` / `case` 行后回车自动缩进，输入 `end` / `else` / `catch` / `case` / `otherwise` 时自动对齐到所属代码块（尽力而为）。
- **代码补全**：约 190 个常用函数（`zeros`、`linspace`、`plot`、`subplot`、`surf`、`meshgrid`、`sprintf`、`cellfun`、`ode45`、`polyfit` …）带签名和中文说明；当前文件中赋值过的变量（含 `[a, b] = …`、`for k = …`、函数参数）、本文件中的函数和其他 `.m` 文件中的函数；代码片段 `for`、`if`、`ifelse`、`while`、`function`、`switch`、`try`、`plot`（带 title / xlabel / ylabel / grid on 的绘图模板）。
- **运行**：MATLAB 解释器在单独的 Web Worker 中运行（第一次运行时才启动），10 秒超时，随时可以「停止」。「输入」面板的内容按行提供给 `input()`。
- **图形**：`plot`、`subplot`、`surf` 等生成的图窗以「Figure N」卡片显示，可下载 PNG，图形配色跟随浅色 / 深色主题；每次运行前清空，`close` 会关闭对应卡片。电脑上图形区在右侧输出面板下方；手机上显示在「输出」页的文本下方（运行出图后自动停在「输出」页）。
- **报错**：状态栏显示「运行错误 / 语法错误 · 第 N 行」（在函数文件中时显示「stats.m 第 N 行」），点击跳到对应文件和行。
- **支持**：矩阵与数组运算、逻辑索引、`end` 索引、字符串与 `string`、元胞数组、结构体、`containers.Map`、函数文件与局部函数、匿名函数和函数句柄、`try/catch`、`global` / `persistent`、`fprintf` / `sprintf` / `disp` 与 MATLAB 风格的变量显示、常用线性代数（`inv`、`det`、`eig`、`lu`、`qr`、`\`）、`polyfit` / `polyval`、`interp1`、`trapz`、`ode45`、`fzero`、`integral`，以及 `plot` / `subplot` / `bar` / `pie` / `histogram` / `scatter` / `surf` / `mesh` / `contour` 等绘图。12 个内置示例。

### MATLAB 暂不支持

- `classdef`（面向对象的类定义）。
- 复数矩阵的线性代数支持有限（复数标量和逐元素运算可用）。
- 宽矩阵显示时不会像 MATLAB 那样按「Columns 1 through 8」分段。
- 各种工具箱（Signal、Optimization、Symbolic 等）、文件读写、GUI 和 Simulink。

## 本地运行

直接用浏览器打开 `index.html`，或：

```bash
npx serve .
```

作为普通网页打开时，代码、输入和分隔条位置会保存在本机 localStorage 中；在沙盒 iframe 中无法使用存储时自动跳过。
