from datetime import date

from rest_framework.response import Response
from rest_framework.views import APIView

from modules.procurement import contracts as ct
from modules.procurement import models as m
from platform_core.authorization.permissions import require
from shared.api.errors import DomainError, iso_date


def perm(code):
    return [require(code)()]


def _row(c):
    return {"id": str(c.id), "number": c.number, "title": c.title, "supplier": {"id": str(c.supplier_id), "name": c.supplier.name}, "status": c.status, "start_date": str(c.start_date), "end_date": str(c.end_date), "currency": c.currency, "value_limit": None if c.value_limit is None else str(c.value_limit)}


class Contracts(APIView):
    def get_permissions(self):
        return perm("procurement.contract.manage" if self.request.method == "POST" else "procurement.view")

    def get(self, request):
        qs = m.SupplierContract.objects.select_related("supplier").order_by("-created_at")
        if request.query_params.get("status"):
            qs = qs.filter(status=request.query_params["status"])
        if request.query_params.get("supplier"):
            qs = qs.filter(supplier_id=request.query_params["supplier"])
        return Response({"results": [_row(c) for c in qs[:200]]})

    def post(self, request):
        b = request.data
        c = ct.create(request.user.id, supplier_id=b.get("supplier"), title=b.get("title", ""), start_date=iso_date(b.get("start_date"), "start_date", required=True), end_date=iso_date(b.get("end_date"), "end_date", required=True), currency=b.get("currency", ""), prices=b.get("prices") or [], value_limit=b.get("value_limit"), payment_terms=b.get("payment_terms", ""), terms_text=b.get("terms_text", ""), auto_renew=bool(b.get("auto_renew")), renewal_notice_days=_int(b.get("renewal_notice_days", 60), "renewal_notice_days"))
        return Response(_row(c), status=201)


def _int(value, field):
    from shared.api.errors import ValidationFailed
    try:
        return int(value)
    except (TypeError, ValueError):
        raise ValidationFailed(f"{field} must be a whole number.", code="invalid_number")


class ContractDetail(APIView):
    def get_permissions(self):
        return perm("procurement.view")

    def get(self, request, pk):
        return Response(ct.status_report(pk))


class ContractAction(APIView):
    def get_permissions(self):
        return perm("procurement.contract.approve" if self.kwargs.get("action") == "activate" else "procurement.contract.manage")

    def post(self, request, pk, action):
        b, uid = request.data, request.user.id
        if action == "activate":
            c = ct.activate(uid, pk)
        elif action == "terminate":
            c = ct.terminate(uid, pk, reason=b.get("reason", ""))
        elif action == "extend":
            c = ct.extend(uid, pk, new_end_date=date.fromisoformat(b["new_end_date"]), value_limit=b.get("value_limit"), reason=b.get("reason", ""))
        else:
            raise DomainError("Unknown action.", code="not_found", status_code=404)
        return Response(_row(c))


class ContractsExpiring(APIView):
    def get_permissions(self):
        return perm("procurement.view")

    def get(self, request):
        return Response({"results": ct.expiring(int(request.query_params.get("days", 60)))})
