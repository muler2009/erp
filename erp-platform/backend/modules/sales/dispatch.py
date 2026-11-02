"""Delivery lifecycle after dispatch: delivered with proof of delivery, failed, discrepancies (short / damaged /
wrong goods open a service case), late-delivery tracking and delivery performance."""
from collections import defaultdict
from datetime import timedelta
from decimal import Decimal

from django.db import transaction
from django.utils import timezone

from modules.crm import models as cm
from modules.crm import service_desk
from modules.crm import services as crm
from modules.sales import models as m
from platform_core.audit.services import record_tenant_event
from platform_core.authorization import services as authz
from shared.api.errors import DomainError, ValidationFailed
from shared.events import services as events
from shared.files import services as files
from shared.notifications.services import notify
from shared.tenancy import current_tenant

ZERO = Decimal("0")
KINDS = ("SHORT", "DAMAGED", "WRONG")


def _delivery(pk, lock=False):
    qs = m.Delivery.objects.select_for_update(of=("self",)).select_related("order") if lock else m.Delivery.objects.select_related("order")
    d = qs.filter(pk=pk).first()
    if d is None:
        raise DomainError("Delivery not found.", code="not_found", status_code=404)
    return d


def _can_see(user_id, d):
    acct = cm.CrmAccount.objects.filter(pk=d.order.account_id).first()
    from modules.crm import teams

    return acct is not None and (crm.sees_all(user_id) or acct.owner_id in teams.visible_owner_ids(user_id) or authz.has_permission(user_id, "sales.delivery.manage"))


def get(user_id, pk):
    d = _delivery(pk)
    if not _can_see(user_id, d):
        raise DomainError("Delivery not found.", code="not_found", status_code=404)
    return d


files.register_access_check("sales.delivery", lambda uid, ref: (lambda d: d is not None and _can_see(uid, d))(m.Delivery.objects.select_related("order").filter(pk=ref).first()))


def set_expected(actor_id, pk, expected_date):
    d = _delivery(pk, lock=True)
    if not authz.has_permission(actor_id, "sales.delivery.manage"):
        raise DomainError("You may not manage deliveries.", code="permission_denied", status_code=403)
    if d.status != "DISPATCHED" or expected_date is None or expected_date < d.delivery_date:
        raise ValidationFailed("Only a dispatched delivery can get an expected date, and not before the dispatch date.", code="invalid_dates")
    d.expected_date, d.late_notified_at = expected_date, None
    d.save(update_fields=["expected_date", "late_notified_at", "updated_at"])
    return d


@transaction.atomic
def confirm_delivered(actor_id, pk, *, received_by, note="", delivered_at=None, discrepancies=(), pod=None):
    """Hand-over done.  `discrepancies`: [{order_line, kind, quantity, note}].  `pod`: optional (filename, bytes) proof document."""
    d = _delivery(pk, lock=True)
    if not authz.has_permission(actor_id, "sales.delivery.manage"):
        raise DomainError("You may not manage deliveries.", code="permission_denied", status_code=403)
    if d.status != "DISPATCHED":
        raise DomainError(f"A {d.status} delivery cannot be confirmed.", code="invalid_state_transition")
    if not (received_by or "").strip():
        raise ValidationFailed("Who received the goods is required.", code="received_by_required")
    when = delivered_at or timezone.now()
    if when.date() < d.delivery_date:
        raise ValidationFailed("Delivery cannot be confirmed before it was dispatched.", code="invalid_dates")
    lines = {str(l.order_line_id): l for l in d.lines.all()}
    rows = []
    for raw in discrepancies:
        dl = lines.get(str(raw.get("order_line")))
        try:
            qty = Decimal(str(raw.get("quantity")))
        except Exception:
            qty = ZERO
        if dl is None or raw.get("kind") not in KINDS or qty <= 0 or qty > dl.quantity:
            raise ValidationFailed("A discrepancy needs a line of this delivery, a kind (SHORT, DAMAGED, WRONG) and a quantity within what was delivered.", code="invalid_discrepancy")
        rows.append((dl, raw["kind"], qty, str(raw.get("note", ""))[:300]))
    d.status, d.delivered_at, d.received_by, d.pod_note = "DELIVERED", when, received_by.strip()[:120], (note or "")[:300]
    d.save()
    if pod:
        files.upload(actor_id, pod[0], pod[1], ref_type="sales.delivery", ref_id=str(d.id))
    if rows:
        owner = cm.CrmAccount.objects.filter(pk=d.order.account_id).values_list("owner_id", flat=True).first()
        summary = "; ".join(f"{k} x{q:f} of {dl.order_line.description[:40]}" for dl, k, q, _ in rows)
        case = service_desk.open_case(owner or actor_id, account_id=d.order.account_id, subject=f"Delivery {d.number}: {summary}"[:200], description="\n".join(n for *_, n in rows if n), kind="COMPLAINT", category="Delivery", priority="HIGH", order_id=d.order_id, delivery_id=d.id)
        for dl, k, q, n in rows:
            m.DeliveryDiscrepancy.objects.create(delivery=d, order_line=dl.order_line, kind=k, quantity=q, note=n, case_id=case.id, recorded_by=actor_id)
    events.emit("sales.delivery.confirmed", {"delivery_id": str(d.id), "order_id": str(d.order_id), "discrepancies": len(rows)}, dedup_key=f"delivery-confirmed-{d.id}")
    record_tenant_event(current_tenant(), "sales.delivery.confirmed", actor_user_id=actor_id, target_type="Delivery", target_id=d.id, metadata={"received_by": d.received_by, "discrepancies": str(len(rows))})
    return d


