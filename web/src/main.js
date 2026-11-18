// App shell: home screen, navigation, opening files, drafts, settings and packages.

import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/600.css";
import "katex/dist/katex.min.css";
import "./styles.css";

import { connectBridge, onHostEvent } from "./bridge.js";
import { el, icon, iconButton, toast, actionSheet, dialog, confirmDialog, panel, closeTopLayer, hasLayer, timeAgo, formatBytes } from "./ui.js";
import { settings, saveSettings, recentFiles, addRecent, removeRecent, store, recall } from "./settings.js";
import { parseNotebook, newNotebook, newCell } from "./nbformat.js";
import { NotebookDoc } from "./notebook.js";
import { ConsoleDoc } from "./console.js";
import { ScriptDoc } from "./script.js";
import { Workspace } from "./workspace.js";
import { assetText, assetJSON, buildInfo } from "./assets.js";
import { PALETTES, applyPalette } from "./themes.js";

const DRAFTS = "pynotebook.drafts";
const APP_LINKS = {
  website: "https://tymon.website",
  source: "https://github.com/TymonBitesTheDust/PyNotebook",
};

class App {
  constructor(bridge) {
    this.bridge = bridge;
    this.screen = null; // HomeScreen when no files are open
    this.workspace = null; // split-screen workspace when files are open
    this.docsByUri = new Map();
    this.liveDocs = new Set();
    this.hostDark = false;
    this.root = document.getElementById("app");
    this.lock = null;
  }

