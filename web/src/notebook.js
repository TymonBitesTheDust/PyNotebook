// Notebooks: NotebookDoc owns the model, the Python kernel and saving; NotebookView
// renders one scrollable view of it inside a pane. Several views of the same doc can be
// open at once (split view); they stay in sync through doc events.

import { el, icon, iconButton, actionSheet, toast, confirmDialog, dialog, promptDialog, panel, debounce } from "./ui.js";
import { createEditor, highlightCodeHtml, applyEditorSettings } from "./editor.js";
import { recheck } from "./assist.js";
import { renderMarkdown, headingsOf } from "./markdown.js";
import { applyMessage, wireLinks, slug } from "./outputs.js";
import { OutputArea, Emitter, bump, saveErrorText, kernelChip, kernelMenu, interruptOrRestart, openFilesPanel, showStatus, showStdin } from "./common.js";
import { Kernel } from "./kernel.js";
import { newCell, serializeNotebook, notebookToPython } from "./nbformat.js";
import { settings, onSettings } from "./settings.js";

// ======================================================================= document

export class NotebookDoc extends Emitter {
  constructor(app, { uri, name, model, writable, dirty }) {
    super();
    this.app = app;
    this.type = "notebook";
    this.uri = uri;
    this.name = name;
    this.model = model;
    if (!model.cells.length) model.cells.push(newCell("code"));
    this.writable = !!writable;
    this.dirty = !!dirty;
    this.views = new Set();
    this.retainers = 0;
    this.running = false;
    this.abortRun = false;
    this.stdin = null;
    this.kernel = new Kernel({ onState: (s, t) => this._kernelState(s, t) });
    this.saveDraftSoon = debounce(() => this.app.saveDraft(this), 1500);
    if (settings.autoStart && !app.anyKernelStarted()) setTimeout(() => this.kernel.start().catch(() => {}), 400);
  }

  get cells() {
    return this.model.cells;
  }

  indexOf(cellOrId) {
    const id = typeof cellOrId === "string" ? cellOrId : cellOrId && cellOrId.id;
    return this.model.cells.findIndex((c) => c.id === id);
  }

  cellById(id) {
    return this.model.cells.find((c) => c.id === id) || null;
  }

  markDirty() {
    if (!this.dirty) {
      this.dirty = true;
      this.emit("dirty");
    }
    this.saveDraftSoon();
  }

  // ------------------------------------------------------------------ edits (all views are notified)

  setSource(cell, text, fromView) {
    if (cell.source === text) return;
    cell.source = text;
    this.markDirty();
    this.emit("source", { cell, fromView });
  }

  insertCell(index, type, source = "", fromView = null) {
    const cell = newCell(type, source);
    return this.insertExisting(index, cell, fromView);
  }

  insertExisting(index, cell, fromView = null) {
    index = Math.max(0, Math.min(index, this.model.cells.length));
    this.model.cells.splice(index, 0, cell);
    this.markDirty();
    this.emit("insert", { index, cell, fromView });
    return cell;
  }

  deleteCell(cell, fromView = null) {
    const i = this.indexOf(cell);
    if (i < 0) return -1;
    this.model.cells.splice(i, 1);
    this.emit("delete", { index: i, cell, fromView });
    if (!this.model.cells.length) this.insertCell(0, "code");
    this.markDirty();
    return i;
  }

  moveCell(cell, delta) {
    const i = this.indexOf(cell);
    const j = i + delta;
    if (i < 0 || j < 0 || j >= this.model.cells.length) return false;
    const cells = this.model.cells;
    [cells[i], cells[j]] = [cells[j], cells[i]];
    this.markDirty();
    this.emit("move", { from: i, to: j, cell });
    return true;
  }

  changeType(cell, type) {
    if (cell.type === type) return;
    cell.type = type;
    if (type !== "code") {
      cell.outputs = [];
      cell.execution_count = null;
    }
    this.markDirty();
    this.emit("replace", { cell });
  }

  duplicateCell(cell, fromView = null) {
    const c = newCell(cell.type, cell.source);
    c.metadata = JSON.parse(JSON.stringify(cell.metadata || {}));
    return this.insertExisting(this.indexOf(cell) + 1, c, fromView);
  }

  clearOutput(cell) {
    cell.outputs = [];
    cell.execution_count = null;
    cell._elapsed = null;
    cell._state = null;
    this.emit("cell", { cell });
  }

  clearAllOutputs() {
    for (const c of this.model.cells) if (c.type === "code") this.clearOutput(c);
    this.markDirty();
  }

  // ------------------------------------------------------------------ running