@transaction.atomic
def mark_failed(actor_id, pk, reason):
    """The carrier could not hand the goods over.  The stock stays issued until the goods are back and returned through a sales return."""
    d = _delivery(pk, lock=True)
    if not authz.has_permission(actor_id, "sales.delivery.manage"):
        raise DomainError("You may not manage deliveries.", code="permission_denied", status_code=403)
    if d.status != "DISPATCHED":
        raise DomainError(f"A {d.status} delivery cannot fail.", code="invalid_state_transition")
    if not (reason or "").strip():
        raise ValidationFailed("A reason is required.", code="reason_required")
    d.status, d.failure_reason = "FAILED", reason.strip()[:300]
    d.save(update_fields=["status", "failure_reason", "updated_at"])
    owner = cm.CrmAccount.objects.filter(pk=d.order.account_id).values_list("owner_id", flat=True).first()
    notify([u for u in {d.order.created_by, owner} if u], "sales.delivery.failed", f"Delivery {d.number} failed", d.failure_reason, ref_type="Delivery", ref_id=str(d.id))
    events.emit("sales.delivery.failed", {"delivery_id": str(d.id), "order_id": str(d.order_id), "reason": d.failure_reason}, dedup_key=f"delivery-failed-{d.id}")
    return d


def attachments(user_id, pk):
    from shared.files.models import StoredFile

    d = get(user_id, pk)
    return StoredFile.objects.filter(ref_type="sales.delivery", ref_id=str(d.id), status="ACTIVE").order_by("created_at")


def attach_pod(actor_id, pk, filename, data):
    d = _delivery(pk)
    if not authz.has_permission(actor_id, "sales.delivery.manage"):
        raise DomainError("You may not manage deliveries.", code="permission_denied", status_code=403)
    return files.upload(actor_id, filename, data, ref_type="sales.delivery", ref_id=str(d.id))


def notify_late(today=None):
    """Tell the sales owner once about each dispatched delivery that is past its expected date."""
    today = today or timezone.now().date()
    n = 0
    for d in m.Delivery.objects.select_for_update(of=("self",)).select_related("order").filter(status="DISPATCHED", expected_date__lt=today, late_notified_at__isnull=True):
        owner = cm.CrmAccount.objects.filter(pk=d.order.account_id).values_list("owner_id", flat=True).first()
        notify([u for u in {d.order.created_by, owner} if u], "sales.delivery.late", f"Delivery {d.number} is late", f"Expected {d.expected_date}.", ref_type="Delivery", ref_id=str(d.id))
        d.late_notified_at = timezone.now()
        d.save(update_fields=["late_notified_at"])
        n += 1
    return n


def performance(user_id, date_from=None, date_to=None, today=None):
    today = today or timezone.now().date()
    qs = crm.scope(m.Delivery.objects.all(), user_id, owner_field="order__account__owner_id")
    if date_from:
        qs = qs.filter(delivery_date__gte=date_from)
    if date_to:
        qs = qs.filter(delivery_date__lte=date_to)
    by = defaultdict(int)
    on_time = judged = 0
    days = []
    for d in qs:
        by[d.status] += 1
        if d.status == "DELIVERED":
            days.append((d.delivered_at.date() - d.delivery_date).days)
            if d.expected_date:
                judged += 1
                on_time += d.delivered_at.date() <= d.expected_date
    late_now = qs.filter(status="DISPATCHED", expected_date__lt=today).count()
    carriers = defaultdict(lambda: [0, 0])
    for d in qs.exclude(carrier=""):
        carriers[d.carrier][0] += 1
        carriers[d.carrier][1] += d.status == "FAILED"
    return {"total": sum(by.values()), "by_status": dict(by), "on_time_percent": round(100 * on_time / judged, 1) if judged else None, "avg_transit_days": round(sum(days) / len(days), 1) if days else None, "late_now": late_now,
            "discrepancies": m.DeliveryDiscrepancy.objects.filter(delivery__in=qs).count(), "by_carrier": {c: {"deliveries": a, "failed": b} for c, (a, b) in carriers.items()}}
