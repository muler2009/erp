import os, sys
from playwright.sync_api import sync_playwright
BASE = os.environ.get("E2E_BASE", "http://beta.erp.localhost:5173")
USER = os.environ["E2E_USER"]
PASSWORD = os.environ["E2E_PASSWORD"]
allr = [l.strip() for l in open(os.path.join(os.path.dirname(__file__), "routes.txt")) if l.strip()]
lo, hi = int(sys.argv[1]), int(sys.argv[2])
routes = allr[lo:hi]
bad = []
with sync_playwright() as p:
    b = p.chromium.launch()
    page = b.new_context(viewport={"width": 1280, "height": 800}).new_page()
    cur = []
    page.on("pageerror", lambda e: cur.append("PAGEERROR " + str(e)[:160]))
    page.on("response", lambda r: cur.append(f"HTTP {r.status} {r.request.method} {r.url.replace(BASE,'')[:80]}") if r.status >= 400 and "/api/" in r.url else None)
    page.goto(BASE + routes[0])
    page.wait_for_url("**/realms/erp/**"); page.fill("#username", USER); page.fill("#password", PASSWORD); page.click("#kc-login")
    page.wait_for_url(BASE + "/**")
    for i, r in enumerate(routes):
        cur.clear()
        if i: page.goto(BASE + r)
        try:
            page.wait_for_load_state("networkidle", timeout=15000)
            page.wait_for_timeout(250)
        except Exception as e: cur.append("CRASH/TIMEOUT " + type(e).__name__); bad.append((r, cur[:], 0, "")); page = page.context.new_page(); continue
        body = " ".join(page.inner_text("main").split())[:90] if page.locator("main").count() else "NO MAIN"
        alert = page.locator("[role=alert]").count()
        if cur or alert or "NO MAIN" in body or "Something went wrong" in body:
            bad.append((r, list(dict.fromkeys(cur))[:3], alert, body))
    print(f"checked {len(routes)} routes, {len(bad)} with problems")
    for r, c, a, body in bad: print(r, "|", c, "| alerts:", a, "|", body)
    b.close()
