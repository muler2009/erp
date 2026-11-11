import json
from datetime import date, datetime

from django.http import FileResponse
from django.utils.dateparse import parse_datetime
from rest_framework.parsers import FormParser, JSONParser, MultiPartParser
from rest_framework.response import Response
from rest_framework.views import APIView

from modules.documents import access, approval, core, distribution, external, grants, review, search
from modules.documents import models as m
from modules.documents.reports import REPORTS
from platform_core.authorization.permissions import require
from shared.api.errors import DomainError, ValidationFailed
from shared.api.pagination import paginate


def perm(code):
    return [require(code)()]


def _d(v):
    if not v:
        return None
    if isinstance(v, date):
        return v
    try:
        return date.fromisoformat(v)
    except ValueError:
        raise ValidationFailed("Dates must be YYYY-MM-DD.", code="invalid_date")


def _body(request):
    """JSON bodies as they are; multipart forms with JSON-encoded list and object fields decoded."""
    data = request.data
    if hasattr(data, "dict"):
        data = data.dict()
        for k in ("tags", "metadata", "links", "targets", "items", "actions", "required_metadata"):
            if isinstance(data.get(k), str):
                try:
                    data[k] = json.loads(data[k])
                except ValueError:
                    raise ValidationFailed(f"{k} must be valid JSON.", code="invalid_fields")
    return data


def _file(request):
    f = request.FILES.get("file")
    if f is None:
        return None
    if f.size > core.files.settings.FILE_MAX_BYTES:
        raise ValidationFailed("The file is too large.", code="file_too_large")
    return (f.name, f.read())


class _V(APIView):
    parser_classes = [JSONParser, MultiPartParser, FormParser]
    read, write = "documents.view", "documents.view"


def _policy(self):
    return perm(self.read if self.request.method in ("GET", "HEAD", "OPTIONS") else self.write)


class _Base(_V):
    def __init_subclass__(cls, **kw):
        super().__init_subclass__(**kw)
        cls.get_permissions = _policy


def _cat(c):
    return {"id": str(c.id), "code": c.code, "name": c.name, "parent": c.parent_id and str(c.parent_id), "doc_type": c.doc_type, "number_prefix": c.number_prefix, "number_padding": c.number_padding, "is_controlled": c.is_controlled,
            "requires_expiry": c.requires_expiry, "review_interval_days": c.review_interval_days, "retention_years": c.retention_years, "default_classification": c.default_classification and c.default_classification.code,
            "required_metadata": c.required_metadata, "is_active": c.is_active}


def _folder(f):
    return {"id": str(f.id), "name": f.name, "parent": f.parent_id and str(f.parent_id), "department": f.department_id and str(f.department_id), "project": f.project_id and str(f.project_id), "is_active": f.is_active}


def _grant(g):
    return {"id": str(g.id), "document": g.document_id and str(g.document_id), "folder": g.folder_id and str(g.folder_id), "subject_type": g.subject_type, "subject_id": g.subject_id, "actions": g.actions,
            "expires_at": g.expires_at and str(g.expires_at), "revoked_at": g.revoked_at and str(g.revoked_at)}


def _ext(r):
    return {"id": str(r.id), "document": str(r.document_id), "reference": r.document.reference, "direction": r.direction, "party_type": r.party_type, "party_name": r.party_name, "sender": r.sender, "recipient": r.recipient,
            "party_reference": r.party_reference, "received_on": r.received_on and str(r.received_on), "sent_on": r.sent_on and str(r.sent_on), "response_due_on": r.response_due_on and str(r.response_due_on),
            "responded_on": r.responded_on and str(r.responded_on), "submission_status": r.submission_status, "contract_ref": r.contract_ref, "resubmission_of": r.resubmission_of_id and str(r.resubmission_of_id)}


def _comment(c):
    return {"id": str(c.id), "document": str(c.document_id), "version": c.version_id and str(c.version_id), "author": str(c.author_id), "comment": c.comment, "response": c.response, "status": c.status, "at": str(c.created_at)}


