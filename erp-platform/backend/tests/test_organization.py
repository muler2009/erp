import uuid
from datetime import date
from decimal import Decimal

import pytest
from django.db import IntegrityError, transaction
from django_tenants.utils import schema_context

from platform_core.authorization.models import RoleDefinition
from platform_core.organizations import models as m
from platform_core.organizations import services as org
from platform_core.tenants.models import Tenant
from platform_core.users.models import TenantMembership
from shared.api.errors import DomainError, ValidationFailed
from tests.conftest import ACME_HOST, GLOBEX_HOST, Api, invite_token_from_mail


def code_of(response):
    return response.json()["error"]["code"]


@pytest.fixture
def member_factory(world, idp, owner_api, commit, acme):
    def build(email, sub, roles=()):
        from django.core import mail

        with schema_context(acme["schema"]):
            ids = [str(RoleDefinition.objects.get(name=n).id) for n in roles]
        mail.outbox = []
        with commit():
            response = owner_api.post("/api/v1/users/invite", {"email": email, "display_name": email.split("@")[0], "role_ids": ids})
        assert response.status_code == 201, response.content
        api = Api(ACME_HOST)
        assert api.login(idp, sub, invite=invite_token_from_mail()).status_code == 302
        return api, TenantMembership.objects.get(user__email=email)

    return build


def dept(api, code, name=None, **extra):
    return api.post("/api/v1/org/departments", {"code": code, "name": name or code, **extra})


# ------------------------------------------------------------------------- seeding
@pytest.mark.django_db
def test_new_tenants_are_seeded(owner_api):
    company = owner_api.get("/api/v1/org/company").json()
    assert company["legal_name"] == "Acme Ltd" and company["base_currency"] is None
    currencies = owner_api.get("/api/v1/org/currencies").json()["results"]
    assert {"USD", "EUR", "ETB"} <= {c["code"] for c in currencies}
    assert not any(c["is_active"] for c in currencies)  # tenant decides what to enable (jurisdiction-neutral)


# ------------------------------------------------------------------------- departments (tree rules)
@pytest.mark.django_db
def test_department_crud_and_hierarchy_rules(owner_api):
    root = dept(owner_api, "hq", "Headquarters")
    assert root.status_code == 201 and root.json()["code"] == "HQ"  # codes are normalized
    root_id = root.json()["id"]
    assert code_of(dept(owner_api, "HQ")) == "code_taken"
    assert code_of(dept(owner_api, "bad code!")) == "invalid_code"

    child = dept(owner_api, "fin", "Finance", parent=root_id).json()
    grandchild = dept(owner_api, "ap", "Payables", parent=child["id"]).json()
    # moving a department under its own descendant is a cycle
    cycle = owner_api.patch(f"/api/v1/org/departments/{root_id}", {"parent": grandchild["id"]})
    assert cycle.status_code == 400 and code_of(cycle) == "department_cycle"
    assert owner_api.patch(f"/api/v1/org/departments/{child['id']}", {"parent": child["id"]}).status_code == 400
    assert owner_api.patch(f"/api/v1/org/departments/{root_id}", {"name": "HQ Renamed"}).json()["name"] == "HQ Renamed"

    # depth limit
    parent = grandchild["id"]
    for i in range(org.MAX_DEPARTMENT_DEPTH):
        response = dept(owner_api, f"d{i}", parent=parent)
        if response.status_code != 201:
            assert code_of(response) == "department_too_deep"
            break
        parent = response.json()["id"]
    else:
        pytest.fail("depth limit not enforced")


@pytest.mark.django_db
def test_optimistic_locking_rejects_stale_updates(owner_api):
    created = dept(owner_api, "ops").json()
    first = owner_api.patch(f"/api/v1/org/departments/{created['id']}", {"name": "Ops 2", "version": created["version"]})
    assert first.status_code == 200 and first.json()["version"] == created["version"] + 1
    stale = owner_api.patch(f"/api/v1/org/departments/{created['id']}", {"name": "Ops 3", "version": created["version"]})
    assert stale.status_code == 409 and code_of(stale) == "version_conflict"


@pytest.mark.django_db
def test_deactivation_guards(owner_api, member_factory):
    parent = dept(owner_api, "p1").json()
    dept(owner_api, "c1", parent=parent["id"])
    refused = owner_api.patch(f"/api/v1/org/departments/{parent['id']}", {"is_active": False})
    assert refused.status_code == 409 and code_of(refused) == "has_active_children"

    sales = dept(owner_api, "sales").json()
    team = owner_api.post("/api/v1/org/teams", {"code": "t1", "name": "Team 1", "department": sales["id"]}).json()
    assert code_of(owner_api.patch(f"/api/v1/org/departments/{sales['id']}", {"is_active": False})) == "has_active_dependents"
    owner_api.patch(f"/api/v1/org/teams/{team['id']}", {"is_active": False})
    assert owner_api.patch(f"/api/v1/org/departments/{sales['id']}", {"is_active": False}).status_code == 200
    # inactive references cannot be used
    assert owner_api.post("/api/v1/org/teams", {"code": "t2", "name": "T2", "department": sales["id"]}).status_code == 400


