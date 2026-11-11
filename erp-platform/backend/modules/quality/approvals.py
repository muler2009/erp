"""Quality approvals run through the shared workflow engine. A quality approval never approves money or purchases."""
from django.db import transaction
from django.utils import timezone

from modules.quality import core, models as m
from shared.notifications.services import notify
from shared.workflows import services as workflows

SUBJECTS = {
    "quality.plan": ("plan", m.QualityPlan, "PENDING_APPROVAL", {"approved": "APPROVED", "back": "DRAFT"}),
    "quality.ncr": ("ncr", m.Ncr, "PENDING_APPROVAL", {"approved": "APPROVED", "back": "INVESTIGATING"}),
    "quality.capa": ("capa", m.Capa, "PENDING_APPROVAL", {"approved": "APPROVED", "back": "ANALYSIS"}),
}


def submit(actor, subject, obj, *, title, comment=""):
    inst = workflows.submit(actor, subject, obj.id, title=title, department_id=getattr(obj, "department_id", None), comment=comment)
    obj.workflow_instance_id = inst.id
    return inst


def _owner(obj):
    return getattr(obj, "owner_id", None) or getattr(obj, "reported_by", None) or getattr(obj, "created_by", None)


def on_outcome(instance):
    rec_type, model, pending, states = SUBJECTS[instance.subject_type]
    obj = model.objects.select_for_update().filter(pk=instance.subject_id).first()
    if obj is None or obj.status != pending:
        return
    if instance.status == "APPROVED":
        extra = {"approved_at": timezone.now()} if hasattr(obj, "approved_at") else {}
        core.set_status(obj, rec_type, states["approved"], None, "APPROVED", **extra)
        notify([_owner(obj)], "quality.approved", f"Approved: {getattr(obj, 'number', '')}", "The quality approval is complete.", ref_type=f"quality.{rec_type}", ref_id=str(obj.id))
    else:
        label = "REJECTED" if instance.status == "REJECTED" else "WITHDRAWN"
        core.set_status(obj, rec_type, states["back"], None, label)
        notify([_owner(obj)], "quality.rejected", f"{label.title()}: {getattr(obj, 'number', '')}", "The record is back with you.", ref_type=f"quality.{rec_type}", ref_id=str(obj.id))


def on_event(instance, event):
    rec_type, model, pending, states = SUBJECTS[instance.subject_type]
    obj = model.objects.select_for_update().filter(pk=instance.subject_id).first()
    if obj is None:
        return
    if event == "CHANGES_REQUESTED" and obj.status == pending:
        core.set_status(obj, rec_type, states["back"], None, "CHANGES_REQUESTED")
    elif event == "RESUBMITTED" and obj.status == states["back"]:
        core.set_status(obj, rec_type, pending, None, "RESUBMITTED")


@transaction.atomic
def resubmit(actor, subject, pk, *, comment=""):
    rec_type, model, pending, states = SUBJECTS[subject]
    obj = core.lock(model, pk)
    if obj.status != states["back"] or not obj.workflow_instance_id:
        raise core.bad_state("Only a record with requested changes can be resubmitted.")
    workflows.resubmit(actor, obj.workflow_instance_id, comment=comment)
    return obj
