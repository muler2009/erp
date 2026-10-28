from decimal import Decimal

from django.utils.dateparse import parse_date, parse_datetime
from rest_framework.response import Response
from rest_framework.views import APIView

from modules.crm import models as m
from modules.crm import services
from platform_core.authorization.permissions import require
from shared.api.errors import DomainError, ValidationFailed
from shared.api.pagination import paginate


def perm(code):
    return [require(code)()]


def _s(v):
    return None if v is None else str(v)


def _date(v, field):
    if v in (None, ""):
        return None
    d = parse_date(str(v))
    if d is None:
        raise ValidationFailed(f"{field} must be a date (YYYY-MM-DD).", code="invalid_date")
    return d


def _account(a):
    return {"id": str(a.id), "name": a.name, "industry": a.industry, "segment": a.segment, "owner_id": str(a.owner_id), "is_active": a.is_active, "partner": _s(a.partner_id)}


def _contact(c):
    return {"id": str(c.id), "account": _s(c.account_id), "first_name": c.first_name, "last_name": c.last_name, "email": c.email, "phone": c.phone, "job_title": c.job_title}


def _lead(l):
    return {"id": str(l.id), "name": l.name, "company": l.company, "email": l.email, "status": l.status, "source": l.source, "owner_id": _s(l.owner_id), "converted_opportunity": _s(l.converted_opportunity_id), "converted_account": _s(l.converted_account_id)}


def _opp(o):
    return {"id": str(o.id), "name": o.name, "account": str(o.account_id), "stage": o.stage.code, "probability": o.stage.probability, "amount": str(o.amount), "currency": o.currency, "status": o.status, "expected_close": _s(o.expected_close), "owner_id": str(o.owner_id)}


def _act(a):
    return {"id": str(a.id), "type": a.type, "subject": a.subject, "due_at": a.due_at, "done_at": a.done_at, "owner_id": str(a.owner_id), "lead": _s(a.lead_id), "opportunity": _s(a.opportunity_id), "account": _s(a.account_id)}


class Accounts(APIView):
    def get_permissions(self):
        return perm("crm.manage" if self.request.method == "POST" else "crm.view")

    def get(self, request):
        qs = services.scope(m.CrmAccount.objects.all(), request.user.id)
        if request.query_params.get("segment"):
            qs = qs.filter(segment=request.query_params["segment"])
        if request.query_params.get("q"):
            qs = qs.filter(name__icontains=request.query_params["q"])
        return paginate(request, qs, _account)

    def post(self, request):
        b = request.data
        a = services.create_account(request.user.id, name=b.get("name", ""), industry=b.get("industry", ""), segment=b.get("segment", ""), website=b.get("website", ""), tax_id=b.get("tax_id", ""), owner_id=b.get("owner_id"))
        return Response(_account(a), status=201)


class AccountDetail(APIView):
    def get_permissions(self):
        return perm("crm.manage" if self.request.method == "PATCH" else "crm.view")

    def get(self, request, pk):
        return Response(_account(services._own(m.CrmAccount, pk, request.user.id, "Account")))

    def patch(self, request, pk):
        b = request.data
        return Response(_account(services.update_account(request.user.id, pk, name=b.get("name"), industry=b.get("industry"), segment=b.get("segment"), is_active=b.get("is_active"))))


class Segments(APIView):
    def get_permissions(self):
        return perm("crm.view")

    def get(self, request):
        return Response(services.segments())


class Contacts(APIView):
    def get_permissions(self):
        return perm("crm.manage" if self.request.method == "POST" else "crm.view")

    def get(self, request):
        return paginate(request, services.scope(m.Contact.objects.all(), request.user.id), _contact)

    def post(self, request):
        b = request.data
        c = services.create_contact(request.user.id, first_name=b.get("first_name", ""), last_name=b.get("last_name", ""), email=b.get("email", ""), phone=b.get("phone", ""), job_title=b.get("job_title", ""), account_id=b.get("account"))
        return Response(_contact(c), status=201)


class Leads(APIView):
    def get_permissions(self):
        return perm("crm.manage" if self.request.method == "POST" else "crm.view")

    def get(self, request):
        qs = services.scope(m.Lead.objects.all(), request.user.id)
        if request.query_params.get("status"):
            qs = qs.filter(status=request.query_params["status"])
        return paginate(request, qs, _lead)

    def post(self, request):
        b = request.data
        l = services.create_lead(request.user.id, name=b.get("name", ""), company=b.get("company", ""), email=b.get("email", ""), phone=b.get("phone", ""), source=b.get("source", ""), auto_assign=b.get("auto_assign", True), owner_id=b.get("owner_id"))
        return Response(_lead(l), status=201)


