"""Customer service: inquiries, complaints and requests with SLA targets, escalation, links to orders, deliveries
and invoices, attachments, resolution, satisfaction and reporting."""
from collections import defaultdict
from datetime import timedelta
from decimal import Decimal

from django.db import transaction
from django.db.models import Avg, Count, F, Q
from django.utils import timezone

from modules.crm import models as m
from modules.crm import services as base
from platform_core.audit.services import record_tenant_event
from platform_core.authorization import services as authz
from shared.api.errors import DomainError, ValidationFailed
from shared.events import services as events
from shared.files import services as files
from shared.notifications import services as notifications
from shared.sequences import services as sequences
from shared.tenancy import current_tenant

PRIORITIES = ("LOW", "MEDIUM", "HIGH", "URGENT")
SEVERITIES = ("MINOR", "MAJOR", "CRITICAL")
DEFAULT_SLA = {"LOW": (24, 120), "MEDIUM": (8, 72), "HIGH": (4, 24), "URGENT": (1, 8)}
OPEN_STATES = ("NEW", "OPEN", "PENDING_CUSTOMER")


def seed_defaults():
    for pr, (fr, res) in DEFAULT_SLA.items():
        m.SlaPolicy.objects.get_or_create(priority=pr, defaults={"first_response_hours": fr, "resolution_hours": res})


def _bad(msg, code="invalid_request"):
    return ValidationFailed(msg, code=code)


def visible(user_id):
    qs = m.ServiceCase.objects.all()
    if base.sees_all(user_id):
        return qs
    from modules.crm import teams

    ids = teams.visible_owner_ids(user_id)
    return qs.filter(Q(owner_id__in=ids) | Q(created_by__in=ids))


def get_case(user_id, case_id, lock=False):
    qs = m.ServiceCase.objects.select_for_update(of=("self",)) if lock else m.ServiceCase.objects
    c = qs.filter(pk=case_id).first()
    if c is None or not _sees(user_id, c):
        raise DomainError("Case not found.", code="not_found", status_code=404)
    return c


def _sees(user_id, c):
    from modules.crm import teams

    return base.sees_all(user_id) or bool({c.owner_id, c.created_by} & teams.visible_owner_ids(user_id))


def _can_see_case_file(user_id, case_id):
    c = m.ServiceCase.objects.filter(pk=case_id).first()
    return c is not None and _sees(user_id, c)


files.register_access_check("crm.case", _can_see_case_file)


def _sla(priority, start):
    pol = m.SlaPolicy.objects.filter(priority=priority).first()
    if pol is None:
        fr, res = DEFAULT_SLA[priority]
    else:
        fr, res = pol.first_response_hours, pol.resolution_hours
    return start + timedelta(hours=fr), start + timedelta(hours=res)


@transaction.atomic
def configure_sla(actor_id, priority, first_response_hours, resolution_hours):
    if not authz.has_permission(actor_id, "crm.assign"):
        raise DomainError("Only sales managers can configure service levels.", code="permission_denied", status_code=403)
    if priority not in PRIORITIES or int(first_response_hours) < 1 or int(resolution_hours) < int(first_response_hours):
        raise _bad("A known priority and hours (resolution >= first response >= 1) are required.", "invalid_sla")
    pol, _ = m.SlaPolicy.objects.update_or_create(priority=priority, defaults={"first_response_hours": int(first_response_hours), "resolution_hours": int(resolution_hours)})
    return pol


def _validate_links(account, order_id, delivery_id, invoice_id, product_id):
    """Everything a case points at must belong to the same customer — no cross-customer references."""
    from modules.finance.models import Invoice
    from modules.inventory.models import Product
    from modules.sales import models as sm

    order = delivery = invoice = product = None
    if order_id:
        order = sm.SalesOrder.objects.filter(pk=order_id, account=account).first()
        if order is None:
            raise _bad("That order does not belong to this customer.", "invalid_link")
    if delivery_id:
        delivery = sm.Delivery.objects.select_related("order").filter(pk=delivery_id, order__account=account).first()
        if delivery is None:
            raise _bad("That delivery does not belong to this customer.", "invalid_link")
        if order and delivery.order_id != order.id:
            raise _bad("The delivery is not part of that order.", "invalid_link")
        order = order or delivery.order
    if invoice_id:
        invoice = Invoice.objects.filter(pk=invoice_id, partner_id=account.partner_id).first() if account.partner_id else None
        if invoice is None:
            raise _bad("That invoice does not belong to this customer.", "invalid_link")
    if product_id:
        product = Product.objects.filter(pk=product_id).first()
        if product is None:
            raise _bad("Unknown product.", "invalid_link")
    return order, delivery, invoice, product


