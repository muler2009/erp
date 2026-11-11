"""Review and approval through the shared workflow engine, publication, obsolescence and archiving."""
from datetime import timedelta

from django.db import transaction
from django.utils import timezone

from modules.documents import access, core
from modules.documents import models as m
from platform_core.organizations import services as org
from shared.api.errors import DomainError, ValidationFailed
from shared.events import services as events
from shared.notifications.services import notify
from shared.workflows import services as workflows


def _version(pk, lock=True):
    qs = m.DocumentVersion.objects.select_for_update() if lock else m.DocumentVersion.objects
    v = qs.filter(pk=pk).first()
    if v is None:
        raise core.nf("Version")
    return v


def _has_published(doc):
    return doc.versions.filter(status="PUBLISHED").exists()


@transaction.atomic
def submit_for_approval(actor, version_id, *, comment=""):
    v = _version(version_id)
    d = core.lock_doc(v.document_id)
    if not (access.can(actor, d, "EDIT") or access.can(actor, d, "UPLOAD")):
        raise core.nf("Version")
    if v.status != "DRAFT":
        raise DomainError("Only a draft version can be submitted for approval.", code="invalid_state_transition")
    if not v.file_id:
        raise ValidationFailed("Upload the document file before submitting it.", code="file_required")
    core._check_metadata(d.category, d.metadata)
    if d.category.requires_expiry and not d.expiry_date:
        raise ValidationFailed("This category needs an expiry date.", code="expiry_required")
    if not d.category.is_controlled:
        raise DomainError("Documents in this category are not controlled; publish them directly.", code="not_controlled")
    inst = workflows.submit(actor, "documents.version", v.id, title=f"{d.reference} v{v.label}: {d.title}", department_id=d.department_id, comment=comment)
    v.status, v.submitted_at, v.workflow_instance_id = "UNDER_REVIEW", timezone.now(), inst.id
    v.save(update_fields=["status", "submitted_at", "workflow_instance_id", "updated_at"])
    if not _has_published(d):
        core.set_status(d, "UNDER_REVIEW", actor, "SUBMITTED", version=v, note=comment)
    else:
        core.event(d, "SUBMITTED", actor, version=v, note=comment)
    return v


@transaction.atomic
def resubmit(actor, version_id, *, comment=""):
    v = _version(version_id)
    if v.status != "CHANGES_REQUESTED" or not v.workflow_instance_id:
        raise DomainError("Only a version with requested changes can be resubmitted.", code="invalid_state_transition")
    if not v.file_id:
        raise ValidationFailed("Upload the corrected file before resubmitting.", code="file_required")
    workflows.resubmit(actor, v.workflow_instance_id, comment=comment)
    return _version(version_id, lock=False)


@transaction.atomic
def withdraw(actor, version_id, *, comment=""):
    v = _version(version_id)
    if v.status not in ("UNDER_REVIEW", "CHANGES_REQUESTED") or not v.workflow_instance_id:
        raise DomainError("Only a version under review can be withdrawn.", code="invalid_state_transition")
    workflows.cancel(actor, v.workflow_instance_id, comment=comment)
    return _version(version_id, lock=False)


# ----------------------------------------------------------------------------- workflow callbacks (inside the engine's transaction)
def _last_comment(instance):
    a = instance.actions.exclude(comment="").order_by("-created_at").first() if hasattr(instance, "actions") else None
    return (a.comment if a else "")[:500]


def on_event(instance, event):
    v = m.DocumentVersion.objects.select_for_update().filter(pk=instance.subject_id).first()
    if v is None:
        return
    d = v.document
    if event == "CHANGES_REQUESTED":
        v.status, v.rejection_note = "CHANGES_REQUESTED", _last_comment(instance)
        v.save(update_fields=["status", "rejection_note", "updated_at"])
        if not _has_published(d):
            core.set_status(d, "CHANGES_REQUESTED", None, "CHANGES_REQUESTED", version=v, note=v.rejection_note)
        else:
            core.event(d, "CHANGES_REQUESTED", None, version=v, note=v.rejection_note)
        notify([v.created_by, d.owner_id], "documents.changes_requested", f"Changes requested: {d.reference}", v.rejection_note, ref_type="documents.document", ref_id=str(d.id))
    elif event == "RESUBMITTED":
        v.status = "UNDER_REVIEW"
        v.save(update_fields=["status", "updated_at"])
        if not _has_published(d):
            core.set_status(d, "UNDER_REVIEW", None, "RESUBMITTED", version=v)
        else:
            core.event(d, "RESUBMITTED", None, version=v)