@pytest.mark.django_db
def test_department_head_must_be_an_active_member(owner_api, member_factory, globex, acme):
    member, membership = member_factory("head@acme.test", "head-sub", ["employee"])
    ok = dept(owner_api, "hd", head_user_id=str(membership.user_id))
    assert ok.status_code == 201
    stranger = dept(owner_api, "hd2", head_user_id=str(uuid.uuid4()))
    assert stranger.status_code == 400 and code_of(stranger) == "not_an_active_member"
    other_tenant_owner = dept(owner_api, "hd3", head_user_id=str(globex["owner_user_id"]))  # member of globex, not acme
    assert other_tenant_owner.status_code == 400


# ------------------------------------------------------------------------- permissions & isolation
@pytest.mark.django_db
def test_org_permissions_and_cross_tenant_isolation(owner_api, member_factory, idp, globex):
    dept_id = dept(owner_api, "iso").json()["id"]
    employee, _ = member_factory("e@acme.test", "e-sub", ["employee"])
    assert employee.get("/api/v1/org/departments").status_code == 403
    assert employee.post("/api/v1/org/departments", {"code": "X", "name": "x"}).status_code == 403
    auditor, _ = member_factory("a@acme.test", "a-sub", ["read_only_auditor"])
    assert auditor.get("/api/v1/org/departments").status_code == 200
    assert auditor.post("/api/v1/org/departments", {"code": "X", "name": "x"}).status_code == 403
    assert auditor.get("/api/v1/settings").status_code == 403

    globex_api = Api(GLOBEX_HOST)
    assert globex_api.login(idp, globex["owner_sub"]).status_code == 302
    assert globex_api.get(f"/api/v1/org/departments/{dept_id}").status_code == 404  # other tenant's id does not resolve
    assert dept_id not in [d["id"] for d in globex_api.get("/api/v1/org/departments").json()["results"]]


@pytest.mark.django_db
def test_org_changes_are_audited(owner_api):
    dept(owner_api, "aud")
    actions = [e["action"] for e in owner_api.get("/api/v1/audit-events").json()["results"]]
    assert "org.department.created" in actions


# ------------------------------------------------------------------------- company, currencies, rates
@pytest.mark.django_db
def test_company_and_base_currency_rules(owner_api):
    usd = [c for c in owner_api.get("/api/v1/org/currencies").json()["results"] if c["code"] == "USD"][0]
    updated = owner_api.patch("/api/v1/org/company", {"legal_name": "Acme Holdings", "base_currency": usd["id"], "work_days": [1, 2, 3, 4, 5, 6]})
    assert updated.status_code == 200 and updated.json()["base_currency"] == usd["id"]
    assert any(c["code"] == "USD" and c["is_active"] for c in owner_api.get("/api/v1/org/currencies").json()["results"])  # activated on use
    assert owner_api.patch("/api/v1/org/company", {"work_days": [0, 9]}).status_code == 400
    assert owner_api.patch("/api/v1/org/company", {"fiscal_year_start_month": 13}).status_code == 400
    locked = owner_api.patch("/api/v1/org/currencies/USD", {"is_active": False})
    assert locked.status_code == 409 and code_of(locked) == "base_currency_locked"


