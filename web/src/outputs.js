// Rendering of cell outputs (streams, rich display data, errors) and
// conversion of kernel messages into nbformat outputs.

import { AnsiUp } from "ansi_up";
import { renderMarkdown, renderLatexOutput, sanitize, escapeHtml } from "./markdown.js";
import { el } from "./ui.js";
import { bridge } from "./bridge.js";

const ansi = new AnsiUp();
ansi.use_classes = true;
ansi.escape_html = true;

const MAX_CHARS = 120000;

// Apply carriage returns and backspaces like Jupyter: text after the last \r replaces the line.
// A trailing \r is kept so the next write overwrites that line.
export function collapseCR(text) {
  if (!/[\r\b]/.test(text)) return text;
  text = text.replace(/\r+\n/g, "\n");
  return text
    .split("\n")
    .map((line) => {
      if (line.includes("\r")) {
        const trailing = line.endsWith("\r");
        const parts = line.split("\r").filter((p) => p !== "");
        line = (parts.length ? parts[parts.length - 1] : "") + (trailing ? "\r" : "");
      }
      if (line.includes("\b")) {
        let out = "";
        for (const ch of line) out = ch === "\b" ? out.slice(0, -1) : out + ch;
        line = out;
      }
      return line;
    })
    .join("\n");
}

function ansiHtml(text) {
  return ansi.ansi_to_html(text);
}

// Append a kernel message to an outputs array (nbformat style). Returns the index touched
// or -1 when the outputs were cleared.
export function applyMessage(outputs, msg, state) {
  switch (msg.type) {
    case "stream": {
      if (state.clearPending) {
        outputs.length = 0;
        state.clearPending = false;
      }
      const last = outputs[outputs.length - 1];
      if (last && last.output_type === "stream" && last.name === msg.name) {
        last.text = collapseCR(last.text + msg.text);
        if (last.text.length > MAX_CHARS * 4) last.text = "…[earlier output removed]\n" + last.text.slice(-MAX_CHARS * 2);
        return outputs.length - 1;
      }
      outputs.push({ output_type: "stream", name: msg.name, text: collapseCR(msg.text) });
      return outputs.length - 1;
    }
    case "display_data":
    case "execute_result": {
      if (state.clearPending) {
        outputs.length = 0;
        state.clearPending = false;
      }
      const o = { output_type: msg.type, data: msg.data || {}, metadata: msg.metadata || {} };
      if (msg.type === "execute_result") o.execution_count = msg.execution_count;
      if (msg.transient && msg.transient.display_id) {
        Object.defineProperty(o, "_displayId", { value: msg.transient.display_id, enumerable: false, writable: true });
      }
      outputs.push(o);
      return outputs.length - 1;
    }
    case "update_display_data": {
      const id = msg.transient && msg.transient.display_id;
      let touched = -2;
      outputs.forEach((o, i) => {
        if (o._displayId === id) {
          o.data = msg.data || {};
          o.metadata = msg.metadata || {};
          touched = i;
        }
      });
      return touched;
    }
    case "error":
      if (state.clearPending) {
        outputs.length = 0;
        state.clearPending = false;
      }
      outputs.push({ output_type: "error", ename: msg.ename, evalue: msg.evalue, traceback: msg.traceback || [] });
      return outputs.length - 1;
    case "clear_output":
      if (msg.wait) state.clearPending = true;
      else outputs.length = 0;
      return -1;
  }
  return -2;
}

const ORDER = [
  "application/vnd.jupyter.widget-view+json",
  "text/html",
  "image/svg+xml",
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "text/markdown",
  "text/latex",
  "application/json",
  "application/javascript",
  "text/plain",
];

function pickMime(data) {
  for (const m of ORDER) if (data[m] != null) return m;
  const keys = Object.keys(data);
  return keys[0];
}

const INTERACTIVE = {
  "application/vnd.plotly.v1+json": "Plotly",
  "application/vnd.bokehjs_exec.v0+json": "Bokeh",
  "application/vnd.vegalite.v5+json": "Vega-Lite",
  "application/vnd.vegalite.v4+json": "Vega-Lite",
  "application/vnd.jupyter.widget-view+json": "Jupyter widget",
  "application/vnd.holoviews_exec.v0+json": "HoloViews",
};

function textBlock(text, cls) {
  const pre = el("pre", { class: cls });
  if (text.length > MAX_CHARS) {
    const head = text.slice(0, MAX_CHARS / 2);
    const tail = text.slice(-MAX_CHARS / 4);
    pre.innerHTML = ansiHtml(head);
    const more = el("button", { class: "out-more", type: "button" }, `Show ${(text.length - head.length - tail.length).toLocaleString()} hidden characters`);
    more.onclick = () => {
      pre.innerHTML = ansiHtml(text);
    };
    pre.append(document.createTextNode("\n"), more, document.createTextNode("\n"));
    const t = document.createElement("span");
    t.innerHTML = ansiHtml(tail);
    pre.append(t);
  } else {
    pre.innerHTML = ansiHtml(text);
  }
  return pre;
}

function collapsible(node, lines) {
  if (lines < 60) return node;
  const wrap = el("div", { class: "out-collapse collapsed" }, node);
  const btn = el("button", { class: "out-expand", type: "button" }, `Show all ${lines.toLocaleString()} lines`);
  btn.onclick = () => {
    const c = wrap.classList.toggle("collapsed");
    btn.textContent = c ? `Show all ${lines.toLocaleString()} lines` : "Show less";
  };
  return el("div", null, wrap, btn);
}

