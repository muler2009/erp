"""Organization & Administration application services (tenant schema).

All writes go through here: validation of business rules, optimistic locking, audit, outbox events.
"""
import calendar
import re
from datetime import date, timedelta
from decimal import Decimal

from django.db import connection, transaction
from django.utils import timezone

from platform_core.audit.services import record_tenant_event
from platform_core.organizations import models as m
from platform_core.users.models import TenantMembership
from shared.tenancy import current_tenant
from shared.api.errors import DomainError, ValidationFailed
from shared.events import services as events

CODE_RE = re.compile(r"^[A-Z0-9][A-Z0-9._-]{0,29}$")
MAX_DEPARTMENT_DEPTH = 8

DEFAULT_CURRENCIES = [
    ("USD", "US Dollar", "$", 2), ("EUR", "Euro", "€", 2), ("GBP", "Pound Sterling", "£", 2), ("ETB", "Ethiopian Birr", "Br", 2),
    ("KES", "Kenyan Shilling", "KSh", 2), ("NGN", "Nigerian Naira", "₦", 2), ("ZAR", "South African Rand", "R", 2),
    ("INR", "Indian Rupee", "₹", 2), ("CNY", "Chinese Yuan", "¥", 2), ("JPY", "Japanese Yen", "¥", 0),
    ("AED", "UAE Dirham", "د.إ", 2), ("SAR", "Saudi Riyal", "﷼", 2),
]


# ----------------------------------------------------------------------------- seeding
def seed_defaults(tenant):
    """Idempotent: company record, currency catalog (inactive until the tenant enables them)."""
    m.Company.objects.get_or_create(singleton=True, defaults={"legal_name": tenant.name})
    for code, name, symbol, decimals in DEFAULT_CURRENCIES:
        m.Currency.objects.get_or_create(code=code, defaults={"name": name, "symbol": symbol, "decimals": decimals, "is_active": False})


# ----------------------------------------------------------------------------- helpers
def _audit(action, actor, obj, request=None, **meta):
    record_tenant_event(current_tenant(), action, actor_user_id=actor, target_type=type(obj).__name__, target_id=getattr(obj, "pk", ""), metadata=meta, request=request)


def assert_active_member(user_id, field="user"):
    if user_id is None:
        return
    ok = TenantMembership.objects.filter(user_id=user_id, tenant=current_tenant(), status=TenantMembership.Status.ACTIVE).exists()
    if not ok:
        raise ValidationFailed(f"{field} must be an active member of this tenant.", code="not_an_active_member")


def _check_version(obj, expected):
    if expected is not None and obj.version != expected:
        raise DomainError("The record was modified by someone else; reload and retry.", code="version_conflict", status_code=409)


def _normalize_code(data):
    if "code" in data:
        data["code"] = (data["code"] or "").strip().upper()
        if not CODE_RE.match(data["code"]):
            raise ValidationFailed("Code must be 1-30 chars: A-Z, 0-9, '.', '_' or '-'.", code="invalid_code")


def _require_active(obj, label):
    if obj is not None and not obj.is_active:
        raise ValidationFailed(f"{label} is inactive.", code="inactive_reference")


# ----------------------------------------------------------------------------- generic resource engine
def _validate_department(data, existing):
    parent = data.get("parent")
    _require_active(parent, "Parent department")
    _require_active(data.get("business_unit"), "Business unit")
    _require_active(data.get("branch"), "Branch")
    assert_active_member(data.get("head_user_id"), "head_user_id")
    if parent is not None:
        depth, node, seen = 1, parent, set()
        while node is not None:
            if existing is not None and node.pk == existing.pk:
                raise ValidationFailed("A department cannot be moved under itself or its descendants.", code="department_cycle")
            if node.pk in seen:  # pre-existing corruption guard
                raise DomainError("Department hierarchy is corrupted.", code="department_cycle")
            seen.add(node.pk)
            node = node.parent
            depth += 1
        if depth > MAX_DEPARTMENT_DEPTH:
            raise ValidationFailed(f"Hierarchy deeper than {MAX_DEPARTMENT_DEPTH} levels.", code="department_too_deep")


def _validate_team(data, existing):
    _require_active(data.get("department"), "Department")
    assert_active_member(data.get("lead_user_id"), "lead_user_id")