def _tr(t):
    return {"id": str(t.id), "number": t.number, "project": t.project_id and str(t.project_id), "direction": t.direction, "party": t.party_name, "purpose": t.purpose, "sent_on": str(t.sent_on),
            "items": [{"document": str(i.document_id), "reference": i.document.reference, "version": i.version.label} for i in t.items.select_related("document", "version")]}


def _rfi(r):
    return {"id": str(r.id), "number": r.number, "project": str(r.project_id), "subject": r.subject, "question": r.question, "raised_by": str(r.raised_by), "assigned_to": str(r.assigned_to), "due_date": r.due_date and str(r.due_date),
            "status": r.status, "response": r.response}


def _disp(r):
    return {"id": str(r.id), "document": str(r.document_id), "reference": r.document.reference, "status": r.status, "reason": r.reason, "requested_by": str(r.requested_by), "decided_by": r.decided_by and str(r.decided_by), "decision_note": r.decision_note}


class Categories(_Base):
    write = "documents.admin"

    def get(self, request):
        core.ensure_defaults()
        return paginate(request, m.Category.objects.select_related("default_classification"), _cat, ordering="code")

    def post(self, request):
        b = _body(request)
        return Response(_cat(core.create_category(request.user.id, code=b.get("code"), name=b.get("name"), number_prefix=b.get("number_prefix"), doc_type=b.get("doc_type", "OTHER"), parent_id=b.get("parent"),
                                                  number_padding=b.get("number_padding", 4), is_controlled=b.get("is_controlled", True), requires_expiry=b.get("requires_expiry", False), review_interval_days=b.get("review_interval_days"),
                                                  retention_years=b.get("retention_years"), default_classification=b.get("default_classification"), required_metadata=b.get("required_metadata"))), status=201)


class CategoryDetail(_Base):
    write = "documents.admin"

    def patch(self, request, pk):
        return Response(_cat(core.update_category(request.user.id, pk, **_body(request))))


class Classifications(_Base):
    def get(self, request):
        core.ensure_defaults()
        return Response([{"code": c.code, "name": c.name, "rank": c.rank} for c in m.Classification.objects.filter(is_active=True).order_by("rank")])


class Folders(_Base):
    write = "documents.admin"

    def get(self, request):
        return paginate(request, m.Folder.objects.all(), _folder, ordering="name")

    def post(self, request):
        b = _body(request)
        return Response(_folder(core.create_folder(request.user.id, name=b.get("name"), parent_id=b.get("parent"), department_id=b.get("department"), project_id=b.get("project"))), status=201)


class Documents(_Base):
    write = "documents.create"

    def get(self, request):
        return paginate(request, search.search(request.user.id, request.query_params.dict()), lambda d: search.doc_dict(d, request.user.id), ordering="-created_at")

    def post(self, request):
        b = _body(request)
        d = core.register_document(request.user.id, title=b.get("title"), category_id=b.get("category"), owner_id=b.get("owner"), folder_id=b.get("folder"), classification=b.get("classification"), department_id=b.get("department"),
                                    project_id=b.get("project"), description=b.get("description", ""), origin=b.get("origin", ""), tags=b.get("tags"), metadata=b.get("metadata"), effective_date=_d(b.get("effective_date")),
                                    expiry_date=_d(b.get("expiry_date")), reference=b.get("reference"), links=b.get("links"), file=_file(request), is_template=str(b.get("is_template", "")).lower() in ("1", "true"),
                                    change_reason=b.get("change_reason") or "Initial issue")
        return Response(search.detail(request.user.id, d), status=201)


class DocumentDetail(_Base):
    write = "documents.view"

    def get(self, request, pk):
        d = core.get_doc(request.user.id, pk)
        m.AccessLog.objects.create(document=d, version=d.current_version, user_id=request.user.id, action="VIEW")
        return Response(search.detail(request.user.id, d))

    def patch(self, request, pk):
        b = _body(request)
        f = {k: b[k] for k in ("title", "description", "origin", "tags", "metadata", "classification") if k in b}
        for k, src in (("department_id", "department"), ("project_id", "project"), ("owner_id", "owner"), ("folder_id", "folder")):
            if src in b:
                f[k] = b[src]
        for k in ("effective_date", "expiry_date"):
            if k in b:
                f[k] = _d(b[k])
        return Response(search.detail(request.user.id, core.update_document(request.user.id, pk, **f)))

    def delete(self, request, pk):
        core.delete_document(request.user.id, pk)
        return Response(status=204)


