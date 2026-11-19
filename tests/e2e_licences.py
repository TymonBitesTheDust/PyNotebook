"""Open-source licences (Settings > About) in the served build and the single-file HTML,
the notices file in the repository, and a hostile notebook that must not run scripts."""
import json
import os
import subprocess
import sys

from playwright.sync_api import sync_playwright

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
PORT = 8775
srv = subprocess.Popen([sys.executable, os.path.join(HERE, "devserver.py"), str(PORT)], stdout=subprocess.PIPE)
srv.stdout.readline()
failures = []


def check(cond, label, extra=""):
    print(("ok   " if cond else "FAIL ") + label + ("" if cond else f"  -> {str(extra)[:400]}"), flush=True)
    if not cond:
        failures.append(label)


notices = json.load(open(os.path.join(ROOT, "web", "dist", "licenses.json")))
names = [p["name"] for g in notices["groups"] for p in g["packages"]]
text = open(os.path.join(ROOT, "THIRD_PARTY_NOTICES.txt"), encoding="utf-8").read()
check(notices["app"]["license"] == "MIT" and "Tymon Ng" in notices["app"]["text"], "PyNotebook's own licence is MIT, Tymon Ng")
for must in ["Pyodide", "Python (CPython)", "dompurify", "katex", "marked", "ansi_up", "@codemirror/view", "@lezer/python", "@fontsource/jetbrains-mono", "Go runtime and standard library"]:
    check(must in names, f"notices include {must}", names)
check(all(n in text for n in names), "THIRD_PARTY_NOTICES.txt lists every component", [n for n in names if n not in text])
check(all(g["text"].strip() for g in notices["groups"]), "every component has its licence text")
dp = next(p for g in notices["groups"] for p in g["packages"] if p["name"] == "dompurify")
check(dp["version"] == "3.4.18", "DOMPurify is 3.4.18", dp)

HOSTILE = {
    "nbformat": 4, "nbformat_minor": 5, "metadata": {},
    "cells": [
        {"cell_type": "markdown", "metadata": {}, "source": "# Hi <img src=x onerror=\"window.__pwned='md'\"> <a href=\"javascript:window.__pwned='link'\">link</a>"},
        {"cell_type": "code", "metadata": {}, "execution_count": 1, "source": "x", "outputs": [{
            "output_type": "display_data", "metadata": {},
            "data": {"text/html": "<b class='safe'>ok</b><img src=x onerror=\"window.__pwned='html'\"><script>window.__pwned='script'</script>"
                     "<svg><animate onbegin=\"window.__pwned='svg'\" attributeName=x dur=1s></svg><iframe srcdoc=\"<script>parent.__pwned='iframe'</script>\"></iframe>"
                     "<form action=https://example.com><input name=q></form>",
                     "text/plain": "ok"}}]},
        {"cell_type": "code", "metadata": {}, "execution_count": 2, "source": "y", "outputs": [{
            "output_type": "display_data", "metadata": {},
            "data": {"application/javascript": "window.__pwned='js'", "text/plain": "js"}}]},
    ],
}


def licences_panel(page, label):
    page.click("button[aria-label='Settings']")
    page.wait_for_selector(".about-card")
    row = page.locator(".about-row:has-text('Licence')")
    check(row.count() == 1 and "MIT" in row.inner_text(), f"{label}: About shows the MIT licence row", row.inner_text() if row.count() else "")
    check("Free software under the MIT licence" in page.inner_text(".about-copy"), f"{label}: copyright line mentions MIT")
    row.locator("button").click()
    page.wait_for_selector(".lic-item")
    items = page.locator(".lic-item summary").all_inner_texts()
    check(len(items) == len(notices["groups"]) + 1, f"{label}: panel lists every group", len(items))
    check(items[0].startswith("PyNotebook") and "MIT" in items[0], f"{label}: PyNotebook comes first", items[0])
    pyo = page.locator(".lic-item:has(.lic-title:text-is('Pyodide'))")
    check("MPL-2.0" in pyo.inner_text() and "314.0.7" in pyo.inner_text(), f"{label}: Pyodide shows MPL-2.0 and its version", pyo.inner_text())
    pyo.locator("summary").click()
    body = pyo.inner_text()
    check("Mozilla Public License Version 2.0" in body and "github.com/pyodide/pyodide" in body, f"{label}: Pyodide's licence text and source link show", body[:200])
    go = page.locator(".lic-item:has(.lic-title:text-is('Go runtime and standard library'))")
    go.locator("summary").click()
    check("Windows app only" in go.inner_text(), f"{label}: Go is marked Windows app only")
    cm = page.locator(".lic-item:has(.lic-title:text-matches('^@codemirror'))")
    check(cm.count() == 1 and "packages" in cm.locator(".lic-title").inner_text(), f"{label}: CodeMirror's packages are grouped", cm.locator(".lic-title").all_inner_texts())
    for _ in range(2):  # the licences panel, then Settings
        page.locator(".panel header button[aria-label='Close']").last.click()
        page.wait_for_timeout(400)


def hostile(page, label):
    page.evaluate("t => __app.openText({ uri: null, name: 'hostile.ipynb', text: t, writable: false, persistent: false })", json.dumps(HOSTILE))
    page.wait_for_selector(".out-html .safe")
    page.wait_for_timeout(1500)
    check(page.evaluate("window.__pwned") is None, f"{label}: a hostile notebook runs no scripts", page.evaluate("window.__pwned"))
    check(page.locator(".out-html script, .out-html iframe, .out-html form, .out-html [onerror], .markdown [onerror]").count() == 0, f"{label}: scripts, frames, forms and handlers are removed")
    href = page.get_attribute(".markdown a:has-text('link')", "href")
    check(not href or not href.lower().startswith("javascript"), f"{label}: javascript: links are removed", href)
    check("can't run here" in page.inner_text(".cell >> nth=2"), f"{label}: JavaScript output is shown as not run")


try:
    with sync_playwright() as p:
        b = p.chromium.launch()
        for label, url in [("served", f"http://127.0.0.1:{PORT}/app/index.html"),
                           ("single file", "file://" + os.path.join(ROOT, "web", "dist-single", "PyNotebook.html"))]:
            ctx = b.new_context(viewport={"width": 412, "height": 860})
            ctx.add_init_script("localStorage.setItem('pynotebook.settings', JSON.stringify({autoStart: false}))")
            page = ctx.new_page()
            errs = []
            page.on("pageerror", lambda e: errs.append(str(e)))
            page.goto(url)
            page.wait_for_selector(".home-screen", timeout=30000)
            licences_panel(page, label)
            hostile(page, label)
            check(not errs, f"{label}: no page errors", errs)
            ctx.close()
        b.close()
finally:
    srv.terminate()
print(f"\n{len(failures)} failure(s)")
sys.exit(1 if failures else 0)
