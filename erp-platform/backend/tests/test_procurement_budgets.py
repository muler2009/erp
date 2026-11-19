from decimal import Decimal as D

import pytest

from modules.procurement import budgets as bd
from modules.procurement import models as pm
from modules.procurement import services as proc
from shared.api.errors import DomainError, ValidationFailed
from tests.test_procurement import D0, api_env, f, gl, po_lines, qualified  # noqa: F401


def budget(f, amount="1000", **kw):
    return bd.create_budget(f["people"]["pm"].id, code=kw.pop("code", "B1"), name="Ops", fiscal_year=2026, amount=amount, **kw)


def req_with(f, b, qty="10", price="10"):
    p = f["people"]
    r = proc.create_requisition(p["po"].id, title="n", lines=[{"product": str(f["widget"].id), "quantity": qty, "estimated_unit_price": price}], budget_id=b.id)
    proc.submit_requisition(p["po"].id, r.id)
    return proc.approve_requisition(p["pm"].id, r.id)


def com(ref_type, ref_id):
    return pm.BudgetCommitment.objects.get(ref_type=ref_type, ref_id=ref_id).amount


@pytest.mark.django_db
def test_requisition_and_po_commitments_flow(f):
    p, b = f["people"], budget(f)
    r = req_with(f, b)  # 100 committed
    assert bd.budget_status(b)["committed"] == "100.0000"
    rl = r.lines.get()
    po = proc.create_po(p["po"].id, supplier_id=f["supplier"].id, currency="USD", order_date=D0, requisition_id=r.id, lines=[{"product": str(f["widget"].id), "quantity": "4", "unit_price": "12", "requisition_line": str(rl.id)}])
    assert com("REQUISITION", r.id) == D("60.0000") and com("PO", po.id) == D("48.0000")  # estimate shrinks as it is ordered
    assert bd.budget_status(b)["available"] == "892.0000"
    proc.cancel_po(p["po"].id, po.id)
    assert com("PO", po.id) == 0 and com("REQUISITION", r.id) == D("100.0000")
    proc.cancel_requisition(p["po"].id, r.id)
    assert bd.budget_status(b)["committed"] == "0.0000"


@pytest.mark.django_db
def test_block_vs_warn_enforcement_and_year_check(f):
    p = f["people"]
    small = budget(f, "50", code="SMALL")
    with pytest.raises(DomainError) as e:
        req_with(f, small, "10", "10")
    assert e.value.get_codes() == "budget_exceeded"
    warn = budget(f, "50", code="WARN", enforcement="WARN")
    assert req_with(f, warn, "10", "10").status == "APPROVED"  # allowed, but flagged
    assert D(bd.budget_status(warn)["available"]) < 0
    wrong = bd.create_budget(None, code="Y25", name="Old", fiscal_year=2025, amount="999")
    with pytest.raises(ValidationFailed) as e:
        proc.create_po(p["po"].id, supplier_id=f["supplier"].id, currency="USD", order_date=D0, lines=po_lines(f), budget_id=wrong.id)
    assert e.value.get_codes() == "budget_year_mismatch"
    with pytest.raises(DomainError):
        proc.create_po(p["po"].id, supplier_id=f["supplier"].id, currency="USD", order_date=D0, lines=po_lines(f, "10", "10"), budget_id=small.id)  # 100 > 50


@pytest.mark.django_db
def test_revision_closing_and_execution_report(f):
    p, b = f["people"], budget(f, "500")
    po = proc.create_po(p["po"].id, supplier_id=f["supplier"].id, currency="USD", order_date=D0, lines=po_lines(f, "10", "10"), budget_id=b.id)
    with pytest.raises(DomainError) as e:
        bd.revise_budget(p["pm"].id, b.id, new_amount="50", reason="cut")
    assert e.value.get_codes() == "below_committed"
    with pytest.raises(ValidationFailed):
        bd.revise_budget(p["pm"].id, b.id, new_amount="900", reason="")
    assert bd.revise_budget(p["pm"].id, b.id, new_amount="900", reason="scope increase").amount == 900 and b.revisions.count() == 1
    with pytest.raises(DomainError):
        bd.close_budget(None, b.id)
    rep = bd.execution_report(2026)
    assert rep["rows"][0]["utilisation_pct"] == "11.1" and rep["totals"]["committed"] == "100.0000"
    proc.cancel_po(p["po"].id, po.id)
    assert bd.close_budget(None, b.id).status == "CLOSED"
    with pytest.raises(DomainError):
        proc.create_po(p["po"].id, supplier_id=f["supplier"].id, currency="USD", order_date=D0, lines=po_lines(f), budget_id=b.id)  # closed


@pytest.mark.django_db
def test_plan_revision_approval_and_variance(f):
    p = f["people"]
    plan = bd.create_plan(p["po"].id, code="P26", name="FY26", fiscal_year=2026, lines=[{"category": "IT", "planned_amount": "400", "quarter": 1}, {"category": "IT", "planned_amount": "100", "quarter": 3}, {"category": "Ops", "planned_amount": "50"}])
    with pytest.raises(DomainError) as e:
        bd.approve_plan(p["po"].id, plan.id)
    assert e.value.get_codes() == "separation_of_duties"
    bd.approve_plan(p["pm"].id, plan.id)
    it = budget(f, "300", code="IT", category="IT")
    proc.create_po(p["po"].id, supplier_id=f["supplier"].id, currency="USD", order_date=D0, lines=po_lines(f, "10", "10"), budget_id=it.id)
    rep = {r["category"]: r for r in bd.plan_vs_actual(plan.id)["rows"]}
    assert rep["IT"]["planned"] == "500.0000" and rep["IT"]["committed"] == "100.0000" and rep["IT"]["variance"] == "400.0000"
    rev = bd.revise_plan(p["po"].id, plan.id, lines=[{"category": "IT", "planned_amount": "700"}], reason="added project")
    assert rev.status == "DRAFT" and rev.revision == 2 and rev.revisions.get().snapshot[0]["planned_amount"] == "400.0000"
    with pytest.raises(ValidationFailed):
        bd.create_plan(None, code="X", name="x", fiscal_year=2026, lines=[{"category": "", "planned_amount": "1"}])


@pytest.mark.django_db
def test_budget_api_permissions(api_env):
    env, api = api_env
    body = {"code": "H1", "name": "HTTP", "fiscal_year": 2026, "amount": "100"}
    assert api["po"].post("/api/v1/procurement/budgets", body).status_code == 403
    assert api["pm"].post("/api/v1/procurement/budgets", body).status_code == 201
    assert api["po"].get("/api/v1/procurement/budgets/execution?fiscal_year=2026").json()["totals"]["budget"] == "100.0000"
    assert api["emp"].get("/api/v1/procurement/budgets").status_code == 403


@pytest.mark.django_db
def test_plan_list_includes_lines_for_revision(api_env):
    env, api = api_env
    body = {"code": "P1", "name": "Plan", "fiscal_year": 2026, "lines": [{"category": "IT", "quarter": 2, "planned_amount": "500"}, {"category": "Office", "quarter": 1, "planned_amount": "100", "description": "Chairs"}]}
    assert api["pm"].post("/api/v1/procurement/plans", body).status_code == 201
    rows = api["pm"].get("/api/v1/procurement/plans").json()["results"]
    assert rows[0]["lines"] == [{"category": "Office", "description": "Chairs", "quarter": 1, "planned_amount": "100.0000"}, {"category": "IT", "description": "", "quarter": 2, "planned_amount": "500.0000"}]
