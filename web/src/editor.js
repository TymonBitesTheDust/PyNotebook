// CodeMirror editor setup and static syntax highlighting for read mode.

import { EditorView, keymap, drawSelection, highlightSpecialChars, lineNumbers, placeholder as cmPlaceholder } from "@codemirror/view";
import { EditorState, Compartment, Annotation, Transaction } from "@codemirror/state";
import { defaultKeymap, history, historyKeymap, indentWithTab, indentLess, indentMore } from "@codemirror/commands";
import { indentOnInput, bracketMatching, syntaxHighlighting, indentUnit } from "@codemirror/language";
import { closeBrackets, closeBracketsKeymap, autocompletion, completionKeymap } from "@codemirror/autocomplete";
import { searchKeymap, highlightSelectionMatches } from "@codemirror/search";
import { python, pythonLanguage } from "@codemirror/lang-python";
import { markdown } from "@codemirror/lang-markdown";
import { tags as t, tagHighlighter, highlightCode } from "@lezer/highlight";
import { settings } from "./settings.js";
import { pythonCompletions, acceptSuggestion, pythonMistakes } from "./assist.js";

export const highlighter = tagHighlighter([
  { tag: t.keyword, class: "tk-kw" },
  { tag: [t.controlKeyword, t.moduleKeyword, t.definitionKeyword, t.operatorKeyword], class: "tk-kw" },
  { tag: [t.bool, t.null, t.atom], class: "tk-atom" },
  { tag: [t.string, t.special(t.string), t.regexp], class: "tk-str" },
  { tag: t.escape, class: "tk-esc" },
  { tag: [t.number, t.integer, t.float], class: "tk-num" },
  { tag: t.comment, class: "tk-com" },
  { tag: [t.function(t.variableName), t.function(t.propertyName)], class: "tk-fn" },
  { tag: t.definition(t.variableName), class: "tk-def" },
  { tag: [t.definition(t.className), t.className, t.typeName], class: "tk-cls" },
  { tag: t.self, class: "tk-self" },
  { tag: t.propertyName, class: "tk-prop" },
  { tag: [t.operator, t.compareOperator, t.arithmeticOperator, t.logicOperator, t.bitwiseOperator, t.updateOperator], class: "tk-op" },
  { tag: t.meta, class: "tk-meta" },
  { tag: [t.heading], class: "tk-heading" },
  { tag: t.emphasis, class: "tk-em" },
  { tag: t.strong, class: "tk-strong" },
  { tag: [t.link, t.url], class: "tk-link" },
  { tag: t.monospace, class: "tk-mono" },
  { tag: t.invalid, class: "tk-invalid" },
]);

function esc(s) {
  return s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
}

// Lines starting with % or ! (IPython magics) are shown as "meta" instead of confusing the parser.
export function highlightCodeHtml(code, lang = "python") {
  if (lang !== "python") return esc(code);
  if (code.length > 200000) return esc(code);
  // Blank out magic lines for the parser (same length keeps positions aligned).
  const magic = [];
  let parseCode = code.replace(/^[ \t]*(?:%|!)[^\n]*$/gm, (m, offset) => {
    magic.push([offset, offset + m.length]);
    return " ".repeat(m.length);
  });
  const inMagic = (from, to) => magic.some(([a, b]) => from < b && to > a);
  let html = "";
  let pos = 0;
  const tree = pythonLanguage.parser.parse(parseCode);
  highlightCode(
    parseCode,
    tree,
    highlighter,
    (text, classes) => {
      const orig = code.slice(pos, pos + text.length);
      const cls = inMagic(pos, pos + text.length) ? "tk-magic" : classes;
      pos += text.length;
      html += cls ? `<span class="${cls}">${esc(orig)}</span>` : esc(orig);
    },
    () => {
      pos += 1;
      html += "\n";
    },
  );
  return html;
}

// Wraps each line of highlighted HTML in a block that CSS numbers (highlighted
// spans never cross a line break, so splitting the HTML on "\n" is safe).
export function numberLines(html) {
  const lines = html.split("\n");
  return {
    html: lines.map((line, i) => `<span class="cl" data-n="${i + 1}">${line}</span>`).join(""),
    digits: String(lines.length).length,
  };
}

const wrapComp = new Compartment();
const numbersComp = new Compartment();
// Which editors may show line numbers (Python code, not the console's one-liners).
const numberable = new WeakMap();
const numbersFor = (view) => (settings.lineNumbers && numberable.get(view) ? lineNumbers() : []);