function b64ToUtf8(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

function utf8ToB64(str) {
  const bytes = new TextEncoder().encode(str);
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

function imageNode(src, md) {
  const img = el("img", { class: "out-img", src, alt: (md && md.alt) || "Output image", loading: "lazy" });
  if (md && md.width) img.style.width = Math.round(md.width) + "px";
  img.addEventListener("click", () => openImageViewer(src));
  return img;
}

export function openImageViewer(src) {
  const img = el("img", { src, alt: "" });
  let zoom = false;
  const wrap = el("div", { class: "img-viewer", role: "dialog", "aria-label": "Image" }, img);
  img.addEventListener("click", (e) => {
    e.stopPropagation();
    zoom = !zoom;
    wrap.classList.toggle("zoom", zoom);
  });
  wrap.addEventListener("click", () => {
    wrap.remove();
    window.removeEventListener("popstate-viewer", close);
  });
  const close = () => wrap.remove();
  document.body.append(wrap);
  wrap.__close = close;
}

export function renderOutput(o) {
  const t = o.output_type;
  if (t === "stream") {
    const text = o.text.endsWith("\r") ? o.text.slice(0, -1) : o.text;
    const lines = (text.match(/\n/g) || []).length;
    return collapsible(textBlock(text, "out-stream" + (o.name === "stderr" ? " stderr" : "")), lines);
  }
  if (t === "error") {
    const tb = (o.traceback && o.traceback.length ? o.traceback.join("\n") : `${o.ename}: ${o.evalue}`);
    return textBlock(tb, "out-error");
  }
  const data = o.data || {};
  const md = o.metadata || {};
  const wrap = el("div", { class: "out-rich" });
  const interactive = Object.keys(data).find((k) => INTERACTIVE[k]);
  let mime = pickMime(data);
  if (interactive) {
    wrap.append(el("div", { class: "out-note" }, `${INTERACTIVE[interactive]} output is interactive and can't be shown here.`));
    const fallback = ["image/png", "image/svg+xml", "image/jpeg", "text/plain"].find((m) => data[m] != null);
    if (!fallback) return wrap;
    mime = fallback;
  }
  const value = data[mime];
  switch (mime) {
    case "text/html": {
      const clean = sanitize(String(value), { ADD_TAGS: ["style"], FORCE_BODY: true });
      const stripped = clean.replace(/<style[\s\S]*?<\/style>/g, "").replace(/<[^>]+>/g, "").trim();
      if (!stripped && !/<(img|svg|table|hr|video|audio|progress)/i.test(clean)) {
        if (data["text/plain"] != null) return textBlock(String(data["text/plain"]), "out-plain");
        wrap.append(el("div", { class: "out-note" }, "This HTML output uses scripts, which can't run here."));
        return wrap;
      }
      const box = el("div", { class: "out-html" });
      box.innerHTML = clean;
      wrap.append(box);
      return wrap;
    }
    case "image/svg+xml": {
      const svg = String(value);
      wrap.append(imageNode("data:image/svg+xml;base64," + utf8ToB64(svg), md[mime]));
      return wrap;
    }
    case "image/png":
    case "image/jpeg":
    case "image/gif":
    case "image/webp":
      wrap.append(imageNode(`data:${mime};base64,${String(value).replace(/\s+/g, "")}`, md[mime]));
      return wrap;
    case "text/markdown": {
      const box = el("div", { class: "out-md markdown" });
      box.innerHTML = renderMarkdown(String(value));
      wrap.append(box);
      return wrap;
    }
    case "text/latex": {
      const box = el("div", { class: "out-latex" });
      box.innerHTML = renderLatexOutput(String(value));
      wrap.append(box);
      return wrap;
    }
    case "application/json": {
      wrap.append(el("pre", { class: "out-plain out-json" }, JSON.stringify(value, null, 2)));
      return wrap;
    }
    case "application/javascript":
      wrap.append(el("div", { class: "out-note" }, "JavaScript output can't run here."));
      if (data["text/plain"] != null) wrap.append(textBlock(String(data["text/plain"]), "out-plain"));
      return wrap;
    case "text/plain":
    default: {
      const text = String(value ?? "");
      const lines = (text.match(/\n/g) || []).length;
      return collapsible(textBlock(text, "out-plain"), lines);
    }
  }
}

export function renderOutputs(container, outputs) {
  container.replaceChildren();
  for (const o of outputs) {
    const node = renderOutput(o);
    node.classList.add("output");
    container.append(node);
  }
}

// Clicks on links inside outputs and markdown open in the system browser.
export function wireLinks(root) {
  root.addEventListener("click", (e) => {
    const a = e.target.closest && e.target.closest("a[href]");
    if (!a) return;
    const href = a.getAttribute("href");
    if (!href) return;
    if (href.startsWith("#")) {
      e.preventDefault();
      const id = decodeURIComponent(href.slice(1));
      const target = root.querySelector(`[id="${CSS.escape(id)}"]`) || [...root.querySelectorAll("h1,h2,h3,h4,h5,h6")].find((h) => slug(h.textContent) === id.toLowerCase());
      if (target) target.scrollIntoView({ behavior: "smooth", block: "start" });
      return;
    }
    if (/^(https?:|mailto:)/i.test(href)) {
      e.preventDefault();
      bridge.openUrl(href);
    } else {
      e.preventDefault();
    }
  });
}

export function slug(s) {
  return String(s).trim().toLowerCase().replace(/[^\w\- ]+/g, "").replace(/\s+/g, "-");
}

export { escapeHtml, b64ToUtf8 };
