from shared.sequences.models import NumberSequence
from shared.sequences.services import register_default_sequence

register_default_sequence("crm.case", "Service cases", "CS-{yyyy}-{seq:05d}", NumberSequence.Reset.YEARLY)
register_default_sequence("crm.campaign", "Campaigns", "CMP-{yyyy}-{seq:04d}", NumberSequence.Reset.YEARLY)
from shared.events.services import register_event

register_event("crm.lead.converted", required=["lead_id", "account_id", "opportunity_id"])
register_event("crm.opportunity.won", required=["opportunity_id", "amount", "currency"])
register_event("crm.case.escalated", required=["case_id", "number", "level"])
register_event("crm.case.resolved", required=["case_id", "number"])
