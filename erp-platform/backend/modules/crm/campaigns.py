"""Marketing campaigns: audience building from segment criteria, consent gating, responses, expenses against a
budget, lead capture, attribution of opportunities and revenue, and ROI."""
from decimal import Decimal, InvalidOperation

from django.db import IntegrityError, transaction
from django.db.models import Count, Q, Sum
from django.utils import timezone

from modules.crm import models as m
from modules.crm import records
from modules.crm import services as base
from platform_core.audit.services import record_tenant_event
from platform_core.authorization import services as authz
from platform_core.organizations.models import Currency
from shared.api.errors import DomainError, ValidationFailed
from shared.sequences import services as sequences
from shared.tenancy import current_tenant

ZERO = Decimal("0")
CHANNELS = ("EMAIL", "PHONE", "SMS", "EVENT", "SOCIAL", "OTHER")
CONSENT_CHANNELS = ("EMAIL", "PHONE", "SMS")
LEAD_CRITERIA = ("source", "industry", "qualification", "priority", "status")
CONTACT_CRITERIA = ("industry", "segment", "lifecycle_stage", "classification", "customer_type")


def _need(actor_id):
    if not authz.has_permission(actor_id, "crm.campaign.manage"):
        raise DomainError("You cannot manage campaigns.", code="permission_denied", status_code=403)


def _bad(msg, code="invalid_request"):
    return ValidationFailed(msg, code=code)


def _get(pk, lock=False):
    qs = m.Campaign.objects.select_for_update() if lock else m.Campaign.objects
    c = qs.filter(pk=pk).first()
    if c is None:
        raise DomainError("Campaign not found.", code="not_found", status_code=404)
    return c


@transaction.atomic
def create_campaign(actor_id, *, name, start_date, end_date, currency, channel="EMAIL", objective="", budget=0, audience=None):
    _need(actor_id)
    try:
        budget = Decimal(str(budget))
    except InvalidOperation:
        raise _bad("budget must be a number.", "invalid_amount")
    if not (name or "").strip() or end_date < start_date or budget < 0 or channel not in CHANNELS:
        raise _bad("A name, a valid period, a non-negative budget and a known channel are required.", "invalid_campaign")
    if not Currency.objects.filter(code=currency, is_active=True).exists():
        raise _bad("Currency is not active.", "invalid_currency")
    audience = audience or {}
    kind = audience.get("kind", "leads")
    allowed = LEAD_CRITERIA if kind == "leads" else CONTACT_CRITERIA
    if kind not in ("leads", "contacts") or any(k not in allowed + ("kind",) for k in audience):
        raise _bad(f"Audience criteria for {kind} may only use: {', '.join(allowed)}.", "invalid_audience")
    return m.Campaign.objects.create(number=sequences.next_number("crm.campaign", on_date=start_date, for_type="Campaign"), name=name.strip()[:150], objective=objective[:300], channel=channel, audience=audience, budget=budget, currency=currency, start_date=start_date, end_date=end_date, owner_id=actor_id)


@transaction.atomic
def build_audience(actor_id, campaign_id):
    """Fill the member list from the criteria (re-runnable: existing members stay, new matches are added). People who
    have not consented — or have opted out — are listed as EXCLUDED with the reason, never silently dropped."""
    _need(actor_id)
    c = _get(campaign_id, lock=True)
    if c.status not in ("DRAFT", "ACTIVE"):
        raise DomainError("This campaign is closed.", code="invalid_state_transition")
    crit = {k: v for k, v in c.audience.items() if k != "kind"}
    gate = c.channel in CONSENT_CHANNELS
    added = excluded = 0
    if c.audience.get("kind", "leads") == "leads":
        qs = m.Lead.objects.exclude(status__in=["CONVERTED", "DISQUALIFIED", "MERGED"]).filter(**crit)
        for l in qs:
            reason = ""
            if gate:
                if l.opted_out_at:
                    reason = "opted out"
                elif not l.marketing_consent:
                    reason = "no consent"
                elif c.channel == "EMAIL" and not l.email or c.channel in ("PHONE", "SMS") and not l.phone:
                    reason = "no address"
            _, new = m.CampaignMember.objects.get_or_create(campaign=c, lead=l, defaults={"status": "EXCLUDED" if reason else "TARGETED", "excluded_reason": reason})
            added += new and not reason
            excluded += new and bool(reason)
    else:
        qs = m.Contact.objects.filter(**{f"account__{k}": v for k, v in crit.items()}) if crit else m.Contact.objects.all()
        for ct in qs:
            reason = ""
            if gate:
                if ct.opted_out_at:
                    reason = "opted out"
                elif not records.can_contact(ct, c.channel):
                    reason = "no consent"
                elif c.channel == "EMAIL" and not ct.email or c.channel in ("PHONE", "SMS") and not ct.phone:
                    reason = "no address"
            _, new = m.CampaignMember.objects.get_or_create(campaign=c, contact=ct, defaults={"status": "EXCLUDED" if reason else "TARGETED", "excluded_reason": reason})
            added += new and not reason
            excluded += new and bool(reason)
    return {"added": added, "excluded": excluded}