  async runCell(cell) {
    if (!cell.source.trim()) {
      this.clearOutput(cell);
      return { status: "ok" };
    }
    cell.outputs = [];
    cell._state = "queued";
    cell._elapsed = null;
    this.emit("cell", { cell });
    let t0 = 0;
    let res;
    const state = { clearPending: false };
    try {
      res = await this.kernel.execute(cell.source, {
        onStart: () => {
          cell._state = "running";
          t0 = performance.now();
          this.emit("state", { cell });
        },
        onOutput: (msg) => {
          if (msg.type === "status") {
            this.emit("status", { cell, text: msg.text, error: msg.error });
            return;
          }
          const idx = applyMessage(cell.outputs, msg, state);
          if (idx >= 0) bump(cell.outputs[idx]);
          this.emit("outputs", { cell });
        },
        onInput: (req, answer) => {
          this.stdin = { cell, req, answer };
          this.emit("stdin", { cell, req });
        },
      });
      cell.execution_count = res.execution_count;
      cell._state = res.status === "ok" ? null : "error";
    } catch (e) {
      if (e.cancelled) {
        cell._state = null;
      } else {
        cell._state = "error";
        cell.outputs.push({ output_type: "error", ename: "KernelError", evalue: e.message, traceback: ["\x1b[1;31mPython stopped\x1b[0m: " + e.message] });
      }
      res = { status: "error", cancelled: e.cancelled };
    } finally {
      cell._elapsed = t0 ? (performance.now() - t0) / 1000 : null;
      if (this.stdin && this.stdin.cell === cell) this.stdin = null;
      this.emit("stdin-done", { cell });
      this.emit("status", { cell, text: null });
      this.emit("cell", { cell });
      this.markDirty();
    }
    return res;
  }

  answerInput(text) {
    const s = this.stdin;
    if (!s) return;
    this.stdin = null;
    this.emit("stdin-done", { cell: s.cell });
    s.answer(text);
  }

  // Run cells [from, to). `follow` is the view that should scroll along.
  async runRange(from, to, follow = null) {
    if (this.running) {
      toast("Already running cells");
      return;
    }
    const cells = this.model.cells.slice(from, to).filter((c) => c.type === "code" && c.source.trim());
    if (!cells.length) return;
    this.running = true;
    this.abortRun = false;
    for (const c of cells) {
      c._state = "queued";
      this.emit("state", { cell: c });
    }
    try {
      for (const c of cells) {
        if (this.abortRun) break;
        if (this.indexOf(c) < 0) continue;
        if (follow) this.emit("follow", { cell: c, view: follow });
        const r = await this.runCell(c);
        if (r.status !== "ok") {
          this.abortRun = true;
          break;
        }
      }
    } finally {
      for (const c of cells) {
        if (c._state === "queued") {
          c._state = null;
          this.emit("state", { cell: c });
        }
      }
      this.running = false;
    }
  }

  runAll(follow) {
    return this.runRange(0, this.model.cells.length, follow);
  }

  async restartRunAll(follow) {
    if (!(await confirmDialog("Restart and run all?", "Python restarts (variables are cleared), then every code cell runs from the top.", "Restart"))) return;
    this.abortRun = true;
    this.kernel.restart().catch(() => {});
    await new Promise((r) => setTimeout(r, 50));
    this.running = false;
    this.runAll(follow);
  }

  _kernelState(s, text) {
    if (s === "off" || s === "dead") {
      this.abortRun = true;
      for (const c of this.model.cells) {
        if (c._state === "queued" || c._state === "running") {
          c._state = null;
          this.emit("state", { cell: c });
        }
      }
    }
    this.emit("kernel", { state: s, text });
    if (s === "dead" && this.views.size) {
      toast("Python stopped: " + (text || "unknown error"), { action: "Restart", onAction: () => this.kernel.restart().catch(() => {}), duration: 8000 });
    }
  }

  // ------------------------------------------------------------------ saving

  serialize() {
    this.emit("flush");
    if (this.kernel.info) {
      const li = (this.model.metadata.language_info ||= { name: "python" });
      li.version = this.kernel.info.python;
    }
    return serializeNotebook(this.model);
  }

  async save() {
    const text = this.serialize();
    if (!this.uri || !this.writable) return this.saveAs();
    try {
      await this.app.bridge.writeDocument(this.uri, text);
      this._saved();
      toast("Saved " + this.name);
      return true;
    } catch (e) {
      const go = await dialog({
        title: "Can't save to this file",
        body: saveErrorText(e),
        buttons: [{ label: "Cancel", value: false }, { label: "Save a copy", value: true, primary: true }],
        dismissValue: false,
      });
      return go ? this.saveAs() : false;
    }
  }

