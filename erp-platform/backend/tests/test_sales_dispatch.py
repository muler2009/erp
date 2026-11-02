from datetime import date, datetime, timedelta, timezone as tz

import pytest

from modules.crm import models as cm
from modules.sales import dispatch as dp
from modules.sales import models as sm
from modules.sales import services as sales
from shared.api.errors import DomainError, ValidationFailed
from shared.notifications.models import Notification
from tests.test_sales import D0, confirmed, deliver, f, line  # noqa: F401

PNG = bytes.fromhex("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000001e221bc330000000049454e44ae426082")


def ship(f, qty="10", expected=None):
    o = confirmed(f, [line(f, qty=qty)])
    d = sales.create_delivery(f["people"]["wh"].id, o.id, location_id=f["loc_a"].id, delivery_date=D0, lines=[{"order_line": str(o.lines.get().id), "quantity": qty}], carrier="DHL", expected_date=expected)
    return o, d


@pytest.mark.django_db
def test_dispatch_confirm_with_pod_and_permissions(f):
    p = f["people"]
    o, d = ship(f)
    assert d.status == "DISPATCHED"
    with pytest.raises(DomainError):
        dp.confirm_delivered(p["rep1"].id, d.id, received_by="Ann")  # reps do not run logistics
    with pytest.raises(ValidationFailed):
        dp.confirm_delivered(p["wh"].id, d.id, received_by=" ")
    with pytest.raises(ValidationFailed):
        dp.confirm_delivered(p["wh"].id, d.id, received_by="Ann", delivered_at=datetime(2026, 1, 1, tzinfo=tz.utc))  # before dispatch
    d = dp.confirm_delivered(p["wh"].id, d.id, received_by="Ann", note="gate 2", pod=("pod.png", PNG), delivered_at=datetime(2026, 3, 16, 10, tzinfo=tz.utc))
    assert (d.status, d.received_by) == ("DELIVERED", "Ann")
    assert [a.original_name for a in dp.attachments(p["rep1"].id, d.id)] == ["pod.png"]
    with pytest.raises(DomainError):
        dp.attachments(p["rep2"].id, d.id)  # another rep's customer
    with pytest.raises(DomainError):
        dp.confirm_delivered(p["wh"].id, d.id, received_by="Ann")  # once
    from shared.files import services as files

    assert files.can_access(p["rep1"].id, dp.attachments(p["rep1"].id, d.id)[0]) and not files.can_access(p["rep2"].id, dp.attachments(p["rep1"].id, d.id)[0])


@pytest.mark.django_db
def test_discrepancy_opens_a_customer_service_case(f):
    p = f["people"]
    o, d = ship(f)
    ln = o.lines.get()
    for bad in ({"order_line": ln.id, "kind": "LOST", "quantity": "1"}, {"order_line": ln.id, "kind": "SHORT", "quantity": "99"}, {"order_line": "00000000-0000-0000-0000-000000000000", "kind": "SHORT", "quantity": "1"}):
        with pytest.raises(ValidationFailed):
            dp.confirm_delivered(p["wh"].id, d.id, received_by="Ann", discrepancies=[bad])
    d.refresh_from_db()
    assert d.status == "DISPATCHED"  # nothing half-applied
    d = dp.confirm_delivered(p["wh"].id, d.id, received_by="Ann", discrepancies=[{"order_line": ln.id, "kind": "DAMAGED", "quantity": "2", "note": "crushed boxes"}])
    x = d.discrepancies.get()
    case = cm.ServiceCase.objects.get(pk=x.case_id)
    assert case.delivery_id == d.id and case.order_id == o.id and case.owner_id is None or case.created_by == p["rep1"].id
    assert case.category == "Delivery" and "DAMAGED" in case.subject and case.account_id == f["acct"].id


@pytest.mark.django_db
def test_failed_delivery_late_notice_and_performance(f):
    p = f["people"]
    o1, d1 = ship(f, "5", expected=D0 + timedelta(days=2))
    o2, d2 = ship(f, "5", expected=D0 + timedelta(days=2))
    o3, d3 = ship(f, "5")
    with pytest.raises(ValidationFailed):
        dp.mark_failed(p["wh"].id, d2.id, " ")
    dp.mark_failed(p["wh"].id, d2.id, "Nobody home")
    assert Notification.objects.filter(user_id=p["rep1"].id, notification_type="sales.delivery.failed").exists()
    with pytest.raises(DomainError):
        dp.confirm_delivered(p["wh"].id, d2.id, received_by="x")
    assert dp.notify_late(D0 + timedelta(days=1)) == 0
    assert dp.notify_late(D0 + timedelta(days=3)) == 1 and dp.notify_late(D0 + timedelta(days=3)) == 0
    dp.set_expected(p["wh"].id, d3.id, D0 + timedelta(days=10))
    with pytest.raises(ValidationFailed):
        dp.set_expected(p["wh"].id, d3.id, D0 - timedelta(days=1))
    dp.confirm_delivered(p["wh"].id, d1.id, received_by="Bob", delivered_at=datetime(2026, 3, 16, tzinfo=tz.utc))
    r = dp.performance(p["rep1"].id, today=D0 + timedelta(days=3))
    assert r["by_status"] == {"DELIVERED": 1, "FAILED": 1, "DISPATCHED": 1} and r["on_time_percent"] == 100.0 and r["avg_transit_days"] == 1.0
    assert r["by_carrier"]["DHL"] == {"deliveries": 3, "failed": 1} and r["late_now"] == 0
    assert dp.performance(p["rep2"].id)["total"] == 0