def on_outcome(instance):
    v = m.DocumentVersion.objects.select_for_update().filter(pk=instance.subject_id).first()
    if v is None:
        return
    d = m.Document.objects.select_for_update().get(pk=v.document_id)
    first = not _has_published(d)
    if instance.status == "APPROVED":
        v.status, v.approved_at = "APPROVED", timezone.now()
        v.save(update_fields=["status", "approved_at", "updated_at"])
        if first:
            core.set_status(d, "APPROVED", None, "APPROVED", version=v)
        else:
            core.event(d, "APPROVED", None, version=v)
        notify([d.owner_id, v.created_by], "documents.approved", f"Approved: {d.reference} v{v.label}", "Ready to publish.", ref_type="documents.document", ref_id=str(d.id))
        if org.get_setting("documents.auto_publish", False):
            _publish(v, d, None)
    else:  # REJECTED or CANCELLED: the author gets the draft back
        note = _last_comment(instance) if instance.status == "REJECTED" else "Withdrawn"
        v.status, v.rejection_note = "DRAFT", note
        v.save(update_fields=["status", "rejection_note", "updated_at"])
        label = "REJECTED" if instance.status == "REJECTED" else "WITHDRAWN"
        if first:
            core.set_status(d, "DRAFT", None, label, version=v, note=note)
        else:
            core.event(d, label, None, version=v, note=note)
        if instance.status == "REJECTED":
            notify([d.owner_id, v.created_by], "documents.rejected", f"Rejected: {d.reference}", note, ref_type="documents.document", ref_id=str(d.id))


# ----------------------------------------------------------------------------- publication
def _publish(v, d, actor):
    today = core.today()
    old = d.versions.filter(status="PUBLISHED").exclude(pk=v.pk).first()
    if old:
        old.status, old.superseded_at = "SUPERSEDED", timezone.now()
        old.save(update_fields=["status", "superseded_at", "updated_at"])
        core.event(d, "SUPERSEDED", actor, version=old, note=f"Replaced by {v.label}")
    v.status, v.published_at, v.published_by = "PUBLISHED", timezone.now(), actor
    v.save(update_fields=["status", "published_at", "published_by", "updated_at"])
    d.effective_date = d.effective_date if (d.effective_date and not old and d.effective_date >= today) else today
    d.current_version = v
    d.next_review_date = d.effective_date + timedelta(days=d.category.review_interval_days) if d.category.review_interval_days else None
    d.review_notified_on = None
    d.save(update_fields=["current_version", "effective_date", "next_review_date", "review_notified_on", "updated_at"])
    core.set_status(d, "PUBLISHED", actor, "PUBLISHED", version=v, note=f"Version {v.label}")
    from modules.documents import distribution
    distribution.on_new_version(d, old, v)
    events.emit("documents.version.published", {"document": str(d.id), "version": str(v.id), "reference": d.reference, "label": v.label}, dedup_key=f"doc-published:{v.id}")
    core.audit("documents.version.published", actor, "DocumentVersion", v.id, reference=d.reference, label=v.label)


@transaction.atomic
def publish_version(actor, version_id):
    v = _version(version_id)
    d = core.lock_doc(v.document_id)
    if not access.can(actor, d, "PUBLISH"):
        raise core.nf("Version")
    if d.category.is_controlled:
        if v.status != "APPROVED":
            raise DomainError("Only an approved version can be published as a controlled document.", code="not_approved")
    elif v.status not in ("DRAFT", "APPROVED"):
        raise DomainError(f"A {v.status} version cannot be published.", code="invalid_state_transition")
    if not v.file_id:
        raise ValidationFailed("The version has no file.", code="file_required")
    if d.category.requires_expiry and not d.expiry_date:
        raise ValidationFailed("This category needs an expiry date.", code="expiry_required")
    core._check_metadata(d.category, d.metadata)
    if v.status == "DRAFT":
        v.approved_at = timezone.now()  # uncontrolled categories are issued on the publisher's authority
    _publish(v, d, actor)
    return v


@transaction.atomic
def mark_obsolete(actor, doc_id, *, reason, replaced_by_id=None):
    d = core.lock_doc(doc_id)
    if not access.can(actor, d, "PUBLISH"):
        raise core.nf()
    if d.status != "PUBLISHED":
        raise DomainError("Only a published document can be made obsolete.", code="invalid_state_transition")
    if not (reason or "").strip():
        raise ValidationFailed("A reason is required.", code="reason_required")
    if replaced_by_id and not m.Document.objects.filter(pk=replaced_by_id, deleted_at__isnull=True).exclude(pk=d.pk).exists():
        raise ValidationFailed("Unknown replacement document.", code="invalid_replacement")
    _obsolete(d, actor, reason + (f" (replaced by {m.Document.objects.get(pk=replaced_by_id).reference})" if replaced_by_id else ""))
    return d


def _obsolete(d, actor, note):
    v = d.current_version
    if v and v.status == "PUBLISHED":
        v.status = "OBSOLETE"
        v.save(update_fields=["status", "updated_at"])
    d.versions.filter(status__in=("DRAFT", "UNDER_REVIEW", "CHANGES_REQUESTED", "APPROVED")).update(status="OBSOLETE")
    d.next_review_date = None
    d.save(update_fields=["next_review_date", "updated_at"])
    core.set_status(d, "OBSOLETE", actor, "OBSOLETED", version=v, note=note)
    m.Acknowledgement.objects.filter(document=d, status="PENDING").update(status="WITHDRAWN")
    events.emit("documents.document.obsoleted", {"document": str(d.id), "reference": d.reference}, dedup_key=f"doc-obsolete:{d.id}")
    core.audit("documents.document.obsoleted", actor, "Document", d.id, reference=d.reference)


