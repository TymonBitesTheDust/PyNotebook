// Pieces shared by the notebook, console and script screens.

import { el, icon, actionSheet, confirmDialog, toast, panel, formatBytes, promptDialog } from "./ui.js";
import { applyMessage, renderOutput } from "./outputs.js";
import { bridge } from "./bridge.js";
import { createEditor, insertText, moveCursor, indent } from "./editor.js";

// ------------------------------------------------------------ output area with node reuse

const versions = new WeakMap();
export function bump(o) {
  versions.set(o, (versions.get(o) || 0) + 1);
}

export function saveErrorText(e) {
  const msg = (e && e.message) || "";
  if (!msg || /readonly/i.test(msg)) return "The app that shared this file only allows reading it. Save a copy somewhere else instead.";
  return msg + " Save a copy somewhere else instead.";
}

// Minimal event emitter used by documents to keep their views in sync.
export class Emitter {
  constructor() {
    this._handlers = new Map();
  }

  on(name, fn) {
    if (!this._handlers.has(name)) this._handlers.set(name, new Set());
    this._handlers.get(name).add(fn);
    return () => this._handlers.get(name).delete(fn);
  }

  emit(name, data) {
    for (const fn of [...(this._handlers.get(name) || [])]) {
      try {
        fn(data);
      } catch (e) {
        console.error(e);
      }
    }
  }
}

export class OutputArea {
  constructor(container) {
    this.el = container;
    this.cache = new WeakMap();
    this.frame = 0;
    this.latest = null;
  }

  render(outputs) {
    const nodes = [];
    for (const o of outputs) {
      const v = versions.get(o) || 0;
      const c = this.cache.get(o);
      if (c && c.v === v) {
        nodes.push(c.node);
        continue;
      }
      const node = renderOutput(o);
      node.classList.add("output");
      this.cache.set(o, { v, node });
      nodes.push(node);
    }
    const current = Array.from(this.el.children);
    if (current.length === nodes.length && current.every((n, i) => n === nodes[i])) return;
    this.el.replaceChildren(...nodes);
  }

  schedule(outputs) {
    this.latest = outputs;
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.render(this.latest);
    });
  }
}

// ------------------------------------------------------------ execution helper

export function showStatus(node, text, isError) {
  if (!node) return;
  if (!text) {
    node.replaceChildren();
    node.hidden = true;
    return;
  }
  node.hidden = false;
  const line = el("div", { class: "status-line" + (isError ? " error" : "") }, text);
  node.append(line);
  while (node.children.length > 3) node.firstChild.remove();
}

export function showStdin(host, req, answer, { focus = true } = {}) {
  const input = el("input", {
    class: "stdin-field",
    type: req.password ? "password" : "text",
    autocapitalize: "off",
    autocomplete: "off",
    autocorrect: "off",
    spellcheck: "false",
    enterkeyhint: "send",
    "aria-label": req.prompt || "Input",
  });
  const submit = () => {
    const v = input.value;
    box.remove();
    answer(v);
  };
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      submit();
    }
  });
  const box = el("form", { class: "stdin", onsubmit: (e) => { e.preventDefault(); submit(); } },
    el("label", { class: "stdin-prompt" }, req.prompt || "Input:"),
    el("div", { class: "stdin-row" }, input, el("button", { class: "btn primary small", type: "submit" }, "Enter")),
  );
  host.replaceChildren(box);
  host.hidden = false;
  setTimeout(() => {
    if (focus) input.focus();
    box.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, 30);
  return box;
}

export function execInto(kernel, code, target, opts = {}) {
  const state = { clearPending: false };
  return kernel.execute(code, {
    onStart: () => target.onStart && target.onStart(),
    onOutput: (msg) => {
      if (msg.type === "status") {
        showStatus(target.statusEl, msg.text, msg.error);
        return;
      }
      const idx = applyMessage(target.outputs, msg, state);
      if (idx >= 0) bump(target.outputs[idx]);
      target.area.schedule(target.outputs);
      target.onOutput && target.onOutput(msg);
    },
    onInput: (req, answer) => showStdin(target.stdinEl, req, (v) => {
      target.stdinEl.hidden = true;
      answer(v);
    }),
  }, opts);
}

// ------------------------------------------------------------ kernel status chip

const STATE_LABEL = { off: "Python off", starting: "Starting…", idle: "Ready", busy: "Running", dead: "Stopped" };

export function kernelChip(kernel, onTap) {
  const dot = el("span", { class: "chip-dot" });
  const label = el("span", { class: "chip-label" }, STATE_LABEL[kernel.state]);
  const chip = el("button", { class: "kernel-chip", type: "button", "data-state": kernel.state, onclick: onTap, "aria-label": "Python status" }, dot, label);
  const update = (s, text) => {
    chip.dataset.state = s;
    // Fixed, short labels so the buttons beside the chip don't move as Python starts.
    label.textContent = STATE_LABEL[s];
    chip.title = text || STATE_LABEL[s];
  };
  return { chip, update };
}

