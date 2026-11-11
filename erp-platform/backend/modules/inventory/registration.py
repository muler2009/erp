from shared.events.services import register_event

register_event("inventory.goods_received", required=["receipt_id", "po_id", "lines"])
register_event("inventory.stock.adjusted", required=["product_id", "location_id", "delta"])

from shared.sequences.models import NumberSequence as _NS  # noqa: E402
from shared.sequences.services import register_default_sequence  # noqa: E402

register_default_sequence("inventory.transfer", "Stock transfers", "TR-{yyyy}-{seq:05d}", _NS.Reset.YEARLY)
register_default_sequence("inventory.requisition", "Material requisitions", "MR-{yyyy}-{seq:05d}", _NS.Reset.YEARLY)
register_default_sequence("inventory.issue_voucher", "Issue vouchers", "IV-{yyyy}-{seq:05d}", _NS.Reset.YEARLY)

from shared.workflows.services import register_subject  # noqa: E402


def _req_outcome(instance):
    from modules.inventory import requisitions

    requisitions.on_workflow_outcome(instance)


register_subject("inventory.requisition", on_outcome=_req_outcome)

register_default_sequence("inventory.adjustment", "Stock adjustments", "ADJ-{yyyy}-{seq:05d}", _NS.Reset.YEARLY)
register_default_sequence("inventory.stock_count", "Stock counts", "SC-{yyyy}-{seq:05d}", _NS.Reset.YEARLY)

from shared.files import services as _files  # noqa: E402

_files.register_access_check("inventory.adjustment", lambda u, rid: __import__("modules.inventory.adjustments", fromlist=["x"])._can_read_evidence(u, rid))
register_default_sequence("inventory.landed_cost", "Landed costs", "LC-{yyyy}-{seq:05d}", _NS.Reset.YEARLY)
