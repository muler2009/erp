import uuid
from datetime import date, timedelta
from decimal import Decimal as D

import pytest
from django.utils import timezone
from django_tenants.utils import schema_context

from modules.hr import services as hr
from modules.projects import costs as cs
from modules.projects import models as pm
from modules.projects import resources as rs
from modules.projects import services as svc
from modules.projects import wbs as tk
from modules.finance import models as fm
from modules.finance import services as fin
from shared.api.errors import DomainError, ValidationFailed
from tests.test_finance import posted_invoice, prepare, user
from tests.test_projects_wbs import S, E, api_env, codes, f, uid  # noqa: F401

TODAY = timezone.now().date()


@pytest.fixture
def g(f, acme):
    from platform_core.tenants.models import Tenant

    tenant = Tenant.objects.get(pk=acme["id"])
    env = prepare(tenant)
    f["fin_env"] = env
    f["people"]["fin"] = env["people"]["ctrl"]  # finance controller: holds projects.budget.approve
    f["people"]["am_"] = user(tenant, "pam@acme.test", "asset_manager")
    f["people"]["am2"] = user(tenant, "pam2@acme.test", "asset_manager")
    return f


def gl(code):
    return fin.account_balance(fm.Account.objects.get(code=code))


def budget(g, **amounts):
    lines = [{"category": k.upper(), "amount": v} for k, v in (amounts or {"labor": "1000", "travel": "500"}).items()]
    b = cs.create_budget(uid(g), g["p"].id, lines)
    cs.submit_budget(uid(g), b.id)
    return cs.decide_budget(g["people"]["fin"].id, b.id, approve=True)


def activate(g):
    svc.set_status(uid(g), g["p"].id, "ACTIVE")


@pytest.mark.django_db
def test_budget_approval_by_finance_and_revisions(g):
    pe = g["people"]
    b = cs.create_budget(uid(g), g["p"].id, [{"category": "LABOR", "amount": "1000"}])
    with pytest.raises(DomainError) as e:
        cs.create_budget(uid(g), g["p"].id, [{"category": "LABOR", "amount": "1"}])
    assert codes(e) == "already_pending"
    with pytest.raises(ValidationFailed) as e:
        cs.replace_lines(uid(g), b.id, [{"category": "LABOR", "amount": "5"}, {"category": "LABOR", "amount": "5"}])
    assert codes(e) == "duplicate_category"
    cs.submit_budget(uid(g), b.id)
    with pytest.raises(DomainError) as e:
        cs.decide_budget(uid(g), b.id, approve=True)
    assert codes(e) == "forbidden"  # the manager cannot approve their own budget
    ok = cs.decide_budget(pe["fin"].id, b.id, approve=True)
    assert ok.status == "APPROVED"
    with pytest.raises(ValidationFailed) as e:
        cs.create_budget(uid(g), g["p"].id, [{"category": "LABOR", "amount": "2000"}])
    assert codes(e) == "reason_required"
    r2 = cs.create_budget(uid(g), g["p"].id, [{"category": "LABOR", "amount": "2000"}], reason="Scope grew")
    cs.submit_budget(uid(g), r2.id)
    cs.decide_budget(pe["fin"].id, r2.id, approve=True)
    b.refresh_from_db()
    assert b.status == "SUPERSEDED" and cs.approved_budget(g["p"].id).revision == 2


@pytest.mark.django_db
def test_budget_submitter_cannot_approve_even_with_permission(g):
    pe = g["people"]
    svc.add_member(uid(g), g["p"].id, pe["fin"].id, role="MEMBER")
    b = cs.create_budget(uid(g), g["p"].id, [{"category": "LABOR", "amount": "10"}])
    cs.submit_budget(uid(g), b.id)
    with pytest.raises(DomainError) as e:
        cs.decide_budget(pe["fin"].id, b.id, approve=False)
    assert codes(e) == "reason_required"
    assert cs.decide_budget(pe["fin"].id, b.id, approve=False, note="Too vague").status == "REJECTED"


