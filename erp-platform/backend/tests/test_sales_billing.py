from datetime import timedelta
from decimal import Decimal as D

import pytest

from modules.finance import services as fin
from modules.sales import billing as bl
from modules.sales import services as sales
from shared.api.errors import DomainError, ValidationFailed
from shared.notifications.models import Notification
from tests.test_sales import D0, confirmed, deliver, f, line  # noqa: F401


def post_invoice(f, inv):
    p = f["people"]
    fin.submit_invoice(p["sm"].id, inv.id)
    fin.approve_invoice(p["mgr"].id, inv.id)
    fin.post_invoice(p["ctrl"].id, inv.id)
    inv.refresh_from_db()
    return inv


@pytest.mark.django_db
def test_milestone_billing_adds_up_exactly_and_excludes_delivery_billing(f):
    p = f["people"]
    o = confirmed(f, [line(f, qty="3", price="33.33")])  # 99.99
    ms = bl.set_milestones(p["sm"].id, o.id, [{"description": "Deposit", "percent": "33.33"}, {"description": "On delivery", "percent": "33.33"}, {"description": "Final", "percent": "33.34"}])
    with pytest.raises(ValidationFailed):
        bl.set_milestones(p["sm"].id, o.id, [{"description": "x", "percent": "50"}])
    with pytest.raises(DomainError):
        bl.set_milestones(p["rep1"].id, o.id, [{"description": "x", "percent": "100"}])  # reps do not bill
    invoices = [bl.invoice_milestone(p["sm"].id, x.id, invoice_date=D0) for x in ms]
    assert sum(i.subtotal for i in invoices) == D("99.99")
    with pytest.raises(DomainError):
        bl.invoice_milestone(p["sm"].id, ms[0].id)  # once
    with pytest.raises(DomainError):
        bl.set_milestones(p["sm"].id, o.id, [{"description": "x", "percent": "100"}])  # already invoiced
    deliver(f, o)
    with pytest.raises(DomainError) as e:
        sales.invoice_order(p["sm"].id, o.id)
    assert e.value.get_codes() == "billed_by_milestone"


@pytest.mark.django_db
def test_statement_and_aging_buckets(f):
    p = f["people"]
    inv = {}
    for name, qty, days in (("recent", "1", 0), ("old", "2", -45), ("ancient", "3", -120)):
        o = confirmed(f, [line(f, qty=qty, price="100")])
        deliver(f, o)
        i = sales.invoice_order(p["sm"].id, o.id, invoice_date=D0 + timedelta(days=200 + days))
        inv[name] = post_invoice(f, i)
    as_of = D0 + timedelta(days=200 + 30)  # due dates are invoice date + 30
    ag = bl.aging(p["rep1"].id, as_of, "USD")
    row = ag["customers"][0]
    assert (D(ag["total"]), D(row["current"]), D(row["1-30"]), D(row["31-60"]), D(row["90+"])) == (600, 100, 0, 200, 300)
    assert sum(D(v) for v in ag["totals"].values()) == 600
    assert bl.aging(p["rep2"].id, as_of, "USD")["customers"] == []
    st = bl.statement(p["rep1"].id, f["acct"].id, D0 + timedelta(days=50), D0 + timedelta(days=300), "USD")
    assert [l["type"] for l in st["lines"]] == ["INVOICE"] * 3 and st["closing_balance"] in ("600.0000", "600")
    assert D(st["opening_balance"]) == 0
    later = bl.statement(p["rep1"].id, f["acct"].id, D0 + timedelta(days=100), D0 + timedelta(days=300), "USD")
    assert D(later["opening_balance"]) == 300 and D(later["closing_balance"]) == 600
    with pytest.raises(DomainError):
        bl.statement(p["rep2"].id, f["acct"].id, D0, D0, "USD")
    with pytest.raises(ValidationFailed):
        bl.statement(p["rep1"].id, f["acct"].id, D0 + timedelta(days=5), D0, "USD")


@pytest.mark.django_db
def test_overdue_reminders_are_graduated_and_not_repeated(f):
    p = f["people"]
    o = confirmed(f, [line(f, qty="1", price="100")])
    deliver(f, o)
    i = post_invoice(f, sales.invoice_order(p["sm"].id, o.id, invoice_date=D0))
    due = i.due_date
    assert bl.send_overdue_reminders(due) == 0  # not overdue yet
    assert bl.send_overdue_reminders(due + timedelta(days=1)) == 1 and bl.send_overdue_reminders(due + timedelta(days=2)) == 0
    assert bl.send_overdue_reminders(due + timedelta(days=16)) == 1  # second level
    assert bl.send_overdue_reminders(due + timedelta(days=40)) == 1 and bl.send_overdue_reminders(due + timedelta(days=60)) == 0
    assert Notification.objects.filter(user_id=p["rep1"].id, notification_type="sales.invoice.overdue").count() == 3
