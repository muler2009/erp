"""CRM services. Ownership is enforced here (not in views): users without `crm.view_all` can only read and
change records they own; assignment changes need `crm.assign`."""
from collections import defaultdict
from decimal import Decimal

from django.db import transaction
from django.db.models import Count, Q
from django.utils import timezone

from modules.crm import models as m
from platform_core.audit.services import record_tenant_event
from platform_core.authorization import services as authz
from platform_core.authorization.models import RoleAssignment
from platform_core.organizations.models import Currency
from platform_core.users.models import TenantMembership
from shared.api.errors import DomainError, ValidationFailed
from shared.events import services as events
from shared.tenancy import current_tenant

ZERO = Decimal("0")
DEFAULT_STAGES = [("PROSPECTING", "Prospecting", 1, 10, False, False), ("QUALIFICATION", "Qualification", 2, 25, False, False), ("PROPOSAL", "Proposal", 3, 50, False, False), ("NEGOTIATION", "Negotiation", 4, 75, False, False), ("WON", "Closed won", 5, 100, True, False), ("LOST", "Closed lost", 6, 0, False, True)]


def seed_defaults():
    for code, name, pos, prob, won, lost in DEFAULT_STAGES:
        m.PipelineStage.objects.get_or_create(code=code, defaults=dict(name=name, position=pos, probability=prob, is_won=won, is_lost=lost))


def sees_all(user_id):
    return authz.has_permission(user_id, "crm.view_all")


def scope(qs, user_id, owner_field="owner_id"):
    """Queryset visible to `user_id`."""
    return qs if sees_all(user_id) else qs.filter(**{owner_field: user_id})


def _own(model, pk, user_id, label, lock=False):
    qs = model.objects.select_for_update() if lock else model.objects
    obj = qs.filter(pk=pk).first()
    if obj is None or not (sees_all(user_id) or getattr(obj, "owner_id", None) == user_id):
        raise DomainError(f"{label} not found.", code="not_found", status_code=404)  # same answer for missing and not yours
    return obj


def _active_member(user_id):
    return TenantMembership.objects.filter(tenant=current_tenant(), user_id=user_id, status="ACTIVE").exists()


# ----------------------------------------------------------------------------- accounts & contacts
@transaction.atomic
def create_account(actor_id, *, name, industry="", segment="", website="", tax_id="", owner_id=None):
    if not name.strip():
        raise ValidationFailed("name is required.", code="invalid_name")
    owner = _resolve_owner(actor_id, owner_id)
    return m.CrmAccount.objects.create(name=name.strip(), industry=industry, segment=segment, website=website, tax_id=tax_id, owner_id=owner)


def _resolve_owner(actor_id, owner_id):
    if owner_id in (None, actor_id):
        return actor_id
    if not authz.has_permission(actor_id, "crm.assign"):
        raise DomainError("You cannot assign records to other users.", code="permission_denied", status_code=403)
    if not _active_member(owner_id):
        raise ValidationFailed("The owner must be an active member.", code="invalid_owner")
    return owner_id


@transaction.atomic
def update_account(actor_id, account_id, *, name=None, industry=None, segment=None, is_active=None):
    a = _own(m.CrmAccount, account_id, actor_id, "Account", lock=True)
    for field, value in (("name", name), ("industry", industry), ("segment", segment), ("is_active", is_active)):
        if value is not None:
            setattr(a, field, value)
    a.save()
    return a


@transaction.atomic
def create_contact(actor_id, *, first_name, last_name="", email="", phone="", job_title="", account_id=None):
    account = _own(m.CrmAccount, account_id, actor_id, "Account") if account_id else None
    if not first_name.strip():
        raise ValidationFailed("first_name is required.", code="invalid_name")
    return m.Contact.objects.create(account=account, first_name=first_name.strip(), last_name=last_name, email=email, phone=phone, job_title=job_title, owner_id=actor_id)


def segments():
    return list(m.CrmAccount.objects.exclude(segment="").values("segment").annotate(accounts=Count("id")).order_by("-accounts", "segment"))


# ----------------------------------------------------------------------------- leads
def _round_robin_owner():
    """The active sales representative with the fewest open leads (ties: oldest assignment)."""
    reps = RoleAssignment.objects.filter(role__name="sales_rep", revoked_at__isnull=True, valid_from__lte=timezone.now()).filter(authz.models_q_valid(timezone.now())).values_list("user_id", flat=True)
    reps = [r for r in dict.fromkeys(reps) if _active_member(r)]
    if not reps:
        return None
    load = {r: 0 for r in reps}
    for row in m.Lead.objects.filter(owner_id__in=reps, status__in=["NEW", "CONTACTED", "QUALIFIED"]).values("owner_id").annotate(n=Count("id")):
        load[row["owner_id"]] = row["n"]
    return min(reps, key=lambda r: (load[r], str(r)))


