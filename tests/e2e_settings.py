"""Settings: theme colour (applied, remembered, follows light/dark) and the About card."""
import os
import subprocess
import sys

from playwright.sync_api import sync_playwright

HERE = os.path.dirname(os.path.abspath(__file__))
PORT = 8771
srv = subprocess.Popen([sys.executable, os.path.join(HERE, "devserver.py"), str(PORT)], stdout=subprocess.PIPE)
srv.stdout.readline()
failures = []


def check(cond, label, extra=""):
    print(("ok   " if cond else "FAIL ") + label + ("" if cond else f"  -> {str(extra)[:300]}"), flush=True)
    if not cond:
        failures.append(label)


def css_var(page, name):
    return page.evaluate(f"getComputedStyle(document.documentElement).getPropertyValue('{name}').trim()").upper()


try:
    with sync_playwright() as p:
        b = p.chromium.launch()
        ctx = b.new_context(viewport={"width": 412, "height": 860}, color_scheme="light")
        # The test machine can't reach the internet: answer the website's address locally.
        ctx.route("https://tymon.website/**", lambda r: r.fulfill(body="tymon.website", content_type="text/plain"))
        page = ctx.new_page()
        errs = []
        page.on("pageerror", lambda e: errs.append(str(e)))
        page.goto(f"http://127.0.0.1:{PORT}/app/index.html")
        page.wait_for_selector(".home-screen")
        check(css_var(page, "--accent") == "#0E6B70", "teal is the default theme colour", css_var(page, "--accent"))
        page.click("button[aria-label='Settings']")
        page.wait_for_selector(".about-card")

        # ---- About card
        about = page.inner_text(".about-card")
        for text in ["PyNotebook", "Version", "Created by", "Tymon Ng", "Built with", "Claude AI", "Made in",
                     "Proudly made in Australia", "Website", "tymon.website", "Source code",
                     "github.com/TymonBitesTheDust/PyNotebook", "© 2026 Tymon Ng"]:
            check(text in about.replace("\n", "").replace("/​", "/") or text in about, f"About shows “{text}”", about)
        hrefs = page.eval_on_selector_all(".about-link", "as => as.map(a => a.href)")
        check(hrefs == ["https://tymon.website/", "https://github.com/TymonBitesTheDust/PyNotebook"], "About links point to the website and repo", hrefs)
        with ctx.expect_page() as popup:
            page.click(".about-link:has-text('tymon.website')")
        check(popup.value.url.startswith("https://tymon.website"), "website link opens outside the app", popup.value.url)
        popup.value.close()
        check(page.locator(".about-card img.about-icon").count() == 1, "About shows the app icon")

        # ---- theme colour
        check(page.locator(".swatch").count() == 6 and page.locator(".swatch.on").get_attribute("data-id") == "teal", "six colours, teal selected")
        page.click(".swatch[data-id='blue']")
        check(css_var(page, "--accent") == "#1D5FBF" and css_var(page, "--bg") == "#F3F5F9", "choosing Blue recolours the app", (css_var(page, "--accent"), css_var(page, "--bg")))
        check(page.get_attribute("meta[name='theme-color']", "content").upper() == "#F3F5F9", "browser bar colour follows the theme")
        check(page.locator(".swatch.on").get_attribute("data-id") == "blue" and page.locator(".swatch[aria-checked='true']").count() == 1, "Blue shows as selected")
        page.click(".seg-btn:has-text('Dark')")
        check(css_var(page, "--accent") == "#7EB0F7" and css_var(page, "--bg") == "#0E1420", "dark mode uses Blue's dark colours", css_var(page, "--accent"))
        page.reload()
        page.wait_for_selector(".home-screen")
        check(css_var(page, "--accent") == "#7EB0F7", "theme colour is remembered after restarting", css_var(page, "--accent"))
        bg = page.evaluate("getComputedStyle(document.querySelector('.home-action.main')).backgroundColor")
        check(bg == "rgb(126, 176, 247)", "buttons use the theme colour", bg)
        page.click("button[aria-label='Settings']")
        page.click(".seg-btn:has-text('System')")
        page.click(".swatch[data-id='teal']")
        check(css_var(page, "--accent") == "#0E6B70", "switching back to Teal restores the original look", css_var(page, "--accent"))
        check(not errs, "no page errors", errs)
        b.close()
finally:
    srv.terminate()
print(f"\n{len(failures)} failure(s)")
sys.exit(1 if failures else 0)
