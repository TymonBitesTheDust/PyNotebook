// Builds the web app.
//
//   node build.mjs            -> dist/        app served next to Pyodide (Android app, Windows exe)
//   node build.mjs --single   -> also dist-single/PyNotebook.html, one self-contained file
//
// Environment: PYODIDE_DIR (default ~/vendor/pyodide/package), APP_VERSION.
import { build } from "esbuild";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";
import { makeNotices } from "./licences.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const src = path.join(here, "src");
const dist = path.join(here, "dist");
const vendor = path.join(src, "vendor");
const PYODIDE = process.env.PYODIDE_DIR || path.join(os.homedir(), "vendor", "pyodide", "package");
const APP_VERSION = process.env.APP_VERSION || "1.5.1";
const single = process.argv.includes("--single");
const pyodideVersion = JSON.parse(fs.readFileSync(path.join(PYODIDE, "package.json"), "utf8")).version;

fs.rmSync(dist, { recursive: true, force: true });
fs.mkdirSync(dist, { recursive: true });

// KaTeX CSS with only woff2 fonts (all supported browsers read them; saves ~1 MB).
fs.mkdirSync(path.join(vendor, "fonts"), { recursive: true });
const katexDir = path.join(here, "node_modules", "katex", "dist");
let css = fs.readFileSync(path.join(katexDir, "katex.min.css"), "utf8");
css = css.replace(/,url\(fonts\/[^)]+\.woff\) format\("woff"\)/g, "").replace(/,url\(fonts\/[^)]+\.ttf\) format\("truetype"\)/g, "");
fs.writeFileSync(path.join(vendor, "katex.css"), css);
for (const f of fs.readdirSync(path.join(katexDir, "fonts"))) {
  if (f.endsWith(".woff2")) fs.copyFileSync(path.join(katexDir, "fonts", f), path.join(vendor, "fonts", f));
}

const common = {
  bundle: true,
  minify: true,
  sourcemap: false,
  target: ["chrome89"],
  alias: { "katex/dist/katex.min.css": path.join(vendor, "katex.css") },
  legalComments: "eof",
  logLevel: "warning",
};

// ------------------------------------------------------------------ dist/ (served build)

const appBuild = await build({
  ...common,
  entryPoints: { app: path.join(src, "main.js") },
  format: "esm",
  outdir: dist,
  loader: { ".woff2": "file", ".woff": "file", ".ttf": "file" },
  assetNames: "assets/[name]-[hash]",
  metafile: true,
});

// Open-source notices: shown in Settings > About, and kept in the repository.
const notices = makeNotices({ metafile: appBuild.metafile, webDir: here, repoDir: path.join(here, ".."), pyodideDir: PYODIDE });
fs.writeFileSync(path.join(dist, "licenses.json"), JSON.stringify(notices.json));
fs.writeFileSync(path.join(here, "..", "THIRD_PARTY_NOTICES.txt"), notices.text);

fs.copyFileSync(path.join(src, "index.html"), path.join(dist, "index.html"));
fs.copyFileSync(path.join(src, "worker.js"), path.join(dist, "worker.js"));
fs.copyFileSync(path.join(src, "welcome.ipynb"), path.join(dist, "welcome.ipynb"));
if (fs.existsSync(path.join(src, "icon.png"))) fs.copyFileSync(path.join(src, "icon.png"), path.join(dist, "icon.png"));
const buildInfo = { app: APP_VERSION, pyodide: pyodideVersion };
fs.writeFileSync(path.join(dist, "build-info.json"), JSON.stringify(buildInfo));

// Python kernel sources, bundled into one JSON file the worker writes into Pyodide's FS.
const pyRoot = path.join(here, "py");
const pyBundle = {};
const walk = (dir) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name !== "__pycache__") walk(p);
    } else if (e.name.endsWith(".py")) {
      pyBundle[path.relative(pyRoot, p).split(path.sep).join("/")] = fs.readFileSync(p, "utf8");
    }
  }
};
walk(pyRoot);
fs.writeFileSync(path.join(dist, "py-bundle.json"), JSON.stringify(pyBundle));

report(dist, "web build");

// ------------------------------------------------------------------ dist-single/PyNotebook.html

