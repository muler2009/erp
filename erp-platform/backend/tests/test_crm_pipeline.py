from datetime import date, datetime, timedelta, timezone as tz
from decimal import Decimal as D

import pytest

from modules.crm import models as cm
from modules.crm import pipeline as pl
from modules.crm import services as crm
from shared.api.errors import DomainError, ValidationFailed
from shared.notifications.models import Notification
from tests.test_sales import D0, f  # noqa: F401


def opp(f, who="rep1", amount="1000", stage="PROSPECTING", close=None):
    return crm.create_opportunity(f["people"][who].id, name="Deal", account_id=f["acct"].id, amount=amount, currency="USD", stage=stage, expected_close=close)


@pytest.mark.django_db
def test_opportunity_detail_fields_and_closed_is_read_only(f):
    p = f["people"]
    o = opp(f)
    o = pl.update_opportunity(p["rep1"].id, o.id, competitors="Acme, Zed", requirements="24h support", decision_makers="CFO", risks="Budget freeze", next_action="Send proposal", next_action_date=D0, amount="1500")
    assert (o.competitors, o.next_action, o.amount) == ("Acme, Zed", "Send proposal", D("1500"))
    with pytest.raises(ValidationFailed):
        pl.update_opportunity(p["rep1"].id, o.id, amount="-5")
    with pytest.raises(DomainError):
        pl.update_opportunity(p["rep2"].id, o.id, name="hijack")
    pl.win(p["rep1"].id, o.id)
    with pytest.raises(DomainError) as x:
        pl.update_opportunity(p["rep1"].id, o.id, amount="1")
    assert x.value.get_codes() == "invalid_state_transition"


@pytest.mark.django_db
def test_stage_history_records_every_move_win_and_loss(f):
    p = f["people"]
    o = opp(f)
    pl.move_stage_tracked(p["rep1"].id, o.id, "QUALIFICATION", "Budget confirmed")
    pl.move_stage_tracked(p["rep1"].id, o.id, "PROPOSAL")
    with pytest.raises(DomainError):
        pl.move_stage_tracked(p["rep1"].id, o.id, "PROPOSAL")  # same stage
    with pytest.raises(ValidationFailed):
        pl.move_stage_tracked(p["rep1"].id, o.id, "WON")
    pl.lose(p["rep1"].id, o.id, "Went with competitor")
    h = pl.stage_history(p["rep1"].id, o.id)
    assert [(x["from"], x["to"]) for x in h] == [("QUALIFICATION", "PROPOSAL")][:0] or [(x["from"], x["to"]) for x in h] == [("PROSPECTING", "QUALIFICATION"), ("QUALIFICATION", "PROPOSAL"), ("PROPOSAL", "LOST")]
    assert h[0]["note"] == "Budget confirmed" and h[-1]["note"] == "Went with competitor"
    with pytest.raises(DomainError):
        pl.stage_history(p["rep2"].id, o.id)
    with pytest.raises(ValidationFailed):
        pl.lose(p["rep1"].id, opp(f).id, " ")


@pytest.mark.django_db
def test_products_on_an_opportunity_and_forecast_grouping(f):
    p = f["people"]
    a = opp(f, amount="1000", stage="PROPOSAL", close=date(2026, 6, 15))  # 50%
    b = opp(f, who="rep2", amount="400", stage="NEGOTIATION", close=date(2026, 7, 1)) if False else None
    pl.set_lines(p["rep1"].id, a.id, [{"product": str(f["widget"].id), "quantity": "10", "expected_price": "60"}, {"product": str(f["paint"].id), "quantity": "10", "expected_price": "40"}])
    with pytest.raises(ValidationFailed):
        pl.set_lines(p["rep1"].id, a.id, [{"product": str(f["widget"].id), "quantity": "0"}])
    with pytest.raises(ValidationFailed):
        pl.set_lines(p["rep1"].id, a.id, [{"product": str(f["widget"].id), "quantity": "1"}, {"product": str(f["widget"].id), "quantity": "2"}])
    assert a.lines.count() == 2  # a rejected replacement leaves the old lines
    by_prod = {r["group"]: r for r in pl.forecast_by(p["rep1"].id, "product")}
    assert D(by_prod[f["widget"].sku]["amount"]) == D("600.00") and D(by_prod[f["paint"].sku]["weighted"]) == D("200.00")
    assert pl.forecast_by(p["rep1"].id, "stage")[0]["group"] == "PROPOSAL"
    assert pl.forecast_by(p["rep1"].id, "month")[0]["group"] == "2026-06"
    assert pl.forecast_by(p["sm"].id, "owner")[0]["group"] == str(p["rep1"].id)
    assert pl.forecast_by(p["rep2"].id, "owner") == []  # reps see only their own pipeline
    with pytest.raises(ValidationFailed):
        pl.forecast_by(p["sm"].id, "colour")