@transaction.atomic
def set_status(actor_id, campaign_id, status):
    _need(actor_id)
    c = _get(campaign_id, lock=True)
    flow = {"DRAFT": ("ACTIVE", "CANCELLED"), "ACTIVE": ("COMPLETED", "CANCELLED")}
    if status not in flow.get(c.status, ()):
        raise DomainError(f"A {c.status} campaign cannot become {status}.", code="invalid_state_transition")
    if status == "ACTIVE" and not c.members.filter(status="TARGETED").exists() and c.channel in CONSENT_CHANNELS:
        raise DomainError("Build an audience with at least one consenting member before activating.", code="empty_audience")
    c.status = status
    c.save(update_fields=["status", "updated_at"])
    return c


@transaction.atomic
def record_sent(actor_id, campaign_id, member_ids=None):
    """Marks targeted members as sent. The consent gate is checked again at send time — consent may have been
    withdrawn since the list was built. Returns (sent, blocked)."""
    _need(actor_id)
    c = _get(campaign_id, lock=True)
    if c.status != "ACTIVE":
        raise DomainError("Only an active campaign can send.", code="invalid_state_transition")
    qs = c.members.select_for_update(of=("self",)).filter(status="TARGETED").select_related("contact", "lead")
    if member_ids:
        qs = qs.filter(pk__in=member_ids)
    sent = blocked = 0
    now = timezone.now()
    for mem in qs:
        ok = True
        if c.channel in CONSENT_CHANNELS:
            if mem.contact_id:
                ok = records.can_contact(mem.contact, c.channel)
            else:
                ok = mem.lead.marketing_consent and not mem.lead.opted_out_at
        if ok:
            mem.status, mem.sent_at = "SENT", now
            sent += 1
        else:
            mem.status, mem.excluded_reason = "EXCLUDED", "consent withdrawn"
            blocked += 1
        mem.save()
    return sent, blocked


@transaction.atomic
def record_response(actor_id, member_id):
    _need(actor_id)
    mem = m.CampaignMember.objects.select_for_update(of=("self",)).select_related("campaign").filter(pk=member_id).first()
    if mem is None:
        raise DomainError("Member not found.", code="not_found", status_code=404)
    if mem.status != "SENT":
        raise DomainError("Only members who were contacted can respond.", code="invalid_state_transition")
    mem.status, mem.responded_at = "RESPONDED", timezone.now()
    mem.save()
    return mem


@transaction.atomic
def capture_lead(actor_id, campaign_id, *, name, email="", phone="", company="", marketing_consent=False):
    """A response that creates a lead attributed to the campaign (e.g. an event sign-up). Duplicates are refused."""
    _need(actor_id)
    c = _get(campaign_id, lock=True)
    if c.status != "ACTIVE":
        raise DomainError("Only an active campaign captures leads.", code="invalid_state_transition")
    lead = records.create_lead_checked(actor_id, name=name, email=email, phone=phone, company=company, source=f"CAMPAIGN:{c.number}")
    lead.campaign, lead.marketing_consent = c, bool(marketing_consent)
    lead.save(update_fields=["campaign", "marketing_consent", "updated_at"])
    m.CampaignMember.objects.create(campaign=c, lead=lead, status="RESPONDED", responded_at=timezone.now())
    return lead


