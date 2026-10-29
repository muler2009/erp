from datetime import date, timedelta

import pytest

from modules.hr import models as hm
from modules.hr import reminders
from modules.hr import services as hr
from shared.notifications.models import Notification
from tests.test_hr import f, hire  # noqa: F401


@pytest.mark.django_db
def test_daily_reminders_go_to_hr_once_per_item(f):
    p = f["people"]
    e = hire(f, "Fixed", contract=False)
    today = date.today()
    hr.add_contract(p["hrm"].id, e.id, start_date=e.hire_date, monthly_salary="1000", currency="USD", kind="FIXED_TERM", end_date=today + timedelta(days=20))
    n = reminders.send_daily(today)
    assert n >= 2  # HR manager and HR officer
    rows = Notification.objects.filter(notification_type="hr.reminder")
    assert {r.user_id for r in rows} >= {p["hrm"].id, p["hro"].id}
    assert not rows.filter(user_id=p["e1"].id).exists()  # employees are not told about HR deadlines
    assert any("Contract ends" in r.title for r in rows)
    assert reminders.send_daily(today) == 0  # the same day again: nothing new


@pytest.mark.django_db
def test_leave_request_and_decision_notify_the_right_people(f):
    p = f["people"]
    boss = hire(f, "Boss", "dm")
    e = hire(f, "Staff", "e1", manager=boss)
    hr.allocate_leave(p["hrm"].id, e.id, leave_type=hm.LeaveType.objects.get(code="ANNUAL").id, year=2026, days=5)
    r = hr.request_leave(p["e1"].id, e.id, leave_type=hm.LeaveType.objects.get(code="ANNUAL").id, start_date=date(2026, 9, 7), end_date=date(2026, 9, 7))
    assert Notification.objects.filter(user_id=p["dm"].id, notification_type="hr.leave.requested").count() == 1
    assert not Notification.objects.filter(user_id=p["e2"].id).exists()
    hr.decide_leave(p["dm"].id, r.id, approve=True)
    n = Notification.objects.get(user_id=p["e1"].id, notification_type="hr.leave.decided")
    assert "approved" in n.title
