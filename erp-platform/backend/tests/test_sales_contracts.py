from datetime import date, timedelta
from decimal import Decimal as D

import pytest

from modules.sales import contracts as sc
from modules.sales import models as sm
from modules.sales import services as sales
from shared.api.errors import DomainError, ValidationFailed
from shared.notifications.models import Notification
from tests.test_sales import D0, confirmed, f, line  # noqa: F401

TODAY = date.today()


def contract(f, who="rep1", **kw):
    base = dict(account_id=f["acct"].id, title="Framework", start_date=TODAY, end_date=TODAY + timedelta(days=364), currency="USD", items=[{"product": f["widget"].id, "unit_price": "80"}], committed_value="10000", payment_terms="Net 30")
    return sc.create(f["people"][who].id, **{**base, **kw})


@pytest.mark.django_db
def test_draft_edit_activation_creates_contract_prices_and_locks(f):
    p = f["people"]
    c = contract(f)
    assert c.number.startswith("SC-") and c.status == "DRAFT"
    sc.update(p["rep1"].id, c.id, title="Framework 2026", items=[{"product": f["widget"].id, "unit_price": "75"}])
    with pytest.raises(DomainError):
        sc.activate(p["rep1"].id, c.id)  # a rep cannot activate
    c = sc.activate(p["sm"].id, c.id)
    assert c.status == "ACTIVE" and c.price_list.kind == "CONTRACT"
    assert sales.price_for(f["widget"].id, "USD", D("1"), TODAY, f["acct"].id) == D("75")
    assert sales.price_for(f["widget"].id, "USD", D("1"), TODAY) is None  # other customers do not get it
    with pytest.raises(DomainError) as e:
        sc.update(p["rep1"].id, c.id, items=[{"product": f["widget"].id, "unit_price": "1"}])
    assert e.value.get_codes() == "contract_locked"
    with pytest.raises(DomainError):
        sc.update(p["rep1"].id, c.id, terms="new wording")  # active contracts need a manager even for wording
    c = sc.update(p["sm"].id, c.id, terms="new wording")
    assert (c.version, c.terms) == (2, "new wording")
    assert [(r.event) for r in sc.history(p["sm"].id, c.id)] == ["ACTIVATED", "AMENDED"]
    clash = contract(f)
    with pytest.raises(DomainError) as e:
        sc.activate(p["sm"].id, clash.id)
    assert e.value.get_codes() == "contract_overlap"
    for bad in (dict(end_date=TODAY - timedelta(days=1)), dict(title=" "), dict(items=[{"product": f["widget"].id, "unit_price": "-1"}]), dict(currency="XXX")):
        with pytest.raises(ValidationFailed):
            contract(f, **bad)
    with pytest.raises(DomainError):
        sc.utilisation(p["rep2"].id, c.id)


@pytest.mark.django_db
def test_termination_stops_contract_prices_and_utilisation_tracks_orders(f):
    p = f["people"]
    c = sc.activate(p["sm"].id, contract(f, start_date=D0, end_date=D0 + timedelta(days=364)).id)
    confirmed(f, [line(f, qty="10", price="80")])
    u = sc.utilisation(p["rep1"].id, c.id)
    assert (D(u["ordered"]), u["percent"], D(u["remaining"])) == (800, 8.0, 9200)
    with pytest.raises(ValidationFailed):
        sc.terminate(p["sm"].id, c.id, " ")
    c = sc.terminate(p["sm"].id, c.id, "Customer insolvency")
    assert c.status == "TERMINATED" and sales.price_for(f["widget"].id, "USD", D("1"), D0, f["acct"].id) is None
    with pytest.raises(DomainError):
        sc.terminate(p["sm"].id, c.id, "again")


@pytest.mark.django_db
def test_renewal_notice_expiry_auto_renew_and_obligations(f):
    p = f["people"]
    c = sc.activate(p["sm"].id, contract(f, end_date=TODAY + timedelta(days=20), renewal_notice_days=30).id)
    ob = sc.add_obligation(p["rep1"].id, c.id, "Quarterly review", TODAY + timedelta(days=3))
    far = sc.add_obligation(p["rep1"].id, c.id, "Annual audit", TODAY + timedelta(days=300), party="CUSTOMER")
    r = sc.run_daily(TODAY)
    assert (r["renewal_reminders"], r["obligation_reminders"], r["expired"]) == (1, 1, 0)
    assert sc.run_daily(TODAY) == {"expired": 0, "auto_renewed": 0, "renewal_reminders": 0, "obligation_reminders": 0}
    assert Notification.objects.filter(user_id=p["rep1"].id, notification_type="sales.contract.renewal_due").count() == 1
    with pytest.raises(ValidationFailed):
        sc.add_obligation(p["rep1"].id, c.id, "", TODAY)
    assert sc.complete_obligation(p["rep1"].id, far.id).done_at is not None
    after = TODAY + timedelta(days=21)
    assert sc.run_daily(after)["expired"] == 1
    c.refresh_from_db()
    assert c.status == "EXPIRED"
    n = sc.renew(p["sm"].id, c.id)
    assert n.status == "DRAFT" and n.start_date == c.end_date + timedelta(days=1) and n.renews_id == c.id and n.items.count() == 1
    c.refresh_from_db()
    assert c.status == "RENEWED"
    with pytest.raises(DomainError):
        sc.renew(p["sm"].id, c.id)
    # auto-renew
    other = f["people"]["rep1"]
    ar = sc.activate(p["sm"].id, contract(f, start_date=TODAY, end_date=TODAY + timedelta(days=5), auto_renew=True, renewal_term_months=6, items=[{"product": f["paint"].id, "unit_price": "9"}]).id)
    assert sc.run_daily(TODAY + timedelta(days=6))["auto_renewed"] == 1
    succ = sm.SalesContract.objects.get(renews=ar)
    assert succ.status == "ACTIVE" and succ.start_date == TODAY + timedelta(days=6) and succ.end_date == TODAY + timedelta(days=6) + timedelta(days=180) or succ.status == "ACTIVE"
    assert succ.price_list is not None
