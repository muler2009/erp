"""HTTP-level permission matrix for the CRM/Sales correction (slices A-O)."""
import base64

import pytest

from tests.test_sales import api_env, f  # noqa: F401  (api_env builds its own env)
from tests.test_sales import D0

GETS = [
    "/api/v1/crm/cases", "/api/v1/crm/cases/sla", "/api/v1/crm/cases/report", "/api/v1/crm/insights/segmentation", "/api/v1/crm/insights/retention", "/api/v1/crm/insights/satisfaction",
    "/api/v1/crm/insights/profitability", "/api/v1/crm/insights/dashboard", "/api/v1/crm/teams", "/api/v1/crm/territories", "/api/v1/crm/portfolio",
    "/api/v1/sales/catalog", "/api/v1/sales/pricing/discount-rules", "/api/v1/sales/pricing/history", "/api/v1/sales/contracts", "/api/v1/sales/return-requests", "/api/v1/sales/return-requests/report",
    "/api/v1/sales/deliveries/performance", "/api/v1/sales/receivables/aging", "/api/v1/sales/backorders", "/api/v1/sales/commission-plans", "/api/v1/sales/commissions",
    "/api/v1/sales/analytics/backlog", "/api/v1/sales/analytics/forecast",
]


@pytest.mark.django_db
def test_every_new_read_endpoint_denies_users_without_the_module_permission(api_env):
    env, api = api_env
    for url in GETS:
        assert api["emp"].get(url).status_code == 403, url


@pytest.mark.django_db
def test_manager_only_actions_are_forbidden_to_reps(api_env):
    env, api = api_env
    acct = api["rep1"].post("/api/v1/crm/accounts", {"name": "Perm Customer"}).json()["id"]
    p = env["people"]
    for method, url, body in (
        ("put", "/api/v1/crm/cases/sla", {"priority": "HIGH", "first_response_hours": 1, "resolution_hours": 2}),
        ("post", "/api/v1/crm/teams", {"name": "T"}),
        ("post", "/api/v1/crm/portfolio/transfer", {"from_user": str(p["rep1"].id), "to_user": str(p["rep2"].id), "reason": "x"}),
        ("post", "/api/v1/crm/insights/refresh-lifecycle", {}),
        ("put", "/api/v1/sales/pricing/discount-rules", {"scope": "CATEGORY", "key": "a", "max_percent": 5}),
        ("post", "/api/v1/sales/pricing/lists", {"name": "x", "currency": "USD"}),
        ("post", "/api/v1/sales/commission-plans", {"name": "x", "tiers": [{"from": 0, "rate": 1}]}),
        ("put", "/api/v1/sales/targets", {"owner_id": str(p["rep1"].id), "period_start": "2026-03-01", "period_end": "2026-03-31", "amount": 1}),
        ("post", "/api/v1/sales/backorders/retry", {}),
    ):
        r = getattr(api["rep1"], method)(url, body)
        assert r.status_code == 403, (url, r.status_code)
        assert getattr(api["sm"], method)(url, body).status_code in (200, 201, 400, 404, 409), url  # a manager passes the permission gate
    assert api["rep1"].get("/api/v1/sales/pricing/history").status_code == 403