  async saveAs() {
    const text = this.serialize();
    const name = this.name.endsWith(".ipynb") ? this.name : this.name + ".ipynb";
    try {
      const r = await this.app.bridge.createDocument(name, "application/x-ipynb+json", text);
      if (!r) return false;
      const oldKey = this.app.draftKey(this);
      this.app.forgetDoc(this);
      this.uri = r.downloaded ? null : r.uri;
      this.name = r.name || name;
      this.writable = !r.downloaded;
      this.app.registerDoc(this);
      this.app.clearDraft(oldKey);
      this._saved();
      this.emit("name");
      if (this.uri) this.app.remember(this, "notebook");
      toast(r.downloaded ? "Downloaded " + this.name : "Saved " + this.name);
      return true;
    } catch (e) {
      toast("Couldn't save: " + e.message);
      return false;
    }
  }

  async rename() {
    const name = await promptDialog("Rename notebook", this.name.replace(/\.ipynb$/, ""), "Rename");
    if (!name) return;
    const full = name.endsWith(".ipynb") ? name : name + ".ipynb";
    if (this.uri) {
      const ok = await confirmDialog("Save under the new name?", `Android keeps the original file. "${full}" is saved as a new file.`, "Save");
      if (!ok) return;
      this.name = full;
      this.emit("name");
      await this.saveAs();
    } else {
      this.name = full;
      this.emit("name");
      this.markDirty();
    }
  }

  async exportPy() {
    const text = notebookToPython(this.model);
    const name = this.name.replace(/\.ipynb$/, "") + ".py";
    try {
      const r = await this.app.bridge.createDocument(name, "text/x-python", text);
      if (r) toast("Exported " + (r.name || name));
    } catch (e) {
      toast("Couldn't export: " + e.message);
    }
  }

  _saved() {
    this.dirty = false;
    this.emit("dirty");
    this.app.clearDraft(this.app.draftKey(this));
  }

  // Ask about unsaved changes before the last view closes. Resolves true to go ahead.
  async confirmClose() {
    if (!this.dirty) return true;
    const choice = await dialog({
      title: "Save changes?",
      body: `"${this.name}" has unsaved changes.`,
      buttons: [
        { label: "Discard", value: "discard", danger: true },
        { label: "Cancel", value: "cancel" },
        { label: "Save", value: "save", primary: true },
      ],
      dismissValue: "cancel",
    });
    if (choice === "cancel") return false;
    if (choice === "save") return !!(await this.save());
    this.app.clearDraft(this.app.draftKey(this));
    this.dirty = false;
    return true;
  }

  createView(ws, opts) {
    return new NotebookView(ws, this, opts);
  }

  destroy() {
    this.kernel.shutdown();
    this.app.forgetDoc(this);
  }
}

// ======================================================================= view

export class NotebookView {
  constructor(ws, doc, { copyFrom } = {}) {
    this.ws = ws;
    this.doc = doc;
    this.selectedId = doc.cells[0] && doc.cells[0].id;
    this.editingId = null;
    this.editor = null;
    this.cv = new Map(); // cell id -> per-view DOM for that cell
    this.offs = [];
    this.pendingSource = new Set();
    this.build();
    this.listen();
    doc.views.add(this);
    if (copyFrom && copyFrom.doc === doc) {
      this.selectedId = copyFrom.selectedId;
      this._markSelected();
      const top = copyFrom.body.scrollTop;
      requestAnimationFrame(() => {
        this.body.scrollTop = top;
      });
    }
    if (doc.stdin) this._showStdin(doc.stdin.cell, doc.stdin.req, false);
  }

  kind() {
    return "notebook";
  }

  // ------------------------------------------------------------------ layout

