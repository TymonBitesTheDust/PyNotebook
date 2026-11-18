// Split-screen workspace: 1–4 panes, stacked or side by side, with draggable dividers.
// Each pane shows a view of a document; several panes can show the same document.

import { el, icon, iconButton, actionSheet, toast, hasLayer } from "./ui.js";
import { createKeybar } from "./common.js";
import { settings, saveSettings, recentFiles } from "./settings.js";

export const MAX_PANES = 4;
const MIN_PANE = 110;

export class Workspace {
  constructor(app) {
    this.app = app;
    this.panes = []; // {view, el, weight}
    this.active = null;
    this.maximized = null;
    this.dir = "rows";
    this.area = el("div", { class: "ws-area" });
    this.barSlot = el("div", { class: "ws-bar" });
    this.keybar = createKeybar({
      getView: () => this.focusedEditor(),
      onRun: () => {
        const v = this.viewWithFocus() || this.active;
        if (v) v.keybarRun();
      },
      onDone: () => {
        const a = document.activeElement;
        if (a && a.blur) a.blur();
      },
    });
    this.root = el("div", { class: "workspace" }, this.area, this.barSlot, this.keybar);
    this.area.addEventListener("pointerdown", (e) => this._activateFrom(e.target), true);
    this.area.addEventListener("focusin", (e) => {
      this._activateFrom(e.target);
      // Show the symbol bar right away; hiding it waits until the tap is over.
      if (e.target.closest && e.target.closest(".cm-editor")) this.updateKeyboard();
      else if (!this.pointerDown) setTimeout(() => this.updateKeyboard(), 60);
    });
    // Wait for the tap to finish before hiding the symbol bar, so the layout doesn't
    // shift under the finger (which would turn the tap into a miss).
    this.pointerDown = false;
    this._down = () => { this.pointerDown = true; };
    this._up = () => {
      this.pointerDown = false;
      setTimeout(() => this.updateKeyboard(), 30);
    };
    document.addEventListener("pointerdown", this._down, true);
    document.addEventListener("pointerup", this._up, true);
    document.addEventListener("pointercancel", this._up, true);
    this.area.addEventListener("focusout", () => setTimeout(() => {
      if (!this.pointerDown) this.updateKeyboard();
    }, 60));
    this._onResize = () => this._applyDirection();
    window.addEventListener("resize", this._onResize);
    // Keyboard shortcuts go to the active pane when nothing is being typed into.
    this._onKey = (e) => {
      if (e.defaultPrevented || hasLayer()) return;
      const a = document.activeElement;
      // A focused button or link (left there by a click or a closed menu) only keeps the
      // keys that press it; letter shortcuts still reach the notebook.
      const pressKey = e.key === "Enter" || e.key === " " || e.key === "Tab";
      const typing = a && a !== document.body && (a.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName) || (/^(BUTTON|A)$/.test(a.tagName) && pressKey) || (a.closest && a.closest(".cm-editor")));
      if (typing) return;
      const v = this.active;
      if (v && v.onKey && v.onKey(e)) e.preventDefault();
    };
    document.addEventListener("keydown", this._onKey);
  }

  get views() {
    return this.panes.map((p) => p.view);
  }

  docs() {
    return [...new Set(this.views.map((v) => v.doc))];
  }

  canAdd() {
    return this.panes.length < MAX_PANES;
  }

  // ------------------------------------------------------------------ panes

  add(view, { after = this.active, activate = true } = {}) {
    const pane = { view, el: el("section", { class: "pane" }, view.header, view.body), weight: 1 };
    // The new pane gets an equal share; the others keep their proportions.
    if (this.panes.length) pane.weight = this.panes.reduce((a, p) => a + p.weight, 0) / this.panes.length;
    const ai = this.panes.findIndex((p) => p.view === after);
    if (ai >= 0) this.panes.splice(ai + 1, 0, pane);
    else this.panes.push(pane);
    this.maximized = null;
    this.layout();
    if (activate || !this.active) this.activate(view);
    return view;
  }

  replace(oldView, newView) {
    const pane = this.panes.find((p) => p.view === oldView);
    if (!pane) return this.add(newView);
    const doc = oldView.doc;
    oldView.destroy();
    this.app.releaseDoc(doc);
    pane.view = newView;
    pane.el.replaceChildren(newView.header, newView.body);
    if (this.maximized === oldView) this.maximized = newView;
    this.layout();
    this.activate(newView);
    return newView;
  }

  // Close a pane; asks about unsaved changes when it's the file's last view.
  async close(view, { force = false } = {}) {
    const pane = this.panes.find((p) => p.view === view);
    if (!pane) return true;
    const doc = view.doc;
    if (!force && doc.views.size <= 1 && !(await doc.confirmClose())) return false;
    const i = this.panes.indexOf(pane);
    this.panes.splice(i, 1);
    const neighbour = this.panes[i - 1] || this.panes[i];
    if (neighbour) neighbour.weight += pane.weight;
    view.destroy();
    this.app.releaseDoc(doc);
    if (this.maximized === view) this.maximized = null;
    if (!this.panes.length) {
      this.app.showHome();
      return true;
    }
    this.layout();
    if (this.active === view) this.activate(neighbour.view);
    return true;
  }

  activate(view) {
    if (!view) return;
    this.active = view;
    for (const p of this.panes) p.el.classList.toggle("active", p.view === view);
    const bar = view.bottomBar();
    this.barSlot.replaceChildren(...(bar ? [bar] : []));
    this.barSlot.hidden = !bar;
    this.refreshTitles();
  }

  _activateFrom(target) {
    const paneEl = target && target.closest && target.closest(".pane");
    const pane = paneEl && this.panes.find((p) => p.el === paneEl);
    if (pane && pane.view !== this.active) this.activate(pane.view);
  }

  toggleMaximize(view) {
    this.maximized = this.maximized === view ? null : view;
    this.layout();
    this.activate(view);
  }

  setDirection(dir) {
    saveSettings({ splitDirection: dir });
    this._applyDirection();
  }

  _computeDirection() {
    const pref = settings.splitDirection || "auto";
    if (pref === "rows" || pref === "cols") return pref;
    const w = window.innerWidth;
    const h = window.innerHeight;
    return w >= 600 && w > h * 1.15 ? "cols" : "rows";
  }

  _applyDirection() {
    const d = this._computeDirection();
    if (d !== this.dir) {
      this.dir = d;
      this.layout();
    }
  }

  layout() {
    this.dir = this._computeDirection();
    const multi = this.panes.length > 1 && !this.maximized;
    this.root.classList.toggle("multi", this.panes.length > 1);
    this.area.classList.toggle("cols", this.dir === "cols");
    this.area.classList.toggle("rows", this.dir !== "cols");
    this.area.classList.toggle("maxed", !!this.maximized);
    const nodes = [];
    this.panes.forEach((p, i) => {
      if (i > 0) nodes.push(this._divider(i - 1));
      p.el.classList.toggle("max", p.view === this.maximized);
      nodes.push(p.el);
      p.view.setCompact(this.panes.length > 1);
    });
    // Keep scroll positions: moving nodes can reset them.
    const scrolls = this.panes.map((p) => [p.view.body, p.view.body.scrollTop]);
    this.area.replaceChildren(...nodes);
    for (const [b, top] of scrolls) b.scrollTop = top;
    this._applyWeights();
    this.root.dataset.panes = String(this.panes.length);
    this.root.classList.toggle("single", !multi && this.panes.length <= 1);
  }

  _applyWeights() {
    for (const p of this.panes) p.el.style.flex = `${p.weight} 1 0px`;
  }

  _divider(i) {
    const d = el("div", { class: "divider", role: "separator", tabindex: "0", "aria-label": "Drag to resize panes", "aria-orientation": this.dir === "cols" ? "vertical" : "horizontal" },
      el("span", { class: "grip" }));
    const resizeBy = (fraction) => {
      const a = this.panes[i];
      const b = this.panes[i + 1];
      const sum = a.weight + b.weight;
      const na = Math.max(sum * 0.12, Math.min(sum * 0.88, a.weight + sum * fraction));
      a.weight = na;
      b.weight = sum - na;
      this._applyWeights();
    };
    d.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      const a = this.panes[i];
      const b = this.panes[i + 1];
      if (!a || !b) return;
      d.setPointerCapture(e.pointerId);
      const horiz = this.dir === "cols";
      const ra = a.el.getBoundingClientRect();
      const rb = b.el.getBoundingClientRect();
      const total = horiz ? ra.width + rb.width : ra.height + rb.height;
      const start = horiz ? e.clientX : e.clientY;
      const sizeA = horiz ? ra.width : ra.height;
      const sum = a.weight + b.weight;
      const min = Math.min(MIN_PANE, total / 2 - 1);
      const move = (ev) => {
        const delta = (horiz ? ev.clientX : ev.clientY) - start;
        const na = Math.max(min, Math.min(total - min, sizeA + delta));
        a.weight = (sum * na) / total;
        b.weight = sum - a.weight;
        this._applyWeights();
      };
      const up = () => {
        d.classList.remove("dragging");
        d.removeEventListener("pointermove", move);
        d.removeEventListener("pointerup", up);
        d.removeEventListener("pointercancel", up);
      };
      d.classList.add("dragging");
      d.addEventListener("pointermove", move);
      d.addEventListener("pointerup", up);
      d.addEventListener("pointercancel", up);
    });
    d.addEventListener("dblclick", () => {
      const a = this.panes[i];
      const b = this.panes[i + 1];
      const sum = a.weight + b.weight;
      a.weight = b.weight = sum / 2;
      this._applyWeights();
    });
    d.addEventListener("keydown", (e) => {
      const back = e.key === "ArrowUp" || e.key === "ArrowLeft";
      const fwd = e.key === "ArrowDown" || e.key === "ArrowRight";
      if (back || fwd) {
        e.preventDefault();
        resizeBy(fwd ? 0.05 : -0.05);
      }
    });
    return d;
  }

  // ------------------------------------------------------------------ keyboard symbol bar

  viewWithFocus() {
    const a = document.activeElement;
    if (!a || !a.closest) return null;
    const paneEl = a.closest(".pane");
    const pane = paneEl && this.panes.find((p) => p.el === paneEl);
    return pane ? pane.view : null;
  }

  focusedEditor() {
    const v = this.viewWithFocus() || this.active;
    return v ? v.focusedEditor() : null;
  }

  updateKeyboard() {
    const a = document.activeElement;
    const editing = !!(a && a.closest && a.closest(".cm-editor") && this.root.contains(a));
    this.root.classList.toggle("keyboard", editing);
  }

  // ------------------------------------------------------------------ pane chrome & menus

  closeButton(view) {
    const b = el("button", { class: "icon-btn close-btn", type: "button", "aria-label": "Back", title: "Back" },
      el("span", { class: "when-single" }, icon("back")),
      el("span", { class: "when-multi" }, icon("close")));
    // With one pane this is the Back arrow (leaves edit mode first, like the system back);
    // with several it closes just this pane.
    b.addEventListener("click", () => {
      if (this.panes.length > 1) this.close(view);
      else this.app.back();
    });
    return b;
  }

  splitButton(view) {
    return iconButton("split", "Split screen", () => this.splitMenu(view), { class: "split-btn" });
  }

  splitMenu(view) {
    if (!this.canAdd()) {
      toast(`Up to ${MAX_PANES} panes fit. Close one to open another.`);
      return;
    }
    const a = this.app;
    const doc = view.doc;
    const items = [];
    if (doc.type === "notebook" || doc.type === "script") {
      items.push({ icon: "split", label: "Same file, another view", hint: "Scroll each part separately", onClick: () => this.add(doc.createView(this, { copyFrom: view }), { after: view }) });
    }
    if (doc.type === "notebook") {
      items.push({ icon: "console", label: "Console for this notebook", hint: "Shares its variables", onClick: () => a.openConsole("beside", view, doc) });
    }
    items.push({ icon: "folder", label: "Open another file…", onClick: () => a.pickAndOpen("beside", view) });
    const open = new Set(this.docs().map((d) => d.uri).filter(Boolean));
    const recents = recentFiles().filter((r) => !open.has(r.uri)).slice(0, 4);
    if (recents.length) {
      items.push("-");
      for (const r of recents) items.push({ icon: r.kind === "notebook" ? "notebook" : "code", label: r.name, hint: "Recent", onClick: () => a.openRecent(r, "beside", view) });
    }
    items.push("-");
    items.push({ icon: "notebook", label: "New notebook", onClick: () => a.newNotebook("beside", view) });
    items.push({ icon: "code", label: "New script", onClick: () => a.newScript("beside", view) });
    items.push({ icon: "console", label: "Python console", hint: "Its own Python", onClick: () => a.openConsole("beside", view) });
    actionSheet("Open beside " + (doc.name || "this pane"), items);
  }

  // Items each view adds to its own "more" menu.
  paneMenuItems(view) {
    const multi = this.panes.length > 1;
    const items = [{ icon: "split", label: "Split screen…", hint: this.canAdd() ? "" : "Full", onClick: () => this.splitMenu(view) }];
    if (multi) {
      items.push({ icon: this.maximized === view ? "minimize" : "maximize", label: this.maximized === view ? "Show all panes" : "Maximize this pane", onClick: () => this.toggleMaximize(view) });
      items.push(this.dir === "cols"
        ? { icon: "splitRows", label: "Stack panes top to bottom", onClick: () => this.setDirection("rows") }
        : { icon: "split", label: "Place panes side by side", onClick: () => this.setDirection("cols") });
      if ((settings.splitDirection || "auto") !== "auto") {
        items.push({ icon: "swap", label: "Arrange automatically", hint: "Side by side when wide", onClick: () => this.setDirection("auto") });
      }
    }
    items.push({ icon: "folder", label: "Open another file here", onClick: () => this.app.pickAndOpen("here", view) });
    if (multi) items.push({ icon: "close", label: "Close this pane", onClick: () => this.close(view) });
    return items;
  }

  refreshTitles() {
    const v = this.active;
    if (v && v.doc && v.doc.name) document.title = v.doc.name + " · PyNotebook";
  }

  // ------------------------------------------------------------------ lifecycle

  async onBack() {
    const v = this.active || (this.panes[0] && this.panes[0].view);
    if (!v) return;
    if (await v.onBack()) return;
    if (this.maximized && this.panes.length > 1) {
      this.toggleMaximize(this.maximized);
      return;
    }
    await this.close(v);
  }

  onPause() {
    for (const d of this.docs()) if (d.dirty) this.app.saveDraft(d);
  }

  saveActive() {
    const v = this.viewWithFocus() || this.active;
    if (v && v.doc.save) v.doc.save();
  }

  destroy() {
    window.removeEventListener("resize", this._onResize);
    document.removeEventListener("keydown", this._onKey);
    document.removeEventListener("pointerdown", this._down, true);
    document.removeEventListener("pointerup", this._up, true);
    document.removeEventListener("pointercancel", this._up, true);
    for (const p of this.panes) {
      p.view.destroy();
      this.app.releaseDoc(p.view.doc);
    }
    this.panes = [];
  }
}
