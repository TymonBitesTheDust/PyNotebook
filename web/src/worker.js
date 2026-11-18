// Python kernel worker: hosts Pyodide and runs the notebook kernel.
// Messages in:  {cmd:'init'|'execute'|'complete'|'loadPackages'|'fs', id, ...}
// Messages out: {type:'status'|'ready'|'iopub'|'input_request'|'reply'|'fatal', ...}

import { loadPyodide } from "../pyodide/pyodide.mjs";

let pyodide = null;
let kernelMod = null;
let interruptView = null;
let inputSab = null;
let stdinMode = "xhr";
let workspaceMounted = false;
const mounts = new Map(); // path -> {syncfs}
const stdinWaiters = new Map(); // id -> resolve (promise mode)

const post = (m) => self.postMessage(m);
const newId = () => Math.random().toString(36).slice(2) + Date.now().toString(36);

function readInput(prompt, password) {
  if (stdinMode === "promise") {
    // Returns a Promise; Python waits on it with pyodide.ffi.run_sync (JSPI).
    const id = newId();
    post({ type: "input_request", prompt, password, mode: "promise", id });
    return new Promise((resolve) => stdinWaiters.set(id, resolve));
  }
  if (stdinMode === "none") return null;
  if (inputSab) {
    const ctl = new Int32Array(inputSab, 0, 2);
    Atomics.store(ctl, 0, 0);
    post({ type: "input_request", prompt, password, mode: "sab" });
    while (Atomics.load(ctl, 0) === 0) Atomics.wait(ctl, 0, 0, 500);
    const state = Atomics.load(ctl, 0);
    const len = Atomics.load(ctl, 1);
    let text = null;
    if (state === 1) text = new TextDecoder().decode(new Uint8Array(inputSab, 8, len).slice());
    Atomics.store(ctl, 0, 0);
    if (interruptView) interruptView[0] = 0;
    return text;
  }
  const id = newId();
  post({ type: "input_request", prompt, password, mode: "xhr", id });
  try {
    const xhr = new XMLHttpRequest();
    xhr.open("GET", "/__stdin?id=" + encodeURIComponent(id), false);
    xhr.send(null);
    if (xhr.status !== 200) return null;
    const r = JSON.parse(xhr.responseText);
    return r && typeof r.text === "string" ? r.text : null;
  } catch (e) {
    return null;
  }
}

const bridge = {
  send: (s) => post({ type: "iopub", msg: s }),
  input: (prompt, password) => readInput(prompt, password),
};

const platform = {
  loadImports: async (code) => {
    await pyodide.loadPackagesFromImports(code, {
      messageCallback: (msg) => post({ type: "iopub", msg: JSON.stringify({ type: "status", text: msg }) }),
      errorCallback: (msg) => post({ type: "iopub", msg: JSON.stringify({ type: "status", text: msg, error: true }) }),
    });
  },
  loadPackages: async (names) => {
    const list = names.toJs ? names.toJs() : names;
    await pyodide.loadPackage(list, {
      messageCallback: (msg) => post({ type: "iopub", msg: JSON.stringify({ type: "status", text: msg }) }),
      errorCallback: (msg) => post({ type: "iopub", msg: JSON.stringify({ type: "status", text: msg, error: true }) }),
    });
  },
};

function syncfs(populate) {
  return new Promise((resolve) => {
    if (!workspaceMounted) return resolve();
    try {
      pyodide.FS.syncfs(populate, () => resolve());
    } catch (e) {
      resolve();
    }
  });
}

// Single-file build: Python's files come from the page instead of a server.
const EMBED_URL = "https://pynotebook.invalid/pyodide/";
function useEmbedded(E) {
  const realFetch = self.fetch.bind(self);
  self.fetch = (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url && url.startsWith(EMBED_URL)) {
      const name = url.slice(EMBED_URL.length);
      if (name === "pyodide.asm.wasm") return Promise.resolve(new Response(E.wasm, { headers: { "Content-Type": "application/wasm" } }));
      if (name === "python_stdlib.zip") return Promise.resolve(new Response(E.stdlib));
      return realFetch(E.cdn + name, init);
    }
    return realFetch(input, init);
  };
}

