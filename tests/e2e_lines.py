"""Line numbers: one switch for notebooks (.ipynb) and Python files (.py), from the ⋯ menu,
Settings or the L key; the reading view lines up with the editor."""
import json
import os
import subprocess
import sys

from playwright.sync_api import sync_playwright

HERE = os.path.dirname(os.path.abspath(__file__))
PORT = 8773
srv = subprocess.Popen([sys.executable, os.path.join(HERE, "devserver.py"), str(PORT)], stdout=subprocess.PIPE)
srv.stdout.readline()
SHOTS = os.path.join(HERE, "shots-lines")
os.makedirs(SHOTS, exist_ok=True)
failures = []


def check(cond, label, extra=""):
    print(("ok   " if cond else "FAIL ") + label + ("" if cond else f"  -> {str(extra)[:400]}"), flush=True)
    if not cond:
        failures.append(label)


def cell(kind, src):
    c = {"cell_type": kind, "metadata": {}, "source": src}
    if kind == "code":
        c.update(outputs=[], execution_count=None)
    return c


TWELVE = "\n".join([f"x{i} = {i}" for i in range(1, 12)] + ["print(x11)"])
LONG = "total = " + " + ".join(f"value_{i}" for i in range(30))
NB = {
    "nbformat": 4, "nbformat_minor": 5, "metadata": {},
    "cells": [
        cell("markdown", "# Title\nSome text"),
        cell("code", "import math\n\nprint(math.pi)"),
        cell("code", TWELVE),
        cell("raw", "raw text\nsecond"),
        cell("code", LONG),
    ],
}

# Where the code's first character sits, relative to the cell, in reading and editing views.
FIRST_CHAR = """(root) => {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, { acceptNode: (n) => n.textContent.trim() ? 1 : 3 });
  const t = walker.nextNode();
  const r = document.createRange();
  r.setStart(t, 0); r.setEnd(t, 1);
  const a = r.getBoundingClientRect(), box = root.closest('.cell-input').getBoundingClientRect();
  return [a.left - box.left, a.top - box.top];
}"""


def menu_item(page, pane_sel, text):
    page.locator(f"{pane_sel} .pane-head button[aria-label='More']").first.click()
    page.wait_for_selector(".sheet-item")
    labels = page.eval_on_selector_all(".sheet-item", "xs => xs.map(x => x.innerText)")
    item = page.locator(f".sheet-item:has-text('{text}')")
    found = item.count() == 1
    if found:
        item.click()
    else:
        page.keyboard.press("Escape")
    page.wait_for_timeout(150)
    return found, labels