class LeadDetail(APIView):
    def get_permissions(self):
        return perm("crm.view")

    def get(self, request, pk):
        return Response(_lead(services._own(m.Lead, pk, request.user.id, "Lead")))


class LeadStatus(APIView):
    def get_permissions(self):
        return perm("crm.manage")

    def post(self, request, pk):
        return Response(_lead(services.set_lead_status(request.user.id, pk, request.data.get("status", ""), request.data.get("reason", ""))))


class LeadConvert(APIView):
    def get_permissions(self):
        return perm("crm.manage")

    def post(self, request, pk):
        b = request.data
        lead, opp = services.convert_lead(request.user.id, pk, opportunity_name=b.get("opportunity_name"), amount=b.get("amount", 0), currency=b.get("currency"), expected_close=_date(b.get("expected_close"), "expected_close"), account_id=b.get("account"))
        return Response({"lead": _lead(lead), "opportunity": _opp(opp)}, status=201)


class Assign(APIView):
    def get_permissions(self):
        return perm("crm.assign")

    def post(self, request, kind, pk):
        if kind not in ("lead", "opportunity", "account"):
            raise DomainError("Unknown record kind.", code="not_found", status_code=404)
        services.assign_owner(request.user.id, kind, pk, request.data.get("owner_id"))
        return Response({"ok": True})


class Opportunities(APIView):
    def get_permissions(self):
        return perm("crm.manage" if self.request.method == "POST" else "crm.view")

    def get(self, request):
        qs = services.scope(m.Opportunity.objects.select_related("stage"), request.user.id)
        if request.query_params.get("status"):
            qs = qs.filter(status=request.query_params["status"])
        return paginate(request, qs, _opp)

    def post(self, request):
        b = request.data
        o = services.create_opportunity(request.user.id, name=b.get("name", ""), account_id=b.get("account"), amount=b.get("amount", 0), currency=b.get("currency", ""), expected_close=_date(b.get("expected_close"), "expected_close"), contact_id=b.get("contact"), stage=b.get("stage", "PROSPECTING"))
        return Response(_opp(m.Opportunity.objects.select_related("stage").get(pk=o.pk)), status=201)


class OpportunityDetail(APIView):
    def get_permissions(self):
        return perm("crm.view")

    def get(self, request, pk):
        services._own(m.Opportunity, pk, request.user.id, "Opportunity")
        return Response(_opp(m.Opportunity.objects.select_related("stage").get(pk=pk)))


def _opp_action(fn):
    class View(APIView):
        def get_permissions(self):
            return perm("crm.manage")

        def post(self, request, pk):
            o = fn(request, pk)
            return Response(_opp(m.Opportunity.objects.select_related("stage").get(pk=o.pk)))

    return View


OpportunityStage = _opp_action(lambda r, pk: services.move_stage(r.user.id, pk, r.data.get("stage", "")))
OpportunityWin = _opp_action(lambda r, pk: services.win_opportunity(r.user.id, pk))
OpportunityLose = _opp_action(lambda r, pk: services.lose_opportunity(r.user.id, pk, r.data.get("reason", "")))


class Activities(APIView):
    def get_permissions(self):
        return perm("crm.manage" if self.request.method == "POST" else "crm.view")

    def get(self, request):
        return paginate(request, services.scope(m.Activity.objects.all(), request.user.id), _act)

    def post(self, request):
        b = request.data
        due = parse_datetime(b["due_at"]) if b.get("due_at") else None
        a = services.log_activity(request.user.id, type=b.get("type", ""), subject=b.get("subject", ""), due_at=due, notes=b.get("notes", ""), lead_id=b.get("lead"), opportunity_id=b.get("opportunity"), account_id=b.get("account"))
        return Response(_act(a), status=201)


class ActivityComplete(APIView):
    def get_permissions(self):
        return perm("crm.manage")

    def post(self, request, pk):
        return Response(_act(services.complete_activity(request.user.id, pk)))


class Followups(APIView):
    def get_permissions(self):
        return perm("crm.view")

    def get(self, request):
        return Response([_act(a) for a in services.followups_due(request.user.id)[:200]])


class Forecast(APIView):
    def get_permissions(self):
        return perm("crm.view")

    def get(self, request):
        return Response(services.forecast(request.user.id))


class Conversion(APIView):
    def get_permissions(self):
        return perm("crm.view")

    def get(self, request):
        return Response(services.conversion_report(request.user.id))


class Stages(APIView):
    def get_permissions(self):
        return perm("crm.view")

    def get(self, request):
        return Response([{"code": s.code, "name": s.name, "probability": s.probability, "is_won": s.is_won, "is_lost": s.is_lost} for s in m.PipelineStage.objects.all()])
