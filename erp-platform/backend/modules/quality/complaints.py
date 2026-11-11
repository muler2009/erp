"""Customer complaints, from receipt to confirmed resolution."""
from datetime import timedelta

from django.db import transaction

from modules.quality import core, ncr, models as m
from shared.api.errors import DomainError, ValidationFailed
from shared.notifications.services import notify


def complaint_dict(c, detail=False):
    d = {"id": str(c.id), "number": c.number, "complaint_type": c.complaint_type, "severity": c.severity, "status": c.status, "customer_id": str(c.customer_id) if c.customer_id else None,
         "customer_name": c.customer_name, "product_id": str(c.product_id) if c.product_id else None, "sales_order_id": str(c.sales_order_id) if c.sales_order_id else None,
         "lot_number": c.lot_number, "received_on": c.received_on.isoformat(), "investigator_id": str(c.investigator_id), "capa_id": str(c.capa_id) if c.capa_id else None,
         "is_recurring": c.is_recurring, "responded_on": c.responded_on.isoformat() if c.responded_on else None}
    if detail:
        d.update({"description": c.description, "channel": c.channel, "findings": c.findings, "response_text": c.response_text, "resolution": c.resolution,
                  "customer_confirmed_on": c.customer_confirmed_on.isoformat() if c.customer_confirmed_on else None, "evidence": core.list_evidence("complaint", c.id),
                  "costs": core.costs_for("complaint", c.id), "actions": core.list_actions("complaint", c.id), "history": core.history("complaint", c.id)})
    return d


def get(pk):
    c = m.Complaint.objects.filter(pk=pk).first()
    if c is None:
        raise core.nf("Complaint")
    return c


@transaction.atomic
def register(actor, data):
    core.need(data, "complaint_type", "severity", "description", "investigator_id")
    if not (data.get("customer_id") or data.get("customer_name")):
        raise ValidationFailed("Identify the customer.", code="invalid_fields")
    core.config_item("COMPLAINT_TYPE", data["complaint_type"])
    core.config_item("SEVERITY", data["severity"])
    recurring = False
    if data.get("product_id"):
        since = core.today() - timedelta(days=180)
        recurring = m.Complaint.objects.filter(product_id=data["product_id"], received_on__gte=since).exclude(status="CLOSED").exists() or \
            m.Complaint.objects.filter(product_id=data["product_id"], received_on__gte=since).count() >= 2
    c = m.Complaint.objects.create(number=core.number("quality.complaint"), complaint_type=data["complaint_type"], severity=data["severity"], customer_id=data.get("customer_id"),
                                   customer_name=data.get("customer_name", ""), product_id=data.get("product_id"), sales_order_id=data.get("sales_order_id"), delivery_id=data.get("delivery_id"),
                                   project_id=data.get("project_id"), lot_number=data.get("lot_number", ""), description=data["description"], received_on=data.get("received_on") or core.today(),
                                   channel=data.get("channel", ""), investigator_id=data["investigator_id"], is_recurring=recurring, recorded_by=actor)
    core.event("complaint", c.id, "RECEIVED", actor, to_status="RECEIVED")
    notify([c.investigator_id], "quality.complaint_assigned", f"Complaint {c.number}", c.description[:200], ref_type="quality.complaint", ref_id=str(c.id))
    if recurring:
        notify(list(core.users_with_permission("quality.complaint.manage") - {actor}), "quality.complaint_recurring", f"Recurring complaint on product ({c.number})", "Similar complaints were received recently.", ref_type="quality.complaint", ref_id=str(c.id))
    return c


@transaction.atomic
def investigate(actor, pk, *, findings, lot_number=None):
    c = core.lock(m.Complaint, pk, "Complaint")
    if c.status not in ("RECEIVED", "INVESTIGATING"):
        raise core.bad_state("The complaint is already responded to.")
    if not findings:
        raise ValidationFailed("Record the findings.", code="invalid_fields")
    c.findings = findings
    if lot_number:
        c.lot_number = lot_number
    core.set_status(c, "complaint", "INVESTIGATING", actor, "INVESTIGATED", note=findings[:200])
    return c


@transaction.atomic
def raise_ncr(actor, pk, *, category, severity=None, containment=""):
    c = core.lock(m.Complaint, pk, "Complaint")
    n = ncr.raise_ncr(actor, {"title": f"Complaint {c.number}", "source": "COMPLAINT", "source_ref_type": "quality.complaint", "source_ref_id": str(c.id), "category": category,
                              "severity": severity or c.severity, "product_id": c.product_id, "project_id": c.project_id, "lot_number": c.lot_number, "description": c.description})
    if containment:
        n.containment = containment
        n.save(update_fields=["containment", "updated_at"])
    core.event("complaint", c.id, "NCR_RAISED", actor, note=n.number)
    return n


@transaction.atomic
def link_capa(actor, pk, *, owner_id, reviewer_id, due_date):
    c = core.lock(m.Complaint, pk, "Complaint")
    if c.capa_id:
        raise ValidationFailed("A CAPA is already linked.", code="duplicate")
    k = ncr.create_capa_record(actor, {"kind": "CORRECTIVE", "title": f"CAPA for complaint {c.number}", "source_type": "COMPLAINT", "source_id": c.id, "problem": c.description,
                                       "owner_id": owner_id, "reviewer_id": reviewer_id, "due_date": due_date})
    c.capa_id = k.id
    c.save(update_fields=["capa_id", "updated_at"])
    core.event("complaint", c.id, "CAPA_LINKED", actor, note=k.number)
    return k


@transaction.atomic
def respond(actor, pk, *, response_text, resolution):
    c = core.lock(m.Complaint, pk, "Complaint")
    if c.status != "INVESTIGATING":
        raise core.bad_state("Investigate the complaint before responding.")
    if not response_text or not resolution:
        raise ValidationFailed("Record the response and the resolution.", code="invalid_fields")
    core.set_status(c, "complaint", "RESPONDED", actor, "RESPONDED", note=resolution, response_text=response_text, resolution=resolution[:500], responded_on=core.today())
    return c


@transaction.atomic
def close(actor, pk, *, customer_confirmed_on=None, note=""):
    c = core.lock(m.Complaint, pk, "Complaint")
    if c.status != "RESPONDED":
        raise core.bad_state("Only a responded complaint can be closed.")
    if not customer_confirmed_on and not note:
        raise ValidationFailed("Record the customer's confirmation, or why none was obtained.", code="confirmation_required")
    sev = m.ConfigItem.objects.filter(kind="SEVERITY", code=c.severity).first()
    if sev and sev.requires_capa:
        k = m.Capa.objects.filter(pk=c.capa_id).first() if c.capa_id else None
        if k is None:
            raise DomainError("This severity requires a CAPA before the complaint can be closed.", code="capa_required", status_code=409)
    core.set_status(c, "complaint", "CLOSED", actor, "CLOSED", note=note, customer_confirmed_on=customer_confirmed_on)
    return c


def list_complaints(**f):
    qs = m.Complaint.objects.all().order_by("-received_on", "-created_at")
    for k in ("status", "severity", "complaint_type", "product_id", "customer_id", "investigator_id"):
        if f.get(k):
            qs = qs.filter(**{k: f[k]})
    return qs