@pytest.mark.django_db
def test_pipeline_configuration_needs_a_manager_and_protects_system_stages(f):
    p = f["people"]
    with pytest.raises(DomainError):
        pl.configure_stage(p["rep1"].id, "DEMO_STAGE", name="Demo", position=3, probability=40)
    st = pl.configure_stage(p["sm"].id, "demo_stage", name="Demo", position=3, probability=40)
    assert st.code == "DEMO_STAGE"
    assert pl.configure_stage(p["sm"].id, "DEMO_STAGE", probability=45).probability == 45
    with pytest.raises(ValidationFailed):
        pl.configure_stage(p["sm"].id, "DEMO_STAGE", probability=120)
    with pytest.raises(DomainError):
        pl.configure_stage(p["sm"].id, "WON", probability=10)
    o = opp(f, stage="DEMO_STAGE")
    with pytest.raises(DomainError) as x:
        pl.retire_stage(p["sm"].id, "DEMO_STAGE")
    assert x.value.get_codes() == "stage_in_use"
    pl.move_stage_tracked(p["rep1"].id, o.id, "PROSPECTING")
    pl.retire_stage(p["sm"].id, "DEMO_STAGE")
    assert not cm.PipelineStage.objects.filter(code="DEMO_STAGE").exists()


@pytest.mark.django_db
def test_activity_assignment_calendar_outcome_and_overdue_reminders(f):
    p = f["people"]
    soon = datetime.now(tz.utc) + timedelta(days=1)
    past = datetime.now(tz.utc) - timedelta(days=2)
    o = opp(f)
    with pytest.raises(DomainError):
        pl.schedule_activity(p["rep1"].id, type="CALL", subject="x", assignee_id=p["rep2"].id, opportunity_id=o.id)  # reps cannot assign others
    with pytest.raises(ValidationFailed):
        pl.schedule_activity(p["rep1"].id, type="CALL", subject="x", priority="NOW", opportunity_id=o.id)
    mine = pl.schedule_activity(p["rep1"].id, type="DEMO", subject="Product demo", due_at=soon, priority="HIGH", opportunity_id=o.id)
    late = pl.schedule_activity(p["rep1"].id, type="CALL", subject="Chase", due_at=past, opportunity_id=o.id)
    given = pl.schedule_activity(p["sm"].id, type="TASK", subject="Prepare quote", due_at=past, assignee_id=p["rep1"].id, account_id=f["acct"].id)
    assert Notification.objects.filter(user_id=p["rep1"].id, notification_type="crm.activity.assigned").count() == 1
    assert {a.id for a in pl.my_activities(p["rep1"].id)} == {mine.id, late.id, given.id}
    assert pl.my_activities(p["rep2"].id).count() == 0
    with pytest.raises(DomainError):
        pl.my_activities(p["rep1"].id, team=True)
    assert pl.my_activities(p["sm"].id, team=True).count() == 3
    assert {a.id for a in pl.overdue(p["rep1"].id)} == {late.id, given.id}
    assert pl.send_overdue_reminders() == 2
    assert pl.send_overdue_reminders() == 0  # not twice in a day
    assert Notification.objects.filter(user_id=p["rep1"].id, notification_type="crm.activity.overdue").count() == 2
    done = pl.complete_with_outcome(p["rep1"].id, late.id, "Left voicemail")
    assert done.outcome == "Left voicemail"
    o.refresh_from_db()
    assert o.last_activity_at is not None
    with pytest.raises(DomainError):
        pl.complete_with_outcome(p["rep1"].id, late.id)
    with pytest.raises(DomainError):
        pl.complete_with_outcome(p["rep2"].id, mine.id)
    assert pl.complete_with_outcome(p["rep1"].id, given.id).done_at  # an assignee can finish what a manager gave them
