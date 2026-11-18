"""Typing help: suggestions as you type ("pr" -> print) and mistakes marked as you type."""
import json
import os
import subprocess
import sys

from playwright.sync_api import sync_playwright

HERE = os.path.dirname(os.path.abspath(__file__))
PORT = 8772
srv = subprocess.Popen([sys.executable, os.path.join(HERE, "devserver.py"), str(PORT)], stdout=subprocess.PIPE)
srv.stdout.readline()
SHOTS = os.path.join(HERE, "shots-assist")
os.makedirs(SHOTS, exist_ok=True)
failures = []


def check(cond, label, extra=""):
    print(("ok   " if cond else "FAIL ") + label + ("" if cond else f"  -> {str(extra)[:400]}"), flush=True)
    if not cond:
        failures.append(label)


def editing_text(page):
    return page.eval_on_selector(".cell.editing .cm-content", "e => e.cmView ? e.cmView.view.state.doc.toString() : e.innerText")


def doc_text(page, sel=".cell.editing .cm-editor"):
    return page.evaluate(f"""() => [...document.querySelectorAll("{sel} .cm-line")]
        .map((l) => (l.querySelector(".cm-placeholder") ? "" : l.textContent)).join("\\n")""")


def clear_cell(page):
    page.keyboard.press("Control+a")
    page.keyboard.press("Delete")


def bar(page):
    loc = page.locator(".cell.editing .cm-problemBar")
    return loc.text_content() if loc.count() and loc.is_visible() else ""


