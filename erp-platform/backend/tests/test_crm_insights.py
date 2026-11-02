from datetime import date, timedelta

import pytest

from modules.crm import insights as ins
from modules.crm import models as cm
from modules.crm import pipeline
from modules.crm import service_desk as sd
from modules.crm import services as crm
from shared.api.errors import DomainError
from tests.test_sales import D0, confirmed, deliver, f, line, order  # noqa: F401


def buy(f, acct, day, qty="10", price="100", product=None):
    from modules.sales import models as sm

    o = confirmed(f, [line(f, qty, price, product=product)])
    sm.SalesOrder.objects.filter(pk=o.pk).update(account=acct, order_date=day)
    return o


@pytest.mark.django_db
def test_account_summary_segmentation_and_visibility(f):
    p = f["people"]
    big = f["acct"]
    small = crm.create_account(p["rep1"].id, name="Small Co", industry="Retail")
    quiet = crm.create_account(p["rep1"].id, name="Never Bought")
    buy(f, big, D0, "10", "100")
    buy(f, big, D0 + timedelta(days=10), "10", "100")
    buy(f, small, D0, "1", "100")
    s = ins.account_summary(p["rep1"].id, big.id, "USD")
    assert (s["orders"], s["lifetime_value"], s["average_order_value"]) == (2, "2000.0000", "1000.00")
    assert s["last_order"] == D0 + timedelta(days=10) and s["top_products"][0]["revenue"] == "2000.0000"
    seg = ins.segmentation(p["rep1"].id, "USD")
    assert [r["name"] for r in seg["tiers"]["A"]] == ["Globex Customer"]
    assert [r["name"] for r in seg["tiers"]["B"] + seg["tiers"]["C"]] == ["Small Co"]
    assert [r["name"] for r in seg["tiers"]["N"]] == ["Never Bought"] and seg["total_revenue"] == "2100.0000"
    with pytest.raises(DomainError):
        ins.account_summary(p["rep2"].id, big.id, "USD")
    assert ins.segmentation(p["rep2"].id, "USD")["tiers"]["A"] == []  # another rep sees none of rep1's customers


@pytest.mark.django_db
def test_retention_buckets_and_lifecycle_refresh(f):
    p = f["people"]
    a1 = f["acct"]
    a2 = crm.create_account(p["rep1"].id, name="Drifting")
    a3 = crm.create_account(p["rep1"].id, name="Gone")
    today = D0 + timedelta(days=200)
    buy(f, a1, today - timedelta(days=5))
    buy(f, a2, today - timedelta(days=100))
    buy(f, a3, today - timedelta(days=190))
    r = ins.retention(p["rep1"].id, today, "USD")
    assert [x["name"] for x in r["active"]] == ["Globex Customer"]
    assert [x["name"] for x in r["at_risk"]] == ["Drifting"] and [x["name"] for x in r["churned"]] == ["Gone"]
    assert r["churn_rate_percent"] == 33.3
    with pytest.raises(DomainError):
        ins.refresh_lifecycle(p["rep1"].id, today, "USD")
    assert ins.refresh_lifecycle(p["sm"].id, today, "USD") == 3
    assert {a.name: a.lifecycle_stage for a in cm.CrmAccount.objects.all()} == {"Globex Customer": "ACTIVE", "Drifting": "AT_RISK", "Gone": "CHURNED"}
    assert ins.refresh_lifecycle(p["sm"].id, today, "USD") == 0


@pytest.mark.django_db
def test_cross_sell_suggests_peer_products_not_yet_bought(f):
    p = f["people"]
    mine = crm.create_account(p["rep1"].id, name="Mine", industry="Retail")
    peer = crm.create_account(p["rep1"].id, name="Peer", industry="Retail")
    cm.CrmAccount.objects.filter(pk=f["acct"].pk).update(industry="Other")
    buy(f, mine, D0, product=f["widget"])
    buy(f, peer, D0, product=f["widget"])
    buy(f, peer, D0, product=f["paint"])
    out = ins.cross_sell(p["rep1"].id, mine.id, "USD")
    assert [r["name"] for r in out] == [f["paint"].name] and out[0]["peer_buyers"] == 1
    assert ins.cross_sell(p["rep1"].id, f["acct"].id, "USD") == []  # no peers in "Other"


@pytest.mark.django_db
def test_satisfaction_and_profitability(f):
    p = f["people"]
    c = sd.open_case(p["rep1"].id, account_id=f["acct"].id, subject="x")
    sd.resolve_case(p["rep1"].id, c.id, "ok")
    sd.record_feedback(p["rep1"].id, c.id, 2)
    sat = ins.satisfaction(p["rep1"].id)
    assert (sat["responses"], sat["average"], sat["detractor_percent"]) == (1, 2.0, 100.0)
    assert ins.satisfaction(p["rep2"].id)["responses"] == 0
    o = confirmed(f, [line(f, "10", "100")])
    deliver(f, o)
    pr = ins.profitability(p["rep1"].id, "USD")
    assert pr[0]["revenue"] == "1000.00" and pr[0]["cost"] == "50.00" and pr[0]["margin_percent"] == 95.0
    with pytest.raises(Exception):
        ins.profitability(p["rep1"].id, "EUR")


@pytest.mark.django_db
def test_dashboard_lead_sources_neglected_deals_and_activity_performance(f):
    p = f["people"]
    l1 = crm.create_lead(p["rep1"].id, name="A", source="web", auto_assign=False)
    crm.create_lead(p["rep1"].id, name="B", source="web", auto_assign=False)
    cm.Lead.objects.filter(pk=l1.pk).update(status="CONVERTED")
    opp = crm.create_opportunity(p["rep1"].id, name="Deal", account_id=f["acct"].id, amount="500", currency="USD")
    cm.Opportunity.objects.filter(pk=opp.pk).update(created_at=opp.created_at - timedelta(days=30))
    a = crm.log_activity(p["rep1"].id, type="CALL", subject="c", account_id=f["acct"].id)
    crm.log_activity(p["rep1"].id, type="CALL", subject="d", account_id=f["acct"].id)
    crm.complete_activity(p["rep1"].id, a.id)
    d = ins.dashboard(p["rep1"].id, currency="USD")
    assert d["lead_sources"]["web"] == {"leads": 2, "converted": 1, "conversion_percent": 50.0}
    assert [n["name"] for n in d["neglected_opportunities"]] == ["Deal"]
    assert d["pipeline"]["open_value_by_currency"] == {"USD": "500.0000"}
    assert d["activity_performance"][0]["completion_percent"] == 50.0
    assert ins.dashboard(p["rep2"].id, currency="USD")["pipeline"]["open_count"] == 0
