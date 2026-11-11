"""Daily procurement jobs. Each step is idempotent."""
from django.utils import timezone

from modules.procurement import requisitions_ext, suppliers


def run_daily():
    from platform_core.authorization.models import RoleAssignment
    from shared.notifications.services import notify

    today = timezone.now().date()
    from modules.procurement import contracts

    out = {"recurring": requisitions_ext.run_recurring(today), "contracts": contracts.run_daily(today)}
    docs = suppliers.expiring_documents(30, today)
    out["expiring_documents"] = len(docs)
    ids = list(RoleAssignment.objects.filter(role__name="procurement_manager").values_list("user_id", flat=True).distinct())
    if docs and ids:
        notify(ids, "procurement.documents.expiring", f"{len(docs)} supplier documents expired or expiring", "", ref_type="procurement.documents", ref_id=str(today))
    return out