@pytest.mark.django_db
def test_exchange_rates(owner_api, acme):
    assert code_of(owner_api.post("/api/v1/org/exchange-rates", {"currency": "EUR", "rate_date": "2026-01-01", "rate": "1.1"})) == "base_currency_required"
    usd = [c for c in owner_api.get("/api/v1/org/currencies").json()["results"] if c["code"] == "USD"][0]
    owner_api.patch("/api/v1/org/company", {"base_currency": usd["id"]})
    assert code_of(owner_api.post("/api/v1/org/exchange-rates", {"currency": "EUR", "rate_date": "2026-01-01", "rate": "1.1"})) == "inactive_reference"
    owner_api.patch("/api/v1/org/currencies/EUR", {"is_active": True})
    assert owner_api.post("/api/v1/org/exchange-rates", {"currency": "EUR", "rate_date": "2026-01-01", "rate": "1.10000000"}).status_code == 201
    assert owner_api.post("/api/v1/org/exchange-rates", {"currency": "EUR", "rate_date": "2026-02-01", "rate": "1.25"}).status_code == 201
    assert owner_api.post("/api/v1/org/exchange-rates", {"currency": "EUR", "rate_date": "2026-03-01", "rate": "0"}).status_code in (400,)
    assert code_of(owner_api.post("/api/v1/org/exchange-rates", {"currency": "USD", "rate_date": "2026-01-01", "rate": "1"})) == "base_currency_rate"
    assert code_of(owner_api.post("/api/v1/org/exchange-rates", {"currency": "EUR", "rate_date": "2999-01-01", "rate": "1.2"})) == "invalid_date"

    with schema_context(acme["schema"]):  # latest rate on or before the date; Decimal arithmetic only
        assert org.get_rate("EUR", date(2026, 1, 15)) == Decimal("1.10000000")
        assert org.get_rate("EUR", date(2026, 2, 1)) == Decimal("1.25000000")
        assert org.get_rate("USD", date(2026, 2, 1)) == 1
        assert org.convert_to_base("100.10", "EUR", date(2026, 1, 15)) == Decimal("110.11")
        with pytest.raises(DomainError) as exc:
            org.get_rate("EUR", date(2025, 12, 31))
        assert exc.value.detail.code == "rate_not_found"
    # the base currency cannot change once rates exist
    eur = [c for c in owner_api.get("/api/v1/org/currencies").json()["results"] if c["code"] == "EUR"][0]
    assert code_of(owner_api.patch("/api/v1/org/company", {"base_currency": eur["id"]})) == "base_currency_locked"
    with pytest.raises(IntegrityError):  # database-level rate > 0
        with transaction.atomic(), schema_context(acme["schema"]):
            m.ExchangeRate.objects.create(currency=m.Currency.objects.get(code="EUR"), rate_date=date(2026, 5, 1), rate=Decimal("-1"))


# ------------------------------------------------------------------------- fiscal calendar
@pytest.mark.django_db
def test_fiscal_years_and_controlled_period_closing(owner_api, acme, member_factory):
    year = owner_api.post("/api/v1/org/fiscal-years", {"name": "FY2026", "start_date": "2026-01-01"})
    assert year.status_code == 201
    periods = year.json()["periods"]
    assert len(periods) == 12 and periods[0]["start_date"] == "2026-01-01" and periods[11]["end_date"] == "2026-12-31"
    assert periods[1]["start_date"] == "2026-02-01" and periods[1]["end_date"] == "2026-02-28"
    assert code_of(owner_api.post("/api/v1/org/fiscal-years", {"name": "FYX", "start_date": "2026-03-01"})) == "fiscal_year_gap"
    assert code_of(owner_api.post("/api/v1/org/fiscal-years", {"name": "FYX", "start_date": "2028-01-01"})) == "fiscal_year_gap"
    assert code_of(owner_api.post("/api/v1/org/fiscal-years", {"name": "FYX", "start_date": "2027-01-15"})) == "invalid_start"
    assert owner_api.post("/api/v1/org/fiscal-years", {"name": "FY2027", "start_date": "2027-01-01"}).status_code == 201

    p1, p2, p3 = periods[0]["id"], periods[1]["id"], periods[2]["id"]
    assert code_of(owner_api.post(f"/api/v1/org/fiscal-periods/{p2}/close")) == "earlier_period_open"  # must close in order
    assert owner_api.post(f"/api/v1/org/fiscal-periods/{p1}/close").json()["status"] == "CLOSED"
    assert code_of(owner_api.post(f"/api/v1/org/fiscal-periods/{p1}/close")) == "invalid_state_transition"
    assert owner_api.post(f"/api/v1/org/fiscal-periods/{p2}/close").status_code == 200
    # only the latest closed period can be reopened, and only with a reason
    assert code_of(owner_api.post(f"/api/v1/org/fiscal-periods/{p1}/reopen", {"reason": "needs correction now"})) == "later_period_closed"
    assert owner_api.post(f"/api/v1/org/fiscal-periods/{p2}/reopen", {"reason": "short"}).status_code == 400
    assert owner_api.post(f"/api/v1/org/fiscal-periods/{p2}/reopen", {"reason": "late supplier invoice found"}).json()["status"] == "OPEN"

    with schema_context(acme["schema"]):  # the posting guard other modules rely on
        assert org.assert_period_open(date(2026, 2, 10)).name == "FY2026-P02"
        with pytest.raises(DomainError) as closed:
            org.assert_period_open(date(2026, 1, 10))
        assert closed.value.detail.code == "period_closed"
        with pytest.raises(DomainError) as none:
            org.assert_period_open(date(2030, 1, 1))
        assert none.value.detail.code == "no_fiscal_period"

    # a module can veto closing (e.g. unposted journals)
    def veto(period):
        raise DomainError("Unposted journals exist.", code="unposted_entries")

    org.PERIOD_CLOSE_CHECKS.append(veto)
    try:
        assert code_of(owner_api.post(f"/api/v1/org/fiscal-periods/{p2}/close")) == "unposted_entries"
    finally:
        org.PERIOD_CLOSE_CHECKS.remove(veto)

    accountant, _ = member_factory("acct@acme.test", "acct-sub", ["finance_manager"])
    assert accountant.post(f"/api/v1/org/fiscal-periods/{p3}/close").status_code == 403  # org.fiscal.close is not a finance role perm
    actions = [e["action"] for e in owner_api.get("/api/v1/audit-events").json()["results"]]
    assert "org.period.closed" in actions and "org.period.reopened" in actions


