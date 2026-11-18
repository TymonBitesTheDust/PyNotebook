// Connection to the host the app runs in:
//   AndroidBridge  the Android app (WebMessagePort to MainActivity)
//   ExeBridge      PyNotebook.exe on Windows (a local server on 127.0.0.1)
//   BrowserBridge  a plain browser: the single-file HTML, or the dev server

const listeners = {};

export function onHostEvent(name, fn) {
  (listeners[name] ||= []).push(fn);
}

function emit(name, data) {
  for (const fn of listeners[name] || []) {
    try {
      fn(data);
    } catch (e) {
      console.error(e);
    }
  }
}

class AndroidBridge {
  constructor(port) {
    this.port = port;
    this.isAndroid = true;
    this.platform = "android";
    this.stdinViaServer = true;
    this.packageNote = "Package downloads are managed by the Android app.";
    this.pending = new Map();
    this.seq = 1;
    port.onmessage = (e) => {
      let m;
      try {
        m = JSON.parse(e.data);
      } catch {
        return;
      }
      if (m.event) {
        emit(m.event, m);
        return;
      }
      const p = this.pending.get(m.id);
      if (!p) return;
      this.pending.delete(m.id);
      if (m.error) p.reject(new Error(m.error));
      else p.resolve(m.result);
    };
  }

  call(method, ...args) {
    const id = this.seq++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.port.postMessage(JSON.stringify({ id, method, args }));
    });
  }

  openDocument(kinds) { return this.call("openDocument", kinds || []); }
  readDocument(uri) { return this.call("readDocument", uri); }
  writeDocument(uri, text) { return this.call("writeDocument", uri, text); }
  createDocument(name, mime, text, base64) { return this.call("createDocument", name, mime, text ?? null, base64 ?? null); }
  pickFiles() { return this.call("pickFiles"); }
  pendingIntent() { return this.call("pendingIntent"); }
  openUrl(url) { return this.call("openUrl", url); }
  listCache() { return this.call("listCache"); }
  clearCache() { return this.call("clearCache"); }
  setTheme(dark, color) { return this.call("setTheme", !!dark, color); }
  stdinReply(id, text) { return this.call("stdinReply", id, text); }
  info() { return this.call("info"); }
  exit() { return this.call("exit"); }
  toast(msg) { return this.call("toast", msg); }
}

// ---------------------------------------------------------------------- file handles (Edge/Chrome)

const HANDLE_DB = "pynotebook-handles";

