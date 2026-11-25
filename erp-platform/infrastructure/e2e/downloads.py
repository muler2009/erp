import os
from playwright.sync_api import sync_playwright
BASE="http://beta.erp.localhost:5173"
with sync_playwright() as p:
    b=p.chromium.launch(); ctx=b.new_context(viewport={"width":1280,"height":800}, accept_downloads=True); page=ctx.new_page()
    page.goto(BASE+"/app/dashboard"); page.wait_for_url("**/realms/erp/**"); page.fill("#username",os.environ["E2E_USER"]); page.fill("#password",os.environ["E2E_PASSWORD"]); page.click("#kc-login"); page.wait_for_url(BASE+"/**")
    page.goto(BASE+"/app/analytics/reports"); page.wait_for_load_state("networkidle")
    opts=[o.get_attribute("value") for o in page.locator("#bi-ds option").all()]
    print(opts[:6])
    page.select_option("#bi-ds", opts[1])
    page.wait_for_timeout(500)
    print([x.inner_text() for x in page.locator("button").all()])
    page.get_by_role("button", name="Run").first.click()
    page.wait_for_load_state("networkidle"); page.wait_for_timeout(500)
    print([x.inner_text() for x in page.locator("button").all()])
    for fmt in ["CSV","Excel","PDF"]:
        btn=page.get_by_role("button", name=lambda n: n.startswith("Download") and fmt.lower() in n.lower()) if False else None
    for l in [x.inner_text() for x in page.locator("button").all() if x.inner_text().startswith("Download")]:
        with page.expect_download(timeout=20000) as d:
            page.get_by_role("button", name=l, exact=True).click()
        dl=d.value; path=dl.path(); import os
        print("DOWNLOAD", l, dl.suggested_filename, os.path.getsize(path), open(path,"rb").read(8))
    print("alerts:", [a.inner_text() for a in page.locator("[role=alert]").all()])
    b.close()