def _validate_position(data, existing):
    _require_active(data.get("department"), "Department")


def _validate_cost_center(data, existing):
    _require_active(data.get("department"), "Department")
    _require_active(data.get("business_unit"), "Business unit")
    assert_active_member(data.get("manager_user_id"), "manager_user_id")


def _validate_business_unit(data, existing):
    assert_active_member(data.get("head_user_id"), "head_user_id")


def _validate_branch(data, existing):
    _require_active(data.get("legal_entity"), "Legal entity")


def _validate_legal_entity(data, existing):
    if data.get("country"):
        data["country"] = data["country"].upper()


def _deactivation_guard_department(dept):
    if dept.children.filter(is_active=True).exists():
        raise DomainError("Deactivate or move the child departments first.", code="has_active_children")
    if dept.teams.filter(is_active=True).exists() or dept.positions.filter(is_active=True).exists() or dept.cost_centers.filter(is_active=True).exists():
        raise DomainError("Department still owns active teams, positions or cost centers.", code="has_active_dependents")
    if dept.members.exists():
        raise DomainError("Department still has assigned members.", code="has_members")


def _deactivation_guard_team(team):
    if team.members.exists():
        raise DomainError("Team still has assigned members.", code="has_members")


def _deactivation_guard_position(position):
    if position.holders.exists():
        raise DomainError("Position is still held by members.", code="has_members")


def _deactivation_guard_branch(branch):
    pass


RESOURCES = {
    "department": {"model": m.Department, "validate": _validate_department, "deactivate_guard": _deactivation_guard_department},
    "team": {"model": m.Team, "validate": _validate_team, "deactivate_guard": _deactivation_guard_team},
    "position": {"model": m.Position, "validate": _validate_position, "deactivate_guard": _deactivation_guard_position},
    "cost_center": {"model": m.CostCenter, "validate": _validate_cost_center},
    "business_unit": {"model": m.BusinessUnit, "validate": _validate_business_unit},
    "branch": {"model": m.Branch, "validate": _validate_branch},
    "legal_entity": {"model": m.LegalEntity, "validate": _validate_legal_entity},
}


def create_resource(key, actor_user_id, data, request=None):
    spec = RESOURCES[key]
    data = dict(data)
    _normalize_code(data)
    spec["validate"](data, None)
    with transaction.atomic():
        if spec["model"].objects.filter(code=data["code"]).exists():
            raise DomainError("This code is already in use.", code="code_taken")
        obj = spec["model"].objects.create(**data)
        _audit(f"org.{key}.created", actor_user_id, obj, request, code=obj.code)
        _emit_department_change(key, obj, "created")
    return obj


def update_resource(key, actor_user_id, obj, data, request=None):
    spec = RESOURCES[key]
    data = dict(data)
    expected_version = data.pop("version", None)
    _normalize_code(data)
    with transaction.atomic():
        obj = spec["model"].objects.select_for_update().get(pk=obj.pk)
        _check_version(obj, expected_version)
        merged = {**{f: getattr(obj, f) for f in data}, **data}
        spec["validate"](merged, obj)
        if "code" in data and data["code"] != obj.code and spec["model"].objects.filter(code=data["code"]).exists():
            raise DomainError("This code is already in use.", code="code_taken")
        if data.get("is_active") is False and obj.is_active and "deactivate_guard" in spec:
            spec["deactivate_guard"](obj)
        for field, value in data.items():
            setattr(obj, field, value)
        obj.version += 1
        obj.save()
        _audit(f"org.{key}.updated", actor_user_id, obj, request, fields=sorted(data))
        _emit_department_change(key, obj, "updated")
    return obj


def _emit_department_change(key, obj, change):
    if key == "department":
        events.emit("org.department.changed", {"department_id": str(obj.pk), "change": change, "code": obj.code})


# ----------------------------------------------------------------------------- company
def get_company():
    return m.Company.objects.get(singleton=True)


