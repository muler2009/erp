"""Quotation lifecycle extras: commercial terms, revision history, approval before sending, expiry, printable
document, and quoting straight from an opportunity's product lines."""
from decimal import Decimal
from html import escape

from django.db import transaction
from django.utils import timezone

from modules.crm import models as cm
from modules.crm import services as crm
from modules.sales import models as m
from platform_core.audit.services import record_tenant_event
from platform_core.authorization import services as authz
from platform_core.organizations import services as org
from shared.api.errors import DomainError, ValidationFailed
from shared.notifications.services import notify
from shared.tenancy import current_tenant

TERM_FIELDS = ("payment_terms", "delivery_terms", "terms", "notes")


def _get(pk, lock=False):
    qs = m.Quotation.objects.select_for_update() if lock else m.Quotation.objects
    q = qs.filter(pk=pk).first()
    if q is None:
        raise DomainError("Quotation not found.", code="not_found", status_code=404)
    return q


def _own(q, actor_id):
    crm._own(cm.CrmAccount, q.account_id, actor_id, "Quotation")


def snapshot(q, actor_id, event):
    m.QuotationRevision.objects.create(quotation=q, version=q.version, event=event, created_by=actor_id, snapshot={
        "status": q.status, "currency": q.currency, "valid_until": str(q.valid_until) if q.valid_until else None, "subtotal": str(q.subtotal), "tax_total": str(q.tax_total), "total": str(q.total),
        "payment_terms": q.payment_terms, "delivery_terms": q.delivery_terms, "terms": q.terms, "notes": q.notes,
        "lines": [{"line_no": l.line_no, "product": str(l.product_id) if l.product_id else None, "description": l.description, "quantity": str(l.quantity), "unit_price": str(l.unit_price), "discount_percent": str(l.discount_percent), "line_total": str(l.line_total)} for l in q.lines.order_by("line_no")]})


def apply_terms(q, **terms):
    for k in TERM_FIELDS:
        if terms.get(k) is not None:
            v = str(terms[k])
            if len(v) > (200 if k.endswith("_terms") else 5000):
                raise ValidationFailed(f"{k} is too long.", code="invalid_terms")
            setattr(q, k, v)


def revisions(actor_id, pk):
    q = _get(pk)
    _own(q, actor_id)
    return list(q.revisions.order_by("version", "created_at"))


# ----------------------------------------------------------------------------- approval and sending
def needs_approval(q):
    limit = Decimal(str(org.get_setting("sales.max_discount_percent", 10)))
    threshold = Decimal(str(org.get_setting("sales.approval_threshold", 10000)))
    today = timezone.now().date()
    return q.max_discount > limit or q.total * org.get_rate(q.currency, today) >= threshold


@transaction.atomic
def send(actor_id, pk):
    q = _get(pk, lock=True)
    _own(q, actor_id)
    if q.status != "DRAFT":
        raise DomainError(f"A {q.status} quotation cannot become SENT.", code="invalid_state_transition")
    if not q.lines.exists():
        raise ValidationFailed("A quotation without lines cannot be sent.", code="no_lines")
    if needs_approval(q) and not (authz.has_permission(actor_id, "sales.order.approve") and q.created_by != actor_id):
        q.status = "PENDING_APPROVAL"
        q.save(update_fields=["status", "updated_at"])
        return q
    return _release(q, actor_id)


def _release(q, actor_id):
    snapshot(q, actor_id, "SENT")
    q.status = "SENT"
    q.save(update_fields=["status", "updated_at"])
    return q


@transaction.atomic
def approve(actor_id, pk):
    q = _get(pk, lock=True)
    if not authz.has_permission(actor_id, "sales.order.approve"):
        raise DomainError("You may not approve quotations.", code="permission_denied", status_code=403)
    if q.status != "PENDING_APPROVAL":
        raise DomainError("This quotation is not waiting for approval.", code="invalid_state_transition")
    if q.created_by == actor_id:
        raise DomainError("You cannot approve a quotation you created.", code="separation_of_duties", status_code=403)
    q.approved_by, q.approved_at = actor_id, timezone.now()
    q.save(update_fields=["approved_by", "approved_at", "updated_at"])
    _release(q, actor_id)
    record_tenant_event(current_tenant(), "sales.quotation.approved", actor_user_id=actor_id, target_type="Quotation", target_id=q.id, metadata={"number": q.number})
    notify([q.created_by], "sales.quotation.approved", f"Quotation {q.number} approved", "It can now be sent to the customer.", ref_type="Quotation", ref_id=str(q.id))
    return q


@transaction.atomic
def reject_approval(actor_id, pk, reason):
    q = _get(pk, lock=True)
    if not authz.has_permission(actor_id, "sales.order.approve"):
        raise DomainError("You may not approve quotations.", code="permission_denied", status_code=403)
    if q.status != "PENDING_APPROVAL":
        raise DomainError("This quotation is not waiting for approval.", code="invalid_state_transition")
    if not (reason or "").strip():
        raise ValidationFailed("A reason is required.", code="reason_required")
    q.status = "DRAFT"
    q.save(update_fields=["status", "updated_at"])
    notify([q.created_by], "sales.quotation.returned", f"Quotation {q.number} returned", reason.strip(), ref_type="Quotation", ref_id=str(q.id))
    return q