# ----------------------------------------------------------------------------- archive, retention and disposal
@transaction.atomic
def archive_document(actor, doc_id, *, reason=""):
    d = core.lock_doc(doc_id)
    if not access.can(actor, d, "ARCHIVE"):
        raise core.nf()
    expired = d.status == "PUBLISHED" and d.expiry_date and d.expiry_date < core.today()
    if d.status != "OBSOLETE" and not expired:
        raise DomainError("Only obsolete or expired documents can be archived.", code="invalid_state_transition")
    if d.status == "PUBLISHED":
        _obsolete(d, actor, "Expired")
    d.archived_at, d.archived_by = timezone.now(), actor
    if d.category.retention_years:
        d.retention_until = core.today() + timedelta(days=365 * d.category.retention_years)
    d.save(update_fields=["archived_at", "archived_by", "retention_until", "updated_at"])
    core.set_status(d, "ARCHIVED", actor, "ARCHIVED", note=reason)
    core.audit("documents.document.archived", actor, "Document", d.id, reference=d.reference, retention_until=d.retention_until)
    return d


@transaction.atomic
def set_retention(actor, doc_id, *, retention_until=None, legal_hold=None):
    d = core.lock_doc(doc_id)
    if not access.can(actor, d, "ARCHIVE"):
        raise core.nf()
    if retention_until is not None:
        if d.retention_until and retention_until < d.retention_until:
            raise DomainError("The retention period can be extended, not shortened.", code="retention_shortened")
        d.retention_until = retention_until
    if legal_hold is not None:
        d.legal_hold = bool(legal_hold)
    d.save(update_fields=["retention_until", "legal_hold", "updated_at"])
    core.event(d, "RETENTION_SET", actor, note=f"until {d.retention_until}, hold {d.legal_hold}")
    return d


@transaction.atomic
def request_disposal(actor, doc_id, *, reason):
    d = core.lock_doc(doc_id)
    if not access.can(actor, d, "ARCHIVE"):
        raise core.nf()
    if d.status != "ARCHIVED":
        raise DomainError("Only archived documents can be disposed of.", code="invalid_state_transition")
    if d.legal_hold:
        raise DomainError("This document is under legal hold.", code="legal_hold")
    if d.retention_until is None:
        raise DomainError("No retention period is defined for this document; set one before requesting disposal.", code="retention_not_defined")
    if d.retention_until > core.today():
        raise DomainError(f"The retention period runs until {d.retention_until}.", code="retention_active")
    if not (reason or "").strip():
        raise ValidationFailed("A reason is required.", code="reason_required")
    if d.disposals.filter(status__in=("PENDING", "APPROVED")).exists():
        raise DomainError("A disposal request is already open.", code="already_requested")
    r = m.DisposalRequest.objects.create(document=d, requested_by=actor, reason=reason[:500], snapshot={"reference": d.reference, "title": d.title, "category": d.category.code, "versions": [{"label": v.label, "sha256": v.sha256, "file": v.file_name} for v in d.versions.all()]})
    core.event(d, "DISPOSAL_REQUESTED", actor, note=reason)
    return r


@transaction.atomic
def decide_disposal(actor, request_id, *, approve, note=""):
    r = m.DisposalRequest.objects.select_for_update().filter(pk=request_id).first()
    if r is None:
        raise core.nf("Disposal request")
    if r.status != "PENDING":
        raise DomainError("This request was already decided.", code="invalid_state_transition")
    if r.requested_by == actor:
        raise DomainError("You cannot approve disposal that you requested.", code="separation_of_duties", status_code=403)
    if not approve and not (note or "").strip():
        raise ValidationFailed("A note is required to reject disposal.", code="comment_required")
    r.status, r.decided_by, r.decided_at, r.decision_note = ("APPROVED" if approve else "REJECTED"), actor, timezone.now(), note[:500]
    r.save()
    core.event(r.document, "DISPOSAL_APPROVED" if approve else "DISPOSAL_REJECTED", actor, note=note)
    return r


@transaction.atomic
def execute_disposal(actor, request_id):
    r = m.DisposalRequest.objects.select_for_update().filter(pk=request_id).first()
    if r is None:
        raise core.nf("Disposal request")
    d = core.lock_doc(r.document_id)
    if r.status != "APPROVED":
        raise DomainError("Only an approved disposal can be carried out.", code="invalid_state_transition")
    if d.legal_hold or d.retention_until is None or d.retention_until > core.today():
        raise DomainError("The document is no longer eligible for disposal.", code="retention_active")
    for v in d.versions.all():
        core._release_file(v)
        m.VersionText.objects.filter(version=v).delete()
    d.disposed_at = timezone.now()
    d.save(update_fields=["disposed_at", "updated_at"])
    r.status, r.executed_at = "EXECUTED", timezone.now()
    r.save()
    core.event(d, "DISPOSED", actor, note=r.reason)
    core.audit("documents.document.disposed", actor, "Document", d.id, reference=d.reference, request=r.id)
    return r
