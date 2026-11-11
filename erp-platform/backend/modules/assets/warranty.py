"""Warranties and warranty claims, insurance policies, renewals, claims, uninsured-asset detection and expiry reminders."""
from datetime import timedelta
from decimal import Decimal

from django.db import transaction
from django.utils import timezone

from modules.assets import maintenance as mt
from modules.assets import models as m
from modules.assets import services as svc
from shared.api.errors import DomainError, ValidationFailed
from shared.notifications.services import notify

ZERO = Decimal("0")


# ----------------------------------------------------------------------------- warranty
@transaction.atomic
def add_warranty(actor_id, asset_id, *, provider_name, start_on, end_on, provider_supplier_id=None, reference="", coverage=""):
    a = svc._get(asset_id)
    if not (provider_name or "").strip():
        raise ValidationFailed("The warranty provider is required.", code="provider_required")
    if end_on < start_on:
        raise ValidationFailed("The warranty cannot end before it starts.", code="invalid_dates")
    w = m.Warranty.objects.create(asset=a, provider_name=provider_name[:160], provider_supplier_id=provider_supplier_id, reference=reference[:60], start_on=start_on, end_on=end_on, coverage=coverage)
    svc.log(a, "WARRANTY_ADDED", actor_id=actor_id, provider=provider_name, until=end_on)
    return w


def active_warranty(asset_id, on=None):
    on = on or timezone.now().date()
    return m.Warranty.objects.filter(asset_id=asset_id, start_on__lte=on, end_on__gte=on).order_by("-end_on").first()


@transaction.atomic
def file_claim(actor_id, warranty_id, *, description, amount_claimed=0, breakdown_id=None, claim_date=None):
    w = m.Warranty.objects.select_for_update(of=("self",)).select_related("asset").filter(pk=warranty_id).first()
    if w is None:
        raise DomainError("Warranty not found.", code="not_found", status_code=404)
    day = claim_date or timezone.now().date()
    if not (w.start_on <= day <= w.end_on):
        raise DomainError("The warranty is not in force on the claim date.", code="warranty_expired")
    if not (description or "").strip():
        raise ValidationFailed("Describe the claim.", code="description_required")
    if breakdown_id and not m.Breakdown.objects.filter(pk=breakdown_id, asset_id=w.asset_id).exists():
        raise ValidationFailed("The breakdown belongs to another asset.", code="invalid_breakdown")
    c = m.WarrantyClaim.objects.create(warranty=w, claim_date=day, description=description, amount_claimed=svc._dec(amount_claimed, "amount_claimed"), breakdown_id=breakdown_id)
    svc.log(w.asset, "WARRANTY_CLAIM_FILED", actor_id=actor_id, claim=c.id)
    return c


def _decide(model, pk, actor_id, status, recovered, name):
    c = model.objects.select_for_update(of=("self",)).filter(pk=pk).first()
    if c is None:
        raise DomainError(f"{name} not found.", code="not_found", status_code=404)
    allowed = {"ACCEPTED": ("FILED",), "REJECTED": ("FILED",), "SETTLED": ("ACCEPTED",)}
    if c.status not in allowed[status]:
        raise DomainError(f"A claim in status {c.status} cannot move to {status}.", code="invalid_state")
    if status == "SETTLED":
        r = svc._dec(recovered, "amount_recovered")
        if r < 0 or r > c.amount_claimed:
            raise ValidationFailed("The recovered amount must be between zero and the amount claimed.", code="invalid_amount")
        c.amount_recovered = r
    c.status, c.decided_by = status, actor_id
    c.save()
    return c


@transaction.atomic
def decide_warranty_claim(actor_id, claim_id, *, status, amount_recovered=0):
    return _decide(m.WarrantyClaim, claim_id, actor_id, status, amount_recovered, "Claim")


# ----------------------------------------------------------------------------- insurance
@transaction.atomic
def create_policy(actor_id, *, policy_number, insurer, start_on, end_on, premium=0, coverage_amount=0, notes="", asset_ids=None, renewed_from=None):
    if not (policy_number or "").strip() or not (insurer or "").strip():
        raise ValidationFailed("Policy number and insurer are required.", code="invalid_policy")
    if end_on < start_on:
        raise ValidationFailed("The policy cannot end before it starts.", code="invalid_dates")
    if m.InsurancePolicy.objects.filter(policy_number=policy_number.strip()).exists():
        raise DomainError("This policy number already exists.", code="duplicate_code")
    p = m.InsurancePolicy.objects.create(policy_number=policy_number.strip(), insurer=insurer[:160], start_on=start_on, end_on=end_on, premium=svc._dec(premium, "premium"), coverage_amount=svc._dec(coverage_amount, "coverage_amount"), notes=notes, renewed_from=renewed_from)
    for aid in asset_ids or []:
        cover(actor_id, p.id, aid)
    return p


@transaction.atomic
def cover(actor_id, policy_id, asset_id, insured_value=None):
    p = m.InsurancePolicy.objects.filter(pk=policy_id).first()
    if p is None:
        raise DomainError("Policy not found.", code="not_found", status_code=404)
    a = svc._get(asset_id)
    if a.status in ("DISPOSED", "RETIRED"):
        raise DomainError("A disposed or retired asset cannot be insured.", code="asset_not_maintainable")
    link, created = m.PolicyAsset.objects.get_or_create(policy=p, asset=a, defaults={"insured_value": svc._dec(insured_value, "insured_value") if insured_value is not None else a.gross_value})
    if created:
        svc.log(a, "INSURED", actor_id=actor_id, policy=p.policy_number, until=p.end_on)
    return link