@transaction.atomic
def create_lead(actor_id, *, name, company="", email="", phone="", source="", auto_assign=True, owner_id=None):
    if not name.strip():
        raise ValidationFailed("name is required.", code="invalid_name")
    if owner_id is not None:
        owner = _resolve_owner(actor_id, owner_id)
    else:
        owner = _round_robin_owner() if auto_assign else actor_id
        owner = owner or actor_id
    lead = m.Lead.objects.create(name=name.strip(), company=company, email=email, phone=phone, source=source, owner_id=owner, created_by=actor_id)
    record_tenant_event(current_tenant(), "crm.lead.created", actor_user_id=actor_id, target_type="Lead", target_id=lead.id, metadata={"owner": str(owner)})
    return lead


@transaction.atomic
def assign_owner(actor_id, kind, record_id, new_owner_id):
    if not authz.has_permission(actor_id, "crm.assign"):
        raise DomainError("You cannot reassign records.", code="permission_denied", status_code=403)
    model = {"lead": m.Lead, "opportunity": m.Opportunity, "account": m.CrmAccount}[kind]
    obj = model.objects.select_for_update().filter(pk=record_id).first()
    if obj is None:
        raise DomainError("Record not found.", code="not_found", status_code=404)
    if not _active_member(new_owner_id):
        raise ValidationFailed("The new owner must be an active member.", code="invalid_owner")
    old, obj.owner_id = obj.owner_id, new_owner_id
    obj.save(update_fields=["owner_id", "updated_at"])
    record_tenant_event(current_tenant(), "crm.owner.changed", actor_user_id=actor_id, target_type=model.__name__, target_id=obj.id, metadata={"from": str(old), "to": str(new_owner_id)})
    return obj


LEAD_FLOW = {"NEW": ("CONTACTED", "QUALIFIED", "DISQUALIFIED"), "CONTACTED": ("QUALIFIED", "DISQUALIFIED"), "QUALIFIED": ("DISQUALIFIED",)}


@transaction.atomic
def set_lead_status(actor_id, lead_id, status, reason=""):
    lead = _own(m.Lead, lead_id, actor_id, "Lead", lock=True)
    if status not in LEAD_FLOW.get(lead.status, ()):
        raise DomainError(f"A {lead.status} lead cannot move to {status}.", code="invalid_state_transition")
    if status == "DISQUALIFIED":
        if not reason.strip():
            raise ValidationFailed("A reason is required to disqualify a lead.", code="reason_required")
        lead.disqualify_reason = reason[:300]
    lead.status = status
    lead.save()
    return lead


def _stage(code):
    st = m.PipelineStage.objects.filter(code=code).first()
    if st is None:
        raise ValidationFailed("Unknown pipeline stage.", code="invalid_stage")
    return st


@transaction.atomic
def convert_lead(actor_id, lead_id, *, opportunity_name=None, amount=0, currency=None, expected_close=None, account_id=None):
    """Qualified lead → account + contact + opportunity, once. Repeating the call is refused."""
    lead = _own(m.Lead, lead_id, actor_id, "Lead", lock=True)
    if lead.status == "CONVERTED":
        raise DomainError("This lead was already converted.", code="already_converted")
    if lead.status != "QUALIFIED":
        raise DomainError("Only qualified leads can be converted.", code="invalid_state_transition")
    if not Currency.objects.filter(code=currency, is_active=True).exists():
        raise ValidationFailed("An active currency is required for the opportunity.", code="invalid_currency")
    account = _own(m.CrmAccount, account_id, actor_id, "Account") if account_id else m.CrmAccount.objects.create(name=lead.company or lead.name, owner_id=lead.owner_id or actor_id)
    contact = m.Contact.objects.create(account=account, first_name=lead.name, email=lead.email, phone=lead.phone, owner_id=lead.owner_id or actor_id)
    opp = m.Opportunity.objects.create(name=opportunity_name or f"{account.name} opportunity", account=account, contact=contact, stage=_stage("PROSPECTING"), amount=Decimal(str(amount)), currency=currency, expected_close=expected_close, owner_id=lead.owner_id or actor_id)
    lead.status, lead.converted_account, lead.converted_opportunity, lead.converted_at = "CONVERTED", account, opp, timezone.now()
    lead.save()
    m.Activity.objects.filter(lead=lead).update(opportunity=opp)
    events.emit("crm.lead.converted", {"lead_id": str(lead.id), "account_id": str(account.id), "opportunity_id": str(opp.id)}, dedup_key=f"lead-converted-{lead.id}")
    return lead, opp


# ----------------------------------------------------------------------------- opportunities
@transaction.atomic
def create_opportunity(actor_id, *, name, account_id, amount, currency, expected_close=None, contact_id=None, stage="PROSPECTING"):
    account = _own(m.CrmAccount, account_id, actor_id, "Account")
    amount = Decimal(str(amount))
    if amount < 0:
        raise ValidationFailed("amount cannot be negative.", code="invalid_amount")
    if not Currency.objects.filter(code=currency, is_active=True).exists():
        raise ValidationFailed("Currency is not active.", code="invalid_currency")
    st = _stage(stage)
    if st.is_won or st.is_lost:
        raise ValidationFailed("Use win/lose to close an opportunity.", code="invalid_stage")
    return m.Opportunity.objects.create(name=name, account=account, contact_id=contact_id, stage=st, amount=amount, currency=currency, expected_close=expected_close, owner_id=actor_id)


