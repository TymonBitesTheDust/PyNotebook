// Interactive Python console. A console either has its own Python, or borrows a
// notebook's (a "scratch" console next to the notebook in split view).

import { el, iconButton, actionSheet, toast } from "./ui.js";
import { createEditor, highlightCodeHtml } from "./editor.js";
import { recheck } from "./assist.js";
import { wireLinks } from "./outputs.js";
import { OutputArea, Emitter, execInto, kernelChip, kernelMenu, interruptOrRestart, openFilesPanel, showStatus } from "./common.js";
import { Kernel } from "./kernel.js";
import { settings } from "./settings.js";

export class ConsoleDoc extends Emitter {
  constructor(app, { owner } = {}) {
    super();
    this.app = app;
    this.type = "console";
    this.owner = owner || null; // a NotebookDoc whose Python this console shares
    this.uri = null;
    this.dirty = false;
    this.views = new Set();
    this.retainers = 0;
    if (owner) {
      owner.retainers++;
      this.kernel = owner.kernel;
      this.offOwner = owner.on("kernel", (k) => this.emit("kernel", k));
      this.offName = owner.on("name", () => this.emit("name"));
    } else {
      this.kernel = new Kernel({ onState: (s, t) => this.emit("kernel", { state: s, text: t }) });
    }
  }

  get name() {
    return this.owner ? `Console · ${this.owner.name}` : "Python console";
  }

  async confirmClose() {
    return true;
  }

  serialize() {
    return "";
  }

  createView(ws, opts) {
    return new ConsoleView(ws, this, opts);
  }

  destroy() {
    if (this.owner) {
      this.offOwner();
      this.offName();
      this.owner.retainers--;
      this.app.releaseDoc(this.owner);
    } else {
      this.kernel.shutdown();
    }
    this.app.forgetDoc(this);
  }
}

export class ConsoleView {
  constructor(ws, doc) {
    this.ws = ws;
    this.doc = doc;
    this.history = [];
    this.histPos = -1;
    this.offs = [];
    this.build();
    doc.views.add(this);
    this.offs.push(doc.on("kernel", ({ state, text }) => {
      this.chipUpdate(state, text);
      this.stopBtn.classList.toggle("hide", state !== "busy");
      if (state === "idle") {
        this._banner();
        recheck(this.editor);
      }
    }));
    this.offs.push(doc.on("name", () => {
      this.titleEl.textContent = doc.name;
      this.ws.refreshTitles();
    }));
    doc.kernel.start().then(() => this._banner()).catch(() => {});
  }

  kind() {
    return "console";
  }

  build() {
    const k = this.doc.kernel;
    const { chip, update } = kernelChip(k, () => kernelMenu(k));
    this.chipUpdate = update;
    this.stopBtn = iconButton("stop", "Interrupt", () => interruptOrRestart(k), { class: k.state === "busy" ? "" : "hide" });
    this.closeBtn = this.ws.closeButton(this);
    this.titleEl = el("span", { class: "doc-name" }, this.doc.name);
    this.header = el("header", { class: "appbar pane-head" },
      this.closeBtn,
      el("button", { class: "appbar-title doc-title", type: "button", onclick: () => this._menu() }, this.titleEl),
      chip,
      this.stopBtn,
      this.ws.splitButton(this),
      iconButton("more", "More", () => this._menu()),
    );
    this.log = el("div", { class: "console-log", "aria-live": "polite" });
    wireLinks(this.log);
    this.log.append(el("div", { class: "console-banner" }, "Starting Python…"));
    const editorHost = el("div", { class: "console-editor" });
    this.input = el("div", { class: "console-input" },
      el("span", { class: "console-prompt", "aria-hidden": "true" }, ">>>"),
      editorHost,
      el("div", { class: "console-buttons" },
        iconButton("up", "Previous command", () => this._hist(-1)),
        iconButton("down", "Next command", () => this._hist(1)),
        iconButton("play", "Run", () => this.run(), { class: "primary-ic" }),
      ),
    );
    // Keep the keyboard open when tapping these buttons while typing.
    for (const b of this.input.querySelectorAll(".console-buttons button")) b.addEventListener("mousedown", (e) => e.preventDefault());
    this.scroller = el("div", { class: "console-scroll" }, this.log);
    this.body = el("div", { class: "pane-body console-body" }, this.scroller, this.input);
    this.editor = createEditor(editorHost, {
      doc: "",
      lang: "python",
      numbers: false,
      placeholder: "Type Python and tap Run",
      onRun: () => this.run(),
      onRunInPlace: () => this.run(),
      complete: (code, pos) => this.doc.kernel.complete(code, pos),
      lint: (code) => this.doc.kernel.lint(code),
    });
  }