@transaction.atomic
def open_case(actor_id, *, account_id, subject, description="", kind="COMPLAINT", category="", priority="MEDIUM", severity="MINOR", contact_id=None, order_id=None, delivery_id=None, invoice_id=None, product_id=None):
    account = base._own(m.CrmAccount, account_id, actor_id, "Account")
    if not (subject or "").strip() or priority not in PRIORITIES or severity not in SEVERITIES or kind not in m.ServiceCase.Kind.values:
        raise _bad("A subject, a known kind, priority and severity are required.", "invalid_case")
    contact = None
    if contact_id:
        contact = m.Contact.objects.filter(pk=contact_id).first()
        if contact is None or contact.account_id != account.id and not contact.links.filter(account=account).exists():
            raise _bad("That contact is not linked to this customer.", "invalid_link")
    order, delivery, invoice, product = _validate_links(account, order_id, delivery_id, invoice_id, product_id)
    now = timezone.now()
    fr, due = _sla(priority, now)
    c = m.ServiceCase.objects.create(number=sequences.next_number("crm.case", for_type="ServiceCase"), subject=subject.strip()[:200], description=description, kind=kind, category=category[:60], priority=priority, severity=severity, account=account, contact=contact, order=order, delivery=delivery, invoice=invoice, product=product, first_response_due=fr, due_at=due, created_by=actor_id, created_at=now)
    return c


@transaction.atomic
def assign_case(actor_id, case_id, owner_id, team=""):
    if not authz.has_permission(actor_id, "crm.assign"):
        raise DomainError("You cannot assign cases.", code="permission_denied", status_code=403)
    c = get_case(actor_id, case_id, lock=True)
    if c.status not in OPEN_STATES:
        raise DomainError("Only open cases can be assigned.", code="invalid_state_transition")
    if not base._active_member(owner_id):
        raise _bad("The handler must be an active member.", "invalid_owner")
    old = c.owner_id
    c.owner_id, c.team = owner_id, team[:60]
    if c.status == "NEW":
        c.status = "OPEN"
    c.save()
    record_tenant_event(current_tenant(), "crm.case.assigned", actor_user_id=actor_id, target_type="ServiceCase", target_id=c.id, metadata={"from": str(old), "to": str(owner_id)})
    notifications.notify([owner_id], "crm.case.assigned", f"Case {c.number}: {c.subject}", ref_type="ServiceCase", ref_id=c.id)
    return c


@transaction.atomic
def add_comment(actor_id, case_id, text, internal=False):
    c = get_case(actor_id, case_id, lock=True)
    if c.status in ("CLOSED", "CANCELLED"):
        raise DomainError("This case is closed.", code="invalid_state_transition")
    if not (text or "").strip():
        raise _bad("A comment needs text.", "invalid_comment")
    com = m.CaseComment.objects.create(case=c, author_id=actor_id, text=text.strip(), is_internal=bool(internal))
    if not internal and c.first_responded_at is None and actor_id != c.created_by:
        c.first_responded_at = timezone.now()  # the first customer-facing reply stops the response clock
        if c.status == "NEW":
            c.status = "OPEN"
        c.save(update_fields=["first_responded_at", "status", "updated_at"])
    return com


@transaction.atomic
def set_status(actor_id, case_id, status, note=""):
    """OPEN <-> PENDING_CUSTOMER; reopen RESOLVED -> OPEN. Resolve and close have their own functions."""
    c = get_case(actor_id, case_id, lock=True)
    allowed = {"NEW": ("OPEN",), "OPEN": ("PENDING_CUSTOMER",), "PENDING_CUSTOMER": ("OPEN",), "RESOLVED": ("OPEN",)}
    if status not in allowed.get(c.status, ()):
        raise DomainError(f"A {c.status} case cannot become {status}.", code="invalid_state_transition")
    if c.status == "RESOLVED":
        c.resolved_at, c.resolution = None, ""
    c.status = status
    c.save()
    if note.strip():
        m.CaseComment.objects.create(case=c, author_id=actor_id, text=note.strip(), is_internal=True)
    return c


@transaction.atomic
def resolve_case(actor_id, case_id, resolution):
    c = get_case(actor_id, case_id, lock=True)
    if c.status not in OPEN_STATES:
        raise DomainError("Only open cases can be resolved.", code="invalid_state_transition")
    if not (resolution or "").strip():
        raise _bad("A resolution is required.", "reason_required")
    now = timezone.now()
    c.status, c.resolution, c.resolved_at = "RESOLVED", resolution.strip(), now
    if c.first_responded_at is None:
        c.first_responded_at = now
    c.save()
    events.emit("crm.case.resolved", {"case_id": str(c.id), "number": c.number}, dedup_key=f"case-resolved-{c.id}-{int(now.timestamp())}")
    return c


@transaction.atomic
def record_feedback(actor_id, case_id, rating, feedback=""):
    """Customer satisfaction, recorded by staff on the customer's behalf (1-5). Only for resolved cases, once."""
    c = get_case(actor_id, case_id, lock=True)
    if c.status != "RESOLVED":
        raise DomainError("Feedback is recorded on a resolved case.", code="invalid_state_transition")
    if c.satisfaction is not None:
        raise DomainError("Feedback was already recorded.", code="feedback_exists")
    if int(rating) not in range(1, 6):
        raise _bad("The rating is 1 to 5.", "invalid_rating")
    c.satisfaction, c.feedback = int(rating), feedback[:500]
    c.save()
    return c


