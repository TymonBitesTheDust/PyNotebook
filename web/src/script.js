// Python scripts (.py): ScriptDoc holds the text, kernel and last run's output;
// ScriptView is one editor pane. Two views of the same script stay in sync edit by edit,
// so you can look at different parts of a long file at once.

import { el, icon, iconButton, actionSheet, toast, dialog, debounce } from "./ui.js";
import { createEditor, applyRemoteChanges } from "./editor.js";
import { recheck } from "./assist.js";
import { settings } from "./settings.js";
import { applyMessage, wireLinks } from "./outputs.js";
import { OutputArea, Emitter, bump, saveErrorText, kernelChip, kernelMenu, interruptOrRestart, openFilesPanel, showStatus, showStdin } from "./common.js";
import { Kernel } from "./kernel.js";
import { pythonToCells } from "./nbformat.js";

export class ScriptDoc extends Emitter {
  constructor(app, { uri, name, text, writable, dirty }) {
    super();
    this.app = app;
    this.type = "script";
    this.uri = uri;
    this.name = name;
    this.text = text || "";
    this.writable = !!writable;
    this.dirty = !!dirty;
    this.views = new Set();
    this.retainers = 0;
    this.outputs = [];
    this.runTitle = "Output";
    this.stdin = null;
    this.kernel = new Kernel({ onState: (s, t) => this.emit("kernel", { state: s, text: t }) });
    this.saveDraftSoon = debounce(() => this.app.saveDraft(this), 1500);
  }

  // Start Python in the background once you work on the script, so mistakes can be
  // checked properly (same rule as notebooks: only when nothing else has started it).
  warmUp() {
    if (this.kernel.state !== "off" || !settings.autoStart || settings.checkCode === false) return;
    if (this.app.anyKernelStarted()) return;
    this.kernel.start().catch(() => {});
  }

  // A view changed the text; copy the change into the other views.
  edited(changes, text, fromView) {
    this.text = text;
    if (!this.dirty) {
      this.dirty = true;
      this.emit("dirty");
    }
    this.saveDraftSoon();
    this.emit("changes", { changes, fromView });
  }

  async run() {
    if (this.kernel.state === "busy") {
      toast("The script is still running");
      return;
    }
    this.emit("flush");
    this.outputs = [];
    this.runTitle = "Running…";
    this.emit("run-start");
    const t0 = performance.now();
    const state = { clearPending: false };
    try {
      const res = await this.kernel.execute(this.text, {
        onOutput: (msg) => {
          if (msg.type === "status") {
            this.emit("status", { text: msg.text, error: msg.error });
            return;
          }
          const idx = applyMessage(this.outputs, msg, state);
          if (idx >= 0) bump(this.outputs[idx]);
          this.emit("outputs");
        },
        onInput: (req, answer) => {
          this.stdin = { req, answer };
          this.emit("stdin", { req });
        },
      }, { fresh: true, silent: true });
      const secs = ((performance.now() - t0) / 1000).toFixed(1);
      this.runTitle = res.status === "ok" ? `Output · finished in ${secs}s` : "Output · stopped with an error";
    } catch (e) {
      this.runTitle = "Output · " + (e.cancelled ? "cancelled" : e.message);
    } finally {
      this.stdin = null;
      this.emit("stdin-done");
      this.emit("status", { text: null });
      this.emit("run-end");
    }
  }

  answerInput(text) {
    const s = this.stdin;
    if (!s) return;
    this.stdin = null;
    this.emit("stdin-done");
    s.answer(text);
  }

  serialize() {
    this.emit("flush");
    return this.text;
  }

  async save() {
    if (!this.uri || !this.writable) return this.saveAs();
    try {
      await this.app.bridge.writeDocument(this.uri, this.serialize());
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
    let name = this.name;
    if (!/\.\w+$/.test(name)) name += ".py";
    try {
      const r = await this.app.bridge.createDocument(name, "text/x-python", this.serialize());
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
      if (this.uri) this.app.remember(this, "script");
      toast("Saved " + this.name);
      return true;
    } catch (e) {
      toast("Couldn't save: " + e.message);
      return false;
    }
  }

  _saved() {
    this.dirty = false;
    this.emit("dirty");
    this.app.clearDraft(this.app.draftKey(this));
  }

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
    return new ScriptView(ws, this, opts);
  }

  destroy() {
    this.kernel.shutdown();
    this.app.forgetDoc(this);
  }
}

export class ScriptView {
  constructor(ws, doc, { copyFrom } = {}) {
    this.ws = ws;
    this.doc = doc;
    this.offs = [];
    this.build();
    this.listen();
    doc.views.add(this);
    if (copyFrom && copyFrom.doc === doc) {
      const top = copyFrom.editor.scrollDOM.scrollTop;
      requestAnimationFrame(() => {
        this.editor.scrollDOM.scrollTop = top;
      });
    }
    if (doc.outputs.length) {
      this.area.render(doc.outputs);
      this.outTitle.textContent = doc.runTitle;
    }
  }

  kind() {
    return "script";
  }

