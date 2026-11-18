// Persistent app settings and small localStorage helpers.

const KEY = "pynotebook.settings";

const defaults = {
  theme: "system", // system | light | dark
  codeSize: 13,
  wrap: true,
  lineNumbers: false,
  autoStart: true,
  splitDirection: "auto", // auto | rows | cols
  accent: "teal", // theme colour, see themes.js
};

function load() {
  try {
    return { ...defaults, ...JSON.parse(localStorage.getItem(KEY) || "{}") };
  } catch {
    return { ...defaults };
  }
}

export const settings = load();

const listeners = [];
export function onSettings(fn) {
  listeners.push(fn);
  return () => {
    const i = listeners.indexOf(fn);
    if (i >= 0) listeners.splice(i, 1);
  };
}

export function saveSettings(patch) {
  Object.assign(settings, patch);
  try {
    localStorage.setItem(KEY, JSON.stringify(settings));
  } catch {}
  for (const fn of listeners) fn(settings);
}

export function store(key, value) {
  try {
    if (value === undefined) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

export function recall(key, fallback = null) {
  try {
    const v = localStorage.getItem(key);
    return v == null ? fallback : JSON.parse(v);
  } catch {
    return fallback;
  }
}

// Recent files: [{uri, name, kind, time}]
const RECENT = "pynotebook.recent";

export function recentFiles() {
  return recall(RECENT, []);
}

export function addRecent(entry) {
  const list = recentFiles().filter((r) => r.uri !== entry.uri);
  list.unshift({ ...entry, time: Date.now() });
  store(RECENT, list.slice(0, 30));
}

export function removeRecent(uri) {
  store(RECENT, recentFiles().filter((r) => r.uri !== uri));
}

export function renameRecent(uri, patch) {
  store(RECENT, recentFiles().map((r) => (r.uri === uri ? { ...r, ...patch } : r)));
}
