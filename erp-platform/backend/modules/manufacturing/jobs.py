from django.db import transaction
from django.utils import timezone

from modules.manufacturing import models as m
from shared.notifications.services import notify


@transaction.atomic
def overdue_order_reminders(today):
    sent = 0
    for o in m.ProductionOrder.objects.select_for_update(of=("self",)).filter(status__in=("RELEASED", "IN_PROGRESS"), planned_end__lt=today):
        if o.last_reminder_on and (today - o.last_reminder_on).days < 7:
            continue
        notify([o.created_by], "manufacturing.order_overdue", f"Production order {o.number} is past its planned end ({o.planned_end})", "Finish, complete short or reschedule it.", ref_type="manufacturing.order", ref_id=str(o.id))
        o.last_reminder_on = today
        o.save(update_fields=["last_reminder_on", "updated_at"])
        sent += 1
    return sent


def run_daily():
    return {"overdue_reminders": overdue_order_reminders(timezone.now().date())}
