// Reading and writing Jupyter notebooks (nbformat 4, with v3 upgrade).

let idCounter = 0;
export function newId() {
  idCounter++;
  const r = Math.random().toString(16).slice(2, 10);
  return (r + idCounter.toString(16)).slice(0, 8);
}

const join = (v) => (Array.isArray(v) ? v.join("") : v == null ? "" : String(v));

function normData(data) {
  const out = {};
  for (const [k, v] of Object.entries(data || {})) {
    if (k === "application/json" || (k.endsWith("+json") && typeof v !== "string")) out[k] = v;
    else out[k] = join(v);
  }
  return out;
}

function normOutput(o) {
  const t = o.output_type;
  if (t === "stream") return { output_type: "stream", name: o.name || "stdout", text: join(o.text) };
  if (t === "error") return { output_type: "error", ename: o.ename || "", evalue: o.evalue || "", traceback: o.traceback || [] };
  if (t === "execute_result" || t === "display_data") {
    const r = { output_type: t, data: normData(o.data), metadata: o.metadata || {} };
    if (t === "execute_result") r.execution_count = o.execution_count ?? null;
    return r;
  }
  return { ...o };
}

function upgradeV3(nb) {
  const cells = [];
  for (const ws of nb.worksheets || []) {
    for (const c of ws.cells || []) {
      if (c.cell_type === "code") {
        cells.push({
          cell_type: "code",
          source: join(c.input),
          execution_count: c.prompt_number ?? null,
          metadata: c.metadata || {},
          outputs: (c.outputs || []).map((o) => {
            if (o.output_type === "stream") return { output_type: "stream", name: o.stream || "stdout", text: join(o.text) };
            if (o.output_type === "pyerr") return { output_type: "error", ename: o.ename, evalue: o.evalue, traceback: o.traceback || [] };
            const map = { png: "image/png", jpeg: "image/jpeg", svg: "image/svg+xml", html: "text/html", latex: "text/latex", text: "text/plain", javascript: "application/javascript", json: "application/json" };
            const data = {};
            for (const [k, mime] of Object.entries(map)) if (o[k] != null) data[mime] = join(o[k]);
            const type = o.output_type === "pyout" ? "execute_result" : "display_data";
            const out = { output_type: type, data, metadata: o.metadata || {} };
            if (type === "execute_result") out.execution_count = o.prompt_number ?? null;
            return out;
          }),
        });
      } else if (c.cell_type === "heading") {
        cells.push({ cell_type: "markdown", source: "#".repeat(c.level || 1) + " " + join(c.source), metadata: c.metadata || {} });
      } else {
        cells.push({ cell_type: c.cell_type === "markdown" ? "markdown" : "raw", source: join(c.source), metadata: c.metadata || {} });
      }
    }
  }
  return { nbformat: 4, nbformat_minor: 5, metadata: nb.metadata || {}, cells };
}

export function parseNotebook(text) {
  let nb;
  try {
    nb = JSON.parse(text);
  } catch (e) {
    throw new Error("This file isn't a valid notebook (the JSON couldn't be read).");
  }
  if (!nb || typeof nb !== "object") throw new Error("This file isn't a notebook.");
  if (nb.nbformat === 3 || nb.worksheets) nb = upgradeV3(nb);
  if (!Array.isArray(nb.cells)) throw new Error("This file isn't a notebook (it has no cells).");
  const seen = new Set();
  const cells = nb.cells.map((c) => {
    let id = c.id && !seen.has(c.id) ? c.id : newId();
    seen.add(id);
    const type = c.cell_type === "code" ? "code" : c.cell_type === "markdown" ? "markdown" : "raw";
    const cell = {
      id,
      type,
      source: join(c.source),
      metadata: c.metadata || {},
      outputs: type === "code" ? (c.outputs || []).map(normOutput) : [],
      execution_count: type === "code" ? c.execution_count ?? null : null,
      attachments: c.attachments || null,
    };
    return cell;
  });
  return {
    metadata: nb.metadata || {},
    nbformat: 4,
    nbformat_minor: Math.max(5, nb.nbformat_minor || 0),
    cells,
  };
}

