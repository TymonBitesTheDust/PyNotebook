// Small DOM helpers, icons, toasts, menus and dialogs.

export function el(tag, attrs, ...children) {
  const node = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === "class") node.className = v;
      else if (k === "html") node.innerHTML = v;
      else if (k === "text") node.textContent = v;
      else if (k.startsWith("on") && typeof v === "function") node.addEventListener(k.slice(2), v);
      else if (k === "style" && typeof v === "object") Object.assign(node.style, v);
      else node.setAttribute(k, v === true ? "" : v);
    }
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

const P = {
  back: "M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20v-2z",
  play: "M8 5v14l11-7z",
  playAll: "M4 18l8.5-6L4 6v12zm9-12v12l8.5-6L13 6z",
  stop: "M6 6h12v12H6z",
  more: "M12 8a2 2 0 1 0 0-4 2 2 0 0 0 0 4zm0 2a2 2 0 1 0 0 4 2 2 0 0 0 0-4zm0 6a2 2 0 1 0 0 4 2 2 0 0 0 0-4z",
  up: "M7.41 15.41L12 10.83l4.59 4.58L18 14l-6-6-6 6z",
  down: "M7.41 8.59L12 13.17l4.59-4.58L18 10l-6 6-6-6z",
  add: "M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z",
  del: "M6 19a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z",
  save: "M17 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V7l-4-4zm-5 16a3 3 0 1 1 0-6 3 3 0 0 1 0 6zm3-10H5V5h10v4z",
  folder: "M10 4H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-8l-2-2z",
  file: "M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6zm-1 7V3.5L18.5 9H13z",
  notebook: "M5 3h12a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5V3zm2 2v14h10V5H7zm2 2h6v2H9V7zm0 4h6v2H9v-2z",
  console: "M20 4H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2zm0 14H4V8h16v10zM6.5 10.5 9 13l-2.5 2.5 1.06 1.06L11.12 13 7.56 9.44 6.5 10.5zM12 15h5v1.5h-5z",
  code: "M9.4 16.6 4.8 12l4.6-4.6L8 6l-6 6 6 6 1.4-1.4zm5.2 0 4.6-4.6-4.6-4.6L16 6l6 6-6 6-1.4-1.4z",
  text: "M5 4v3h5.5v12h3V7H19V4z",
  edit: "M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04a1 1 0 0 0 0-1.41l-2.34-2.34a1 1 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z",
  check: "M9 16.17 4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z",
  close: "M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z",
  settings: "M19.14 12.94a7.5 7.5 0 0 0 .05-.94 7.5 7.5 0 0 0-.05-.94l2.03-1.58a.5.5 0 0 0 .12-.61l-1.92-3.32a.5.5 0 0 0-.59-.22l-2.39.96a7 7 0 0 0-1.62-.94l-.36-2.54a.5.5 0 0 0-.5-.42h-3.84a.5.5 0 0 0-.49.42l-.36 2.54a7.3 7.3 0 0 0-1.62.94l-2.39-.96a.5.5 0 0 0-.59.22L2.71 8.87a.5.5 0 0 0 .12.61l2.03 1.58a7.3 7.3 0 0 0 0 1.88l-2.03 1.58a.5.5 0 0 0-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.04.7 1.62.94l.36 2.54c.05.24.25.42.49.42h3.84c.25 0 .45-.18.49-.42l.36-2.54a7 7 0 0 0 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32a.5.5 0 0 0-.12-.61l-2.01-1.58zM12 15.6a3.6 3.6 0 1 1 0-7.2 3.6 3.6 0 0 1 0 7.2z",
  restart: "M17.65 6.35A7.96 7.96 0 0 0 12 4a8 8 0 1 0 7.73 10h-2.08A6 6 0 1 1 12 6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z",
  list: "M3 13h2v-2H3v2zm0 4h2v-2H3v2zm0-8h2V7H3v2zm4 4h14v-2H7v2zm0 4h14v-2H7v2zM7 7v2h14V7H7z",
  download: "M5 20h14v-2H5v2zM19 9h-4V3H9v6H5l7 7 7-7z",
  upload: "M5 20h14v-2H5v2zm4-4h6v-6h4l-7-7-7 7h4v6z",
  clear: "M5 13h14v-2H5v2z",
  copy: "M16 1H4a2 2 0 0 0-2 2v14h2V3h12V1zm3 4H8a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2zm0 16H8V7h11v14z",
  package: "M21 16.5c0 .38-.21.71-.53.88l-7.9 4.44a1 1 0 0 1-1.14 0l-7.9-4.44A1 1 0 0 1 3 16.5v-9c0-.38.21-.71.53-.88l7.9-4.44a1 1 0 0 1 1.14 0l7.9 4.44c.32.17.53.5.53.88v9zM12 4.15 6.04 7.5 12 10.85l5.96-3.35L12 4.15zM5 15.91l6 3.38v-6.71L5 9.21v6.7zm14 0v-6.7l-6 3.37v6.71l6-3.38z",
  history: "M13 3a9 9 0 0 0-9 9H1l3.89 3.89.07.14L9 12H6a7 7 0 1 1 2.05 4.95l-1.42 1.42A9 9 0 1 0 13 3zm-1 5v5l4.28 2.54.72-1.21-3.5-2.08V8H12z",
  wrap: "M4 19h6v-2H4v2zM20 5H4v2h16V5zm-3 6H4v2h13.25a1.75 1.75 0 0 1 0 3.5H15V14l-3 3 3 3v-2h2a4 4 0 0 0 0-8z",
  info: "M11 7h2v2h-2zm0 4h2v6h-2zm1-9a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm0 18a8 8 0 1 1 0-16 8 8 0 0 1 0 16z",
  undo: "M12.5 8c-2.65 0-5.05.99-6.9 2.6L2 7v9h9l-3.62-3.62A7.97 7.97 0 0 1 20.07 15.5l2.37-.78A10.5 10.5 0 0 0 12.5 8z",
  split: "M3 5h8v14H3V5zm10 0h8v14h-8V5zM5 7v10h4V7H5zm10 0v10h4V7h-4z",
  splitRows: "M5 3h14v8H5V3zm0 10h14v8H5v-8zm2-8v4h10V5H7zm0 10v4h10v-4H7z",
  maximize: "M5 5h6v2H7v4H5V5zm8 0h6v6h-2V7h-4V5zM5 13h2v4h4v2H5v-6zm12 0h2v6h-6v-2h4v-4z",
  minimize: "M9 9V5h2v6H5V9h4zm4-4h2v4h4v2h-6V5zM5 13h6v6H9v-4H5v-2zm8 0h6v2h-4v4h-2v-6z",
  swap: "M16 17.01V10h-2v7.01h-3L15 21l4-3.99h-3zM9 3 5 6.99h3V14h2V6.99h3L9 3z",
  person: "M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z",
  sparkle: "M12 2c.5 5.3 4.7 9.5 10 10-5.3.5-9.5 4.7-10 10-.5-5.3-4.7-9.5-10-10 5.3-.5 9.5-4.7 10-10z",
  globe: "M11.99 2C6.47 2 2 6.48 2 12s4.47 10 9.99 10C17.52 22 22 17.52 22 12S17.52 2 11.99 2zm6.93 6h-2.95a15.65 15.65 0 0 0-1.38-3.56A8.03 8.03 0 0 1 18.92 8zM12 4.04c.83 1.2 1.48 2.53 1.91 3.96h-3.82c.43-1.43 1.08-2.76 1.91-3.96zM4.26 14A8.2 8.2 0 0 1 4 12c0-.69.1-1.36.26-2h3.38c-.08.66-.14 1.32-.14 2s.06 1.34.14 2H4.26zm.82 2h2.95c.32 1.25.78 2.45 1.38 3.56A7.99 7.99 0 0 1 5.08 16zm2.95-8H5.08a7.99 7.99 0 0 1 4.33-3.56A15.65 15.65 0 0 0 8.03 8zM12 19.96c-.83-1.2-1.48-2.53-1.91-3.96h3.82c-.43 1.43-1.08 2.76-1.91 3.96zM14.34 14H9.66c-.09-.66-.16-1.32-.16-2s.07-1.35.16-2h4.68c.09.65.16 1.32.16 2s-.07 1.34-.16 2zm.25 5.56c.6-1.11 1.06-2.31 1.38-3.56h2.95a8.03 8.03 0 0 1-4.33 3.56zM16.36 14c.08-.66.14-1.32.14-2s-.06-1.34-.14-2h3.38c.16.64.26 1.31.26 2s-.1 1.36-.26 2h-3.38z",
  southernCross: southernCross(),
  palette: "M12 3a9 9 0 0 0 0 18c.83 0 1.5-.67 1.5-1.5 0-.39-.15-.74-.39-1.01-.23-.26-.38-.61-.38-.99 0-.83.67-1.5 1.5-1.5H16c2.76 0 5-2.24 5-5 0-4.42-4.03-8-9-8zm-5.5 9a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3zm3-4a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3zm5 0a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3zm3 4a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3z",
  search: "M15.5 14h-.79l-.28-.27a6.5 6.5 0 1 0-.7.7l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0a4.5 4.5 0 1 1 0-9 4.5 4.5 0 0 1 0 9z",
};

