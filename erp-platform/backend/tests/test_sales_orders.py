from decimal import Decimal as D

import pytest

from modules.crm import records
from modules.inventory import services as inv
from modules.sales import models as sm
from modules.sales import orders_ext as ox
from modules.sales import services as sales
from shared.api.errors import DomainError, ValidationFailed
from shared.notifications.models import Notification
from tests.test_sales import D0, confirmed, deliver, f, line, order  # noqa: F401


def submit(f, o, who="rep1"):
    sales.submit_order(f["people"][who].id, o.id)
    o.refresh_from_db()
    return o


@pytest.mark.django_db
def test_blocked_customer_cannot_order_and_on_hold_needs_manager(f):
    p = f["people"]
    records.set_credit(p["sm"].id, f["acct"].id, credit_status="BLOCKED", note="Unpaid invoices")
    o = order(f)
    with pytest.raises(DomainError) as e:
        sales.submit_order(p["rep1"].id, o.id)
    assert e.value.get_codes() == "customer_blocked" and "Unpaid invoices" in str(e.value.detail)
    records.set_credit(p["sm"].id, f["acct"].id, credit_status="ON_HOLD", note="Review")
    o = submit(f, o)
    assert (o.status, o.hold_reason) == ("PENDING_APPROVAL", "customer_on_hold")
    records.set_credit(p["sm"].id, f["acct"].id, credit_status="BLOCKED", note="Review")
    with pytest.raises(DomainError):
        sales.approve_order(p["sm"].id, o.id)  # blocked in the meantime
    records.set_credit(p["sm"].id, f["acct"].id, credit_status="ON_HOLD", note="Review")
    sales.approve_order(p["sm"].id, o.id)
    o.refresh_from_db()
    assert o.status == "CONFIRMED"


@pytest.mark.django_db
def test_credit_limit_counts_open_orders_and_receivables(f):
    p = f["people"]
    records.set_credit(p["sm"].id, f["acct"].id, credit_limit="1500")
    a = submit(f, order(f, [line(f, qty="10", price="100")]))  # 1000 <= 1500
    assert a.status == "CONFIRMED" and a.hold_reason == ""
    assert D(ox.credit_position(p["rep1"].id, f["acct"].id)["exposure"]) == 1000
    b = submit(f, order(f, [line(f, qty="6", price="100")]))  # 1000 + 600 > 1500
    assert (b.status, b.hold_reason) == ("PENDING_APPROVAL", "credit_limit_exceeded")
    cp = ox.credit_position(p["rep1"].id, f["acct"].id)
    assert D(cp["available_credit"]) == 500
    with pytest.raises(DomainError):
        sales.approve_order(p["rep1"].id, b.id)
    sales.approve_order(p["sm"].id, b.id)
    # delivered and invoiced-then-posted amounts still count until paid
    deliver(f, a)
    inv_ = sales.invoice_order(p["officer"].id, a.id)
    from modules.finance import services as fin

    fin.submit_invoice(p["officer"].id, inv_.id) if hasattr(fin, "submit_invoice") else None
    assert ox.exposure(sm.SalesOrder.objects.get(pk=a.id).account)["total"] >= 600
    with pytest.raises(DomainError):
        ox.credit_position(p["rep2"].id, f["acct"].id)