export function newNotebook(pythonVersion) {
  return {
    metadata: {
      kernelspec: { name: "python3", display_name: "Python 3 (ipykernel)", language: "python" },
      language_info: { name: "python", version: pythonVersion || "3", file_extension: ".py", mimetype: "text/x-python" },
    },
    nbformat: 4,
    nbformat_minor: 5,
    cells: [newCell("code")],
  };
}

export function newCell(type, source = "") {
  return { id: newId(), type, source, metadata: {}, outputs: [], execution_count: null, attachments: null };
}

// Split text into lines that keep their "\n", the way Jupyter stores multiline strings.
function lines(s) {
  if (!s) return [];
  const out = s.split(/(?<=\n)/);
  return out;
}

function serialOutput(o) {
  if (o.output_type === "stream") return { output_type: "stream", name: o.name, text: lines(o.text) };
  if (o.output_type === "error") return { output_type: "error", ename: o.ename, evalue: o.evalue, traceback: o.traceback };
  const data = {};
  for (const [k, v] of Object.entries(o.data || {})) {
    if (typeof v !== "string") data[k] = v;
    else if (k.startsWith("image/") && k !== "image/svg+xml") data[k] = v;
    else data[k] = lines(v);
  }
  const r = { output_type: o.output_type, data, metadata: o.metadata || {} };
  if (o.output_type === "execute_result") r.execution_count = o.execution_count ?? null;
  return r;
}

export function serializeNotebook(model) {
  const cells = model.cells.map((c) => {
    const base = { cell_type: c.type, id: c.id, metadata: c.metadata || {}, source: lines(c.source) };
    if (c.type === "code") {
      base.execution_count = c.execution_count ?? null;
      base.outputs = (c.outputs || []).map(serialOutput);
    }
    if (c.attachments && c.type !== "code") base.attachments = c.attachments;
    return base;
  });
  const nb = { cells, metadata: model.metadata || {}, nbformat: 4, nbformat_minor: model.nbformat_minor || 5 };
  return stableStringify(nb, 1) + "\n";
}

// JSON.stringify with sorted object keys (Jupyter's on-disk format).
function stableStringify(value, indent) {
  const pad = (n) => " ".repeat(n * indent);
  const walk = (v, depth) => {
    if (v === null || typeof v !== "object") return JSON.stringify(v === undefined ? null : v);
    if (Array.isArray(v)) {
      if (v.length === 0) return "[]";
      return "[\n" + v.map((x) => pad(depth + 1) + walk(x, depth + 1)).join(",\n") + "\n" + pad(depth) + "]";
    }
    const keys = Object.keys(v).filter((k) => v[k] !== undefined).sort();
    if (keys.length === 0) return "{}";
    return "{\n" + keys.map((k) => pad(depth + 1) + JSON.stringify(k) + ": " + walk(v[k], depth + 1)).join(",\n") + "\n" + pad(depth) + "}";
  };
  return walk(value, 0);
}

// Export code cells as a Python script.
export function notebookToPython(model) {
  const parts = [];
  for (const c of model.cells) {
    if (c.type === "code") parts.push("# %%\n" + c.source.replace(/^(\s*)([%!])/gm, "$1# $2"));
    else if (c.type === "markdown") parts.push("# %% [markdown]\n" + c.source.split("\n").map((l) => "# " + l).join("\n"));
  }
  return parts.join("\n\n") + "\n";
}

// Turn a .py file using "# %%" markers into notebook cells (percent format).
export function pythonToCells(src) {
  if (!/^# %%/m.test(src)) return [newCell("code", src.replace(/\n+$/, ""))];
  const cells = [];
  const chunks = src.split(/^# %%/m);
  if (chunks[0].trim()) cells.push(newCell("code", chunks[0].replace(/\n+$/, "")));
  for (const ch of chunks.slice(1)) {
    const nl = ch.indexOf("\n");
    const header = nl < 0 ? ch : ch.slice(0, nl);
    const body = (nl < 0 ? "" : ch.slice(nl + 1)).replace(/\n+$/, "");
    if (/\[markdown\]/.test(header)) cells.push(newCell("markdown", body.split("\n").map((l) => l.replace(/^# ?/, "")).join("\n")));
    else cells.push(newCell("code", body));
  }
  return cells;
}