  build() {
    const doc = this.doc;
    const { chip, update } = kernelChip(doc.kernel, () => kernelMenu(doc.kernel));
    this.chipUpdate = update;
    this.titleEl = el("span", { class: "doc-name" }, doc.name);
    this.dirtyDot = el("span", { class: "dirty-dot", hidden: !doc.dirty });
    this.stopBtn = iconButton("stop", "Interrupt", () => interruptOrRestart(doc.kernel), { class: "hide" });
    this.closeBtn = this.ws.closeButton(this);
    this.header = el("header", { class: "appbar pane-head" },
      this.closeBtn,
      el("button", { class: "appbar-title doc-title", type: "button", onclick: () => this._menu() }, this.titleEl, this.dirtyDot),
      chip,
      this.stopBtn,
      iconButton("play", "Run script", () => doc.run(), { class: "primary-ic" }),
      this.ws.splitButton(this),
      iconButton("more", "More", () => this._menu()),
    );
    const host = el("div", { class: "script-editor" });
    this.outEl = el("div", { class: "cell-outputs" });
    this.statusEl = el("div", { class: "cell-status", hidden: true });
    this.stdinEl = el("div", { class: "cell-stdin", hidden: true });
    this.outTitle = el("span", null, doc.runTitle);
    this.drawer = el("section", { class: "script-output collapsed", "aria-label": "Output" },
      el("button", { class: "drawer-head", type: "button", onclick: () => this.toggleDrawer() }, this.outTitle, icon("up", 20)),
      el("div", { class: "drawer-body" }, this.statusEl, this.outEl, this.stdinEl),
    );
    wireLinks(this.drawer);
    this.body = el("div", { class: "pane-body script-body" }, host, this.drawer);
    this.editor = createEditor(host, {
      doc: doc.text,
      lang: "python",
      placeholder: "# Write a Python script, then tap ▶",
      onUpdate: (u, remote) => {
        if (!remote) doc.edited(u.changes, u.state.doc.toString(), this);
      },
      onFocus: () => doc.warmUp(),
      onRun: () => doc.run(),
      onRunInPlace: () => doc.run(),
      complete: (code, pos) => doc.kernel.complete(code, pos),
      lint: (code) => doc.kernel.lint(code),
    });
    this.area = new OutputArea(this.outEl);
  }

  listen() {
    const d = this.doc;
    const on = (name, fn) => this.offs.push(d.on(name, fn));
    on("changes", ({ changes, fromView }) => {
      if (fromView !== this) applyRemoteChanges(this.editor, changes);
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
      if (state === "idle") recheck(this.editor);
    });
    on("run-start", () => {
      this.editor.contentDOM.blur();
      this.outTitle.textContent = d.runTitle;
      this.area.render(d.outputs);
      this.toggleDrawer(true);
    });
    on("outputs", () => this.area.schedule(d.outputs));
    on("status", ({ text, error }) => showStatus(this.statusEl, text, error));
    on("stdin", ({ req }) => {
      this.toggleDrawer(true);
      showStdin(this.stdinEl, req, (v) => d.answerInput(v), { focus: this.ws.active === this });
    });
    on("stdin-done", () => {
      this.stdinEl.hidden = true;
      this.stdinEl.replaceChildren();
    });
    on("run-end", () => {
      this.outTitle.textContent = d.runTitle;
      this.area.render(d.outputs);
      if (!d.outputs.length) this.outEl.replaceChildren(el("div", { class: "empty" }, "The script finished without printing anything."));
    });
  }

  bottomBar() {
    return null;
  }

  focusedEditor() {
    return this.editor;
  }

  keybarRun() {
    this.doc.run();
  }

  setCompact(multi) {
    this.closeBtn.setAttribute("aria-label", multi ? "Close pane" : "Back");
    this.closeBtn.title = multi ? "Close pane" : "Back";
  }

  toggleDrawer(open) {
    const collapsed = open === undefined ? !this.drawer.classList.contains("collapsed") : !open;
    this.drawer.classList.toggle("collapsed", collapsed);
  }

  _menu() {
    const d = this.doc;
    actionSheet(d.name, [
      { icon: "save", label: "Save", onClick: () => d.save() },
      { icon: "save", label: "Save as…", onClick: () => d.saveAs() },
      "-",
      ...this.ws.paneMenuItems(this),
      "-",
      { icon: "notebook", label: "Open as notebook", hint: "# %% markers become cells", onClick: () => this.toNotebook() },
      { icon: "folder", label: "Files", onClick: () => openFilesPanel(d.kernel) },
      { icon: "package", label: "Offline packages", onClick: () => d.app.openPackages(d.kernel) },
      { icon: "restart", label: "Restart Python", onClick: () => d.kernel.restart().catch(() => {}) },
      { icon: "settings", label: "Settings", onClick: () => d.app.openSettings() },
    ]);
  }

  toNotebook() {
    const cells = pythonToCells(this.doc.serialize());
    this.doc.app.openNotebookModel({ name: this.doc.name.replace(/\.py$/, "") + ".ipynb", cells }, "beside", this);
  }

  onBack() {
    if (!this.drawer.classList.contains("collapsed") && this.drawer.contains(document.activeElement)) {
      this.toggleDrawer(false);
      return true;
    }
    return false;
  }

  where() {
    const line = this.editor.state.doc.lineAt(this.editor.lineBlockAtHeight(this.editor.scrollDOM.scrollTop).from).number;
    return `line ${line} of ${this.editor.state.doc.lines}`;
  }

  destroy() {
    for (const off of this.offs) off();
    this.offs = [];
    this.editor.destroy();
    this.doc.views.delete(this);
  }
}