  build() {
    const doc = this.doc;
    const { chip, update } = kernelChip(doc.kernel, () => this._chipTap());
    this.chipUpdate = update;
    this.titleEl = el("span", { class: "doc-name" }, doc.name);
    this.dirtyDot = el("span", { class: "dirty-dot", hidden: !doc.dirty, title: "Unsaved changes" });
    this.stopBtn = iconButton("stop", "Interrupt", () => interruptOrRestart(doc.kernel), { class: doc.kernel.state === "busy" ? "" : "hide" });
    this.closeBtn = this.ws.closeButton(this);
    this.header = el("header", { class: "appbar pane-head" },
      this.closeBtn,
      el("button", { class: "appbar-title doc-title", type: "button", onclick: () => this._menu() }, this.titleEl, this.dirtyDot),
      chip,
      this.stopBtn,
      iconButton("playAll", "Run all", () => doc.runAll(this), { class: "opt-runall" }),
      this.ws.splitButton(this),
      iconButton("more", "More", () => this._menu()),
    );
    this.cellsEl = el("main", { class: "cells", "aria-label": "Notebook cells" });
    wireLinks(this.cellsEl);
    this.addRow = el("div", { class: "add-row" },
      el("button", { class: "btn ghost", type: "button", onclick: () => this.insert(doc.cells.length, "code") }, icon("add", 18), " Code"),
      el("button", { class: "btn ghost", type: "button", onclick: () => this.insert(doc.cells.length, "markdown") }, icon("add", 18), " Text"),
    );
    this.body = el("div", { class: "pane-body notebook-body" }, this.cellsEl, this.addRow);
    this.cellbar = el("nav", { class: "cellbar", "aria-label": "Cell actions" },
      iconButton("play", "Run cell", () => this.runSelected(true), { class: "primary-ic", text: "Run" }),
      iconButton("up", "Move up", () => this.moveSelected(-1)),
      iconButton("down", "Move down", () => this.moveSelected(1)),
      iconButton("code", "Add code cell below", () => this.insert(this._selIndex() + 1, "code")),
      iconButton("text", "Add text cell below", () => this.insert(this._selIndex() + 1, "markdown")),
      iconButton("edit", "Edit cell", () => this.editSelected()),
      iconButton("more", "Cell options", () => this._cellMenu()),
    );
    this.renderAll();
    this.offs.push(onSettings(() => this._applySettings()));
  }

  bottomBar() {
    return this.cellbar;
  }

  focusedEditor() {
    return this.editor;
  }

  keybarRun() {
    this.runSelected(true);
  }

  setCompact(multi) {
    this.closeBtn.setAttribute("aria-label", multi ? "Close pane" : "Back");
    this.closeBtn.title = multi ? "Close pane" : "Back";
  }

  _applySettings() {
    if (this.editor) applyEditorSettings(this.editor);
    for (const cell of this.doc.cells) if (cell.type !== "markdown" && cell.id !== this.editingId) this._renderInput(cell);
  }

  renderAll() {
    this.cellsEl.replaceChildren();
    this.cv.clear();
    for (const c of this.doc.cells) this.cellsEl.append(this._buildCell(c));
    if (!this.doc.cellById(this.selectedId)) this.selectedId = this.doc.cells[0] && this.doc.cells[0].id;
    this._markSelected();
  }

  _buildCell(cell) {
    const count = el("span", { class: "exec-count" });
    const time = el("span", { class: "exec-time" });
    const gutter = el("div", { class: "cell-gutter", "aria-hidden": "true" }, count, time);
    const input = el("div", { class: "cell-input" });
    const status = el("div", { class: "cell-status", hidden: true });
    const outputs = el("div", { class: "cell-outputs" });
    const stdin = el("div", { class: "cell-stdin", hidden: true });
    const root = el("section", { class: `cell ${cell.type}`, "data-id": cell.id },
      gutter,
      el("div", { class: "cell-main" }, input, status, outputs, stdin),
    );
    const v = { root, input, outputs, status, stdin, count, time, area: new OutputArea(outputs) };
    this.cv.set(cell.id, v);
    root.addEventListener("click", (e) => this._cellClick(cell, e));
    this._renderInput(cell);
    this._renderGutter(cell);
    if (cell.type === "code") v.area.render(cell.outputs);
    return root;
  }

  _renderInput(cell) {
    const v = this.cv.get(cell.id);
    if (!v || cell.id === this.editingId) return;
    v.input.replaceChildren();
    if (cell.type === "markdown") {
      const md = el("div", { class: "markdown" });
      if (cell.source.trim()) md.innerHTML = renderMarkdown(cell.source, cell.attachments);
      else md.append(el("p", { class: "placeholder" }, "Empty text cell. Tap twice to write."));
      for (const h of md.querySelectorAll("h1,h2,h3,h4,h5,h6")) if (!h.id) h.id = slug(h.textContent);
      v.input.append(md);
    } else {
      const pre = el("pre", { class: "code-static" + (cell.type === "raw" ? " raw" : "") + (settings.wrap ? " wrap" : "") });
      if (cell.source) pre.innerHTML = cell.type === "code" ? highlightCodeHtml(cell.source) : cell.source.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
      else pre.append(el("span", { class: "placeholder" }, cell.type === "code" ? "Empty code cell" : "Raw cell"));
      v.input.append(pre);
    }
  }

  _renderGutter(cell) {
    const v = this.cv.get(cell.id);
    if (!v) return;
    v.root.classList.toggle("queued", cell._state === "queued");
    v.root.classList.toggle("running", cell._state === "running");
    v.root.classList.toggle("errored", cell._state === "error" || (cell._state !== "queued" && cell._state !== "running" && cell.outputs.some((o) => o.output_type === "error")));
    if (cell.type !== "code") {
      v.count.textContent = "";
      v.time.textContent = "";
      return;
    }
    const n = cell._state === "queued" || cell._state === "running" ? "*" : cell.execution_count ?? " ";
    v.count.textContent = `[${n}]`;
    v.time.textContent = cell._elapsed != null && cell._state !== "running" ? fmtElapsed(cell._elapsed) : "";
  }

