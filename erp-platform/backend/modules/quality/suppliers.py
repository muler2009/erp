"""Supplier quality: status, certificates, evaluation and corrective action requests."""
from datetime import timedelta
from decimal import Decimal

from django.db import transaction
from django.db.models import Sum
from django.utils import timezone

from modules.quality import core, models as m
from platform_core.organizations import services as org
from shared.api.errors import DomainError, ValidationFailed
from shared.events import services as events
from shared.notifications.services import notify

STATUSES = ("PENDING", "APPROVED", "CONDITIONAL", "RESTRICTED", "BLOCKED")


def _supplier(pk):
    from modules.procurement.models import Supplier
    s = Supplier.objects.filter(pk=pk).first()
    if s is None:
        raise core.nf("Supplier")
    return s


def profile(supplier_id):
    s = _supplier(supplier_id)
    p, _ = m.SupplierProfile.objects.get_or_create(supplier_id=s.id, defaults={"min_score": org.get_setting("quality.supplier_min_score", 70)})
    return p


def profile_dict(p):
    return {"supplier_id": str(p.supplier_id), "status": p.status, "status_reason": p.status_reason, "min_score": str(p.min_score), "max_rejection_rate": str(p.max_rejection_rate),
            "criteria_note": p.criteria_note, "certificates": [cert_dict(c) for c in m.SupplierCertificate.objects.filter(supplier_id=p.supplier_id).order_by("expires_on")],
            "latest_evaluation": next(iter(evaluation_list(p.supplier_id)[:1]), None), "open_scars": m.Scar.objects.filter(supplier_id=p.supplier_id).exclude(status="CLOSED").count()}


@transaction.atomic
def set_status(actor, supplier_id, *, status, reason, min_score=None, max_rejection_rate=None, criteria_note=None):
    s = _supplier(supplier_id)
    p = m.SupplierProfile.objects.select_for_update().filter(supplier_id=s.id).first() or profile(supplier_id)
    if status not in STATUSES:
        raise ValidationFailed("Unknown status.", code="invalid_fields")
    if not reason:
        raise ValidationFailed("Give the reason for the change.", code="invalid_fields")
    if status == "APPROVED" and m.Scar.objects.filter(supplier_id=s.id).exclude(status="CLOSED").exists():
        raise DomainError("Close the open corrective action requests before approving this supplier.", code="scar_open", status_code=409)
    old = p.status
    p.status, p.status_reason, p.changed_by = status, reason[:300], actor
    if min_score is not None:
        p.min_score = Decimal(str(min_score))
    if max_rejection_rate is not None:
        p.max_rejection_rate = Decimal(str(max_rejection_rate))
    if criteria_note is not None:
        p.criteria_note = criteria_note[:500]
    p.save()
    core.event("supplier", s.id, "STATUS", actor, from_status=old, to_status=status, note=reason)
    if status == "BLOCKED" and s.status != "BLOCKED":
        s.status = "BLOCKED"
        s.save(update_fields=["status", "updated_at"])
    elif old == "BLOCKED" and status != "BLOCKED" and s.status == "BLOCKED":
        s.status = "QUALIFIED"
        s.save(update_fields=["status", "updated_at"])
    events.emit("quality.supplier.status_changed", {"supplier": str(s.id), "status": status}, dedup_key=f"supplier-status:{s.id}:{p.updated_at.timestamp()}")
    core.audit("quality.supplier.status", actor, "quality.supplier", s.id, status=status)
    return p


def cert_dict(c):
    return {"id": str(c.id), "supplier_id": str(c.supplier_id), "name": c.name, "number": c.number, "issuer": c.issuer, "issued_on": c.issued_on.isoformat() if c.issued_on else None,
            "expires_on": c.expires_on.isoformat() if c.expires_on else None, "expired": bool(c.expires_on and c.expires_on < core.today()), "document_id": str(c.document_id) if c.document_id else None}