class DocumentVersions(_Base):
    def post(self, request, pk):
        f = _file(request)
        if f is None:
            raise ValidationFailed("A 'file' part is required.", code="file_required")
        return Response(core.version_dict(core.upload_version(request.user.id, pk, *f, change_reason=_body(request).get("change_reason", ""))), status=201)


class DocumentRevisions(_Base):
    def post(self, request, pk):
        b = _body(request)
        return Response(core.version_dict(core.create_revision(request.user.id, pk, change_reason=b.get("change_reason", ""), change_type=b.get("change_type", "MAJOR"), file=_file(request))), status=201)


class VersionDownload(_Base):
    def get(self, request, pk):
        f, handle = core.open_version(request.user.id, pk, request=request)
        r = FileResponse(handle, content_type=f.content_type, as_attachment=True, filename=f.original_name)
        r["X-Content-Type-Options"] = "nosniff"
        r["Content-Security-Policy"] = "default-src 'none'; sandbox"
        r["Cache-Control"] = "private, no-store"
        return r


class VersionSubmit(_Base):
    def post(self, request, pk):
        return Response(core.version_dict(approval.submit_for_approval(request.user.id, pk, comment=_body(request).get("comment", ""))))


class VersionResubmit(_Base):
    def post(self, request, pk):
        return Response(core.version_dict(approval.resubmit(request.user.id, pk, comment=_body(request).get("comment", ""))))


class VersionWithdraw(_Base):
    def post(self, request, pk):
        return Response(core.version_dict(approval.withdraw(request.user.id, pk, comment=_body(request).get("comment", ""))))


class VersionPublish(_Base):
    def post(self, request, pk):
        return Response(core.version_dict(approval.publish_version(request.user.id, pk)))


class DocObsolete(_Base):
    def post(self, request, pk):
        b = _body(request)
        d = approval.mark_obsolete(request.user.id, pk, reason=b.get("reason", ""), replaced_by_id=b.get("replaced_by"))
        return Response({"id": str(d.id), "reference": d.reference, "status": d.status})


class DocArchive(_Base):
    def post(self, request, pk):
        d = approval.archive_document(request.user.id, pk, reason=_body(request).get("reason", ""))
        return Response({"id": str(d.id), "status": d.status, "retention_until": d.retention_until and str(d.retention_until)})


class DocRetention(_Base):
    def post(self, request, pk):
        b = _body(request)
        d = approval.set_retention(request.user.id, pk, retention_until=_d(b.get("retention_until")), legal_hold=b.get("legal_hold"))
        return Response({"id": str(d.id), "retention_until": d.retention_until and str(d.retention_until), "legal_hold": d.legal_hold})


class DisposalRequests(_Base):
    write = "documents.archive"
    read = "documents.disposal.approve"

    def get(self, request):
        return paginate(request, m.DisposalRequest.objects.select_related("document"), _disp)

    def post(self, request):
        b = _body(request)
        return Response(_disp(approval.request_disposal(request.user.id, b.get("document"), reason=b.get("reason", ""))), status=201)


class DisposalDecide(_Base):
    write = "documents.disposal.approve"

    def post(self, request, pk):
        b = _body(request)
        return Response(_disp(approval.decide_disposal(request.user.id, pk, approve=bool(b.get("approve")), note=b.get("note", ""))))


class DisposalExecute(_Base):
    write = "documents.disposal.approve"

    def post(self, request, pk):
        return Response(_disp(approval.execute_disposal(request.user.id, pk)))


class DocLinks(_Base):
    def post(self, request, pk):
        b = _body(request)
        ln = core.add_link(request.user.id, pk, b.get("type"), b.get("ref_id"), b.get("label", ""))
        return Response({"id": str(ln.id), "type": ln.link_type, "ref_id": ln.ref_id}, status=201)


class LinkDetail(_Base):
    def delete(self, request, pk):
        core.remove_link(request.user.id, pk)
        return Response(status=204)