async function init(m) {
  post({ type: "status", text: "Loading Python…" });
  if (m.interruptSab) {
    interruptView = new Int8Array(m.interruptSab);
  }
  if (m.inputSab) inputSab = m.inputSab;
  stdinMode = m.stdinMode || (inputSab ? "sab" : "xhr");
  const t0 = performance.now();
  const E = m.embedded;
  const config = {
    // (A blob: worker URL can't be a base for relative URLs, so only resolve when served.)
    indexURL: E ? EMBED_URL : new URL("../pyodide/", self.location.href).href,
    env: { HOME: "/home/pyodide", MPLBACKEND: "module://_nb_inline_backend" },
    stdout: (s) => post({ type: "iopub", msg: JSON.stringify({ type: "stream", name: "stdout", text: s + "\n" }) }),
    stderr: (s) => post({ type: "iopub", msg: JSON.stringify({ type: "stream", name: "stderr", text: s + "\n" }) }),
  };
  if (E) {
    useEmbedded(E);
    config.indexURL = EMBED_URL;
    config.lockFileContents = E.lock;
    config.packageBaseUrl = E.cdn;
    if (self.__pnbCreateModule) config.createPyodideModule = self.__pnbCreateModule;
  }
  pyodide = await loadPyodide(config);
  post({ type: "status", text: "Starting kernel…" });
  if (interruptView) pyodide.setInterruptBuffer(interruptView);

  // Kernel sources
  const bundle = E ? E.pyBundle : await (await fetch(new URL("py-bundle.json", self.location.href))).json();
  for (const [path, src] of Object.entries(bundle)) {
    const full = "/opt/pynotebook/" + path;
    pyodide.FS.mkdirTree(full.slice(0, full.lastIndexOf("/")));
    pyodide.FS.writeFile(full, src);
  }

  // Persistent workspace (IndexedDB backed)
  try {
    pyodide.FS.mkdirTree("/home/pyodide");
    pyodide.FS.mount(pyodide.FS.filesystems.IDBFS, {}, "/home/pyodide");
    workspaceMounted = true;
    await syncfs(true);
  } catch (e) {
    workspaceMounted = false;
  }

  const lock = E ? E.lock : await (await fetch(new URL("../pyodide/pyodide-lock.json", self.location.href))).json();
  const lockImports = [];
  for (const p of Object.values(lock.packages || {})) for (const i of p.imports || []) lockImports.push(i);
  self.lockImports = lockImports;

  pyodide.runPython(`
import sys, os
sys.path.insert(0, "/opt/pynotebook")
os.chdir("/home/pyodide")
`);
  kernelMod = pyodide.pyimport("_nbkernel");
  kernelMod.init(bridge, platform, pyodide.toPy(lockImports));
  const version = pyodide.runPython("import sys; sys.version.split()[0]");
  post({
    type: "ready",
    python: version,
    pyodide: pyodide.version,
    seconds: (performance.now() - t0) / 1000,
    sab: !!inputSab,
    stdinMode,
    persistent: workspaceMounted,
  });
}

async function syncMounts() {
  for (const m of mounts.values()) {
    try {
      await m.syncfs();
    } catch (e) {
      post({ type: "iopub", msg: JSON.stringify({ type: "stream", name: "stderr", text: `Couldn't save files to the folder: ${e.message}\n` }) });
    }
  }
}

async function mountFolder(handle) {
  const safe = String(handle.name || "folder").replace(/[^\w.\- ]+/g, "_").trim() || "folder";
  const path = "/mnt/" + safe;
  if (mounts.has(path)) {
    try {
      pyodide.FS.unmount(path);
    } catch {}
    mounts.delete(path);
  }
  pyodide.FS.mkdirTree(path);
  const nfs = await pyodide.mountNativeFS(path, handle);
  mounts.set(path, nfs);
  pyodide.runPython(`import os; os.chdir(${JSON.stringify(path)})`);
  return { path, name: handle.name };
}