if (single) {
  const out = path.join(here, "dist-single");
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(out, { recursive: true });

  // Pyodide's files come from PYODIDE_DIR instead of the server.
  const pyodidePlugin = {
    name: "pyodide",
    setup(b) {
      b.onResolve({ filter: /pyodide\/pyodide(\.asm)?\.mjs$/ }, (args) => ({ path: path.join(PYODIDE, path.basename(args.path)) }));
    },
  };
  const nodeOnly = ["node:*", "fs", "path", "crypto", "ws", "url", "vm", "child_process", "module", "worker_threads"];

  const app = await build({
    ...common,
    entryPoints: [path.join(src, "main.js")],
    format: "esm",
    write: false,
    outdir: out,
    loader: { ".woff2": "dataurl", ".woff": "dataurl", ".ttf": "dataurl" },
  });
  const appJs = app.outputFiles.find((f) => f.path.endsWith(".js")).text;
  const appCss = app.outputFiles.find((f) => f.path.endsWith(".css")).text;

  const worker = await build({
    ...common,
    stdin: {
      contents: `import createPyodideModule from "../pyodide/pyodide.asm.mjs";\nimport "./worker.js";\nself.__pnbCreateModule = createPyodideModule;\n`,
      resolveDir: src,
      loader: "js",
    },
    // Pages opened from disk (file://) can only start classic workers from blob: URLs.
    // Pyodide refuses classic workers by probing importScripts, so hide it.
    format: "iife",
    banner: { js: "self.importScripts = function () { throw new TypeError('importScripts is not available'); };" },
    write: false,
    platform: "browser",
    target: ["chrome110"],
    external: nodeOnly,
    plugins: [pyodidePlugin],
    logLevel: "error",
  });
  const workerJs = worker.outputFiles[0].text;

  const gz64 = (buf) => zlib.gzipSync(buf, { level: 9 }).toString("base64");
  const blocks = [
    ["build-info.json", "text", JSON.stringify({ ...buildInfo, platform: "html" })],
    ["worker.js", "gz64", gz64(Buffer.from(workerJs))],
    ["py-bundle.json", "gz64", gz64(Buffer.from(JSON.stringify(pyBundle)))],
    ["welcome.ipynb", "gz64", gz64(fs.readFileSync(path.join(src, "welcome.ipynb")))],
    ["licenses.json", "gz64", gz64(Buffer.from(JSON.stringify(notices.json)))],
    ["pyodide-lock.json", "gz64", gz64(fs.readFileSync(path.join(PYODIDE, "pyodide-lock.json")))],
    ["pyodide.asm.wasm", "gz64", gz64(fs.readFileSync(path.join(PYODIDE, "pyodide.asm.wasm")))],
    // Already compressed, so stored as plain base64.
    ["python_stdlib.zip", "b64", fs.readFileSync(path.join(PYODIDE, "python_stdlib.zip")).toString("base64")],
  ];

  // Inline <script> content must not contain "</script", "<script" or "<!--" (they change how
  // HTML parses the script). In this bundle they only occur inside strings and regexes, where
  // \x3C means the same "<".
  if (/\\(<!--|<\/?script)/i.test(appJs)) throw new Error("app bundle has an escaped '<' that can't be rewritten safely");
  const safeJs = appJs.replace(/<(!--|\/?script)/gi, "\\x3C$1");
  const icon = fs.existsSync(path.join(src, "icon.png")) ? "data:image/png;base64," + fs.readFileSync(path.join(src, "icon.png")).toString("base64") : "";
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content">
<meta name="theme-color" content="#F3F6F5">
<meta name="color-scheme" content="light dark">
<title>PyNotebook</title>
${icon ? `<link rel="icon" href="${icon}">` : ""}
<style>${appCss}</style>
</head>
<body>
<div id="app"><div class="boot">Loading PyNotebook…</div></div>
<noscript>PyNotebook needs JavaScript. Open this file in Microsoft Edge or Google Chrome.</noscript>
<script type="module">${safeJs}</script>
${blocks.map(([name, enc, data]) => `<script type="application/x-pnb" data-name="${name}" data-enc="${enc}">${data}</script>`).join("\n")}
</body>
</html>
`;
  fs.writeFileSync(path.join(out, "PyNotebook.html"), html);
  console.log(`single file: ${(html.length / 1e6).toFixed(1)} MB  (worker ${(workerJs.length / 1e6).toFixed(2)} MB before compression)`);
}

function report(dir, label) {
  let total = 0;
  const list = [];
  const walkDist = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walkDist(p);
      else {
        const s = fs.statSync(p).size;
        total += s;
        list.push([path.relative(dir, p), s]);
      }
    }
  };
  walkDist(dir);
  list.sort((a, b) => b[1] - a[1]);
  console.log(`${label}: ${(total / 1024).toFixed(0)} KB in ${list.length} files`);
  for (const [f, s] of list.slice(0, 4)) console.log("  ", f, (s / 1024).toFixed(0) + " KB");
}
