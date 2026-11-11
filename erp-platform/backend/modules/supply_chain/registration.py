from shared.events.services import register_event
from shared.sequences.models import NumberSequence
from shared.sequences.services import register_default_sequence

register_default_sequence("supply_chain.shipment", "Shipments", "SHP-{yyyy}-{seq:05d}", NumberSequence.Reset.YEARLY)
register_default_sequence("supply_chain.plan", "Supply plans", "SP-{yyyy}-{seq:04d}", NumberSequence.Reset.YEARLY)
register_default_sequence("supply_chain.risk", "Supply risks", "SR-{yyyy}-{seq:04d}", NumberSequence.Reset.YEARLY)
register_event("supply_chain.shipment.delivered", required=["shipment"])
register_event("supply_chain.exception.reported", required=["shipment", "kind"])
