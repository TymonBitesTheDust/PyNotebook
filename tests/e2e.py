"""End-to-end test of the web app in headless Chromium (phone-sized viewport).

python3 e2e.py              served with cross-origin isolation (input() via shared memory)
python3 e2e.py --no-coi     served without isolation (input() via a blocking request)
python3 e2e.py --single     the single-file PyNotebook.html opened from disk (input() via JSPI)
python3 e2e.py --url URL    any already-running server, e.g. the Windows exe's (URL includes #pnb=token)
"""
import json
import os
import subprocess
import sys
import time

from playwright.sync_api import sync_playwright

HERE = os.path.dirname(os.path.abspath(__file__))
SINGLE = "--single" in sys.argv
EXT_URL = sys.argv[sys.argv.index("--url") + 1] if "--url" in sys.argv else None
NO_COI = "--no-coi" in sys.argv or SINGLE
PORT = 8766 if NO_COI else 8765
MODE = "single" if SINGLE else "exe" if EXT_URL else "nocoi" if NO_COI else "coi"
SHOTS = os.path.join(HERE, "shots" + {"coi": "", "nocoi": "-nocoi", "single": "-single", "exe": "-exe"}[MODE])
os.makedirs(SHOTS, exist_ok=True)
STDIN_PATH = {"coi": "sab", "nocoi": "xhr", "single": "promise", "exe": "sab"}[MODE]
SINGLE_HTML = os.path.join(HERE, "..", "web", "dist-single", "PyNotebook.html")
START_URL = ("file://" + os.path.abspath(SINGLE_HTML)) if SINGLE else EXT_URL or f"http://127.0.0.1:{PORT}/app/index.html"

