from datetime import date, timedelta
from decimal import Decimal as D

import pytest
from django.utils import timezone

from modules.projects import billing as bl
from modules.projects import costs as cs
from modules.projects import jobs
from modules.projects import models as pm
from modules.projects import reporting as rp
from modules.projects import risks as rk
from modules.projects import services as svc
from modules.projects import wbs as tk
from modules.finance import models as fm
from modules.finance import services as fin
from shared.api.errors import DomainError, ValidationFailed
from tests.test_projects_costs import activate, budget, employee_time, g  # noqa: F401
from tests.test_projects_wbs import S, E, api_env, codes, f, uid  # noqa: F401

TODAY = timezone.now().date()


def billable(g, kind="FIXED", value="1000"):
    svc.update_project(uid(g), g["p"].id, customer_id=g["fin_env"]["cust"].id, billing_type=kind, contract_value=value if kind == "FIXED" else 0)
    g["p"].refresh_from_db()


def post_invoice(g, invoice_id):
    p = g["fin_env"]["people"]
    fin.submit_invoice(p["officer"].id, invoice_id)
    fin.approve_invoice(p["mgr"].id, invoice_id)
    fin.post_invoice(p["mgr2"].id, invoice_id)


@pytest.mark.django_db
def test_risk_register_scoring_ownership_and_closing(g):
    pe = g["people"]
    r = rk.raise_risk(pe["dev"].id, g["p"].id, title="Supplier delay", probability=4, impact=5, owner_id=pe["dev2"].id)
    assert r.score == 20 and r.owner_id == pe["dev2"].id
    with pytest.raises(ValidationFailed):
        rk.raise_risk(pe["dev"].id, g["p"].id, title="bad", probability=6, impact=1)
    with pytest.raises(DomainError):
        rk.raise_risk(pe["outsider"].id, g["p"].id, title="x", probability=1, impact=1)
    with pytest.raises(DomainError) as e:
        rk.update_risk(pe["dev"].id, r.id, mitigation="x")  # not owner, not manager
    assert codes(e) == "forbidden"
    with pytest.raises(ValidationFailed):
        rk.update_risk(pe["dev2"].id, r.id, status="MITIGATING")
    rk.update_risk(pe["dev2"].id, r.id, status="MITIGATING", mitigation="Second supplier")
    with pytest.raises(DomainError) as e:
        rk.update_risk(pe["dev2"].id, r.id, status="CLOSED", note="done")
    assert codes(e) == "forbidden"
    assert rk.update_risk(uid(g), r.id, status="CLOSED", note="Supplier delivered").status == "CLOSED"
    with pytest.raises(DomainError):
        rk.update_risk(uid(g), r.id, mitigation="again")


@pytest.mark.django_db
def test_issue_lifecycle_sod_and_completion_blocked_by_serious_issues(g):
    pe = g["people"]
    risk = rk.raise_risk(uid(g), g["p"].id, title="R", probability=3, impact=3)
    i = rk.raise_issue(pe["dev"].id, g["p"].id, title="Crane down", severity="CRITICAL", risk_id=risk.id, assigned_to=pe["dev2"].id)
    risk.refresh_from_db()
    assert risk.status == "OCCURRED" and i.assigned_to == pe["dev2"].id
    with pytest.raises(DomainError) as e:
        rk.update_issue(pe["dev"].id, i.id, status="IN_PROGRESS")
    assert codes(e) == "forbidden"
    rk.update_issue(pe["dev2"].id, i.id, status="IN_PROGRESS")
    with pytest.raises(ValidationFailed):
        rk.update_issue(pe["dev2"].id, i.id, status="RESOLVED")
    with pytest.raises(DomainError) as e:
        rk.update_issue(pe["dev2"].id, i.id, status="CLOSED")
    assert codes(e) == "invalid_state_transition"
    rk.update_issue(pe["dev2"].id, i.id, status="RESOLVED", resolution="Replaced")
    activate(g)
    with pytest.raises(DomainError) as e:
        svc.set_status(uid(g), g["p"].id, "COMPLETED")
    assert codes(e) == "issues_open"  # resolved but not yet confirmed and closed
    assert rk.update_issue(uid(g), i.id, status="CLOSED").status == "CLOSED"
    assert svc.set_status(uid(g), g["p"].id, "COMPLETED").status == "COMPLETED"