@transaction.atomic
def revise(actor_id, pk, reason=""):
    """Reopen a sent, rejected or expired quotation as a new draft version, keeping the old one in the history."""
    q = _get(pk, lock=True)
    _own(q, actor_id)
    if q.status not in ("SENT", "REJECTED", "EXPIRED", "PENDING_APPROVAL"):
        raise DomainError(f"A {q.status} quotation cannot be revised.", code="invalid_state_transition")
    snapshot(q, actor_id, "REVISED")
    q.status, q.version, q.approved_by, q.approved_at, q.expired_at = "DRAFT", q.version + 1, None, None, None
    q.save()
    record_tenant_event(current_tenant(), "sales.quotation.revised", actor_user_id=actor_id, target_type="Quotation", target_id=q.id, metadata={"version": str(q.version), "reason": reason[:200]})
    return q


# ----------------------------------------------------------------------------- expiry
def expire_overdue(today=None):
    """Mark sent/pending quotations past their validity date as EXPIRED and tell the owner.  Idempotent."""
    today = today or timezone.now().date()
    n = 0
    for q in m.Quotation.objects.select_for_update().filter(status__in=("SENT", "PENDING_APPROVAL", "DRAFT"), valid_until__lt=today):
        was_draft = q.status == "DRAFT"
        q.status, q.expired_at = "EXPIRED", timezone.now()
        q.save(update_fields=["status", "expired_at", "updated_at"])
        if not was_draft:
            owner = cm.CrmAccount.objects.filter(pk=q.account_id).values_list("owner_id", flat=True).first()
            notify([u for u in {q.created_by, owner} if u], "sales.quotation.expired", f"Quotation {q.number} expired", "Revise it to offer the customer a new validity period.", ref_type="Quotation", ref_id=str(q.id))
        n += 1
    return n


# ----------------------------------------------------------------------------- printable document
def document(actor_id, pk):
    q = _get(pk)
    _own(q, actor_id)
    company = org.get_company()
    acct = q.account
    rows = "".join(
        f"<tr><td>{l.line_no}</td><td>{escape(l.description)}</td><td class=n>{l.quantity:f}</td><td class=n>{l.unit_price:f}</td><td class=n>{l.discount_percent:f}%</td><td class=n>{l.line_total:f}</td></tr>" for l in q.lines.order_by("line_no"))
    def block(title, text):
        return f"<h3>{escape(title)}</h3><p>{escape(text).replace(chr(10), '<br>')}</p>" if text else ""
    return (f"<!doctype html><html><head><meta charset='utf-8'><title>{escape(q.number)}</title><style>body{{font:14px sans-serif;margin:2rem}}table{{border-collapse:collapse;width:100%}}td,th{{border-bottom:1px solid #ccc;padding:4px 8px;text-align:left}}.n{{text-align:right}}</style></head><body>"
            f"<h1>Quotation {escape(q.number)} <small>v{q.version}</small></h1><p><b>{escape(company.trade_name or company.legal_name)}</b><br>{escape(company.address)}</p>"
            f"<p>For: <b>{escape(acct.name)}</b><br>Valid until: {q.valid_until or 'not limited'} · Currency: {escape(q.currency)}</p>"
            f"<table><tr><th>#</th><th>Description</th><th class=n>Qty</th><th class=n>Unit price</th><th class=n>Discount</th><th class=n>Total</th></tr>{rows}</table>"
            f"<p class=n>Subtotal {q.subtotal:f}<br>Tax {q.tax_total:f}<br><b>Total {q.total:f} {escape(q.currency)}</b></p>"
            f"{block('Payment terms', q.payment_terms)}{block('Delivery terms', q.delivery_terms)}{block('Terms and conditions', q.terms)}{block('Notes', q.notes)}</body></html>")


# ----------------------------------------------------------------------------- from an opportunity
@transaction.atomic
def from_opportunity(actor_id, opportunity_id, *, valid_until=None, price_from_list=True, **terms):
    from modules.sales import services as sales

    opp = crm._own(cm.Opportunity, opportunity_id, actor_id, "Opportunity")
    if opp.status != "OPEN":
        raise DomainError("Only an open opportunity can be quoted.", code="invalid_state_transition")
    lines = [{"product": str(l.product_id), "quantity": str(l.quantity)} for l in opp.lines.select_related("product").order_by("created_at")]
    if not lines:
        raise ValidationFailed("The opportunity has no product lines to quote.", code="no_lines")
    q = sales.create_quotation(actor_id, account_id=opp.account_id, currency=opp.currency, lines=lines, valid_until=valid_until, opportunity_id=opp.id, **terms)
    return q