// The Southern Cross as on the Australian flag: four seven-pointed stars and a small
// five-pointed one.
function southernCross() {
  const star = (cx, cy, r, points) => {
    let d = "";
    for (let i = 0; i < points * 2; i++) {
      const a = (Math.PI * i) / points - Math.PI / 2;
      const rr = i % 2 ? r * 0.5 : r;
      d += (i ? "L" : "M") + (cx + rr * Math.cos(a)).toFixed(2) + " " + (cy + rr * Math.sin(a)).toFixed(2);
    }
    return d + "Z";
  };
  return star(12.2, 3.9, 3.6, 7) + star(11, 19.9, 3.9, 7) + star(4.4, 11.6, 3.4, 7) + star(19.4, 9.6, 3.1, 7) + star(15.2, 14.8, 2, 5);
}

export function icon(name, size = 22) {
  const span = document.createElement("span");
  span.className = "ic";
  span.innerHTML = `<svg viewBox="0 0 24 24" width="${size}" height="${size}" aria-hidden="true"><path d="${P[name] || ""}"/></svg>`;
  return span;
}

export function iconButton(name, label, onclick, extra = {}) {
  const b = el("button", { class: "icon-btn " + (extra.class || ""), "aria-label": label, title: label, onclick, type: "button" });
  b.append(icon(name, extra.size || 22));
  if (extra.text) b.append(el("span", { class: "icon-btn-text" }, extra.text));
  return b;
}