  // ------------------------------------------------------------------ doc events

  listen() {
    const d = this.doc;
    const on = (name, fn) => this.offs.push(d.on(name, fn));
    on("insert", ({ index, cell, fromView }) => {
      const node = this._buildCell(cell);
      this.cellsEl.insertBefore(node, this.cellsEl.children[index] || null);
      if (fromView === this) {
        this._select(cell.id);
        this._startEditing(cell);
      } else if (!this.doc.cellById(this.selectedId)) {
        this.selectedId = cell.id;
        this._markSelected();
      }
    });
    on("delete", ({ cell }) => {
      if (this.editingId === cell.id) this._dropEditor();
      const v = this.cv.get(cell.id);
      if (v) v.root.remove();
      this.cv.delete(cell.id);
      if (this.selectedId === cell.id) {
        const idx = Math.min(this._lastIndex ?? 0, d.cells.length - 1);
        this.selectedId = d.cells[Math.max(0, idx)] && d.cells[Math.max(0, idx)].id;
        this._markSelected();
      }
    });
    on("move", ({ from, to, cell }) => {
      const node = this.cv.get(cell.id)?.root;
      if (!node) return;
      node.remove();
      this.cellsEl.insertBefore(node, this.cellsEl.children[to] || null);
      if (this.selectedId === cell.id) node.scrollIntoView({ block: "nearest", behavior: "smooth" });
    });
    on("replace", ({ cell }) => {
      if (this.editingId === cell.id) this._dropEditor();
      const old = this.cv.get(cell.id)?.root;
      const node = this._buildCell(cell);
      if (old) old.replaceWith(node);
      this._markSelected();
    });
    on("source", ({ cell, fromView }) => {
      if (fromView === this) return;
      this.pendingSource.add(cell.id);
      this._flushSourceSoon();
    });
    on("cell", ({ cell }) => {
      const v = this.cv.get(cell.id);
      if (!v) return;
      v.area.render(cell.outputs);
      this._renderGutter(cell);
    });
    on("state", ({ cell }) => this._renderGutter(cell));
    on("outputs", ({ cell }) => {
      const v = this.cv.get(cell.id);
      if (v) v.area.schedule(cell.outputs);
    });
    on("status", ({ cell, text, error }) => {
      const v = this.cv.get(cell.id);
      if (v) showStatus(v.status, text, error);
    });
    on("stdin", ({ cell, req }) => this._showStdin(cell, req, this.ws.active === this));
    on("stdin-done", ({ cell }) => {
      const v = this.cv.get(cell.id);
      if (v) {
        v.stdin.hidden = true;
        v.stdin.replaceChildren();
      }
    });
    on("dirty", () => {
      this.dirtyDot.hidden = !d.dirty;
    });
    on("name", () => {
      this.titleEl.textContent = d.name;
      this.ws.refreshTitles();
    });
    on("kernel", ({ state, text }) => {
      this.chipUpdate(state, text);
      this.stopBtn.classList.toggle("hide", state !== "busy");
      // Python can now check the code properly (and knows names from cells just run).
      if (state === "idle" && this.editor) recheck(this.editor);
    });
    on("follow", ({ cell, view }) => {
      if (view !== this) return;
      this._select(cell.id, false);
      const v = this.cv.get(cell.id);
      if (v) v.root.scrollIntoView({ block: "nearest", behavior: "smooth" });
    });
    on("editing", ({ cell, view }) => {
      if (view !== this && this.editingId === cell.id) this._stopEditing();
    });
    on("flush", () => {
      if (this.editor && this.editingId) {
        const cell = d.cellById(this.editingId);
        if (cell) d.setSource(cell, this.editor.state.doc.toString(), this);
      }
    });
  }

  _flushSourceSoon() {
    clearTimeout(this._srcTimer);
    this._srcTimer = setTimeout(() => {
      for (const id of this.pendingSource) {
        const cell = this.doc.cellById(id);
        if (cell) this._renderInput(cell);
      }
      this.pendingSource.clear();
    }, 120);
  }

  _showStdin(cell, req, focus) {
    const v = this.cv.get(cell.id);
    if (!v) return;
    showStdin(v.stdin, req, (value) => {
      this.doc.answerInput(value);
    }, { focus });
  }

  // ------------------------------------------------------------------ selection & editing

  _selIndex() {
    const i = this.doc.indexOf(this.selectedId);
    return i < 0 ? 0 : i;
  }

