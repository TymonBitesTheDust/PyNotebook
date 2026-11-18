// Typing help for Python editors:
//   suggestions  names to insert as you type ("pr" -> print), from Python's own
//                vocabulary (works before Python starts), the live session and the code.
//   mistakes     syntax errors and undefined names, underlined with the line marked
//                and explained in a bar under the code.

import { syntaxTree } from "@codemirror/language";
import { EditorView, Decoration, ViewPlugin, showPanel } from "@codemirror/view";
import { RangeSetBuilder, StateEffect } from "@codemirror/state";
import {
  acceptCompletion, completionStatus, currentCompletions, selectedCompletionIndex, setSelectedCompletion,
  insertCompletionText, insertBracket, pickedCompletion,
} from "@codemirror/autocomplete";
import { linter, forEachDiagnostic, setDiagnosticsEffect } from "@codemirror/lint";
import { settings } from "./settings.js";

// ====================================================================== vocabulary

const KEYWORDS = [
  "False", "None", "True", "and", "as", "assert", "async", "await", "break", "class", "continue", "def", "del",
  "elif", "else", "except", "finally", "for", "from", "global", "if", "import", "in", "is", "lambda", "nonlocal",
  "not", "or", "pass", "raise", "return", "try", "while", "with", "yield", "match", "case",
];
const COMMON_KEYWORDS = new Set(["def", "for", "if", "import", "from", "return", "while", "class", "else", "elif", "in",
  "not", "and", "or", "None", "True", "False", "with", "try", "except", "lambda", "print"]);

// [name, signature] for built-in functions; classes that are usually called get "()" too.
const FUNCTIONS = [
  ["print", "(*values, sep=' ', end='\\n', file=None, flush=False)"], ["len", "(obj)"], ["input", "(prompt='')"],
  ["abs", "(x)"], ["all", "(iterable)"], ["any", "(iterable)"], ["ascii", "(obj)"], ["bin", "(x)"],
  ["breakpoint", "()"], ["callable", "(obj)"], ["chr", "(i)"], ["compile", "(source, filename, mode)"],
  ["delattr", "(obj, name)"], ["dir", "([obj])"], ["divmod", "(a, b)"], ["eval", "(source, globals=None, locals=None)"],
  ["exec", "(source, globals=None, locals=None)"], ["format", "(value, format_spec='')"],
  ["getattr", "(obj, name[, default])"], ["globals", "()"], ["hasattr", "(obj, name)"], ["hash", "(obj)"],
  ["help", "([obj])"], ["hex", "(x)"], ["id", "(obj)"], ["isinstance", "(obj, classinfo)"],
  ["issubclass", "(cls, classinfo)"], ["iter", "(obj)"], ["locals", "()"], ["max", "(iterable, *, key=None)"],
  ["min", "(iterable, *, key=None)"], ["next", "(iterator[, default])"], ["oct", "(x)"],
  ["open", "(file, mode='r', encoding=None)"], ["ord", "(c)"], ["pow", "(base, exp, mod=None)"], ["repr", "(obj)"],
  ["round", "(number, ndigits=None)"], ["setattr", "(obj, name, value)"], ["sorted", "(iterable, *, key=None, reverse=False)"],
  ["sum", "(iterable, /, start=0)"], ["vars", "([obj])"], ["aiter", "(async_iterable)"], ["anext", "(async_iterator[, default])"],
];
const CALLED_CLASSES = [
  ["range", "(start, stop[, step])"], ["list", "(iterable=())"], ["dict", "(**kwargs)"], ["set", "(iterable=())"],
  ["tuple", "(iterable=())"], ["str", "(object='')"], ["int", "(x=0, base=10)"], ["float", "(x=0)"], ["bool", "(x=False)"],
  ["enumerate", "(iterable, start=0)"], ["zip", "(*iterables, strict=False)"], ["map", "(function, iterable, ...)"],
  ["filter", "(function, iterable)"], ["reversed", "(sequence)"], ["frozenset", "(iterable=())"], ["bytes", "(source=b'')"],
  ["bytearray", "(source=b'')"], ["complex", "(real=0, imag=0)"], ["slice", "(start, stop[, step])"], ["super", "()"],
  ["type", "(obj)"], ["object", "()"], ["memoryview", "(obj)"],
];
const DECORATORS = ["property", "staticmethod", "classmethod"];
const EXCEPTIONS = [
  "Exception", "BaseException", "ValueError", "TypeError", "KeyError", "IndexError", "ZeroDivisionError", "AttributeError",
  "NameError", "RuntimeError", "StopIteration", "FileNotFoundError", "ImportError", "ModuleNotFoundError", "OSError",
  "KeyboardInterrupt", "NotImplementedError", "AssertionError", "ArithmeticError", "LookupError", "PermissionError",
  "TimeoutError", "UnicodeDecodeError", "UnicodeEncodeError", "RecursionError", "OverflowError", "MemoryError",
  "EOFError", "SystemExit", "Warning", "UserWarning", "DeprecationWarning", "ConnectionError", "IsADirectoryError",
  "NotADirectoryError", "FileExistsError",
];
const CONSTANTS = ["NotImplemented", "Ellipsis", "__name__"];
const MODULES = [
  "numpy", "pandas", "matplotlib", "matplotlib.pyplot", "scipy", "sklearn", "sympy", "statsmodels", "networkx", "PIL",
  "bs4", "requests", "yaml", "regex", "micropip", "math", "cmath", "random", "statistics", "decimal", "fractions",
  "os", "sys", "json", "csv", "re", "datetime", "time", "calendar", "collections", "itertools", "functools", "operator",
  "string", "textwrap", "pathlib", "typing", "dataclasses", "enum", "copy", "pprint", "heapq", "bisect", "array",
  "io", "base64", "hashlib", "uuid", "secrets", "zipfile", "gzip", "sqlite3", "asyncio", "inspect", "unittest",
  "doctest", "timeit", "abc", "contextlib", "warnings", "traceback", "shutil", "tempfile", "glob", "urllib",
  "html", "xml", "struct", "zoneinfo", "locale", "unicodedata", "difflib", "fnmatch", "logging", "argparse",
];

