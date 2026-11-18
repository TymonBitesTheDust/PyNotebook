// Markdown + LaTeX rendering for text cells and text/markdown outputs.

import { marked } from "marked";
import DOMPurify from "dompurify";
import katex from "katex";
import { highlightCodeHtml } from "./editor.js";

marked.setOptions({ gfm: true, breaks: false });

const renderer = new marked.Renderer();
renderer.code = ({ text, lang }) => {
  const l = (lang || "").trim().split(/\s+/)[0].toLowerCase();
  const body = l === "python" || l === "py" || l === "ipython" || l === "ipython3" || l === ""
    ? highlightCodeHtml(text, l ? "python" : "plain")
    : escapeHtml(text);
  return `<pre class="md-code"><code>${body}</code></pre>`;
};
marked.use({ renderer });

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// Split text into code and non-code segments so math inside code is left alone.
function segments(src) {
  const out = [];
  const fence = /^( {0,3})(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:\n\1\2[`~]*[ \t]*(?=\n|$)|$)/gm;
  let last = 0;
  let m;
  while ((m = fence.exec(src))) {
    if (m.index > last) out.push({ code: false, text: src.slice(last, m.index) });
    out.push({ code: true, text: m[0] });
    last = m.index + m[0].length;
  }
  if (last < src.length) out.push({ code: false, text: src.slice(last) });
  // inline code spans
  const final = [];
  for (const seg of out) {
    if (seg.code) {
      final.push(seg);
      continue;
    }
    const re = /(`+)([\s\S]*?[^`])\1(?!`)/g;
    let l = 0;
    let mm;
    while ((mm = re.exec(seg.text))) {
      if (mm.index > l) final.push({ code: false, text: seg.text.slice(l, mm.index) });
      final.push({ code: true, text: mm[0] });
      l = mm.index + mm[0].length;
    }
    if (l < seg.text.length) final.push({ code: false, text: seg.text.slice(l) });
  }
  return final;
}

const MATH_RE = new RegExp(
  [
    String.raw`\$\$([\s\S]+?)\$\$`,
    String.raw`\\\[([\s\S]+?)\\\]`,
    String.raw`\\begin\{([a-zA-Z*]+)\}([\s\S]+?)\\end\{\3\}`,
    String.raw`\\\(([\s\S]+?)\\\)`,
    String.raw`(?<![\\$\w])\$(?![\s$])((?:\\\$|[^$\n])+?)(?<![\s\\])\$(?![\w$])`,
  ].join("|"),
  "g",
);

function protectMath(src, store) {
  return segments(src)
    .map((seg) => {
      if (seg.code) return seg.text;
      return seg.text.replace(MATH_RE, (whole, dd, br, envName, envBody, pr, inl) => {
        let tex;
        let display;
        if (dd !== undefined) { tex = dd; display = true; }
        else if (br !== undefined) { tex = br; display = true; }
        else if (envName !== undefined) { tex = whole; display = true; }
        else if (pr !== undefined) { tex = pr; display = false; }
        else { tex = inl; display = false; }
        store.push({ tex, display });
        return `⁣MATH${store.length - 1}⁣`;
      });
    })
    .join("");
}

export function renderTex(tex, display) {
  try {
    return katex.renderToString(tex, {
      displayMode: display,
      throwOnError: false,
      strict: "ignore",
      trust: false,
      output: "htmlAndMathml",
      macros: { "\\R": "\\mathbb{R}", "\\N": "\\mathbb{N}", "\\Z": "\\mathbb{Z}" },
    });
  } catch (e) {
    return `<code class="tex-error">${escapeHtml(tex)}</code>`;
  }
}

const PURIFY = {
  ADD_ATTR: ["target", "align"],
  FORBID_TAGS: ["script", "iframe", "object", "embed", "form", "base", "meta", "link", "input", "button", "textarea", "select"],
  FORBID_ATTR: ["srcdoc", "formaction"],
};

export function sanitize(html, extra) {
  return DOMPurify.sanitize(html, { ...PURIFY, ...(extra || {}) });
}

export function renderMarkdown(src, attachments) {
  const maths = [];
  let text = protectMath(src || "", maths);
  let html = marked.parse(text);
  if (attachments) {
    html = html.replace(/(src|href)="attachment:([^"]+)"/g, (whole, attr, name) => {
      const a = attachments[decodeURIComponent(name)] || attachments[name];
      if (!a) return whole;
      const mime = Object.keys(a)[0];
      const data = Array.isArray(a[mime]) ? a[mime].join("") : a[mime];
      return `${attr}="data:${mime};base64,${String(data).replace(/\s+/g, "")}"`;
    });
  }
  html = sanitize(html);
  html = html.replace(/⁣MATH(\d+)⁣/g, (_, i) => {
    const m = maths[+i];
    return m ? renderTex(m.tex, m.display) : "";
  });
  return html;
}

export function renderLatexOutput(src) {
  const s = String(src).trim();
  const maths = [];
  const protectedSrc = protectMath(s, maths);
  if (maths.length === 0) return renderTex(s, true);
  const html = sanitize(escapeHtml(protectedSrc).replace(/\n/g, "<br>"));
  return html.replace(/⁣MATH(\d+)⁣/g, (_, i) => renderTex(maths[+i].tex, maths[+i].display));
}

// Headings for the outline panel.
export function headingsOf(src) {
  const out = [];
  let inFence = false;
  for (const line of (src || "").split("\n")) {
    if (/^\s{0,3}(```|~~~)/.test(line)) inFence = !inFence;
    if (inFence) continue;
    const m = /^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (m) out.push({ level: m[1].length, text: m[2].replace(/[*_`]/g, "").replace(/\$[^$]*\$/g, (x) => x.slice(1, -1)) });
  }
  return out;
}