  _selected() {
    return this.doc.cellById(this.selectedId) || this.doc.cells[0];
  }

  _cellClick(cell, e) {
    if (this.doc.indexOf(cell) < 0) return;
    if (e.target.closest("a[href], .stdin, .out-img, button, input")) {
      if (cell.id !== this.selectedId) this._select(cell.id, false);
      return;
    }
    if (cell.id === this.editingId) return;
    const wasSelected = cell.id === this.selectedId;
    this._select(cell.id, false);
    if (wasSelected && e.target.closest(".cell-input")) this._startEditing(cell, { x: e.clientX, y: e.clientY });
  }

  _select(id, scroll = true) {
    if (!id) return;
    if (this.editingId && this.editingId !== id) this._stopEditing();
    this.selectedId = id;
    this._lastIndex = this.doc.indexOf(id);
    this._markSelected();
    if (scroll) {
      const v = this.cv.get(id);
      if (v) v.root.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }
  }

  _markSelected() {
    for (const [id, v] of this.cv) v.root.classList.toggle("selected", id === this.selectedId);
    this._lastIndex = this.doc.indexOf(this.selectedId);
  }

  editSelected() {
    const cell = this._selected();
    if (cell) this._startEditing(cell);
  }

  _startEditing(cell, at) {
    if (this.editingId === cell.id) {
      this.editor && this.editor.focus();
      return;
    }
    this._stopEditing();
    const v = this.cv.get(cell.id);
    if (!v) return;
    this.doc.emit("editing", { cell, view: this });
    this.editingId = cell.id;
    v.root.classList.add("editing");
    v.input.replaceChildren();
    const lang = cell.type === "code" ? "python" : cell.type === "markdown" ? "markdown" : "plain";
    this.editor = createEditor(v.input, {
      doc: cell.source,
      lang,
      placeholder: cell.type === "markdown" ? "Write text with Markdown and $math$" : "Python code",
      onChange: (text) => this.doc.setSource(cell, text, this),
      onRun: () => this.runSelected(true),
      onRunInPlace: () => this.runSelected(false),
      onEscape: () => this._stopEditing(),
      complete: (code, pos) => this.doc.kernel.complete(code, pos),
      lint: lang === "python" ? (code) => this.doc.kernel.lint(code, this._otherCode(cell)) : null,
      words: () => this._otherWords(cell),
    });
    // Focus now so typing lands in the cell at once; place the caret where the
    // person tapped once the editor has been laid out.
    this.editor.dispatch({ selection: { anchor: this.editor.state.doc.length } });
    this.editor.focus();
    if (at) {
      requestAnimationFrame(() => {
        if (!this.editor) return;
        const p = this.editor.posAtCoords({ x: at.x, y: at.y });
        if (p != null) this.editor.dispatch({ selection: { anchor: p } });
      });
    }
  }

  // Other code cells, so the mistake check knows the names they define.
  _otherCode(cell) {
    const out = [];
    let size = 0;
    for (const c of this.doc.cells) {
      if (c.type !== "code" || c.id === cell.id || !c.source.trim()) continue;
      size += c.source.length;
      if (size > 400000) break;
      out.push(c.source);
    }
    return out;
  }

  // Names used in the other code cells, for suggestions.
  _otherWords(cell) {
    const words = new Set();
    const re = /[A-Za-z_][A-Za-z0-9_]{2,}/g;
    for (const src of this._otherCode(cell)) {
      for (const m of src.matchAll(re)) {
        words.add(m[0]);
        if (words.size >= 2000) return words;
      }
    }
    return words;
  }

  _dropEditor() {
    if (this.editor) this.editor.destroy();
    this.editor = null;
    const id = this.editingId;
    this.editingId = null;
    const v = id && this.cv.get(id);
    if (v) v.root.classList.remove("editing");
    this.ws.updateKeyboard();
  }

  _stopEditing() {
    if (!this.editingId) return;
    const id = this.editingId;
    const cell = this.doc.cellById(id);
    if (this.editor && cell) this.doc.setSource(cell, this.editor.state.doc.toString(), this);
    this._dropEditor();
    if (cell) this._renderInput(cell);
  }

  // ------------------------------------------------------------------ actions (cell bar, menus)

  insert(index, type) {
    this._stopEditing();
    this.doc.insertCell(index, type, "", this);
  }

  moveSelected(delta) {
    const cell = this._selected();
    if (cell) this.doc.moveCell(cell, delta);
  }

  deleteSelected() {
    const cell = this._selected();
    if (!cell) return;
    if (this.editingId === cell.id) this._dropEditor();
    const i = this.doc.deleteCell(cell, this);
    toast("Cell deleted", {
      action: "Undo",
      onAction: () => {
        this.doc.insertExisting(i, cell);
        this._select(cell.id);
      },
    });
  }

