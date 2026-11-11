"""External documents, correspondence, submittals, review comments, transmittals and RFIs."""
from django.db import transaction
from django.utils import timezone

from modules.documents import access, approval, core
from modules.documents import models as m
from shared.api.errors import DomainError, ValidationFailed
from shared.notifications.services import notify
from shared.sequences import services as sequences

PARTY_TYPES = ("SUPPLIER", "CONTRACTOR", "CONSULTANT", "CUSTOMER", "AUTHORITY", "OTHER")
SUBMISSION = {"RECEIVED": {"UNDER_REVIEW", "ACCEPTED", "REJECTED"}, "SENT": {"ACCEPTED", "REJECTED"}, "UNDER_REVIEW": {"ACCEPTED", "REJECTED"}, "REJECTED": set(), "ACCEPTED": set(), "RESUBMITTED": {"UNDER_REVIEW", "ACCEPTED", "REJECTED"}}


@transaction.atomic
def register_external(actor, *, direction, party_type, party_name, title, category_id, file=None, party_id="", sender="", recipient="", party_reference="", received_on=None, sent_on=None,
                      response_due_on=None, contract_ref="", project_id=None, resubmission_of=None, **doc_fields):
    if direction not in ("INCOMING", "OUTGOING") or party_type not in PARTY_TYPES or not (party_name or "").strip():
        raise ValidationFailed("A direction, a party type and a party name are required.", code="invalid_fields")
    if direction == "INCOMING" and not received_on:
        received_on = core.today()
    if direction == "OUTGOING" and not sent_on:
        sent_on = core.today()
    links = list(doc_fields.pop("links", None) or [])
    for t, pid in (("SUPPLIER", party_id if party_type == "SUPPLIER" else ""), ("CUSTOMER", party_id if party_type == "CUSTOMER" else "")):
        if pid:
            links.append({"type": t, "ref_id": pid})
    if contract_ref:
        links.append({"type": "CONTRACT", "ref_id": contract_ref[:64]})
    d = core.register_document(actor, title=title, category_id=category_id, direction=direction, project_id=project_id, file=file, links=links, origin=f"{party_type.title()}: {party_name}", change_reason=f"{direction.title()} document", **doc_fields)
    orig = None
    if resubmission_of:
        orig = m.ExternalRecord.objects.select_for_update().filter(pk=resubmission_of).first()
        if orig is None or orig.submission_status != "REJECTED":
            raise DomainError("Only a rejected submission can be resubmitted.", code="invalid_state_transition")
    rec = m.ExternalRecord.objects.create(document=d, direction=direction, party_type=party_type, party_name=party_name[:200], party_id=str(party_id)[:64], sender=sender[:200], recipient=recipient[:200], party_reference=party_reference[:100],
                                          received_on=received_on, sent_on=sent_on, response_due_on=response_due_on, contract_ref=contract_ref[:100], resubmission_of=orig,
                                          submission_status="RESUBMITTED" if orig else ("SENT" if direction == "OUTGOING" else "RECEIVED"))
    if not d.category.is_controlled and file:  # uncontrolled categories (correspondence, submittals) are registered as issued
        v = d.versions.first()
        approval.publish_version(actor, v.id) if access.can(actor, d, "PUBLISH") else None
    return rec


@transaction.atomic
def update_submission(actor, record_id, status, *, note=""):
    r = m.ExternalRecord.objects.select_for_update().select_related("document").filter(pk=record_id).first()
    if r is None or not access.can(actor, r.document, "REVIEW"):
        raise core.nf("External document")
    if status not in SUBMISSION.get(r.submission_status, set()):
        raise DomainError(f"A {r.submission_status} submission cannot become {status}.", code="invalid_state_transition")
    if status == "REJECTED" and not (note or "").strip():
        raise ValidationFailed("A reason is required when rejecting a submission.", code="comment_required")
    old = r.submission_status
    r.submission_status = status
    r.save()
    core.event(r.document, "SUBMISSION_" + status, actor, from_status=old, to_status=status, note=note)
    return r


@transaction.atomic
def mark_responded(actor, record_id, *, responded_on=None):
    r = m.ExternalRecord.objects.select_for_update().select_related("document").filter(pk=record_id).first()
    if r is None or not access.can(actor, r.document, "REVIEW"):
        raise core.nf("External document")
    r.responded_on = responded_on or core.today()
    r.save(update_fields=["responded_on", "updated_at"])
    core.event(r.document, "RESPONDED", actor)
    return r


@transaction.atomic
def add_comment(actor, doc_id, comment, *, version_id=None):
    d = core.get_doc(actor, doc_id, "REVIEW")
    if not (comment or "").strip():
        raise ValidationFailed("A comment is required.", code="comment_required")
    if version_id and not d.versions.filter(pk=version_id).exists():
        raise ValidationFailed("Unknown version.", code="invalid_fields")
    c = m.ReviewComment.objects.create(document=d, version_id=version_id or d.current_version_id, author_id=actor, comment=comment)
    if d.owner_id != actor:
        notify([d.owner_id], "documents.comment", f"Comment on {d.reference}", comment[:200], ref_type="documents.document", ref_id=str(d.id))
    return c


