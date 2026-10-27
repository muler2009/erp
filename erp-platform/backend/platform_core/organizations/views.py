"""Organization API: thin views over platform_core.organizations.services."""
from django.db import connection
from django.shortcuts import get_object_or_404
from rest_framework import serializers
from rest_framework.response import Response
from rest_framework.views import APIView

from platform_core.authorization.permissions import require
from platform_core.organizations import models as m
from platform_core.organizations import serializers as s
from platform_core.organizations import services
from platform_core.users.models import TenantMembership
from shared.api.errors import DomainError
from shared.api.pagination import paginate
from shared.sequences import services as seq_services
from shared.sequences.models import NumberSequence


def resource_views(key, model, serializer, view_perm, manage_perm, ordering="code"):
    """Build list/create and detail views for one structural resource."""

    class ListCreate(APIView):
        def get_permissions(self):
            return [require(manage_perm if self.request.method == "POST" else view_perm)()]

        def get(self, request):
            qs = model.objects.all()
            if request.query_params.get("active") in ("true", "false"):
                qs = qs.filter(is_active=request.query_params["active"] == "true")
            return paginate(request, qs, lambda o: serializer(o).data, ordering=ordering)

        def post(self, request):
            data = serializer(data=request.data)
            data.is_valid(raise_exception=True)
            obj = services.create_resource(key, request.user.id, data.validated_data, request)
            return Response(serializer(obj).data, status=201)

    class Detail(APIView):
        def get_permissions(self):
            return [require(manage_perm if self.request.method == "PATCH" else view_perm)()]

        def get(self, request, pk):
            return Response(serializer(get_object_or_404(model, pk=pk)).data)

        def patch(self, request, pk):
            obj = get_object_or_404(model, pk=pk)
            data = serializer(obj, data=request.data, partial=True)
            data.is_valid(raise_exception=True)
            obj = services.update_resource(key, request.user.id, obj, data.validated_data, request)
            return Response(serializer(obj).data)

    ListCreate.__name__ = f"{key.title().replace('_', '')}ListCreate"
    Detail.__name__ = f"{key.title().replace('_', '')}Detail"
    return ListCreate, Detail


STRUCT_VIEW, STRUCT_MANAGE = "org.structure.view", "org.structure.manage"
DepartmentList, DepartmentDetail = resource_views("department", m.Department, s.DepartmentSerializer, STRUCT_VIEW, STRUCT_MANAGE)
TeamList, TeamDetail = resource_views("team", m.Team, s.TeamSerializer, STRUCT_VIEW, STRUCT_MANAGE)
PositionList, PositionDetail = resource_views("position", m.Position, s.PositionSerializer, STRUCT_VIEW, STRUCT_MANAGE)
CostCenterList, CostCenterDetail = resource_views("cost_center", m.CostCenter, s.CostCenterSerializer, STRUCT_VIEW, STRUCT_MANAGE)
BusinessUnitList, BusinessUnitDetail = resource_views("business_unit", m.BusinessUnit, s.BusinessUnitSerializer, STRUCT_VIEW, STRUCT_MANAGE)
BranchList, BranchDetail = resource_views("branch", m.Branch, s.BranchSerializer, STRUCT_VIEW, STRUCT_MANAGE)
LegalEntityList, LegalEntityDetail = resource_views("legal_entity", m.LegalEntity, s.LegalEntitySerializer, STRUCT_VIEW, STRUCT_MANAGE)


class CompanyView(APIView):
    def get_permissions(self):
        return [require("org.settings.manage" if self.request.method == "PATCH" else "org.structure.view")()]

    def get(self, request):
        return Response(s.CompanySerializer(services.get_company()).data)

    def patch(self, request):
        data = s.CompanySerializer(services.get_company(), data=request.data, partial=True)
        data.is_valid(raise_exception=True)
        return Response(s.CompanySerializer(services.update_company(request.user.id, data.validated_data, request)).data)


class CurrencyList(APIView):
    permission_classes = [require("org.reference.view")]

    def get(self, request):
        qs = m.Currency.objects.all()
        if request.query_params.get("active") in ("true", "false"):
            qs = qs.filter(is_active=request.query_params["active"] == "true")
        return paginate(request, qs, lambda o: s.CurrencySerializer(o).data, ordering="code")


class CurrencyActivation(APIView):
    permission_classes = [require("org.reference.manage")]

    class In(serializers.Serializer):
        is_active = serializers.BooleanField()

    def patch(self, request, code):
        data = self.In(data=request.data)
        data.is_valid(raise_exception=True)
        currency = get_object_or_404(m.Currency, code=code.upper())
        return Response(s.CurrencySerializer(services.set_currency_active(request.user.id, currency, data.validated_data["is_active"], request)).data)


class ExchangeRates(APIView):
    def get_permissions(self):
        return [require("org.reference.manage" if self.request.method == "POST" else "org.reference.view")()]

    class In(serializers.Serializer):
        currency = serializers.CharField(max_length=3)
        rate_date = serializers.DateField()
        rate = serializers.DecimalField(max_digits=18, decimal_places=8)
        source = serializers.CharField(max_length=60, required=False, allow_blank=True, default="")

    def get(self, request):
        qs = m.ExchangeRate.objects.select_related("currency")
        if request.query_params.get("currency"):
            qs = qs.filter(currency__code=request.query_params["currency"].upper())
        return paginate(request, qs, lambda o: s.ExchangeRateSerializer(o).data, ordering="-rate_date")

    def post(self, request):
        data = self.In(data=request.data)
        data.is_valid(raise_exception=True)
        v = data.validated_data
        currency = get_object_or_404(m.Currency, code=v["currency"].upper())
        obj = services.set_exchange_rate(request.user.id, currency, v["rate_date"], v["rate"], v["source"], request)
        return Response(s.ExchangeRateSerializer(obj).data, status=201)