  async runSelected(advance) {
    const cell = this._selected();
    if (!cell) return;
    if (this.editingId === cell.id && this.editor) this.doc.setSource(cell, this.editor.state.doc.toString(), this);
    const idx = this.doc.indexOf(cell);
    if (advance) {
      if (idx + 1 >= this.doc.cells.length) {
        this._stopEditing();
        this.doc.insertCell(idx + 1, "code");
      }
      const next = this.doc.cells[idx + 1];
      this._select(next.id);
    } else if (this.editingId === cell.id && cell.type === "markdown") {
      this._stopEditing();
    }
    if (cell.type === "markdown") {
      if (this.editingId === cell.id) this._stopEditing();
      else this._renderInput(cell);
      return;
    }
    if (cell.type !== "code") return;
    await this.doc.runCell(cell);
  }

  _chipTap() {
    if (this.doc.kernel.state === "off") {
      this.doc.kernel.start().catch(() => {});
      return;
    }
    kernelMenu(this.doc.kernel, { onRestartRunAll: () => this.doc.restartRunAll(this) });
  }

  _menu() {
    const d = this.doc;
    actionSheet(d.name, [
      { icon: "save", label: "Save", hint: d.uri ? "" : "Choose where to save", onClick: () => d.save() },
      { icon: "save", label: "Save as…", onClick: () => d.saveAs() },
      { icon: "edit", label: "Rename", onClick: () => d.rename() },
      "-",
      ...this.ws.paneMenuItems(this),
      "-",
      { icon: "list", label: "Outline", onClick: () => this.outline() },
      d.app.bridge.isAndroid ? null : { icon: "info", label: "Keyboard shortcuts", onClick: () => shortcutsPanel() },
      { icon: "folder", label: "Files", hint: "Data files for your code", onClick: () => openFilesPanel(d.kernel) },
      { icon: "package", label: "Offline packages", onClick: () => d.app.openPackages(d.kernel) },
      "-",
      { icon: "playAll", label: "Run all", onClick: () => d.runAll(this) },
      { icon: "restart", label: "Restart Python", onClick: () => d.kernel.restart().catch(() => {}) },
      { icon: "playAll", label: "Restart and run all", onClick: () => d.restartRunAll(this) },
      { icon: "clear", label: "Clear all outputs", onClick: () => d.clearAllOutputs() },
      { icon: "code", label: "Export as Python file", onClick: () => d.exportPy() },
      "-",
      { icon: "settings", label: "Settings", onClick: () => d.app.openSettings() },
    ]);
  }

  _cellMenu() {
    const cell = this._selected();
    if (!cell) return;
    const d = this.doc;
    const i = d.indexOf(cell);
    actionSheet("Cell", [
      { icon: "playAll", label: "Run all above", onClick: () => d.runRange(0, i, this) },
      { icon: "playAll", label: "Run this and below", onClick: () => d.runRange(i, d.cells.length, this) },
      "-",
      cell.type !== "code" ? { icon: "code", label: "Change to code", onClick: () => d.changeType(cell, "code") } : null,
      cell.type !== "markdown" ? { icon: "text", label: "Change to text", onClick: () => d.changeType(cell, "markdown") } : null,
      cell.type !== "raw" ? { icon: "file", label: "Change to raw", onClick: () => d.changeType(cell, "raw") } : null,
      { icon: "copy", label: "Duplicate", onClick: () => {
        const c = d.duplicateCell(cell);
        this._select(c.id);
      } },
      { icon: "copy", label: "Copy source", onClick: () => navigator.clipboard?.writeText(cell.source).then(() => toast("Copied"), () => toast("Couldn't copy")) },
      cell.type === "code" ? { icon: "clear", label: "Clear output", onClick: () => { d.clearOutput(cell); d.markDirty(); } } : null,
      { icon: "add", label: "Add code cell above", onClick: () => this.insert(i, "code") },
      "-",
      { icon: "del", label: "Delete cell", danger: true, onClick: () => this.deleteSelected() },
    ]);
  }

  outline() {
    const items = [];
    this.doc.cells.forEach((c) => {
      if (c.type !== "markdown") return;
      for (const h of headingsOf(c.source)) items.push({ ...h, id: c.id });
    });
    const list = el("div", { class: "outline" });
    let entry;
    if (!items.length) list.append(el("div", { class: "empty" }, "No headings yet. Text cells starting with # appear here."));
    for (const it of items) {
      list.append(el("button", {
        class: "outline-item lvl" + Math.min(it.level, 4),
        type: "button",
        onclick: () => {
          entry.close();
          this._select(it.id, false);
          const v = this.cv.get(it.id);
          setTimeout(() => v && v.root.scrollIntoView({ block: "start", behavior: "smooth" }), 180);
        },
      }, it.text));
    }
    entry = panel("Outline", list);
  }