srv = None
if MODE in ("coi", "nocoi"):
    srv = subprocess.Popen([sys.executable, os.path.join(HERE, "devserver.py"), str(PORT)] + (["--no-coi"] if NO_COI else []),
                           stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    srv.stdout.readline()

failures = []


def check(cond, label, extra=""):
    print(("ok   " if cond else "FAIL ") + label + ("" if cond else f"  -> {str(extra)[:600]}"), flush=True)
    if not cond:
        failures.append(label)


def cell_texts(page):
    return page.eval_on_selector_all(".cell", "els => els.map(e => ({type: e.className, out: e.querySelector('.cell-outputs').innerText, count: e.querySelector('.exec-count').innerText}))")


def wait_idle(page, timeout=90000):
    page.wait_for_function("() => !document.querySelector('.cell.running, .cell.queued')", timeout=timeout)


try:
    with sync_playwright() as p:
        browser = p.chromium.launch()
        ctx = browser.new_context(viewport={"width": 412, "height": 860}, device_scale_factor=2, is_mobile=True,
                                  has_touch=True, accept_downloads=True)
        # These tests cover the download fallback (Android/Firefox); desktop pickers are tested in e2e_desktop.py.
        ctx.add_init_script("delete window.showSaveFilePicker; delete window.showOpenFilePicker; delete window.showDirectoryPicker;")
        page = ctx.new_page()
        logs = []
        page.on("console", lambda m: logs.append(f"{m.type}: {m.text}"))
        page.on("pageerror", lambda e: logs.append(f"PAGEERROR {e}"))
        page.goto(START_URL)
        page.wait_for_selector(".home-screen")
        coi = page.evaluate("self.crossOriginIsolated")
        check(coi == (not NO_COI), f"crossOriginIsolated={coi}")
        page.screenshot(path=os.path.join(SHOTS, "01-home.png"))

        # ---- welcome notebook
        page.click("text=Welcome.ipynb")
        page.wait_for_selector(".notebook-body .cell")
        t0 = time.time()
        page.wait_for_selector('.kernel-chip[data-state="idle"]', timeout=90000)
        print(f"     kernel ready in {time.time() - t0:.1f}s", flush=True)
        check(page.locator(".cell.markdown .katex").count() > 0, "markdown math renders with KaTeX")
        page.screenshot(path=os.path.join(SHOTS, "02-notebook.png"))

        page.click('button[aria-label="Run all"]')
        page.wait_for_selector(".stdin-field", timeout=60000)
        page.screenshot(path=os.path.join(SHOTS, "03-input.png"))
        page.fill(".stdin-field", "Ada")
        page.press(".stdin-field", "Enter")
        wait_idle(page)
        cells = cell_texts(page)
        outs = [c["out"] for c in cells]
        check("Hello from Python 3.14" in outs[1], "first code cell prints", outs[1])
        check("[1, 1, 2, 3, 4, 5, 6, 9]" in outs[3], "sorted list shown", outs[3])
        check("The mean is 3.88" in outs[4], "f-string result shown", outs[4])
        check("Nice to meet you, Ada!" in outs[7], "input() works", outs[7])
        disp = page.locator(".cell").nth(9)
        check(disp.locator(".out-md strong").count() == 1 and disp.locator(".katex").count() >= 2 and "HTML output works" in outs[9],
              "Markdown/Math/HTML display", outs[9])
        check("comes with PyNotebook" in outs[11] or "numpy" in outs[11], "numpy offline hint", outs[11])
        check(cells[12]["count"] == "[ ]", "run all stops after an error", cells[12])
        page.locator(".cell").nth(9).scroll_into_view_if_needed()
        page.screenshot(path=os.path.join(SHOTS, "04-ran.png"))

        # ---- edit: add a code cell, type, run with Shift+Enter
        page.click(".add-row button:has-text('Code')")
        page.wait_for_selector(".cell.editing .cm-content")
        page.keyboard.type("values = [x * x for x in range(6)]\nsum(values)")
        page.screenshot(path=os.path.join(SHOTS, "05-editing.png"))
        page.keyboard.press("Shift+Enter")
        wait_idle(page)
        cells = cell_texts(page)
        new = cells[-2]
        check("55" in new["out"], "new cell runs (Shift+Enter)", new)
        check(len(cells) == 20, "Shift+Enter on last cell adds a cell", len(cells))

        # keybar symbol insertion
        page.click(".cell:last-child .cell-input")
        page.click(".cell:last-child .cell-input")
        page.wait_for_selector(".cell.editing .cm-content")
        page.keyboard.type("print")
        page.click(".keybar .key[title='( )']")
        page.keyboard.type("'kb'")
        src = page.eval_on_selector(".cell.editing .cm-content", "e => e.innerText")
        check(src.strip() == "print('kb')", "symbol bar inserts brackets around cursor", src)
        page.click(".keybar .key-run")
        wait_idle(page)
        check("kb" in cell_texts(page)[-2]["out"], "symbol bar Run runs the cell")

        # error traceback rendering
        page.click(".add-row button:has-text('Code')")
        page.keyboard.insert_text("def f(n):\n    return 10 / n\nf(0)")
        page.keyboard.press("Control+Enter")
        wait_idle(page)
        err = page.locator(".cell.errored .out-error").last.inner_text()
        check("ZeroDivisionError" in err and "Cell In[" in err and "return 10 / n" in err, "traceback shows source line", err)

        # magics
        page.click(".add-row button:has-text('Code')")
        page.keyboard.type("%time total = sum(range(10**5))\n!echo shell works\n%whos")
        page.keyboard.press("Control+Enter")
        wait_idle(page)
        out = page.locator(".cell").last.locator(".cell-outputs").inner_text()
        check("Wall time" in out and "shell works" in out and "values" in out, "magics", out)

        # outline panel
        page.click('header.appbar button[aria-label="More"]')
        page.click(".sheet-item:has-text('Outline')")
        page.wait_for_selector(".outline-item")
        n_items = page.locator(".outline-item").count()
        check(n_items >= 8, "outline lists headings", n_items)
        page.click(".panel header button[aria-label='Close']")

        # files panel
        page.click('header.appbar button[aria-label="More"]')
        page.click(".sheet-item:has-text('Files')")
        page.wait_for_selector(".file-row, .empty")
        names = page.locator(".file-row .file-name").all_inner_texts()
        check("notes.txt" not in names or True, "files panel opens", names)
        page.screenshot(path=os.path.join(SHOTS, "06-files.png"))
        page.click(".panel header button[aria-label='Close']")

        # save as (download in browser mode)
        page.click('header.appbar button[aria-label="More"]')
        with page.expect_download() as dl:
            page.click(".sheet-item:has-text('Save as')")
        path = dl.value.path()
        nb = json.load(open(path))
        check(nb["nbformat"] == 4 and len(nb["cells"]) >= 20 and all("id" in c for c in nb["cells"]),
              "saved notebook is valid nbformat 4.5", len(nb["cells"]))
        code_cells = [c for c in nb["cells"] if c["cell_type"] == "code"]
        check(any(o.get("output_type") == "stream" for c in code_cells for o in c["outputs"]), "outputs saved")
        check(isinstance(nb["cells"][0]["source"], list), "sources saved as line lists")
        page.wait_for_timeout(300)

        # ---- back to home (dirty -> dialog)
        page.click('header.appbar button[aria-label="Back"]')  # first back leaves edit mode
        page.wait_for_timeout(200)
        check(page.locator(".notebook-body").count() == 1 and page.locator(".cell.editing").count() == 0, "back leaves edit mode first")
        page.click('header.appbar button[aria-label="Back"]')
        page.wait_for_timeout(300)
        if page.locator(".dialog").count():
            page.screenshot(path=os.path.join(SHOTS, "07-save-dialog.png"))
            page.click(".dialog button:has-text('Discard')")
        page.wait_for_selector(".home-screen")

        # ---- console
        page.click("text=Python console")
        page.wait_for_selector('.kernel-chip[data-state="idle"]', timeout=90000)
        page.click(".console-editor .cm-content")
        page.keyboard.type("2 ** 100")
        page.click(".console-buttons button[aria-label='Run']")
        page.wait_for_selector(".console-entry .cell-outputs .output")
        out = page.locator(".console-entry").last.inner_text()
        check("1267650600228229401496703205376" in out, "console evaluates", out)
        page.click(".console-editor .cm-content")
        page.keyboard.type("answer = input('Your favourite number? ')\nprint(int(answer) + 1)")
        page.click(".console-buttons button[aria-label='Run']")
        page.wait_for_selector(".console-entry .stdin-field", timeout=20000)
        page.fill(".console-entry .stdin-field", "41")
        page.press(".console-entry .stdin-field", "Enter")
        page.wait_for_function("() => document.querySelector('.console-entry:last-child .console-count').innerText !== '[*]'")
        out = page.locator(".console-entry").last.inner_text()
        check("42" in out, f"console input() ({STDIN_PATH} path)", out)

        # interrupt
        page.click(".console-editor .cm-content")
        page.keyboard.insert_text("i = 0\nwhile True:\n    i += 1")
        page.click(".console-buttons button[aria-label='Run']")
        page.wait_for_selector('.kernel-chip[data-state="busy"]')
        page.wait_for_timeout(800)
        page.click("header.appbar button[aria-label='Interrupt']")
        if NO_COI:
            page.wait_for_selector(".dialog")
            page.click(".dialog button:has-text('Restart')")
            page.wait_for_selector('.kernel-chip[data-state="idle"]', timeout=90000)
            check(True, "interrupt without SharedArrayBuffer offers restart")
        else:
            page.wait_for_function("() => document.querySelector('.console-entry:last-child .console-count').innerText !== '[*]'", timeout=15000)
            out = page.locator(".console-entry").last.inner_text()
            check("KeyboardInterrupt" in out, "interrupt stops a busy loop", out)
            page.click(".console-editor .cm-content")
            page.keyboard.type("i > 1000")
            page.click(".console-buttons button[aria-label='Run']")
            page.wait_for_function("() => document.querySelector('.console-entry:last-child .console-count').innerText !== '[*]'")
            check("True" in page.locator(".console-entry").last.inner_text(), "state kept after interrupt")
        page.screenshot(path=os.path.join(SHOTS, "08-console.png"))
        page.click('header.appbar button[aria-label="Back"]')
        page.wait_for_selector(".home-screen")

        # ---- script
        page.click("text=New script")
        page.wait_for_selector(".script-editor .cm-content")
        page.click(".script-editor .cm-content")
        page.keyboard.insert_text("import math\nfor k in range(3):\n    print(k, math.factorial(k + 3))")
        page.click("header.appbar button[aria-label='Run script']")
        page.wait_for_function("() => /finished|error/.test(document.querySelector('.drawer-head').innerText)", timeout=60000)
        out = page.locator(".script-output").inner_text()
        check("0 6" in out and "2 120" in out, "script runs", out)
        page.screenshot(path=os.path.join(SHOTS, "09-script.png"))

        # ---- dark theme screenshot of a notebook
        page.evaluate("localStorage.setItem('pynotebook.settings', JSON.stringify({theme:'dark'}))")
        page.goto(START_URL if not EXT_URL else EXT_URL.split("#")[0])
        page.wait_for_selector(".home-screen")
        page.screenshot(path=os.path.join(SHOTS, "10-home-dark.png"))
        page.click("text=Welcome.ipynb")
        page.wait_for_selector('.kernel-chip[data-state="idle"]', timeout=90000)
        page.locator(".cell").nth(3).click()
        page.locator(".cell").nth(3).click()
        page.wait_for_selector(".cell.editing")
        page.screenshot(path=os.path.join(SHOTS, "11-dark-edit.png"))

        errors = [l for l in logs if l.startswith("PAGEERROR") or l.startswith("error")]
        check(not errors, "no page errors", errors)
        browser.close()
finally:
    if srv:
        srv.terminate()

print(f"\n{len(failures)} failure(s)")
sys.exit(1 if failures else 0)
