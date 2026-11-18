// Main-thread side of the Python kernel: owns the worker, serialises executions,
// routes output to the right cell, and handles input() and interrupts.

import { bridge } from "./bridge.js";
import { workerURL, workerType, embeddedRuntime } from "./assets.js";

const COI = typeof SharedArrayBuffer !== "undefined" && self.crossOriginIsolated === true;
// JS Promise Integration lets Python pause inside input() until the page replies.
const JSPI = typeof WebAssembly !== "undefined" && typeof WebAssembly.Suspending === "function";

// How input() gets its answer to the worker:
//   sab      shared memory (needs a cross-origin isolated page: Android app, Windows exe)
//   xhr      a blocking request the host answers (Android app without isolation, dev server)
//   promise  Python pauses via JSPI (single-file HTML in Edge/Chrome)
export function stdinMode() {
  if (COI) return "sab";
  if (bridge && bridge.stdinViaServer) return "xhr";
  return JSPI ? "promise" : "none";
}

export class Kernel {
  constructor({ onState } = {}) {
    this.state = "off"; // off | starting | idle | busy | dead
    this.onState = onState || (() => {});
    this.worker = null;
    this.ready = null;
    this.pending = new Map();
    this.seq = 1;
    this.queue = Promise.resolve();
    this.queued = 0;
    this.current = null; // handlers for the running execution
    this.last = null;
    this.info = null;
    this.statusText = "";
    this.pendingStdin = new Set();
    this.inputWaiting = false;
    this.gen = 0;
  }

  get canInterrupt() {
    return COI;
  }

  _setState(s, text) {
    this.state = s;
    if (text !== undefined) this.statusText = text;
    this.onState(s, this.statusText);
  }

  start() {
    if (this.ready) return this.ready;
    this._setState("starting", "Starting Python…");
    const gen = this.gen;
    this.interruptSab = COI ? new SharedArrayBuffer(1) : null;
    this.interruptView = COI ? new Int8Array(this.interruptSab) : null;
    this.inputSab = COI ? new SharedArrayBuffer(8 + 65536) : null;
    this.ready = (async () => {
      const [url, embedded] = await Promise.all([workerURL(), embeddedRuntime()]);
      if (gen !== this.gen) throw new Error("Python was restarted.");
      this.worker = new Worker(url, { type: workerType });
      this.worker.onmessage = (e) => this._onMessage(e.data);
      this.worker.onerror = (e) => {
        this._fatal(e.message || "The Python worker failed to start.");
      };
      return this._request({ cmd: "init", interruptSab: this.interruptSab, inputSab: this.inputSab, stdinMode: stdinMode(), embedded });
    })()
      .then(() => {
        this._setState("idle", "Ready");
        return this.info;
      })
      .catch((err) => {
        const msg = err.message || String(err);
        this._fatal(/restarted/i.test(msg) ? msg
          : `Python couldn't start (${msg}). ${bridge && bridge.isAndroid
            ? 'Updating "Android System WebView" from the Play Store usually fixes this.'
            : "Use an up-to-date Microsoft Edge or Google Chrome."}`);
        throw err;
      });
    this.ready.catch(() => {});
    return this.ready;
  }

  _fatal(message) {
    this._setState("dead", message);
    for (const p of this.pending.values()) p.reject(new Error(message));
    this.pending.clear();
  }

