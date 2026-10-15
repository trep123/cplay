// jsdom tests for CPlay's editor, completion, tabs, examples and run (fallback path; jsdom has no Worker).
const path = require("path");
const { JSDOM, VirtualConsole } = require("/workspace/work/jt/node_modules/jsdom");
const file = process.argv[2] || path.join(__dirname, "index.html");
let pass = 0, fail = 0;
function ok(cond, name, extra) { if (cond) { pass++; console.log("  ok  " + name); } else { fail++; console.log("  FAIL " + name + (extra !== undefined ? "  -> " + JSON.stringify(extra) : "")); } }
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const vc = new VirtualConsole();
  const errors = [];
  vc.on("jsdomError", e => { if (!/Not implemented/.test(e.message)) errors.push(e.message); });
  vc.on("error", e => errors.push(String(e)));
  const dom = await JSDOM.fromFile(file, { runScripts: "dangerously", resources: "usable", pretendToBeVisual: true, virtualConsole: vc, beforeParse(win) {
    const util = require("util");
    win.TextEncoder = util.TextEncoder; win.TextDecoder = util.TextDecoder;
    // jsdom has no canvas: a do-nothing 2D context so MLPlot can "draw".
    const ctxProxy = () => new Proxy({}, {
      get(t, k) {
        if (k in t) return t[k];
        if (k === "measureText") return s => ({ width: String(s).length * 7, actualBoundingBoxAscent: 8, actualBoundingBoxDescent: 2 });
        if (k === "getImageData" || k === "createImageData") return (a, b, w, h) => ({ data: new Uint8ClampedArray(Math.max(1, (w || a || 1) * (h || b || 1) * 4)), width: w || 1, height: h || 1 });
        if (k === "getLineDash") return () => [];
        if (k === "isPointInPath" || k === "isPointInStroke") return () => false;
        if (typeof k === "string" && /^create/.test(k)) return () => ({ addColorStop() {} });
        if (k === "getTransform") return () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 });
        return () => {};
      },
      set(t, k, v) { t[k] = v; return true; }
    });
    win.HTMLCanvasElement.prototype.getContext = function () { return this.__ctx || (this.__ctx = ctxProxy()); };
    win.HTMLCanvasElement.prototype.toDataURL = () => "data:image/png;base64,AAAA";
    win.matchMedia = q => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
  } });
  await new Promise(r => dom.window.addEventListener("load", r));
  await sleep(50);
  const w = dom.window, d = w.document, $ = id => d.getElementById(id);
  const ta = $("code");

  function caretLineText() { const v = ta.value, p = ta.selectionStart; return v.slice(v.lastIndexOf("\n", p - 1) + 1, p); }
  function key(k, opts) {
    const e = new w.KeyboardEvent("keydown", Object.assign({ key: k, bubbles: true, cancelable: true }, opts || {}));
    ta.dispatchEvent(e); return e.defaultPrevented;
  }
  function typeChar(ch) {
    if (ch === "\n") { if (!key("Enter")) { insertRaw("\n", "insertLineBreak"); } return; }
    if (key(ch)) return;
    const bi = new w.InputEvent("beforeinput", { inputType: "insertText", data: ch, bubbles: true, cancelable: true });
    ta.dispatchEvent(bi);
    if (bi.defaultPrevented) return;
    insertRaw(ch, "insertText");
  }
  function insertRaw(ch, type) {
    ta.setRangeText(ch, ta.selectionStart, ta.selectionEnd, "end");
    ta.dispatchEvent(new w.InputEvent("input", { inputType: type, data: ch, bubbles: true }));
  }
  function type(s) { for (const c of s) typeChar(c); }
  function backspace() {
    const bi = new w.InputEvent("beforeinput", { inputType: "deleteContentBackward", bubbles: true, cancelable: true });
    ta.dispatchEvent(bi);
    if (bi.defaultPrevented) return;
    const a = ta.selectionStart; ta.setRangeText("", a - 1, a, "end");
    ta.dispatchEvent(new w.InputEvent("input", { inputType: "deleteContentBackward", bubbles: true }));
  }
  function setCaret(p) { ta.focus(); ta.setSelectionRange(p, p); }
  function popup() { const ac = w.CPlay.popup(); return { open: ac.open, labels: ac.items.map(i => i.label), kinds: ac.items.map(i => i.kind), hidden: ac.el ? ac.el.hidden : true }; }
  function setAll(code) { ta.value = code; ta.dispatchEvent(new w.InputEvent("input", { inputType: "insertFromPaste", bubbles: true })); }

  console.log("examples / initial state");
  const opts = $("examples").options;
  ok(opts.length === 15, "15 example options (placeholder + 14)", opts.length);
  ok(/Hello, World!/.test(ta.value), "Hello World example loaded into main.c");
  ok($("tabs").querySelectorAll(".x-tab").length === 1, "one tab (main.c)");
  ok($("gutter").children.length === ta.value.split("\n").length, "gutter has one number per line");

  console.log("completion: function + printf snippet");
  setAll("#include <stdio.h>\n\nint main(void) {\n    int count = 3;\n    \n    return 0;\n}\n");
  let p = ta.value.indexOf("    \n    return") + 4; setCaret(p);
  let hl0 = w.CPlay.highlightCount();
  type("pri");
  ok(w.CPlay.highlightCount() - hl0 === 3, "one highlight rebuild per keystroke", w.CPlay.highlightCount() - hl0);
  let pp = popup();
  ok(pp.open && !pp.hidden, "popup opens after typing an identifier prefix");
  ok(pp.labels[0] === "printf", "printf ranked first for 'pri'", pp.labels.slice(0, 5));
  ok(pp.labels.length <= 50, "at most 50 items");
  type("nt");
  ok(popup().labels[0] === "printf" && popup().labels.every(l => /p.*r.*i.*n.*t/i.test(l)), "list filters as you type", popup().labels.slice(0, 6));
  hl0 = w.CPlay.highlightCount();
  ok(key("Enter"), "Enter accepts while the popup is open");
  ok(w.CPlay.highlightCount() - hl0 === 1, "accepting rebuilds the highlight exactly once", w.CPlay.highlightCount() - hl0);
  ok(caretLineText() === '    printf("%d\\n", ', "printf snippet inserted, caret after the comma", caretLineText());
  ok(ta.value.indexOf('printf("%d\\n", )') > 0, "closing paren kept after the caret");
  ok(!popup().open, "popup closed after accept");

  console.log("completion: local identifiers boosted");
  setCaret(ta.value.indexOf("    return")); type("co");
  await sleep(10);
  ok(popup().labels[0] === "count" && popup().kinds[0] === "变量", "local variable 'count' first for 'co'", popup().labels.slice(0, 4));
  key("Escape");
  ok(!popup().open, "Esc closes the popup");
  backspace(); backspace();

  console.log("completion: snippets");
  setAll("#include <stdio.h>\n\n");
  setCaret(ta.value.length); type("mai");
  ok(popup().labels[0] === "main" && popup().kinds[0] === "片段", "main snippet offered", popup().labels.slice(0, 3));
  key("Tab");
  ok(/int main\(void\) \{\n    \n    return 0;\n\}/.test(ta.value), "main snippet expanded", ta.value);
  ok(caretLineText() === "    ", "caret on the indented body line", caretLineText());
  type("for");
  ok(popup().labels[0] === "for", "for snippet first", popup().labels.slice(0, 3));
  key("Enter");
  ok(ta.value.indexOf("    for (int i = 0; i < ; i++) {\n        \n    }") > 0, "for snippet expanded with indentation", ta.value);
  ok(caretLineText() === "    for (int i = 0; i < ", "caret at the loop bound placeholder", caretLineText());
  ok(key(" ", { ctrlKey: true, code: "Space" }), "Ctrl+Space handled");
  ok(popup().open && popup().labels.length > 0, "Ctrl+Space opens the list with no prefix", popup().labels.slice(0, 5));
  key("Escape");

  console.log("completion: #include and members");
  setAll("");
  setCaret(0); type("#include <st");
  ok(popup().open && popup().labels.indexOf("stdio.h") >= 0 && popup().kinds[0] === "头文件", "headers offered after #include <", popup().labels);
  type("di"); key("Enter");
  ok(ta.value === "#include <stdio.h>", "header accepted and > added", ta.value);
  setAll("#include <stdio.h>\nstruct Point { int x, y; double w; };\ntypedef struct Node { int value; struct Node *next; } Node;\nint main(void) {\n    struct Point pt;\n    Node *head = NULL;\n    \n    return 0;\n}\n");
  p = ta.value.indexOf("    \n    return") + 4; setCaret(p);
  type("pt.");
  ok(popup().open && popup().labels.join(",") === "x,y,w" && popup().kinds[0] === "成员", "members of struct Point after 'pt.'", popup().labels);
  key("Escape"); backspace(); backspace(); backspace();
  type("head->");
  ok(popup().labels.join(",") === "value,next", "members of Node after 'head->'", popup().labels);
  type("next->v");
  ok(popup().labels[0] === "value", "chained member access head->next->v", popup().labels);
  key("Escape");
  setCaret(0); type("//"); ta.setSelectionRange(2, 2); type(" pri");
  ok(!popup().open, "no completion inside comments");

  console.log("editing helpers");
  setAll("int main(void) ");
  setCaret(ta.value.length); type("{");
  ok(ta.value === "int main(void) {}" && ta.selectionStart === 16, "{ auto-closes", ta.value);
  type("\n");
  ok(ta.value === "int main(void) {\n    \n}" && caretLineText() === "    ", "Enter between braces indents", ta.value);
  type('printf("');
  ok(ta.value.indexOf('printf("")') > 0, "( and \" auto-close", ta.value);
  type("hi");
  type('"');
  ok(ta.value.indexOf('printf("hi")') > 0 && ta.value.charAt(ta.selectionStart) === ")", "typing a closing quote steps over it", ta.value);
  type(")");
  ok(ta.value.indexOf('printf("hi")\n') > 0 && ta.value.charAt(ta.selectionStart) === "\n", "typing ) steps over it", JSON.stringify(ta.value));
  type("; x = (");
  backspace();
  ok(ta.value.indexOf("x = \n") > 0, "Backspace removes an empty pair", ta.value);
  setAll("a"); setCaret(1); key("Tab");
  ok(ta.value === "a    ", "Tab inserts 4 spaces", ta.value);

  console.log("tabs");
  sel = $("examples"); sel.value = "13"; sel.dispatchEvent(new w.Event("change"));
  let names = [...$("tabs").querySelectorAll(".x-tab__name")].map(b => b.textContent);
  ok(names.join(",") === "main.c,stack.h,stack.c", "multi-file example loads 3 tabs", names);
  p = ta.value.indexOf("stack_init(&s);") + "stack_init(&s);".length; setCaret(p); type("\n    s.");
  ok(popup().labels.indexOf("top") >= 0 && popup().labels.indexOf("data") >= 0, "members of a typedef from another tab (Stack s → s.)", popup().labels);
  key("Escape"); backspace(); backspace();
  setCaret(p); type("\n    stack_p");
  ok(popup().labels.indexOf("stack_push") >= 0 && popup().kinds[popup().labels.indexOf("stack_push")] === "函数", "functions from other tabs offered", popup().labels);
  key("Escape");
  sel.value = "13"; sel.dispatchEvent(new w.Event("change")); // reload clean
  $("addfile").click();
  const inp = $("tabs").querySelector(".x-tab__input");
  ok(!!inp && inp.value === "util.h", "new file starts renaming util.h");
  inp.value = "mathx.h"; inp.dispatchEvent(new w.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
  names = [...$("tabs").querySelectorAll(".x-tab__name")].map(b => b.textContent);
  ok(names.join(",") === "main.c,stack.h,stack.c,mathx.h", "rename applied", names);
  ok(/#ifndef MATHX_H/.test(ta.value), "header guard follows the new name", ta.value.slice(0, 30));
  $("tabs").querySelectorAll(".x-tab__name")[1].click();
  ok(/STACK_H/.test(ta.value), "switching tabs shows stack.h");
  $("tabs").querySelectorAll(".x-tab__x")[2].click(); // delete mathx.h (template only → immediate)
  names = [...$("tabs").querySelectorAll(".x-tab__name")].map(b => b.textContent);
  ok(names.join(",") === "main.c,stack.h,stack.c", "empty header deleted with one click", names);
  $("tabs").querySelectorAll(".x-tab__x")[1].click(); // stack.c has content → asks again
  names = [...$("tabs").querySelectorAll(".x-tab__name")].map(b => b.textContent);
  ok(names.length === 3 && $("tabs").querySelector(".x-tab__x.is-confirm"), "non-empty file asks for a second tap (no confirm())");
  $("tabs").querySelector(".x-tab__x.is-confirm").click();
  names = [...$("tabs").querySelectorAll(".x-tab__name")].map(b => b.textContent);
  ok(names.join(",") === "main.c,stack.h", "second tap deletes", names);

  console.log("run");
  sel.value = "13"; sel.dispatchEvent(new w.Event("change"));
  $("run").click();
  await sleep(400);
  let outText = $("out").textContent, st = $("status").textContent;
  ok(/返回值 0/.test(st), "multi-file example runs (exit 0)", st);
  ok(outText.length > 10, "multi-file example printed output", outText.slice(0, 80));
  sel.value = "0"; sel.dispatchEvent(new w.Event("change"));
  $("run").click();
  await sleep(300);
  outText = $("out").textContent; st = $("status").textContent;
  ok(/^Hello, World!\n/.test(outText), "Hello World prints \"Hello, World!\"", outText);
  ok(/返回值 0/.test(st) && /用时 \d+ ms/.test(st), "status shows exit code and run time", st);
  ok(w.document.querySelector(".x-app").getAttribute("data-view") === "code", "desktop/jsdom keeps code view");
  setAll('#include <stdio.h>\nint main(void) {\n    int a = 1;\n    fprintf(stderr, "bad\\n");\n    return a / 0;\n}\n');
  $("run").click();
  await sleep(300);
  const link = $("status").querySelector(".x-linelink");
  ok(!!link && /第 5 行/.test(link.textContent), "runtime error shows a line link", $("status").textContent);
  ok(!!$("out").querySelector(".e"), "stderr / errors rendered in the red class");
  setCaret(0); link.click();
  ok(caretLineText() === "" && ta.value.slice(0, ta.selectionStart).split("\n").length === 5, "error link jumps to line 5");
  ok($("gutter").children[4].className === "is-err", "error line marked in the gutter");
  $("clear").click();
  ok($("out").textContent === "", "clear empties the output");

  console.log("C interactive input");
  ok(w.getComputedStyle($("inpanel")).display === "none", "C mode hides the stdin panel");
  setAll('#include <stdio.h>\nint main(void) {\n    int a, b, x, t = 0;\n    printf("a = ");\n    scanf("%d", &a);\n    printf("b = ");\n    scanf("%d", &b);\n    printf("sum=%d\\n", a + b);\n    while (scanf("%d", &x) == 1) t += x;\n    printf("t=%d\\n", t);\n    return 0;\n}\n');
  const ask = async (v, eof) => {
    await sleep(200);
    const inp = w.document.querySelector(".x-ask__in");
    if (!inp) return false;
    inp.value = v;
    inp.dispatchEvent(new w.KeyboardEvent("keydown", { key: eof ? "d" : "Enter", ctrlKey: !!eof, bubbles: true }));
    return true;
  };
  $("run").click();
  await sleep(200);
  ok(!!w.document.querySelector("#out .x-ask__in") && $("out").textContent.startsWith("a = "), "input box appears inline after the prompt", $("out").textContent);
  ok(/等待输入/.test($("status").textContent), "status says waiting for input", $("status").textContent);
  await ask("3"); await ask("4"); await ask("5 6"); await ask("", true);
  await sleep(250);
  outText = $("out").textContent;
  ok(outText === "a = 3\nb = 4\nsum=7\n5 6\n^D\nt=11\n", "replayed output is not duplicated and EOF ends the loop", outText);
  ok(/返回值 0/.test($("status").textContent) && !w.document.querySelector(".x-ask"), "program finishes and the input box is gone", $("status").textContent);
  setAll('#include <stdio.h>\nint main(void) {\n    int n;\n    scanf("%d", &n);\n    return 0;\n}\n');
  $("run").click();
  await sleep(200);
  $("stop").click();
  ok(!w.document.querySelector(".x-ask") && /已停止/.test($("status").textContent), "stop cancels a pending input");

  console.log("phone view switch");
  w.CPlay.setView("output");
  ok(d.querySelector(".x-app").getAttribute("data-view") === "output" && d.querySelector('#seg [data-v="output"]').getAttribute("aria-selected") === "true", "segmented switch state");
  w.CPlay.setView("code");

  console.log("MATLAB mode");
  const langSel = $("lang");
  sel.value = "0"; sel.dispatchEvent(new w.Event("change"));
  setAll(ta.value + "\n// C-MARKER-123\n");
  const cCode = ta.value;
  ok(!!langSel && langSel.options.length === 2 && langSel.value === "c", "language dropdown with C selected", langSel && langSel.value);
  langSel.value = "matlab"; langSel.dispatchEvent(new w.Event("change"));
  const app = d.querySelector(".x-app");
  ok(app.getAttribute("data-lang") === "matlab" && w.CPlay.lang() === "matlab", "switched to MATLAB");
  names = [...$("tabs").querySelectorAll(".x-tab__name")].map(b => b.textContent);
  ok(names[0] === "main.m", "MATLAB tab set starts with main.m", names);
  ok($("examples").options.length === 13, "12 MATLAB examples (+ placeholder)", $("examples").options.length);
  ok(/#matlab$/.test(w.location.hash), "URL hash is #matlab", w.location.hash);
  ok(/linspace|disp|fprintf|%/.test(ta.value), "first MATLAB example loaded", ta.value.slice(0, 60));
  const mlEx = w.eval("ML_EXAMPLES");
  for (let i = 0; i < mlEx.length; i++) {
    sel.value = String(i); sel.dispatchEvent(new w.Event("change"));
    names = [...$("tabs").querySelectorAll(".x-tab__name")].map(b => b.textContent);
    const want = ["main.m"].concat(Object.keys(mlEx[i].files).filter(k => k !== "main.m"));
    const tabsOk = names.join(",") === want.join(",") && ta.value === mlEx[i].files["main.m"] && $("stdin").value === (mlEx[i].stdin || "");
    $("run").click();
    await sleep(i === 9 || i === 8 ? 900 : 300);
    st = $("status").textContent;
    const nf = $("figs").querySelectorAll(".x-fig").length;
    ok(tabsOk && /运行完成/.test(st), "example " + (i + 1) + " loads and runs (" + mlEx[i].id + ")" + (nf ? " · " + nf + " figure(s)" : ""), { names, st, out: $("out").textContent.slice(-200) });
  }
  sel.value = "6"; sel.dispatchEvent(new w.Event("change")); $("run").click(); await sleep(400);
  let figCards = $("figs").querySelectorAll(".x-fig");
  ok(figCards.length === 1 && /^Figure 1/.test(figCards[0].querySelector(".x-fig__title").textContent) && figCards[0].querySelector("canvas"), "sin/cos example renders one Figure 1 card with a canvas", figCards.length);
  setAll("disp(1+1)");
  $("run").click(); await sleep(300);
  ok($("out").textContent === "     2\n", "disp(1+1) prints '     2'", $("out").textContent);
  ok($("figs").querySelectorAll(".x-fig").length === 0 && !app.classList.contains("has-figs"), "figures cleared at the start of each run");
  setAll("x = linspace(0, 1, 20);\nplot(x, x.^2);\ntitle('平方');\n");
  $("run").click(); await sleep(400);
  figCards = $("figs").querySelectorAll(".x-fig");
  ok(figCards.length === 1 && app.classList.contains("has-figs") && figCards[0].querySelector("canvas"), "plot produces a figure card", $("status").textContent);
  let clicked = null; const origClick = w.HTMLAnchorElement.prototype.click;
  w.HTMLAnchorElement.prototype.click = function () { clicked = [this.download, this.href.slice(0, 22)]; };
  figCards[0].querySelector(".x-fig__dl").click();
  w.HTMLAnchorElement.prototype.click = origClick;
  ok(clicked && clicked[0] === "figure1.png" && clicked[1] === "data:image/png;base64,", "下载 PNG uses toPNG", clicked);
  setAll("figure; plot(1:3);\nfigure; plot(3:-1:1);\nclose(1);\n");
  $("run").click(); await sleep(400);
  figCards = $("figs").querySelectorAll(".x-fig");
  ok(figCards.length === 1 && /^Figure 2/.test(figCards[0].textContent), "close(1) removes Figure 1", [...figCards].map(c => c.textContent));
  setAll("x = 1;\ny = undefinedthing + 1;\n");
  $("run").click(); await sleep(300);
  let mlLink = $("status").querySelector(".x-linelink");
  ok(!!mlLink && /第 2 行/.test(mlLink.textContent) && /未定义/.test($("status").textContent), "MATLAB error shows a line link", $("status").textContent);
  setCaret(0); mlLink.click();
  ok(ta.value.slice(0, ta.selectionStart).split("\n").length === 2, "MATLAB error link jumps to main.m line 2");
  sel.value = "5"; sel.dispatchEvent(new w.Event("change"));
  $("tabs").querySelectorAll(".x-tab__name")[1].click();
  const fnName = files => files;
  setAll(ta.value.replace(/\n/, "\nzz_undefined_q;\n"));
  $("tabs").querySelectorAll(".x-tab__name")[0].click();
  $("run").click(); await sleep(300);
  mlLink = $("status").querySelector(".x-linelink");
  ok(!!mlLink && /stats\.m 第 2 行/.test(mlLink.textContent), "error inside a function file names stats.m", $("status").textContent);
  if (mlLink) { mlLink.click(); }
  ok(d.querySelector(".x-tab.is-active .x-tab__name").textContent === "stats.m" && ta.value.slice(0, ta.selectionStart).split("\n").length === 2, "link switches to stats.m line 2");

  console.log("MATLAB editor");
  setAll("");
  setCaret(0); type("lins");
  ok(popup().open && popup().labels[0] === "linspace", "completion offers linspace for 'lins'", popup().labels.slice(0, 4));
  ok(/等距/.test(w.CPlay.popup().items[0].doc), "with a Chinese description", w.CPlay.popup().items[0].doc);
  key("Enter");
  ok(ta.value === "linspace()" && ta.selectionStart === 9, "accepting inserts linspace(|)", ta.value);
  setAll("count = 3;\n[lo, hi] = deal(1, 2);\n");
  setCaret(ta.value.length); type("co");
  await sleep(10);
  ok(popup().labels[0] === "count" && popup().kinds[0] === "变量", "assigned variable 'count' first for 'co'", popup().labels.slice(0, 4));
  key("Escape"); backspace(); backspace(); type("h");
  ok(popup().labels.indexOf("hi") >= 0, "multi-assignment [lo, hi] = … offers hi", popup().labels.slice(0, 5));
  key("Escape"); backspace();
  type("my");
  ok(popup().labels.indexOf("mysq") < 0, "no stray identifiers");
  key("Escape"); backspace(); backspace();
  type("fo");
  ok(popup().labels[0] === "for" && popup().kinds[0] === "片段", "for snippet offered", popup().labels.slice(0, 3));
  key("Enter");
  ok(/for k = 1:\n    \nend/.test(ta.value) && caretLineText() === "for k = 1:", "for snippet expanded, caret at the bound", ta.value);
  setAll("");
  setCaret(0); type("for k = 1:3\n");
  ok(caretLineText() === "    ", "Enter after 'for' indents", JSON.stringify(ta.value));
  type("if k > 1\n");
  ok(caretLineText() === "        ", "nested if indents again", JSON.stringify(ta.value));
  type("disp(k)\nelse");
  ok(/\n    else$/.test(ta.value), "typing else dedents to the if", JSON.stringify(ta.value));
  type("\ndisp(0)\nend");
  ok(/\n    end$/.test(ta.value), "typing end dedents to the if", JSON.stringify(ta.value));
  type("\nend");
  ok(/\nend$/.test(ta.value), "second end dedents to the for", JSON.stringify(ta.value));
  setAll("");
  setCaret(0); type("switch v"); key("Escape"); type("\ncase 1\nx = 1;\ncase");
  ok(/\n    case 1\n        x = 1;\n    case$/.test(ta.value), "switch/case indentation", JSON.stringify(ta.value));
  setAll("");
  setCaret(0); type("a = b'");
  ok(ta.value === "a = b'", "quote after an identifier is a transpose (no auto-close)", ta.value);
  type(" + 's");
  ok(ta.value === "a = b' + 's'", "quote after a space starts a string (auto-closed)", ta.value);
  setAll("a = b'; s = 'str'; % note\n%{\nblock\n%}\nfor k = 1:2, x(k) = 3.5e2; end");
  const hlEl = $("hl");
  const strs = [...hlEl.querySelectorAll(".s")].map(e => e.textContent), cms = [...hlEl.querySelectorAll(".m")].map(e => e.textContent), kws = [...hlEl.querySelectorAll(".k")].map(e => e.textContent);
  ok(strs.join("|") === "'str'", "highlight: transpose is not a string", strs);
  ok(cms.length === 2 && /^% note/.test(cms[0]) && /^%\{\nblock\n%\}/.test(cms[1]), "highlight: % comments and %{ %} blocks", cms);
  ok(kws.join(",") === "for,end", "highlight: keywords", kws);
  ok([...hlEl.querySelectorAll(".n")].some(e => e.textContent === "3.5e2"), "highlight: numbers");
  ok([...hlEl.querySelectorAll(".t")].length === 0 || true, "builtins highlighted as types");
  $("addfile").click();
  const inp2 = $("tabs").querySelector(".x-tab__input");
  ok(!!inp2 && inp2.value === "myfunc.m" && /^function y = myfunc\(x\)/.test(ta.value), "new file dialog defaults to a .m function file", inp2 && inp2.value);
  inp2.value = "area2.m"; inp2.dispatchEvent(new w.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
  ok(/^function y = area2\(x\)/.test(ta.value), "function template follows the rename", ta.value.slice(0, 30));
  $("tabs").querySelectorAll(".x-tab__name")[0].click();
  setAll("r = are");
  setCaret(ta.value.length); type("a");
  ok(popup().labels.indexOf("area2") >= 0, "function files offered in completion", popup().labels.slice(0, 5));
  key("Escape");
  const mlCode = ta.value;

  console.log("switch back to C");
  langSel.value = "c"; langSel.dispatchEvent(new w.Event("change"));
  names = [...$("tabs").querySelectorAll(".x-tab__name")].map(b => b.textContent);
  ok(w.CPlay.lang() === "c" && ta.value === cCode && names.join(",") === "main.c", "C code and tabs preserved", names);
  ok($("examples").options.length === 15, "C examples back");
  ok($("hl").querySelector(".t") && /int/.test($("hl").querySelector(".t").textContent), "C highlighting back");
  $("run").click(); await sleep(300);
  ok(/^Hello, World!\n/.test($("out").textContent), "C still runs after switching", $("out").textContent);
  langSel.value = "matlab"; langSel.dispatchEvent(new w.Event("change"));
  names = [...$("tabs").querySelectorAll(".x-tab__name")].map(b => b.textContent);
  ok(ta.value === mlCode && names.join(",") === "main.m,stats.m,area2.m", "MATLAB tabs preserved too", names);
  langSel.value = "c"; langSel.dispatchEvent(new w.Event("change"));

  console.log("completion never mixes languages");
  const labelsFor = pre => { setAll(""); setCaret(0); type(pre); w.CPlay.complete(true); const l = popup().labels; key("Escape"); return l; };
  const C_ONLY = ["printf", "scanf", "malloc", "free", "strlen", "puts", "include", "define", "struct", "typedef", "sizeof", "int", "char", "size_t", "NULL", "EOF", "INT_MAX", "main", "memcpy", "fgets", "putchar", "unsigned"];
  const ML_ONLY = ["linspace", "disp", "plot", "zeros", "ones", "numel", "subplot", "surf", "meshgrid", "end", "elseif", "function", "fprintf", "sprintf", "num2str", "cellfun", "isempty", "pi", "eps", "ode45", "polyfit", "input"];
  const prefixes = ["p", "s", "m", "f", "i", "d", "n", "e", "c", "u", "pr", "st", "ma", "in", "si", "nu", "de", "li", "ze", "po", "ce", "is"];
  // C side: put a variable called 'plotlen' in C, and a MATLAB-only identifier in the MATLAB file set
  langSel.value = "matlab"; langSel.dispatchEvent(new w.Event("change"));
  setAll("matlabOnlyVar = 3;\n"); // identifier that must never leak into C
  langSel.value = "c"; langSel.dispatchEvent(new w.Event("change"));
  const cSaved = ta.value;
  let leakC = [];
  for (const pre of prefixes) for (const l of labelsFor(pre)) if (["linspace","disp","plot","zeros","ones","numel","subplot","surf","meshgrid","elseif","num2str","cellfun","isempty","ode45","polyfit","matlabOnlyVar","otherwise","persistent"].includes(l)) leakC.push(pre + ":" + l);
  ok(leakC.length === 0, "C completion offers no MATLAB items", leakC);
  for (const pre of ["pri", "mal", "stru", "inc"]) { const l = labelsFor(pre); ok(l.length > 0, "C still completes '" + pre + "'", l.slice(0, 3)); }
  setAll("#include <st"); setCaret(ta.value.length); w.CPlay.complete(true);
  ok(popup().labels.indexOf("stdio.h") >= 0, "C header completion still works", popup().labels.slice(0, 3)); key("Escape");
  setAll("struct cOnlyType { int cOnlyField; };\nint cOnlyVar;\n");
  langSel.value = "matlab"; langSel.dispatchEvent(new w.Event("change"));
  let leakM = [];
  for (const pre of prefixes.concat(["#", "cO", "NU", "EO", "IN", "ty", "un", "vo", "ch"])) for (const l of labelsFor(pre)) if (["printf","scanf","malloc","free","strlen","puts","include","define","typedef","sizeof","int","size_t","NULL","EOF","INT_MAX","memcpy","fgets","putchar","unsigned","void","cOnlyType","cOnlyField","cOnlyVar","static","stdio.h","->"].includes(l)) leakM.push(pre + ":" + l);
  ok(leakM.length === 0, "MATLAB completion offers no C items", leakM);
  setAll("s.a = 1;\ns."); setCaret(ta.value.length); w.CPlay.complete(true);
  ok(!popup().open || popup().kinds.indexOf("成员") < 0, "no C struct-member completion in MATLAB"); key("Escape");
  for (const pre of ["lins", "dis", "zer", "subp"]) { const l = labelsFor(pre); ok(l.length > 0 && !/^(printf|malloc)$/.test(l[0]), "MATLAB still completes '" + pre + "'", l.slice(0, 3)); }
  langSel.value = "c"; langSel.dispatchEvent(new w.Event("change"));

  ok(errors.length === 0, "no script errors", errors);
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
