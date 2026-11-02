from datetime import date, timedelta
from decimal import Decimal as D

import pytest

from modules.crm import models as cm
from modules.crm import pipeline
from modules.crm import services as crm
from modules.sales import analytics as an
from modules.sales import models as sm
from shared.api.errors import ValidationFailed
from tests.test_sales import D0, confirmed, deliver, f, line  # noqa: F401

S, E = date(2026, 3, 1), date(2026, 3, 31)


@pytest.mark.django_db
def test_performance_aov_discount_concentration_and_scoping(f):
    p = f["people"]
    other = crm.create_account(p["rep2"].id, name="Other")
    confirmed(f, [line(f, qty="10", price="100", disc="10")])  # 900 net, 1000 gross
    o2 = confirmed(f, [line(f, qty="10", price="100")])
    sm.SalesOrder.objects.filter(pk=o2.pk).update(account=other)
    r = an.performance(p["sm"].id, S, E)
    assert (r["orders"], D(r["revenue"]), D(r["average_order_value"])) == (2, 1900, 950)
    assert r["average_discount_percent"] == 5.0 and r["top_customers"][0]["name"] == "Other" and r["top5_share_percent"] == 100.0
    assert r["concentration_hhi"] == round((1000 / 1900 * 100) ** 2 + (900 / 1900 * 100) ** 2)
    assert r["trend"] == {"2026-03": "1900.00"}
    mine = an.performance(p["rep1"].id, S, E)
    assert (mine["orders"], D(mine["revenue"])) == (1, 900) and an.performance(p["rep2"].id, S, E)["orders"] == 1
    with pytest.raises(ValidationFailed):
        an.performance(p["sm"].id, E, S)


@pytest.mark.django_db
def test_win_rate_cycle_and_quote_conversion(f):
    p = f["people"]
    from django.utils import timezone

    opps = [crm.create_opportunity(p["rep1"].id, name=f"O{i}", account_id=f["acct"].id, amount="100", currency="USD") for i in range(3)]
    crm.win_opportunity(p["rep1"].id, opps[0].id)
    crm.win_opportunity(p["rep1"].id, opps[1].id)
    crm.lose_opportunity(p["rep1"].id, opps[2].id, "price")
    cm.Opportunity.objects.filter(pk=opps[0].id).update(created_at=timezone.now() - timedelta(days=10))
    today = timezone.now().date()
    r = an.performance(p["rep1"].id, today - timedelta(days=1), today + timedelta(days=1))
    assert r["win_rate_percent"] == 66.7 and 4.0 <= r["avg_sales_cycle_days"] <= 5.0  # 10-day and same-day wins
    assert r["quote_to_order_percent"] is None
    assert an.performance(p["rep2"].id, today - timedelta(days=1), today + timedelta(days=1))["win_rate_percent"] is None


@pytest.mark.django_db
def test_backlog_and_forecast_scenarios(f):
    p = f["people"]
    o = confirmed(f, [line(f, qty="10", price="100")])
    deliver(f, o, qty="4")
    b = an.backlog(p["rep1"].id)
    assert (D(b["to_deliver"]), D(b["to_invoice"]), b["orders"]) == (600, 400, 1) and an.backlog(p["rep2"].id)["orders"] == 0
    today = D0
    for name, amount, stage, days in (("sure", "1000", "NEGOTIATION", 20), ("maybe", "2000", "PROSPECTING", 40), ("far", "5000", "PROSPECTING", 400)):
        opp = crm.create_opportunity(p["rep1"].id, name=name, account_id=f["acct"].id, amount=amount, currency="USD", expected_close=today + timedelta(days=days))
        cm.Opportunity.objects.filter(pk=opp.pk).update(stage=cm.PipelineStage.objects.get(code=stage))
    fc = an.forecast(p["rep1"].id, today=today, months=3)
    prob = {s.code: s.probability for s in cm.PipelineStage.objects.all()}
    assert D(fc["backlog"]) == 600
    assert D(fc["best"]) == 600 + 3000 and D(fc["worst"]) == 600 + (1000 if prob["NEGOTIATION"] >= 90 else 0)
    assert D(fc["likely"]) == 600 + D(1000) * prob["NEGOTIATION"] / 100 + D(2000) * prob["PROSPECTING"] / 100
    assert D(fc["worst"]) <= D(fc["likely"]) <= D(fc["best"])
    assert "2026-04" in fc["pipeline_by_month"] or "2026-05" in fc["pipeline_by_month"]
    with pytest.raises(ValidationFailed):
        an.forecast(p["rep1"].id, months=0)
    assert an.forecast(p["rep2"].id, today=today)["best"] == "0.00"