@transaction.atomic
def move_stage(actor_id, opp_id, stage_code):
    opp = _own(m.Opportunity, opp_id, actor_id, "Opportunity", lock=True)
    if opp.status != "OPEN":
        raise DomainError("A closed opportunity cannot change stage.", code="invalid_state_transition")
    st = _stage(stage_code)
    if st.is_won or st.is_lost:
        raise ValidationFailed("Use win/lose to close an opportunity.", code="invalid_stage")
    opp.stage = st
    opp.save(update_fields=["stage", "updated_at"])
    return opp


@transaction.atomic
def win_opportunity(actor_id, opp_id, system=False):
    """`system=True` is used by the sales module when an order for the opportunity is confirmed."""
    opp = m.Opportunity.objects.select_for_update().get(pk=opp_id) if system else _own(m.Opportunity, opp_id, actor_id, "Opportunity", lock=True)
    if opp.status != "OPEN":
        raise DomainError("This opportunity is already closed.", code="invalid_state_transition")
    opp.status, opp.stage, opp.closed_at = "WON", m.PipelineStage.objects.get(is_won=True), timezone.now()
    opp.save()
    events.emit("crm.opportunity.won", {"opportunity_id": str(opp.id), "amount": str(opp.amount), "currency": opp.currency}, dedup_key=f"opportunity-won-{opp.id}")
    return opp


@transaction.atomic
def lose_opportunity(actor_id, opp_id, reason):
    opp = _own(m.Opportunity, opp_id, actor_id, "Opportunity", lock=True)
    if opp.status != "OPEN":
        raise DomainError("This opportunity is already closed.", code="invalid_state_transition")
    if not (reason or "").strip():
        raise ValidationFailed("A reason is required.", code="reason_required")
    opp.status, opp.stage, opp.closed_at, opp.lost_reason = "LOST", m.PipelineStage.objects.get(is_lost=True), timezone.now(), reason[:300]
    opp.save()
    return opp


# ----------------------------------------------------------------------------- activities
@transaction.atomic
def log_activity(actor_id, *, type, subject, due_at=None, notes="", lead_id=None, opportunity_id=None, account_id=None):
    if type not in m.Activity.Type.values:
        raise ValidationFailed("Invalid activity type.", code="invalid_type")
    if not (lead_id or opportunity_id or account_id):
        raise ValidationFailed("An activity must be linked to a lead, opportunity or account.", code="invalid_link")
    lead = _own(m.Lead, lead_id, actor_id, "Lead") if lead_id else None
    opp = _own(m.Opportunity, opportunity_id, actor_id, "Opportunity") if opportunity_id else None
    acct = _own(m.CrmAccount, account_id, actor_id, "Account") if account_id else None
    return m.Activity.objects.create(type=type, subject=subject[:200], notes=notes, due_at=due_at, owner_id=actor_id, lead=lead, opportunity=opp, account=acct)


@transaction.atomic
def complete_activity(actor_id, activity_id):
    a = _own(m.Activity, activity_id, actor_id, "Activity", lock=True)
    if a.done_at:
        raise DomainError("This activity is already done.", code="invalid_state_transition")
    a.done_at = timezone.now()
    a.save(update_fields=["done_at", "updated_at"])
    return a


def followups_due(actor_id, now=None):
    now = now or timezone.now()
    return scope(m.Activity.objects.filter(done_at__isnull=True, due_at__lte=now), actor_id).order_by("due_at")


# ----------------------------------------------------------------------------- analytics
def forecast(actor_id):
    """Open pipeline by expected-close month: total and probability-weighted amount, per currency."""
    out = defaultdict(lambda: {"count": 0, "amount": ZERO, "weighted": ZERO})
    for o in scope(m.Opportunity.objects.filter(status="OPEN").select_related("stage"), actor_id):
        key = (o.expected_close.strftime("%Y-%m") if o.expected_close else "unscheduled", o.currency)
        row = out[key]
        row["count"] += 1
        row["amount"] += o.amount
        row["weighted"] += o.amount * o.stage.probability / 100
    return [{"month": k[0], "currency": k[1], "count": v["count"], "amount": str(v["amount"]), "weighted": str(v["weighted"].quantize(Decimal("0.01")))} for k, v in sorted(out.items())]


def conversion_report(actor_id):
    leads = scope(m.Lead.objects.all(), actor_id)
    by_status = {r["status"]: r["n"] for r in leads.values("status").annotate(n=Count("id"))}
    total = sum(by_status.values())
    opps = scope(m.Opportunity.objects.all(), actor_id)
    won, lost = opps.filter(status="WON").count(), opps.filter(status="LOST").count()
    return {"leads": by_status, "lead_to_opportunity_rate": round(by_status.get("CONVERTED", 0) / total, 4) if total else None, "won": won, "lost": lost, "win_rate": round(won / (won + lost), 4) if won + lost else None}
