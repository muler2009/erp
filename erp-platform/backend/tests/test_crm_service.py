from datetime import datetime, timedelta, timezone as tz

import pytest

from modules.crm import models as cm
from modules.crm import records as rec
from modules.crm import service_desk as sd
from modules.crm import services as crm
from shared.api.errors import DomainError, ValidationFailed
from shared.events.models import OutboxEvent
from shared.notifications.models import Notification
from tests.test_sales import D0, f, line, order  # noqa: F401

PNG = bytes.fromhex("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000001e221bc330000000049454e44ae426082")


def case(f, who="rep1", **kw):
    return sd.open_case(f["people"][who].id, account_id=f["acct"].id, subject="Late delivery", **{"priority": "HIGH", **kw})


@pytest.mark.django_db
def test_case_gets_sla_targets_and_validates_links(f):
    p = f["people"]
    c = case(f)
    assert c.number.startswith("CS-") and c.status == "NEW"
    assert c.due_at - c.created_at == timedelta(hours=24) and c.first_response_due - c.created_at == timedelta(hours=4)
    for bad in ({"priority": "ASAP"}, {"severity": "HUGE"}, {"kind": "RUMOUR"}, {"subject": " "}):
        with pytest.raises(ValidationFailed):
            sd.open_case(p["rep1"].id, account_id=f["acct"].id, **{"subject": "x", **bad})
    other = crm.create_account(p["rep1"].id, name="Other Co")
    with pytest.raises(DomainError):
        sd.open_case(p["rep2"].id, account_id=f["acct"].id, subject="x")  # not their account
    o = order(f)  # belongs to f["acct"]
    ok = sd.open_case(p["rep1"].id, account_id=f["acct"].id, subject="Wrong qty", order_id=o.id)
    assert ok.order_id == o.id
    with pytest.raises(ValidationFailed) as x:
        sd.open_case(p["rep1"].id, account_id=other.id, subject="Not theirs", order_id=o.id)
    assert x.value.get_codes() == "invalid_link"
    with pytest.raises(ValidationFailed):
        sd.open_case(p["rep1"].id, account_id=f["acct"].id, subject="No partner invoice", invoice_id="00000000-0000-0000-0000-000000000000")
    sd.configure_sla(p["sm"].id, "HIGH", 2, 12)
    assert case(f).due_at - cm.ServiceCase.objects.latest("created_at").created_at == timedelta(hours=12)
    with pytest.raises(DomainError):
        sd.configure_sla(p["rep1"].id, "HIGH", 1, 2)
    with pytest.raises(ValidationFailed):
        sd.configure_sla(p["sm"].id, "HIGH", 5, 2)


@pytest.mark.django_db
def test_lifecycle_response_clock_resolution_feedback_and_close(f):
    p = f["people"]
    c = case(f, who="rep1")
    c = sd.assign_case(p["sm"].id, c.id, p["rep2"].id, team="Support")
    assert c.status == "OPEN" and c.owner_id == p["rep2"].id
    assert Notification.objects.filter(user_id=p["rep2"].id, notification_type="crm.case.assigned").exists()
    with pytest.raises(DomainError):
        sd.assign_case(p["rep1"].id, c.id, p["rep1"].id)
    sd.add_comment(p["rep2"].id, c.id, "Looking into it", internal=True)
    c.refresh_from_db()
    assert c.first_responded_at is None  # internal notes do not stop the response clock
    sd.add_comment(p["rep2"].id, c.id, "We are checking with the carrier")
    c.refresh_from_db()
    assert c.first_responded_at is not None
    assert [x.text for x in sd.comments_for(p["rep2"].id, c.id, customer_view=True)] == ["We are checking with the carrier"]
    assert sd.set_status(p["rep2"].id, c.id, "PENDING_CUSTOMER", "waiting for photos").status == "PENDING_CUSTOMER"
    sd.set_status(p["rep2"].id, c.id, "OPEN")
    with pytest.raises(ValidationFailed):
        sd.resolve_case(p["rep2"].id, c.id, " ")
    with pytest.raises(DomainError):
        sd.close_case(p["rep2"].id, c.id)  # not resolved yet
    r = sd.resolve_case(p["rep2"].id, c.id, "Re-delivered on Monday")
    assert r.status == "RESOLVED" and OutboxEvent.objects.filter(event_type="crm.case.resolved").count() == 1
    with pytest.raises(ValidationFailed):
        sd.record_feedback(p["rep2"].id, c.id, 9)
    assert sd.record_feedback(p["rep2"].id, c.id, 4, "Fine").satisfaction == 4
    with pytest.raises(DomainError):
        sd.record_feedback(p["rep2"].id, c.id, 5)
    assert sd.close_case(p["rep2"].id, c.id).status == "CLOSED"
    with pytest.raises(DomainError):
        sd.add_comment(p["rep2"].id, c.id, "late")
    reopened = case(f)
    sd.resolve_case(p["rep1"].id, reopened.id, "x")
    assert sd.set_status(p["rep1"].id, reopened.id, "OPEN").resolution == ""  # reopening clears the resolution
    with pytest.raises(ValidationFailed):
        sd.cancel_case(p["rep1"].id, reopened.id, " ")
    assert sd.cancel_case(p["rep1"].id, reopened.id, "Raised twice").status == "CANCELLED"


