from datetime import date

from rest_framework.response import Response
from rest_framework.views import APIView

from modules.procurement import analytics as an
from platform_core.authorization.permissions import require
from platform_core.organizations import services as org
from shared.api.errors import ValidationFailed


def perm(code):
    return [require(code)()]


def _range(request):
    q = request.query_params
    try:
        return date.fromisoformat(q["from"]), date.fromisoformat(q["to"])
    except (KeyError, ValueError):
        raise ValidationFailed("from and to (YYYY-MM-DD) are required.", code="invalid_date")


class SupplierPerformance(APIView):
    def get_permissions(self):
        return perm("procurement.view")

    def get(self, request):
        return Response({"results": an.supplier_performance(*_range(request))})


class SpendBy(APIView):
    def get_permissions(self):
        return perm("procurement.view")

    def get(self, request):
        return Response({"results": an.spend(*_range(request), group_by=request.query_params.get("group_by", "supplier"))})


class CycleTimes(APIView):
    def get_permissions(self):
        return perm("procurement.view")

    def get(self, request):
        return Response(an.cycle_times(*_range(request)))


class PriceVariance(APIView):
    def get_permissions(self):
        return perm("procurement.view")

    def get(self, request):
        return Response({"results": an.price_variance(*_range(request))})


class WorkQueue(APIView):
    def get_permissions(self):
        return perm("procurement.view")

    def get(self, request):
        return Response(an.work_queue(date.today()))


class ProcurementSettings(APIView):
    def get_permissions(self):
        return perm("procurement.settings.manage" if self.request.method == "PATCH" else "procurement.view")

    def get(self, request):
        return Response({k: v for k, v in org.all_settings().items() if k.startswith("procurement.")})

    def patch(self, request):
        bad = [k for k in request.data if not str(k).startswith("procurement.")]
        if bad:
            raise ValidationFailed("Only procurement settings can be changed here.", code="invalid_setting")
        org.update_settings(request.user.id, dict(request.data))
        return Response({k: v for k, v in org.all_settings().items() if k.startswith("procurement.")})