const BOOST = new Map([["print", 4], ...["len", "range", "input", "int", "str", "float", "list", "dict", "enumerate",
  "zip", "sorted", "sum", "min", "max", "abs", "round", "open", "isinstance", "type", "set", "tuple", "bool"].map((n) => [n, 2])]);

const SIGNATURES = new Map([...FUNCTIONS, ...CALLED_CLASSES]);
const CALLED = new Set([...FUNCTIONS.map((f) => f[0]), ...CALLED_CLASSES.map((c) => c[0])]);
const KEYWORD_SET = new Set(KEYWORDS);

const STATIC_OPTIONS = [
  ...KEYWORDS.map((k) => ({ label: k, type: "keyword", boost: COMMON_KEYWORDS.has(k) ? 1 : 0 })),
  ...FUNCTIONS.map(([n, sig]) => ({ label: n, type: "function", detail: sig })),
  ...CALLED_CLASSES.map(([n, sig]) => ({ label: n, type: "class", detail: sig })),
  ...DECORATORS.map((n) => ({ label: n, type: "class" })),
  ...EXCEPTIONS.map((n) => ({ label: n, type: "class", detail: "exception", boost: -1 })),
  ...CONSTANTS.map((n) => ({ label: n, type: "constant" })),
];

// ====================================================================== suggestions

function wantsParens(option) {
  if (option.type === "function" || option.type === "method") return true;
  return option.type === "class" && CALLED.has(option.label);
}

// Insert the name; for something you call, also "()" with the cursor inside — unless the
// "(" is already there or the context is an import, a definition or a decorator.
function applyName(view, completion, from, to) {
  const state = view.state;
  const line = state.doc.lineAt(from);
  const before = state.sliceDoc(line.from, from);
  const next = state.sliceDoc(to, to + 1);
  const noParens = next === "(" || /^\s*(from|import)\b/.test(before) || /^\s*@\s*[\w.]*$/.test(before) ||
    /\b(def|class)\s+$/.test(before) || /\bexcept\b[^:]*$/.test(before) || /\braise\s+$/.test(before) && completion.detail === "exception";
  view.dispatch({ ...insertCompletionText(state, completion.label, from, to), annotations: pickedCompletion.of(completion) });
  if (!noParens && wantsParens(completion)) {
    const tr = insertBracket(view.state, "(");
    if (tr) view.dispatch(tr);
  }
}

function decorate(o) {
  const option = { label: o.label, type: o.type, detail: o.detail || SIGNATURES.get(o.label) || "" };
  let boost = BOOST.get(o.label) ?? o.boost ?? 0;
  if (o.user) boost = Math.max(boost, 2);
  option.boost = boost;
  if (wantsParens(option)) option.apply = applyName;
  return option;
}