@transaction.atomic
def update_company(actor_user_id, data, request=None):
    company = m.Company.objects.select_for_update().get(singleton=True)
    data = dict(data)
    _check_version(company, data.pop("version", None))
    if "base_currency" in data and data["base_currency"] is not None:
        new_base = data["base_currency"]
        if company.base_currency_id and new_base.pk != company.base_currency_id and m.ExchangeRate.objects.exists():
            raise DomainError("The base currency cannot change once exchange rates exist.", code="base_currency_locked")
        if not new_base.is_active:
            new_base.is_active = True
            new_base.save(update_fields=["is_active", "updated_at"])
    if "work_days" in data and (any(d not in range(1, 8) for d in data["work_days"]) or len(set(data["work_days"])) != len(data["work_days"])):
        raise ValidationFailed("work_days must be unique ISO weekdays 1-7.", code="invalid_work_days")
    for field, value in data.items():
        setattr(company, field, value)
    company.version += 1
    company.save()
    _audit("org.company.updated", actor_user_id, company, request, fields=sorted(data))
    return company


# ----------------------------------------------------------------------------- currencies and rates
@transaction.atomic
def set_currency_active(actor_user_id, currency, active, request=None):
    company = get_company()
    if not active and company.base_currency_id == currency.pk:
        raise DomainError("The base currency cannot be deactivated.", code="base_currency_locked")
    currency.is_active = active
    currency.version += 1
    currency.save(update_fields=["is_active", "version", "updated_at"])
    _audit("org.currency.activated" if active else "org.currency.deactivated", actor_user_id, currency, request, code=currency.code)
    return currency


@transaction.atomic
def set_exchange_rate(actor_user_id, currency, rate_date, rate, source="", request=None):
    company = get_company()
    if company.base_currency_id is None:
        raise DomainError("Set the company's base currency first.", code="base_currency_required")
    if currency.pk == company.base_currency_id:
        raise ValidationFailed("The base currency always has rate 1.", code="base_currency_rate")
    if not currency.is_active:
        raise ValidationFailed("Currency is not active.", code="inactive_reference")
    rate = Decimal(rate)
    if rate <= 0:
        raise ValidationFailed("Rate must be positive.", code="invalid_rate")
    if rate_date > timezone.now().date() + timedelta(days=1):
        raise ValidationFailed("Rate date cannot be in the future.", code="invalid_date")
    obj, created = m.ExchangeRate.objects.update_or_create(
        currency=currency, rate_date=rate_date, defaults={"rate": rate, "source": source, "created_by": actor_user_id}
    )
    _audit("org.exchange_rate.set", actor_user_id, obj, request, currency=currency.code, rate=str(rate), date=str(rate_date))
    return obj


def get_rate(currency_code, on_date):
    """Rate (base per 1 unit) effective on `on_date` = latest rate dated on or before it."""
    company = get_company()
    if company.base_currency_id is None:
        raise DomainError("Set the company's base currency first.", code="base_currency_required")
    if company.base_currency.code == currency_code:
        return Decimal(1)
    row = m.ExchangeRate.objects.filter(currency__code=currency_code, rate_date__lte=on_date).order_by("-rate_date").first()
    if row is None:
        raise DomainError(f"No exchange rate for {currency_code} on or before {on_date}.", code="rate_not_found", status_code=404)
    return row.rate


def convert_to_base(amount, currency_code, on_date):
    company = get_company()
    amount = Decimal(amount)
    quant = Decimal(1).scaleb(-company.base_currency.decimals)
    return (amount * get_rate(currency_code, on_date)).quantize(quant)


# ----------------------------------------------------------------------------- fiscal calendar
def _add_months(d, months):
    index = d.month - 1 + months
    year, month = d.year + index // 12, index % 12 + 1
    return date(year, month, min(d.day, calendar.monthrange(year, month)[1]))


