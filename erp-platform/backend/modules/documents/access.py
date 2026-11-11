"""Who may do what to which document. Role permissions give the broad capability; classification narrows it; grants widen it for one
document or folder (to a user, a department, a role or a project team) and may expire. Approval rights come from the workflow engine."""
from django.db.models import Q
from django.utils import timezone

from modules.documents import models as m
from platform_core.authorization import services as authz
from platform_core.authorization.models import RoleAssignment
from platform_core.organizations.models import TenantUserProfile
from shared.workflows.models import ApprovalTask

ACTIONS = ("VIEW", "DOWNLOAD", "UPLOAD", "EDIT", "REVIEW", "PUBLISH", "ARCHIVE", "DELETE")
ROLE_PERM = {"VIEW": "documents.view", "DOWNLOAD": "documents.view", "UPLOAD": "documents.create", "EDIT": "documents.edit", "REVIEW": "documents.review",
             "PUBLISH": "documents.publish", "ARCHIVE": "documents.archive", "DELETE": "documents.delete"}
OPEN_STATUSES = ("PUBLISHED", "OBSOLETE")


def _subjects(user_id):
    """The (type, id) pairs that can receive a grant for this user."""
    out = {("USER", str(user_id))}
    dept = TenantUserProfile.objects.filter(user_id=user_id).values_list("department_id", flat=True).first()
    if dept:
        out.add(("DEPARTMENT", str(dept)))
    now = timezone.now()
    for name in RoleAssignment.objects.filter(user_id=user_id).filter(Q(valid_to__isnull=True) | Q(valid_to__gt=now)).values_list("role__name", flat=True):
        out.add(("ROLE", name))
    try:
        from modules.projects.models import ProjectMember
        for pid in ProjectMember.objects.filter(user_id=user_id, is_active=True).values_list("project_id", flat=True):
            out.add(("PROJECT", str(pid)))
    except Exception:  # pragma: no cover - projects module not installed
        pass
    return out


def _active_grants(user_id):
    subs = _subjects(user_id)
    q = Q()
    for t, i in subs:
        q |= Q(subject_type=t, subject_id=i)
    now = timezone.now()
    return m.AccessGrant.objects.filter(q, revoked_at__isnull=True).filter(Q(expires_at__isnull=True) | Q(expires_at__gt=now))


def _folder_chain(folder_id):
    out, seen = [], set()
    while folder_id and folder_id not in seen:
        seen.add(folder_id)
        out.append(folder_id)
        folder_id = m.Folder.objects.filter(pk=folder_id).values_list("parent_id", flat=True).first()
    return out


def grant_actions(user_id, doc):
    chain = _folder_chain(doc.folder_id)
    acts = set()
    for g in _active_grants(user_id).filter(Q(document=doc) | Q(folder_id__in=chain)):
        acts.update(g.actions)
    return acts


def _approver(user_id, doc):
    return ApprovalTask.objects.filter(assignee_id=user_id, instance__subject_type="documents.version", instance__status__in=("PENDING", "CHANGES_REQUESTED"),
                                       instance__subject_id__in=[str(v) for v in doc.versions.values_list("id", flat=True)]).exists()


def can(user_id, doc, action):
    if doc.deleted_at or doc.disposed_at:
        return False
    if action not in ACTIONS:
        return False
    if doc.status == "ARCHIVED" and action not in ("VIEW", "DOWNLOAD", "ARCHIVE"):
        return False  # archived records are read-only; ARCHIVE here means retention and disposal handling
    granted = grant_actions(user_id, doc)
    if action in granted:
        return True
    if action in ("VIEW", "DOWNLOAD") and _approver(user_id, doc):
        return True
    rank = doc.classification.rank
    if doc.owner_id == user_id and action in ("VIEW", "DOWNLOAD", "UPLOAD", "EDIT", "REVIEW"):
        return doc.status != "ARCHIVED" or authz.has_permission(user_id, "documents.archive")
    if rank >= 4 or not authz.has_permission(user_id, ROLE_PERM[action]):
        return False
    if rank == 3 and not authz.has_permission(user_id, "documents.confidential.view"):
        return False
    if doc.status == "ARCHIVED":
        return authz.has_permission(user_id, "documents.archive")
    if action in ("VIEW", "DOWNLOAD") and doc.status not in OPEN_STATUSES:  # work in progress is for the people working on it
        return authz.has_permission(user_id, "documents.create") or authz.has_permission(user_id, "documents.review")
    return True


def can_view_history(user_id, doc):
    return authz.has_permission(user_id, "documents.history.view") or can(user_id, doc, "EDIT") or can(user_id, doc, "REVIEW") or doc.owner_id == user_id


def can_read_version(user_id, version, action="DOWNLOAD"):
    doc = version.document
    if not can(user_id, doc, action):
        return False
    if version.status == "PUBLISHED":
        return True
    if version.status in ("SUPERSEDED", "OBSOLETE", "APPROVED", "DRAFT", "UNDER_REVIEW"):
        return can_view_history(user_id, doc) or _approver(user_id, doc)
    return False


def can_read_version_file(user_id, version_id):
    v = m.DocumentVersion.objects.select_related("document__classification").filter(pk=version_id).first()
    return bool(v and can_read_version(user_id, v, "DOWNLOAD"))


def _descendants(folder_ids):
    children = {}
    for f in m.Folder.objects.values("id", "parent_id"):
        children.setdefault(f["parent_id"], []).append(f["id"])
    out, stack = set(folder_ids), list(folder_ids)
    while stack:
        for c in children.get(stack.pop(), []):
            if c not in out:
                out.add(c)
                stack.append(c)
    return out


def visible(user_id):
    """Documents this user may see in lists. Mirrors `can(..., "VIEW")` as a database filter."""
    doc_ids, folder_ids = set(), set()
    for g in _active_grants(user_id):
        if "VIEW" in g.actions:
            (doc_ids.add(g.document_id) if g.document_id else folder_ids.add(g.folder_id))
    q = Q(id__in=doc_ids) | Q(folder_id__in=_descendants(folder_ids))
    has_archive = authz.has_permission(user_id, "documents.archive")
    q |= Q(owner_id=user_id) & (Q() if has_archive else ~Q(status="ARCHIVED"))
    if authz.has_permission(user_id, "documents.view"):
        cap = 3 if authz.has_permission(user_id, "documents.confidential.view") else 2
        statuses = list(OPEN_STATUSES)
        if authz.has_permission(user_id, "documents.create") or authz.has_permission(user_id, "documents.review"):
            statuses += ["DRAFT", "UNDER_REVIEW", "CHANGES_REQUESTED", "APPROVED"]
        if has_archive:
            statuses.append("ARCHIVED")
        q |= Q(classification__rank__lte=cap, status__in=statuses)
    pending = ApprovalTask.objects.filter(assignee_id=user_id, instance__subject_type="documents.version", instance__status__in=("PENDING", "CHANGES_REQUESTED")).values_list("instance__subject_id", flat=True)
    q |= Q(id__in=list(m.DocumentVersion.objects.filter(pk__in=list(pending)).values_list("document_id", flat=True)))
    return m.Document.objects.filter(deleted_at__isnull=True, disposed_at__isnull=True).filter(q)
