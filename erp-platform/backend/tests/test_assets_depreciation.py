from datetime import date
from decimal import Decimal as D

import pytest

from modules.assets import depreciation as dp
from modules.assets import models as am
from modules.assets import services as svc
from modules.finance import models as fm
from modules.finance import services as fin
from shared.api.errors import DomainError, ValidationFailed
from tests.test_assets import D0, activate, api_env, f, laptop  # noqa: F401


def gl(code):
    return fin.account_balance(fm.Account.objects.get(code=code))


def asset(f, serial, cost="1200", cat=None):
    a = laptop(f, serial_number=serial, purchase_cost=cost, **({"category_id": cat.id} if cat else {}))
    return activate(f, a, cost=cost)


@pytest.mark.django_db
def test_straight_line_runs_post_to_finance_and_reconcile(f):
    a = asset(f, "S1")  # 1200, 10% residual = 120, 36 months => 30/month
    assert (a.gross_value, a.residual_value, a.useful_life_months, a.depreciation_start) == (D("1200"), D("120"), 36, date(2026, 3, 1))
    run = dp.run_depreciation(f["people"]["ctrl"].id, 2026, 3)
    a.refresh_from_db()
    assert run.total_amount == D("30") and a.accumulated_depreciation == D("30") and dp.nbv(a) == D("1170")
    assert gl("5500") == D("30") and abs(gl("1590")) == D("30")
    with pytest.raises(DomainError) as e:
        dp.run_depreciation(f["people"]["ctrl"].id, 2026, 3)
    assert e.value.get_codes() == "already_run"
    with pytest.raises(DomainError) as e:
        dp.run_depreciation(f["people"]["ctrl"].id, 2026, 5)
    assert e.value.get_codes() == "run_out_of_sequence"
    dp.run_depreciation(f["people"]["ctrl"].id, 2026, 4)
    assert dp.reconcile()["reconciled"] is True
    rep = dp.valuation_report(date(2026, 3, 31))
    assert rep["totals"]["net_book_value"] == "1170.0000" and dp.valuation_report()["totals"]["net_book_value"] == "1140.0000"


@pytest.mark.django_db
def test_schedule_ends_at_residual_and_catch_up_on_late_capitalization(f):
    a = asset(f, "S2")
    s = dp.schedule(a.id)
    assert len(s) == 36 and s[0]["charge"] == "30.0000" and s[-1]["nbv"] == "120.0000"
    dp.run_depreciation(f["people"]["ctrl"].id, 2026, 3)
    late = laptop(f, serial_number="LATE", purchase_cost="1200")
    activate(f, late, cost="1200", day=date(2026, 3, 20))  # starts March, but March is already depreciated
    run = dp.run_depreciation(f["people"]["ctrl"].id, 2026, 4)
    late.refresh_from_db()
    assert late.depreciated_months == 2 and run.total_amount == D("30") + D("60")  # April for the first, March+April for the late one


@pytest.mark.django_db
def test_reducing_balance_and_non_depreciating_categories(f):
    from modules.assets import services as s
    car = s.create_category(None, code="CARX", name="Cars", prefix="CX", depreciation_method="RB", reducing_rate_percent="24", useful_life_months=60, residual_percent="0", tracking="BARCODE", asset_class="VEHICLE")
    land = s.create_category(None, code="LAND", name="Land", prefix="LD", depreciation_method="NON", asset_class="FIXED")
    c = asset(f, "C1", "10000", car)
    l = asset(f, "L1", "50000", land)
    run = dp.run_depreciation(f["people"]["ctrl"].id, 2026, 3)
    assert run.total_amount == D("200") and run.asset_count == 1  # 10000 * 24% / 12, land untouched
    dp.run_depreciation(f["people"]["ctrl"].id, 2026, 4)
    c.refresh_from_db()
    assert c.accumulated_depreciation == D("396")  # 200 + 9800*2%
    assert {r["asset"]: r["net_book_value"] for r in dp.valuation_report()["rows"]}[l.number] == "50000.0000"


@pytest.mark.django_db
def test_reversal_only_latest_and_rerun(f):
    ctrl = f["people"]["ctrl"].id
    a = asset(f, "R1")
    r1, r2 = dp.run_depreciation(ctrl, 2026, 3), None
    r2 = dp.run_depreciation(ctrl, 2026, 4)
    with pytest.raises(DomainError) as e:
        dp.reverse_run(ctrl, r1.id, reason="x")
    assert e.value.get_codes() == "not_latest"
    with pytest.raises(ValidationFailed):
        dp.reverse_run(ctrl, r2.id, reason="")
    dp.reverse_run(ctrl, r2.id, reason="Wrong useful life")
    a.refresh_from_db()
    assert a.accumulated_depreciation == D("30") and a.depreciated_months == 1 and gl("5500") == D("30")
    assert dp.run_depreciation(ctrl, 2026, 4).status == "POSTED"
    with pytest.raises(DomainError):
        dp.reverse_run(ctrl, r2.id, reason="again")
    assert dp.reconcile()["reconciled"]