@transaction.atomic
def create_fiscal_year(actor_user_id, name, start_date, request=None):
    if start_date.day != 1:
        raise ValidationFailed("A fiscal year must start on the first day of a month.", code="invalid_start")
    end_date = _add_months(start_date, 12) - timedelta(days=1)
    last = m.FiscalYear.objects.order_by("-end_date").first()
    if last is not None and start_date != last.end_date + timedelta(days=1):
        raise ValidationFailed(f"Fiscal years must be contiguous: the next one starts on {last.end_date + timedelta(days=1)}.", code="fiscal_year_gap")
    if m.FiscalYear.objects.filter(name=name).exists():
        raise DomainError("A fiscal year with this name already exists.", code="name_taken")
    year = m.FiscalYear.objects.create(name=name, start_date=start_date, end_date=end_date)
    for i in range(12):
        p_start = _add_months(start_date, i)
        p_end = _add_months(start_date, i + 1) - timedelta(days=1)
        m.FiscalPeriod.objects.create(fiscal_year=year, number=i + 1, name=f"{name}-P{i + 1:02d}", start_date=p_start, end_date=p_end)
    _audit("org.fiscal_year.created", actor_user_id, year, request, start=str(start_date))
    return year


def period_for(on_date):
    return m.FiscalPeriod.objects.filter(start_date__lte=on_date, end_date__gte=on_date).select_related("fiscal_year").first()


def assert_period_open(on_date):
    """Posting guard used by transactional modules (finance, inventory...)."""
    period = period_for(on_date)
    if period is None:
        raise DomainError(f"No fiscal period is defined for {on_date}.", code="no_fiscal_period")
    if period.status != m.FiscalPeriod.Status.OPEN:
        raise DomainError(f"Fiscal period {period.name} is closed.", code="period_closed")
    return period


# Modules append callables(period) that raise DomainError to veto a close (e.g. unposted journals).
PERIOD_CLOSE_CHECKS = []


@transaction.atomic
def close_period(actor_user_id, period, request=None):
    period = m.FiscalPeriod.objects.select_for_update().select_related("fiscal_year").get(pk=period.pk)
    if period.status == m.FiscalPeriod.Status.CLOSED:
        raise DomainError("Period is already closed.", code="invalid_state_transition")
    earlier_open = m.FiscalPeriod.objects.filter(start_date__lt=period.start_date, status=m.FiscalPeriod.Status.OPEN).exists()
    if earlier_open:
        raise DomainError("Close earlier periods first.", code="earlier_period_open")
    for check in PERIOD_CLOSE_CHECKS:
        check(period)
    period.status = m.FiscalPeriod.Status.CLOSED
    period.closed_at = timezone.now()
    period.closed_by = actor_user_id
    period.version += 1
    period.save(update_fields=["status", "closed_at", "closed_by", "version", "updated_at"])
    _audit("org.period.closed", actor_user_id, period, request, name=period.name)
    events.emit("org.period.closed", {"period_id": str(period.pk), "fiscal_year": period.fiscal_year.name, "number": period.number}, dedup_key=f"period-closed-{period.pk}-{period.version}")
    return period


@transaction.atomic
def reopen_period(actor_user_id, period, reason, request=None):
    if len((reason or "").strip()) < 10:
        raise ValidationFailed("A reason of at least 10 characters is required to reopen a period.", code="reason_required")
    period = m.FiscalPeriod.objects.select_for_update().select_related("fiscal_year").get(pk=period.pk)
    if period.status != m.FiscalPeriod.Status.CLOSED:
        raise DomainError("Period is not closed.", code="invalid_state_transition")
    if m.FiscalPeriod.objects.filter(start_date__gt=period.start_date, status=m.FiscalPeriod.Status.CLOSED).exists():
        raise DomainError("Only the latest closed period can be reopened.", code="later_period_closed")
    period.status = m.FiscalPeriod.Status.OPEN
    period.closed_at = None
    period.closed_by = None
    period.version += 1
    period.save(update_fields=["status", "closed_at", "closed_by", "version", "updated_at"])
    _audit("org.period.reopened", actor_user_id, period, request, name=period.name, reason=reason.strip())
    events.emit("org.period.reopened", {"period_id": str(period.pk), "fiscal_year": period.fiscal_year.name, "number": period.number}, dedup_key=f"period-reopened-{period.pk}-{period.version}")
    return period


# ----------------------------------------------------------------------------- calendar
def work_days(company=None):
    company = company or get_company()
    return company.work_days or [1, 2, 3, 4, 5]


def is_business_day(on_date, branch=None):
    if on_date.isoweekday() not in work_days():
        return False
    holidays = m.Holiday.objects.filter(holiday_date=on_date)
    return not (holidays.filter(branch__isnull=True).exists() or (branch is not None and holidays.filter(branch=branch).exists()))


