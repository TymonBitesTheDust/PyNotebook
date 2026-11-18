"""Split-screen tests: several views of one file, different files side by side,
a console sharing a notebook's Python, resizing, maximizing and closing panes."""
import os
import subprocess
import sys

from playwright.sync_api import sync_playwright

HERE = os.path.dirname(os.path.abspath(__file__))
SHOTS = os.path.join(HERE, "shots")
os.makedirs(SHOTS, exist_ok=True)
PORT = 8769
srv = subprocess.Popen([sys.executable, os.path.join(HERE, "devserver.py"), str(PORT)], stdout=subprocess.PIPE)
srv.stdout.readline()
failures = []


def check(cond, label, extra=""):
    print(("ok   " if cond else "FAIL ") + label + ("" if cond else f"  -> {str(extra)[:500]}"), flush=True)
    if not cond:
        failures.append(label)


def pane(page, i):
    return page.locator(".ws-area > .pane").nth(i)


def idle(page, timeout=90000):
    page.wait_for_function("() => !document.querySelector('.cell.running, .cell.queued')", timeout=timeout)


try:
    with sync_playwright() as p:
        b = p.chromium.launch()
        ctx = b.new_context(viewport={"width": 412, "height": 860}, device_scale_factor=2, is_mobile=True, has_touch=True)
        page = ctx.new_page()
        errs = []
        page.on("pageerror", lambda e: errs.append(str(e)))
        page.goto(f"http://127.0.0.1:{PORT}/app/index.html")
        page.click("text=Welcome.ipynb")
        page.wait_for_selector('.kernel-chip[data-state="idle"]', timeout=90000)
        check(page.locator(".pane-head .close-btn .when-single").is_visible(), "single pane shows a back arrow")

        # ---- same notebook, second view
        pane(page, 0).locator("button[aria-label='Split screen']").click()
        page.click(".sheet-item:has-text('Same file, another view')")
        page.wait_for_selector(".ws-area > .pane:nth-of-type(2)")
        check(page.locator(".ws-area > .pane").count() == 2 and page.locator(".workspace.multi").count() == 1, "split into two panes")
        check(page.locator(".ws-area.rows").count() == 1 and page.locator(".ws-area > .divider").count() == 1, "stacked with a divider on a phone")
        check(page.locator(".pane-head .close-btn .when-multi").first.is_visible(), "panes show a close button")
        # scroll the second view to the end; the first stays put
        pane(page, 1).locator(".pane-body").evaluate("b => b.scrollTop = b.scrollHeight")
        page.wait_for_timeout(200)
        tops = page.eval_on_selector_all(".ws-area > .pane .pane-body", "bs => bs.map(b => Math.round(b.scrollTop))")
        check(tops[0] < 50 and tops[1] > 500, "views scroll independently", tops)
        page.screenshot(path=os.path.join(SHOTS, "30-split-same.png"))

        # edit in view 1 -> view 2 updates
        c1 = pane(page, 0).locator(".cell").nth(3)
        c1.click()
        c1.locator(".cell-input").click()
        page.wait_for_selector(".pane:nth-of-type(1) .cell.editing .cm-content")
        page.keyboard.press("Control+End")
        page.keyboard.type("  # edited in pane 1")
        page.wait_for_timeout(400)
        other = pane(page, 1).locator(".cell").nth(3).locator(".cell-input").inner_text()
        check("edited in pane 1" in other, "edits appear in the other view", other)
        check(page.locator(".workspace.keyboard").count() == 1, "symbol bar shows while typing")

        # run from view 2 -> outputs in both
        pane(page, 1).locator(".cell").nth(3).scroll_into_view_if_needed()
        pane(page, 1).locator(".cell").nth(3).click()
        page.click("nav.cellbar button[aria-label='Run cell']")
        idle(page)
        outs = [pane(page, i).locator(".cell").nth(3).locator(".cell-outputs").inner_text() for i in (0, 1)]
        check(all("[1, 1, 2, 3, 4, 5, 6, 9]" in o for o in outs), "outputs show in both views", outs)
        check(pane(page, 1).evaluate("e => e.classList.contains('active')"), "tapping a pane makes it active")

        # insert in view 1 -> appears in view 2; delete in view 2 -> gone in view 1
        n0 = pane(page, 1).locator(".cell").count()
        pane(page, 0).locator(".cell").nth(0).click()
        page.click("nav.cellbar button[aria-label='Add code cell below']")
        page.keyboard.type("split_marker = 1")
        page.wait_for_timeout(300)
        n1 = pane(page, 1).locator(".cell").count()
        check(n1 == n0 + 1 and "split_marker" in pane(page, 1).locator(".cell").nth(1).inner_text(), "inserted cell shows in both views", (n0, n1))
        pane(page, 1).locator(".cell").nth(1).click()
        page.click("nav.cellbar button[aria-label='Cell options']")
        page.click(".sheet-item:has-text('Delete cell')")
        page.wait_for_timeout(300)
        counts = [pane(page, i).locator(".cell").count() for i in (0, 1)]
        check(counts == [n0, n0], "deleted cell leaves both views", counts)

        # ---- console sharing the notebook's Python
        pane(page, 1).locator("button[aria-label='Split screen']").click()
        page.click(".sheet-item:has-text('Console for this notebook')")
        page.wait_for_selector(".console-body")
        check(page.locator(".ws-area > .pane").count() == 3, "third pane: console")
        check("Console · Welcome.ipynb" in pane(page, 2).locator(".pane-head").inner_text(), "console names its notebook")
        pane(page, 2).locator(".console-editor .cm-content").click()
        page.keyboard.type("sum(numbers) + 1000")
        pane(page, 2).locator(".console-buttons button[aria-label='Run']").click()
        page.wait_for_function("() => document.querySelector('.console-entry:last-child .console-count').innerText !== '[*]'")
        out = pane(page, 2).locator(".console-entry").last.inner_text()
        check("1031" in out, "console sees the notebook's variables", out)
        page.screenshot(path=os.path.join(SHOTS, "31-split-console.png"))

        # ---- resize with the divider
        h_before = pane(page, 0).bounding_box()["height"]
        d = page.locator(".ws-area > .divider").first.bounding_box()
        page.mouse.move(d["x"] + d["width"] / 2, d["y"] + d["height"] / 2)
        page.mouse.down()
        page.mouse.move(d["x"] + d["width"] / 2, d["y"] + d["height"] / 2 + 90, steps=6)
        page.mouse.up()
        h_after = pane(page, 0).bounding_box()["height"]
        check(h_after > h_before + 60, "dragging the divider resizes panes", (h_before, h_after))

        # ---- maximize, then back restores
        pane(page, 2).locator("button[aria-label='More']").click()
        page.click(".sheet-item:has-text('Maximize this pane')")
        page.wait_for_timeout(150)
        vis = [pane(page, i).is_visible() for i in range(3)]
        check(vis == [False, False, True], "maximize shows one pane", (vis, page.evaluate("[...document.querySelectorAll('.ws-area > *')].map(p => p.className + ':' + getComputedStyle(p).display)"), page.evaluate("document.querySelector('.ws-area').className")))
        page.evaluate("__app.back()")
        page.wait_for_timeout(200)
        vis = [pane(page, i).is_visible() for i in range(3)]
        check(vis == [True, True, True], "back restores all panes", vis)

        # ---- a different file beside: new script, then a second view of it
        pane(page, 2).locator("button[aria-label='Split screen']").click()
        page.click(".sheet-item:has-text('New script')")
        page.wait_for_selector(".script-body")
        check(page.locator(".ws-area > .pane").count() == 4, "four panes")
        page.locator(".script-body .cm-content").first.click()
        page.keyboard.insert_text("for i in range(3):\n    print('line', i)\n")
        pane(page, 3).locator("button[aria-label='Split screen']").click()
        page.wait_for_selector("#toast.show")
        check("Up to 4 panes" in page.inner_text("#toast"), "a fifth pane is refused", page.inner_text("#toast"))
        # close the console and add a second view of the script
        pane(page, 2).locator(".close-btn").click()
        page.wait_for_timeout(200)
        check(page.locator(".ws-area > .pane").count() == 3, "close a pane")
        script_pane = page.locator(".ws-area > .pane:has(.script-body)").first
        script_pane.locator("button[aria-label='Split screen']").click()
        page.click(".sheet-item:has-text('Same file, another view')")
        page.wait_for_function("() => document.querySelectorAll('.script-body').length === 2")
        s1 = page.locator(".script-body").nth(0)
        s2 = page.locator(".script-body").nth(1)

        s2.locator(".cm-content").click()
        page.keyboard.press("Control+End")
        page.keyboard.type("print('from view two')")
        page.wait_for_timeout(200)
        check("from view two" in s1.locator(".cm-content").inner_text(), "script edits sync between views")
        page.locator(".pane:has(.script-body)").nth(0).locator("button[aria-label='Run script']").click()
        page.wait_for_function("() => [...document.querySelectorAll('.drawer-head')].every(h => /finished|error/.test(h.innerText))", timeout=60000)
        outs = [page.locator(".script-output").nth(i).inner_text() for i in (0, 1)]
        check(all("from view two" in o and "line 2" in o for o in outs), "script output shows in both views", outs)
        page.screenshot(path=os.path.join(SHOTS, "32-split-mixed.png"))

        # ---- landscape: side by side
        page.set_viewport_size({"width": 915, "height": 412})
        page.wait_for_timeout(300)
        check(page.locator(".ws-area.cols").count() == 1, "landscape places panes side by side")
        page.screenshot(path=os.path.join(SHOTS, "33-split-landscape.png"))
        page.set_viewport_size({"width": 412, "height": 860})
        page.wait_for_timeout(200)
        pane(page, 0).locator("button[aria-label='More']").click()
        page.click(".sheet-item:has-text('Place panes side by side')")
        page.wait_for_timeout(150)
        check(page.locator(".ws-area.cols").count() == 1, "side-by-side can be chosen in portrait")
        pane(page, 0).locator("button[aria-label='More']").click()
        page.click(".sheet-item:has-text('Arrange automatically')")
        page.wait_for_timeout(150)
        check(page.locator(".ws-area.rows").count() == 1, "automatic arrangement returns to stacked")

        # ---- closing: dirty notebook asks once (last view), script asks too
        for _ in range(6):
            n = page.locator(".ws-area > .pane").count()
            if n == 0 or page.locator(".home-screen").count():
                break
            page.locator(".ws-area > .pane").first.locator(".close-btn").click()
            page.wait_for_timeout(250)
            if page.locator(".dialog").count():
                page.click(".dialog button:has-text('Discard')")
                page.wait_for_timeout(250)
        check(page.locator(".home-screen").count() == 1, "closing every pane returns home")
        check(page.evaluate("__app.liveDocs.size") == 0, "all documents released", page.evaluate("__app.liveDocs.size"))
        check(not errs, "no page errors", errs)
        b.close()
finally:
    srv.terminate()
print(f"\n{len(failures)} failure(s)")
sys.exit(1 if failures else 0)