  _request(msg, transfer) {
    const id = this.seq++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ ...msg, id }, transfer || []);
    });
  }

  _onMessage(m) {
    switch (m.type) {
      case "status":
        this._setState(this.state, m.text);
        break;
      case "ready":
        this.info = m;
        this.stdinModeUsed = m.stdinMode;
        break;
      case "iopub": {
        let msg;
        try {
          msg = JSON.parse(m.msg);
        } catch {
          return;
        }
        const h = this.current || this.last;
        if (h && h.onOutput) h.onOutput(msg);
        break;
      }
      case "input_request": {
        const h = this.current || this.last;
        this.inputWaiting = true;
        if (m.mode === "xhr" || m.mode === "promise") this.pendingStdin.add(m.id);
        const answer = (text) => this._answerInput(m, text);
        if (h && h.onInput) h.onInput({ prompt: m.prompt, password: m.password }, answer);
        else answer(null);
        break;
      }
      case "reply": {
        const p = this.pending.get(m.id);
        if (!p) return;
        this.pending.delete(m.id);
        if (m.error !== undefined) p.reject(new Error(m.error));
        else p.resolve(m.result);
        break;
      }
      case "fatal":
        this._fatal(m.error);
        break;
    }
  }

  _answerInput(m, text) {
    this.inputWaiting = false;
    if (m.mode === "sab") {
      const ctl = new Int32Array(this.inputSab, 0, 2);
      if (text == null) {
        Atomics.store(ctl, 0, 2);
      } else {
        let bytes = new TextEncoder().encode(text);
        if (bytes.length > 65536) bytes = bytes.slice(0, 65536);
        new Uint8Array(this.inputSab, 8, bytes.length).set(bytes);
        Atomics.store(ctl, 1, bytes.length);
        Atomics.store(ctl, 0, 1);
      }
      Atomics.notify(ctl, 0);
    } else if (m.mode === "promise") {
      this.pendingStdin.delete(m.id);
      if (this.worker) this.worker.postMessage({ cmd: "stdin", id: m.id, text });
    } else {
      this.pendingStdin.delete(m.id);
      bridge.stdinReply(m.id, text);
    }
  }

  _cancelInputs() {
    for (const id of this.pendingStdin) {
      if (this.stdinModeUsed === "promise") this.worker && this.worker.postMessage({ cmd: "stdin", id, text: null });
      else bridge.stdinReply(id, null);
    }
    this.pendingStdin.clear();
    this.inputWaiting = false;
  }

  // Run code. handlers: {onOutput(msg), onInput(req, answer), onStart()}
  execute(code, handlers = {}, opts = {}) {
    this.queued++;
    const gen = this.gen;
    const run = async () => {
      if (gen !== this.gen) {
        const err = new Error("Cancelled");
        err.cancelled = true;
        throw err;
      }
      try {
        await this.start();
      } catch (e) {
        this.queued--;
        throw e;
      }
      if (this.state === "dead") {
        this.queued--;
        throw new Error("Python stopped. Restart it to continue.");
      }
      this.current = handlers;
      this.last = handlers;
      this._setState("busy", "Running");
      handlers.onStart && handlers.onStart();
      try {
        return await this._request({ cmd: "execute", code, silent: !!opts.silent, fresh: !!opts.fresh });
      } finally {
        this.queued--;
        this.current = null;
        if (this.state !== "dead") this._setState(this.queued > 0 ? "busy" : "idle", "Ready");
      }
    };
    const p = this.queue.then(run, run);
    this.queue = p.catch(() => {});
    return p;
  }

  // Ask the worker for completions; gives up quickly if Python is busy.
  async complete(code, pos) {
    if (this.state !== "idle") return null;
    const req = this._request({ cmd: "complete", code, pos });
    req.catch(() => {});
    const timeout = new Promise((r) => setTimeout(() => r(null), 600));
    try {
      return await Promise.race([req, timeout]);
    } catch {
      return null;
    }
  }

  // Mistakes in a piece of code, checked by Python itself. null when Python isn't
  // ready (the editor then uses its own quick check). context: other cells' code.
  async lint(code, context) {
    if (this.state !== "idle") return null;
    const req = this._request({ cmd: "lint", code, context: context || [] });
    req.catch(() => {});
    const timeout = new Promise((r) => setTimeout(() => r(null), 1500));
    try {
      return await Promise.race([req, timeout]);
    } catch {
      return null;
    }
  }

  async loadPackages(names, onOutput) {
    const handlers = { onOutput };
    await this.start();
    this.last = handlers;
    const prev = this.current;
    this.current = handlers;
    try {
      return await this._request({ cmd: "loadPackages", names });
    } finally {
      this.current = prev;
    }
  }

  async fs(op, path, data, root = null) {
    await this.start();
    if (this.state === "busy") throw new Error("Python is busy. Try again when the cell finishes.");
    return this._request({ cmd: "fs", op, path, data, root });
  }

  // Returns true if an interrupt was delivered, false if a restart is needed.
  interrupt() {
    if (this.state !== "busy" && !this.inputWaiting) return true;
    if (COI && this.interruptView) {
      this.interruptView[0] = 2;
      if (this.inputWaiting) {
        const ctl = new Int32Array(this.inputSab, 0, 2);
        Atomics.store(ctl, 0, 2);
        Atomics.notify(ctl, 0);
        this.inputWaiting = false;
      }
      return true;
    }
    if (this.inputWaiting && this.pendingStdin.size) {
      this._cancelInputs();
      return true;
    }
    return false;
  }

  // Mount a folder from this computer (a FileSystemDirectoryHandle) as Python's working folder.
  async mountFolder(handle) {
    await this.start();
    if (this.state === "busy") throw new Error("Python is busy. Try again when the cell finishes.");
    return this._request({ cmd: "mount", handle });
  }

  shutdown() {
    this.gen++;
    if (this.stdinModeUsed !== "promise") for (const id of this.pendingStdin) bridge.stdinReply(id, null);
    this.pendingStdin.clear();
    if (this.worker) this.worker.terminate();
    this.worker = null;
    for (const p of this.pending.values()) p.reject(new Error("Python was restarted."));
    this.pending.clear();
    this.ready = null;
    this.current = null;
    this.last = null;
    this.queue = Promise.resolve();
    this.queued = 0;
    this.inputWaiting = false;
    this._setState("off", "Not started");
  }

  restart() {
    this.shutdown();
    return this.start();
  }
}