@pytest.mark.django_db
def test_improvement_impairment_revaluation_adjust_future_charges(f):
    u, u2, ctrl = f["people"]["am_"].id, f["people"]["am2"].id, f["people"]["ctrl"].id
    a = asset(f, "V1")
    dp.run_depreciation(ctrl, 2026, 3)
    imp = dp.request_adjustment(u, a.id, kind="IMPROVEMENT", amount="600", effective_date=date(2026, 3, 31), reason="Upgrade", extend_life_months=12)
    with pytest.raises(DomainError):
        dp.request_adjustment(u, a.id, kind="IMPAIRMENT", amount="10", effective_date=D0, reason="x")  # one pending at a time
    with pytest.raises(DomainError) as e:
        dp.decide_adjustment(u, imp.id, approve=True)
    assert e.value.get_codes() == "separation_of_duties"
    dp.decide_adjustment(u2, imp.id, approve=True)
    a.refresh_from_db()
    assert a.gross_value == D("1800") and a.useful_life_months == 48 and gl("1500") == D("1800")
    loss = dp.request_adjustment(u, a.id, kind="IMPAIRMENT", amount="270", effective_date=D0, reason="Water damage")
    dp.decide_adjustment(u2, loss.id, approve=True)
    a.refresh_from_db()
    assert a.impairment_total == D("270") and dp.nbv(a) == D("1500") and gl("5600") == D("270")
    up = dp.request_adjustment(u, a.id, kind="REVALUATION", amount="1800", effective_date=D0, reason="Market value")
    dp.decide_adjustment(u2, up.id, approve=True)
    a.refresh_from_db()
    assert dp.nbv(a) == D("1800") and a.revaluation_surplus == D("300") and abs(gl("3200")) == D("300")
    down = dp.request_adjustment(u, a.id, kind="REVALUATION", amount="1650", effective_date=D0, reason="Fell")
    dp.decide_adjustment(u2, down.id, approve=True)
    a.refresh_from_db()
    assert dp.nbv(a) == D("1650") and a.revaluation_surplus == D("150") and gl("5600") == D("270")  # absorbed by surplus, no new loss
    assert dp.reconcile()["reconciled"]
    with pytest.raises(ValidationFailed) as e:
        dp.request_adjustment(u, a.id, kind="REVALUATION", amount="10", effective_date=D0, reason="below residual")
    assert e.value.get_codes() == "below_residual"


@pytest.mark.django_db
def test_policy_change_and_rejection(f):
    u, u2 = f["people"]["am_"].id, f["people"]["am2"].id
    a = asset(f, "P1")
    dp.run_depreciation(f["people"]["ctrl"].id, 2026, 3)
    with pytest.raises(ValidationFailed):
        dp.change_policy(u, a.id, reason="", useful_life_months=48)
    with pytest.raises(ValidationFailed) as e:
        dp.change_policy(u, a.id, reason="r", useful_life_months=0)
    assert e.value.get_codes() == "invalid_life"
    dp.change_policy(u, a.id, reason="Longer life expected", useful_life_months=60)
    with pytest.raises(DomainError) as e:
        dp.change_policy(u, a.id, reason="r", depreciation_start=D0)
    assert e.value.get_codes() == "start_locked"
    adj = dp.request_adjustment(u, a.id, kind="IMPAIRMENT", amount="50", effective_date=D0, reason="x")
    with pytest.raises(ValidationFailed):
        dp.decide_adjustment(u2, adj.id, approve=False)
    assert dp.decide_adjustment(u2, adj.id, approve=False, note="No evidence").status == "REJECTED"
    with pytest.raises(RuntimeError):
        am.AssetValueEntry.objects.first().delete()


@pytest.mark.django_db
def test_depreciation_over_http_permissions(api_env):
    env, api = api_env
    assert api["emp"].post("/api/v1/assets/depreciation/runs", {"year": 2026, "month": 3}).status_code == 403
    assert api["auditor"].post("/api/v1/assets/depreciation/runs", {"year": 2026, "month": 3}).status_code == 403
    assert api["auditor"].get("/api/v1/assets/depreciation/runs?year=2026").status_code == 200
    assert api["auditor"].get("/api/v1/assets/reports/valuation").status_code == 200
    assert api["auditor"].get("/api/v1/assets/reports/reconciliation").json()["reconciled"] is True
    assert api["emp"].get("/api/v1/assets/reports/reconciliation").status_code == 403
    assert api["am"].post("/api/v1/assets/depreciation/runs", {"year": 2026, "month": 3}).status_code == 409  # nothing to depreciate
    assert api["am"].post("/api/v1/assets/depreciation/runs", {"year": "x"}).status_code == 400
    assert api["auditor"].post("/api/v1/assets/adjustments/00000000-0000-0000-0000-000000000001/approve").status_code == 403
