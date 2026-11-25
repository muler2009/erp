import os
import sys
from playwright.sync_api import sync_playwright
BASE="http://beta.erp.localhost:5173"
routes=[l.strip() for l in open(os.path.join(os.path.dirname(os.path.abspath(__file__)),"routes.txt")) if l.strip()]
lo,hi=int(sys.argv[1]),int(sys.argv[2])
with sync_playwright() as p:
    b=p.chromium.launch(); page=b.new_context(viewport={"width":390,"height":800}).new_page()
    page.goto(BASE+"/app/dashboard"); page.wait_for_url("**/realms/erp/**"); page.fill("#username",os.environ["E2E_USER"]); page.fill("#password",os.environ["E2E_PASSWORD"]); page.click("#kc-login"); page.wait_for_url(BASE+"/**"); page.wait_for_load_state("networkidle"); page.wait_for_timeout(1000)
    for r in routes[lo:hi]:
        try:
            page.goto(BASE+r); page.wait_for_load_state("networkidle", timeout=20000); page.wait_for_timeout(200)
            w=page.evaluate("[document.documentElement.scrollWidth, window.innerWidth]")
            if w[0]>w[1]: print("OVERFLOW", r, w)
        except Exception as e:
            print("ERR", r, type(e).__name__); page=page.context.new_page()
    print("done", lo, hi)
    b.close()
