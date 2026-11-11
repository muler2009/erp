"""Daily inventory jobs. Each step is idempotent (alerts are de-duplicated per day by reference)."""
from django.utils import timezone

from modules.inventory import availability


def run_daily():
    from platform_core.authorization.models import RoleAssignment
    from shared.notifications.services import notify

    today = timezone.now().date()
    rows = availability.alerts(today)
    if not rows:
        return {"alerts": 0}
    ids = list(RoleAssignment.objects.filter(role__name__in=["inventory_manager", "warehouse_staff"]).values_list("user_id", flat=True).distinct())
    if ids:
        notify(ids, "inventory.alerts", f"{len(rows)} stock alerts", ", ".join(sorted({r["alert"] for r in rows})), ref_type="inventory.alerts", ref_id=str(today))
    return {"alerts": len(rows)}