@pytest.mark.django_db
def test_expense_flow_limits_sod_budget_and_journal(g):
    pe = g["people"]
    budget(g, labor="1000", travel="500")
    with pytest.raises(DomainError) as e:
        cs.submit_expense(pe["dev"].id, g["p"].id, category="TRAVEL", description="Flight", amount="100", incurred_on=TODAY)
    assert codes(e) == "project_not_active"
    activate(g)
    with pytest.raises(ValidationFailed) as e:
        cs.submit_expense(pe["dev"].id, g["p"].id, category="LABOR", description="x", amount="10", incurred_on=TODAY)
    assert codes(e) == "invalid_category"
    with pytest.raises(DomainError):
        cs.submit_expense(pe["outsider"].id, g["p"].id, category="TRAVEL", description="x", amount="10", incurred_on=TODAY)
    e1 = cs.submit_expense(pe["dev"].id, g["p"].id, category="TRAVEL", description="Flight", amount="400", incurred_on=TODAY)
    with pytest.raises(DomainError) as e:
        cs.decide_expense(pe["dev"].id, e1.id, approve=True)
    assert codes(e) == "forbidden"
    approved = cs.decide_expense(uid(g), e1.id, approve=True)
    assert approved.status == "APPROVED" and gl("5800") == D("400") and abs(gl("2250")) == D("400")
    e2 = cs.submit_expense(pe["dev"].id, g["p"].id, category="TRAVEL", description="Hotel", amount="200", incurred_on=TODAY)
    with pytest.raises(DomainError) as e:
        cs.decide_expense(uid(g), e2.id, approve=True)
    assert codes(e) == "budget_exceeded"
    assert cs.decide_expense(uid(g), e2.id, approve=False, note="Over budget").status == "REJECTED"
    e3 = cs.submit_expense(pe["dev"].id, g["p"].id, category="TRAVEL", description="Team trip", amount="80", incurred_on=TODAY)
    assert cs.decide_expense(uid(g), e3.id, approve=True).status == "APPROVED"
    with pytest.raises(ValidationFailed):
        cs.submit_expense(pe["dev"].id, g["p"].id, category="TRAVEL", description="future", amount="1", incurred_on=TODAY + timedelta(days=2))


@pytest.mark.django_db
def test_expense_above_limit_needs_budget_approver_and_manager_cannot_self_approve(g):
    pe = g["people"]
    budget(g, labor="1000", material="50000")
    activate(g)
    e = cs.submit_expense(pe["dev"].id, g["p"].id, category="MATERIAL", description="Cement", amount="5000", incurred_on=TODAY)
    with pytest.raises(DomainError) as ex:
        cs.decide_expense(uid(g), e.id, approve=True)
    assert codes(ex) == "approval_limit_exceeded"
    svc.add_member(uid(g), g["p"].id, pe["fin"].id, role="OBSERVER")
    assert cs.decide_expense(pe["fin"].id, e.id, approve=True).status == "APPROVED"
    own = cs.submit_expense(uid(g), g["p"].id, category="OTHER", description="Own", amount="10", incurred_on=TODAY)
    with pytest.raises(DomainError) as ex:
        cs.decide_expense(uid(g), own.id, approve=True)
    assert codes(ex) == "separation_of_duties"
    with pytest.raises(DomainError) as ex:
        svc.set_status(uid(g), g["p"].id, "COMPLETED")  # tasks open? none; pending expense blocks
    assert codes(ex) == "expenses_pending"


@pytest.mark.django_db
def test_invoice_backed_expense_posts_nothing_and_cannot_overallocate(g, acme):
    pe = g["people"]
    activate(g)
    invoice = posted_invoice(g["fin_env"], kind="SUPPLIER_INVOICE", price="300", tax=False)
    before = gl("5800")
    e = cs.submit_expense(pe["dev"].id, g["p"].id, category="SUBCONTRACT", description="Welding", amount="200", incurred_on=TODAY, invoice_id=invoice.id)
    assert cs.decide_expense(uid(g), e.id, approve=True).journal_entry_id is None and gl("5800") == before
    with pytest.raises(DomainError) as ex:
        cs.submit_expense(pe["dev"].id, g["p"].id, category="SUBCONTRACT", description="More", amount="150", incurred_on=TODAY, invoice_id=invoice.id)
    assert codes(ex) == "invoice_over_allocated"


def employee_time(g, key, hours, project_code, approve=True):
    pe = g["people"]
    emp = hr.create_employee(None, first_name=key, last_name="T", hire_date=date(2026, 1, 1), user_id=pe[key].id)
    wk = date(2026, 3, 16)
    rows = [{"work_date": wk + timedelta(days=i), "hours": str(hours), "project_ref": project_code} for i in range(2)]
    ts = hr.save_timesheet(pe[key].id, emp.id, wk, rows)
    hr.submit_timesheet(pe[key].id, ts.id)
    if approve:
        hr.decide_timesheet(pe["owner"].id, ts.id, approve=True)
    return emp


@pytest.mark.django_db
def test_time_cost_uses_approved_hours_and_member_rates(g):
    pe = g["people"]
    employee_time(g, "dev", 8, g["p"].code)  # 16h at rate 20
    employee_time(g, "dev2", 4, g["p"].code, approve=False)  # not approved: ignored
    employee_time(g, "outsider", 5, g["p"].code)  # not a member: unmatched, no cost
    t = cs.time_cost(g["p"].id)
    assert t["hours"] == 16 and t["cost"] == D("320") and t["unmatched_hours"] == 10
    assert cs.time_cost(g["p"].id, date_from=date(2026, 3, 17))["hours"] == 8


