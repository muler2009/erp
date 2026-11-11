"""Daily logistics housekeeping: detect late shipments (auto delay exception, once) and remind about shipments not dispatched on time."""
from django.db import transaction
from django.utils import timezone

from modules.supply_chain import logistics
from modules.supply_chain import models as m
from shared.notifications.services import notify

SYSTEM = None


@transaction.atomic
def late_shipments(today):
    n = 0
    for s in m.Shipment.objects.select_for_update(of=("self",)).filter(status__in=("DISPATCHED", "IN_TRANSIT"), planned_arrival__lt=today):
        if m.DeliveryException.objects.filter(shipment=s, kind="DELAY", status="OPEN", auto_detected=True).exists():
            continue
        logistics.report_exception(None, s.id, kind="DELAY", severity="MEDIUM", description=f"Planned arrival {s.planned_arrival} has passed.", auto=True)
        n += 1
    return n


@transaction.atomic
def undispatched_reminders(today):
    n = 0
    for s in m.Shipment.objects.select_for_update(of=("self",)).filter(status="PLANNED", planned_dispatch__lt=today):
        if s.last_reminder_on and (today - s.last_reminder_on).days < 3:
            continue
        notify([s.created_by], "supply_chain.not_dispatched", f"Shipment {s.number} should have been dispatched on {s.planned_dispatch}", "Dispatch it, reschedule or cancel.", ref_type="supply_chain.shipment", ref_id=str(s.id))
        s.last_reminder_on = today
        s.save(update_fields=["last_reminder_on", "updated_at"])
        n += 1
    return n


def run_daily():
    today = timezone.now().date()
    from modules.supply_chain import risk
    return {"late": late_shipments(today), "reminders": undispatched_reminders(today), "risk_reminders": risk.daily(today)}