@transaction.atomic
def add_certificate(actor, supplier_id, data):
    _supplier(supplier_id)
    core.need(data, "name")
    if data.get("issued_on") and data.get("expires_on") and data["expires_on"] < data["issued_on"]:
        raise ValidationFailed("The certificate expires before it was issued.", code="invalid_dates")
    return m.SupplierCertificate.objects.create(supplier_id=supplier_id, name=data["name"][:120], number=data.get("number", ""), issuer=data.get("issuer", ""), issued_on=data.get("issued_on"),
                                                expires_on=data.get("expires_on"), document_id=data.get("document_id"), recorded_by=actor)


def evaluation_dict(e):
    return {"id": str(e.id), "supplier_id": str(e.supplier_id), "period_from": e.period_from.isoformat(), "period_to": e.period_to.isoformat(), "lots_inspected": e.lots_inspected,
            "lots_rejected": e.lots_rejected, "quantity_inspected": str(e.quantity_inspected), "quantity_rejected": str(e.quantity_rejected), "ncr_count": e.ncr_count,
            "scar_open": e.scar_open, "rejection_rate": str(e.rejection_rate), "score": str(e.score), "outcome": e.outcome}


def evaluation_list(supplier_id):
    return [evaluation_dict(e) for e in m.SupplierEvaluation.objects.filter(supplier_id=supplier_id).order_by("-period_to", "-created_at")]


def metrics(supplier_id, date_from, date_to):
    ins = m.Inspection.objects.filter(supplier_id=supplier_id, status="COMPLETED", completed_at__date__gte=date_from, completed_at__date__lte=date_to, stage="INCOMING")
    lots, rejected_lots = ins.count(), ins.filter(result="FAIL").count()
    q = ins.aggregate(i=Sum("quantity_inspected"), r=Sum("quantity_rejected"))
    qi, qr = q["i"] or Decimal(0), q["r"] or Decimal(0)
    rate = (qr / qi * 100) if qi else (Decimal(rejected_lots) / lots * 100 if lots else Decimal(0))
    ncrs = m.Ncr.objects.filter(supplier_id=supplier_id, detected_on__gte=date_from, detected_on__lte=date_to).exclude(status="REJECTED").count()
    scars = m.Scar.objects.filter(supplier_id=supplier_id).exclude(status="CLOSED").count()
    return lots, rejected_lots, qi, qr, ncrs, scars, rate.quantize(Decimal("0.01"))


@transaction.atomic
def evaluate(actor, supplier_id, *, date_from, date_to, apply_status=False):
    """Score = 100 minus the rejection rate (x2), 5 per NCR (max 30) and 5 per open SCAR (max 20), never below 0."""
    p = profile(supplier_id)
    lots, rl, qi, qr, ncrs, scars, rate = metrics(supplier_id, date_from, date_to)
    score = max(Decimal(0), Decimal(100) - min(Decimal(50), rate * 2) - min(Decimal(30), Decimal(ncrs) * 5) - min(Decimal(20), Decimal(scars) * 5)).quantize(Decimal("0.01"))
    outcome = "MEETS" if score >= p.min_score and rate <= p.max_rejection_rate else "BELOW"
    e = m.SupplierEvaluation.objects.create(supplier_id=supplier_id, period_from=date_from, period_to=date_to, lots_inspected=lots, lots_rejected=rl, quantity_inspected=qi, quantity_rejected=qr,
                                            ncr_count=ncrs, scar_open=scars, rejection_rate=rate, score=score, outcome=outcome, evaluated_by=actor)
    core.event("supplier", supplier_id, "EVALUATED", actor, note=f"{score} {outcome}")
    if apply_status and outcome == "BELOW" and p.status == "APPROVED":
        set_status(actor, supplier_id, status="CONDITIONAL", reason=f"Evaluation score {score} below the criteria")
    return e


