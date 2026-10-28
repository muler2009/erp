from shared.events.services import register_event

register_event("crm.lead.converted", required=["lead_id", "account_id", "opportunity_id"])
register_event("crm.opportunity.won", required=["opportunity_id", "amount", "currency"])
