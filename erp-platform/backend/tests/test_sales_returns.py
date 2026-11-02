from datetime import timedelta
from decimal import Decimal as D

import pytest

from modules.inventory import models as im
from modules.sales import models as sm
from modules.sales import returns as rt
from modules.sales import services as sales
from shared.api.errors import DomainError, ValidationFailed
from shared.notifications.models import Notification
from tests.test_sales import D0, confirmed, deliver, f, line  # noqa: F401


def stock(f, loc=None):
    return im.StockLevel.objects.filter(product=f["widget"], location=loc or f["loc_a"]).first().quantity


def delivered(f, qty="10"):
    o = confirmed(f, [line(f, qty=qty)])
    deliver(f, o)
    return o, o.lines.get()


@pytest.mark.django_db
def test_request_approval_and_receipt_with_dispositions(f):
    p = f["people"]
    o, ln = delivered(f)  # stock 100 -> 90
    with pytest.raises(ValidationFailed):
        rt.request_return(p["rep1"].id, o.id, reason="x", lines=[{"order_line": ln.id, "quantity": "11"}], today=D0)
    with pytest.raises(ValidationFailed):
        rt.request_return(p["rep1"].id, o.id, reason=" ", lines=[{"order_line": ln.id, "quantity": "1"}], today=D0)
    with pytest.raises(DomainError):
        rt.request_return(p["rep2"].id, o.id, reason="x", lines=[{"order_line": ln.id, "quantity": "1"}], today=D0)
    rr = rt.request_return(p["rep1"].id, o.id, reason="faulty", reason_code="DEFECTIVE", lines=[{"order_line": ln.id, "quantity": "6", "disposition": "QUARANTINE"}], today=D0)
    with pytest.raises(ValidationFailed):  # 6 already requested; only 4 left
        rt.request_return(p["rep1"].id, o.id, reason="more", lines=[{"order_line": ln.id, "quantity": "5"}], today=D0)
    with pytest.raises(DomainError):
        rt.receive(p["wh"].id, rr.id, location_id=f["loc_a"].id, return_date=D0)  # not approved
    with pytest.raises(DomainError):
        rt.decide(p["rep1"].id, rr.id, True)
    with pytest.raises(ValidationFailed):
        rt.decide(p["sm"].id, rr.id, False, " ")
    rr = rt.decide(p["sm"].id, rr.id, True)
    assert Notification.objects.filter(user_id=p["rep1"].id, notification_type="sales.return.approved").exists()
    with pytest.raises(ValidationFailed) as e:  # quarantine needs its own location
        rt.receive(p["wh"].id, rr.id, location_id=f["loc_a"].id, return_date=D0)
    assert e.value.get_codes() == "quarantine_location_required"
    wh = im.Warehouse.objects.first()
    q = im.Location.objects.create(warehouse=wh, code="QUAR")
    rr = rt.receive(p["wh"].id, rr.id, location_id=f["loc_a"].id, return_date=D0, quarantine_location_id=q.id)
    assert rr.status == "RECEIVED" and stock(f, q) == 6 and stock(f) == 90  # quarantined, not restocked
    assert rr.sales_return.lines.get().disposition == "QUARANTINE"
    with pytest.raises(DomainError):
        rt.receive(p["wh"].id, rr.id, location_id=f["loc_a"].id, return_date=D0)
    rr2 = rt.request_return(p["rep1"].id, o.id, reason="broken", reason_code="DAMAGED", lines=[{"order_line": ln.id, "quantity": "4", "disposition": "DISPOSE"}], today=D0)
    rt.decide(p["sm"].id, rr2.id, True)
    rt.receive(p["wh"].id, rr2.id, location_id=f["loc_a"].id, return_date=D0)
    assert stock(f) == 90  # disposed goods never re-enter stock
    ln.refresh_from_db()
    assert ln.returned_quantity == 10
    rep = rt.report(p["sm"].id)
    assert rep["by_status"] == {"RECEIVED": 2} and rep["by_reason"] == {"DEFECTIVE": 1, "DAMAGED": 1} and D(rep["received_by_disposition"]["DISPOSE"]) == 4
    assert rt.report(p["rep2"].id)["total"] == 0


@pytest.mark.django_db
def test_replacement_order_is_created_confirmed_and_free(f):
    p = f["people"]
    o, ln = delivered(f, "5")
    rr = rt.request_return(p["rep1"].id, o.id, reason="wrong item", reason_code="WRONG_ITEM", lines=[{"order_line": ln.id, "quantity": "2"}], replacement=True, today=D0)
    rt.decide(p["sm"].id, rr.id, True)
    rr = rt.receive(p["wh"].id, rr.id, location_id=f["loc_a"].id, return_date=D0)
    rep = sm.SalesOrder.objects.get(replacement_for=rr)
    assert rep.status == "CONFIRMED" and rep.total == 0 and rep.lines.get().quantity == 2
    assert rep.lines.get().reservation.quantity == 2
    deliver(f, rep)
    rep.refresh_from_db()
    assert rep.status == "DELIVERED"


@pytest.mark.django_db
def test_return_window_and_cancel(f):
    p = f["people"]
    o, ln = delivered(f)
    late = D0 + timedelta(days=45)
    with pytest.raises(DomainError) as e:
        rt.request_return(p["rep1"].id, o.id, reason="late", lines=[{"order_line": ln.id, "quantity": "1"}], today=late)
    assert e.value.get_codes() == "return_window_expired"
    rr = rt.request_return(p["sm"].id, o.id, reason="goodwill", lines=[{"order_line": ln.id, "quantity": "1"}], today=late)  # a manager may accept late returns
    with pytest.raises(DomainError):
        rt.decide(p["sm"].id, rr.id, True)  # their own request
    assert rt.cancel(p["sm"].id, rr.id).status == "CANCELLED"
    with pytest.raises(DomainError):
        rt.cancel(p["sm"].id, rr.id)
    nodelivery = confirmed(f)
    with pytest.raises(DomainError):
        rt.request_return(p["rep1"].id, nodelivery.id, reason="x", lines=[{"order_line": nodelivery.lines.get().id, "quantity": "1"}], today=D0)
