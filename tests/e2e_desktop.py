"""Desktop (Windows exe) behaviour, run against the exe's server built for Linux.

Covers: files passed on the command line (as when double-clicking in File Explorer),
saving them back to disk, a second launch opening another window, the browser file
pickers (stubbed with the origin-private file system), keyboard shortcuts, using a
real folder as Python's working folder, drag and drop, side-by-side panes, the
unsaved-changes prompt, and the exe exiting after its last window closes.
"""
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time

from playwright.sync_api import sync_playwright

HERE = os.path.dirname(os.path.abspath(__file__))
EXE = os.path.join(HERE, "..", "build-win", "pynotebook-linux")
SHOTS = os.path.join(HERE, "shots-desktop")
os.makedirs(SHOTS, exist_ok=True)
failures = []


def check(cond, label, extra=""):
    print(("ok   " if cond else "FAIL ") + label + ("" if cond else f"  -> {str(extra)[:500]}"), flush=True)
    if not cond:
        failures.append(label)


work = tempfile.mkdtemp(prefix="pnb-desktop-")
data = os.path.join(work, "data")
nb_path = os.path.join(work, "My analysis.ipynb")
py_path = os.path.join(work, "helper.py")
json.dump({"cells": [
    {"cell_type": "markdown", "id": "m1", "metadata": {}, "source": ["# Opened from File Explorer"]},
    {"cell_type": "code", "id": "c1", "metadata": {}, "source": ["total = sum(range(10))\n", "total"], "outputs": [], "execution_count": None},
], "metadata": {}, "nbformat": 4, "nbformat_minor": 5}, open(nb_path, "w"))
open(py_path, "w").write("print('helper ready')\n")

out_path = os.path.join(work, "server.out")
out = open(out_path, "w")
server = subprocess.Popen([EXE, "--no-browser", "--data-dir", data, nb_path], stdout=out, stderr=subprocess.STDOUT)


def urls():
    for _ in range(50):
        lines = [l.strip() for l in open(out_path) if l.startswith("http")]
        if lines:
            return lines
        time.sleep(0.1)
    return []


def idle(page, timeout=90000):
    page.wait_for_function("() => !document.querySelector('.cell.running, .cell.queued')", timeout=timeout)


OPFS_PICKERS = """
(() => {
  const opfs = () => navigator.storage.getDirectory();
  window.__pickNext = null;
  window.showOpenFilePicker = async () => {
    const root = await opfs();
    return [await root.getFileHandle(window.__pickNext || 'picked.ipynb')];
  };
  window.showSaveFilePicker = async (opts) => {
    const root = await opfs();
    return await root.getFileHandle('saved-' + (opts && opts.suggestedName || 'file'), { create: true });
  };
  window.showDirectoryPicker = async () => {
    const root = await opfs();
    return await root.getDirectoryHandle('project', { create: true });
  };
  window.__opfsWrite = async (name, text) => {
    const root = await opfs();
    const h = await root.getFileHandle(name, { create: true });
    const w = await h.createWritable(); await w.write(text); await w.close();
  };
  window.__opfsRead = async (name, dir) => {
    let root = await opfs();
    if (dir) root = await root.getDirectoryHandle(dir);
    return await (await (await root.getFileHandle(name)).getFile()).text();
  };
})();
"""

