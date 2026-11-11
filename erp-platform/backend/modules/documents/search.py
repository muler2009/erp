"""Finding documents, saved searches, favourites, related documents and histories."""
from datetime import date, timedelta

from django.db.models import Count, Q, TextField
from django.db.models.functions import Cast

from modules.documents import access, core
from modules.documents import models as m
from shared.api.errors import DomainError, ValidationFailed
from shared.workflows.models import WorkflowAction


def _d(v):
    if not v:
        return None
    try:
        return date.fromisoformat(v)
    except ValueError:
        raise ValidationFailed("Dates must be YYYY-MM-DD.", code="invalid_date")


def search(user_id, p):
    """`p` is a dict of query parameters. Only documents the user may see are ever returned."""
    qs = access.visible(user_id).select_related("category", "classification", "current_version")
    q = (p.get("q") or "").strip()
    if q:
        cond = Q(title__icontains=q) | Q(reference__icontains=q) | Q(description__icontains=q) | Q(tags__contains=[q.lower()]) | Q(meta_text__icontains=q)
        if str(p.get("full_text", "")).lower() in ("1", "true"):
            cond |= Q(current_version__text__content__icontains=q)
        qs = qs.annotate(meta_text=Cast("metadata", TextField())).filter(cond)
    for k, f in (("status", "status"), ("department", "department_id"), ("project", "project_id"), ("owner", "owner_id"), ("direction", "direction"), ("classification", "classification__code"), ("doc_type", "category__doc_type"), ("category", "category_id")):
        if p.get(k):
            qs = qs.filter(**{f: p[k]})
    if p.get("category_code"):
        qs = qs.filter(category__code=p["category_code"])
    if p.get("tag"):
        qs = qs.filter(tags__contains=[p["tag"].lower()])
    if p.get("folder"):
        qs = qs.filter(folder_id__in=access._descendants({p["folder"]}))
    if p.get("is_template") in ("1", "true", True):
        qs = qs.filter(is_template=True)
    if p.get("link_type") and p.get("link_ref"):
        qs = qs.filter(links__link_type=p["link_type"], links__ref_id=p["link_ref"])
    for k, f in (("effective_from", "effective_date__gte"), ("effective_to", "effective_date__lte"), ("created_from", "created_at__date__gte"), ("created_to", "created_at__date__lte")):
        if _d(p.get(k)):
            qs = qs.filter(**{f: _d(p[k])})
    if str(p.get("expired", "")).lower() in ("1", "true"):
        qs = qs.filter(expiry_date__lt=core.today()).exclude(status__in=("ARCHIVED", "OBSOLETE"))
    return qs.distinct()


def doc_dict(d, user_id=None):
    today = core.today()
    v = d.current_version
    out = {"id": str(d.id), "reference": d.reference, "title": d.title, "status": d.status, "category": d.category.code, "category_name": d.category.name, "doc_type": d.category.doc_type, "classification": d.classification.code,
           "owner": str(d.owner_id), "department": d.department_id and str(d.department_id), "project": d.project_id and str(d.project_id), "folder": d.folder_id and str(d.folder_id), "direction": d.direction, "tags": d.tags,
           "current_version": v and {"id": str(v.id), "label": v.label, "file_name": v.file_name, "published_at": v.published_at and str(v.published_at)}, "effective_date": d.effective_date and str(d.effective_date),
           "expiry_date": d.expiry_date and str(d.expiry_date), "next_review_date": d.next_review_date and str(d.next_review_date), "expired": bool(d.expiry_date and d.expiry_date < today and d.status not in ("ARCHIVED", "OBSOLETE")),
           "review_overdue": bool(d.next_review_date and d.next_review_date < today and d.status == "PUBLISHED"), "is_template": d.is_template, "legal_hold": d.legal_hold,
           "is_obsolete": d.status == "OBSOLETE"}
    pending = d.versions.exclude(pk=d.current_version_id).filter(status__in=("DRAFT", "UNDER_REVIEW", "CHANGES_REQUESTED", "APPROVED")).order_by("-number").first()
    out["pending_revision"] = pending and {"id": str(pending.id), "label": pending.label, "status": pending.status}
    if user_id:
        out["can"] = {a.lower(): access.can(user_id, d, a) for a in ("EDIT", "UPLOAD", "REVIEW", "PUBLISH", "ARCHIVE", "DELETE")}
    return out


