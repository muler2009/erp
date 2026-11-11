import uuid
from datetime import date
from decimal import Decimal as D

import pytest
from django_tenants.utils import schema_context

from modules.assets import allocation as al
from modules.assets import depreciation as dp
from modules.assets import disposal as ds
from modules.assets import maintenance as mt
from modules.assets import models as am
from modules.assets import services as svc
from modules.assets import verification as vf
from modules.finance import models as fm
from modules.finance import services as fin
from shared.api.errors import DomainError, ValidationFailed
from tests.test_assets import activate, api_env, f, laptop  # noqa: F401

TODAY = date.today()


def codes(e):
    return e.value.get_codes()


def gl(code):
    return fin.account_balance(fm.Account.objects.get(code=code))


def live(f, serial="D1", cost="1200"):
    return activate(f, laptop(f, serial_number=serial, purchase_cost=cost), cost=cost)


def users(f):
    return f["people"]["am_"].id, f["people"]["am2"].id, f["people"]["ctrl"].id


def depreciate(f, *months):
    for mo in months:
        dp.run_depreciation(f["people"]["ctrl"].id, 2026, mo)


@pytest.mark.django_db
def test_sale_posts_gain_and_removes_asset_from_ledger(f):
    a = live(f)
    u, u2, _ = users(f)
    depreciate(f, 3, 4)  # 1200, 60 accumulated => NBV 1140
    d = ds.request_disposal(u, a.id, method="SALE", reason="Replaced", buyer="Abebe", expected_proceeds="1000")
    with pytest.raises(DomainError) as e:
        ds.execute(u, d.id, executed_on=date(2026, 5, 10), proceeds="1000")
    assert codes(e) == "approval_required"
    with pytest.raises(DomainError) as e:
        ds.decide(u, d.id, approve=True)
    assert codes(e) == "separation_of_duties"
    ds.decide(u2, d.id, approve=True)
    d = ds.execute(u, d.id, executed_on=date(2026, 5, 10), proceeds="1000")
    a.refresh_from_db()
    assert a.status == "DISPOSED" and d.nbv_at_disposal == D("1140") and d.gain_loss == D("-140")
    assert gl("1500") == 0 and gl("1590") == 0 and gl("5950") == D("140")
    assert dp.reconcile()["reconciled"] is True
    cert = ds.certificate(d.id)
    assert cert["gain_loss"].startswith("-140") and cert["asset"] == a.number
    assert ds.disposal_report(date(2026, 1, 1), date(2026, 12, 31))["totals"]["gain_loss"].startswith("-140")
    with pytest.raises(DomainError) as e:
        svc.update_asset(u, a.id, description="x")
    assert codes(e) == "asset_disposed"
    with pytest.raises(DomainError) as e:
        ds.request_disposal(u, a.id, method="SCRAP", reason="again")
    assert codes(e) == "asset_not_disposable"


@pytest.mark.django_db
def test_gain_on_sale(f):
    a = live(f, "D2")
    u, u2, _ = users(f)
    depreciate(f, 3)
    ds_ = ds.request_disposal(u, a.id, method="SALE", reason="Sold", buyer="B", expected_proceeds="2000")
    ds.decide(u2, ds_.id, approve=True)
    d = ds.execute(u, ds_.id, executed_on=date(2026, 4, 5), proceeds="2000")
    assert d.gain_loss == D("2000") - D("1170") and gl("5950") == -D("830") and dp.reconcile()["reconciled"]


@pytest.mark.django_db
def test_donation_and_write_off_validate_proceeds_and_non_capitalized_has_no_journal(f):
    a = live(f, "D3")
    small = laptop(f, serial_number="SMALL", purchase_cost="100")
    u, u2, _ = users(f)
    with pytest.raises(ValidationFailed) as e:
        ds.request_disposal(u, a.id, method="SCRAP", reason="x", expected_proceeds="5")
    assert codes(e) == "invalid_proceeds"
    with pytest.raises(ValidationFailed) as e:
        ds.request_disposal(u, a.id, method="SALE", reason="x")
    assert codes(e) == "buyer_required"
    with pytest.raises(DomainError) as e:
        ds.request_disposal(u, small.id, method="SCRAP", reason="not in register")
    assert codes(e) == "asset_not_disposable"
    d = ds.request_disposal(u, a.id, method="DONATION", reason="Charity")
    with pytest.raises(DomainError) as e:
        ds.request_disposal(u, a.id, method="SCRAP", reason="dup")
    assert codes(e) == "already_pending"
    ds.decide(u2, d.id, approve=False, note="Not now")
    d2 = ds.request_disposal(u, a.id, method="DONATION", reason="Charity")
    ds.decide(u2, d2.id, approve=True)
    depreciate(f, 3)
    done = ds.execute(u, d2.id, executed_on=date(2026, 3, 31), proceeds=0)
    assert done.gain_loss == -D("1170") and gl("5950") == D("1170")


@pytest.mark.django_db
def test_blockers_and_depreciation_must_be_current(f):
    a = live(f, "D4")
    u, u2, _ = users(f)
    d = ds.request_disposal(u, a.id, method="SCRAP", reason="Broken")
    ds.decide(u2, d.id, approve=True)
    with pytest.raises(DomainError) as e:
        ds.execute(u, d.id, executed_on=date(2026, 6, 15))
    assert codes(e) == "depreciation_not_current"
    depreciate(f, 3, 4, 5)
    b = mt.report_breakdown(u, a.id, symptoms="x")
    wo = mt.open_repair(u, b.id, description="fix")
    with pytest.raises(DomainError) as e:
        ds.execute(u, d.id, executed_on=date(2026, 6, 15))
    assert codes(e) == "disposal_blocked"
    mt.cancel_work_order(u, wo.id)
    am.Breakdown.objects.filter(pk=b.id).update(status="CLOSED")
    with pytest.raises(DomainError) as e:
        ds.execute(u, d.id, executed_on=date(2026, 4, 15))  # before depreciation already posted
    assert codes(e) == "period_closed_for_disposal"
    al.allocate(u, a.id, target_kind="DEPARTMENT", target_id=uuid.uuid4(), start_on=TODAY)
    ds.execute(u, d.id, executed_on=date(2026, 6, 15))
    assert not am.AssetAllocation.objects.filter(asset=a, status="ACTIVE").exists()