export async function interruptOrRestart(kernel) {
  if (kernel.state !== "busy" && !kernel.inputWaiting) return;
  if (kernel.interrupt()) {
    toast("Interrupting…");
    return;
  }
  const ok = await confirmDialog(
    "Stop by restarting Python?",
    "This device can't interrupt a running cell, so Python has to restart. Variables and imports will be lost.",
    "Restart",
    true,
  );
  if (ok) {
    kernel.restart();
  }
}

export function kernelMenu(kernel, { onRestartRunAll } = {}) {
  const info = kernel.info;
  actionSheet(info ? `Python ${info.python} · Pyodide ${info.pyodide}` : "Python", [
    kernel.state === "off" || kernel.state === "dead" ? { icon: "play", label: "Start Python", onClick: () => kernel.restart() } : null,
    kernel.state === "busy" ? { icon: "stop", label: "Interrupt", onClick: () => interruptOrRestart(kernel) } : null,
    kernel.state !== "off" ? { icon: "restart", label: "Restart Python", hint: "Clears all variables", onClick: () => kernel.restart() } : null,
    onRestartRunAll ? { icon: "playAll", label: "Restart and run all", onClick: onRestartRunAll } : null,
  ]);
}

// ------------------------------------------------------------ symbol bar shown above the keyboard

const KEYS = [
  { label: "⇥", title: "Indent", act: (v) => indent(v, true) },
  { label: "⇤", title: "Dedent", act: (v) => indent(v, false) },
  { label: "( )", ins: "()", off: 1 },
  { label: "[ ]", ins: "[]", off: 1 },
  { label: "{ }", ins: "{}", off: 1 },
  { label: ":", ins: ":" },
  { label: "=", ins: "=" },
  { label: '"', ins: '""', off: 1 },
  { label: "'", ins: "''", off: 1 },
  { label: "#", ins: "# " },
  { label: "_", ins: "_" },
  { label: ".", ins: "." },
  { label: ",", ins: ", " },
  { label: "+", ins: "+" },
  { label: "-", ins: "-" },
  { label: "*", ins: "*" },
  { label: "/", ins: "/" },
  { label: "<", ins: "<" },
  { label: ">", ins: ">" },
  { label: "!", ins: "!" },
  { label: "%", ins: "%" },
  { label: "←", title: "Left", act: (v) => moveCursor(v, -1) },
  { label: "→", title: "Right", act: (v) => moveCursor(v, 1) },
];

export function createKeybar({ getView, onRun, onDone }) {
  const bar = el("div", { class: "keybar", role: "toolbar", "aria-label": "Code symbols" });
  const scroller = el("div", { class: "keybar-keys" });
  const keep = (e) => e.preventDefault();
  for (const k of KEYS) {
    const b = el("button", { class: "key", type: "button", title: k.title || k.label, "aria-label": k.title || k.label }, k.label);
    b.addEventListener("mousedown", keep);
    b.addEventListener("click", () => {
      const v = getView();
      if (!v) return;
      if (k.act) k.act(v);
      else insertText(v, k.ins, { cursorOffset: k.off });
    });
    scroller.append(b);
  }
  const run = el("button", { class: "key key-run", type: "button", "aria-label": "Run", title: "Run" }, icon("play", 20));
  run.addEventListener("mousedown", keep);
  run.addEventListener("click", () => onRun && onRun());
  const done = el("button", { class: "key key-done", type: "button", "aria-label": "Hide keyboard", title: "Done" }, icon("check", 20));
  done.addEventListener("mousedown", keep);
  done.addEventListener("click", () => onDone && onDone());
  bar.append(scroller, run, done);
  return bar;
}

// ------------------------------------------------------------ files panel (Python's working folder)