class TemplateUse(_Base):
    write = "documents.create"

    def post(self, request, pk):
        b = _body(request)
        d = core.create_from_template(request.user.id, pk, title=b.get("title"), category_id=b.get("category"), owner_id=b.get("owner"), folder_id=b.get("folder"), department_id=b.get("department"), project_id=b.get("project"),
                                      links=b.get("links"), metadata=b.get("metadata"))
        return Response(search.detail(request.user.id, d), status=201)


class DocDistribute(_Base):
    def post(self, request, pk):
        b = _body(request)
        return Response({"users": distribution.distribute(request.user.id, pk, b.get("targets"), requires_acknowledgement=bool(b.get("requires_acknowledgement")), due_date=_d(b.get("due_date")))}, status=201)


class DocAcknowledge(_Base):
    def post(self, request, pk):
        a = distribution.acknowledge(request.user.id, pk)
        return Response({"document": str(a.document_id), "version": str(a.version_id), "acknowledged_at": str(a.acknowledged_at)})


class MyAcknowledgements(_Base):
    def get(self, request):
        return Response([{"document": str(a.document_id), "reference": a.document.reference, "title": a.document.title, "version": a.version.label, "due_date": a.due_date and str(a.due_date)} for a in distribution.my_pending(request.user.id)])


class DocReview(_Base):
    def post(self, request, pk):
        b = _body(request)
        r = review.record_review(request.user.id, pk, outcome=b.get("outcome"), comment=b.get("comment", ""))
        return Response({"outcome": r.outcome, "reviewed_on": str(r.reviewed_on)})


class DocComments(_Base):
    def get(self, request, pk):
        d = core.get_doc(request.user.id, pk)
        return Response([_comment(c) for c in d.comments.order_by("created_at")])

    def post(self, request, pk):
        b = _body(request)
        return Response(_comment(external.add_comment(request.user.id, pk, b.get("comment"), version_id=b.get("version"))), status=201)


class CommentRespond(_Base):
    def post(self, request, pk):
        b = _body(request)
        return Response(_comment(external.respond_comment(request.user.id, pk, b.get("response"), resolve=bool(b.get("resolve")))))


class CommentResolve(_Base):
    def post(self, request, pk):
        return Response(_comment(external.resolve_comment(request.user.id, pk)))


class DocGrants(_Base):
    write = "documents.admin"
    read = "documents.admin"

    def get(self, request, pk):
        return Response([_grant(g) for g in m.AccessGrant.objects.filter(document_id=pk, revoked_at__isnull=True)])

    def post(self, request, pk):
        b = _body(request)
        return Response(_grant(grants.grant(request.user.id, subject_type=b.get("subject_type"), subject_id=b.get("subject_id"), actions=b.get("actions"), document_id=pk, expires_at=parse_datetime(b["expires_at"]) if b.get("expires_at") else None)), status=201)


class FolderGrants(_Base):
    write = "documents.admin"
    read = "documents.admin"

    def post(self, request, pk):
        b = _body(request)
        return Response(_grant(grants.grant(request.user.id, subject_type=b.get("subject_type"), subject_id=b.get("subject_id"), actions=b.get("actions"), folder_id=pk, expires_at=parse_datetime(b["expires_at"]) if b.get("expires_at") else None)), status=201)


class GrantDetail(_Base):
    write = "documents.admin"

    def delete(self, request, pk):
        grants.revoke(request.user.id, pk)
        return Response(status=204)


class Externals(_Base):
    write = "documents.external.manage"

    def get(self, request):
        ids = access.visible(request.user.id).filter(direction__in=("INCOMING", "OUTGOING")).values_list("pk", flat=True)
        qs = m.ExternalRecord.objects.filter(document_id__in=list(ids)).select_related("document")
        if request.query_params.get("status"):
            qs = qs.filter(submission_status=request.query_params["status"])
        return paginate(request, qs, _ext)

    def post(self, request):
        b = _body(request)
        extra = {k: b[k] for k in ("description", "tags", "metadata", "classification", "links") if k in b}
        for k, src in (("department_id", "department"), ("folder_id", "folder")):
            if src in b:
                extra[k] = b[src]
        if b.get("expiry_date"):
            extra["expiry_date"] = _d(b["expiry_date"])
        rec = external.register_external(request.user.id, direction=b.get("direction"), party_type=b.get("party_type"), party_name=b.get("party_name"), title=b.get("title"), category_id=b.get("category"), file=_file(request),
                                         party_id=b.get("party_id", ""), sender=b.get("sender", ""), recipient=b.get("recipient", ""), party_reference=b.get("party_reference", ""), received_on=_d(b.get("received_on")),
                                         sent_on=_d(b.get("sent_on")), response_due_on=_d(b.get("response_due_on")), contract_ref=b.get("contract_ref", ""), project_id=b.get("project"), resubmission_of=b.get("resubmission_of"), **extra)
        return Response(_ext(rec), status=201)


