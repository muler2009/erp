"""Daily housekeeping for one tenant; every step is idempotent so a re-run does no harm."""
from django.utils import timezone

from modules.assets import custody, fleet, inspections, maintenance, warranty


def run_daily(today=None):
    today = today or timezone.now().date()
    out = {}
    out["maintenance"] = maintenance.run_daily(today)
    out["inspections_scheduled"] = inspections.schedule_due(None, today)
    out["expiry_reminders"] = warranty.run_reminders(today) + fleet.run_reminders(today)
    out["custody_reminders"] = custody.run_reminders(today)
    return out