  async init() {
    try {
      const info = await this.bridge.info();
      this.hostInfo = info;
      this.hostDark = !!info.dark;
    } catch (e) {
      this.hostInfo = {};
      if (this.bridge.isExe) toast(e.message, { duration: 15000 });
    }
    this.build = await buildInfo();
    document.documentElement.dataset.platform = this.bridge.platform || "browser";
    if (!this.bridge.isAndroid) {
      const mq = matchMedia("(prefers-color-scheme: dark)");
      this.hostDark = mq.matches;
      mq.addEventListener("change", (e) => {
        this.hostDark = e.matches;
        this.applyTheme();
      });
    }
    this.applyTheme();
    onHostEvent("uiMode", (m) => {
      this.hostDark = !!m.dark;
      this.applyTheme();
    });
    onHostEvent("back", () => this.back());
    onHostEvent("pause", () => this.workspace && this.workspace.onPause());
    onHostEvent("openIntent", (m) => m.file && this.openFromHost(m.file));
    window.addEventListener("keydown", (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "s" && this.workspace) {
        e.preventDefault();
        this.workspace.saveActive();
      }
    });
    window.addEventListener("beforeunload", (e) => {
      if (!this.workspace) return;
      this.workspace.onPause();
      // Desktop: ask before closing the window with unsaved changes (drafts are kept anyway).
      if (!this.bridge.isAndroid && this.workspace.docs().some((d) => d.dirty)) {
        e.preventDefault();
        e.returnValue = "";
      }
    });
    onHostEvent("hostLost", () => toast("PyNotebook.exe has closed, so new packages and files can't load. Save your work, then start PyNotebook again.", { duration: 12000 }));
    this.setupDrop();
    this.showHome();
    try {
      const pending = await this.bridge.pendingIntent();
      if (pending) this.openFromHost(pending);
      const files = await this.bridge.pendingFiles?.() || [];
      files.forEach((f, i) => {
        if (f.error) toast(f.error, { duration: 8000 });
        else this.openText(f, i === 0 && !this.workspace ? "new" : "beside");
      });
    } catch (e) {
      toast(e.message);
    }
    if (!this.bridge.isAndroid) {
      const q = new URLSearchParams(location.search);
      if (q.get("open")) {
        const url = q.get("open");
        const text = await (await fetch(url)).text();
        this.openText({ uri: null, name: url.split("/").pop(), text, writable: false, persistent: false });
      }
    }
  }

  applyTheme() {
    const dark = settings.theme === "system" ? this.hostDark : settings.theme === "dark";
    document.documentElement.dataset.theme = dark ? "dark" : "light";
    document.documentElement.style.setProperty("--code-size", settings.codeSize + "px");
    const bg = applyPalette(settings.accent, dark);
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.content = bg;
    this.bridge.setTheme(dark, bg).catch(() => {});
  }

  // ------------------------------------------------------------------ navigation

  showHome() {
    if (this.workspace) {
      this.workspace.destroy();
      this.workspace = null;
    }
    this.screen = new HomeScreen(this);
    this.root.classList.remove("ws-mode");
    this.root.replaceChildren(this.screen.root);
    document.title = "PyNotebook";
    window.scrollTo(0, 0);
  }

  ensureWorkspace() {
    if (!this.workspace) {
      this.workspace = new Workspace(this);
      this.screen = null;
      this.root.classList.add("ws-mode");
      this.root.replaceChildren(this.workspace.root);
    }
    return this.workspace;
  }

  // Show a document. placement: "new" (fresh screen), "beside" (new pane next to `ref`),
  // "here" (replace the pane showing `ref`).
  async place(doc, placement = "new", ref = null) {
    if (placement !== "new" && this.workspace) {
      const ws = this.workspace;
      if (placement === "beside") {
        if (!ws.canAdd()) {
          toast("Up to 4 panes fit. Close one to open another.");
          this.releaseDoc(doc);
          return null;
        }
        return ws.add(doc.createView(ws), { after: ref || ws.active });
      }
      const old = ref || ws.active;
      if (old && old.doc !== doc && old.doc.views.size <= 1 && !(await old.doc.confirmClose())) {
        this.releaseDoc(doc);
        return null;
      }
      return ws.replace(old, doc.createView(ws));
    }
    if (this.workspace) return this.place(doc, "beside", ref);
    const ws = this.ensureWorkspace();
    const view = ws.add(doc.createView(ws));
    ws.refreshTitles();
    return view;
  }

  async back() {
    if (hasLayer()) {
      closeTopLayer();
      return;
    }
    const viewer = document.querySelector(".img-viewer");
    if (viewer) {
      viewer.remove();
      return;
    }
    if (this.workspace) {
      if (this.backBusy) return;
      this.backBusy = true;
      try {
        await this.workspace.onBack();
      } finally {
        this.backBusy = false;
      }
      return;
    }
    this.bridge.exit();
  }

  // Drop .ipynb / .py files onto the window to open them (beside the current file).
  setupDrop() {
    const hasFiles = (e) => e.dataTransfer && [...e.dataTransfer.types].includes("Files");
    window.addEventListener("dragover", (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
      document.body.classList.add("dropping");
    });
    window.addEventListener("dragleave", (e) => {
      if (!e.relatedTarget) document.body.classList.remove("dropping");
    });
    window.addEventListener("drop", async (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      document.body.classList.remove("dropping");
      const items = [...e.dataTransfer.items].filter((i) => i.kind === "file");
      // Handles must be requested before the first await.
      const handles = items.map((i) => (i.getAsFileSystemHandle ? i.getAsFileSystemHandle().catch(() => null) : Promise.resolve(null)));
      const files = items.map((i) => i.getAsFile());
      for (let k = 0; k < items.length; k++) {
        const name = files[k] ? files[k].name : "";
        if (!/\.(ipynb|py|txt|json)$/i.test(name)) {
          toast(`${name || "That file"} isn't a notebook or Python file. To use data files in your code, add them in Files.`, { duration: 6000 });
          continue;
        }
        let file;
        try {
          const h = await handles[k];
          file = h && h.kind === "file" && this.bridge.adoptHandle
            ? await this.bridge.adoptHandle(h)
            : { uri: null, name, text: await files[k].text(), writable: false, persistent: false };
        } catch (err) {
          toast("Couldn't open " + name + ": " + err.message);
          continue;
        }
        this.openText(file, this.workspace ? "beside" : "new", this.workspace && this.workspace.active);
      }
    });
  }

  // ------------------------------------------------------------------ documents

  registerDoc(doc) {
    this.liveDocs.add(doc);
    if (doc.uri) this.docsByUri.set(doc.uri, doc);
  }

  forgetDoc(doc) {
    this.liveDocs.delete(doc);
    if (doc.uri && this.docsByUri.get(doc.uri) === doc) this.docsByUri.delete(doc.uri);
  }

  // Destroys a document once no pane shows it and nothing (like a shared console) uses it.
  releaseDoc(doc) {
    if (doc && doc.views.size === 0 && doc.retainers <= 0) doc.destroy();
  }

  anyKernelStarted() {
    for (const d of this.liveDocs) if (d.kernel && d.kernel.state !== "off") return true;
    return false;
  }

  // ------------------------------------------------------------------ opening documents

  async pickAndOpen(placement = "new", ref = null) {
    let file;
    try {
      file = await this.bridge.openDocument(["ipynb", "py"]);
    } catch (e) {
      toast("Couldn't open the file: " + e.message);
      return;
    }
    if (file) this.openText(file, placement, ref);
  }

  openFromHost(file) {
    const ws = this.workspace;
    if (!ws) {
      this.openText(file);
      return;
    }
    actionSheet("Open " + (file.name || "file"), [
      ws.canAdd() ? { icon: "split", label: "Open beside the current file", onClick: () => this.openText(file, "beside", ws.active) } : null,
      { icon: "folder", label: "Open instead of the current pane", onClick: () => this.openText(file, "here", ws.active) },
    ]);
  }

  async openRecent(r, placement = "new", ref = null) {
    let file;
    try {
      file = await this.bridge.readDocument(r.uri);
    } catch (e) {
      const remove = await dialog({
        title: "Can't open this file",
        body: `${r.name} may have been moved or deleted, or the permission to read it has expired. Open it again with Open file.`,
        buttons: [{ label: "Remove from list", value: true }, { label: "OK", value: false, primary: true }],
        dismissValue: false,
      });
      if (remove) {
        removeRecent(r.uri);
        if (!this.workspace) this.showHome();
      }
      return;
    }
    this.openText({ ...file, uri: r.uri }, placement, ref);
  }

  async openWelcome(placement = "new", ref = null) {
    const text = await assetText("welcome.ipynb");
    this.openText({ uri: null, name: "Welcome.ipynb", text, writable: false, persistent: false }, placement, ref);
  }

  openText(file, placement = "new", ref = null) {
    const name = file.name || "Untitled";
    // The same file is already open: show another view of it.
    const existing = file.uri && this.docsByUri.get(file.uri);
    if (existing) {
      this.place(existing, placement === "new" ? "beside" : placement, ref);
      return;
    }
    const isNotebook = /\.ipynb$/i.test(name) || (/^\s*\{/.test(file.text || "") && /"cells"\s*:/.test(file.text || ""));
    const draft = this.findDraft(file.uri);
    const proceed = (text, dirty) => {
      const writable = file.writable !== false && !!file.uri;
      let doc;
      if (isNotebook) {
        let model;
        try {
          model = parseNotebook(text);
        } catch (e) {
          toast(e.message, { duration: 6000 });
          return;
        }
        doc = new NotebookDoc(this, { uri: file.uri, name, model, writable, dirty });
      } else {
        doc = new ScriptDoc(this, { uri: file.uri, name, text, writable, dirty });
      }
      this.registerDoc(doc);
      if (file.uri && file.persistent !== false) this.remember({ uri: file.uri, name }, isNotebook ? "notebook" : "script");
      this.place(doc, placement, ref);
    };
    if (draft && draft.text !== file.text) {
      dialog({
        title: "Restore unsaved changes?",
        body: `You edited ${name} ${timeAgo(draft.time)} without saving.`,
        buttons: [
          { label: "Discard", value: false, danger: true },
          { label: "Restore", value: true, primary: true },
        ],
        dismissValue: false,
      }).then((restore) => {
        if (!restore) this.clearDraft(file.uri);
        proceed(restore ? draft.text : file.text, restore);
      });
      return;
    }
    proceed(file.text || "", false);
  }

  newNotebook(placement = "new", ref = null) {
    const model = newNotebook(this.pythonVersion());
    const doc = new NotebookDoc(this, { uri: null, name: this.untitled("Untitled", ".ipynb"), model, writable: false });
    this.registerDoc(doc);
    this.place(doc, placement, ref).then((view) => view && setTimeout(() => view.editSelected(), 300));
  }

  openNotebookModel({ name, cells }, placement = "new", ref = null) {
    const model = newNotebook(this.pythonVersion());
    model.cells = cells.length ? cells : [newCell("code")];
    const doc = new NotebookDoc(this, { uri: null, name, model, writable: false, dirty: true });
    this.registerDoc(doc);
    this.place(doc, this.workspace && !this.workspace.canAdd() && placement === "beside" ? "here" : placement, ref);
  }

  newScript(placement = "new", ref = null) {
    const doc = new ScriptDoc(this, { uri: null, name: this.untitled("script", ".py"), text: "", writable: false });
    this.registerDoc(doc);
    this.place(doc, placement, ref).then((view) => view && setTimeout(() => view.editor.focus(), 300));
  }

  // owner: a NotebookDoc whose Python the console should share.
  openConsole(placement = "new", ref = null, owner = null) {
    const doc = new ConsoleDoc(this, { owner });
    this.registerDoc(doc);
    this.place(doc, placement, ref);
  }

  openDraft(d) {
    this.clearDraft(d.key);
    let doc;
    if (d.kind === "notebook") {
      try {
        doc = new NotebookDoc(this, { uri: null, name: d.name, model: parseNotebook(d.text), writable: false, dirty: true });
      } catch (e) {
        toast(e.message);
        return;
      }
    } else {
      doc = new ScriptDoc(this, { uri: null, name: d.name, text: d.text, writable: false, dirty: true });
    }
    this.registerDoc(doc);
    this.place(doc, "new");
  }

  untitled(base, ext) {
    const names = new Set(recentFiles().map((r) => r.name));
    if (!names.has(base + ext)) return base + ext;
    for (let i = 2; ; i++) if (!names.has(`${base}${i}${ext}`)) return `${base}${i}${ext}`;
  }

  pythonVersion() {
    return (this.lock && this.lock.info && this.lock.info.python) || "3.14";
  }

  remember(doc, kind) {
    if (!doc.uri) return;
    addRecent({ uri: doc.uri, name: doc.name, kind });
  }

  // ------------------------------------------------------------------ drafts (crash / background-kill recovery)

  draftKey(doc) {
    if (doc.uri) return doc.uri;
    doc._draftId ||= "new:" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    return doc._draftId;
  }

  saveDraft(doc) {
    if (!doc.dirty || doc.type === "console") return;
    let text;
    try {
      text = doc.serialize();
    } catch {
      return;
    }
    if (text.length > 3_000_000) return;
    const key = this.draftKey(doc);
    const drafts = recall(DRAFTS, {});
    drafts[key] = { name: doc.name, kind: doc.type, time: Date.now(), text, uri: doc.uri || null };
    if (!store(DRAFTS, drafts)) {
      // Storage full: keep only this draft.
      store(DRAFTS, { [key]: drafts[key] });
    }
  }

  clearDraft(key) {
    if (!key) return;
    const drafts = recall(DRAFTS, {});
    if (drafts[key]) {
      delete drafts[key];
      store(DRAFTS, drafts);
    }
  }

  findDraft(uri) {
    if (!uri) return null;
    return recall(DRAFTS, {})[uri] || null;
  }

  unsavedDrafts() {
    return Object.entries(recall(DRAFTS, {}))
      .filter(([k]) => k.startsWith("new:"))
      .map(([key, d]) => ({ key, ...d }))
      .sort((a, b) => b.time - a.time);
  }

  // ------------------------------------------------------------------ packages

  async loadLock() {
    if (this.lock) return this.lock;
    this.lock = await assetJSON("pyodide-lock.json");
    return this.lock;
  }

  async openPackages(kernel) {
    const lock = await this.loadLock();
    const pk = lock.packages;
    const featured = ["numpy", "pandas", "matplotlib", "scipy", "sympy", "scikit-learn", "networkx", "pillow", "statsmodels", "beautifulsoup4", "micropip", "requests", "pyyaml", "regex"]
      .filter((n) => pk[n]);
    const depsOf = (name, acc = new Set()) => {
      const p = pk[name];
      if (!p || acc.has(name)) return acc;
      acc.add(name);
      for (const d of p.depends || []) depsOf(d, acc);
      return acc;
    };
    const body = el("div");
    const note = el("p", { class: "panel-note" },
      "Python and its standard library are built in. Larger packages download the first time you import them and then work offline. Download them now if you'll be without internet.");
    body.append(note);
    const list = el("div", { class: "pkg-list" });
    body.append(list);
    let cache = null;
    const refresh = async () => {
      try {
        cache = await this.bridge.listCache();
      } catch {
        cache = null;
      }
      const cachedNames = new Set((cache || []).map((c) => c.name));
      list.replaceChildren();
      for (const name of featured) {
        const all = [...depsOf(name)];
        const files = all.map((n) => pk[n].file_name);
        const have = files.filter((f) => cachedNames.has(f)).length;
        const size = (cache || []).filter((c) => files.includes(c.name)).reduce((a, c) => a + c.size, 0);
        const done = cache && have === files.length;
        const btn = el("button", { class: "btn small" + (done ? "" : " primary"), type: "button", disabled: done || !cache }, done ? "Downloaded" : "Download");
        btn.onclick = async () => {
          btn.disabled = true;
          btn.textContent = "Downloading…";
          try {
            let i = 0;
            for (const f of files) {
              i++;
              btn.textContent = `${i}/${files.length}…`;
              const r = await fetch("../pyodide/" + f);
              if (!r.ok) throw new Error(`couldn't download ${f} (${r.status})`);
              await r.arrayBuffer();
            }
            toast(`${name} is ready for offline use`);
          } catch (e) {
            toast("Download failed: " + e.message + ". Check your internet connection.", { duration: 6000 });
          }
          refresh();
        };
        list.append(el("div", { class: "pkg-row" },
          el("div", { class: "pkg-info" },
            el("div", { class: "pkg-name" }, name, el("span", { class: "pkg-ver" }, " " + pk[name].version)),
            el("div", { class: "pkg-meta" }, all.length > 1 ? `with ${all.length - 1} dependencies` : "no dependencies",
              size ? " · " + formatBytes(size) + " on device" : "")),
          btn));
      }
      if (!cache) {
        list.prepend(el("p", { class: "panel-note" }, this.bridge.packageNote || "Packages download the first time you import them."));
        for (const b of list.querySelectorAll(".pkg-row .btn")) b.hidden = true;
      }
      else {
        const total = cache.reduce((a, c) => a + c.size, 0);
        list.append(el("div", { class: "pkg-footer" },
          el("span", null, `Downloaded packages use ${formatBytes(total)}.`),
          el("button", { class: "btn small danger", type: "button", disabled: !cache.length, onclick: async () => {
            if (await confirmDialog("Delete downloaded packages?", "They download again when you next import them.", "Delete", true)) {
              await this.bridge.clearCache();
              refresh();
            }
          } }, "Delete all")));
      }
    };
    panel("Offline packages", body);
    refresh();
  }

  // ------------------------------------------------------------------ settings

  openSettings() {
    const body = el("div", { class: "settings" });
    const row = (label, hint, control) => el("div", { class: "set-row" }, el("div", { class: "set-text" }, el("div", { class: "set-label" }, label), hint ? el("div", { class: "set-hint" }, hint) : null), control);
    const seg = (options, value, onPick) => {
      const g = el("div", { class: "seg", role: "radiogroup" });
      for (const [v, l] of options) {
        const b = el("button", { class: "seg-btn" + (v === value ? " on" : ""), type: "button", role: "radio", "aria-checked": String(v === value) }, l);
        b.onclick = () => {
          for (const x of g.children) {
            x.classList.remove("on");
            x.setAttribute("aria-checked", "false");
          }
          b.classList.add("on");
          b.setAttribute("aria-checked", "true");
          onPick(v);
        };
        g.append(b);
      }
      return g;
    };
    const toggle = (value, onChange) => {
      const t = el("button", { class: "switch" + (value ? " on" : ""), type: "button", role: "switch", "aria-checked": String(value) });
      t.onclick = () => {
        const on = !t.classList.contains("on");
        t.classList.toggle("on", on);
        t.setAttribute("aria-checked", String(on));
        onChange(on);
      };
      return t;
    };
    const sizeLabel = el("span", { class: "size-val" }, settings.codeSize + " px");
    const size = el("div", { class: "stepper" },
      iconButton("clear", "Smaller", () => setSize(-1)),
      sizeLabel,
      iconButton("add", "Larger", () => setSize(1)),
    );
    const setSize = (d) => {
      const v = Math.max(10, Math.min(20, settings.codeSize + d));
      saveSettings({ codeSize: v });
      sizeLabel.textContent = v + " px";
      this.applyTheme();
    };
    // Theme colour: a swatch per palette, showing its accent in the current light/dark mode.
    const swatches = el("div", { class: "swatches", role: "radiogroup", "aria-label": "Theme colour" });
    const paintSwatches = () => {
      const dark = document.documentElement.dataset.theme === "dark";
      for (const b of swatches.children) {
        const p = PALETTES.find((x) => x.id === b.dataset.id);
        b.querySelector(".swatch-dot").style.background = p[dark ? "dark" : "light"].accent;
        b.querySelector(".swatch-dot").style.color = p[dark ? "dark" : "light"].onAccent;
        const on = p.id === (settings.accent || "teal");
        b.classList.toggle("on", on);
        b.setAttribute("aria-checked", String(on));
      }
    };
    for (const p of PALETTES) {
      const b = el("button", { class: "swatch", type: "button", role: "radio", "data-id": p.id, "aria-label": p.name },
        el("span", { class: "swatch-dot" }, icon("check", 18)),
        el("span", { class: "swatch-name" }, p.name));
      b.onclick = () => {
        saveSettings({ accent: p.id });
        this.applyTheme();
        paintSwatches();
      };
      swatches.append(b);
    }
    paintSwatches();
    body.append(
      row("Appearance", null, seg([["system", "System"], ["light", "Light"], ["dark", "Dark"]], settings.theme, (v) => {
        saveSettings({ theme: v });
        this.applyTheme();
        paintSwatches();
      })),
      el("div", { class: "set-row stack" },
        el("div", { class: "set-text" }, el("div", { class: "set-label" }, "Theme colour")),
        swatches),
      row("Code size", null, size),
      row("Wrap long lines", "Long code lines continue on the next line instead of scrolling sideways.", toggle(settings.wrap, (v) => saveSettings({ wrap: v }))),
      row("Line numbers", "Shown while editing code.", toggle(settings.lineNumbers, (v) => saveSettings({ lineNumbers: v }))),
      row("Start Python when a notebook opens", "Cells run sooner. Turn off to save battery when you only read notebooks.", toggle(settings.autoStart, (v) => saveSettings({ autoStart: v }))),
    );
    if (this.bridge.isExe) {
      const add = el("button", { class: "btn small", type: "button" }, "Add");
      const remove = el("button", { class: "btn small ghost", type: "button" }, "Remove");
      const go = async (enable) => {
        try {
          await this.bridge.openWith(enable);
          toast(enable
            ? "Done. Right-click a .ipynb file, choose Open with, then PyNotebook. Tick \u201cAlways\u201d to make it the default."
            : "PyNotebook was removed from Open with.", { duration: 9000 });
        } catch (e) {
          toast(e.message);
        }
      };
      add.onclick = () => go(true);
      remove.onclick = () => go(false);
      body.append(row("Open .ipynb and .py files from File Explorer",
        "Adds PyNotebook to the Open with menu for this Windows account. Do this again if you move PyNotebook.exe.",
        el("div", { class: "row-buttons" }, remove, add)));
    }
    body.append(this.aboutCard());
    panel("Settings", body);
  }

  // Who made PyNotebook, at the bottom of Settings.
  aboutCard() {
    const kind = this.bridge.isAndroid ? "Android app" : this.bridge.isExe ? "Windows app" : "Web app";
    const version = this.hostInfo.version || this.build.app || "";
    const iconLink = document.querySelector('link[rel="icon"]');
    // Long addresses may wrap only after a slash.
    const link = (href, text) => {
      const parts = text.split(/(?<=\/)/).flatMap((part, i) => (i ? [el("wbr"), part] : [part]));
      const a = el("a", { class: "about-v about-link", href, target: "_blank", rel: "noopener" }, ...parts);
      a.addEventListener("click", (e) => {
        e.preventDefault();
        this.bridge.openUrl(href);
      });
      return a;
    };
    const item = (ic, label, value) => el("div", { class: "about-row" },
      el("span", { class: "about-ic", "aria-hidden": "true" }, icon(ic, 22)),
      el("div", { class: "about-text" }, el("div", { class: "about-k" }, label), typeof value === "string" ? el("div", { class: "about-v" }, value) : value));
    const credits = el("p", { class: "about-credits" });
    this.loadLock().then((lock) => {
      credits.textContent = `Python ${lock.info.python} via Pyodide ${this.build.pyodide || ""}`.trim() +
        `, running entirely on this ${this.bridge.isAndroid ? "device" : "computer"}. Built with Pyodide, CodeMirror, KaTeX, marked and DOMPurify.`;
    }).catch(() => {});
    return el("section", { class: "about-card", "aria-label": "About PyNotebook" },
      el("div", { class: "about-head" },
        iconLink ? el("img", { class: "about-icon", src: iconLink.href, alt: "" }) : null,
        el("div", null,
          el("h2", { class: "about-name" }, "PyNotebook"),
          el("div", { class: "about-ver" }, [version && `Version ${version}`, kind].filter(Boolean).join(" \u00b7 ")))),
      el("div", { class: "about-list" },
        item("person", "Created by", "Tymon Ng"),
        item("sparkle", "Built with", "Claude AI"),
        item("southernCross", "Made in", "Proudly made in Australia"),
        item("globe", "Website", link(APP_LINKS.website, "tymon.website")),
        item("code", "Source code", link(APP_LINKS.source, "github.com/TymonBitesTheDust/PyNotebook"))),
      el("p", { class: "about-copy" }, "\u00a9 2026 Tymon Ng"),
      credits);
  }
}

