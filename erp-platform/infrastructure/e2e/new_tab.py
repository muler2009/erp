import os
from playwright.sync_api import sync_playwright
BASE="http://beta.erp.localhost:5173"
with sync_playwright() as p:
    b=p.chromium.launch(); ctx=b.new_context(viewport={"width":1280,"height":800}); page=ctx.new_page()
    page.goto(BASE+"/app/dashboard"); page.wait_for_url("**/realms/erp/**"); page.fill("#username",os.environ["E2E_USER"]); page.fill("#password",os.environ["E2E_PASSWORD"]); page.click("#kc-login"); page.wait_for_url(BASE+"/**"); page.wait_for_load_state("networkidle")
    seen={}
    page.route("**/api/v1/test/printable", lambda r: (seen.update(auth=r.request.headers.get("authorization","")[:7]), r.fulfill(status=200, content_type="text/html", body="<html><body><h1>Quotation Q-1</h1><script>window.__ran=1</script></body></html>")))
    with ctx.expect_page() as pg:
        page.evaluate("async () => { const m = await import('/src/shared/lib/fileDownload.ts'); await m.openFromApi('/api/v1/test/printable'); }")
    pop=pg.value; pop.wait_for_load_state()
    print("popup url scheme:", pop.url.split(":")[0], "| heading:", pop.inner_text("h1"), "| auth header sent:", seen.get("auth"), "| opener severed:", pop.evaluate("window.opener===null"))
    pop.pdf if False else None
    b.close()