// ---------------------------------------------------------------- toasts

let toastTimer = null;
export function toast(message, { action, onAction, duration = 3200 } = {}) {
  let host = document.getElementById("toast");
  if (!host) {
    host = el("div", { id: "toast", role: "status", "aria-live": "polite" });
    document.body.append(host);
  }
  host.replaceChildren(el("span", { class: "toast-msg" }, message));
  if (action) {
    host.append(el("button", { class: "toast-action", type: "button", onclick: () => { hide(); onAction && onAction(); } }, action));
  }
  host.classList.add("show");
  clearTimeout(toastTimer);
  const hide = () => host.classList.remove("show");
  toastTimer = setTimeout(hide, duration);
}

// ---------------------------------------------------------------- layered UI (menus, sheets, dialogs)

const layers = [];

export function closeTopLayer() {
  const top = layers.pop();
  if (top) {
    top.close(true);
    return true;
  }
  return false;
}

export function hasLayer() {
  return layers.length > 0;
}

function pushLayer(node, onClose) {
  const entry = {
    node,
    close(fromStack) {
      if (!fromStack) {
        const i = layers.indexOf(entry);
        if (i >= 0) layers.splice(i, 1);
      }
      node.classList.remove("open");
      setTimeout(() => node.remove(), 160);
      onClose && onClose();
    },
  };
  layers.push(entry);
  document.body.append(node);
  requestAnimationFrame(() => node.classList.add("open"));
  return entry;
}