try:
    first = urls()
    check(len(first) == 1 and "open=" in first[0], "exe prints a window address with the file to open", first)
    with sync_playwright() as p:
        b = p.chromium.launch()
        ctx = b.new_context(viewport={"width": 1280, "height": 860})
        ctx.add_init_script(OPFS_PICKERS)
        page = ctx.new_page()
        errs = []
        page.on("pageerror", lambda e: errs.append(str(e)))
        page.goto(first[0])
        page.wait_for_selector(".notebook-body .cell")
        check("My analysis.ipynb" in page.inner_text(".pane-head"), "file from the command line opens")
        check(page.title().startswith("My analysis.ipynb"), "window title shows the file", page.title())
        page.wait_for_selector('.kernel-chip[data-state="idle"]', timeout=90000)
        check(page.locator(".keybar").is_hidden(), "touch symbol bar hidden with a mouse")

        # ---- keyboard shortcuts (command mode)
        page.locator(".cell").nth(1).click()
        page.keyboard.press("Shift+Enter")
        idle(page)
        check("45" in page.locator(".cell").nth(1).inner_text(), "Shift+Enter runs the selected cell")
        n = page.locator(".cell").count()
        page.keyboard.press("Escape")
        page.locator(".cell").nth(1).click()
        page.keyboard.press("b")
        page.wait_for_selector(".cell.editing .cm-content")
        page.keyboard.type("half = total / 2\nhalf")
        page.keyboard.press("Escape")  # closes the completion popup
        if page.locator(".cell.editing").count():
            page.keyboard.press("Escape")  # leaves the cell
        check(page.locator(".cell.editing").count() == 0 and page.locator(".cell").count() == n + 1, "B adds a cell below; Esc stops editing")
        page.keyboard.press("Control+Enter")
        idle(page)
        check("22.5" in page.locator(".cell").nth(2).inner_text(), "Ctrl+Enter runs the cell")
        page.keyboard.press("ArrowUp")
        page.keyboard.press("ArrowUp")
        page.keyboard.press("m")
        check("markdown" in page.locator(".cell").nth(0).get_attribute("class"), "arrows select; M keeps markdown")
        page.keyboard.press("ArrowDown")
        page.keyboard.press("ArrowDown")
        page.keyboard.press("y")
        page.keyboard.press("d")
        page.keyboard.press("d")
        page.wait_for_timeout(200)
        check(page.locator(".cell").count() == n, "D D deletes the cell", page.locator(".cell").count())

        # ---- save back to the file on disk
        page.keyboard.press("Control+s")
        page.wait_for_function("() => document.querySelector('#toast.show') && /Saved/.test(document.querySelector('#toast').innerText)")
        saved = json.load(open(nb_path))
        check(len(saved["cells"]) == 3 and saved["cells"][1]["execution_count"] == 1
              and saved["cells"][1]["outputs"][0]["data"]["text/plain"] == ["45"], "Ctrl+S saves to the original file", saved["cells"][1])

        # ---- a second launch opens another window with its file
        r = subprocess.run([EXE, "--data-dir", data, py_path], timeout=20)
        check(r.returncode == 0, "second launch hands over and exits", r.returncode)
        time.sleep(0.5)
        second = urls()
        check(len(second) == 2 and second[1] != second[0], "running instance opens a second window", second)
        page2 = ctx.new_page()
        page2.goto(second[1])
        page2.wait_for_selector(".script-body .cm-content")
        check("helper ready" in page2.inner_text(".script-body"), "second window shows helper.py")
        page2.locator(".script-body .cm-content").click()
        page2.keyboard.press("Control+End")
        page2.keyboard.type("print('edited in window 2')")
        page2.keyboard.press("Control+s")
        page2.wait_for_timeout(500)
        check("edited in window 2" in open(py_path).read(), "script saved to disk from the second window")
        page2.close()

        # ---- side by side on a wide window, and recent list reopen
        page.locator(".pane-head button[aria-label='Split screen']").first.click()
        page.click(".sheet-item:has-text('Same file, another view')")
        page.wait_for_timeout(200)
        check(page.locator(".ws-area.cols > .pane").count() == 2, "wide window places panes side by side",
              (page.evaluate("document.querySelector('.ws-area').className"), page.locator(".ws-area > .pane").count(), page.evaluate("localStorage.getItem('pynotebook.settings')")))
        page.screenshot(path=os.path.join(SHOTS, "40-desktop-split.png"))
        page.locator(".ws-area > .pane").nth(1).locator(".close-btn").click()

        # ---- file pickers (Edge/Chrome file system access), stubbed with OPFS
        page.evaluate("""__opfsWrite('picked.ipynb', JSON.stringify({cells: [{cell_type: 'code', id: 'p1', metadata: {}, source: ['print(\"picked\")'], outputs: [], execution_count: null}], metadata: {}, nbformat: 4, nbformat_minor: 5}))""")
        page.locator(".pane-head button[aria-label='Split screen']").first.click()
        page.click(".sheet-item:has-text('Open another file')")
        page.wait_for_selector(".pane-head:has-text('picked.ipynb')")
        pk = page.locator(".ws-area > .pane:has(.pane-head:has-text('picked.ipynb'))")
        pk.locator(".cell").first.click()
        page.keyboard.press("Shift+Enter")
        idle(page)
        page.keyboard.press("Control+s")
        page.wait_for_timeout(600)
        txt = page.evaluate("__opfsRead('picked.ipynb')")
        check('"execution_count": 1' in txt and "picked" in txt, "file opened with the picker saves in place", txt[:200])
        pk.locator("button[aria-label='More']").click()
        page.click(".sheet-item:has-text('Save as')")
        page.wait_for_timeout(600)
        check("saved-picked.ipynb" in pk.locator(".pane-head").inner_text(), "Save as writes a new file and switches to it", pk.locator(".pane-head").inner_text())

        # ---- a real folder as Python's working folder (stubbed with OPFS)
        page.evaluate("""(async () => { const root = await navigator.storage.getDirectory(); const d = await root.getDirectoryHandle('project', {create: true});
          const h = await d.getFileHandle('data.csv', {create: true}); const w = await h.createWritable(); await w.write('a,b\\n1,2\\n3,4\\n'); await w.close(); })()""")
        pk.locator("button[aria-label='More']").click()
        page.click(".sheet-item:has-text('Files')")
        page.click("button:has-text('Use a folder on this PC')")
        page.wait_for_selector(".file-row:has-text('data.csv')", timeout=20000)
        check("project" in page.inner_text(".file-areas"), "Files panel switches to the chosen folder")
        page.click(".panel header button[aria-label='Close']")
        pk.locator(".add-row button:has-text('Code')").click()
        page.keyboard.insert_text("import os, csv\nrows = list(csv.reader(open('data.csv')))\nopen('result.txt', 'w').write(str(len(rows)))\nprint(os.getcwd(), rows[-1])")
        page.keyboard.press("Control+Enter")
        idle(page)
        o = pk.locator(".cell").last.inner_text()
        check("/mnt/project ['3', '4']" in o, "code reads files in the chosen folder", o)
        res = page.evaluate("__opfsRead('result.txt', 'project')")
        check(res == "3", "files written by code appear in the folder", res)

        # ---- drag and drop a file onto the window
        page.evaluate("""() => {
          const dt = new DataTransfer();
          dt.items.add(new File([JSON.stringify({cells: [], metadata: {}, nbformat: 4, nbformat_minor: 5})], 'dropped.ipynb', {type: 'application/json'}));
          window.dispatchEvent(new DragEvent('dragover', {dataTransfer: dt, cancelable: true}));
          window.dispatchEvent(new DragEvent('drop', {dataTransfer: dt, cancelable: true}));
        }""")
        page.wait_for_selector(".pane-head:has-text('dropped.ipynb')", timeout=5000)
        check(True, "dropping a notebook opens it in a new pane")
        page.screenshot(path=os.path.join(SHOTS, "41-desktop-panes.png"))

        # ---- package panel lists the exe's download cache
        page.locator(".ws-area > .pane").first.locator("button[aria-label='More']").click()
        page.click(".sheet-item:has-text('Offline packages')")
        page.wait_for_selector(".pkg-footer", timeout=10000)
        check("Downloaded packages use" in page.inner_text(".pkg-footer"), "packages panel shows the exe's cache")
        page.click(".panel header button[aria-label='Close']")

        # ---- unsaved changes prompt when closing the window
        dirty = page.locator(".ws-area > .pane").first
        dirty.locator(".cell").first.click()
        page.keyboard.press("b")
        page.keyboard.type("x = 1")
        page.keyboard.press("Escape")
        blocked = page.evaluate("() => { const e = new Event('beforeunload', {cancelable: true}); window.dispatchEvent(e); return e.defaultPrevented; }")
        check(blocked, "closing with unsaved changes asks first")
        check(not errs, "no page errors", errs)
        b.close()
finally:
    server.terminate()
    server.wait(timeout=10)

# ---- the exe exits by itself after its last window closes
data2 = os.path.join(work, "data2")
proc = subprocess.Popen([EXE, "--no-browser", "--data-dir", data2, "--port", "38990"], stdout=subprocess.PIPE, text=True)
url = proc.stdout.readline().strip()
with sync_playwright() as p:
    b = p.chromium.launch()
    pg = b.new_page()
    pg.goto(url)
    pg.wait_for_selector(".home-screen")
    time.sleep(1)
    pg.close()
    b.close()
try:
    proc.wait(timeout=30)
    check(True, "exe exits after its last window closes")
except subprocess.TimeoutExpired:
    proc.kill()
    check(False, "exe exits after its last window closes")
check(not os.path.exists(os.path.join(data2, "instance.json")), "exe removes its instance file on exit")
shutil.rmtree(work, ignore_errors=True)
print(f"\n{len(failures)} failure(s)")
sys.exit(1 if failures else 0)