@pytest.mark.django_db
def test_escalation_levels_are_idempotent_and_notify_managers(f):
    p = f["people"]
    c = case(f, priority="URGENT")  # 8h target
    c = sd.assign_case(p["sm"].id, c.id, p["rep1"].id)
    soon = c.created_at + timedelta(hours=7)
    assert sd.escalate_overdue(soon) == 0
    late = c.created_at + timedelta(hours=9)
    assert sd.escalate_overdue(late) == 1 and sd.escalate_overdue(late) == 0
    c.refresh_from_db()
    assert c.escalation_level == 1
    assert Notification.objects.filter(user_id=p["sm"].id, notification_type="crm.case.escalated").count() == 1
    assert sd.sla_state(c, late)["resolution_breached"] is True
    later = c.created_at + timedelta(hours=13)  # beyond 8h + half the window
    assert sd.escalate_overdue(later) == 1
    c.refresh_from_db()
    assert c.escalation_level == 2
    assert OutboxEvent.objects.filter(event_type="crm.case.escalated").count() == 2
    sd.resolve_case(p["rep1"].id, c.id, "done")
    assert sd.escalate_overdue(later + timedelta(days=5)) == 0  # resolved cases are not escalated


@pytest.mark.django_db
def test_visibility_attachments_and_timeline(f):
    p = f["people"]
    c = case(f)
    assert sd.visible(p["rep2"].id).count() == 0 and sd.visible(p["sm"].id).count() == 1
    with pytest.raises(DomainError):
        sd.get_case(p["rep2"].id, c.id)
    up = sd.attach_file(p["rep1"].id, c.id, "damage.png", PNG)
    assert [a.id for a in sd.attachments(p["rep1"].id, c.id)] == [up.id]
    from shared.files import services as files

    assert files.can_access(p["sm"].id, up) and not files.can_access(p["rep2"].id, up)
    with pytest.raises(DomainError):
        sd.attachments(p["rep2"].id, c.id)
    tl = rec.account_timeline(p["rep1"].id, f["acct"].id)
    assert any(e["kind"] == "case" and c.number in e["summary"] for e in tl)


@pytest.mark.django_db
def test_service_report(f):
    p = f["people"]
    a = case(f, category="Delivery", kind="COMPLAINT")
    b = case(f, category="Billing", kind="INQUIRY", priority="LOW")
    sd.resolve_case(p["rep1"].id, a.id, "fixed")
    sd.record_feedback(p["rep1"].id, a.id, 5)
    r = sd.service_report(p["sm"].id)
    assert (r["total"], r["open"], r["complaints"], r["avg_satisfaction"], r["sla_met_percent"]) == (2, 1, 1, 5.0, 100.0)
    assert r["by_category"] == {"Delivery": 1, "Billing": 1}
    assert sd.service_report(p["rep2"].id)["total"] == 0