def detail(user_id, doc):
    out = doc_dict(doc, user_id)
    hist = access.can_view_history(user_id, doc)
    versions = doc.versions.order_by("-number") if hist else doc.versions.filter(pk=doc.current_version_id)
    out.update(description=doc.description, origin=doc.origin, metadata=doc.metadata, created_by=str(doc.created_by), last_reviewed_on=doc.last_reviewed_on and str(doc.last_reviewed_on),
               retention_until=doc.retention_until and str(doc.retention_until), versions=[core.version_dict(v) for v in versions],
               links=[{"id": str(x.id), "type": x.link_type, "ref_id": x.ref_id, "label": x.label} for x in doc.links.all()],
               template=doc.template_id and {"id": str(doc.template_id), "version": doc.template_version.label if doc.template_version else None}, related=[{"id": str(r.id), "reference": r.reference, "title": r.title} for r in related(user_id, doc)])
    if hist:
        out["history"] = [{"action": e.action, "from": e.from_status, "to": e.to_status, "by": e.actor_id and str(e.actor_id), "note": e.note, "at": str(e.at), "version": e.version.label if e.version else None} for e in doc.events.select_related("version").order_by("at", "id")]
        out["approvals"] = approval_history(doc)
    return out


def approval_history(doc):
    ids = {str(v.id): v.label for v in doc.versions.all()}
    rows = WorkflowAction.objects.filter(instance__subject_type="documents.version", instance__subject_id__in=list(ids)).select_related("instance").order_by("created_at", "id")
    return [{"version": ids[a.instance.subject_id], "action": a.action, "round": a.round, "stage": a.stage_order, "by": a.actor_id and str(a.actor_id), "comment": a.comment, "at": str(a.created_at)} for a in rows]


def related(user_id, doc, limit=20):
    ids = set()
    for ln in doc.links.all():
        ids |= set(m.DocumentLink.objects.filter(link_type=ln.link_type, ref_id=ln.ref_id).exclude(document=doc).values_list("document_id", flat=True))
    if doc.template_id:
        ids.add(doc.template_id)
    ids |= set(doc.instances.values_list("id", flat=True))
    ext = getattr(doc, "external", None)
    if ext:
        if ext.resubmission_of_id:
            ids.add(ext.resubmission_of.document_id)
        ids |= set(ext.resubmissions.values_list("document_id", flat=True))
    return list(access.visible(user_id).filter(pk__in=ids).select_related("category", "classification")[:limit])


# ----------------------------------------------------------------------------- saved searches and favourites
def save_search(user_id, name, params):
    if not (name or "").strip() or not isinstance(params, dict):
        raise ValidationFailed("A name and a set of parameters are required.", code="invalid_fields")
    s, _ = m.SavedSearch.objects.update_or_create(user_id=user_id, name=name.strip()[:100], defaults={"params": params})
    return s


def delete_search(user_id, pk):
    n, _ = m.SavedSearch.objects.filter(pk=pk, user_id=user_id).delete()
    if not n:
        raise core.nf("Saved search")


def favourite(user_id, doc_id, on=True):
    d = core.get_doc(user_id, doc_id)
    if on:
        m.Favorite.objects.get_or_create(user_id=user_id, document=d)
    else:
        m.Favorite.objects.filter(user_id=user_id, document=d).delete()
    return on


def favourites(user_id):
    ids = m.Favorite.objects.filter(user_id=user_id).values_list("document_id", flat=True)
    return access.visible(user_id).filter(pk__in=list(ids)).select_related("category", "classification", "current_version")
