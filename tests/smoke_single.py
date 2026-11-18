import os, sys, time
from playwright.sync_api import sync_playwright
HTML = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "web", "dist-single", "PyNotebook.html")
with sync_playwright() as p:
    b = p.chromium.launch()
    page = b.new_page(viewport={"width": 1280, "height": 860})
    logs = []
    page.on("console", lambda m: logs.append(f"{m.type}: {m.text}"))
    page.on("pageerror", lambda e: logs.append(f"PAGEERROR {e}"))
    page.goto("file://" + HTML)
    page.wait_for_selector(".home-screen", timeout=20000)
    print("isSecureContext", page.evaluate("isSecureContext"), "COI", page.evaluate("crossOriginIsolated"),
          "FSA", page.evaluate("typeof showOpenFilePicker"), "JSPI", page.evaluate("typeof WebAssembly.Suspending"))
    page.click("text=Welcome.ipynb")
    t0 = time.time()
    try:
        page.wait_for_selector('.kernel-chip[data-state="idle"]', timeout=60000)
        print("kernel ready", round(time.time() - t0, 1), "s")
    except Exception as e:
        print("kernel not ready:", page.eval_on_selector(".kernel-chip", "e => e.dataset.state + ' ' + e.title"))
    print("\n".join(logs[-15:]))
    b.close()
