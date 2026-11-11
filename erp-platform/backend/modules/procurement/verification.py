"""Invoice verification: duplicate detection, exception queue, controlled overrides, debit notes."""
import re
from decimal import Decimal

from django.db import transaction

from modules.finance import models as fm
from modules.finance import services as finance
from modules.procurement import models as m
from platform_core.audit.services import record_tenant_event
from shared.api.errors import DomainError, ValidationFailed
from shared.tenancy import current_tenant


def normalise_ref(ref):
    return re.sub(r"[^A-Z0-9]", "", (ref or "").upper())


def find_duplicates(inv):
    """exact: same supplier and same invoice number (ignoring case/punctuation); possible: same supplier, date and total."""
    others = fm.Invoice.objects.filter(partner_id=inv.partner_id, kind="SUPPLIER_INVOICE").exclude(pk=inv.pk).exclude(status="VOID")
    key = normalise_ref(inv.supplier_ref)
    exact = [o.number or str(o.id)[:8] for o in others if key and normalise_ref(o.supplier_ref) == key]
    possible = [o.number or str(o.id)[:8] for o in others.filter(invoice_date=inv.invoice_date, total=inv.total) if (o.number or str(o.id)[:8]) not in exact]
    return {"exact": exact, "possible": possible}


def exceptions():
    return [{"match": str(x.id), "invoice": str(x.invoice_id), "invoice_number": x.invoice.number, "supplier_ref": x.invoice.supplier_ref, "po": x.order.number, "problems": x.detail.get("problems", {}), "goods_value": str(x.goods_value), "raised_at": x.updated_at.isoformat()}
            for x in m.InvoiceMatch.objects.filter(status="EXCEPTION").select_related("invoice", "order").order_by("created_at")]


@transaction.atomic
def override(actor_id, match_id, *, reason):
    """Accept an invoice despite a failed match. Needs a reason, a different person from whoever ran the match, and is audited.
    A duplicate-invoice exception can never be overridden."""
    x = m.InvoiceMatch.objects.select_for_update().filter(pk=match_id).select_related("invoice").first()
    if x is None:
        raise DomainError("Match not found.", code="not_found", status_code=404)
    if x.status != "EXCEPTION":
        raise DomainError("Only an exception can be overridden.", code="invalid_state")
    if not (reason or "").strip():
        raise ValidationFailed("A reason is required to override a match.", code="reason_required")
    if x.matched_by == actor_id:
        raise DomainError("Separation of duties: someone else must approve the override.", code="separation_of_duties", status_code=403)
    if "duplicate_invoice" in x.detail.get("problems", {}):
        raise DomainError("A duplicate invoice cannot be overridden; void it instead.", code="duplicate_not_overridable")
    order = m.PurchaseOrder.objects.select_for_update().get(pk=x.order_id)
    x.status, x.overridden_by, x.override_reason = "OVERRIDDEN", actor_id, reason[:300]
    x.save()
    order.invoiced_value += x.goods_value
    order.save(update_fields=["invoiced_value"])
    from modules.procurement import budgets

    budgets.sync_po_consumed(order)
    record_tenant_event(current_tenant(), "procurement.invoice.match_overridden", actor_user_id=actor_id, target_type="Invoice", target_id=x.invoice_id, metadata={"reason": reason[:200], "problems": ",".join(x.detail.get("problems", {}))})
    return x


@transaction.atomic
def debit_note(actor_id, invoice_id, *, lines, reason, invoice_date, supplier_ref=""):
    """A debit note raised by us against a supplier invoice is booked as a supplier credit note referencing it.
    The credited value cannot exceed what is left on the original invoice."""
    inv = fm.Invoice.objects.select_for_update().filter(pk=invoice_id).first()
    if inv is None or inv.kind != "SUPPLIER_INVOICE":
        raise DomainError("Supplier invoice not found.", code="not_found", status_code=404)
    if inv.status not in ("POSTED", "PAID"):
        raise DomainError("Debit notes can only be raised against posted invoices.", code="invalid_state")
    if not (reason or "").strip():
        raise ValidationFailed("A reason is required.", code="reason_required")
    already = sum((c.total for c in inv.credit_notes.exclude(status="VOID")), Decimal("0"))
    cn = finance.create_invoice(actor_id, kind="SUPPLIER_CREDIT_NOTE", partner_id=inv.partner_id, invoice_date=invoice_date, currency=inv.currency, lines=lines, supplier_ref=supplier_ref, credit_for_id=inv.id)
    if already + cn.total > inv.total:
        raise DomainError(f"Credit would exceed the invoice total (already credited {already}).", code="credit_exceeds_invoice")
    record_tenant_event(current_tenant(), "procurement.debit_note.created", actor_user_id=actor_id, target_type="Invoice", target_id=cn.id, metadata={"against": inv.number, "reason": reason[:200]})
    return cn
