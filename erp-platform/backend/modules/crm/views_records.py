from rest_framework.response import Response
from rest_framework.views import APIView

from modules.crm import models as m
from modules.crm import records
from modules.crm.services import _own, scope
from modules.crm.views import _account, _contact, _date, _lead, _s, perm
from shared.api.errors import ValidationFailed


def _addr(a):
    return {"id": str(a.id), "kind": a.kind, "label": a.label, "line1": a.line1, "city": a.city, "region": a.region, "country": a.country, "is_default": a.is_default}


class LeadDuplicates(APIView):
    def get_permissions(self):
        return perm("crm.view")

    def get(self, request):
        q = request.query_params
        return Response(records.find_lead_duplicates(request.user.id, name=q.get("name", ""), company=q.get("company", ""), email=q.get("email", ""), phone=q.get("phone", "")))


class LeadMerge(APIView):
    def get_permissions(self):
        return perm("crm.manage")

    def post(self, request):
        return Response(_lead(records.merge_leads(request.user.id, request.data.get("keep"), request.data.get("merge"))))


class LeadImport(APIView):
    def get_permissions(self):
        return perm("crm.manage")

    def post(self, request):
        b = request.data
        rows = records.parse_csv(b["csv"]) if b.get("csv") else b.get("rows")
        if not isinstance(rows, list):
            raise ValidationFailed("Provide rows or csv.", code="invalid_import")
        return Response(records.import_leads(request.user.id, rows, dry_run=bool(b.get("dry_run", True)), source=b.get("source", "IMPORT")))


class AccountCredit(APIView):
    def get_permissions(self):
        return perm("crm.assign")

    def post(self, request, pk):
        b = request.data
        kw = {"credit_limit": b["credit_limit"]} if "credit_limit" in b else {}
        return Response(_account(records.set_credit(request.user.id, pk, credit_status=b.get("credit_status"), note=b.get("note"), **kw)))


class AccountAddresses(APIView):
    def get_permissions(self):
        return perm("crm.manage" if self.request.method == "POST" else "crm.view")

    def get(self, request, pk):
        return Response([_addr(a) for a in _own(m.CrmAccount, pk, request.user.id, "Account").addresses.order_by("kind", "created_at")])

    def post(self, request, pk):
        b = request.data
        return Response(_addr(records.add_address(request.user.id, pk, kind=b.get("kind"), line1=b.get("line1"), label=b.get("label", ""), city=b.get("city", ""), region=b.get("region", ""), country=b.get("country", ""), is_default=bool(b.get("is_default", False)))), status=201)


class AddressDetail(APIView):
    def get_permissions(self):
        return perm("crm.manage")

    def delete(self, request, pk):
        records.delete_address(request.user.id, pk)
        return Response(status=204)


class AccountTimeline(APIView):
    def get_permissions(self):
        return perm("crm.view")

    def get(self, request, pk):
        return Response(records.account_timeline(request.user.id, pk))


class AccountChildren(APIView):
    def get_permissions(self):
        return perm("crm.view")

    def get(self, request, pk):
        a = _own(m.CrmAccount, pk, request.user.id, "Account")
        return Response([_account(c) for c in scope(a.children.all(), request.user.id)])


class ContactDetail(APIView):
    def get_permissions(self):
        return perm("crm.manage" if self.request.method == "PATCH" else "crm.view")

    def get(self, request, pk):
        return Response(_contact(_own(m.Contact, pk, request.user.id, "Contact")))

    def patch(self, request, pk):
        b = request.data
        keys = ("first_name", "last_name", "email", "phone", "job_title", "role", "preferred_channel", "account_id")
        return Response(_contact(records.update_contact(request.user.id, pk, **{k: b[k] for k in keys if k in b})))


class ContactConsent(APIView):
    def get_permissions(self):
        return perm("crm.manage")

    def post(self, request, pk):
        b = request.data
        return Response(_contact(records.set_consent(request.user.id, pk, email=b.get("email"), phone=b.get("phone"), sms=b.get("sms"), opt_out=b.get("opt_out"))))


class ContactLinks(APIView):
    def get_permissions(self):
        return perm("crm.manage")

    def post(self, request, pk):
        l = records.link_contact(request.user.id, pk, request.data.get("account"), request.data.get("role", ""))
        return Response({"contact": str(l.contact_id), "account": str(l.account_id), "role": l.role}, status=201)


class ContactDates(APIView):
    def get_permissions(self):
        return perm("crm.manage")

    def post(self, request, pk):
        b = request.data
        d = records.add_contact_date(request.user.id, pk, label=b.get("label"), on_date=_date(b.get("on_date"), "on_date"), remind_days_before=b.get("remind_days_before", 7), yearly=b.get("yearly", True))
        return Response({"id": str(d.id), "label": d.label, "on_date": str(d.on_date)}, status=201)


class UpcomingDates(APIView):
    def get_permissions(self):
        return perm("crm.view")

    def get(self, request):
        return Response(records.upcoming_contact_dates(request.user.id, within_days=int(request.query_params.get("days", 30))))


# ------------------------------------------------------------------ pipeline (slice B)
from django.utils.dateparse import parse_datetime  # noqa: E402

from modules.crm import pipeline  # noqa: E402
from modules.crm.views import _act, _opp  # noqa: E402
from shared.api.pagination import paginate  # noqa: E402


class OpportunityHistory(APIView):
    def get_permissions(self):
        return perm("crm.view")

    def get(self, request, pk):
        return Response(pipeline.stage_history(request.user.id, pk))


class OpportunityLines(APIView):
    def get_permissions(self):
        return perm("crm.manage" if self.request.method == "PUT" else "crm.view")

    def get(self, request, pk):
        o = _own(m.Opportunity, pk, request.user.id, "Opportunity")
        return Response([{"product": str(l.product_id), "sku": l.product.sku, "quantity": str(l.quantity), "expected_price": str(l.expected_price)} for l in o.lines.select_related("product")])

    def put(self, request, pk):
        pipeline.set_lines(request.user.id, pk, request.data.get("lines") or [])
        return self.get(request, pk)


class StageConfig(APIView):
    def get_permissions(self):
        return perm("crm.assign")

    def put(self, request, code):
        b = request.data
        st = pipeline.configure_stage(request.user.id, code, name=b.get("name"), position=b.get("position"), probability=b.get("probability"))
        return Response({"code": st.code, "name": st.name, "position": st.position, "probability": st.probability})

    def delete(self, request, code):
        pipeline.retire_stage(request.user.id, code)
        return Response(status=204)


class ForecastBy(APIView):
    def get_permissions(self):
        return perm("crm.view")

    def get(self, request):
        return Response(pipeline.forecast_by(request.user.id, request.query_params.get("group", "owner")))


class ActivityCalendar(APIView):
    def get_permissions(self):
        return perm("crm.view")

    def get(self, request):
        q = request.query_params
        d_from = parse_datetime(q["from"]) if q.get("from") else None
        d_to = parse_datetime(q["to"]) if q.get("to") else None
        return paginate(request, pipeline.my_activities(request.user.id, d_from, d_to, team=q.get("scope") == "team"), _act)


class ActivitiesOverdue(APIView):
    def get_permissions(self):
        return perm("crm.view")

    def get(self, request):
        return Response([_act(a) for a in pipeline.overdue(request.user.id)[:200]])
