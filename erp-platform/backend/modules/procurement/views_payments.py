from datetime import date

from rest_framework.response import Response
from rest_framework.views import APIView

from modules.procurement import payments as pay
from platform_core.authorization.permissions import require
from shared.api.errors import ValidationFailed


def perm(code):
    return [require(code)()]


def _d(v, default=None):
    return date.fromisoformat(v) if v else default


class DueList(APIView):
    def get_permissions(self):
        return perm("procurement.payment.release")

    def get(self, request):
        q = request.query_params
        return Response({"results": pay.due_list(_d(q.get("as_of"), date.today()), int(q.get("within_days", 0)))})


class Ageing(APIView):
    def get_permissions(self):
        return perm("procurement.payment.release")

    def get(self, request):
        return Response({"results": pay.ageing(_d(request.query_params.get("as_of"), date.today()))})


class Statement(APIView):
    def get_permissions(self):
        return perm("procurement.view")

    def get(self, request, pk):
        q = request.query_params
        return Response(pay.statement(pk, _d(q.get("from"), date(2000, 1, 1)), _d(q.get("to"), date.today())))


class PayInvoice(APIView):
    def get_permissions(self):
        return perm("procurement.payment.release")

    def post(self, request, pk):
        b = request.data
        if not b.get("payment_date") or not b.get("bank_account"):
            raise ValidationFailed("payment_date and bank_account are required.", code="invalid_payment")
        p, created = pay.pay_invoice(request.user.id, idempotency_key=request.headers.get("Idempotency-Key") or b.get("idempotency_key", ""), invoice_id=pk, bank_account_id=b["bank_account"], payment_date=date.fromisoformat(b["payment_date"]), take_discount=b.get("take_discount", True) is not False, withhold=b.get("withhold", True) is not False, memo=b.get("memo", ""))
        return Response({"payment": p.number, "amount": str(p.amount), "replayed": not created}, status=201 if created else 200)


class WhtReport(APIView):
    def get_permissions(self):
        return perm("procurement.payment.release")

    def get(self, request):
        q = request.query_params
        return Response({"results": pay.wht_report(_d(q.get("from"), date(2000, 1, 1)), _d(q.get("to"), date.today()))})