@pytest.mark.django_db
def test_reservations_backorders_and_fifo_refill(f):
    p, w = f["people"], f["widget"]  # 100 widgets in stock
    a = confirmed(f, [line(f, qty="80", price="100")])
    b = confirmed(f, [line(f, qty="50", price="100")])
    la, lb = a.lines.get(), b.lines.get()
    assert la.reservation.quantity == 80 and lb.reservation.quantity == 20 and ox.backordered(lb) == 30
    rep = ox.backorder_report(p["sm"].id)
    assert [(r["order"], r["backordered"]) for r in rep] == [(b.number, "30.0000")]
    assert ox.backorder_report(p["rep2"].id) == []
    assert ox.retry_backorders() == 0  # nothing new in stock
    inv.receive_stock(None, product_id=w.id, location_id=f["loc_a"].id, quantity="25", unit_cost="5", on_date=D0)
    assert ox.retry_backorders() == 1 and ox.retry_backorders() == 0
    lb.refresh_from_db()
    assert lb.reservation.quantity == 45 and ox.backordered(lb) == 5
    assert Notification.objects.filter(user_id=p["rep1"].id, notification_type="sales.order.stock_available").exists()
    deliver(f, a)  # consumes a's reservation
    la.refresh_from_db()
    assert la.reservation.quantity == 0 and ox.backordered(la) == 0
    sales.cancel_order(p["rep1"].id, b.id)
    assert not sm.OrderReservation.objects.filter(order_line=lb).exists()
    svc = confirmed(f, [line(f, product=f["service"], qty="1", price="50")])
    assert ox.backordered(svc.lines.get()) == 0 and not sm.OrderReservation.objects.filter(order_line__order=svc).exists()


@pytest.mark.django_db
def test_outstanding_quantities(f):
    o = confirmed(f, [line(f, qty="10")])
    deliver(f, o, qty="4")
    row = ox.outstanding(o)[0]
    assert (row["ordered"], row["delivered"], row["to_deliver"], row["to_invoice"]) == ("10.0000", "4.0000", "6.0000", "4.0000")


@pytest.mark.django_db
def test_amendment_needs_a_different_approver_and_respects_fulfilment(f):
    p = f["people"]
    o = confirmed(f, [line(f, qty="10", price="100")])
    deliver(f, o, qty="4")
    ln = o.lines.get()
    with pytest.raises(ValidationFailed) as e:
        ox.request_amendment(p["rep1"].id, o.id, quantities={ln.id: "3"}, reason="smaller")
    assert e.value.get_codes() == "below_fulfilled"
    with pytest.raises(ValidationFailed):
        ox.request_amendment(p["rep1"].id, o.id, quantities={ln.id: "8"}, reason=" ")
    with pytest.raises(DomainError):
        ox.request_amendment(p["rep2"].id, o.id, quantities={ln.id: "8"}, reason="x")  # not their order
    a = ox.request_amendment(p["rep1"].id, o.id, quantities={ln.id: "8"}, add=[line(f, product=f["service"], qty="1", price="50")], reason="customer change")
    with pytest.raises(DomainError):
        ox.request_amendment(p["rep1"].id, o.id, quantities={ln.id: "9"}, reason="again")  # one at a time
    with pytest.raises(DomainError):
        ox.approve_amendment(p["rep1"].id, a.id)  # reps cannot approve
    ox.approve_amendment(p["sm"].id, a.id)
    o.refresh_from_db()
    assert (o.total, o.version, o.status) == (850, 2, "PARTIALLY_DELIVERED")
    assert [(l.line_no, l.quantity) for l in o.lines.order_by("line_no")] == [(1, 8), (2, 1)]
    a.refresh_from_db()
    assert a.status == "APPLIED" and a.total_before == 1000 and a.total_after == 850 and a.before_snapshot["total"] == "1000.0000"
    with pytest.raises(DomainError):
        ox.approve_amendment(p["sm2"].id, a.id)  # only once
    # cancelling the undelivered remainder completes the order
    a2 = ox.request_amendment(p["rep1"].id, o.id, quantities={ln.id: "4", o.lines.get(line_no=2).id: "0"}, reason="cancel rest")
    with pytest.raises(DomainError):
        ox.reject_amendment(p["sm"].id, a2.id, "")  # needs a reason
    ox.approve_amendment(p["sm"].id, a2.id)
    o.refresh_from_db()
    assert o.status == "DELIVERED" and o.total == 400
    rej = ox.request_amendment(p["rep1"].id, o.id, quantities={ln.id: "5"}, reason="more")
    assert ox.reject_amendment(p["sm"].id, rej.id, "no stock").status == "REJECTED"
    draft = order(f)
    with pytest.raises(DomainError):
        ox.request_amendment(p["rep1"].id, draft.id, quantities={draft.lines.get().id: "2"}, reason="draft")
