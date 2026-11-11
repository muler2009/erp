import uuid

from django.db import models
from django.db.models import F, Q
from django.utils import timezone

MONEY = dict(max_digits=20, decimal_places=4)
QTY = dict(max_digits=18, decimal_places=4)

STATUSES = ("PLANNING", "ACTIVE", "ON_HOLD", "COMPLETED", "CANCELLED")
TASK_STATUSES = ("TODO", "IN_PROGRESS", "BLOCKED", "DONE", "CANCELLED")
BILLING = ("FIXED", "TIME_MATERIAL", "NON_BILLABLE")
MEMBER_ROLES = ("MANAGER", "MEMBER", "OBSERVER")
DEP_TYPES = ("FS", "SS")


class Base(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    created_at = models.DateTimeField(default=timezone.now, db_index=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        abstract = True


class Project(Base):
    code = models.CharField(max_length=30, unique=True)
    name = models.CharField(max_length=200)
    description = models.TextField(blank=True)
    status = models.CharField(max_length=10, default="PLANNING", db_index=True)
    billing_type = models.CharField(max_length=14, default="FIXED")
    contract_value = models.DecimalField(default=0, **MONEY)
    customer_id = models.UUIDField(null=True, blank=True)  # finance partner
    manager_id = models.UUIDField(db_index=True)  # user
    department_id = models.UUIDField(null=True, blank=True)
    cost_center_id = models.UUIDField(null=True, blank=True)
    priority = models.CharField(max_length=8, default="MEDIUM")
    start_on = models.DateField()
    end_on = models.DateField()
    actual_start = models.DateField(null=True, blank=True)
    actual_end = models.DateField(null=True, blank=True)
    closed_reason = models.CharField(max_length=300, blank=True)
    last_reminder_on = models.DateField(null=True, blank=True)
    version = models.PositiveIntegerField(default=1)
    created_by = models.UUIDField(null=True, blank=True)

    class Meta:
        constraints = [
            models.CheckConstraint(condition=Q(end_on__gte=F("start_on")), name="prj_dates_ordered"),
            models.CheckConstraint(condition=Q(contract_value__gte=0), name="prj_contract_non_negative"),
        ]


class ProjectMember(Base):
    project = models.ForeignKey(Project, on_delete=models.CASCADE, related_name="members")
    user_id = models.UUIDField(db_index=True)
    employee_id = models.UUIDField(null=True, blank=True)
    role = models.CharField(max_length=10, default="MEMBER")
    cost_rate = models.DecimalField(default=0, **MONEY)  # per hour, base currency
    bill_rate = models.DecimalField(default=0, **MONEY)
    allocation_percent = models.DecimalField(max_digits=5, decimal_places=2, default=100)
    is_active = models.BooleanField(default=True)

    class Meta:
        constraints = [
            models.UniqueConstraint(fields=["project", "user_id"], condition=Q(is_active=True), name="prj_one_active_membership"),
            models.CheckConstraint(condition=Q(allocation_percent__gt=0, allocation_percent__lte=100, cost_rate__gte=0, bill_rate__gte=0), name="prj_member_ranges"),
        ]


class Task(Base):
    project = models.ForeignKey(Project, on_delete=models.CASCADE, related_name="tasks")
    parent = models.ForeignKey("self", null=True, blank=True, on_delete=models.PROTECT, related_name="children")
    wbs_code = models.CharField(max_length=40)
    sort_order = models.PositiveIntegerField(default=0)
    name = models.CharField(max_length=200)
    description = models.TextField(blank=True)
    is_milestone = models.BooleanField(default=False)
    status = models.CharField(max_length=12, default="TODO", db_index=True)
    assignee_id = models.UUIDField(null=True, blank=True)
    planned_start = models.DateField()
    planned_end = models.DateField()
    planned_hours = models.DecimalField(default=0, **QTY)
    percent_complete = models.DecimalField(max_digits=5, decimal_places=2, default=0)
    actual_start = models.DateField(null=True, blank=True)
    actual_end = models.DateField(null=True, blank=True)
    last_reminder_on = models.DateField(null=True, blank=True)

    class Meta:
        ordering = ["sort_order", "created_at"]
        constraints = [
            models.UniqueConstraint(fields=["project", "wbs_code"], name="prj_wbs_unique"),
            models.CheckConstraint(condition=Q(planned_end__gte=F("planned_start")), name="prj_task_dates_ordered"),
            models.CheckConstraint(condition=Q(percent_complete__gte=0, percent_complete__lte=100, planned_hours__gte=0), name="prj_task_ranges"),
        ]


class TaskDependency(Base):
    predecessor = models.ForeignKey(Task, on_delete=models.CASCADE, related_name="successor_links")
    successor = models.ForeignKey(Task, on_delete=models.CASCADE, related_name="predecessor_links")
    kind = models.CharField(max_length=2, default="FS")  # FS finish-to-start, SS start-to-start
    lag_days = models.IntegerField(default=0)

    class Meta:
        constraints = [
            models.UniqueConstraint(fields=["predecessor", "successor"], name="prj_dependency_uniq"),
            models.CheckConstraint(condition=~Q(predecessor=F("successor")), name="prj_dependency_not_self"),
        ]


# ----------------------------------------------------------------------------- budgets and expenses (P-B)
COST_CATEGORIES = ("LABOR", "MATERIAL", "EQUIPMENT", "SUBCONTRACT", "TRAVEL", "OTHER")


class ProjectBudget(Base):
    project = models.ForeignKey(Project, on_delete=models.CASCADE, related_name="budgets")
    revision = models.PositiveIntegerField(default=1)
    status = models.CharField(max_length=10, default="DRAFT", db_index=True)  # DRAFT / SUBMITTED / APPROVED / REJECTED / SUPERSEDED
    reason = models.CharField(max_length=300, blank=True)
    submitted_by = models.UUIDField(null=True, blank=True)
    decided_by = models.UUIDField(null=True, blank=True)
    decision_note = models.CharField(max_length=300, blank=True)

    class Meta:
        constraints = [
            models.UniqueConstraint(fields=["project", "revision"], name="prj_budget_revision_uniq"),
            models.UniqueConstraint(fields=["project"], condition=Q(status="APPROVED"), name="prj_one_approved_budget"),
        ]


class BudgetLine(Base):
    budget = models.ForeignKey(ProjectBudget, on_delete=models.CASCADE, related_name="lines")
    category = models.CharField(max_length=12)
    description = models.CharField(max_length=200, blank=True)
    amount = models.DecimalField(**MONEY)

    class Meta:
        constraints = [models.CheckConstraint(condition=Q(amount__gt=0), name="prj_budget_line_positive")]


class ProjectExpense(Base):
    project = models.ForeignKey(Project, on_delete=models.PROTECT, related_name="expenses")
    task = models.ForeignKey(Task, null=True, blank=True, on_delete=models.PROTECT, related_name="expenses")
    category = models.CharField(max_length=12)
    description = models.CharField(max_length=300)
    amount = models.DecimalField(**MONEY)  # base currency
    incurred_on = models.DateField()
    claimant_id = models.UUIDField()
    invoice_id = models.UUIDField(null=True, blank=True)  # an already-booked supplier invoice this cost is allocated from
    status = models.CharField(max_length=10, default="DRAFT", db_index=True)  # DRAFT / SUBMITTED / APPROVED / REJECTED
    decided_by = models.UUIDField(null=True, blank=True)
    decision_note = models.CharField(max_length=300, blank=True)
    journal_entry_id = models.UUIDField(null=True, blank=True)

    class Meta:
        constraints = [models.CheckConstraint(condition=Q(amount__gt=0), name="prj_expense_positive")]


# ----------------------------------------------------------------------------- risks, issues and billing (P-C)
class Risk(Base):
    project = models.ForeignKey(Project, on_delete=models.CASCADE, related_name="risks")
    title = models.CharField(max_length=200)
    description = models.TextField(blank=True)
    category = models.CharField(max_length=60, blank=True)
    probability = models.PositiveSmallIntegerField()  # 1..5
    impact = models.PositiveSmallIntegerField()  # 1..5
    status = models.CharField(max_length=12, default="OPEN", db_index=True)  # OPEN / MITIGATING / OCCURRED / CLOSED
    owner_id = models.UUIDField(null=True, blank=True)
    mitigation = models.TextField(blank=True)
    review_on = models.DateField(null=True, blank=True)
    closed_note = models.CharField(max_length=300, blank=True)
    raised_by = models.UUIDField()
    last_reminder_on = models.DateField(null=True, blank=True)

    @property
    def score(self):
        return self.probability * self.impact

    class Meta:
        constraints = [models.CheckConstraint(condition=Q(probability__gte=1, probability__lte=5, impact__gte=1, impact__lte=5), name="prj_risk_scale")]


class Issue(Base):
    project = models.ForeignKey(Project, on_delete=models.CASCADE, related_name="issues")
    task = models.ForeignKey(Task, null=True, blank=True, on_delete=models.SET_NULL, related_name="issues")
    risk = models.ForeignKey(Risk, null=True, blank=True, on_delete=models.SET_NULL, related_name="issues")
    title = models.CharField(max_length=200)
    description = models.TextField(blank=True)
    severity = models.CharField(max_length=8, default="MEDIUM")  # LOW / MEDIUM / HIGH / CRITICAL
    status = models.CharField(max_length=12, default="OPEN", db_index=True)  # OPEN / IN_PROGRESS / RESOLVED / CLOSED
    assigned_to = models.UUIDField(null=True, blank=True)
    due_on = models.DateField(null=True, blank=True)
    resolution = models.TextField(blank=True)
    raised_by = models.UUIDField()
    resolved_by = models.UUIDField(null=True, blank=True)
    last_reminder_on = models.DateField(null=True, blank=True)


class ProjectBilling(Base):
    project = models.ForeignKey(Project, on_delete=models.PROTECT, related_name="billings")
    invoice_id = models.UUIDField(unique=True)  # customer invoice drafted in Finance
    kind = models.CharField(max_length=10)  # MILESTONE / TIME / ADVANCE
    amount = models.DecimalField(**MONEY)  # before tax, base currency
    description = models.CharField(max_length=300, blank=True)
    task = models.ForeignKey(Task, null=True, blank=True, on_delete=models.PROTECT, related_name="billings")
    period_start = models.DateField(null=True, blank=True)
    period_end = models.DateField(null=True, blank=True)
    created_by = models.UUIDField()

    class Meta:
        constraints = [models.CheckConstraint(condition=Q(amount__gt=0), name="prj_billing_positive")]
