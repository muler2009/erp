from shared.events.services import register_event
from shared.sequences.models import NumberSequence
from shared.sequences.services import register_default_sequence

register_default_sequence("manufacturing.order", "Production orders", "MO-{yyyy}-{seq:05d}", NumberSequence.Reset.YEARLY)
register_default_sequence("manufacturing.plan", "Production plans", "PP-{yyyy}-{seq:04d}", NumberSequence.Reset.YEARLY)
register_event("manufacturing.order.completed", required=["order", "product", "quantity"])
register_event("manufacturing.order.closed", required=["order", "variance"])
