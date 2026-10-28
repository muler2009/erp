from shared.events.services import register_event
from shared.sequences.models import NumberSequence
from shared.sequences.services import register_default_sequence
from shared.workflows.services import register_subject

R = NumberSequence.Reset
register_default_sequence("procurement.requisition", "Purchase requisitions", "PR-{yyyy}-{seq:05d}", R.YEARLY)
register_default_sequence("procurement.rfq", "Requests for quotation", "RFQ-{yyyy}-{seq:05d}", R.YEARLY)
register_default_sequence("procurement.purchase_order", "Purchase orders", "PO-{yyyy}-{seq:05d}", R.YEARLY)
register_default_sequence("procurement.goods_receipt", "Goods receipts", "GR-{yyyy}-{seq:05d}", R.YEARLY)

register_event("procurement.purchase_order.approved", required=["po_id", "number", "supplier_id", "total", "currency"])
register_event("procurement.requisition.approved", required=["requisition_id", "number"])


def _req_outcome(instance):
    from modules.procurement import services

    services._on_outcome("requisition", instance)


def _po_outcome(instance):
    from modules.procurement import services

    services._on_outcome("po", instance)


register_subject("procurement.requisition", on_outcome=_req_outcome)
register_subject("procurement.purchase_order", on_outcome=_po_outcome)


def _install_finance_hooks():
    from modules.finance import services as finance
    from modules.procurement import services

    if services.require_match_before_posting not in finance.POST_CHECKS:
        finance.POST_CHECKS.append(services.require_match_before_posting)
    if services.release_match_on_void not in finance.VOID_HOOKS:
        finance.VOID_HOOKS.append(services.release_match_on_void)


_install_finance_hooks()
