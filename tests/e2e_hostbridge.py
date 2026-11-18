"""Exercises the Android host protocol (WebMessagePort RPC + events) with a fake host in the page.

The fake host implements the same methods MainActivity.java answers, so this checks the
web side of: pending launch intent, open/save to a writable document, back events,
openIntent events, theme calls and stdin replies routed through the host.
"""
import json
import os
import subprocess
import sys

from playwright.sync_api import sync_playwright

HERE = os.path.dirname(os.path.abspath(__file__))
PORT = 8767
srv = subprocess.Popen([sys.executable, os.path.join(HERE, "devserver.py"), str(PORT), "--no-coi"],
                       stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
srv.stdout.readline()

NB = {
    "cells": [
        {"cell_type": "markdown", "id": "m1", "metadata": {}, "source": ["# From a file manager\n", "Opened via *Open with*."]},
        {"cell_type": "code", "id": "c1", "metadata": {}, "source": ["x = input('n? ')\n", "print(int(x) * 2)"],
         "outputs": [], "execution_count": None},
    ],
    "metadata": {}, "nbformat": 4, "nbformat_minor": 4,
}

FAKE_HOST = """
(() => {
  const host = { calls: [], files: {}, events: [] };
  window.__host = host;
  const ch = new MessageChannel();
  const port = ch.port1;
  host.port = port;
  const reply = (id, result) => port.postMessage(JSON.stringify({ id, result }));
  const fail = (id, error) => port.postMessage(JSON.stringify({ id, error }));
  let pending = { uri: "content://fm/doc/42", name: "shared.ipynb", text: %s, writable: true, persistent: false };
  host.files["content://fm/doc/42"] = pending.text;
  port.onmessage = async (e) => {
    const { id, method, args } = JSON.parse(e.data);
    host.calls.push([method, args]);
    switch (method) {
      case "info": return reply(id, { platform: "android", sdk: 35, version: "1.0.0", dark: false });
      case "pendingIntent": { const p = pending; pending = null; return reply(id, p); }
      case "writeDocument": host.files[args[0]] = args[1]; return reply(id, true);
      case "readDocument": return host.files[args[0]] != null ? reply(id, { uri: args[0], name: "x.ipynb", text: host.files[args[0]], writable: true, persistent: true }) : fail(id, "gone");
      case "createDocument": host.files["content://new/1"] = args[2]; return reply(id, { uri: "content://new/1", name: args[0] });
      case "stdinReply":
        await fetch("/__stdin_reply", { method: "POST", body: JSON.stringify({ id: args[0], text: args[1] }) });
        return reply(id, true);
      case "exit": host.exited = true; return reply(id, true);
      default: return reply(id, true);
    }
  };
  host.event = (ev) => port.postMessage(JSON.stringify(ev));
  addEventListener("DOMContentLoaded", () => setTimeout(() => window.postMessage("pynotebook:port", "*", [ch.port2]), 50));
})();
""" % json.dumps(json.dumps(NB))

failures = []


def check(cond, label, extra=""):
    print(("ok   " if cond else "FAIL ") + label + ("" if cond else f"  -> {str(extra)[:500]}"), flush=True)
    if not cond:
        failures.append(label)


try:
    with sync_playwright() as p:
        b = p.chromium.launch()
        ctx = b.new_context(viewport={"width": 400, "height": 820}, is_mobile=True, has_touch=True,
                            user_agent="Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 Chrome/140 Mobile PyNotebookApp/1.0.0")
        ctx.add_init_script(FAKE_HOST)
        page = ctx.new_page()
        errs = []
        page.on("pageerror", lambda e: errs.append(str(e)))
        page.goto(f"http://127.0.0.1:{PORT}/app/index.html")
        page.wait_for_selector(".notebook-body", timeout=20000)
        check("shared.ipynb" in page.inner_text("header.appbar"), "launch intent opens the shared notebook")
        calls = page.evaluate("__host.calls.map(c => c[0])")
        check("info" in calls and "setTheme" in calls and "pendingIntent" in calls, "startup host calls", calls)
        page.wait_for_selector('.kernel-chip[data-state="idle"]', timeout=90000)
        page.locator(".cell").nth(1).click()
        page.click("nav.cellbar button[aria-label='Run cell']")
        page.wait_for_selector(".stdin-field", timeout=20000)
        page.fill(".stdin-field", "21")
        page.press(".stdin-field", "Enter")
        page.wait_for_function("() => !document.querySelector('.cell.running, .cell.queued')", timeout=30000)
        out = page.locator(".cell").nth(1).locator(".cell-outputs").inner_text()
        check("42" in out, "input() via host stdinReply", out)
        check(page.evaluate("__host.calls.some(c => c[0] === 'stdinReply')"), "stdin reply went through the host")
        # save to the same (writable) document
        page.click("header.appbar button[aria-label='More']")
        page.click(".sheet-item:has-text('Save'):not(:has-text('as'))")
        page.wait_for_timeout(300)
        saved = page.evaluate("__host.files['content://fm/doc/42']")
        nb = json.loads(saved)
        check(nb["nbformat_minor"] == 5 and nb["cells"][1]["execution_count"] == 1
              and any("42" in "".join(o.get("text", [])) for o in nb["cells"][1]["outputs"]), "save writes back to the opened file", saved[:300])
        # hardware back: leaves notebook (not dirty after save), second back on home exits
        page.evaluate("__host.event({event: 'back'})")
        page.wait_for_selector(".home-screen")
        check(True, "back event returns home")
        check(page.locator(".recent-name:has-text('shared.ipynb')").count() == 0, "non-persistent file not added to recent")
        page.evaluate("__host.event({event: 'back'})")
        page.wait_for_timeout(200)
        check(page.evaluate("!!__host.exited"), "back on home exits the app")
        # openIntent event while running
        page.evaluate("__host.event({event: 'openIntent', file: {uri: 'content://fm/doc/7', name: 'hello.py', text: 'print(\"hi from py\")', writable: false, persistent: true}})")
        page.wait_for_selector(".script-body")
        check("print" in page.inner_text(".script-editor"), "openIntent opens a .py file in the script editor")
        page.evaluate("__host.event({event: 'back'})")
        page.wait_for_selector(".home-screen")
        check(page.locator(".recent-name:has-text('hello.py')").count() == 1, "persistent file added to recent")
        # dark mode event
        page.evaluate("__host.event({event: 'uiMode', dark: true})")
        page.wait_for_timeout(100)
        check(page.evaluate("document.documentElement.dataset.theme") == "dark", "uiMode event switches theme")
        check(not errs, "no page errors", errs)
        b.close()
finally:
    srv.terminate()
print(f"\n{len(failures)} failure(s)")
sys.exit(1 if failures else 0)