@transaction.atomic
def set_lead_consent(actor_id, lead_id, *, consent=None, opt_out=None):
    lead = base._own(m.Lead, lead_id, actor_id, "Lead", lock=True)
    if consent is not None:
        lead.marketing_consent = bool(consent)
    if opt_out is True:
        lead.opted_out_at, lead.marketing_consent = timezone.now(), False
    elif opt_out is False:
        lead.opted_out_at = None
    lead.save()
    record_tenant_event(current_tenant(), "crm.consent.changed", actor_user_id=actor_id, target_type="Lead", target_id=lead.id, metadata={"consent": str(lead.marketing_consent), "opt_out": str(lead.opted_out_at is not None)})
    return lead


@transaction.atomic
def add_expense(actor_id, campaign_id, *, on_date, description, amount):
    """Spend is capped by the budget: an expense that would exceed it is refused (raise the budget deliberately)."""
    _need(actor_id)
    c = _get(campaign_id, lock=True)
    if c.status == "CANCELLED":
        raise DomainError("The campaign was cancelled.", code="invalid_state_transition")
    try:
        amt = Decimal(str(amount))
    except InvalidOperation:
        raise _bad("amount must be a number.", "invalid_amount")
    if amt <= 0 or not (description or "").strip():
        raise _bad("A description and a positive amount are required.", "invalid_expense")
    spent = c.expenses.aggregate(s=Sum("amount"))["s"] or ZERO
    if spent + amt > c.budget:
        raise DomainError(f"This would exceed the budget ({c.budget - spent} left).", code="budget_exceeded")
    return m.CampaignExpense.objects.create(campaign=c, on_date=on_date, description=description.strip()[:200], amount=amt, created_by=actor_id)


@transaction.atomic
def update_budget(actor_id, campaign_id, budget):
    if not authz.has_permission(actor_id, "crm.assign"):
        raise DomainError("Only sales managers can change a campaign budget.", code="permission_denied", status_code=403)
    c = _get(campaign_id, lock=True)
    b = Decimal(str(budget))
    spent = c.expenses.aggregate(s=Sum("amount"))["s"] or ZERO
    if b < spent:
        raise _bad("The budget cannot be lower than what was already spent.", "invalid_amount")
    c.budget = b
    c.save(update_fields=["budget", "updated_at"])
    return c


def campaign_report(user_id, campaign_id):
    """Funnel, leads, conversions, spend, attributed pipeline and revenue (won opportunities) and ROI."""
    _need(user_id)
    c = _get(campaign_id)
    members = {r["status"]: r["n"] for r in c.members.values("status").annotate(n=Count("id"))}
    leads = c.leads.all()
    converted = leads.filter(status="CONVERTED").count()
    spent = c.expenses.aggregate(s=Sum("amount"))["s"] or ZERO
    opps = c.opportunities.all()
    won = opps.filter(status="WON", currency=c.currency).aggregate(s=Sum("amount"))["s"] or ZERO
    open_pipeline = opps.filter(status="OPEN", currency=c.currency).aggregate(s=Sum("amount"))["s"] or ZERO
    roi = ((won - spent) / spent * 100).quantize(Decimal("0.01")) if spent else None
    sent = members.get("SENT", 0) + members.get("RESPONDED", 0)
    return {"campaign": c.number, "status": c.status, "currency": c.currency, "members": members, "excluded": members.get("EXCLUDED", 0), "response_rate": str((Decimal(members.get("RESPONDED", 0)) / sent * 100).quantize(Decimal("0.01"))) if sent else None, "leads_generated": leads.count(), "leads_converted": converted, "budget": str(c.budget), "spent": str(spent), "remaining": str(c.budget - spent), "opportunities": opps.count(), "open_pipeline": str(open_pipeline), "won_revenue": str(won), "roi_percent": str(roi) if roi is not None else None, "cost_per_lead": str((spent / leads.count()).quantize(Decimal("0.01"))) if leads.count() and spent else None}


def campaigns_overview(user_id):
    _need(user_id)
    return [campaign_report(user_id, c.id) for c in m.Campaign.objects.order_by("-start_date")[:100]]