  _banner() {
    const b = this.log.querySelector(".console-banner");
    const info = this.doc.kernel.info;
    if (!b || !info) return;
    b.textContent = this.doc.owner
      ? `Shares Python with ${this.doc.owner.name}: its variables are available here. Type code below and tap ▶.`
      : `Python ${info.python} (Pyodide ${info.pyodide}). Type code below and tap ▶ to run it.`;
  }

  bottomBar() {
    return null;
  }

  focusedEditor() {
    return this.editor;
  }

  keybarRun() {
    this.run();
  }

  setCompact(multi) {
    this.closeBtn.setAttribute("aria-label", multi ? "Close pane" : "Back");
    this.closeBtn.title = multi ? "Close pane" : "Back";
  }

  _hist(dir) {
    if (!this.history.length) return;
    if (this.histPos === -1) this.histPos = this.history.length;
    this.histPos = Math.max(0, Math.min(this.history.length, this.histPos + dir));
    const text = this.history[this.histPos] ?? "";
    this.editor.dispatch({ changes: { from: 0, to: this.editor.state.doc.length, insert: text }, selection: { anchor: text.length } });
    this.editor.focus();
  }

  _keepBottom() {
    const sc = this.scroller;
    if (sc.scrollTop + sc.clientHeight >= sc.scrollHeight - 200) {
      requestAnimationFrame(() => {
        sc.scrollTop = sc.scrollHeight;
      });
    }
  }

  async run() {
    const code = this.editor.state.doc.toString();
    if (!code.trim()) return;
    this.history.push(code);
    this.histPos = -1;
    this.editor.dispatch({ changes: { from: 0, to: this.editor.state.doc.length, insert: "" } });
    const echo = el("pre", { class: "console-echo" + (settings.wrap ? " wrap" : "") });
    echo.innerHTML = highlightCodeHtml(code);
    const count = el("span", { class: "console-count" }, "[*]");
    const outputsEl = el("div", { class: "cell-outputs" });
    const status = el("div", { class: "cell-status", hidden: true });
    const stdin = el("div", { class: "cell-stdin", hidden: true });
    const entry = el("div", { class: "console-entry" }, el("div", { class: "console-entry-head" }, count, echo), status, outputsEl, stdin);
    this.log.append(entry);
    this.scroller.scrollTop = this.scroller.scrollHeight;
    const outputs = [];
    const area = new OutputArea(outputsEl);
    try {
      const res = await execInto(this.doc.kernel, code, { outputs, area, statusEl: status, stdinEl: stdin, onOutput: () => this._keepBottom() });
      count.textContent = `[${res.execution_count}]`;
      entry.classList.toggle("errored", res.status !== "ok");
    } catch (e) {
      count.textContent = "[!]";
      if (!e.cancelled) outputsEl.append(el("pre", { class: "out-error" }, e.message));
    } finally {
      showStatus(status, null);
      stdin.hidden = true;
      area.render(outputs);
      this._keepBottom();
    }
  }

  _menu() {
    const k = this.doc.kernel;
    actionSheet(this.doc.name, [
      ...this.ws.paneMenuItems(this),
      "-",
      { icon: "clear", label: "Clear console", onClick: () => {
        this.log.replaceChildren(el("div", { class: "console-banner" }, "Console cleared. Variables are kept."));
      } },
      { icon: "folder", label: "Files", onClick: () => openFilesPanel(k) },
      { icon: "package", label: "Offline packages", onClick: () => this.doc.app.openPackages(k) },
      { icon: "restart", label: "Restart Python", onClick: () => {
        k.restart().then(() => toast("Python restarted"), () => {});
      } },
      { icon: "settings", label: "Settings", onClick: () => this.doc.app.openSettings() },
    ]);
  }

  onBack() {
    return false;
  }

  where() {
    return "";
  }

  destroy() {
    for (const off of this.offs) off();
    this.offs = [];
    this.editor.destroy();
    this.doc.views.delete(this);
  }
}
