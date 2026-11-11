"""Access grants: who gets which actions on a document or a folder, optionally until a given time."""
from django.db import transaction
from django.utils import timezone

from modules.documents import access, core
from modules.documents import models as m
from shared.api.errors import DomainError, ValidationFailed


@transaction.atomic
def grant(actor, *, subject_type, subject_id, actions, document_id=None, folder_id=None, expires_at=None):
    if bool(document_id) == bool(folder_id):
        raise ValidationFailed("Give either a document or a folder.", code="invalid_fields")
    if subject_type not in ("USER", "DEPARTMENT", "ROLE", "PROJECT") or not subject_id:
        raise ValidationFailed("subject_type must be USER, DEPARTMENT, ROLE or PROJECT.", code="invalid_fields")
    actions = sorted(set(actions or []))
    if not actions or any(a not in access.ACTIONS for a in actions):
        raise ValidationFailed(f"actions must be from {', '.join(access.ACTIONS)}.", code="invalid_actions")
    if expires_at and expires_at <= timezone.now():
        raise ValidationFailed("The expiry must be in the future.", code="invalid_dates")
    doc = folder = None
    if document_id:
        doc = core.lock_doc(document_id)
    else:
        folder = m.Folder.objects.filter(pk=folder_id).first()
        if folder is None:
            raise core.nf("Folder")
    g = m.AccessGrant.objects.create(document=doc, folder=folder, subject_type=subject_type, subject_id=str(subject_id)[:64], actions=actions, expires_at=expires_at, granted_by=actor)
    if doc:
        core.event(doc, "ACCESS_GRANTED", actor, note=f"{subject_type} {subject_id}: {','.join(actions)}")
    core.audit("documents.access.granted", actor, "AccessGrant", g.id, subject=f"{subject_type}:{subject_id}", actions=",".join(actions))
    return g


@transaction.atomic
def revoke(actor, grant_id):
    g = m.AccessGrant.objects.select_for_update().filter(pk=grant_id).first()
    if g is None or g.revoked_at:
        raise DomainError("Grant not found.", code="not_found", status_code=404)
    g.revoked_at = timezone.now()
    g.save(update_fields=["revoked_at", "updated_at"])
    if g.document_id:
        core.event(g.document, "ACCESS_REVOKED", actor, note=f"{g.subject_type} {g.subject_id}")
    core.audit("documents.access.revoked", actor, "AccessGrant", g.id)
    return g