@pytest.mark.django_db
def test_cost_report_earned_value(g):
    pe = g["people"]
    budget(g, labor="1000", travel="500")
    activate(g)
    t1 = tk.create_task(uid(g), g["p"].id, name="A", planned_start=S, planned_end=S + timedelta(days=10), planned_hours=20, assignee_id=pe["dev"].id)
    tk.create_task(uid(g), g["p"].id, name="B", planned_start=S, planned_end=S + timedelta(days=10), planned_hours=20, assignee_id=pe["dev"].id)
    tk.update_progress(pe["dev"].id, t1.id, percent=100)
    employee_time(g, "dev", 8, g["p"].code)  # AC labour 320
    r = cs.cost_report(g["p"].id, today=S + timedelta(days=60))
    ev = r["earned_value"]
    assert r["has_approved_budget"] and D(r["totals"]["actual"]) == 320 and D(ev["percent_complete"]) == 50
    assert D(ev["ev"]) == D("750") and D(ev["cpi"]) == D("2.34") and D(r["rows"][0]["planned"]) == D("800")
    assert D(ev["eac"]) > 0 and D(ev["bac"]) == D("1500")


@pytest.mark.django_db
def test_allocation_cannot_exceed_100_percent_across_projects(g):
    pe = g["people"]
    other = svc.create_project(pe["pm2"].id, name="Other", start_on=S, end_on=E)
    with pytest.raises(DomainError) as e:
        svc.add_member(pe["pm2"].id, other.id, pe["dev"].id, allocation_percent=60)  # already 100% on the first project
    assert codes(e) == "over_allocated"
    svc.update_member(uid(g), g["p"].id, pe["dev"].id, allocation_percent=40)
    svc.add_member(pe["pm2"].id, other.id, pe["dev"].id, allocation_percent=60)
    with pytest.raises(DomainError) as e:
        svc.update_member(uid(g), g["p"].id, pe["dev"].id, allocation_percent=60)
    assert codes(e) == "over_allocated"
    rows = {r["user_id"]: r for r in rs.resource_load(S, S + timedelta(days=27))}
    assert rows[str(pe["dev"].id)]["allocation_percent"] == "100.00" and set(rows[str(pe["dev"].id)]["projects"]) == {g["p"].code, other.code}


@pytest.mark.django_db
def test_asset_allocation_to_project_is_validated(g):
    from modules.assets import allocation as al
    from modules.assets import services as asvc
    from tests.test_assets import activate as act_asset

    cat = asvc.create_category(None, code="EQ", name="Equipment", asset_class="EQUIPMENT", capitalization_threshold="500", useful_life_months=36, residual_percent="10")
    loc = asvc.create_location(None, code="SITE", name="Site")
    env = {"people": g["people"], "cat": cat, "loc": loc}
    a = asvc.create_asset(g["people"]["am_"].id, category_id=cat.id, name="Excavator", purchase_cost="5000", location_id=loc.id)
    act_asset(env, a, cost="5000")
    with pytest.raises(ValidationFailed) as e:
        al.allocate(g["people"]["am_"].id, a.id, target_kind="PROJECT", target_id=uuid.uuid4(), start_on=TODAY)
    assert codes(e) == "invalid_target"
    row = al.allocate(g["people"]["am_"].id, a.id, target_kind="PROJECT", target_id=g["p"].id, start_on=TODAY)
    assert row.target_id == g["p"].id
    svc.set_status(uid(g), g["p"].id, "CANCELLED", reason="Dropped")
    with pytest.raises(ValidationFailed):
        al.allocate(g["people"]["am_"].id, a.id, target_kind="PROJECT", target_id=g["p"].id, start_on=TODAY, share_percent=10)


@pytest.mark.django_db
def test_http_cost_visibility_and_permissions(api_env):
    env, api = api_env
    pid = str(env["p"].id)
    assert api["dev"].get(f"/api/v1/projects/projects/{pid}/cost-report").status_code == 403  # members don't see costs
    assert api["pm"].get(f"/api/v1/projects/projects/{pid}/cost-report").status_code == 200
    assert api["auditor"].get(f"/api/v1/projects/projects/{pid}/cost-report").status_code == 200
    assert api["outsider"].get(f"/api/v1/projects/projects/{pid}/cost-report").status_code == 404
    assert api["pm"].post(f"/api/v1/projects/projects/{pid}/budgets", {"lines": [{"category": "LABOR", "amount": "100"}]}).status_code == 201
    assert api["dev"].post(f"/api/v1/projects/projects/{pid}/budgets", {"lines": [{"category": "LABOR", "amount": "100"}]}).status_code == 403
    assert api["pm"].get("/api/v1/projects/resource-load?from=2026-03-02&to=2026-03-30").status_code == 403
    assert api["auditor"].get("/api/v1/projects/resource-load?from=2026-03-02&to=2026-03-30").status_code == 200
    assert api["auditor"].get("/api/v1/projects/resource-load").status_code == 400
