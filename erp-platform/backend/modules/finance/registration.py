"""Registers finance's numbering sequences, domain events, workflow subject and period-close veto."""
from platform_core.organizations import services as org
from shared.events.services import register_event
from shared.sequences.models import NumberSequence
from shared.sequences.services import register_default_sequence
from shared.workflows.services import register_subject

R = NumberSequence.Reset
register_default_sequence("finance.journal", "Journal entries", "JV-{yyyy}-{seq:06d}", R.YEARLY)
register_default_sequence("finance.invoice", "Customer invoices", "INV-{yyyy}-{seq:06d}", R.YEARLY)
register_default_sequence("finance.bill", "Supplier invoices", "BILL-{yyyy}-{seq:06d}", R.YEARLY)
register_default_sequence("finance.credit_note", "Customer credit notes", "CN-{yyyy}-{seq:06d}", R.YEARLY)
register_default_sequence("finance.supplier_credit_note", "Supplier credit notes", "SCN-{yyyy}-{seq:06d}", R.YEARLY)
register_default_sequence("finance.payment", "Payments", "PAY-{yyyy}-{seq:06d}", R.YEARLY)

register_event("finance.invoice.posted", required=["invoice_id", "number", "kind", "total", "currency"])
register_event("finance.payment.completed", required=["payment_id", "number", "kind", "amount", "currency"])
register_event("finance.journal.posted", required=["entry_id", "number", "source_type"])


def _on_invoice_outcome(instance):
    from modules.finance import services

    services._on_workflow_outcome(instance)


register_subject("finance.invoice", on_outcome=_on_invoice_outcome)


def _close_check(period):
    from modules.finance import services

    services._journal_check_closing(period)


if _close_check not in org.PERIOD_CLOSE_CHECKS:
    org.PERIOD_CLOSE_CHECKS.append(_close_check)
