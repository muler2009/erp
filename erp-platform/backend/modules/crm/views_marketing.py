from rest_framework.response import Response
from rest_framework.views import APIView

from modules.crm import campaigns as cp
from modules.crm import models as m
from modules.crm.views import _date, _lead, _s, perm
from shared.api.errors import ValidationFailed
from shared.api.pagination import paginate


def _camp(c):
    return {"id": str(c.id), "number": c.number, "name": c.name, "objective": c.objective, "channel": c.channel, "audience": c.audience, "budget": str(c.budget), "currency": c.currency, "start_date": str(c.start_date), "end_date": str(c.end_date), "status": c.status, "owner_id": str(c.owner_id)}


def _mem(x):
    return {"id": str(x.id), "contact": _s(x.contact_id), "lead": _s(x.lead_id), "status": x.status, "excluded_reason": x.excluded_reason}


class Campaigns(APIView):
    def get_permissions(self):
        return perm("crm.campaign.manage")

    def get(self, request):
        return paginate(request, m.Campaign.objects.order_by("-start_date"), _camp)

    def post(self, request):
        b = request.data
        c = cp.create_campaign(request.user.id, name=b.get("name", ""), start_date=_date(b.get("start_date"), "start_date"), end_date=_date(b.get("end_date"), "end_date"), currency=b.get("currency", ""), channel=b.get("channel", "EMAIL"), objective=b.get("objective", ""), budget=b.get("budget", 0), audience=b.get("audience"))
        return Response(_camp(c), status=201)


class CampaignDetail(APIView):
    def get_permissions(self):
        return perm("crm.campaign.manage")

    def get(self, request, pk):
        return Response(_camp(cp._get(pk)))


class CampaignAction(APIView):
    def get_permissions(self):
        return perm("crm.assign" if self.kwargs.get("action") == "budget" else "crm.campaign.manage")

    def post(self, request, pk, action):
        u, b = request.user.id, request.data
        if action == "audience":
            return Response(cp.build_audience(u, pk))
        if action in ("activate", "complete", "cancel"):
            return Response(_camp(cp.set_status(u, pk, {"activate": "ACTIVE", "complete": "COMPLETED", "cancel": "CANCELLED"}[action])))
        if action == "send":
            sent, blocked = cp.record_sent(u, pk, b.get("members"))
            return Response({"sent": sent, "blocked": blocked})
        if action == "expenses":
            e = cp.add_expense(u, pk, on_date=_date(b.get("on_date"), "on_date"), description=b.get("description", ""), amount=b.get("amount"))
            return Response({"id": str(e.id), "amount": str(e.amount)}, status=201)
        if action == "budget":
            return Response(_camp(cp.update_budget(u, pk, b.get("budget"))))
        if action == "capture":
            return Response(_lead(cp.capture_lead(u, pk, name=b.get("name", ""), email=b.get("email", ""), phone=b.get("phone", ""), company=b.get("company", ""), marketing_consent=b.get("marketing_consent", False))), status=201)
        raise ValidationFailed(f"Unknown action '{action}'.", code="invalid_action")


class CampaignMembers(APIView):
    def get_permissions(self):
        return perm("crm.campaign.manage")

    def get(self, request, pk):
        qs = cp._get(pk).members.order_by("created_at")
        if request.query_params.get("status"):
            qs = qs.filter(status=request.query_params["status"])
        return paginate(request, qs, _mem)


class MemberResponse(APIView):
    def get_permissions(self):
        return perm("crm.campaign.manage")

    def post(self, request, pk):
        return Response(_mem(cp.record_response(request.user.id, pk)))


class CampaignReport(APIView):
    def get_permissions(self):
        return perm("crm.campaign.manage")

    def get(self, request, pk):
        return Response(cp.campaign_report(request.user.id, pk))


class CampaignsOverview(APIView):
    def get_permissions(self):
        return perm("crm.campaign.manage")

    def get(self, request):
        return Response(cp.campaigns_overview(request.user.id))


class LeadConsent(APIView):
    def get_permissions(self):
        return perm("crm.manage")

    def post(self, request, pk):
        b = request.data
        return Response(_lead(cp.set_lead_consent(request.user.id, pk, consent=b.get("consent"), opt_out=b.get("opt_out"))))
