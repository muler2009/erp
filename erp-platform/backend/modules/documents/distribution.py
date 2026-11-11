"""Controlled distribution, required reading and acknowledgement."""
from datetime import timedelta

from django.db import IntegrityError, transaction
from django.db.models import Q
from django.utils import timezone

from modules.documents import access, core
from modules.documents import models as m
from platform_core.authorization.models import RoleAssignment
from platform_core.organizations.models import TenantUserProfile
from platform_core.users.models import TenantMembership
from shared.api.errors import DomainError, ValidationFailed
from shared.notifications.services import notify
from shared.tenancy import current_tenant


def _active(user_ids):
    return set(TenantMembership.objects.filter(tenant=current_tenant(), user_id__in=set(user_ids), status="ACTIVE").values_list("user_id", flat=True))


def expand(target_type, target_id):
    """The active users a distribution target stands for."""
    if target_type == "USER":
        ids = {target_id}
    elif target_type == "DEPARTMENT":
        ids = {str(x) for x in TenantUserProfile.objects.filter(department_id=target_id).values_list("user_id", flat=True)}
    elif target_type == "ROLE":
        now = timezone.now()
        ids = {str(x) for x in RoleAssignment.objects.filter(role__name=target_id).filter(Q(valid_to__isnull=True) | Q(valid_to__gt=now)).values_list("user_id", flat=True)}
    else:
        raise ValidationFailed("target type must be USER, DEPARTMENT or ROLE.", code="invalid_fields")
    return _active(ids)


@transaction.atomic
def distribute(actor, doc_id, targets, *, requires_acknowledgement=False, due_date=None):
    d = core.lock_doc(doc_id)
    if not access.can(actor, d, "VIEW") or not (access.can(actor, d, "EDIT") or access.can(actor, d, "PUBLISH") or _distributor(actor)):
        raise core.nf()
    v = d.current_version
    if d.status != "PUBLISHED" or v is None:
        raise DomainError("Only a published document can be distributed.", code="not_published")
    if not targets:
        raise ValidationFailed("At least one target is required.", code="invalid_fields")
    users = set()
    for t in targets:
        ids = expand(t.get("type"), str(t.get("id")))
        if not ids:
            raise ValidationFailed(f"{t.get('type')} {t.get('id')} has no active members.", code="empty_target")
        users |= ids
        m.Distribution.objects.create(document=d, version=v, target_type=t["type"], target_id=str(t["id"])[:64], requires_acknowledgement=requires_acknowledgement, due_date=due_date, distributed_by=actor)
        if not m.AccessGrant.objects.filter(document=d, subject_type=t["type"], subject_id=str(t["id"]), revoked_at__isnull=True).exists():
            m.AccessGrant.objects.create(document=d, subject_type=t["type"], subject_id=str(t["id"])[:64], actions=["VIEW", "DOWNLOAD"], granted_by=actor)
    if requires_acknowledgement:
        for u in users:
            m.Acknowledgement.objects.get_or_create(version=v, user_id=u, defaults={"document": d, "due_date": due_date})
    notify(users, "documents.distributed", f"{'Please read: ' if requires_acknowledgement else 'New document: '}{d.reference} {d.title}", f"Version {v.label}", ref_type="documents.document", ref_id=str(d.id))
    core.event(d, "DISTRIBUTED", actor, version=v, note=f"{len(users)} user(s){', acknowledgement required' if requires_acknowledgement else ''}")
    return sorted(str(u) for u in users)


def _distributor(user_id):
    from platform_core.authorization import services as authz
    return authz.has_permission(user_id, "documents.distribute")


def on_new_version(doc, old, new):
    """A revised document goes back out to the same readers, and anyone who had to acknowledge the old version has to acknowledge the new one."""
    if old is None:
        return
    prior = m.Acknowledgement.objects.filter(version=old).exclude(status="WITHDRAWN")
    users = {a.user_id for a in prior}
    for a in prior.filter(status="PENDING"):
        a.status = "WITHDRAWN"
        a.save(update_fields=["status", "updated_at"])
    due = None
    for dist in m.Distribution.objects.filter(version=old, requires_acknowledgement=True)[:1]:
        due = dist.due_date
    for u in users:
        m.Acknowledgement.objects.get_or_create(version=new, user_id=u, defaults={"document": doc, "due_date": due})
    for dist in m.Distribution.objects.filter(version=old):
        m.Distribution.objects.create(document=doc, version=new, target_type=dist.target_type, target_id=dist.target_id, requires_acknowledgement=dist.requires_acknowledgement, due_date=dist.due_date, distributed_by=dist.distributed_by)
        users |= expand(dist.target_type, dist.target_id)
    if users:
        notify(users, "documents.revised", f"Revised: {doc.reference} {doc.title}", f"Version {new.label} replaces {old.label}.", ref_type="documents.document", ref_id=str(doc.id))
    core.event(doc, "REDISTRIBUTED", None, version=new, note=f"{len(users)} user(s) told about the revision")


@transaction.atomic
def acknowledge(actor, doc_id):
    d = core.get_doc(actor, doc_id)
    v = d.current_version
    if d.status != "PUBLISHED" or v is None:
        raise DomainError("Only the current published version can be acknowledged.", code="not_published")
    a = m.Acknowledgement.objects.select_for_update().filter(version=v, user_id=actor).first()
    if a is None:
        raise DomainError("You have no acknowledgement to give for this document.", code="not_assigned", status_code=404)
    if a.status == "ACKNOWLEDGED":
        raise DomainError("Already acknowledged.", code="already_acknowledged")
    a.status, a.acknowledged_at = "ACKNOWLEDGED", timezone.now()
    a.save()
    core.event(d, "ACKNOWLEDGED", actor, version=v)
    return a


def my_pending(user_id):
    return m.Acknowledgement.objects.filter(user_id=user_id, status="PENDING", version__status="PUBLISHED").select_related("document", "version").order_by("due_date", "created_at")


def missing(doc_id=None):
    qs = m.Acknowledgement.objects.filter(status="PENDING", version__status="PUBLISHED").select_related("document", "version")
    return qs.filter(document_id=doc_id) if doc_id else qs


def remind(today):
    from platform_core.organizations import services as org
    every = int(org.get_setting("documents.ack_reminder_days", 7))
    n = 0
    for a in m.Acknowledgement.objects.select_for_update(of=("self",)).filter(status="PENDING", version__status="PUBLISHED").select_related("document", "version"):
        if a.last_reminder_on and (today - a.last_reminder_on).days < every:
            continue
        overdue = a.due_date and a.due_date < today
        notify([a.user_id], "documents.ack_overdue" if overdue else "documents.ack_reminder", f"{'Overdue: p' if overdue else 'P'}lease acknowledge {a.document.reference}", f"Version {a.version.label}", ref_type="documents.document", ref_id=str(a.document_id))
        a.last_reminder_on = today
        a.save(update_fields=["last_reminder_on", "updated_at"])
        n += 1
    return n