def add_business_days(start, days, branch=None):
    current, remaining = start, days
    step = 1 if days >= 0 else -1
    while remaining != 0:
        current += timedelta(days=step)
        if is_business_day(current, branch):
            remaining -= step
    return current


@transaction.atomic
def add_holiday(actor_user_id, holiday_date, name, branch=None, request=None):
    if m.Holiday.objects.filter(holiday_date=holiday_date, branch=branch).exists():
        raise DomainError("A holiday already exists on this date.", code="holiday_exists")
    obj = m.Holiday.objects.create(holiday_date=holiday_date, name=name, branch=branch)
    _audit("org.holiday.created", actor_user_id, obj, request, date=str(holiday_date))
    return obj


# ----------------------------------------------------------------------------- member profiles
@transaction.atomic
def assign_profile(actor_user_id, user_id, data, request=None):
    assert_active_member(user_id, "user")
    data = dict(data)
    if "manager_user_id" in data and data["manager_user_id"] is not None:
        assert_active_member(data["manager_user_id"], "manager_user_id")
        if data["manager_user_id"] == user_id:
            raise ValidationFailed("A member cannot be their own manager.", code="self_manager")
        _assert_no_management_cycle(user_id, data["manager_user_id"])
    for field, label in (("department", "Department"), ("team", "Team"), ("position", "Position"), ("business_unit", "Business unit"), ("cost_center", "Cost center")):
        _require_active(data.get(field), label)
    team = data.get("team")
    department = data.get("department")
    if team is not None and department is not None and team.department_id != department.pk:
        raise ValidationFailed("The team does not belong to the department.", code="team_department_mismatch")
    profile, _ = m.TenantUserProfile.objects.select_for_update().get_or_create(user_id=user_id)
    for field, value in data.items():
        setattr(profile, field, value)
    profile.save()
    _audit("org.profile.updated", actor_user_id, profile, request, user_id=str(user_id), fields=sorted(data))
    return profile


def _assert_no_management_cycle(user_id, manager_id):
    seen, current = {user_id}, manager_id
    while current is not None:
        if current in seen:
            raise ValidationFailed("This would create a management cycle.", code="management_cycle")
        seen.add(current)
        current = m.TenantUserProfile.objects.filter(user_id=current).values_list("manager_user_id", flat=True).first()


# ----------------------------------------------------------------------------- tenant settings
def _is_bool(v):
    return isinstance(v, bool)


def _is_int_range(lo, hi):
    return lambda v: isinstance(v, int) and not isinstance(v, bool) and lo <= v <= hi


SETTINGS_SCHEMA = {
    "locale.timezone": (lambda v: isinstance(v, str) and 1 <= len(v) <= 64, "UTC"),
    "locale.date_format": (lambda v: v in ("YYYY-MM-DD", "DD/MM/YYYY", "MM/DD/YYYY"), "YYYY-MM-DD"),
    "notifications.email_enabled": (_is_bool, True),
    "workflow.default_due_hours": (_is_int_range(1, 24 * 30), 72),
}


def get_setting(key, default=None):
    row = m.TenantSetting.objects.filter(key=key).first()
    if row is not None:
        return row.value
    return SETTINGS_SCHEMA[key][1] if key in SETTINGS_SCHEMA else default


def all_settings():
    stored = {s.key: s.value for s in m.TenantSetting.objects.all()}
    return {key: stored.get(key, default) for key, (_, default) in SETTINGS_SCHEMA.items()}


@transaction.atomic
def update_settings(actor_user_id, values, request=None):
    for key, value in values.items():
        if key not in SETTINGS_SCHEMA:
            raise ValidationFailed(f"Unknown setting '{key}'.", code="unknown_setting")
        if not SETTINGS_SCHEMA[key][0](value):
            raise ValidationFailed(f"Invalid value for '{key}'.", code="invalid_setting")
    for key, value in values.items():
        m.TenantSetting.objects.update_or_create(key=key, defaults={"value": value, "updated_by": actor_user_id})
    record_tenant_event(current_tenant(), "org.settings.updated", actor_user_id=actor_user_id, target_type="TenantSetting", metadata={"keys": sorted(values)}, request=request)
    return all_settings()
