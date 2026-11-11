"""Business intelligence: KPI definitions and their history, dashboards, saved reports, schedules and the run log."""
import uuid

from django.db import models
from django.db.models import Q
from django.utils import timezone

VALUE = dict(max_digits=24, decimal_places=4)


class Base(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    created_at = models.DateTimeField(default=timezone.now, db_index=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        abstract = True


class Kpi(Base):
    code = models.CharField(max_length=40, unique=True)
    name = models.CharField(max_length=150)
    description = models.CharField(max_length=300, blank=True)
    metric = models.CharField(max_length=60)  # a registered metric code
    params = models.JSONField(default=dict, blank=True)
    unit = models.CharField(max_length=20, blank=True)
    direction = models.CharField(max_length=6, default="HIGHER")  # HIGHER is better | LOWER is better
    target = models.DecimalField(null=True, blank=True, **VALUE)
    warn_at = models.DecimalField(null=True, blank=True, **VALUE)
    critical_at = models.DecimalField(null=True, blank=True, **VALUE)
    owner_id = models.UUIDField(null=True, blank=True)
    is_active = models.BooleanField(default=True)
    is_system = models.BooleanField(default=False)
    created_by = models.UUIDField(null=True, blank=True)


class KpiSnapshot(Base):
    """One value per KPI per day. Recomputing the same day replaces the value; earlier days are never touched."""
    kpi = models.ForeignKey(Kpi, on_delete=models.CASCADE, related_name="snapshots")
    as_of = models.DateField()
    value = models.DecimalField(null=True, blank=True, **VALUE)
    status = models.CharField(max_length=10)  # GOOD WARN CRITICAL NO_TARGET NO_DATA

    class Meta:
        constraints = [models.UniqueConstraint(fields=["kpi", "as_of"], name="an_snapshot_once_a_day")]
        indexes = [models.Index(fields=["kpi", "-as_of"], name="an_snapshot_kpi_idx")]


class Dashboard(Base):
    code = models.CharField(max_length=40, unique=True)
    name = models.CharField(max_length=150)
    description = models.CharField(max_length=300, blank=True)
    visibility = models.CharField(max_length=8, default="PRIVATE")  # PRIVATE ALL ROLES
    roles = models.JSONField(default=list, blank=True)  # role names, when visibility is ROLES
    owner_id = models.UUIDField(null=True, blank=True)
    is_system = models.BooleanField(default=False)
    is_active = models.BooleanField(default=True)
    position = models.PositiveSmallIntegerField(default=100)


class Widget(Base):
    dashboard = models.ForeignKey(Dashboard, on_delete=models.CASCADE, related_name="widgets")
    position = models.PositiveSmallIntegerField(default=1)
    kind = models.CharField(max_length=10)  # KPI TREND DATASET
    title = models.CharField(max_length=150, blank=True)
    config = models.JSONField(default=dict)


class SavedReport(Base):
    name = models.CharField(max_length=150)
    description = models.CharField(max_length=300, blank=True)
    dataset = models.CharField(max_length=80)
    params = models.JSONField(default=dict, blank=True)  # may hold a relative "period" such as LAST_MONTH so scheduled runs never go stale
    columns = models.JSONField(default=list, blank=True)
    filters = models.JSONField(default=list, blank=True)  # [{"column", "op", "value"}]
    sort = models.JSONField(default=list, blank=True)  # [{"column", "desc"}]
    owner_id = models.UUIDField(db_index=True)
    shared = models.BooleanField(default=False)
    is_active = models.BooleanField(default=True)

    class Meta:
        constraints = [models.UniqueConstraint(fields=["owner_id", "name"], condition=Q(is_active=True), name="an_report_name_per_owner")]


class Schedule(Base):
    report = models.ForeignKey(SavedReport, on_delete=models.PROTECT, related_name="schedules")
    frequency = models.CharField(max_length=8)  # DAILY WEEKLY MONTHLY
    weekday = models.PositiveSmallIntegerField(null=True, blank=True)  # 0 Monday .. 6 Sunday
    day_of_month = models.PositiveSmallIntegerField(null=True, blank=True)  # 1 .. 28
    fmt = models.CharField(max_length=4, default="XLSX")  # CSV XLSX PDF
    recipients = models.JSONField(default=list)  # user ids
    next_run_on = models.DateField(db_index=True)
    last_run_on = models.DateField(null=True, blank=True)
    last_status = models.CharField(max_length=10, blank=True)
    last_error = models.CharField(max_length=300, blank=True)
    owner_id = models.UUIDField(db_index=True)
    is_active = models.BooleanField(default=True)


class ReportRun(Base):
    """What was produced, for whom and when. Append-only."""
    report = models.ForeignKey(SavedReport, null=True, blank=True, on_delete=models.SET_NULL, related_name="runs")
    schedule = models.ForeignKey(Schedule, null=True, blank=True, on_delete=models.SET_NULL, related_name="runs")
    run_date = models.DateField(null=True, blank=True)
    dataset = models.CharField(max_length=80)
    params = models.JSONField(default=dict, blank=True)
    fmt = models.CharField(max_length=4)
    requested_by = models.UUIDField()
    row_count = models.PositiveIntegerField(default=0)
    file_id = models.UUIDField(null=True, blank=True)
    status = models.CharField(max_length=10, default="OK")  # OK FAILED
    error = models.CharField(max_length=300, blank=True)
    delivered_to = models.JSONField(default=list)

    class Meta:
        constraints = [models.UniqueConstraint(fields=["schedule", "run_date"], condition=Q(schedule__isnull=False), name="an_one_run_per_schedule_day")]