// ---------------------------------------------------------------------- home screen

class HomeScreen {
  constructor(app) {
    this.app = app;
    this.build();
  }

  build() {
    const a = this.app;
    const action = (ic, title, hint, fn, cls = "") => el("button", { class: "home-action " + cls, type: "button", onclick: fn },
      el("span", { class: "home-action-icon" }, icon(ic, 24)),
      el("span", { class: "home-action-text" }, el("span", { class: "home-action-title" }, title), el("span", { class: "home-action-hint" }, hint)));
    const header = el("header", { class: "home-head" },
      el("div", { class: "home-brand" },
        el("span", { class: "brand-prompt", "aria-hidden": "true" }, "In [1]:"),
        el("h1", { class: "brand-name" }, "PyNotebook")),
      iconButton("settings", "Settings", () => a.openSettings()),
    );
    const tagline = el("p", { class: "home-tagline" }, a.bridge.isAndroid
      ? "Open Jupyter notebooks, read them, and run their Python right on your phone."
      : "Open Jupyter notebooks, read them, and run their Python on this computer. You can also drop .ipynb files onto this window.");
    const actions = el("div", { class: "home-actions" },
      action("folder", "Open file", ".ipynb notebook or .py script", () => a.pickAndOpen(), "main"),
      action("notebook", "New notebook", "Code and text cells", () => a.newNotebook()),
      action("console", "Python console", "Try code line by line", () => a.openConsole()),
      action("code", "New script", "A plain .py file", () => a.newScript()),
    );
    const sections = [];
    const drafts = a.unsavedDrafts();
    if (drafts.length) {
      const list = el("div", { class: "file-list" });
      for (const d of drafts) {
        const row = el("div", { class: "recent-row" },
          el("button", { class: "recent-open", type: "button", onclick: () => a.openDraft(d) },
            icon(d.kind === "notebook" ? "notebook" : "code", 20),
            el("span", { class: "recent-text" }, el("span", { class: "recent-name" }, d.name), el("span", { class: "recent-meta" }, "Not saved · " + timeAgo(d.time)))),
          iconButton("close", "Discard draft", async () => {
            if (await confirmDialog(`Discard ${d.name}?`, "This unsaved draft will be deleted.", "Discard", true)) {
              a.clearDraft(d.key);
              a.showHome();
            }
          }, { size: 18 }));
        list.append(row);
      }
      sections.push(el("section", { class: "home-section" }, el("h2", { class: "home-h2" }, "Unsaved work"), list));
    }
    const recents = recentFiles();
    const rlist = el("div", { class: "file-list" });
    rlist.append(el("div", { class: "recent-row" },
      el("button", { class: "recent-open", type: "button", onclick: () => a.openWelcome() },
        icon("info", 20),
        el("span", { class: "recent-text" }, el("span", { class: "recent-name" }, "Welcome.ipynb"), el("span", { class: "recent-meta" }, "A short tour: text, math, plots, input()")))));
    for (const r of recents) {
      rlist.append(el("div", { class: "recent-row" },
        el("button", { class: "recent-open", type: "button", onclick: () => a.openRecent(r) },
          icon(r.kind === "notebook" ? "notebook" : "code", 20),
          el("span", { class: "recent-text" }, el("span", { class: "recent-name" }, r.name), el("span", { class: "recent-meta" }, timeAgo(r.time)))),
        iconButton("close", "Remove from recent", () => {
          removeRecent(r.uri);
          a.showHome();
        }, { size: 18 })));
    }
    sections.push(el("section", { class: "home-section" }, el("h2", { class: "home-h2" }, recents.length ? "Recent" : "Start here"), rlist));
    const foot = el("footer", { class: "home-foot" },
      el("button", { class: "btn ghost", type: "button", onclick: () => a.openPackages(null) }, icon("package", 18), " Offline packages"));
    this.root = el("div", { class: "screen home-screen" }, header, tagline, actions, ...sections, foot);
  }

  async onBack() {
    return false;
  }

  onPause() {}

  destroy() {}

  kind() {
    return "home";
  }
}

// ---------------------------------------------------------------------- boot

connectBridge().then((bridge) => {
  const app = new App(bridge);
  window.__app = app;
  app.init().catch((e) => {
    console.error(e);
    toast("Startup problem: " + e.message);
  });
});