@pytest.mark.django_db
def test_verification_count_discrepancies_and_resolution(f):
    ok, moved, gone, cond = live(f, "C1"), live(f, "C2"), live(f, "C3"), live(f, "C4")
    u, u2, _ = users(f)
    c = vf.start_count(u, name="Q4 count", location_id=f["loc"].id)
    assert am.CountLine.objects.filter(count=c).count() == 4
    vf.scan(u, c.id, ok.number, condition="GOOD")
    assert vf.scan(u, c.id, moved.number, location_id=f["loc2"].id).discrepancy == "FOUND_ELSEWHERE"
    assert vf.scan(u, c.id, cond.number, condition="DAMAGED").discrepancy == "CONDITION_CHANGED"
    with pytest.raises(DomainError) as e:
        vf.scan(u, c.id, ok.number)
    assert codes(e) == "already_pending"
    with pytest.raises(DomainError) as e:
        vf.scan(u, c.id, "NOPE")
    assert codes(e) == "not_found"
    stray = laptop(f, serial_number="STRAY", location_id=f["loc2"].id)
    assert vf.complete_count(u, c.id) == {"count": c.number, "missing": 1, "discrepancies": 3}
    lines = {l.asset.number: l for l in am.CountLine.objects.filter(count=c).select_related("asset")}
    with pytest.raises(DomainError) as e:
        vf.resolve(u, lines[gone.number].id, resolution="FOUND", notes="x")
    assert codes(e) == "separation_of_duties"
    with pytest.raises(ValidationFailed) as e:
        vf.resolve(u2, lines[gone.number].id, resolution="LOCATION_UPDATED", notes="x")
    assert codes(e) == "invalid_resolution"
    with pytest.raises(DomainError) as e:
        vf.close_count(u2, c.id)
    assert codes(e) == "discrepancies_open"
    vf.resolve(u2, lines[moved.number].id, resolution="LOCATION_UPDATED", notes="Relocated to Branch 1")
    vf.resolve(u2, lines[cond.number].id, resolution="CONDITION_UPDATED", notes="Screen smashed")
    vf.resolve(u2, lines[gone.number].id, resolution="WRITE_OFF_REQUESTED", notes="Searched all floors")
    moved.refresh_from_db(); cond.refresh_from_db()
    assert moved.location_id == f["loc2"].id and cond.condition == "DAMAGED"
    wo = am.AssetDisposal.objects.get(asset=gone)
    assert wo.method == "WRITE_OFF" and wo.status == "REQUESTED" and wo.count_line_id == lines[gone.number].id
    vf.close_count(u2, c.id)
    rep = vf.count_report(c.id)
    assert rep["status"] == "CLOSED" and rep["accuracy_percent"] == "25.0"


@pytest.mark.django_db
def test_http_permissions_and_flow(api_env, acme):
    env, api = api_env
    with schema_context(acme["schema"]):
        a = activate(env, laptop(env, serial_number="HD1"))
    body = {"asset": str(a.id), "method": "SCRAP", "reason": "Obsolete"}
    assert api["emp"].post("/api/v1/assets/disposals", body).status_code == 403
    assert api["auditor"].post("/api/v1/assets/disposals", body).status_code == 403
    r = api["am"].post("/api/v1/assets/disposals", body)
    assert r.status_code == 201
    did = r.json()["id"]
    assert api["am"].post(f"/api/v1/assets/disposals/{did}/approve").status_code == 403  # own request
    assert api["auditor"].get("/api/v1/assets/disposals").status_code == 200
    assert api["emp"].post("/api/v1/assets/verification-counts", {"name": "x"}).status_code == 403
    c = api["am"].post("/api/v1/assets/verification-counts", {"name": "HQ"})
    assert c.status_code == 201
    cid = c.json()["id"]
    assert api["am"].post(f"/api/v1/assets/verification-counts/{cid}/scan", {"code": a.number}).status_code == 201
    assert api["am"].post(f"/api/v1/assets/verification-counts/{cid}/complete").json()["discrepancies"] == 0
    assert api["am"].get(f"/api/v1/assets/verification-counts/{cid}/report").status_code == 200
    assert api["am"].get("/api/v1/assets/reports/disposals").status_code == 400


@pytest.mark.django_db
def test_revaluation_surplus_is_released_to_retained_earnings_on_disposal(f):
    a = live(f, "D9")
    u, u2, _ = users(f)
    depreciate(f, 3)  # NBV 1170
    adj = dp.request_adjustment(u, a.id, kind="REVALUATION", amount="1500", effective_date=date(2026, 3, 31), reason="Market value")
    dp.decide_adjustment(u2, adj.id, approve=True)
    assert gl("3200") == -D("330") or abs(gl("3200")) == D("330")
    d = ds.request_disposal(u, a.id, method="SALE", reason="Sold", buyer="B", expected_proceeds="1500")
    ds.decide(u2, d.id, approve=True)
    ds.execute(u, d.id, executed_on=date(2026, 4, 2), proceeds="1500")
    assert gl("3200") == 0 and abs(gl("3900")) == D("330")
    assert gl("1500") == 0 and gl("1590") == 0 and dp.reconcile()["reconciled"] is True
