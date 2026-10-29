"""HR reminders: probation, contract, document and certificate expiries go to HR once per item and day; leave
decisions and new leave requests notify the people concerned."""
from datetime import timedelta

from django.utils import timezone

from modules.hr import lifecycle
from modules.hr import models as m
from platform_core.authorization import services as authz
from platform_core.users.models import TenantMembership
from shared.notifications import services as notifications
from shared.notifications.models import Notification
from shared.tenancy import current_tenant

TYPE = "hr.reminder"


def _hr_users():
    ids = TenantMembership.objects.filter(tenant=current_tenant(), status="ACTIVE").values_list("user_id", flat=True)
    return [u for u in ids if authz.has_permission(u, "hr.employee.manage")]


def send_daily(today=None, within_days=30):
    """Idempotent: an item already announced today is not announced again. Returns the number of reminders created."""
    today = today or timezone.now().date()
    recipients = _hr_users()
    if not recipients:
        return 0
    # the monitoring helper is scoped by user; HR managers see everyone
    items = []
    mon = lifecycle.monitoring(recipients[0], within_days=within_days, today=today)
    for r in mon["probation_ending"]:
        items.append(("probation", r["employee"], f"Probation ends {r['probation_end']}: {r['name']}"))
    for r in mon["contracts_expiring"]:
        items.append(("contract", r["employee"], f"Contract ends {r['end_date']}: {r['name']}"))
    for r in mon["documents_expiring"]:
        items.append(("document", r["employee"] + r["title"], f"Document '{r['title']}' of {r['employee']} expires {r['expires_on']}"))
    for r in mon["qualifications_expiring"]:
        items.append(("qualification", r["employee"] + r["title"], f"Qualification '{r['title']}' of {r['employee']} expires {r['expires_on']}"))
    for r in mon["retirements"]:
        items.append(("retirement", r["employee"], f"Retirement date {r['retirement_date']}: {r['name']}"))
    created = 0
    for kind, key, title in items:
        ref = f"{kind}:{key}:{today}"
        for u in recipients:
            if Notification.objects.filter(user_id=u, notification_type=TYPE, ref_id=ref).exists():
                continue
            notifications.notify([u], TYPE, title, ref_type="hr_reminder", ref_id=ref)
            created += 1
    return created


def leave_requested(req):
    mgr = req.employee.manager
    if mgr is not None and mgr.user_id:
        notifications.notify([mgr.user_id], "hr.leave.requested", f"Leave request from {req.employee.name}", f"{req.start_date} to {req.end_date}", ref_type="LeaveRequest", ref_id=req.id)


def leave_decided(req):
    if req.employee.user_id:
        notifications.notify([req.employee.user_id], "hr.leave.decided", f"Your leave request was {req.status.lower()}", req.decision_note, ref_type="LeaveRequest", ref_id=req.id)