class ExternalStatus(_Base):
    write = "documents.external.manage"

    def post(self, request, pk):
        b = _body(request)
        return Response(_ext(external.update_submission(request.user.id, pk, b.get("status"), note=b.get("note", ""))))


class ExternalResponded(_Base):
    write = "documents.external.manage"

    def post(self, request, pk):
        return Response(_ext(external.mark_responded(request.user.id, pk, responded_on=_d(_body(request).get("responded_on")))))


class Transmittals(_Base):
    write = "documents.external.manage"

    def get(self, request):
        qs = m.Transmittal.objects.all()
        if request.query_params.get("project"):
            qs = qs.filter(project_id=request.query_params["project"])
        return paginate(request, qs, _tr)

    def post(self, request):
        b = _body(request)
        return Response(_tr(external.create_transmittal(request.user.id, direction=b.get("direction"), party_name=b.get("party_name"), items=b.get("items"), project_id=b.get("project"), purpose=b.get("purpose", "FOR_INFORMATION"),
                                                        response_due_on=_d(b.get("response_due_on")), notes=b.get("notes", ""))), status=201)


class Rfis(_Base):
    write = "documents.external.manage"

    def get(self, request):
        qs = m.Rfi.objects.all()
        for k in ("project", "status"):
            if request.query_params.get(k):
                qs = qs.filter(**{k + ("_id" if k == "project" else ""): request.query_params[k]})
        return paginate(request, qs, _rfi)

    def post(self, request):
        b = _body(request)
        return Response(_rfi(external.create_rfi(request.user.id, project_id=b.get("project"), subject=b.get("subject"), question=b.get("question"), assigned_to=b.get("assigned_to"), due_date=_d(b.get("due_date")), document_id=b.get("document"))), status=201)


class RfiAnswer(_Base):
    def post(self, request, pk):
        return Response(_rfi(external.answer_rfi(request.user.id, pk, _body(request).get("response"))))


class RfiClose(_Base):
    def post(self, request, pk):
        return Response(_rfi(external.close_rfi(request.user.id, pk)))


class Favourites(_Base):
    def get(self, request):
        return paginate(request, search.favourites(request.user.id), lambda d: search.doc_dict(d, request.user.id), ordering="-created_at")


class DocFavourite(_Base):
    def post(self, request, pk):
        search.favourite(request.user.id, pk, True)
        return Response(status=204)

    def delete(self, request, pk):
        search.favourite(request.user.id, pk, False)
        return Response(status=204)


class SavedSearches(_Base):
    def get(self, request):
        return Response([{"id": str(s.id), "name": s.name, "params": s.params} for s in m.SavedSearch.objects.filter(user_id=request.user.id).order_by("name")])

    def post(self, request):
        b = _body(request)
        s = search.save_search(request.user.id, b.get("name"), b.get("params"))
        return Response({"id": str(s.id), "name": s.name, "params": s.params}, status=201)


class SavedSearchDetail(_Base):
    def delete(self, request, pk):
        search.delete_search(request.user.id, pk)
        return Response(status=204)


class ReportView(_Base):
    def get(self, request, name):
        fn = REPORTS.get(name)
        if fn is None:
            raise DomainError("Unknown report.", code="not_found", status_code=404)
        if name == "access" and not access.authz.has_permission(request.user.id, "documents.admin"):
            raise DomainError("You are not allowed to see access reports.", code="forbidden", status_code=403)
        return Response(fn(request.user.id, request.query_params.dict()))