@transaction.atomic
def respond_comment(actor, comment_id, response, *, resolve=False):
    c = m.ReviewComment.objects.select_for_update().select_related("document").filter(pk=comment_id).first()
    if c is None or not access.can(actor, c.document, "EDIT") and c.author_id != actor:
        raise core.nf("Comment")
    if not (response or "").strip():
        raise ValidationFailed("A response is required.", code="comment_required")
    c.response, c.responded_by = response, actor
    if resolve:
        c.status = "RESOLVED"
    c.save()
    notify([c.author_id], "documents.comment_response", f"Response on {c.document.reference}", response[:200], ref_type="documents.document", ref_id=str(c.document_id))
    return c


@transaction.atomic
def resolve_comment(actor, comment_id):
    c = m.ReviewComment.objects.select_for_update().select_related("document").filter(pk=comment_id).first()
    if c is None or (c.author_id != actor and not access.can(actor, c.document, "REVIEW")):
        raise core.nf("Comment")
    c.status = "RESOLVED"
    c.save(update_fields=["status", "updated_at"])
    return c


# ----------------------------------------------------------------------------- transmittals
@transaction.atomic
def create_transmittal(actor, *, direction, party_name, items, project_id=None, purpose="FOR_INFORMATION", response_due_on=None, notes=""):
    if direction not in ("OUTGOING", "INCOMING") or not (party_name or "").strip() or not items:
        raise ValidationFailed("A direction, a party and at least one document are required.", code="invalid_fields")
    if purpose not in ("FOR_INFORMATION", "FOR_REVIEW", "FOR_APPROVAL", "FOR_CONSTRUCTION", "AS_BUILT"):
        raise ValidationFailed("Unknown purpose.", code="invalid_fields")
    if project_id:
        core._validate_link("PROJECT", str(project_id))
    rows = []
    for it in items:
        d = m.Document.objects.select_related("classification").filter(pk=it.get("document"), deleted_at__isnull=True).first()
        if d is None or not access.can(actor, d, "DOWNLOAD"):
            raise ValidationFailed("Every document must exist and be readable by you.", code="invalid_document")
        v = d.versions.filter(pk=it["version"]).first() if it.get("version") else d.current_version
        if v is None or v.status not in ("PUBLISHED", "SUPERSEDED", "OBSOLETE", "APPROVED"):
            raise DomainError(f"{d.reference} has no issued version to transmit.", code="no_issued_version")
        if d.status in ("OBSOLETE", "ARCHIVED") or (v.status in ("SUPERSEDED", "OBSOLETE") and direction == "OUTGOING"):
            raise DomainError(f"{d.reference}: only the current approved version can be sent.", code="superseded_version")
        rows.append((d, v))
    if len({d.id for d, _ in rows}) != len(rows):
        raise ValidationFailed("A document can appear once per transmittal.", code="duplicate_item")
    t = m.Transmittal.objects.create(number=sequences.next_number("documents.transmittal", on_date=core.today(), for_type="Transmittal"), project_id=project_id, direction=direction, party_name=party_name[:200], purpose=purpose,
                                     sent_on=core.today(), response_due_on=response_due_on, notes=notes[:500], created_by=actor)
    for d, v in rows:
        m.TransmittalItem.objects.create(transmittal=t, document=d, version=v)
        core.event(d, "TRANSMITTED", actor, version=v, note=f"{t.number} to {party_name}")
    core.audit("documents.transmittal.created", actor, "Transmittal", t.id, number=t.number)
    return t


# ----------------------------------------------------------------------------- RFIs
@transaction.atomic
def create_rfi(actor, *, project_id, subject, question, assigned_to, due_date=None, document_id=None):
    core._validate_link("PROJECT", str(project_id))
    core._check_user(assigned_to)
    if not (subject or "").strip() or not (question or "").strip():
        raise ValidationFailed("A subject and a question are required.", code="invalid_fields")
    if document_id and not m.Document.objects.filter(pk=document_id, deleted_at__isnull=True).exists():
        raise ValidationFailed("Unknown document.", code="invalid_document")
    r = m.Rfi.objects.create(number=sequences.next_number("documents.rfi", on_date=core.today(), for_type="RFI"), project_id=project_id, subject=subject[:250], question=question, raised_by=actor, assigned_to=assigned_to, due_date=due_date, document_id=document_id or None)
    notify([assigned_to], "documents.rfi_assigned", f"RFI {r.number}: {r.subject}", question[:200], ref_type="documents.rfi", ref_id=str(r.id))
    return r


@transaction.atomic
def answer_rfi(actor, rfi_id, response):
    r = m.Rfi.objects.select_for_update().filter(pk=rfi_id).first()
    if r is None or r.assigned_to != actor:
        raise core.nf("RFI")
    if r.status != "OPEN" or not (response or "").strip():
        raise DomainError("An open RFI and a response are required.", code="invalid_state_transition")
    r.status, r.response, r.answered_at = "ANSWERED", response, timezone.now()
    r.save()
    notify([r.raised_by], "documents.rfi_answered", f"RFI {r.number} answered", response[:200], ref_type="documents.rfi", ref_id=str(r.id))
    return r


@transaction.atomic
def close_rfi(actor, rfi_id):
    r = m.Rfi.objects.select_for_update().filter(pk=rfi_id).first()
    if r is None or r.raised_by != actor:
        raise core.nf("RFI")
    if r.status != "ANSWERED":
        raise DomainError("Only an answered RFI can be closed.", code="invalid_state_transition")
    r.status = "CLOSED"
    r.save(update_fields=["status", "updated_at"])
    return r