@pytest.mark.django_db
def test_fixed_price_milestone_billing_caps_and_revenue_recognition(g):
    pe = g["people"]
    billable(g)
    ms = tk.create_task(uid(g), g["p"].id, name="Handover", planned_start=S + timedelta(days=30), planned_end=S + timedelta(days=30), is_milestone=True)
    with pytest.raises(DomainError) as e:
        bl.invoice_project(uid(g), g["p"].id, kind="MILESTONE", amount="600", task_id=ms.id, invoice_date=TODAY)
    assert codes(e) == "project_not_active"  # a planning project can take an advance only
    activate(g)
    with pytest.raises(DomainError) as e:
        bl.invoice_project(uid(g), g["p"].id, kind="MILESTONE", amount="600", task_id=ms.id, invoice_date=TODAY)
    assert codes(e) == "milestone_not_reached"
    tk.update_progress(uid(g), ms.id, percent=100)
    b = bl.invoice_project(uid(g), g["p"].id, kind="MILESTONE", amount="600", task_id=ms.id, invoice_date=TODAY)
    inv = fm.Invoice.objects.get(pk=b.invoice_id)
    assert inv.kind == "CUSTOMER_INVOICE" and inv.status == "DRAFT" and inv.subtotal == D("600")
    with pytest.raises(DomainError) as e:
        bl.invoice_project(uid(g), g["p"].id, kind="MILESTONE", amount="100", task_id=ms.id, invoice_date=TODAY)
    assert codes(e) == "already_pending"
    with pytest.raises(DomainError) as e:
        bl.invoice_project(uid(g), g["p"].id, kind="ADVANCE", amount="500", invoice_date=TODAY)
    assert codes(e) == "over_billing"
    s0 = bl.billing_summary(g["p"].id)
    assert s0["billed"] == "600.0000" and s0["recognized"] == "0" and s0["remaining"] == "400.0000"
    post_invoice(g, b.invoice_id)
    assert bl.billing_summary(g["p"].id)["recognized"] == "600.0000"


@pytest.mark.django_db
def test_time_and_material_billing_uses_approved_hours_and_blocks_double_billing(g):
    pe = g["people"]
    billable(g, "TIME_MATERIAL")
    svc.update_member(uid(g), g["p"].id, pe["dev"].id, bill_rate=50)
    activate(g)
    employee_time(g, "dev", 8, g["p"].code)  # 16 h on 16 and 17 March
    pv = bl.time_billing_preview(g["p"].id, date(2026, 3, 1), date(2026, 3, 31))
    assert pv["amount"] == D("800")
    b = bl.invoice_project(uid(g), g["p"].id, kind="TIME", invoice_date=TODAY, period_start=date(2026, 3, 1), period_end=date(2026, 3, 31))
    assert b.amount == D("800")
    with pytest.raises(DomainError) as e:
        bl.invoice_project(uid(g), g["p"].id, kind="TIME", invoice_date=TODAY, period_start=date(2026, 3, 15), period_end=date(2026, 4, 15))
    assert codes(e) == "already_pending"
    with pytest.raises(DomainError) as e:
        bl.invoice_project(uid(g), g["p"].id, kind="TIME", invoice_date=TODAY, period_start=date(2026, 5, 1), period_end=date(2026, 5, 31))
    assert codes(e) == "nothing_to_bill"
    with pytest.raises(DomainError) as e:
        bl.invoice_project(uid(g), g["p"].id, kind="MILESTONE", amount="1", invoice_date=TODAY)
    assert codes(e) == "not_billable"


@pytest.mark.django_db
def test_non_billable_and_unauthorised_billing_are_refused(g):
    activate(g)
    with pytest.raises(DomainError) as e:
        bl.invoice_project(uid(g), g["p"].id, kind="ADVANCE", amount="10", invoice_date=TODAY)
    assert codes(e) == "not_billable"
    billable(g)
    with pytest.raises(DomainError) as e:
        bl.invoice_project(g["people"]["dev"].id, g["p"].id, kind="ADVANCE", amount="10", invoice_date=TODAY)
    assert codes(e) == "forbidden"