@transaction.atomic
def uncover(actor_id, policy_id, asset_id):
    n, _ = m.PolicyAsset.objects.filter(policy_id=policy_id, asset_id=asset_id).delete()
    if not n:
        raise DomainError("This asset is not on the policy.", code="not_found", status_code=404)


@transaction.atomic
def renew_policy(actor_id, policy_id, *, policy_number, start_on, end_on, premium=0, coverage_amount=None):
    old = m.InsurancePolicy.objects.select_for_update(of=("self",)).filter(pk=policy_id).first()
    if old is None:
        raise DomainError("Policy not found.", code="not_found", status_code=404)
    if old.renewals.exists():
        raise DomainError("This policy has already been renewed.", code="already_pending")
    new = create_policy(actor_id, policy_number=policy_number, insurer=old.insurer, start_on=start_on, end_on=end_on, premium=premium, coverage_amount=old.coverage_amount if coverage_amount is None else coverage_amount, renewed_from=old)
    for l in old.covered.select_related("asset"):
        if l.asset.status not in ("DISPOSED", "RETIRED"):
            cover(actor_id, new.id, l.asset_id, l.insured_value)
    return new


def is_insured(asset_id, on=None):
    on = on or timezone.now().date()
    return m.PolicyAsset.objects.filter(asset_id=asset_id, policy__start_on__lte=on, policy__end_on__gte=on).exists()


def uninsured_assets(on=None):
    """Assets in service that need insurance (category rule) but have no policy in force."""
    on = on or timezone.now().date()
    qs = m.Asset.objects.filter(category__requires_insurance=True, status__in=("AVAILABLE", "ASSIGNED", "IN_USE", "UNDER_MAINTENANCE", "TRANSFERRED")).select_related("category").order_by("number")
    return [{"asset": a.number, "name": a.name, "category": a.category.code, "gross_value": str(a.gross_value)} for a in qs if not is_insured(a.id, on)]


@transaction.atomic
def file_insurance_claim(actor_id, policy_id, asset_id, *, incident_date, description, amount_claimed=0):
    link = m.PolicyAsset.objects.select_related("policy", "asset").filter(policy_id=policy_id, asset_id=asset_id).first()
    if link is None:
        raise DomainError("The asset is not covered by this policy.", code="not_covered")
    if not (link.policy.start_on <= incident_date <= link.policy.end_on):
        raise DomainError("The policy was not in force on the incident date.", code="policy_not_in_force")
    if not (description or "").strip():
        raise ValidationFailed("Describe the incident.", code="description_required")
    c = m.InsuranceClaim.objects.create(policy=link.policy, asset=link.asset, incident_date=incident_date, description=description, amount_claimed=svc._dec(amount_claimed, "amount_claimed"))
    svc.log(link.asset, "INSURANCE_CLAIM_FILED", actor_id=actor_id, claim=c.id)
    return c


@transaction.atomic
def decide_insurance_claim(actor_id, claim_id, *, status, amount_recovered=0):
    return _decide(m.InsuranceClaim, claim_id, actor_id, status, amount_recovered, "Claim")


# ----------------------------------------------------------------------------- reports and reminders
def expiring(days=30, today=None):
    today = today or timezone.now().date()
    limit = today + timedelta(days=days)
    return {
        "warranties": [{"asset": w.asset.number, "provider": w.provider_name, "end_on": str(w.end_on)} for w in m.Warranty.objects.filter(end_on__gte=today, end_on__lte=limit).select_related("asset").order_by("end_on")],
        "policies": [{"policy": p.policy_number, "insurer": p.insurer, "end_on": str(p.end_on), "renewed": p.renewals.exists()} for p in m.InsurancePolicy.objects.filter(end_on__gte=today, end_on__lte=limit).order_by("end_on")],
    }


@transaction.atomic
def run_reminders(today=None, days=30):
    """Remind about warranties and policies that expire soon; each item at most once every 14 days."""
    today = today or timezone.now().date()
    limit = today + timedelta(days=days)
    sent = 0
    ids = mt._staff_user_ids()
    for w in m.Warranty.objects.select_for_update(of=("self",)).filter(end_on__gte=today, end_on__lte=limit).select_related("asset"):
        if w.last_reminder_on and (today - w.last_reminder_on).days < 14:
            continue
        notify(ids, "assets.warranty_expiring", f"Warranty for {w.asset.number} ends {w.end_on}", w.provider_name, ref_type="assets.warranty", ref_id=str(w.id))
        w.last_reminder_on = today
        w.save(update_fields=["last_reminder_on", "updated_at"])
        sent += 1
    for p in m.InsurancePolicy.objects.select_for_update(of=("self",)).filter(end_on__gte=today, end_on__lte=limit):
        if p.renewals.exists() or (p.last_reminder_on and (today - p.last_reminder_on).days < 14):
            continue
        notify(ids, "assets.policy_expiring", f"Insurance policy {p.policy_number} ends {p.end_on}", p.insurer, ref_type="assets.policy", ref_id=str(p.id))
        p.last_reminder_on = today
        p.save(update_fields=["last_reminder_on", "updated_at"])
        sent += 1
    return sent