  // ------------------------------------------------------------------ keyboard (Jupyter command mode)

  // Called by the workspace for keys pressed while no editor or field has focus.
  onKey(e) {
    if (this.editingId) return false;
    const mod = e.ctrlKey || e.metaKey;
    const d = this.doc;
    if (e.key === "Enter" && e.shiftKey && !mod) {
      this.runSelected(true);
      return true;
    }
    if (e.key === "Enter" && mod) {
      this.runSelected(false);
      return true;
    }
    if (e.key === "Enter" && e.altKey) {
      const cell = this._selected();
      if (cell) d.runCell(cell);
      this.insert(this._selIndex() + 1, "code");
      return true;
    }
    if (mod || e.altKey) return false;
    const cell = this._selected();
    const i = this._selIndex();
    const go = (j) => {
      j = Math.max(0, Math.min(d.cells.length - 1, j));
      this._select(d.cells[j].id);
    };
    switch (e.key) {
      case "ArrowUp":
      case "k":
        go(i - 1);
        return true;
      case "ArrowDown":
      case "j":
        go(i + 1);
        return true;
      case "Home":
        go(0);
        return true;
      case "End":
        go(d.cells.length - 1);
        return true;
      case "Enter":
        this.editSelected();
        return true;
      case "a":
        this.insert(i, "code");
        return true;
      case "b":
        this.insert(i + 1, "code");
        return true;
      case "m":
        if (cell) d.changeType(cell, "markdown");
        return true;
      case "y":
        if (cell) d.changeType(cell, "code");
        return true;
      case "r":
        if (cell) d.changeType(cell, "raw");
        return true;
      case "d": {
        const now = Date.now();
        if (this._lastD && now - this._lastD < 700) {
          this._lastD = 0;
          this.deleteSelected();
        } else this._lastD = now;
        return true;
      }
      case "i":
        if (this._lastI && Date.now() - this._lastI < 700) {
          this._lastI = 0;
          interruptOrRestart(d.kernel);
        } else this._lastI = Date.now();
        return true;
      case "o":
        if (cell) {
          const v = this.cv.get(cell.id);
          if (v) v.outputs.classList.toggle("hidden-out");
        }
        return true;
      default:
        return false;
    }
  }

  // ------------------------------------------------------------------ lifecycle

  onBack() {
    if (this.editingId) {
      this._stopEditing();
      return true;
    }
    return false;
  }

  // Scroll position description for the pane title (e.g. "cell 12 of 40").
  where() {
    const top = this.body.getBoundingClientRect().top;
    let idx = 0;
    const nodes = this.cellsEl.children;
    for (let i = 0; i < nodes.length; i++) {
      if (nodes[i].getBoundingClientRect().bottom > top + 8) {
        idx = i;
        break;
      }
    }
    return `cell ${idx + 1} of ${nodes.length}`;
  }

  destroy() {
    this._stopEditing();
    for (const off of this.offs) off();
    this.offs = [];
    this.doc.views.delete(this);
  }
}

function fmtElapsed(s) {
  if (s < 1) return "";
  if (s < 60) return s.toFixed(s < 10 ? 1 : 0) + "s";
  const m = Math.floor(s / 60);
  return `${m}m${String(Math.round(s % 60)).padStart(2, "0")}`;
}

function shortcutsPanel() {
  const rows = [
    ["Shift+Enter", "Run the cell and select the next one"],
    ["Ctrl+Enter", "Run the cell"],
    ["Alt+Enter", "Run the cell and add one below"],
    ["Enter", "Edit the selected cell"],
    ["Esc", "Stop editing"],
    ["↑ / ↓ (or K / J)", "Select the cell above or below"],
    ["A / B", "Add a code cell above or below"],
    ["M / Y / R", "Make the cell text, code or raw"],
    ["D, D", "Delete the cell"],
    ["I, I", "Interrupt Python"],
    ["O", "Hide or show the cell's output"],
    ["Ctrl+S", "Save"],
    ["Tab / Shift+Tab", "Indent or dedent while editing; Tab also completes"],
  ];
  const t = el("table", { class: "keys" });
  for (const [k, what] of rows) t.append(el("tr", null, el("td", null, el("kbd", null, k)), el("td", null, what)));
  panel("Keyboard shortcuts", el("div", null, el("p", { class: "panel-note" }, "Shortcuts work when no cell is being edited. Click a cell to select it."), t));
}