function inStringOrComment(state, pos) {
  for (let node = syntaxTree(state).resolveInner(pos, -1); node; node = node.parent) {
    if (node.name === "Comment") return true;
    if (node.name === "String") return true;
    if (node.name === "FormatString") return true;
    if (node.name === "FormatReplacement" || node.name === "Body" || node.name === "Script") return false;
  }
  return false;
}

function documentWords(state, skipFrom, skipTo) {
  const words = new Set();
  const text = state.doc.toString();
  const re = /[A-Za-z_][A-Za-z0-9_]{2,}/g;
  let m;
  while ((m = re.exec(text)) && words.size < 400) {
    if (m.index === skipFrom || (m.index >= skipFrom && m.index < skipTo)) continue;
    words.add(m[0]);
  }
  return words;
}

// complete(code, pos) asks the running Python for names (null when it isn't ready);
// moreWords() gives names used elsewhere (e.g. the notebook's other cells).
export function pythonCompletions(complete, moreWords) {
  return async (ctx) => {
    if (settings.suggest === false && !ctx.explicit) return null;
    const line = ctx.state.doc.lineAt(ctx.pos);
    const before = line.text.slice(0, ctx.pos - line.from);
    if (/^\s*[%!]/.test(before)) return null; // magics and shell lines
    if (inStringOrComment(ctx.state, ctx.pos)) return null;

    const imp = /^\s*(?:import|from)\s+([\w.]*)$/.exec(before) || /^\s*import\s.*,\s*([\w.]*)$/.exec(before);
    if (imp) {
      if (!imp[1] && !ctx.explicit) return null;
      return { from: ctx.pos - imp[1].length, options: MODULES.map((m) => ({ label: m, type: "namespace" })), validFor: /^[\w.]*$/ };
    }

    const word = ctx.matchBefore(/[A-Za-z_][\w.]*|\.$/);
    if (!word && !ctx.explicit) return null;
    const text = word ? word.text : "";
    const attr = text.includes(".");
    if (!attr && text.length < 1 && !ctx.explicit) return null;
    if (/^\d/.test(text)) return null;

    const res = complete ? await complete(ctx.state.doc.toString(), ctx.pos) : null;
    if (ctx.aborted) return null;
    if (attr) {
      if (!res || !res.options || !res.options.length) return null;
      return { from: res.from, options: res.options.map(decorate), validFor: /^\w*$/ };
    }
    const from = word ? word.from : ctx.pos;
    const seen = new Map();
    const lower = text.toLowerCase();
    const add = (o) => {
      if (o.label === text || seen.has(o.label)) return; // nothing to add for an exact match
      if (!o.label.toLowerCase().startsWith(lower)) return; // only names that start with what's typed
      seen.set(o.label, decorate(o));
    };
    for (const o of (res && res.options) || []) add(o);
    for (const o of STATIC_OPTIONS) add(o);
    for (const w of documentWords(ctx.state, from, ctx.pos)) add({ label: w, type: KEYWORD_SET.has(w) ? "keyword" : "variable" });
    if (moreWords) for (const w of moreWords()) if (!KEYWORD_SET.has(w)) add({ label: w, type: "variable" });
    if (!seen.size) return null;
    // Typing more letters re-asks, so the list closes once the word is complete.
    return { from, options: [...seen.values()], validFor: (t) => /^\w*$/.test(t) && !seen.has(t) };
  };
}

// Tab (and the ⇥ key above the phone keyboard): take the highlighted suggestion, or the first one.
export function acceptSuggestion(view) {
  if (completionStatus(view.state) !== "active" || !currentCompletions(view.state).length) return false;
  if (selectedCompletionIndex(view.state) == null || selectedCompletionIndex(view.state) < 0) {
    view.dispatch({ effects: setSelectedCompletion(0) });
  }
  return acceptCompletion(view);
}

// ====================================================================== mistakes

const ERR = (line, col, message, endCol) => ({ line: line + 1, col, endLine: line + 1, endCol: endCol ?? col + 1, severity: "error", message });
const COMPOUND = /^\s*(if|elif|else|for|while|def|class|try|except|finally|with|async\s+(?:def|for|with))\b/;

