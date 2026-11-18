// Where the app's own files come from. Normally they are served next to the page
// (Android app, Windows exe, dev server). In the single-file HTML build they are
// embedded in the page as <script type="application/x-pnb" data-name=... data-enc=...>
// blocks, and the Python worker is started from a Blob.

const embedded = typeof document !== "undefined" ? document.querySelectorAll("script[type='application/x-pnb']") : [];

export const isSingleFile = embedded.length > 0;

function block(name) {
  for (const s of embedded) if (s.dataset.name === name) return s;
  return null;
}

async function decode(node) {
  const enc = node.dataset.enc || "text";
  const text = node.textContent.trim();
  if (enc === "text") return new Blob([text]);
  // base64, optionally gzip-compressed
  let bytes;
  try {
    bytes = await (await fetch("data:application/octet-stream;base64," + text)).arrayBuffer();
  } catch {
    const bin = atob(text);
    bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  }
  if (enc === "gz64") {
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
    return await new Response(stream).blob();
  }
  return new Blob([bytes]);
}

const cache = new Map();
function embeddedBlob(name, type) {
  if (!cache.has(name)) {
    const node = block(name);
    if (!node) throw new Error("Missing embedded file " + name);
    cache.set(name, decode(node).then((b) => (type ? new Blob([b], { type }) : b)));
  }
  return cache.get(name);
}

// Text of an app file such as "welcome.ipynb" or "pyodide-lock.json".
export async function assetText(name) {
  if (isSingleFile) return (await embeddedBlob(name)).text();
  const url = name === "pyodide-lock.json" ? "../pyodide/pyodide-lock.json" : name;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Couldn't load ${name} (${r.status})`);
  return r.text();
}

export async function assetJSON(name) {
  return JSON.parse(await assetText(name));
}

// The single-file build's worker is a classic script (see build.mjs).
export const workerType = isSingleFile ? "classic" : "module";

let workerUrlPromise = null;
export function workerURL() {
  if (!isSingleFile) return Promise.resolve(new URL("./worker.js", location.href));
  workerUrlPromise ||= embeddedBlob("worker.js", "text/javascript").then((b) => URL.createObjectURL(b));
  return workerUrlPromise;
}

// Everything the worker needs to start Python without a server (single-file build).
let runtimePromise = null;
export function embeddedRuntime() {
  if (!isSingleFile) return Promise.resolve(null);
  runtimePromise ||= (async () => {
    const [wasm, stdlib, lock, pyBundle, meta] = await Promise.all([
      embeddedBlob("pyodide.asm.wasm", "application/wasm"),
      embeddedBlob("python_stdlib.zip", "application/zip"),
      assetJSON("pyodide-lock.json"),
      assetJSON("py-bundle.json"),
      buildInfo(),
    ]);
    const cdn = `https://cdn.jsdelivr.net/pyodide/v${meta.pyodide}/full/`;
    return { wasm, stdlib, lock, pyBundle, cdn };
  })();
  return runtimePromise;
}

// {app, pyodide, platform} written by the build; absent in dev builds.
let infoPromise = null;
export function buildInfo() {
  infoPromise ||= (async () => {
    if (isSingleFile) return JSON.parse(await (await embeddedBlob("build-info.json")).text());
    try {
      const r = await fetch("build-info.json");
      if (r.ok) return await r.json();
    } catch {}
    return { app: "dev", pyodide: "", platform: "dev" };
  })();
  return infoPromise;
}