export async function openFilesPanel(kernel) {
  let cwd = "";
  let root = null; // null: the app's own folder; "/mnt/<name>": a folder on this computer
  let mounts = [];
  const canMount = typeof window.showDirectoryPicker === "function" && !bridge.isAndroid;
  const list = el("div", { class: "file-list" });
  const crumbs = el("div", { class: "file-crumbs" });
  const areas = el("div", { class: "seg file-areas", role: "radiogroup", "aria-label": "Working folder" });
  const note = el("p", { class: "panel-note" });
  const fs = (op, path, data) => kernel.fs(op, path, data, root);
  const label = (m) => m.split("/").pop();

  const renderAreas = () => {
    areas.replaceChildren();
    areas.hidden = !mounts.length;
    const opt = (value, text) => {
      const on = value === root;
      const b = el("button", { class: "seg-btn" + (on ? " on" : ""), type: "button", role: "radio", "aria-checked": String(on) }, text);
      b.onclick = async () => {
        root = value;
        cwd = "";
        try {
          await kernel.fs("chdir", "", null, root);
        } catch (e) {
          toast(e.message);
        }
        renderAreas();
        refresh();
      };
      areas.append(b);
    };
    opt(null, bridge.isAndroid ? "App folder" : "PyNotebook folder");
    for (const m of mounts) opt(m, label(m));
    note.textContent = root
      ? `This is the folder "${label(root)}" on your computer. Your code opens and saves these files directly, by name.`
      : "Files here are what your code sees (the working folder). They stay on this device between sessions.";
  };

  const refresh = async () => {
    list.replaceChildren(el("div", { class: "empty" }, "Loading…"));
    crumbs.replaceChildren();
    const parts = cwd.split("/").filter(Boolean);
    crumbs.append(el("button", { class: "crumb", type: "button", onclick: () => { cwd = ""; refresh(); } }, root ? label(root) : "home"));
    parts.forEach((p, i) => {
      crumbs.append(el("span", { class: "crumb-sep" }, "/"),
        el("button", { class: "crumb", type: "button", onclick: () => { cwd = parts.slice(0, i + 1).join("/"); refresh(); } }, p));
    });
    let entries;
    try {
      entries = await fs("list", cwd);
    } catch (e) {
      list.replaceChildren(el("div", { class: "empty" }, e.message));
      return;
    }
    list.replaceChildren();
    if (!entries.length) list.append(el("div", { class: "empty" }, root ? "This folder is empty." : "No files yet. Add files to use them in your code."));
    for (const f of entries) {
      const path = (cwd ? cwd + "/" : "") + f.name;
      const row = el("button", { class: "file-row", type: "button" },
        icon(f.dir ? "folder" : "file", 20),
        el("span", { class: "file-name" }, f.name),
        el("span", { class: "file-meta" }, f.dir ? "" : formatBytes(f.size)),
      );
      row.onclick = () => {
        if (f.dir) {
          cwd = path;
          refresh();
          return;
        }
        actionSheet(f.name, [
          { icon: "download", label: bridge.isAndroid ? "Save to phone" : "Save a copy…", onClick: async () => {
            try {
              const data = await fs("read", path);
              const r = await bridge.createDocument(f.name, "application/octet-stream", null, data);
              if (r) toast("Saved " + r.name);
            } catch (e) {
              toast(e.message);
            }
          } },
          { icon: "copy", label: "Copy path", onClick: () => {
            navigator.clipboard?.writeText(path).then(() => toast("Copied " + path), () => toast(path));
          } },
          { icon: "del", label: "Delete", danger: true, onClick: async () => {
            const where = root ? `the folder "${label(root)}" on your computer` : "the working folder";
            if (await confirmDialog(`Delete ${f.name}?`, `This removes it from ${where}.`, "Delete", true)) {
              await fs("delete", path);
              refresh();
            }
          } },
        ]);
      };
      list.append(row);
    }
  };

  const add = el("button", { class: "btn primary", type: "button" }, icon("upload", 18), " Add files");
  add.onclick = async () => {
    let files;
    try {
      files = await bridge.pickFiles();
    } catch (e) {
      toast(e.message);
      return;
    }
    if (!files || !files.length) return;
    for (const f of files) {
      await fs("write", (cwd ? cwd + "/" : "") + f.name, f.base64);
    }
    toast(files.length === 1 ? `Added ${files[0].name}` : `Added ${files.length} files`);
    refresh();
  };
  const mk = el("button", { class: "btn", type: "button" }, icon("folder", 18), " New folder");
  mk.onclick = async () => {
    const name = await promptDialog("New folder", "", "Create", "folder name");
    if (!name) return;
    await fs("mkdir", (cwd ? cwd + "/" : "") + name.replace(/\//g, "_"));
    refresh();
  };
  const useFolder = el("button", { class: "btn", type: "button", hidden: !canMount }, icon("folder", 18), " Use a folder on this PC…");
  useFolder.onclick = async () => {
    let handle;
    try {
      handle = await window.showDirectoryPicker({ mode: "readwrite", id: "pynotebook-folder" });
    } catch (e) {
      if (e && e.name !== "AbortError") toast(e.message);
      return;
    }
    try {
      const r = await kernel.mountFolder(handle);
      if (!mounts.includes(r.path)) mounts.push(r.path);
      root = r.path;
      cwd = "";
      toast(`Your code now works in "${r.name}"`);
      renderAreas();
      refresh();
    } catch (e) {
      toast("Couldn't use that folder: " + e.message);
    }
  };
  panel("Files", el("div", null, areas, note, el("div", { class: "panel-actions" }, add, mk, useFolder), crumbs, list));
  try {
    const w = await kernel.fs("where", "");
    mounts = w.mounts || [];
    root = mounts.find((m) => w.cwd === m || w.cwd.startsWith(m + "/")) || null;
  } catch {}
  renderAreas();
  refresh();
}

// ------------------------------------------------------------ editor wrapper for a single editable area

export { createEditor };