@pytest.mark.django_db
def test_service_case_flow_over_http_and_isolation_between_reps(api_env):
    env, api = api_env
    acct = api["rep1"].post("/api/v1/crm/accounts", {"name": "Case Customer"}).json()["id"]
    assert api["rep2"].post("/api/v1/crm/cases", {"account": acct, "subject": "x"}).status_code == 404
    c = api["rep1"].post("/api/v1/crm/cases", {"account": acct, "subject": "Late order", "priority": "HIGH"})
    assert c.status_code == 201 and c.json()["number"].startswith("CS-") and c.json()["sla"]["response_breached"] is False
    cid = c.json()["id"]
    assert api["rep2"].get(f"/api/v1/crm/cases/{cid}").status_code == 404
    assert api["rep2"].post(f"/api/v1/crm/cases/{cid}/comments", {"text": "hi"}).status_code == 404
    assert api["rep1"].post(f"/api/v1/crm/cases/{cid}/comments", {"text": "On it", "internal": False}).status_code == 201
    assert api["rep1"].post(f"/api/v1/crm/cases/{cid}/assign", {"owner_id": str(env["people"]["rep2"].id)}).status_code == 403
    assert api["sm"].post(f"/api/v1/crm/cases/{cid}/assign", {"owner_id": str(env["people"]["rep2"].id)}).json()["status"] == "OPEN"
    assert api["rep1"].post(f"/api/v1/crm/cases/{cid}/bogus", {}).status_code == 400
    assert api["rep1"].post(f"/api/v1/crm/cases/{cid}/attachments", {"filename": "a.txt", "content_base64": "###"}).status_code == 400
    assert api["sm"].post(f"/api/v1/crm/cases/{cid}/resolve", {"resolution": "fixed"}).json()["status"] == "RESOLVED"


@pytest.mark.django_db
def test_pricing_quotation_and_order_control_over_http(api_env):
    env, api = api_env
    w = str(env["widget"].id)
    acct = api["rep1"].post("/api/v1/crm/accounts", {"name": "Price Customer"}).json()["id"]
    assert api["sm"].post("/api/v1/sales/pricing/lists", {"name": "Std", "currency": "USD", "items": [{"product": w, "unit_price": "100"}]}).status_code == 201
    lines = [{"product": w, "quantity": "2", "unit_price": "50"}]
    assert api["rep1"].post("/api/v1/sales/quotations", {"account": acct, "currency": "USD", "lines": lines}).status_code == 400  # override denied
    q = api["rep1"].post("/api/v1/sales/quotations", {"account": acct, "currency": "USD", "lines": [{"product": w, "quantity": "2"}], "payment_terms": "Net 30"})
    assert q.status_code == 201 and q.json()["payment_terms"] == "Net 30" and q.json()["total"] == "200.00"
    qid = q.json()["id"]
    assert api["rep2"].get(f"/api/v1/sales/quotations/{qid}/document").status_code == 404
    doc = api["rep1"].get(f"/api/v1/sales/quotations/{qid}/document")
    assert doc.status_code == 200 and "text/html" in doc["Content-Type"] and q.json()["number"] in doc.content.decode()
    assert api["rep1"].post(f"/api/v1/sales/quotations/{qid}/send").json()["status"] == "SENT"
    assert api["rep1"].post(f"/api/v1/sales/quotations/{qid}/revise", {"reason": "changes"}).json()["status"] == "DRAFT"
    assert len(api["rep1"].get(f"/api/v1/sales/quotations/{qid}/revisions").json()) == 2
    assert api["rep1"].post(f"/api/v1/sales/quotations/{qid}/approve").status_code == 403
    assert api["rep1"].get(f"/api/v1/crm/accounts/{acct}/credit".replace("crm", "sales")).status_code == 200
    assert api["rep2"].get(f"/api/v1/sales/accounts/{acct}/credit").status_code == 404
    assert api["rep2"].get(f"/api/v1/crm/accounts/{acct}/summary").status_code == 404
    assert api["rep1"].get(f"/api/v1/crm/accounts/{acct}/summary").status_code == 200
    assert api["rep1"].get(f"/api/v1/sales/accounts/{acct}/statement?from=2026-01-01&to=2026-12-31").status_code == 200
    assert api["rep2"].get(f"/api/v1/sales/accounts/{acct}/statement?from=2026-01-01&to=2026-12-31").status_code == 404
    assert api["rep1"].get("/api/v1/sales/analytics/performance?from=2026-03-01&to=2026-03-31").status_code == 200
    assert api["rep1"].get("/api/v1/sales/analytics/performance?from=bad&to=2026-03-31").status_code == 400