@transaction.atomic
def close_case(actor_id, case_id):
    c = get_case(actor_id, case_id, lock=True)
    if c.status != "RESOLVED":
        raise DomainError("Only a resolved case can be closed.", code="invalid_state_transition")
    c.status, c.closed_at = "CLOSED", timezone.now()
    c.save()
    return c


@transaction.atomic
def cancel_case(actor_id, case_id, reason):
    c = get_case(actor_id, case_id, lock=True)
    if c.status not in OPEN_STATES:
        raise DomainError("Only open cases can be cancelled.", code="invalid_state_transition")
    if not (reason or "").strip():
        raise _bad("A reason is required.", "reason_required")
    c.status = "CANCELLED"
    c.save()
    m.CaseComment.objects.create(case=c, author_id=actor_id, text=f"Cancelled: {reason.strip()}", is_internal=True)
    return c


@transaction.atomic
def attach_file(actor_id, case_id, filename, data):
    c = get_case(actor_id, case_id)
    if c.status in ("CLOSED", "CANCELLED"):
        raise DomainError("This case is closed.", code="invalid_state_transition")
    return files.upload(actor_id, filename, data, ref_type="crm.case", ref_id=str(c.id))


def attachments(user_id, case_id):
    from shared.files.models import StoredFile

    c = get_case(user_id, case_id)
    return StoredFile.objects.filter(ref_type="crm.case", ref_id=str(c.id), status="ACTIVE").order_by("created_at")


def comments_for(user_id, case_id, customer_view=False):
    c = get_case(user_id, case_id)
    qs = c.comments.order_by("created_at")
    return qs.filter(is_internal=False) if customer_view else qs


# ----------------------------------------------------------------------------- SLA and escalation
def sla_state(c, now=None):
    now = now or timezone.now()
    out = {"response_breached": False, "resolution_breached": False}
    if c.first_response_due:
        out["response_breached"] = (c.first_responded_at or now) > c.first_response_due
    if c.due_at:
        end = c.resolved_at or (now if c.status in OPEN_STATES else c.closed_at or now)
        out["resolution_breached"] = end > c.due_at
    return out


@transaction.atomic
def escalate_overdue(now=None):
    """Hourly job. Level 1 when the resolution target passes; level 2 when half the target window has passed again.
    Managers (crm.assign) and the handler are told once per level. Idempotent."""
    from platform_core.users.models import TenantMembership

    now = now or timezone.now()
    managers = [u for u in TenantMembership.objects.filter(tenant=current_tenant(), status="ACTIVE").values_list("user_id", flat=True) if authz.has_permission(u, "crm.assign")]
    raised = 0
    for c in m.ServiceCase.objects.select_for_update(of=("self",)).filter(status__in=OPEN_STATES, due_at__lt=now):
        window = c.due_at - c.created_at
        level = 2 if now > c.due_at + window / 2 else 1
        if level <= c.escalation_level:
            continue
        c.escalation_level = level
        c.save(update_fields=["escalation_level", "updated_at"])
        who = set(managers) | ({c.owner_id} if c.owner_id else set())
        notifications.notify(list(who), "crm.case.escalated", f"Case {c.number} overdue (level {level})", c.subject, ref_type="ServiceCase", ref_id=c.id)
        events.emit("crm.case.escalated", {"case_id": str(c.id), "number": c.number, "level": level}, dedup_key=f"case-escalated-{c.id}-{level}")
        raised += 1
    return raised


# ----------------------------------------------------------------------------- reports
def service_report(user_id, d_from=None, d_to=None):
    qs = visible(user_id)
    if d_from:
        qs = qs.filter(created_at__date__gte=d_from)
    if d_to:
        qs = qs.filter(created_at__date__lte=d_to)
    cases = list(qs.select_related("account"))
    done = [c for c in cases if c.resolved_at]
    hours = [(c.resolved_at - c.created_at).total_seconds() / 3600 for c in done]
    within = [c for c in done if c.due_at and c.resolved_at <= c.due_at]
    rated = [c.satisfaction for c in cases if c.satisfaction]
    by_cat, by_month = defaultdict(int), defaultdict(int)
    for c in cases:
        by_cat[c.category or "(none)"] += 1
        by_month[f"{c.created_at:%Y-%m}"] += 1
    by_owner = defaultdict(lambda: {"handled": 0, "resolved": 0})
    for c in cases:
        if c.owner_id:
            by_owner[str(c.owner_id)]["handled"] += 1
            by_owner[str(c.owner_id)]["resolved"] += bool(c.resolved_at)
    return {"total": len(cases), "open": sum(c.status in OPEN_STATES for c in cases), "complaints": sum(c.kind == "COMPLAINT" for c in cases), "avg_resolution_hours": round(sum(hours) / len(hours), 2) if hours else None, "sla_met_percent": round(len(within) / len(done) * 100, 2) if done else None, "avg_satisfaction": round(sum(rated) / len(rated), 2) if rated else None, "escalated": sum(c.escalation_level > 0 for c in cases), "by_category": dict(by_cat), "by_month": dict(sorted(by_month.items())), "by_owner": dict(by_owner)}