// A quick check that needs no Python: brackets, strings and the colon after if/for/def/...
// Used until Python is ready (or while it's busy). Same wording as Python's messages.
export function quickCheck(code) {
  const lines = code.split("\n");
  if (/^\s*%%/.test(lines[0] || "") && !/^\s*%%(time|capture|python3?|prun)\b/.test(lines[0])) return [];
  const pairs = { ")": "(", "]": "[", "}": "{" };
  const stack = [];
  let str = null; // {q, triple, line, col}
  let logicalStart = 0;
  let topColon = false;
  let lastSig = null; // [line, col] of the last code character in the logical line
  for (let li = 0; li < lines.length; li++) {
    const text = lines[li];
    if (li === 0 && /^\s*%%/.test(text)) {
      logicalStart = 1;
      continue;
    }
    if (!str && !stack.length && li === logicalStart && /^\s*[%!]/.test(text)) {
      logicalStart = li + 1;
      continue;
    }
    let i = 0;
    while (i < text.length) {
      const c = text[i];
      if (str) {
        if (c === "\\") {
          i += 2;
          continue;
        }
        if (str.triple ? text.startsWith(str.q.repeat(3), i) : c === str.q) {
          i += str.triple ? 3 : 1;
          lastSig = [li, i - 1];
          str = null;
          continue;
        }
        i++;
        continue;
      }
      if (c === "#") break;
      if (c === '"' || c === "'") {
        const triple = text.startsWith(c.repeat(3), i);
        str = { q: c, triple, line: li, col: i };
        i += triple ? 3 : 1;
        continue;
      }
      if (c === "(" || c === "[" || c === "{") stack.push({ ch: c, line: li, col: i });
      else if (c === ")" || c === "]" || c === "}") {
        const top = stack.pop();
        if (!top) return [ERR(li, i, `unmatched '${c}'`)];
        if (top.ch !== pairs[c]) return [ERR(li, i, `closing parenthesis '${c}' does not match opening parenthesis '${top.ch}'`)];
      } else if (c === ":" && !stack.length && text[i + 1] !== "=") topColon = true;
      if (c !== " " && c !== "\t") lastSig = [li, i];
      i++;
    }
    if (str && !str.triple) {
      if (/\\$/.test(text)) continue;
      return [ERR(str.line, str.col, "unterminated string literal", text.length)];
    }
    const continued = !str && /\\\s*$/.test(text.replace(/#.*$/, ""));
    if (!str && !stack.length && !continued) {
      if (COMPOUND.test(lines[logicalStart] || "") && !topColon && lastSig) {
        return [ERR(lastSig[0], lastSig[1], "expected ':'")];
      }
      logicalStart = li + 1;
      topColon = false;
      lastSig = null;
    }
  }
  if (str) return [ERR(str.line, str.col, "unterminated triple-quoted string literal", str.col + 3)];
  if (stack.length) {
    const top = stack[stack.length - 1];
    return [ERR(top.line, top.col, `'${top.ch}' was never closed`)];
  }
  return [];
}

// Python counts characters (code points); the editor counts UTF-16 units.
function lineOffset(text, col) {
  let units = 0;
  let n = 0;
  for (const ch of text) {
    if (n >= col) break;
    units += ch.length;
    n++;
  }
  return units;
}

function toDiagnostics(state, items) {
  const doc = state.doc;
  const head = state.selection.main.head;
  const headLine = doc.lineAt(head).number;
  const out = [];
  for (const it of items) {
    const ln = doc.line(Math.min(Math.max(1, it.line), doc.lines));
    let from = ln.from + Math.min(lineOffset(ln.text, it.col), ln.length);
    const eln = doc.line(Math.min(Math.max(ln.number, it.endLine || it.line), doc.lines));
    let to = eln.from + Math.min(lineOffset(eln.text, it.endCol ?? it.col + 1), eln.length);
    if (from >= ln.to && ln.length) from = ln.to - 1;
    if (to <= from) to = Math.min(from + 1, Math.max(eln.to, from));
    // Don't nag about the word being typed right now, or a block that's about to be written.
    if (it.severity === "warning" && head >= from && head <= to) continue;
    if (/expected an indented block/.test(it.message) && Math.abs(headLine - ln.number) <= 1 && !doc.lineAt(head).text.trim()) continue;
    const message = it.message.charAt(0).toUpperCase() + it.message.slice(1);
    const d = { from, to, severity: it.severity === "error" ? "error" : "warning", message };
    if (it.fix) {
      d.actions = [{ name: `Change to ${it.fix}`, apply: (view, f, t) => view.dispatch({ changes: { from: f, to: t, insert: it.fix } }) }];
      d.fix = it.fix;
    }
    out.push(d);
  }
  return out.sort((a, b) => a.from - b.from);
}

function collect(state) {
  const list = [];
  forEachDiagnostic(state, (d, from, to) => list.push({ d, from, to }));
  return list.sort((a, b) => (a.d.severity === b.d.severity ? a.from - b.from : a.d.severity === "error" ? -1 : 1));
}

const diagnosticsChanged = (u) => u.docChanged || u.transactions.some((tr) => tr.effects.some((e) => e.is(setDiagnosticsEffect)));

// Marks every line that has a problem.
const markLines = ViewPlugin.fromClass(class {
  constructor(view) {
    this.decorations = this.build(view.state);
  }
  update(u) {
    if (diagnosticsChanged(u)) this.decorations = this.build(u.state);
  }
  build(state) {
    const lines = new Map();
    forEachDiagnostic(state, (d, from) => {
      const l = state.doc.lineAt(from).from;
      if (lines.get(l) !== "error") lines.set(l, d.severity);
    });
    const b = new RangeSetBuilder();
    for (const [from, sev] of [...lines].sort((a, b) => a[0] - b[0])) {
      b.add(from, from, Decoration.line({ class: sev === "error" ? "cm-problemLine cm-problemLine-error" : "cm-problemLine cm-problemLine-warning" }));
    }
    return b.finish();
  }
}, { decorations: (v) => v.decorations });

// The bar under the code: the most important problem, where it is, and a fix if there is one.
const problemBar = showPanel.of((view) => {
  const dom = document.createElement("div");
  dom.className = "cm-problemBar";
  dom.setAttribute("role", "status");
  const render = (state) => {
    const list = collect(state);
    dom.replaceChildren();
    dom.hidden = !list.length;
    if (!list.length) return;
    const { d, from, to } = list[0];
    dom.dataset.severity = d.severity;
    const lineNo = state.doc.lineAt(from).number;
    const msg = document.createElement("button");
    msg.type = "button";
    msg.className = "cm-problemMsg";
    msg.title = "Go to the problem";
    msg.innerHTML = `<span class="cm-problemIcon" aria-hidden="true">${d.severity === "error" ? "!" : "?"}</span>`;
    const t = document.createElement("span");
    t.textContent = (state.doc.lines > 1 ? `Line ${lineNo}: ` : "") + d.message;
    msg.append(t);
    msg.addEventListener("mousedown", (e) => e.preventDefault());
    msg.addEventListener("click", () => {
      view.dispatch({ selection: { anchor: from }, scrollIntoView: true });
      view.focus();
    });
    dom.append(msg);
    if (d.fix) {
      const fix = document.createElement("button");
      fix.type = "button";
      fix.className = "cm-problemFix";
      fix.textContent = `Change to ${d.fix}`;
      fix.addEventListener("mousedown", (e) => e.preventDefault());
      fix.addEventListener("click", () => view.dispatch({ changes: { from, to, insert: d.fix }, userEvent: "input.fix" }));
      dom.append(fix);
    }
    if (list.length > 1) {
      const more = document.createElement("span");
      more.className = "cm-problemMore";
      more.textContent = `+${list.length - 1} more`;
      dom.append(more);
    }
  };
  render(view.state);
  return { dom, top: false, update: (u) => diagnosticsChanged(u) && render(u.state) };
});

// lint(code) asks the running Python (null when it isn't ready; the quick check is used then).
export function pythonMistakes(lint) {
  const source = async (view) => {
    if (settings.checkCode === false) return [];
    const state = view.state;
    const code = state.doc.toString();
    if (!code.trim()) return [];
    let items = null;
    try {
      items = lint ? await lint(code) : null;
    } catch {
      items = null;
    }
    if (!items) items = quickCheck(code);
    return toDiagnostics(state, items);
  };
  const needsRefresh = (u) => u.transactions.some((tr) => tr.effects.some((e) => e.is(recheckEffect)));
  return [linter(source, { delay: 700, needsRefresh }), markLines, problemBar];
}

const recheckEffect = StateEffect.define();

// Check again although the code didn't change (e.g. Python just became ready, or a cell
// that defines names has run).
export function recheck(view) {
  if (view && !view.destroyed) view.dispatch({ effects: recheckEffect.of(null) });
}

export { EditorView };
