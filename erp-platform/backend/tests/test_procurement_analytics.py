from datetime import timedelta
from decimal import Decimal as D

import pytest

from modules.procurement import analytics as an
from modules.procurement import returns as rt
from modules.procurement import services as proc
from tests.test_procurement import D0, api_env, approved_po, f, receive  # noqa: F401


@pytest.mark.django_db
def test_supplier_performance_is_measured_from_events(f):
    p = f["people"]
    po = approved_po(f, "10", "10")
    po.expected_date = D0 + timedelta(days=5)
    po.save(update_fields=["expected_date"])
    receive(f, po, "10")  # on time (receipt dated D0)
    r = rt.create_return(p["po"].id, po.id, location_id=f["loc_a"].id, return_date=D0, reason="Bad", lines=[{"po_line": str(po.lines.get().id), "quantity": "2"}])
    rt.approve_return(p["pm"].id, r.id)
    rt.dispatch_return(p["wh"].id, r.id)
    c = rt.create_claim(p["po"].id, supplier_id=f["supplier"].id, kind="DAMAGE", description="d", amount="9", order_id=po.id)
    rt.submit_claim(p["po"].id, c.id)
    from datetime import date as _d
    row = an.supplier_performance(D0, _d.today() + timedelta(days=1))[0]
    assert row["on_time_pct"] == "100.0" and row["defect_pct"] == "20.0" and row["claims"] == 1 and row["orders"] == 1
    assert an.spend(D0, D0 + timedelta(days=30))[0]["ordered"].startswith("100")
    assert an.spend(D0, D0 + timedelta(days=30), "month")[0]["orders"] == 1
    assert an.cycle_times(D0, D0 + timedelta(days=30))["po_to_receipt_days"] == "0.0"
    q = an.work_queue(D0)
    assert q["open_claims"] == 1 and q["pending_inspections"] == 0 and q["returns_awaiting_credit"] == 0


@pytest.mark.django_db
def test_analytics_and_settings_over_http(api_env):
    env, api = api_env
    qs = "?from=2026-01-01&to=2026-12-31"
    for path in ("analytics/supplier-performance", "analytics/spend", "analytics/cycle-times", "analytics/price-variance"):
        assert api["emp"].get(f"/api/v1/procurement/{path}{qs}").status_code == 403
        assert api["pm"].get(f"/api/v1/procurement/{path}{qs}").status_code == 200
    assert api["pm"].get("/api/v1/procurement/analytics/spend").status_code == 400
    assert api["pm"].get(f"/api/v1/procurement/analytics/spend{qs}&group_by=bogus").status_code == 400
    assert api["emp"].get("/api/v1/procurement/work-queue").status_code == 403
    assert "pending_inspections" in api["pm"].get("/api/v1/procurement/work-queue").json()
    assert api["emp"].patch("/api/v1/procurement/settings", {"procurement.over_receipt_percent": 5}).status_code == 403
    assert api["pm"].patch("/api/v1/procurement/settings", {"hr.retirement_age": 61}).status_code == 400
    r = api["pm"].patch("/api/v1/procurement/settings", {"procurement.over_receipt_percent": 5})
    assert r.status_code == 200 and r.json()["procurement.over_receipt_percent"] == 5
    assert api["pm"].patch("/api/v1/procurement/settings", {"procurement.over_receipt_percent": 99}).status_code == 400