function handleDb() {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(HANDLE_DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore("h");
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

async function dbOp(mode, fn) {
  const db = await handleDb();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction("h", mode);
      const req = fn(tx.objectStore("h"));
      tx.oncomplete = () => resolve(req && req.result);
      tx.onerror = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

const getHandle = (id) => dbOp("readonly", (st) => st.get(id));
const putHandle = (id, h) => dbOp("readwrite", (st) => st.put(h, id));
const allHandles = () => dbOp("readonly", (st) => st.getAll());
const allHandleKeys = () => dbOp("readonly", (st) => st.getAllKeys());

async function ensurePermission(handle, mode) {
  const opts = { mode };
  if ((await handle.queryPermission(opts)) === "granted") return;
  if ((await handle.requestPermission(opts)) === "granted") return;
  const err = new Error(mode === "readwrite"
    ? "PyNotebook wasn't allowed to save to this file."
    : "PyNotebook wasn't allowed to open this file.");
  err.name = "NotAllowedError";
  throw err;
}

const PICKER_TYPES = [
  { description: "Notebooks and Python files", accept: { "application/x-ipynb+json": [".ipynb"], "text/x-python": [".py"] } },
  { description: "Text and JSON", accept: { "text/plain": [".txt"], "application/json": [".json"] } },
];

function saveTypes(name) {
  if (/\.ipynb$/i.test(name)) return [{ description: "Jupyter notebook", accept: { "application/x-ipynb+json": [".ipynb"] } }];
  if (/\.py$/i.test(name)) return [{ description: "Python file", accept: { "text/x-python": [".py"] } }];
  return undefined;
}

const isAbort = (e) => e && e.name === "AbortError";

function bytesFromBase64(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

// ---------------------------------------------------------------------- browser (single-file HTML, dev)

class BrowserBridge {
  constructor() {
    this.isAndroid = false;
    this.platform = "browser";
    this.fsa = typeof window.showOpenFilePicker === "function";
    // The dev server answers blocking input() requests; elsewhere input() uses JSPI.
    this.stdinViaServer = location.protocol === "http:" && location.hostname === "127.0.0.1" && !this.isExe;
    this.packageNote = "Packages download from the internet the first time you import them. Your browser keeps them in its cache, so they usually load offline afterwards.";
  }

  _pick(accept, multiple) {
    return new Promise((resolve) => {
      const input = document.createElement("input");
      input.type = "file";
      if (accept) input.accept = accept;
      input.multiple = !!multiple;
      input.onchange = () => resolve(Array.from(input.files || []));
      input.addEventListener("cancel", () => resolve([]));
      input.click();
    });
  }

  // Store a file handle and return a stable "fsa:" uri for it (the same file gets the same uri).
  async adoptHandle(handle) {
    let id = null;
    try {
      const keys = await allHandleKeys();
      const values = await allHandles();
      for (let i = 0; i < keys.length; i++) {
        if (values[i] && (await values[i].isSameEntry(handle))) {
          id = keys[i];
          break;
        }
      }
    } catch {}
    if (!id) id = Math.random().toString(36).slice(2) + Date.now().toString(36);
    try {
      await putHandle(id, handle);
    } catch {}
    const file = await handle.getFile();
    return { uri: "fsa:" + id, name: handle.name, text: await file.text(), writable: true, persistent: true };
  }

  async openDocument() {
    if (this.fsa) {
      let handle;
      try {
        [handle] = await window.showOpenFilePicker({ types: PICKER_TYPES, multiple: false, id: "pynotebook-open" });
      } catch (e) {
        if (isAbort(e)) return null;
        throw e;
      }
      return this.adoptHandle(handle);
    }
    const [f] = await this._pick(".ipynb,.py,.txt,.json");
    if (!f) return null;
    return { uri: null, name: f.name, text: await f.text(), writable: false, persistent: false };
  }

  async readDocument(uri) {
    if (!uri || !uri.startsWith("fsa:")) throw new Error("This file can't be reopened here. Use Open file instead.");
    const handle = await getHandle(uri.slice(4));
    if (!handle) throw new Error("This file is no longer in PyNotebook's list. Use Open file instead.");
    await ensurePermission(handle, "read");
    const file = await handle.getFile();
    return { uri, name: handle.name, text: await file.text(), writable: true, persistent: true };
  }

  async writeDocument(uri, text) {
    if (!uri || !uri.startsWith("fsa:")) throw new Error("readonly");
    const handle = await getHandle(uri.slice(4));
    if (!handle) throw new Error("readonly");
    await ensurePermission(handle, "readwrite");
    const w = await handle.createWritable();
    await w.write(text);
    await w.close();
    return true;
  }

  async createDocument(name, mime, text, base64) {
    const data = base64 != null ? bytesFromBase64(base64) : text;
    if (typeof window.showSaveFilePicker === "function") {
      let handle;
      try {
        handle = await window.showSaveFilePicker({ suggestedName: name, types: saveTypes(name), id: "pynotebook-save" });
      } catch (e) {
        if (isAbort(e)) return null;
        throw e;
      }
      const w = await handle.createWritable();
      await w.write(data);
      await w.close();
      const adopted = await this.adoptHandle(handle);
      return { uri: adopted.uri, name: handle.name };
    }
    const blob = new Blob([data], { type: mime });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    return { uri: null, name, downloaded: true };
  }

  async pickFiles() {
    const files = await this._pick("", true);
    const out = [];
    for (const f of files) {
      const buf = new Uint8Array(await f.arrayBuffer());
      let s = "";
      for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
      out.push({ name: f.name, base64: btoa(s), size: f.size });
    }
    return out;
  }

  async pendingIntent() { return null; }
  async pendingFiles() { return []; }
  async openUrl(url) { window.open(url, "_blank", "noopener"); }
  async listCache() { return null; }
  async clearCache() { return false; }
  async setTheme() {}
  async stdinReply(id, text) {
    await fetch("/__stdin_reply", { method: "POST", body: JSON.stringify({ id, text }) });
  }
  async info() {
    return { platform: this.platform, dark: matchMedia("(prefers-color-scheme: dark)").matches, version: "" };
  }
  async exit() {}
  async toast() {}
}

// ---------------------------------------------------------------------- Windows exe (local server)

class ExeBridge extends BrowserBridge {
  constructor(token, openId) {
    super();
    this.isExe = true;
    this.platform = "windows";
    this.token = token;
    this.openId = openId;
    this.stdinViaServer = true;
    this.packageNote = "";
    this.lostShown = false;
    this._events();
  }

  async api(path, body) {
    const r = await fetch(path, {
      method: body === undefined ? "GET" : "POST",
      headers: { "X-PNB-Token": this.token, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (r.status === 401) throw new Error("This window belongs to a PyNotebook session that has ended. Close it and start PyNotebook again.");
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || `PyNotebook couldn't do that (${r.status}).`);
    return data;
  }

  // Keeps PyNotebook.exe running while this window is open.
  _events() {
    let failures = 0;
    const connect = () => {
      const es = new EventSource("/__pnb/events?t=" + encodeURIComponent(this.token));
      es.onopen = () => {
        failures = 0;
      };
      es.onerror = () => {
        es.close();
        failures++;
        if (failures === 3 && !this.lostShown) {
          this.lostShown = true;
          emit("hostLost", {});
        }
        setTimeout(connect, Math.min(10000, 1000 * failures));
      };
    };
    connect();
  }

  async info() {
    const i = await this.api("/__pnb/hello");
    return { ...i, dark: matchMedia("(prefers-color-scheme: dark)").matches };
  }

  async pendingFiles() {
    if (!this.openId) return [];
    const id = this.openId;
    this.openId = null;
    const r = await this.api("/__pnb/pending?id=" + encodeURIComponent(id));
    return (r.files || []).map((f) => ({ uri: "path:" + f.path, name: f.name, text: f.text, writable: true, persistent: true, error: f.error }));
  }

  async readDocument(uri) {
    if (uri && uri.startsWith("path:")) {
      const f = await this.api("/__pnb/read", { path: uri.slice(5) });
      return { uri, name: f.name, text: f.text, writable: true, persistent: true };
    }
    return super.readDocument(uri);
  }

  async writeDocument(uri, text) {
    if (uri && uri.startsWith("path:")) {
      await this.api("/__pnb/write", { path: uri.slice(5), text });
      return true;
    }
    return super.writeDocument(uri, text);
  }

  async openUrl(url) {
    await this.api("/__pnb/open-url", { url });
  }

  async listCache() {
    return (await this.api("/__pnb/cache")).files;
  }

  async clearCache() {
    await this.api("/__pnb/cache-clear", {});
    return true;
  }

  async stdinReply(id, text) {
    await this.api("/__pnb/stdin-reply", { id, text });
  }

  async openWith(enable) {
    return this.api("/__pnb/open-with", { enable: !!enable });
  }
}

export let bridge = null;

// The exe opens this page as /app/index.html#pnb=<token>&open=<id>.
function exeSession() {
  const h = new URLSearchParams(location.hash.slice(1));
  let token = h.get("pnb");
  const openId = h.get("open");
  try {
    if (token) sessionStorage.setItem("pnb.token", token);
    else token = sessionStorage.getItem("pnb.token");
  } catch {}
  if (h.get("pnb")) history.replaceState(null, "", location.pathname + location.search);
  return token && location.protocol === "http:" ? { token, openId } : null;
}

export function connectBridge() {
  if (bridge) return Promise.resolve(bridge);
  const onAndroid = /PyNotebookApp\//.test(navigator.userAgent);
  if (!onAndroid) {
    const exe = exeSession();
    bridge = exe ? new ExeBridge(exe.token, exe.openId) : new BrowserBridge();
    return Promise.resolve(bridge);
  }
  return new Promise((resolve) => {
    const take = (port) => {
      if (bridge) return;
      bridge = new AndroidBridge(port);
      resolve(bridge);
    };
    if (window.__hostPort) take(window.__hostPort);
    window.addEventListener("message", (e) => {
      if (e.data === "pynotebook:port" && e.ports && e.ports[0]) take(e.ports[0]);
    });
    setTimeout(() => {
      if (!bridge) {
        console.warn("Android host port did not arrive; using browser bridge");
        bridge = new BrowserBridge();
        resolve(bridge);
      }
    }, 20000);
  });
}
