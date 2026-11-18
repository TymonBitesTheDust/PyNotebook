import json, os, subprocess, sys
from playwright.sync_api import sync_playwright
HERE = os.path.dirname(os.path.abspath(__file__))
srv = subprocess.Popen([sys.executable, os.path.join(HERE, "devserver.py"), "8768"], stdout=subprocess.PIPE)
srv.stdout.readline()
try:
    with sync_playwright() as p:
        b = p.chromium.launch()
        ctx = b.new_context(viewport={"width": 400, "height": 860}, device_scale_factor=2, accept_downloads=True)
        # These tests cover the download fallback (Android/Firefox); desktop pickers are tested in e2e_desktop.py.
        ctx.add_init_script("delete window.showSaveFilePicker; delete window.showOpenFilePicker; delete window.showDirectoryPicker;")
        page = ctx.new_page()
        errs = []
        page.on("pageerror", lambda e: errs.append(str(e)))
        page.add_init_script("localStorage.setItem('pynotebook.settings', JSON.stringify({autoStart:false}))")
        page.goto("http://127.0.0.1:8768/app/index.html?open=/fixtures/real_outputs.ipynb")
        page.wait_for_selector(".notebook-body .cell")
        page.wait_for_timeout(500)
        r = page.evaluate("""() => ({
          tables: document.querySelectorAll('.out-html table').length,
          imgs: [...document.querySelectorAll('.out-img')].map(i => i.naturalWidth),
          stderr: document.querySelectorAll('.out-stream.stderr').length,
          ansi: document.querySelectorAll('.out-stream [class*=ansi-]').length,
          katex: document.querySelectorAll('.katex').length,
          errors: [...document.querySelectorAll('.out-error')].map(e => e.innerText.slice(0, 200)),
          counts: [...document.querySelectorAll('.exec-count')].map(e => e.innerText),
          mdtable: document.querySelectorAll('.markdown table').length,
          chip: document.querySelector('.kernel-chip').dataset.state,
        })""")
        print(json.dumps(r, indent=1))
        page.screenshot(path=os.path.join(HERE, "shots", "20-real-top.png"))
        page.locator(".cell").nth(2).scroll_into_view_if_needed()
        page.screenshot(path=os.path.join(HERE, "shots", "21-real-plot.png"))
        page.locator(".cell").nth(6).scroll_into_view_if_needed()
        page.screenshot(path=os.path.join(HERE, "shots", "22-real-error.png"))
        # round trip
        page.click("header.appbar button[aria-label='More']")
        with page.expect_download() as dl:
            page.click(".sheet-item:has-text('Save as')")
        a = json.load(open(os.path.join(HERE, "fixtures", "real_outputs.ipynb")))
        bnb = json.load(open(dl.value.path()))
        def norm(o):
            o = dict(o)
            for k in ("text", "data"):
                pass
            return o
        same = True
        for ca, cb in zip(a["cells"], bnb["cells"]):
            ja = json.dumps({k: ca.get(k) for k in ("cell_type", "source", "outputs", "execution_count")}, sort_keys=True)
            jb = json.dumps({k: cb.get(k) for k in ("cell_type", "source", "outputs", "execution_count")}, sort_keys=True)
            if ja != jb:
                same = False
                print("DIFF in cell", ca.get("id"))
                print(" A:", ja[:400]); print(" B:", jb[:400])
        print("round trip identical:", same, "| page errors:", errs)
        b.close()
finally:
    srv.terminate()