class FiscalYears(APIView):
    def get_permissions(self):
        return [require("org.reference.manage" if self.request.method == "POST" else "org.reference.view")()]

    class In(serializers.Serializer):
        name = serializers.CharField(max_length=40)
        start_date = serializers.DateField()

    def get(self, request):
        return Response([s.FiscalYearSerializer(y).data for y in m.FiscalYear.objects.prefetch_related("periods").order_by("start_date")])

    def post(self, request):
        data = self.In(data=request.data)
        data.is_valid(raise_exception=True)
        year = services.create_fiscal_year(request.user.id, data.validated_data["name"], data.validated_data["start_date"], request)
        return Response(s.FiscalYearSerializer(year).data, status=201)


class PeriodClose(APIView):
    permission_classes = [require("org.fiscal.close")]

    def post(self, request, pk):
        period = get_object_or_404(m.FiscalPeriod, pk=pk)
        return Response(s.FiscalPeriodSerializer(services.close_period(request.user.id, period, request)).data)


class PeriodReopen(APIView):
    permission_classes = [require("org.fiscal.close")]

    class In(serializers.Serializer):
        reason = serializers.CharField()

    def post(self, request, pk):
        data = self.In(data=request.data)
        data.is_valid(raise_exception=True)
        period = get_object_or_404(m.FiscalPeriod, pk=pk)
        return Response(s.FiscalPeriodSerializer(services.reopen_period(request.user.id, period, data.validated_data["reason"], request)).data)


class Holidays(APIView):
    def get_permissions(self):
        return [require("org.reference.manage" if self.request.method == "POST" else "org.reference.view")()]

    def get(self, request):
        return paginate(request, m.Holiday.objects.all(), lambda o: s.HolidaySerializer(o).data, ordering="-holiday_date")

    def post(self, request):
        data = s.HolidaySerializer(data=request.data)
        data.is_valid(raise_exception=True)
        v = data.validated_data
        return Response(s.HolidaySerializer(services.add_holiday(request.user.id, v["holiday_date"], v["name"], v.get("branch"), request)).data, status=201)


class MemberProfiles(APIView):
    permission_classes = [require("org.structure.view")]

    def get(self, request):
        memberships = TenantMembership.objects.filter(tenant=connection.tenant, status=TenantMembership.Status.ACTIVE).select_related("user").order_by("created_at")
        profiles = {p.user_id: p for p in m.TenantUserProfile.objects.all()}
        out = []
        for mem in memberships:
            profile = profiles.get(mem.user_id)
            out.append({"user_id": str(mem.user_id), "email": mem.user.email, "display_name": mem.user.display_name, "profile": s.ProfileSerializer(profile).data if profile else None})
        return Response(out)


class MemberProfile(APIView):
    permission_classes = [require("org.profiles.manage")]

    def put(self, request, user_id):
        data = s.ProfileSerializer(data=request.data, partial=True)
        data.is_valid(raise_exception=True)
        profile = services.assign_profile(request.user.id, user_id, data.validated_data, request)
        return Response(s.ProfileSerializer(profile).data)


class Settings(APIView):
    def get_permissions(self):
        return [require("org.settings.manage")()]

    def get(self, request):
        return Response(services.all_settings())

    def put(self, request):
        if not isinstance(request.data, dict):
            raise DomainError("Expected an object.", code="validation_error", status_code=400)
        return Response(services.update_settings(request.user.id, dict(request.data), request))


class SequenceSerializer(serializers.ModelSerializer):
    class Meta:
        model = NumberSequence
        fields = ["id", "code", "name", "template", "reset_policy", "next_value", "period_key", "is_active"]
        read_only_fields = ["id", "next_value", "period_key"]
        extra_kwargs = {"code": {"validators": []}}  # uniqueness is a domain rule (sequence_exists)


class Sequences(APIView):
    def get_permissions(self):
        return [require("org.sequences.manage")()]

    def get(self, request):
        return paginate(request, NumberSequence.objects.all(), lambda o: SequenceSerializer(o).data, ordering="code")

    def post(self, request):
        data = SequenceSerializer(data=request.data)
        data.is_valid(raise_exception=True)
        v = data.validated_data
        seq = seq_services.create_sequence(v["code"], v["name"], v["template"], v.get("reset_policy", NumberSequence.Reset.NEVER))
        return Response(SequenceSerializer(seq).data, status=201)


class SequenceDetail(APIView):
    permission_classes = [require("org.sequences.manage")]

    def get(self, request, code):
        seq = get_object_or_404(NumberSequence, code=code)
        return Response({**SequenceSerializer(seq).data, "preview": seq_services.preview(code)})

    def patch(self, request, code):
        seq = get_object_or_404(NumberSequence, code=code)
        body = request.data
        extra = {"next_value": body["next_value"]} if "next_value" in body else {}
        data = SequenceSerializer(seq, data=body, partial=True)
        data.is_valid(raise_exception=True)
        v = data.validated_data
        v.pop("code", None)
        seq = seq_services.update_sequence(seq, **v, **extra)
        return Response(SequenceSerializer(seq).data)
