from datetime import date, timedelta
from decimal import Decimal as D

import pytest
from django_tenants.utils import schema_context

from modules.assets import jobs
from modules.assets import maintenance as mt
from modules.assets import models as am
from modules.assets import planning as pl
from modules.assets import services as svc
from shared.api.errors import DomainError, ValidationFailed
from tests.test_assets import activate, api_env, f, laptop  # noqa: F401

TODAY = date.today()


def codes(e):
    return e.value.get_codes()


def live(f, serial, cost="1200"):
    return activate(f, laptop(f, serial_number=serial, purchase_cost=cost), cost=cost)


@pytest.mark.django_db
def test_replacement_candidates_follow_rules_and_settings(f):
    healthy, poor, flaky, costly = live(f, "R1"), live(f, "R2"), live(f, "R3"), live(f, "R4")
    u = f["people"]["am_"].id
    am.Asset.objects.filter(pk=poor.id).update(condition="POOR")
    for _ in range(3):
        b = mt.report_breakdown(u, flaky.id, symptoms="x")
        am.Breakdown.objects.filter(pk=b.id).update(status="CLOSED")
        am.Asset.objects.filter(pk=flaky.id).update(status="AVAILABLE")
    wo = mt.create_work_order(u, costly.id, kind="PREVENTIVE", description="overhaul")
    mt.start(u, wo.id)
    mt.add_external_cost(u, wo.id, amount="700")
    mt.complete(u, wo.id, notes="done")
    got = {c["asset"]: c["reasons"] for c in pl.replacement_candidates()}
    assert healthy.number not in got
    assert got[poor.number] == ["CONDITION_POOR"] and got[flaky.number] == ["REPEATED_BREAKDOWNS"] and got[costly.number] == ["MAINTENANCE_COST_HIGH"]


@pytest.mark.django_db
def test_replacement_plan_and_capex_budget_need_second_approver(f):
    a = live(f, "P1")
    u, u2 = f["people"]["am_"].id, f["people"]["am2"].id
    item = pl.plan_replacement(u, a.id, planned_year=2027, estimated_cost="1500", reason="End of life")
    with pytest.raises(DomainError) as e:
        pl.plan_replacement(u, a.id, planned_year=2027, estimated_cost="1", reason="dup")
    assert codes(e) == "already_pending"
    with pytest.raises(DomainError) as e:
        pl.decide_replacement(u, item.id, approve=True)
    assert codes(e) == "separation_of_duties"
    assert pl.decide_replacement(u2, item.id, approve=True).status == "APPROVED"
    with pytest.raises(DomainError) as e:
        pl.decide_replacement(u2, item.id, approve=True)
    assert codes(e) == "invalid_state"
    b = pl.propose_budget(u, year=2026, amount="1000", category_id=f["cat"].id)
    with pytest.raises(DomainError):
        pl.propose_budget(u, year=2026, amount="5", category_id=f["cat"].id)
    with pytest.raises(ValidationFailed):
        pl.decide_budget(u2, b.id, approve=False)
    pl.decide_budget(u2, b.id, approve=True)
    row = pl.budget_report(2026)["rows"][0]
    assert row["category"] == "IT" and D(row["budget"]) == 1000 and D(row["actual"]) == 1200 and row["over_budget"] is True
    assert D(pl.budget_report(2027)["rows"][0]["planned_replacements"]) == 1500


@pytest.mark.django_db
def test_dashboard_and_daily_job_are_consistent_and_idempotent(f):
    a = live(f, "J1")
    u = f["people"]["am_"].id
    svc.update_category(None, f["cat"].id, inspection_interval_days=30)
    mt.create_plan(u, a.id, name="Clean", interval_days=30, first_due_on=TODAY - timedelta(days=1))
    first = jobs.run_daily(TODAY + timedelta(days=45))
    assert len(first["maintenance"]["created"]) == 1 and first["inspections_scheduled"] == 1
    second = jobs.run_daily(TODAY + timedelta(days=45))
    assert second["maintenance"]["created"] == [] and second["inspections_scheduled"] == 0
    d = pl.dashboard(TODAY + timedelta(days=46))
    assert d["assets_by_status"]["AVAILABLE"] == 1 and d["maintenance"]["open_work_orders"] == 1 and d["inspections"]["overdue"] == 1 and d["reconciled"] is True


@pytest.mark.django_db
def test_http_permissions(api_env, acme):
    env, api = api_env
    with schema_context(acme["schema"]):
        a = activate(env, laptop(env, serial_number="HP1"))
    assert api["auditor"].get("/api/v1/assets/dashboard").status_code == 200
    assert api["emp"].get("/api/v1/assets/dashboard").status_code == 403
    assert api["auditor"].post("/api/v1/assets/capex-budgets", {"year": 2026, "amount": "10"}).status_code == 403
    assert api["am"].post("/api/v1/assets/capex-budgets", {"year": 2026, "amount": "10"}).status_code == 201
    assert api["am"].get("/api/v1/assets/reports/capex").status_code == 400
    r = api["am"].post("/api/v1/assets/replacement-plan", {"asset": str(a.id), "planned_year": 2027, "estimated_cost": "900", "reason": "Old"})
    assert r.status_code == 201
    assert api["am"].post(f"/api/v1/assets/replacement-plan/{r.json()['id']}/approve").status_code == 403  # own entry