// A bottom sheet with a list of actions. items: [{icon, label, hint, onClick, danger, disabled}] or "-" separators
export function actionSheet(title, items) {
  const sheet = el("div", { class: "sheet-wrap" });
  const panel = el("div", { class: "sheet", role: "menu" });
  if (title) panel.append(el("div", { class: "sheet-title" }, title));
  let entry;
  for (const it of items) {
    if (!it) continue;
    if (it === "-") {
      panel.append(el("div", { class: "sheet-sep" }));
      continue;
    }
    const b = el("button", {
      class: "sheet-item" + (it.danger ? " danger" : ""),
      type: "button",
      role: "menuitem",
      disabled: it.disabled,
      onclick: () => {
        entry.close();
        setTimeout(() => it.onClick && it.onClick(), 10);
      },
    });
    if (it.icon) b.append(icon(it.icon, 20));
    b.append(el("span", { class: "sheet-label" }, it.label));
    if (it.hint) b.append(el("span", { class: "sheet-hint" }, it.hint));
    panel.append(b);
  }
  sheet.append(el("div", { class: "scrim", onclick: () => entry.close() }), panel);
  entry = pushLayer(sheet);
  return entry;
}

// A modal dialog. Returns a promise of the chosen button value.
export function dialog({ title, body, buttons = [{ label: "OK", value: true, primary: true }], input, dismissValue = null }) {
  return new Promise((resolve) => {
    const wrap = el("div", { class: "dialog-wrap" });
    const box = el("div", { class: "dialog", role: "dialog", "aria-modal": "true" });
    let field = null;
    if (title) box.append(el("h2", { class: "dialog-title" }, title));
    if (body) box.append(typeof body === "string" ? el("p", { class: "dialog-body" }, body) : body);
    if (input) {
      field = el("input", {
        class: "dialog-input",
        type: input.type || "text",
        value: input.value || "",
        placeholder: input.placeholder || "",
        autocapitalize: "off",
        autocomplete: "off",
        spellcheck: "false",
      });
      field.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          finish(buttons.find((b) => b.primary)?.value ?? true);
        }
      });
      box.append(field);
    }
    const row = el("div", { class: "dialog-buttons" });
    let done = false;
    let entry;
    const finish = (value) => {
      if (done) return;
      done = true;
      entry.close();
      if (input) resolve(value === dismissValue || value === false ? null : field.value);
      else resolve(value);
    };
    for (const b of buttons) {
      row.append(el("button", {
        class: "btn " + (b.primary ? "primary" : "") + (b.danger ? " danger" : ""),
        type: "button",
        onclick: () => finish(b.value),
      }, b.label));
    }
    box.append(row);
    wrap.append(el("div", { class: "scrim", onclick: () => finish(dismissValue) }), box);
    entry = pushLayer(wrap, () => {
      if (!done) {
        done = true;
        resolve(input ? null : dismissValue);
      }
    });
    if (field) setTimeout(() => { field.focus(); field.select(); }, 60);
  });
}

export function confirmDialog(title, body, okLabel = "OK", danger = false) {
  return dialog({
    title,
    body,
    buttons: [
      { label: "Cancel", value: false },
      { label: okLabel, value: true, primary: true, danger },
    ],
    dismissValue: false,
  });
}

export function promptDialog(title, value = "", okLabel = "OK", placeholder = "") {
  return dialog({
    title,
    input: { value, placeholder },
    buttons: [
      { label: "Cancel", value: false },
      { label: okLabel, value: true, primary: true },
    ],
    dismissValue: false,
  });
}

// Full-screen panel (used for files, packages, outline, settings).
export function panel(title, content, { onClose, actions = [] } = {}) {
  const wrap = el("div", { class: "panel-wrap" });
  let entry;
  const head = el("header", { class: "appbar" },
    iconButton("back", "Close", () => entry.close()),
    el("h1", { class: "appbar-title" }, title),
    ...actions,
  );
  const body = el("div", { class: "panel-body" }, content);
  wrap.append(el("div", { class: "panel" }, head, body));
  entry = pushLayer(wrap, onClose);
  return entry;
}

export function formatBytes(n) {
  if (n < 1024) return n + " B";
  if (n < 1024 * 1024) return (n / 1024).toFixed(n < 10240 ? 1 : 0) + " KB";
  return (n / 1024 / 1024).toFixed(1) + " MB";
}

export function timeAgo(t) {
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return Math.floor(s / 60) + " min ago";
  if (s < 86400) return Math.floor(s / 3600) + " h ago";
  if (s < 86400 * 7) return Math.floor(s / 86400) + " d ago";
  return new Date(t).toLocaleDateString();
}

export function debounce(fn, ms) {
  let t = null;
  return (...a) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...a), ms);
  };
}