try:
    with sync_playwright() as p:
        b = p.chromium.launch()
        ctx = b.new_context(viewport={"width": 412, "height": 860}, device_scale_factor=2, is_mobile=True, has_touch=True)
        ctx.add_init_script("if (!sessionStorage.getItem('seeded')) { localStorage.setItem('pynotebook.settings', JSON.stringify({autoStart: false})); sessionStorage.setItem('seeded', '1'); }")
        page = ctx.new_page()
        errs = []
        page.on("pageerror", lambda e: errs.append(str(e)))
        page.goto(f"http://127.0.0.1:{PORT}/app/index.html")
        page.wait_for_selector(".home-screen")
        page.evaluate("t => __app.openText({ uri: null, name: 'lines.ipynb', text: t, writable: false, persistent: false })", json.dumps(NB))
        page.wait_for_selector(".cell.code .code-static")
        check(page.locator(".code-static.numbered").count() == 0, "numbers are off at first")

        # ---- notebook: turn on from the ⋯ menu
        found, labels = menu_item(page, ".pane", "Show line numbers")
        check(found, "notebook menu offers Show line numbers", labels)
        check(page.locator(".code-static.numbered").count() == 3, "every code cell is numbered", page.locator(".code-static.numbered").count())
        nums = page.evaluate("() => [...document.querySelectorAll('.cell.code')[1].querySelectorAll('.cl')].map(l => l.dataset.n)")
        check(nums == [str(i) for i in range(1, 13)], "each cell counts from 1 (1–12)", nums)
        texts = page.evaluate("() => [...document.querySelectorAll('.cell.code')[0].querySelectorAll('.cl')].map(l => l.textContent)")
        check(texts == ["import math", "", "print(math.pi)"], "blank lines are kept and numbered", texts)
        h = page.evaluate("() => [...document.querySelectorAll('.cell.code')[0].querySelectorAll('.cl')].map(l => Math.round(l.getBoundingClientRect().height))")
        check(len(set(h)) == 1 and h[0] > 15, "a blank line is as tall as a written one", h)
        check(page.locator(".cell.code .cl .tk-kw").count() >= 1 and page.locator(".cell.code .cl .tk-fn").count() >= 1, "code is still coloured")
        check(page.locator(".cell.raw .code-static.numbered, .cell.markdown .cl").count() == 0, "text and raw cells are not numbered")
        before = page.evaluate("() => getComputedStyle(document.querySelector('.cell.code .cl'), '::before').content")
        check(before == "attr(data-n)" or before == '"1"', "number is drawn beside the line", before)
        copied = page.evaluate("() => { const pre = document.querySelectorAll('.cell.code')[0].querySelector('pre'); const s = getSelection(); s.selectAllChildren(pre); const t = s.toString(); s.removeAllRanges(); return t; }")
        check("1" not in copied.replace("print(math.pi)", "") and "import math" in copied, "selecting code doesn't pick up the numbers", repr(copied))
        # A wrapped long line continues under the code, not under the number.
        rows = page.evaluate("""() => { const cl = document.querySelectorAll('.cell.code')[2].querySelector('.cl');
            const r = document.createRange(); r.selectNodeContents(cl); const rows = {};
            for (const x of r.getClientRects()) if (x.width > 1) { const k = Math.round(x.top); rows[k] = Math.min(rows[k] ?? 1e9, Math.round(x.left)); }
            return Object.values(rows); }""")
        check(len(rows) >= 2 and len(set(rows)) == 1, "wrapped lines line up with the code", rows)
        page.locator(".cell.code").nth(1).scroll_into_view_if_needed()
        page.screenshot(path=os.path.join(SHOTS, "notebook-read.png"))

        # ---- editing shows the same numbers in the same place
        static_pos = page.locator(".cell.code").nth(1).locator("pre").evaluate(FIRST_CHAR)
        static_line2 = page.evaluate("() => { const l = document.querySelectorAll('.cell.code')[1].querySelectorAll('.cl')[1]; const b = l.closest('.cell-input').getBoundingClientRect(); return l.getBoundingClientRect().top - b.top; }")
        page.locator(".cell.code").nth(1).locator("pre").click(position={"x": 5, "y": 5})
        page.keyboard.press("Enter")
        page.wait_for_selector(".cell.editing .cm-lineNumbers")
        gut = page.eval_on_selector_all(".cell.editing .cm-lineNumbers .cm-gutterElement", "es => es.filter(e => e.offsetHeight && e.textContent).map(e => e.textContent)")
        check(gut == [str(i) for i in range(1, 13)], "editor shows the same numbers", gut)
        edit_pos = page.locator(".cell.editing .cm-content").evaluate(FIRST_CHAR)
        dx, dy = abs(static_pos[0] - edit_pos[0]), abs(static_pos[1] - edit_pos[1])
        check(dx < 1.5 and dy < 1.5, "code doesn't jump when you start editing", (static_pos, edit_pos))
        edit_line2 = page.evaluate("() => { const l = document.querySelectorAll('.cell.editing .cm-line')[1]; const b = l.closest('.cell-input').getBoundingClientRect(); return l.getBoundingClientRect().top - b.top; }")
        check(abs(edit_line2 - static_line2) < 1.5, "line 2 sits at the same height in both views", (static_line2, edit_line2))
        num_edit = page.evaluate("() => { const e = [...document.querySelectorAll('.cell.editing .cm-lineNumbers .cm-gutterElement')].find(e => e.textContent === '12'); const b = e.closest('.cell-input').getBoundingClientRect(); const r = document.createRange(); r.selectNodeContents(e); const x = r.getBoundingClientRect(); return [x.right - b.left, x.top - b.top]; }")
        page.screenshot(path=os.path.join(SHOTS, "notebook-edit.png"))
        page.keyboard.press("Escape")
        page.wait_for_timeout(100)
        # Compare the number's right edge in the reading view (pseudo element: measure via its box).
        num_read = page.evaluate("""() => { const l = [...document.querySelectorAll('.cell.code')[1].querySelectorAll('.cl')][11]; const cs = getComputedStyle(l, '::before');
            const b = l.closest('.cell-input').getBoundingClientRect(), r = l.getBoundingClientRect();
            return [r.left - b.left + parseFloat(cs.width) - parseFloat(cs.paddingRight), r.top - b.top]; }""")
        check(abs(num_read[0] - num_edit[0]) < 1.5, "numbers end at the same place in both views", (num_read, num_edit))

        # ---- typing a new line while editing grows the numbers
        page.locator(".cell.code").nth(0).locator("pre").click(position={"x": 5, "y": 5})
        page.keyboard.press("Enter")
        page.wait_for_selector(".cell.editing .cm-lineNumbers")
        page.keyboard.press("Control+End")
        page.keyboard.press("Enter")
        page.keyboard.type("x = 1")
        gut = page.eval_on_selector_all(".cell.editing .cm-lineNumbers .cm-gutterElement", "es => es.filter(e => e.offsetHeight && e.textContent).map(e => e.textContent)")
        check(gut == ["1", "2", "3", "4"], "new lines are numbered as you type", gut)

        # ---- switching off while a cell is open updates the editor at once
        found, labels = menu_item(page, ".pane", "Hide line numbers")
        check(found, "menu now offers Hide line numbers", labels)
        check(page.locator(".cell.editing .cm-lineNumbers").count() == 0, "editor numbers go away")
        check(page.locator(".code-static.numbered").count() == 0, "reading view numbers go away")
        page.keyboard.press("Escape")
        page.wait_for_timeout(100)
        check(page.locator(".cell.editing").count() == 0, "Esc closes the cell after using the menu")
        nums = page.evaluate("() => [...document.querySelectorAll('.cell.code')[0].querySelectorAll('.cl')].length")
        check(nums == 0, "cell left editing without numbers", nums)

        # ---- L key in command mode (desktop keyboards)
        page.evaluate("document.activeElement && document.activeElement.blur()")
        page.keyboard.press("l")
        check(page.locator(".code-static.numbered").count() == 3, "L shows line numbers", page.locator(".code-static.numbered").count())
        page.keyboard.press("l")
        check(page.locator(".code-static.numbered").count() == 0, "L again hides them")
        page.keyboard.press("l")

        # ---- no wrap: numbers stay put while scrolling sideways
        page.click("button[aria-label='More'] >> nth=0")
        page.click(".sheet-item:has-text('Settings')")
        page.wait_for_selector(".about-card")
        lines_row = page.locator(".set-row:has(.set-label:text-is('Line numbers'))")
        hint = lines_row.inner_text()
        check("notebooks and .py files" in hint, "Settings explains where numbers show", hint)
        check(lines_row.locator("[role=switch]").get_attribute("aria-checked") == "true", "Settings switch shows numbers are on")
        page.locator(".set-row:has(.set-label:text-is('Wrap long lines')) [role=switch]").click()
        page.click(".panel header button[aria-label='Close']")
        page.wait_for_timeout(200)
        pre = page.locator(".cell.code").nth(2).locator("pre")
        check("wrap" not in (pre.get_attribute("class") or ""), "long lines no longer wrap", pre.get_attribute("class"))
        pre.evaluate("p => p.scrollLeft = 200")
        page.wait_for_timeout(100)
        sticky = page.evaluate("""() => { const pre = document.querySelectorAll('.cell.code')[2].querySelector('pre');
            return { scrolled: pre.scrollLeft, w: pre.scrollWidth, pw: pre.clientWidth }; }""")
        check(sticky["scrolled"] > 150, "long line scrolls sideways", sticky)
        pre.scroll_into_view_if_needed()
        page.screenshot(path=os.path.join(SHOTS, "notebook-nowrap-scrolled.png"))
        # Restore wrapping.
        page.click("button[aria-label='More'] >> nth=0")
        page.click(".sheet-item:has-text('Settings')")
        page.wait_for_selector(".about-card")
        page.locator(".set-row:has(.set-label:text-is('Wrap long lines')) [role=switch]").click()
        page.click(".panel header button[aria-label='Close']")

        # ---- remembered after a restart
        page.reload()
        page.wait_for_selector(".home-screen")
        page.evaluate("t => __app.openText({ uri: null, name: 'lines.ipynb', text: t, writable: false, persistent: false })", json.dumps(NB))
        page.wait_for_selector(".cell.code .code-static")
        check(page.locator(".code-static.numbered").count() == 3, "line numbers are remembered after restarting")

        # ---- .py file beside it
        page.evaluate("() => __app.openText({ uri: null, name: 'lines.py', text: 'def f(x):\\n    return x * 2\\n\\nprint(f(21))\\n', writable: false, persistent: false }, 'beside', __app.workspace.active)")
        page.wait_for_selector(".script-editor .cm-editor")
        gut = page.eval_on_selector_all(".script-editor .cm-lineNumbers .cm-gutterElement", "es => es.filter(e => e.offsetHeight && e.textContent).map(e => e.textContent)")
        check(gut == ["1", "2", "3", "4", "5"], ".py file shows line numbers", gut)
        page.screenshot(path=os.path.join(SHOTS, "split-py-notebook.png"))
        script_pane = ".pane:has(.script-editor)"
        found, labels = menu_item(page, script_pane, "Hide line numbers")
        check(found, ".py menu offers Hide line numbers", labels)
        check(page.locator(".script-editor .cm-lineNumbers").count() == 0, ".py numbers hide")
        check(page.locator(".code-static.numbered").count() == 0, "the notebook beside it follows too")
        found, labels = menu_item(page, script_pane, "Show line numbers")
        check(found and page.locator(".script-editor .cm-lineNumbers").count() == 1, ".py numbers come back from its menu")
        page.locator(".script-editor .cm-content").click()
        page.keyboard.press("Control+End")
        for _ in range(8):
            page.keyboard.press("Enter")
        gut = page.eval_on_selector_all(".script-editor .cm-lineNumbers .cm-gutterElement", "es => es.filter(e => e.offsetHeight && e.textContent).map(e => e.textContent)")
        check(gut[-1] == "13" and len(gut) == 13, "gutter widens to two digits as the file grows", gut[-3:])
        page.evaluate("document.activeElement && document.activeElement.blur()")
        page.screenshot(path=os.path.join(SHOTS, "py-numbers.png"))


        # ---- dark mode keeps the numbers readable
        ctx2 = b.new_context(viewport={"width": 412, "height": 860}, device_scale_factor=2, color_scheme="dark", is_mobile=True, has_touch=True)
        ctx2.add_init_script("localStorage.setItem('pynotebook.settings', JSON.stringify({autoStart: false, lineNumbers: true, accent: 'blue'}));")
        p2 = ctx2.new_page()
        p2.goto(f"http://127.0.0.1:{PORT}/app/index.html")
        p2.wait_for_selector(".home-screen")
        p2.evaluate("t => __app.openText({ uri: null, name: 'lines.ipynb', text: t, writable: false, persistent: false })", json.dumps(NB))
        p2.wait_for_selector(".code-static.numbered")
        p2.locator(".cell.code").nth(1).scroll_into_view_if_needed()
        p2.screenshot(path=os.path.join(SHOTS, "notebook-dark.png"))
        # ---- the console's input line stays unnumbered
        p2.evaluate("() => __app.openConsole('beside', __app.workspace.active)")
        p2.wait_for_selector(".console-body .cm-editor")
        check(p2.locator(".console-body .cm-lineNumbers").count() == 0, "console input has no line numbers")
        ctx2.close()
        check(not errs, "no page errors", errs)
        b.close()
finally:
    srv.terminate()
print(f"\n{len(failures)} failure(s)")
sys.exit(1 if failures else 0)