async function handle(m) {
  switch (m.cmd) {
    case "init":
      await init(m);
      return undefined;
    case "execute": {
      if (interruptView) interruptView[0] = 0;
      const res = await kernelMod.execute(m.code, !!m.silent, !!m.fresh);
      await syncfs(false);
      await syncMounts();
      return JSON.parse(res);
    }
    case "complete": {
      const res = kernelMod.complete(m.code, m.pos);
      return JSON.parse(res);
    }
    case "lint": {
      const ctx = m.context && m.context.length ? pyodide.toPy(m.context) : null;
      try {
        return JSON.parse(kernelMod.lint(m.code, ctx));
      } finally {
        if (ctx) ctx.destroy();
      }
    }
    case "loadPackages": {
      await platform.loadPackages(m.names);
      return true;
    }
    case "fs":
      return fsOp(m);
    case "mount":
      return mountFolder(m.handle);
    default:
      throw new Error("unknown command " + m.cmd);
  }
}

function b64encode(bytes) {
  let s = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) s += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  return btoa(s);
}

function b64decode(str) {
  const bin = atob(str);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function fsOp(m) {
  const FS = pyodide.FS;
  // "root" picks the area: the app's own folder, or a folder mounted from this computer.
  const base = m.root && mounts.has(m.root) ? m.root : "/home/pyodide";
  const isMount = base !== "/home/pyodide";
  const flush = async () => (isMount ? syncMounts() : syncfs(false));
  const clean = (p) => {
    const parts = [];
    for (const seg of String(p || "").split("/")) {
      if (!seg || seg === ".") continue;
      if (seg === "..") parts.pop();
      else parts.push(seg);
    }
    return base + (parts.length ? "/" + parts.join("/") : "");
  };
  const path = clean(m.path);
  switch (m.op) {
    case "list": {
      const out = [];
      for (const name of FS.readdir(path)) {
        if (name === "." || name === "..") continue;
        const st = FS.stat(path + "/" + name);
        out.push({ name, dir: FS.isDir(st.mode), size: st.size, mtime: +st.mtime });
      }
      out.sort((a, b) => (b.dir - a.dir) || a.name.localeCompare(b.name));
      return out;
    }
    case "write": {
      FS.mkdirTree(path.slice(0, path.lastIndexOf("/")) || base);
      FS.writeFile(path, b64decode(m.data));
      await flush();
      return true;
    }
    case "read":
      return b64encode(FS.readFile(path));
    case "delete": {
      const st = FS.stat(path);
      if (FS.isDir(st.mode)) {
        const rm = (p) => {
          for (const n of FS.readdir(p)) {
            if (n === "." || n === "..") continue;
            const c = p + "/" + n;
            if (FS.isDir(FS.stat(c).mode)) rm(c);
            else FS.unlink(c);
          }
          FS.rmdir(p);
        };
        rm(path);
      } else FS.unlink(path);
      await flush();
      return true;
    }
    case "mkdir":
      FS.mkdirTree(path);
      await flush();
      return true;
    case "where":
      return { cwd: pyodide.runPython("import os; os.getcwd()"), mounts: [...mounts.keys()], persistent: workspaceMounted };
    case "chdir":
      pyodide.runPython(`import os; os.chdir(${JSON.stringify(base)})`);
      return base;
    default:
      throw new Error("unknown fs op " + m.op);
  }
}

let chain = Promise.resolve();
self.onmessage = (e) => {
  const m = e.data;
  if (m.cmd === "stdin") {
    // Answer to input() in promise mode; Python is paused waiting for it.
    const resolve = stdinWaiters.get(m.id);
    stdinWaiters.delete(m.id);
    if (resolve) resolve(m.text == null ? null : String(m.text));
    if (m.text == null && interruptView) interruptView[0] = 0;
    return;
  }
  // Completions and file listings may run while a cell awaits; executions are serialised.
  const run = async () => {
    try {
      const result = await handle(m);
      post({ type: "reply", id: m.id, result });
    } catch (err) {
      const msg = (err && err.message) || String(err);
      post({ type: "reply", id: m.id, error: msg });
      if (m.cmd === "init" || /fatal|Aborted|RuntimeError: memory|out of memory/i.test(msg)) {
        post({ type: "fatal", error: msg });
      }
    }
  };
  if (m.cmd === "execute" || m.cmd === "init" || m.cmd === "loadPackages") {
    chain = chain.then(run);
  } else {
    run();
  }
};