# ------------------------------------------------------------------------- calendar
@pytest.mark.django_db
def test_business_calendar(owner_api, acme):
    assert owner_api.post("/api/v1/org/holidays", {"holiday_date": "2026-01-07", "name": "Holiday"}).status_code == 201
    assert code_of(owner_api.post("/api/v1/org/holidays", {"holiday_date": "2026-01-07", "name": "Dup"})) == "holiday_exists"
    with schema_context(acme["schema"]):
        assert not org.is_business_day(date(2026, 1, 3))  # Saturday (default Mon-Fri)
        assert not org.is_business_day(date(2026, 1, 7))  # holiday
        assert org.is_business_day(date(2026, 1, 8))
        assert org.add_business_days(date(2026, 1, 6), 2) == date(2026, 1, 9)  # skips the 7th
        assert org.add_business_days(date(2026, 1, 9), -1) == date(2026, 1, 8)


# ------------------------------------------------------------------------- member profiles
@pytest.mark.django_db
def test_member_profiles(owner_api, member_factory):
    e1, m1 = member_factory("p1@acme.test", "p1-sub", ["employee"])
    e2, m2 = member_factory("p2@acme.test", "p2-sub", ["employee"])
    d = dept(owner_api, "eng").json()
    other = dept(owner_api, "ops2").json()
    t = owner_api.post("/api/v1/org/teams", {"code": "core", "name": "Core", "department": d["id"]}).json()
    pos = owner_api.post("/api/v1/org/positions", {"code": "dev", "title": "Developer", "department": d["id"]}).json()

    response = owner_api.put(f"/api/v1/org/members/{m1.user_id}/profile", {"department": d["id"], "team": t["id"], "position": pos["id"], "manager_user_id": str(m2.user_id)})
    assert response.status_code == 200, response.content
    assert code_of(owner_api.put(f"/api/v1/org/members/{m1.user_id}/profile", {"department": other["id"], "team": t["id"]})) == "team_department_mismatch"
    assert code_of(owner_api.put(f"/api/v1/org/members/{m1.user_id}/profile", {"manager_user_id": str(m1.user_id)})) == "self_manager"
    cycle = owner_api.put(f"/api/v1/org/members/{m2.user_id}/profile", {"manager_user_id": str(m1.user_id)})
    assert cycle.status_code == 400 and code_of(cycle) == "management_cycle"
    assert code_of(owner_api.put(f"/api/v1/org/members/{uuid.uuid4()}/profile", {"department": d["id"]})) == "not_an_active_member"
    assert e1.put(f"/api/v1/org/members/{m1.user_id}/profile", {"department": d["id"]}).status_code == 403
    # a department that still has members cannot be deactivated
    assert code_of(owner_api.patch(f"/api/v1/org/departments/{d['id']}", {"is_active": False})) in ("has_active_dependents", "has_members")
    members = owner_api.get("/api/v1/org/members").json()
    assert any(x["profile"] and x["profile"]["department"] == d["id"] for x in members)


# ------------------------------------------------------------------------- settings
@pytest.mark.django_db
def test_tenant_settings_are_validated(owner_api):
    assert owner_api.get("/api/v1/settings").json()["workflow.default_due_hours"] == 72
    ok = owner_api.put("/api/v1/settings", {"workflow.default_due_hours": 48, "notifications.email_enabled": False})
    assert ok.status_code == 200 and ok.json()["workflow.default_due_hours"] == 48
    assert code_of(owner_api.put("/api/v1/settings", {"nope": 1})) == "unknown_setting"
    assert code_of(owner_api.put("/api/v1/settings", {"workflow.default_due_hours": "soon"})) == "invalid_setting"
    assert code_of(owner_api.put("/api/v1/settings", {"workflow.default_due_hours": True})) == "invalid_setting"
    assert owner_api.get("/api/v1/settings").json()["workflow.default_due_hours"] == 48  # failed update changed nothing