try:
    with sync_playwright() as p:
        b = p.chromium.launch()
        ctx = b.new_context(viewport={"width": 412, "height": 860}, device_scale_factor=2, is_mobile=True, has_touch=True)
        # Start with Python off, to check the help that works before Python is ready.
        ctx.add_init_script("if (!sessionStorage.getItem('seeded')) { localStorage.setItem('pynotebook.settings', JSON.stringify({autoStart: false})); sessionStorage.setItem('seeded', '1'); }")
        page = ctx.new_page()
        errs = []
        page.on("pageerror", lambda e: errs.append(str(e)))
        page.goto(f"http://127.0.0.1:{PORT}/app/index.html")
        page.click("text=New notebook")
        page.wait_for_selector(".cell.editing .cm-content")
        check(page.locator('.kernel-chip[data-state="off"]').count() == 1, "Python is off for the first checks")

        # ---- suggestions without Python
        page.keyboard.type("pr", delay=60)
        page.wait_for_selector(".cm-tooltip-autocomplete li", timeout=5000)
        first = page.locator(".cm-tooltip-autocomplete li").first.inner_text()
        check(first.startswith("print"), "typing 'pr' suggests print first", first)
        check("sep=" in first, "print's suggestion shows how to call it", first)
        check(page.locator(".cm-tooltip-autocomplete li[aria-selected]").count() == 0, "nothing pre-selected, so Enter still makes a new line")
        page.screenshot(path=os.path.join(SHOTS, "suggest-print.png"))
        page.keyboard.press("Tab")
        page.keyboard.type('"hi"')
        check(doc_text(page) == 'print("hi")', "Tab inserts print() with the cursor inside", doc_text(page))
        page.keyboard.press("End")
        page.keyboard.press("Enter")
        page.keyboard.type("le", delay=60)
        page.wait_for_selector(".cm-tooltip-autocomplete li")
        page.locator(".cm-tooltip-autocomplete li:has-text('len')").first.click()
        check(doc_text(page).endswith("len()"), "tapping a suggestion inserts it", doc_text(page))
        clear_cell(page)
        page.keyboard.type("pr", delay=60)
        page.wait_for_selector(".cm-tooltip-autocomplete li")
        page.keyboard.press("Enter")
        check(doc_text(page) == "pr\n", "Enter starts a new line when nothing is picked", repr(doc_text(page)))
        clear_cell(page)
        page.keyboard.type("import nu", delay=60)
        page.wait_for_selector(".cm-tooltip-autocomplete li")
        check("numpy" in page.locator(".cm-tooltip-autocomplete li").first.inner_text(), "after 'import', module names are suggested")
        page.keyboard.press("Tab")
        check(doc_text(page) == "import numpy", "module name inserted without ()", doc_text(page))
        clear_cell(page)
        page.keyboard.type("# pr", delay=60)
        page.wait_for_timeout(500)
        check(page.locator(".cm-tooltip-autocomplete").count() == 0, "no suggestions inside comments")
        clear_cell(page)

        # ---- mistakes without Python (quick check)
        page.keyboard.insert_text("x = max(1, 2")  # pasted: typing "(" would add the ")" itself
        page.wait_for_function("() => { const b = document.querySelector('.cell.editing .cm-problemBar'); return b && !b.hidden; }", timeout=5000)
        check("'(' was never closed" in bar(page), "missing ')' is reported", bar(page))
        check(page.locator(".cell.editing .cm-problemLine-error").count() == 1, "the line is marked")
        check(page.locator(".cell.editing .cm-lintRange-error, .cell.editing .cm-lintPoint").count() >= 1, "the spot is underlined")
        page.keyboard.type(")")
        page.wait_for_timeout(1100)
        check(bar(page) == "" and page.locator(".cell.editing .cm-problemLine").count() == 0, "the mark goes away once fixed", bar(page))
        clear_cell(page)
        page.keyboard.insert_text("if x > 1\n    y = 2")
        page.wait_for_timeout(1100)
        check("Line 1: Expected ':'" in bar(page), "missing colon is reported on its line", bar(page))
        clear_cell(page)
        page.keyboard.insert_text("name = 'Ada")
        page.wait_for_timeout(1100)
        check("Unterminated string literal" in bar(page), "unclosed quote is reported", bar(page))
        page.screenshot(path=os.path.join(SHOTS, "mistake-quick.png"))
        clear_cell(page)
        page.keyboard.insert_text("ok = [1, 2]  # (not a problem)\nfor i in ok: print(i)")
        page.wait_for_timeout(1100)
        check(bar(page) == "", "correct code isn't marked", bar(page))
        clear_cell(page)

        # ---- with Python running: its exact messages, undefined names and fixes
        page.click(".kernel-chip")
        page.wait_for_selector('.kernel-chip[data-state="idle"]', timeout=90000)
        page.locator(".cell.editing .cm-content").click()
        page.keyboard.insert_text('pirnt("hello")')
        page.wait_for_timeout(1300)
        check("'pirnt' isn't defined. Did you mean 'print'?" in bar(page), "a typo gets a suggestion", bar(page))
        check(page.locator(".cell.editing .cm-problemLine-warning").count() == 1, "the line is marked as a warning")
        page.screenshot(path=os.path.join(SHOTS, "mistake-typo.png"))
        page.click(".cell.editing .cm-problemFix")
        check(doc_text(page) == 'print("hello")', "Fix changes it to print", doc_text(page))
        page.wait_for_timeout(1300)
        check(bar(page) == "", "no problem after the fix", bar(page))
        clear_cell(page)
        page.keyboard.insert_text("for i in range(3):\nprint(i)")
        page.wait_for_timeout(1300)
        check("Line 2: Expected an indented block after 'for' statement on line 1" in bar(page), "Python's own message for missing indentation", bar(page))
        clear_cell(page)
        page.keyboard.insert_text("print(1 2)")
        page.wait_for_timeout(1300)
        check("Perhaps you forgot a comma?" in bar(page), "Python spots a missing comma", bar(page))
        clear_cell(page)

        # names defined in another cell count, even before that cell runs
        page.keyboard.insert_text("price = 10")
        page.keyboard.press("Escape")
        page.click(".add-row button:has-text('Code')")
        page.wait_for_selector(".cell.editing .cm-content")
        page.keyboard.insert_text("total = price * 2\nprint(totl)")
        page.wait_for_timeout(1300)
        b_text = bar(page)
        check("price" not in b_text and "'totl' isn't defined. Did you mean 'total'?" in b_text, "names from other cells count; misspellings don't", b_text)
        clear_cell(page)
        page.keyboard.type("pr", delay=60)
        page.wait_for_selector(".cm-tooltip-autocomplete li")
        labels = page.locator(".cm-tooltip-autocomplete .cm-completionLabel").all_inner_texts()
        check(labels[:1] == ["print"] and "price" in labels[:4], "suggestions include the notebook's own names", labels[:6])
        page.keyboard.press("Escape")
        clear_cell(page)
        page.keyboard.insert_text("import math\nmath.sqroot(2)")
        page.wait_for_timeout(1300)
        page.keyboard.press("Shift+Enter")
        page.wait_for_function("() => !document.querySelector('.cell.running, .cell.queued')", timeout=60000)
        page.locator(".cell").nth(1).click()
        page.locator(".cell").nth(1).locator(".cell-input").click()
        page.wait_for_selector(".cell.editing .cm-content")
        page.wait_for_timeout(1300)
        check("Module 'math' has no attribute 'sqroot'. Did you mean 'sqrt'?" in bar(page), "misspelt module function after import", bar(page))
        page.keyboard.press("Control+End")
        page.keyboard.insert_text("\nmath.fl")
        page.keyboard.type("o", delay=60)
        page.wait_for_selector(".cm-tooltip-autocomplete li")
        lbl = page.locator(".cm-tooltip-autocomplete li").first.inner_text()
        check(lbl.startswith("floor"), "attribute suggestions after a dot", lbl)
        page.keyboard.press("Tab")
        check(doc_text(page).endswith("math.floor()"), "method inserted with ()", doc_text(page).splitlines()[-1])
        page.keyboard.press("Escape")

        # ---- console and script editors get the same help
        page.evaluate("__app.showHome()")
        page.click("text=Python console")
        page.wait_for_selector('.kernel-chip[data-state="idle"]', timeout=90000)
        page.locator(".console-editor .cm-content").click()
        page.keyboard.insert_text("lenght = len([1, 2]")
        page.wait_for_timeout(1300)
        cb = page.locator(".console-editor .cm-problemBar")
        check(cb.is_visible() and "'(' was never closed" in cb.text_content(), "console marks mistakes", cb.text_content() if cb.count() else "")
        page.evaluate("__app.showHome()")
        page.click("text=New script")
        page.wait_for_selector(".script-editor .cm-content")
        page.locator(".script-editor .cm-content").click()
        page.keyboard.insert_text("def area(r):\n    return 3.14 * r ** 2\n\nprint(aera(2))")
        # Python is off in this test (it would otherwise start when you begin editing)
        page.click(".kernel-chip")
        page.click(".sheet-item:has-text('Start Python')")
        page.wait_for_selector('.kernel-chip[data-state="idle"]', timeout=90000)
        page.wait_for_timeout(1500)
        sb = page.locator(".script-editor .cm-problemBar")
        txt = sb.text_content() if sb.count() and sb.is_visible() else ""
        check("Line 4" in txt and "Did you mean 'area'?" in txt, "script marks a misspelt function", txt)

        # ---- settings switches
        page.evaluate("__app.showHome()")
        page.click("button[aria-label='Settings']")
        page.locator(".set-row:has-text('Suggestions while typing') .switch").click()
        page.locator(".set-row:has-text('Mark mistakes while typing') .switch").click()
        page.click(".panel header button[aria-label='Close']")
        page.click("text=New notebook")
        page.wait_for_selector(".cell.editing .cm-content")
        page.keyboard.type("pr", delay=60)
        page.wait_for_timeout(600)
        check(page.locator(".cm-tooltip-autocomplete").count() == 0, "suggestions can be switched off")
        page.keyboard.insert_text("(")
        page.wait_for_timeout(1200)
        check(bar(page) == "", "mistake marking can be switched off", bar(page))
        check(not errs, "no page errors", errs)
        b.close()
finally:
    srv.terminate()
print(f"\n{len(failures)} failure(s)")
sys.exit(1 if failures else 0)