# ----------------------------------------------------------------------------- SCAR
def scar_dict(s):
    return {"id": str(s.id), "number": s.number, "supplier_id": str(s.supplier_id), "ncr_id": str(s.ncr_id) if s.ncr_id else None, "description": s.description, "due_date": s.due_date.isoformat(),
            "status": s.status, "response": s.response, "review_note": s.review_note, "owner_id": str(s.owner_id), "overdue": s.status in ("OPEN", "REJECTED") and s.due_date < core.today(),
            "history": core.history("scar", s.id)}


@transaction.atomic
def raise_scar(actor, data):
    core.need(data, "supplier_id", "description", "due_date", "owner_id")
    _supplier(data["supplier_id"])
    ncr = None
    if data.get("ncr_id"):
        ncr = m.Ncr.objects.filter(pk=data["ncr_id"]).first()
        if ncr is None:
            raise core.nf("Non-conformance report")
        if ncr.supplier_id and str(ncr.supplier_id) != str(data["supplier_id"]):
            raise ValidationFailed("The non-conformance belongs to another supplier.", code="supplier_mismatch")
    s = m.Scar.objects.create(number=core.number("quality.scar"), supplier_id=data["supplier_id"], ncr=ncr, description=data["description"], due_date=data["due_date"], owner_id=data["owner_id"], created_by=actor)
    core.event("scar", s.id, "RAISED", actor, to_status="OPEN")
    return s


def get_scar(pk):
    s = m.Scar.objects.filter(pk=pk).first()
    if s is None:
        raise core.nf("SCAR")
    return s


@transaction.atomic
def record_response(actor, pk, *, response):
    s = core.lock(m.Scar, pk, "SCAR")
    if s.status not in ("OPEN", "REJECTED"):
        raise core.bad_state("The request is not awaiting a response.")
    if not response:
        raise ValidationFailed("Record the supplier's response.", code="invalid_fields")
    core.set_status(s, "scar", "RESPONDED", actor, "RESPONDED", note=response[:200], response=response, responded_at=timezone.now())
    return s


@transaction.atomic
def review_response(actor, pk, *, accept, note):
    s = core.lock(m.Scar, pk, "SCAR")
    if s.status != "RESPONDED":
        raise core.bad_state("There is no response to review.")
    if not note:
        raise ValidationFailed("Record the review.", code="invalid_fields")
    s.reviewed_by, s.review_note = actor, note[:500]
    core.set_status(s, "scar", "ACCEPTED" if accept else "REJECTED", actor, "ACCEPTED" if accept else "REJECTED", note=note)
    return s


@transaction.atomic
def close_scar(actor, pk, *, note):
    s = core.lock(m.Scar, pk, "SCAR")
    if s.status != "ACCEPTED":
        raise core.bad_state("Only an accepted response can be closed.")
    core.set_status(s, "scar", "CLOSED", actor, "CLOSED", note=note)
    return s


def list_scars(**f):
    qs = m.Scar.objects.all().order_by("-created_at")
    for k in ("status", "supplier_id"):
        if f.get(k):
            qs = qs.filter(**{k: f[k]})
    return qs


def reminders(on):
    n = 0
    notice = int(org.get_setting("quality.certificate_notice_days", 30))
    for c in m.SupplierCertificate.objects.filter(expires_on__lte=on + timedelta(days=notice)).filter(last_reminder_on__isnull=True) | m.SupplierCertificate.objects.filter(expires_on__lte=on + timedelta(days=notice), last_reminder_on__lt=on - timedelta(days=6)):
        users = core.users_with_permission("quality.supplier.manage")
        if users:
            notify(list(users), "quality.certificate_expiring", f"Supplier certificate {'expired' if c.expires_on < on else 'expiring'}", f"{c.name} expires {c.expires_on}", ref_type="quality.supplier", ref_id=str(c.supplier_id))
        c.last_reminder_on = on
        c.save(update_fields=["last_reminder_on"])
        n += 1
    return n