// Marks edits copied from another view of the same file (split view), so they aren't echoed back.
export const remoteEdit = Annotation.define();

export function applyRemoteChanges(view, changes) {
  view.dispatch({ changes, annotations: [remoteEdit.of(true), Transaction.addToHistory.of(false)] });
}

// complete(code, pos) and lint(code) ask the running Python; both may answer null.
export function createEditor(parent, { doc, lang = "python", numbers = true, onChange, onUpdate, onRun, onRunInPlace, onEscape, onFocus, onBlur, complete, lint, words, placeholder }) {
  const runKeys = [
    { key: "Shift-Enter", run: () => { onRun && onRun(); return true; } },
    { key: "Mod-Enter", run: () => { onRunInPlace && onRunInPlace(); return true; } },
    { key: "Escape", run: () => { onEscape && onEscape(); return true; } },
  ];
  const pySource = pythonCompletions(complete, words);
  const completionSource = async (ctx) => {
    if (lang !== "python") return null;
    if (ctx.view && !ctx.view.hasFocus) return null;
    const res = await pySource(ctx);
    // The answer may arrive after the person moved on (blur, another pane).
    if (ctx.aborted || (ctx.view && !ctx.view.hasFocus)) return null;
    return res;
  };
  const extensions = [
    highlightSpecialChars(),
    history(),
    drawSelection(),
    indentUnit.of("    "),
    EditorState.tabSize.of(4),
    indentOnInput(),
    bracketMatching(),
    closeBrackets(),
    highlightSelectionMatches(),
    syntaxHighlighting(highlighter),
    // Nothing is pre-selected, so Enter still starts a new line; Tab or a tap inserts a suggestion.
    autocompletion({ override: [completionSource], activateOnTyping: true, icons: true, selectOnOpen: false, maxRenderedOptions: 50, interactionDelay: 0 }),
    keymap.of([...runKeys, ...closeBracketsKeymap, ...defaultKeymap, ...searchKeymap, ...historyKeymap, ...completionKeymap,
      { key: "Tab", run: acceptSuggestion }, indentWithTab]),
    lang === "python" ? pythonMistakes(lint) : [],
    lang === "python" ? python() : lang === "markdown" ? markdown() : [],
    wrapComp.of(settings.wrap ? EditorView.lineWrapping : []),
    numbersComp.of(settings.lineNumbers && numbers && lang === "python" ? lineNumbers() : []),
    EditorView.contentAttributes.of({ autocorrect: "off", autocapitalize: "off", spellcheck: lang === "markdown" ? "true" : "false", "aria-label": lang === "markdown" ? "Text cell" : "Code" }),
    EditorView.updateListener.of((u) => {
      if (u.docChanged && onUpdate) onUpdate(u, u.transactions.some((tr) => tr.annotation(remoteEdit)));
      if (u.docChanged && onChange) onChange(u.state.doc.toString());
      if (u.focusChanged) {
        if (u.view.hasFocus) onFocus && onFocus(u.view);
        else onBlur && onBlur(u.view);
      }
    }),
  ];
  if (placeholder) extensions.push(cmPlaceholder(placeholder));
  const view = new EditorView({ state: EditorState.create({ doc, extensions }), parent });
  numberable.set(view, numbers && lang === "python");
  return view;
}

export function insertText(view, text, { cursorOffset } = {}) {
  const sel = view.state.selection.main;
  const off = cursorOffset ?? text.length;
  view.dispatch({
    changes: { from: sel.from, to: sel.to, insert: text },
    selection: { anchor: sel.from + off },
    scrollIntoView: true,
    userEvent: "input.type",
  });
  view.focus();
}

export function moveCursor(view, delta) {
  const sel = view.state.selection.main;
  const pos = Math.max(0, Math.min(view.state.doc.length, sel.head + delta));
  view.dispatch({ selection: { anchor: pos }, scrollIntoView: true });
  view.focus();
}

export function indent(view, more) {
  (more ? indentMore : indentLess)(view);
  view.focus();
}

// The ⇥ key above the phone keyboard: insert the suggestion if one is showing, else indent.
export function tabKey(view) {
  if (!acceptSuggestion(view)) indentMore(view);
  view.focus();
}

export function applyEditorSettings(view) {
  view.dispatch({
    effects: [
      wrapComp.reconfigure(settings.wrap ? EditorView.lineWrapping : []),
      numbersComp.reconfigure(numbersFor(view)),
    ],
  });
}
