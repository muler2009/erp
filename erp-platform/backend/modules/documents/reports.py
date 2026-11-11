"""Document reports. Every report is limited to documents the requesting user may see."""
from collections import Counter, defaultdict
from datetime import timedelta

from django.db.models import Count, Q

from modules.documents import access, core, distribution
from modules.documents import models as m
from modules.documents.search import _d, doc_dict
from shared.workflows.models import ApprovalTask


def _vis(user, **f):
    return access.visible(user).filter(**f).select_related("category", "classification", "current_version")


def register(user, p):
    qs = _vis(user)
    for k, f in (("category", "category__code"), ("status", "status"), ("department", "department_id"), ("project", "project_id")):
        if p.get(k):
            qs = qs.filter(**{f: p[k]})
    return [doc_dict(d) for d in qs.order_by("reference")[:2000]]


def by_category_department(user, p):
    c = Counter()
    for d in _vis(user):
        c[(d.category.code, str(d.department_id) if d.department_id else "(none)", d.status)] += 1
    return [{"category": k[0], "department": k[1], "status": k[2], "count": n} for k, n in sorted(c.items())]


def pending_approvals(user, p):
    docs = {str(d.id): d for d in _vis(user, status__in=("UNDER_REVIEW", "CHANGES_REQUESTED", "PUBLISHED", "APPROVED"))}
    out = []
    for v in m.DocumentVersion.objects.filter(status__in=("UNDER_REVIEW", "CHANGES_REQUESTED")).select_related("document"):
        d = docs.get(str(v.document_id))
        if d is None:
            continue
        tasks = ApprovalTask.objects.filter(instance_id=v.workflow_instance_id, status="PENDING")
        out.append({"reference": d.reference, "title": d.title, "version": v.label, "status": v.status, "submitted_at": v.submitted_at and str(v.submitted_at), "waiting_for": sorted({str(t.assignee_id) for t in tasks}),
                    "overdue_tasks": sum(1 for t in tasks if t.due_at and t.due_at < core.timezone.now())})
    return out


def revision_history(user, p):
    ids = list(_vis(user, **({"pk": p["document"]} if p.get("document") else {})).values_list("pk", flat=True))
    return [{"reference": v.document.reference, "version": v.label, "status": v.status, "reason": v.change_reason, "created_by": str(v.created_by), "created_at": str(v.created_at), "published_at": v.published_at and str(v.published_at), "superseded_at": v.superseded_at and str(v.superseded_at)}
            for v in m.DocumentVersion.objects.filter(document_id__in=ids).select_related("document").order_by("document__reference", "number")]


def overdue_reviews(user, p):
    t = core.today()
    return [{**doc_dict(d), "days_overdue": (t - d.next_review_date).days} for d in _vis(user, status="PUBLISHED", next_review_date__lt=t).order_by("next_review_date")]


def expiring(user, p):
    t = core.today()
    within = int(p.get("within_days", 60))
    qs = _vis(user, expiry_date__isnull=False).exclude(status__in=("ARCHIVED", "OBSOLETE")).filter(expiry_date__lte=t + timedelta(days=within)).order_by("expiry_date")
    return [{**doc_dict(d), "days_to_expiry": (d.expiry_date - t).days} for d in qs]


def obsolete(user, p):
    return [doc_dict(d) for d in _vis(user, status="OBSOLETE").order_by("reference")]


def archived(user, p):
    return [{**doc_dict(d), "archived_at": d.archived_at and str(d.archived_at), "retention_until": d.retention_until and str(d.retention_until)} for d in _vis(user, status="ARCHIVED").order_by("-archived_at")]


def acknowledgements(user, p):
    ids = set(_vis(user).values_list("pk", flat=True))
    rows = defaultdict(lambda: Counter())
    for a in m.Acknowledgement.objects.filter(document_id__in=ids, version__status="PUBLISHED").select_related("document", "version"):
        rows[(a.document.reference, a.version.label)][a.status] += 1
    out = [{"reference": k[0], "version": k[1], "acknowledged": v["ACKNOWLEDGED"], "pending": v["PENDING"]} for k, v in sorted(rows.items())]
    if p.get("pending_by_user"):
        pend = Counter(str(a.user_id) for a in distribution.missing() if a.document_id in ids)
        return [{"user": u, "pending": n} for u, n in sorted(pend.items())]
    return out


def access_report(user, p):
    qs = m.AccessLog.objects.select_related("document")
    if p.get("document"):
        qs = qs.filter(document_id=p["document"])
    if p.get("user"):
        qs = qs.filter(user_id=p["user"])
    if _d(p.get("from")):
        qs = qs.filter(at__date__gte=_d(p["from"]))
    if _d(p.get("to")):
        qs = qs.filter(at__date__lte=_d(p["to"]))
    return [{"reference": a.document.reference, "user": str(a.user_id), "action": a.action, "at": str(a.at)} for a in qs.order_by("-at")[:1000]]


def external_submissions(user, p):
    ids = set(_vis(user, direction__in=("INCOMING", "OUTGOING")).values_list("pk", flat=True))
    t = core.today()
    qs = m.ExternalRecord.objects.filter(document_id__in=ids).select_related("document")
    if p.get("status"):
        qs = qs.filter(submission_status=p["status"])
    if p.get("party"):
        qs = qs.filter(party_name__icontains=p["party"])
    return [{"reference": r.document.reference, "title": r.document.title, "direction": r.direction, "party": r.party_name, "party_type": r.party_type, "status": r.submission_status, "received_on": r.received_on and str(r.received_on),
             "sent_on": r.sent_on and str(r.sent_on), "response_due_on": r.response_due_on and str(r.response_due_on), "responded_on": r.responded_on and str(r.responded_on),
             "response_overdue": bool(r.response_due_on and r.response_due_on < t and not r.responded_on)} for r in qs.order_by("-created_at")[:1000]]


def project_register(user, p):
    if not p.get("project"):
        return []
    out = []
    for d in _vis(user, project_id=p["project"]).order_by("reference"):
        row = doc_dict(d)
        row["superseded_versions"] = [v.label for v in d.versions.filter(status="SUPERSEDED").order_by("number")]
        row["latest_approved"] = d.current_version.label if d.current_version else None
        out.append(row)
    return out


def transmittals(user, p):
    qs = m.Transmittal.objects.prefetch_related("items__document", "items__version")
    if p.get("project"):
        qs = qs.filter(project_id=p["project"])
    ids = set(_vis(user).values_list("pk", flat=True))
    return [{"number": t.number, "direction": t.direction, "party": t.party_name, "purpose": t.purpose, "sent_on": str(t.sent_on), "response_due_on": t.response_due_on and str(t.response_due_on),
             "items": [{"reference": i.document.reference, "version": i.version.label} for i in t.items.all() if i.document_id in ids]} for t in qs.order_by("-sent_on", "-created_at")[:500]]


def forms_submitted(user, p):
    c = Counter()
    for d in _vis(user, template__isnull=False):
        c[(d.template.reference, d.template_version.label if d.template_version else "")] += 1
    return [{"template": k[0], "version": k[1], "submitted": n} for k, n in sorted(c.items())]


REPORTS = {"register": register, "by-category": by_category_department, "pending-approvals": pending_approvals, "revision-history": revision_history, "overdue-reviews": overdue_reviews, "expiring": expiring,
           "obsolete": obsolete, "archived": archived, "acknowledgements": acknowledgements, "access": access_report, "external": external_submissions, "project-register": project_register,
           "transmittals": transmittals, "forms": forms_submitted}
