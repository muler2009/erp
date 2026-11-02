import base64

from rest_framework.response import Response
from rest_framework.views import APIView

from modules.crm import models as m
from modules.crm import service_desk as sd
from modules.crm.views import _date, _s, perm
from shared.api.errors import ValidationFailed
from shared.api.pagination import paginate


def _case(c):
    st = sd.sla_state(c)
    return {"id": str(c.id), "number": c.number, "subject": c.subject, "description": c.description, "kind": c.kind, "category": c.category, "priority": c.priority, "severity": c.severity, "status": c.status, "account": str(c.account_id), "contact": _s(c.contact_id), "order": _s(c.order_id), "delivery": _s(c.delivery_id), "invoice": _s(c.invoice_id), "product": _s(c.product_id), "owner_id": _s(c.owner_id), "team": c.team, "first_response_due": c.first_response_due, "due_at": c.due_at, "first_responded_at": c.first_responded_at, "resolved_at": c.resolved_at, "resolution": c.resolution, "escalation_level": c.escalation_level, "satisfaction": c.satisfaction, "feedback": c.feedback, "sla": st}


def _comment(x):
    return {"id": str(x.id), "author": str(x.author_id), "text": x.text, "internal": x.is_internal, "at": x.created_at.isoformat()}


class Cases(APIView):
    def get_permissions(self):
        return perm("crm.manage" if self.request.method == "POST" else "crm.view")

    def get(self, request):
        q = request.query_params
        qs = sd.visible(request.user.id).order_by("-created_at")
        for f in ("status", "priority", "kind", "account"):
            if q.get(f):
                qs = qs.filter(**{f: q[f]})
        if q.get("overdue") == "1":
            from django.utils import timezone

            qs = qs.filter(status__in=sd.OPEN_STATES, due_at__lt=timezone.now())
        return paginate(request, qs, _case)

    def post(self, request):
        b = request.data
        c = sd.open_case(request.user.id, account_id=b.get("account"), subject=b.get("subject", ""), description=b.get("description", ""), kind=b.get("kind", "COMPLAINT"), category=b.get("category", ""), priority=b.get("priority", "MEDIUM"), severity=b.get("severity", "MINOR"), contact_id=b.get("contact"), order_id=b.get("order"), delivery_id=b.get("delivery"), invoice_id=b.get("invoice"), product_id=b.get("product"))
        return Response(_case(c), status=201)


class CaseDetail(APIView):
    def get_permissions(self):
        return perm("crm.view")

    def get(self, request, pk):
        return Response(_case(sd.get_case(request.user.id, pk)))


class CaseComments(APIView):
    def get_permissions(self):
        return perm("crm.manage" if self.request.method == "POST" else "crm.view")

    def get(self, request, pk):
        return Response([_comment(x) for x in sd.comments_for(request.user.id, pk, customer_view=request.query_params.get("customer") == "1")])

    def post(self, request, pk):
        return Response(_comment(sd.add_comment(request.user.id, pk, request.data.get("text", ""), bool(request.data.get("internal", False)))), status=201)


class CaseAction(APIView):
    def get_permissions(self):
        return perm("crm.assign" if self.kwargs.get("action") == "assign" else "crm.manage")

    def post(self, request, pk, action):
        u, b = request.user.id, request.data
        if action == "assign":
            return Response(_case(sd.assign_case(u, pk, b.get("owner_id"), b.get("team", ""))))
        if action == "status":
            return Response(_case(sd.set_status(u, pk, b.get("status", ""), b.get("note", ""))))
        if action == "resolve":
            return Response(_case(sd.resolve_case(u, pk, b.get("resolution", ""))))
        if action == "feedback":
            return Response(_case(sd.record_feedback(u, pk, b.get("rating", 0), b.get("feedback", ""))))
        if action == "close":
            return Response(_case(sd.close_case(u, pk)))
        if action == "cancel":
            return Response(_case(sd.cancel_case(u, pk, b.get("reason", ""))))
        raise ValidationFailed(f"Unknown action '{action}'.", code="invalid_action")


class CaseAttachments(APIView):
    def get_permissions(self):
        return perm("crm.manage" if self.request.method == "POST" else "crm.view")

    def get(self, request, pk):
        return Response([{"id": str(f.id), "name": f.original_name, "size": f.size, "content_type": f.content_type} for f in sd.attachments(request.user.id, pk)])

    def post(self, request, pk):
        b = request.data
        try:
            data = base64.b64decode(b.get("content_base64", ""), validate=True)
        except Exception:
            raise ValidationFailed("content_base64 must be valid base64.", code="invalid_file")
        f = sd.attach_file(request.user.id, pk, b.get("filename", ""), data)
        return Response({"id": str(f.id), "name": f.original_name, "size": f.size}, status=201)


class SlaConfig(APIView):
    def get_permissions(self):
        return perm("crm.assign" if self.request.method == "PUT" else "crm.view")

    def get(self, request):
        return Response([{"priority": p.priority, "first_response_hours": p.first_response_hours, "resolution_hours": p.resolution_hours} for p in m.SlaPolicy.objects.order_by("first_response_hours")])

    def put(self, request):
        b = request.data
        p = sd.configure_sla(request.user.id, b.get("priority"), b.get("first_response_hours", 0), b.get("resolution_hours", 0))
        return Response({"priority": p.priority, "first_response_hours": p.first_response_hours, "resolution_hours": p.resolution_hours})


class ServiceReport(APIView):
    def get_permissions(self):
        return perm("crm.view")

    def get(self, request):
        q = request.query_params
        return Response(sd.service_report(request.user.id, _date(q.get("from"), "from"), _date(q.get("to"), "to")))