@pytest.mark.django_db
def test_profitability_combines_revenue_and_cost(g):
    pe = g["people"]
    billable(g)
    budget(g, labor="1000", travel="500")
    activate(g)
    t = tk.create_task(uid(g), g["p"].id, name="Work", planned_start=S, planned_end=S + timedelta(days=10), planned_hours=40, assignee_id=pe["dev"].id)
    tk.update_progress(pe["dev"].id, t.id, percent=50)
    employee_time(g, "dev", 8, g["p"].code)  # AC 320
    b = bl.invoice_project(uid(g), g["p"].id, kind="ADVANCE", amount="400", invoice_date=TODAY)
    post_invoice(g, b.invoice_id)
    r = rp.profitability(g["p"].id, today=S + timedelta(days=60))
    assert D(r["revenue_recognized"]) == 400 and D(r["actual_cost"]) == 320 and D(r["margin"]) == 80 and r["margin_percent"] == "20.00"
    assert D(r["under_billed"]) == D("100")  # earned 50% of 1000, billed 400... 500-400
    assert D(r["forecast"]["revenue"]) == 1000


@pytest.mark.django_db
def test_health_and_portfolio(g):
    pe = g["people"]
    budget(g, labor="1000")
    activate(g)
    assert rp.health(g["p"].id, today=S + timedelta(days=1))["rag"] == "GREEN"
    done = tk.create_task(uid(g), g["p"].id, name="Done", planned_start=S, planned_end=S + timedelta(days=5), planned_hours=10, assignee_id=pe["dev"].id)
    tk.create_task(uid(g), g["p"].id, name="Late", planned_start=S, planned_end=S + timedelta(days=5), planned_hours=10, assignee_id=pe["dev"].id)
    tk.update_progress(pe["dev"].id, done.id, percent=100)
    h = rp.health(g["p"].id, today=S + timedelta(days=20))
    assert h["rag"] == "AMBER" and "OVERDUE_TASKS" in h["reasons"]
    rk.raise_issue(uid(g), g["p"].id, title="Stopper", severity="CRITICAL")
    h = rp.health(g["p"].id, today=S + timedelta(days=20))
    assert h["rag"] == "RED" and "CRITICAL_ISSUE" in h["reasons"]
    pf = rp.portfolio(uid(g), today=S + timedelta(days=20))
    assert pf["rag"]["RED"] == 1 and pf["projects"][0]["margin"] is not None
    member_view = rp.portfolio(pe["dev"].id, today=S + timedelta(days=20))
    assert "margin" not in member_view["projects"][0]  # members do not see profitability
    assert rp.portfolio(pe["outsider"].id)["projects"] == []


@pytest.mark.django_db
def test_daily_job_reminds_once_a_week(g):
    pe = g["people"]
    activate(g)
    tk.create_task(uid(g), g["p"].id, name="Late", planned_start=S, planned_end=S + timedelta(days=5), assignee_id=pe["dev"].id)
    rk.raise_risk(uid(g), g["p"].id, title="Review me", probability=2, impact=2, review_on=S)
    day = E + timedelta(days=1)  # past the project end, so the project itself is flagged too
    first = jobs.run_daily(day)
    assert first == {"overdue_reminders": 2, "register_reminders": 1}
    assert jobs.run_daily(day) == {"overdue_reminders": 0, "register_reminders": 0}
    assert jobs.run_daily(day + timedelta(days=8))["overdue_reminders"] == 2


@pytest.mark.django_db
def test_http_permissions(api_env):
    env, api = api_env
    pid = str(env["p"].id)
    assert api["dev"].post(f"/api/v1/projects/projects/{pid}/risks", {"title": "R", "probability": 2, "impact": 2}).status_code == 201
    assert api["outsider"].post(f"/api/v1/projects/projects/{pid}/risks", {"title": "R", "probability": 2, "impact": 2}).status_code == 404
    assert api["auditor"].post(f"/api/v1/projects/projects/{pid}/risks", {"title": "R", "probability": 2, "impact": 2}).status_code == 404  # read-only access never lets you write
    assert api["dev"].get(f"/api/v1/projects/projects/{pid}/profitability").status_code == 403
    assert api["dev"].post(f"/api/v1/projects/projects/{pid}/billing", {"kind": "ADVANCE", "amount": "5"}).status_code == 403
    assert api["pm"].post(f"/api/v1/projects/projects/{pid}/billing", {"kind": "ADVANCE", "amount": "5"}).status_code == 409  # not billable (no customer)
    assert api["pm"].get(f"/api/v1/projects/projects/{pid}/health").status_code == 200
    assert api["auditor"].get("/api/v1/projects/portfolio").status_code == 200
    assert api["outsider"].get("/api/v1/projects/portfolio").json()["projects"] == []
