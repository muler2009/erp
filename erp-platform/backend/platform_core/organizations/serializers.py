from rest_framework import serializers

from platform_core.organizations import models as m

_BASE_RO = ["id", "created_at", "updated_at", "version"]


def _model_serializer(model, fields, extra_ro=()):
    extra_kwargs = {"code": {"validators": []}} if "code" in fields else {}  # uniqueness is enforced (after normalization) by the service
    meta = type("Meta", (), {"model": model, "fields": _BASE_RO + fields, "read_only_fields": _BASE_RO + list(extra_ro), "extra_kwargs": extra_kwargs})
    return type(f"{model.__name__}Serializer", (serializers.ModelSerializer,), {"Meta": meta, "version": serializers.IntegerField(required=False)})


DepartmentSerializer = _model_serializer(m.Department, ["code", "name", "parent", "business_unit", "branch", "head_user_id", "is_active"])
TeamSerializer = _model_serializer(m.Team, ["code", "name", "department", "lead_user_id", "is_active"])
PositionSerializer = _model_serializer(m.Position, ["code", "title", "department", "description", "is_active"])
CostCenterSerializer = _model_serializer(m.CostCenter, ["code", "name", "department", "business_unit", "manager_user_id", "is_active"])
BusinessUnitSerializer = _model_serializer(m.BusinessUnit, ["code", "name", "head_user_id", "is_active"])
BranchSerializer = _model_serializer(m.Branch, ["code", "name", "legal_entity", "address", "is_active"])
LegalEntitySerializer = _model_serializer(m.LegalEntity, ["code", "name", "registration_number", "tax_id", "country", "currency", "is_active"])


class CompanySerializer(serializers.ModelSerializer):
    version = serializers.IntegerField(required=False)

    class Meta:
        model = m.Company
        fields = ["id", "legal_name", "trade_name", "registration_number", "tax_id", "country", "address", "phone", "email", "base_currency", "fiscal_year_start_month", "work_days", "version", "updated_at"]
        read_only_fields = ["id", "updated_at"]
        extra_kwargs = {"fiscal_year_start_month": {"min_value": 1, "max_value": 12}}


class CurrencySerializer(serializers.ModelSerializer):
    class Meta:
        model = m.Currency
        fields = ["id", "code", "name", "symbol", "decimals", "is_active"]
        read_only_fields = fields


class ExchangeRateSerializer(serializers.ModelSerializer):
    currency_code = serializers.CharField(source="currency.code", read_only=True)

    class Meta:
        model = m.ExchangeRate
        fields = ["id", "currency", "currency_code", "rate_date", "rate", "source"]
        read_only_fields = ["id", "currency_code"]


class FiscalPeriodSerializer(serializers.ModelSerializer):
    class Meta:
        model = m.FiscalPeriod
        fields = ["id", "number", "name", "start_date", "end_date", "status", "closed_at", "closed_by", "version"]
        read_only_fields = fields


class FiscalYearSerializer(serializers.ModelSerializer):
    periods = FiscalPeriodSerializer(many=True, read_only=True)

    class Meta:
        model = m.FiscalYear
        fields = ["id", "name", "start_date", "end_date", "periods"]
        read_only_fields = ["id", "end_date", "periods"]


class HolidaySerializer(serializers.ModelSerializer):
    class Meta:
        model = m.Holiday
        fields = ["id", "holiday_date", "name", "branch"]
        read_only_fields = ["id"]


class ProfileSerializer(serializers.ModelSerializer):
    class Meta:
        model = m.TenantUserProfile
        fields = ["user_id", "department", "team", "position", "business_unit", "cost_center", "manager_user_id"]
        read_only_fields = ["user_id"]
