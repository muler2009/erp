from shared.events.services import register_event
from shared.sequences.models import NumberSequence
from shared.sequences.services import register_default_sequence
from shared.workflows.services import register_subject

R = NumberSequence.Reset
register_default_sequence("sales.quotation", "Quotations", "QT-{yyyy}-{seq:05d}", R.YEARLY)
register_default_sequence("sales.order", "Sales orders", "SO-{yyyy}-{seq:05d}", R.YEARLY)
register_default_sequence("sales.delivery", "Delivery notes", "DN-{yyyy}-{seq:05d}", R.YEARLY)
register_default_sequence("sales.return", "Sales returns", "RMA-{yyyy}-{seq:05d}", R.YEARLY)

register_event("sales.order.confirmed", required=["order_id", "number", "account_id", "total", "currency"])
register_event("sales.delivery.completed", required=["delivery_id", "order_id", "lines"])


def _order_outcome(instance):
    from modules.sales import services

    services._on_outcome(instance)


register_subject("sales.order", on_outcome=_order_outcome)


def _hooks():
    from modules.finance import services as finance
    from modules.sales import services

    if services.release_invoiced_on_void not in finance.VOID_HOOKS:
        finance.VOID_HOOKS.append(services.release_invoiced_on_void)


_hooks()
