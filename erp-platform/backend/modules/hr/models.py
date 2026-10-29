"""Human resources and payroll (module 3). Money is Decimal; payslips are immutable once the run is approved."""
import uuid

from django.db import models
from django.db.models import F, Q
from django.utils import timezone

MONEY = dict(max_digits=20, decimal_places=4)
DAYS = dict(max_digits=7, decimal_places=2)


class Base(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    created_at = models.DateTimeField(default=timezone.now, db_index=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        abstract = True


class Employee(Base):
    class Status(models.TextChoices):
        ONBOARDING = "ONBOARDING"
        ACTIVE = "ACTIVE"
        OFFBOARDING = "OFFBOARDING"
        TERMINATED = "TERMINATED"

    class EmploymentType(models.TextChoices):
        FULL_TIME = "FULL_TIME"
        PART_TIME = "PART_TIME"
        CONTRACTOR = "CONTRACTOR"
        INTERN = "INTERN"

    class ProbationStatus(models.TextChoices):
        NONE = "NONE"
        IN_PROGRESS = "IN_PROGRESS"
        CONFIRMED = "CONFIRMED"
        EXTENDED = "EXTENDED"
        FAILED = "FAILED"

    employee_no = models.CharField(max_length=30, unique=True)
    user_id = models.UUIDField(null=True, blank=True, unique=True)  # the login this person uses (self-service)
    first_name = models.CharField(max_length=80)
    last_name = models.CharField(max_length=80)
    email = models.CharField(max_length=200, blank=True)
    phone = models.CharField(max_length=40, blank=True)
    status = models.CharField(max_length=12, choices=Status.choices, default=Status.ONBOARDING, db_index=True)
    hire_date = models.DateField()
    termination_date = models.DateField(null=True, blank=True)
    termination_reason = models.CharField(max_length=300, blank=True)
    department = models.ForeignKey("organizations.Department", null=True, blank=True, on_delete=models.PROTECT, related_name="+")
    position = models.ForeignKey("organizations.Position", null=True, blank=True, on_delete=models.PROTECT, related_name="+")
    manager = models.ForeignKey("self", null=True, blank=True, on_delete=models.PROTECT, related_name="reports")
    bank_account = models.CharField(max_length=60, blank=True)
    tax_id = models.CharField(max_length=40, blank=True)
    address = models.CharField(max_length=300, blank=True)
    date_of_birth = models.DateField(null=True, blank=True)
    employment_type = models.CharField(max_length=12, choices=EmploymentType.choices, default=EmploymentType.FULL_TIME)
    grade = models.ForeignKey("JobGrade", null=True, blank=True, on_delete=models.PROTECT, related_name="+")
    probation_end = models.DateField(null=True, blank=True)
    probation_status = models.CharField(max_length=12, choices=ProbationStatus.choices, default=ProbationStatus.NONE)
    separation_type = models.CharField(max_length=14, blank=True)

    class Meta:
        constraints = [
            models.CheckConstraint(condition=Q(termination_date__isnull=True) | Q(termination_date__gte=F("hire_date")), name="employee_term_after_hire"),
            models.CheckConstraint(condition=~Q(manager=F("id")), name="employee_not_own_manager"),
        ]

    @property
    def name(self):
        return f"{self.first_name} {self.last_name}".strip()


class Contract(Base):
    class Kind(models.TextChoices):
        PERMANENT = "PERMANENT"
        FIXED_TERM = "FIXED_TERM"
        CASUAL = "CASUAL"

    employee = models.ForeignKey(Employee, on_delete=models.PROTECT, related_name="contracts")
    kind = models.CharField(max_length=10, choices=Kind.choices, default=Kind.PERMANENT)
    start_date = models.DateField()
    end_date = models.DateField(null=True, blank=True)
    monthly_salary = models.DecimalField(**MONEY)
    currency = models.CharField(max_length=3)
    created_by = models.UUIDField(null=True, blank=True)

    class Meta:
        constraints = [
            models.CheckConstraint(condition=Q(end_date__isnull=True) | Q(end_date__gte=F("start_date")), name="contract_dates_ordered"),
            models.CheckConstraint(condition=Q(monthly_salary__gte=0), name="contract_salary_non_negative"),
        ]


class ChecklistItem(Base):
    class Kind(models.TextChoices):
        ONBOARDING = "ONBOARDING"
        OFFBOARDING = "OFFBOARDING"

    employee = models.ForeignKey(Employee, on_delete=models.CASCADE, related_name="checklist")
    kind = models.CharField(max_length=12, choices=Kind.choices)
    title = models.CharField(max_length=200)
    assignee_role = models.CharField(max_length=10, default="HR")  # HR / IT / MANAGER / EMPLOYEE / FINANCE
    due_date = models.DateField(null=True, blank=True)
    done_at = models.DateTimeField(null=True, blank=True)
    done_by = models.UUIDField(null=True, blank=True)


class Attendance(Base):
    employee = models.ForeignKey(Employee, on_delete=models.PROTECT, related_name="attendance")
    work_date = models.DateField()
    check_in = models.DateTimeField()
    check_out = models.DateTimeField(null=True, blank=True)
    work_mode = models.CharField(max_length=8, default="OFFICE")  # OFFICE / REMOTE / FIELD / TRAVEL
    source = models.CharField(max_length=10, default="CLOCK")  # CLOCK / MANUAL / DEVICE / CORRECTION

    class Meta:
        constraints = [
            models.UniqueConstraint(fields=["employee", "work_date"], name="one_attendance_per_day"),
            models.CheckConstraint(condition=Q(check_out__isnull=True) | Q(check_out__gt=F("check_in")), name="attendance_out_after_in"),
        ]

    @property
    def hours(self):
        from decimal import Decimal

        return None if self.check_out is None else (Decimal((self.check_out - self.check_in).total_seconds()) / 3600).quantize(Decimal("0.01"))


class LeaveType(Base):
    class Grant(models.TextChoices):
        ACCRUAL = "ACCRUAL"  # annual_days earned month by month
        UPFRONT = "UPFRONT"  # annual_days granted at the start of the year (prorated in the hire year)
        MANUAL = "MANUAL"  # granted by HR per case (maternity, paternity, compassionate...)

    code = models.CharField(max_length=20, unique=True)
    name = models.CharField(max_length=80)
    is_paid = models.BooleanField(default=True)
    annual_days = models.DecimalField(default=0, **DAYS)
    grant_mode = models.CharField(max_length=8, choices=Grant.choices, default=Grant.MANUAL)
    eligibility_months = models.PositiveSmallIntegerField(default=0)  # minimum length of service
    eligible_employment_types = models.JSONField(default=list)  # empty = every type
    max_carryover_days = models.DecimalField(default=0, **DAYS)
    carryover_expiry_months = models.PositiveSmallIntegerField(default=0)  # 0 = carried days never expire
    allow_half_day = models.BooleanField(default=False)
    max_consecutive_days = models.PositiveSmallIntegerField(default=0)  # 0 = no limit
    min_notice_days = models.PositiveSmallIntegerField(default=0)
    is_active = models.BooleanField(default=True)


class LeaveAllocation(Base):
    """An entitlement entry: manual grant, monthly/annual accrual, or carry-over (with optional expiry)."""

    class Kind(models.TextChoices):
        MANUAL = "MANUAL"
        ACCRUAL = "ACCRUAL"
        CARRYOVER = "CARRYOVER"

    employee = models.ForeignKey(Employee, on_delete=models.PROTECT, related_name="leave_allocations")
    leave_type = models.ForeignKey(LeaveType, on_delete=models.PROTECT, related_name="+")
    year = models.PositiveSmallIntegerField()
    kind = models.CharField(max_length=10, choices=Kind.choices, default=Kind.MANUAL)
    period = models.CharField(max_length=7, blank=True)  # YYYY-MM for monthly accruals, YYYY for upfront
    days = models.DecimalField(**DAYS)
    expires_on = models.DateField(null=True, blank=True)

    class Meta:
        constraints = [models.UniqueConstraint(fields=["employee", "leave_type", "year", "kind", "period"], name="one_allocation_entry"), models.CheckConstraint(condition=Q(days__gte=0), name="allocation_non_negative")]


class LeaveDelegation(Base):
    """A manager hands leave/time approvals to a colleague for a period (e.g. while on leave)."""

    delegator_id = models.UUIDField(db_index=True)
    delegate_id = models.UUIDField(db_index=True)
    start_date = models.DateField()
    end_date = models.DateField()
    revoked_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        constraints = [models.CheckConstraint(condition=Q(end_date__gte=F("start_date")), name="delegation_dates_ordered"), models.CheckConstraint(condition=~Q(delegator_id=F("delegate_id")), name="delegation_not_self")]


class LeaveRequest(Base):
    class Status(models.TextChoices):
        PENDING = "PENDING"
        APPROVED = "APPROVED"
        REJECTED = "REJECTED"
        CANCELLED = "CANCELLED"

    employee = models.ForeignKey(Employee, on_delete=models.PROTECT, related_name="leave_requests")
    leave_type = models.ForeignKey(LeaveType, on_delete=models.PROTECT, related_name="+")
    start_date = models.DateField()
    end_date = models.DateField()
    days = models.DecimalField(**DAYS)  # business days, fixed at request time (0.5 for a half day)
    half_day = models.CharField(max_length=2, blank=True)  # "" / AM / PM
    reason = models.CharField(max_length=300, blank=True)
    status = models.CharField(max_length=10, choices=Status.choices, default=Status.PENDING, db_index=True)
    decided_by = models.UUIDField(null=True, blank=True)
    decision_note = models.CharField(max_length=300, blank=True)
    workflow_instance_id = models.UUIDField(null=True, blank=True)

    class Meta:
        constraints = [models.CheckConstraint(condition=Q(end_date__gte=F("start_date")), name="leave_dates_ordered"), models.CheckConstraint(condition=Q(days__gt=0), name="leave_days_positive")]


class Timesheet(Base):
    class Status(models.TextChoices):
        DRAFT = "DRAFT"
        SUBMITTED = "SUBMITTED"
        APPROVED = "APPROVED"
        REJECTED = "REJECTED"

    employee = models.ForeignKey(Employee, on_delete=models.PROTECT, related_name="timesheets")
    week_start = models.DateField()  # always a Monday
    status = models.CharField(max_length=10, choices=Status.choices, default=Status.DRAFT, db_index=True)
    decided_by = models.UUIDField(null=True, blank=True)
    decision_note = models.CharField(max_length=300, blank=True)

    class Meta:
        constraints = [models.UniqueConstraint(fields=["employee", "week_start"], name="one_timesheet_per_week")]


class TimesheetEntry(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    timesheet = models.ForeignKey(Timesheet, on_delete=models.CASCADE, related_name="entries")
    work_date = models.DateField()
    hours = models.DecimalField(max_digits=5, decimal_places=2)
    project_ref = models.CharField(max_length=60, blank=True)  # the projects module (Phase 7) will own real projects
    description = models.CharField(max_length=200, blank=True)

    class Meta:
        constraints = [models.CheckConstraint(condition=Q(hours__gt=0, hours__lte=24), name="entry_hours_range")]


# ----------------------------------------------------------------------------- payroll rules
class PayComponent(Base):
    """Configurable allowance or deduction. PERCENT_OF_BASIC uses the prorated basic salary of the period."""

    class Kind(models.TextChoices):
        ALLOWANCE = "ALLOWANCE"
        DEDUCTION = "DEDUCTION"

    class Calc(models.TextChoices):
        FIXED = "FIXED"
        PERCENT_OF_BASIC = "PERCENT_OF_BASIC"

    code = models.CharField(max_length=20, unique=True)
    name = models.CharField(max_length=80)
    kind = models.CharField(max_length=10, choices=Kind.choices)
    calc = models.CharField(max_length=16, choices=Calc.choices)
    value = models.DecimalField(**MONEY)  # amount (base currency) or percent
    taxable = models.BooleanField(default=True)  # ALLOWANCE: counts as taxable income. DEDUCTION: ignored (always taken after tax)
    is_active = models.BooleanField(default=True)

    class Meta:
        constraints = [models.CheckConstraint(condition=Q(value__gte=0), name="component_value_non_negative")]


class EmployeeComponent(Base):
    employee = models.ForeignKey(Employee, on_delete=models.CASCADE, related_name="components")
    component = models.ForeignKey(PayComponent, on_delete=models.PROTECT, related_name="+")
    override_value = models.DecimalField(null=True, blank=True, **MONEY)
    start_date = models.DateField()
    end_date = models.DateField(null=True, blank=True)


class TaxBracket(Base):
    """Progressive monthly income-tax table of the tenant's jurisdiction: `rate`% on the slice above
    `lower_bound` (until the next bracket). Nothing is seeded: statutory rules are the tenant's to configure."""

    lower_bound = models.DecimalField(unique=True, **MONEY)
    rate = models.DecimalField(max_digits=6, decimal_places=3)

    class Meta:
        ordering = ["lower_bound"]
        constraints = [models.CheckConstraint(condition=Q(rate__gte=0, rate__lte=100), name="bracket_rate_range")]


class PayrollRun(Base):
    class Status(models.TextChoices):
        DRAFT = "DRAFT"
        PENDING_APPROVAL = "PENDING_APPROVAL"
        APPROVED = "APPROVED"
        POSTED = "POSTED"
        PAID = "PAID"
        CANCELLED = "CANCELLED"

    number = models.CharField(max_length=30, unique=True)
    period_start = models.DateField()
    period_end = models.DateField()
    status = models.CharField(max_length=17, choices=Status.choices, default=Status.DRAFT, db_index=True)
    gross_total = models.DecimalField(default=0, **MONEY)
    tax_total = models.DecimalField(default=0, **MONEY)
    pension_employee_total = models.DecimalField(default=0, **MONEY)
    pension_employer_total = models.DecimalField(default=0, **MONEY)
    deduction_total = models.DecimalField(default=0, **MONEY)
    net_total = models.DecimalField(default=0, **MONEY)
    rules_snapshot = models.JSONField(default=dict)  # tax table and rates used, for reproducibility
    created_by = models.UUIDField()
    approved_by = models.UUIDField(null=True, blank=True)
    posted_by = models.UUIDField(null=True, blank=True)
    paid_by = models.UUIDField(null=True, blank=True)
    workflow_instance_id = models.UUIDField(null=True, blank=True)
    journal_id = models.UUIDField(null=True, blank=True)
    payment_journal_id = models.UUIDField(null=True, blank=True)
    reversal_journal_id = models.UUIDField(null=True, blank=True)
    version = models.PositiveIntegerField(default=1)

    class Meta:
        constraints = [
            models.CheckConstraint(condition=Q(period_end__gte=F("period_start")), name="payroll_period_ordered"),
            models.UniqueConstraint(fields=["period_start", "period_end"], condition=~Q(status="CANCELLED"), name="one_live_run_per_period"),
        ]


class Payslip(Base):
    run = models.ForeignKey(PayrollRun, on_delete=models.PROTECT, related_name="payslips")
    employee = models.ForeignKey(Employee, on_delete=models.PROTECT, related_name="payslips")
    working_days = models.DecimalField(**DAYS)
    payable_days = models.DecimalField(**DAYS)
    unpaid_leave_days = models.DecimalField(default=0, **DAYS)
    basic = models.DecimalField(**MONEY)
    allowances = models.DecimalField(default=0, **MONEY)
    overtime_pay = models.DecimalField(default=0, **MONEY)
    other_earnings = models.DecimalField(default=0, **MONEY)  # bonuses, commissions, arrears, positive adjustments
    gross = models.DecimalField(**MONEY)
    taxable_income = models.DecimalField(**MONEY)
    income_tax = models.DecimalField(default=0, **MONEY)
    pension_employee = models.DecimalField(default=0, **MONEY)
    other_deductions = models.DecimalField(default=0, **MONEY)
    net = models.DecimalField(**MONEY)
    pension_employer = models.DecimalField(default=0, **MONEY)

    class Meta:
        constraints = [
            models.UniqueConstraint(fields=["run", "employee"], name="one_payslip_per_employee_per_run"),
            models.CheckConstraint(condition=Q(net__gte=0), name="payslip_net_non_negative"),
        ]


class PayslipLine(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    payslip = models.ForeignKey(Payslip, on_delete=models.CASCADE, related_name="lines")
    code = models.CharField(max_length=30)
    name = models.CharField(max_length=100)
    kind = models.CharField(max_length=12)  # BASIC / ALLOWANCE / DEDUCTION / TAX / PENSION
    amount = models.DecimalField(**MONEY)


# ----------------------------------------------------------------------------- organization & employee records
class JobGrade(Base):
    code = models.CharField(max_length=20, unique=True)
    name = models.CharField(max_length=80)
    min_salary = models.DecimalField(default=0, **MONEY)  # base-currency monthly salary band
    max_salary = models.DecimalField(default=0, **MONEY)
    is_active = models.BooleanField(default=True)

    class Meta:
        constraints = [models.CheckConstraint(condition=Q(max_salary__gte=F("min_salary")), name="grade_band_ordered")]


class PositionPlan(Base):
    """HR view of an organization Position: approved headcount, grade, description and requirements."""

    position = models.OneToOneField("organizations.Position", on_delete=models.PROTECT, related_name="hr_plan")
    grade = models.ForeignKey(JobGrade, null=True, blank=True, on_delete=models.PROTECT, related_name="+")
    approved_headcount = models.PositiveSmallIntegerField(default=1)
    job_description = models.TextField(blank=True)
    requirements = models.TextField(blank=True)


class EmergencyContact(Base):
    employee = models.ForeignKey(Employee, on_delete=models.CASCADE, related_name="emergency_contacts")
    name = models.CharField(max_length=120)
    relationship = models.CharField(max_length=40)
    phone = models.CharField(max_length=40)


class Qualification(Base):
    employee = models.ForeignKey(Employee, on_delete=models.CASCADE, related_name="qualifications")
    kind = models.CharField(max_length=12)  # DEGREE / CERTIFICATE / LICENSE / OTHER
    title = models.CharField(max_length=200)
    institution = models.CharField(max_length=200, blank=True)
    awarded_on = models.DateField(null=True, blank=True)
    expires_on = models.DateField(null=True, blank=True)


class Skill(Base):
    employee = models.ForeignKey(Employee, on_delete=models.CASCADE, related_name="skills")
    name = models.CharField(max_length=80)
    level = models.PositiveSmallIntegerField(default=1)

    class Meta:
        constraints = [models.UniqueConstraint(fields=["employee", "name"], name="one_skill_name_per_employee"), models.CheckConstraint(condition=Q(level__gte=1, level__lte=5), name="skill_level_range")]


class EmployeeEvent(models.Model):
    """Append-only employment history (DB trigger forbids update/delete)."""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    employee = models.ForeignKey(Employee, on_delete=models.PROTECT, related_name="events")
    kind = models.CharField(max_length=20, db_index=True)  # HIRED PROMOTION TRANSFER SALARY_CHANGE REPORTING_LINE GRADE_CHANGE PROBATION SEPARATION CONTRACT
    effective_date = models.DateField()
    details = models.JSONField(default=dict)
    actor_id = models.UUIDField(null=True, blank=True)
    created_at = models.DateTimeField(default=timezone.now)

    class Meta:
        ordering = ["effective_date", "created_at"]


class AssignmentChange(Base):
    """Effective-dated promotion / transfer / reporting-line change. Applied on its effective date."""

    class Status(models.TextChoices):
        PENDING = "PENDING"  # requested by a manager, awaiting HR
        SCHEDULED = "SCHEDULED"
        APPLIED = "APPLIED"
        CANCELLED = "CANCELLED"

    employee = models.ForeignKey(Employee, on_delete=models.PROTECT, related_name="assignment_changes")
    kind = models.CharField(max_length=14)  # PROMOTION / TRANSFER / REPORTING_LINE
    effective_date = models.DateField()
    department = models.ForeignKey("organizations.Department", null=True, blank=True, on_delete=models.PROTECT, related_name="+")
    position = models.ForeignKey("organizations.Position", null=True, blank=True, on_delete=models.PROTECT, related_name="+")
    manager = models.ForeignKey(Employee, null=True, blank=True, on_delete=models.PROTECT, related_name="+")
    grade = models.ForeignKey(JobGrade, null=True, blank=True, on_delete=models.PROTECT, related_name="+")
    clear_manager = models.BooleanField(default=False)
    reason = models.CharField(max_length=300, blank=True)
    status = models.CharField(max_length=10, choices=Status.choices, default=Status.PENDING, db_index=True)
    requested_by = models.UUIDField()
    approved_by = models.UUIDField(null=True, blank=True)


class ProbationEvaluation(Base):
    employee = models.ForeignKey(Employee, on_delete=models.PROTECT, related_name="probation_evaluations")
    evaluator_id = models.UUIDField()
    outcome = models.CharField(max_length=8)  # CONFIRM / EXTEND / FAIL
    notes = models.TextField(blank=True)
    new_probation_end = models.DateField(null=True, blank=True)


class Separation(Base):
    class Status(models.TextChoices):
        REQUESTED = "REQUESTED"  # employee resignation awaiting HR
        ACCEPTED = "ACCEPTED"  # offboarding under way
        REJECTED = "REJECTED"
        WITHDRAWN = "WITHDRAWN"
        COMPLETED = "COMPLETED"

    employee = models.ForeignKey(Employee, on_delete=models.PROTECT, related_name="separations")
    kind = models.CharField(max_length=14)  # RESIGNATION / TERMINATION / RETIREMENT / END_OF_CONTRACT / OTHER
    last_working_date = models.DateField()
    reason = models.CharField(max_length=300)
    status = models.CharField(max_length=10, choices=Status.choices, default=Status.REQUESTED, db_index=True)
    requested_by = models.UUIDField()
    decided_by = models.UUIDField(null=True, blank=True)
    settlement_recorded = models.BooleanField(default=False)
    settlement_amount = models.DecimalField(default=0, **MONEY)
    settlement_notes = models.CharField(max_length=500, blank=True)


class EmployeeDocument(Base):
    """A versioned HR document; the bytes live in the shared file service (ref_type hr.employee_document)."""

    employee = models.ForeignKey(Employee, on_delete=models.PROTECT, related_name="documents")
    doc_type = models.CharField(max_length=20, db_index=True)  # CONTRACT / ID / CERTIFICATE / FORM / OTHER
    title = models.CharField(max_length=200)
    version = models.PositiveSmallIntegerField(default=1)
    file_id = models.UUIDField(null=True, blank=True)
    expires_on = models.DateField(null=True, blank=True)
    is_current = models.BooleanField(default=True)
    uploaded_by = models.UUIDField()


class DocumentRequirement(Base):
    """A document every employee (or every employee of a type) must have on file."""

    doc_type = models.CharField(max_length=20)
    title = models.CharField(max_length=120)
    employment_type = models.CharField(max_length=12, blank=True)  # blank = all

    class Meta:
        constraints = [models.UniqueConstraint(fields=["doc_type", "employment_type"], name="one_requirement_per_type")]


# ----------------------------------------------------------------------------- work schedules, overtime, corrections
class WorkSchedule(Base):
    code = models.CharField(max_length=20, unique=True)
    name = models.CharField(max_length=80)
    work_days = models.JSONField(default=list)  # ISO weekdays, 1 = Monday
    start_time = models.TimeField()
    end_time = models.TimeField()  # earlier than start_time = overnight shift
    break_minutes = models.PositiveSmallIntegerField(default=60)
    grace_minutes = models.PositiveSmallIntegerField(default=10)  # lateness tolerance
    is_default = models.BooleanField(default=False)
    is_active = models.BooleanField(default=True)


class ScheduleAssignment(Base):
    employee = models.ForeignKey(Employee, on_delete=models.CASCADE, related_name="schedule_assignments")
    schedule = models.ForeignKey(WorkSchedule, on_delete=models.PROTECT, related_name="+")
    effective_from = models.DateField()
    effective_to = models.DateField(null=True, blank=True)


class OvertimePolicy(Base):
    code = models.CharField(max_length=20, unique=True, default="DEFAULT")
    weekday_multiplier = models.DecimalField(max_digits=5, decimal_places=2, default=1.5)
    rest_day_multiplier = models.DecimalField(max_digits=5, decimal_places=2, default=2.0)
    holiday_multiplier = models.DecimalField(max_digits=5, decimal_places=2, default=2.5)
    max_daily_hours = models.DecimalField(max_digits=4, decimal_places=2, default=4)
    monthly_hours_divisor = models.DecimalField(max_digits=6, decimal_places=2, default=176)  # hours per month for the hourly rate
    is_active = models.BooleanField(default=True)


class AttendanceCorrection(Base):
    class Status(models.TextChoices):
        PENDING = "PENDING"
        APPROVED = "APPROVED"
        REJECTED = "REJECTED"

    employee = models.ForeignKey(Employee, on_delete=models.PROTECT, related_name="attendance_corrections")
    work_date = models.DateField()
    check_in = models.DateTimeField()
    check_out = models.DateTimeField(null=True, blank=True)
    work_mode = models.CharField(max_length=8, default="OFFICE")
    reason = models.CharField(max_length=300)
    status = models.CharField(max_length=10, choices=Status.choices, default=Status.PENDING, db_index=True)
    decided_by = models.UUIDField(null=True, blank=True)
    decision_note = models.CharField(max_length=300, blank=True)


class OvertimeRequest(Base):
    class Status(models.TextChoices):
        PENDING = "PENDING"
        APPROVED = "APPROVED"
        REJECTED = "REJECTED"

    employee = models.ForeignKey(Employee, on_delete=models.PROTECT, related_name="overtime_requests")
    work_date = models.DateField()
    hours = models.DecimalField(max_digits=5, decimal_places=2)
    reason = models.CharField(max_length=300)
    status = models.CharField(max_length=10, choices=Status.choices, default=Status.PENDING, db_index=True)
    decided_by = models.UUIDField(null=True, blank=True)
    decision_note = models.CharField(max_length=300, blank=True)
    payroll_run = models.ForeignKey("PayrollRun", null=True, blank=True, on_delete=models.PROTECT, related_name="+")  # set when paid

    class Meta:
        constraints = [models.CheckConstraint(condition=Q(hours__gt=0, hours__lte=24), name="overtime_hours_range"), models.UniqueConstraint(fields=["employee", "work_date"], condition=~Q(status="REJECTED"), name="one_live_overtime_request_per_day")]


# ----------------------------------------------------------------------------- compensation changes, inputs and loans
class SalaryRevision(Base):
    class Status(models.TextChoices):
        PENDING = "PENDING"
        APPROVED = "APPROVED"
        REJECTED = "REJECTED"
        CANCELLED = "CANCELLED"

    employee = models.ForeignKey(Employee, on_delete=models.PROTECT, related_name="salary_revisions")
    effective_date = models.DateField()
    old_salary = models.DecimalField(**MONEY)
    new_salary = models.DecimalField(**MONEY)
    reason = models.CharField(max_length=300)
    status = models.CharField(max_length=10, choices=Status.choices, default=Status.PENDING, db_index=True)
    requested_by = models.UUIDField()
    decided_by = models.UUIDField(null=True, blank=True)
    decision_note = models.CharField(max_length=300, blank=True)
    contract = models.ForeignKey(Contract, null=True, blank=True, on_delete=models.PROTECT, related_name="+")  # the segment created on approval

    class Meta:
        constraints = [models.CheckConstraint(condition=Q(new_salary__gte=0), name="revision_salary_non_negative")]


class PayrollInput(Base):
    """A one-off payroll item for a month: bonus, commission, arrears or a (signed) adjustment such as a reversal."""

    class Kind(models.TextChoices):
        BONUS = "BONUS"
        COMMISSION = "COMMISSION"
        ARREARS = "ARREARS"
        ADJUSTMENT = "ADJUSTMENT"
        REIMBURSEMENT = "REIMBURSEMENT"

    class Status(models.TextChoices):
        PENDING = "PENDING"
        APPROVED = "APPROVED"
        REJECTED = "REJECTED"

    employee = models.ForeignKey(Employee, on_delete=models.PROTECT, related_name="payroll_inputs")
    kind = models.CharField(max_length=14, choices=Kind.choices)
    month = models.DateField()  # first day of the payroll month
    amount = models.DecimalField(max_digits=14, decimal_places=4)  # negative only for ADJUSTMENT
    taxable = models.BooleanField(default=True)
    description = models.CharField(max_length=200)
    status = models.CharField(max_length=10, choices=Status.choices, default=Status.PENDING, db_index=True)
    created_by = models.UUIDField()
    decided_by = models.UUIDField(null=True, blank=True)
    payroll_run = models.ForeignKey(PayrollRun, null=True, blank=True, on_delete=models.PROTECT, related_name="+")


class Loan(Base):
    class Kind(models.TextChoices):
        LOAN = "LOAN"
        ADVANCE = "ADVANCE"

    class Status(models.TextChoices):
        PENDING = "PENDING"
        ACTIVE = "ACTIVE"
        COMPLETED = "COMPLETED"
        REJECTED = "REJECTED"
        CANCELLED = "CANCELLED"

    employee = models.ForeignKey(Employee, on_delete=models.PROTECT, related_name="loans")
    kind = models.CharField(max_length=8, choices=Kind.choices, default=Kind.LOAN)
    principal = models.DecimalField(**MONEY)
    installments = models.PositiveSmallIntegerField()
    start_month = models.DateField()
    reason = models.CharField(max_length=300, blank=True)
    status = models.CharField(max_length=10, choices=Status.choices, default=Status.PENDING, db_index=True)
    requested_by = models.UUIDField()
    decided_by = models.UUIDField(null=True, blank=True)
    decision_note = models.CharField(max_length=300, blank=True)

    class Meta:
        constraints = [models.CheckConstraint(condition=Q(principal__gt=0, installments__gte=1), name="loan_positive")]


class LoanInstallment(Base):
    loan = models.ForeignKey(Loan, on_delete=models.CASCADE, related_name="schedule")
    due_month = models.DateField()
    amount = models.DecimalField(**MONEY)
    payroll_run = models.ForeignKey(PayrollRun, null=True, blank=True, on_delete=models.PROTECT, related_name="+")
    repaid = models.BooleanField(default=False)  # true once the run that deducted it is posted

    class Meta:
        constraints = [models.UniqueConstraint(fields=["loan", "due_month"], name="one_installment_per_month")]


# ----------------------------------------------------------------------------- recruitment
class JobRequisition(Base):
    class Status(models.TextChoices):
        DRAFT = "DRAFT"
        PENDING = "PENDING"
        APPROVED = "APPROVED"  # open for applications
        REJECTED = "REJECTED"
        CLOSED = "CLOSED"

    number = models.CharField(max_length=30, unique=True)
    title = models.CharField(max_length=150)
    department = models.ForeignKey("organizations.Department", null=True, blank=True, on_delete=models.PROTECT, related_name="+")
    position = models.ForeignKey("organizations.Position", null=True, blank=True, on_delete=models.PROTECT, related_name="+")
    headcount = models.PositiveSmallIntegerField(default=1)
    justification = models.CharField(max_length=500)
    status = models.CharField(max_length=10, choices=Status.choices, default=Status.DRAFT, db_index=True)
    requested_by = models.UUIDField()
    decided_by = models.UUIDField(null=True, blank=True)
    decision_note = models.CharField(max_length=300, blank=True)

    class Meta:
        constraints = [models.CheckConstraint(condition=Q(headcount__gte=1), name="requisition_headcount_positive")]


class Candidate(Base):
    class Stage(models.TextChoices):
        APPLIED = "APPLIED"
        SCREENING = "SCREENING"
        INTERVIEW = "INTERVIEW"
        OFFER = "OFFER"
        HIRED = "HIRED"
        REJECTED = "REJECTED"
        WITHDRAWN = "WITHDRAWN"

    requisition = models.ForeignKey(JobRequisition, on_delete=models.PROTECT, related_name="candidates")
    name = models.CharField(max_length=150)
    email = models.EmailField()
    phone = models.CharField(max_length=40, blank=True)
    source = models.CharField(max_length=60, blank=True)
    stage = models.CharField(max_length=10, choices=Stage.choices, default=Stage.APPLIED, db_index=True)
    reason = models.CharField(max_length=300, blank=True)
    employee = models.ForeignKey(Employee, null=True, blank=True, on_delete=models.PROTECT, related_name="+")

    class Meta:
        constraints = [models.UniqueConstraint(fields=["requisition", "email"], name="one_application_per_email_per_requisition")]


class Interview(Base):
    class Status(models.TextChoices):
        SCHEDULED = "SCHEDULED"
        DONE = "DONE"
        CANCELLED = "CANCELLED"

    candidate = models.ForeignKey(Candidate, on_delete=models.CASCADE, related_name="interviews")
    interviewer_id = models.UUIDField()
    scheduled_at = models.DateTimeField()
    status = models.CharField(max_length=10, choices=Status.choices, default=Status.SCHEDULED)
    score = models.PositiveSmallIntegerField(null=True, blank=True)
    recommendation = models.CharField(max_length=10, blank=True)  # HIRE / NO_HIRE
    feedback = models.TextField(blank=True)

    class Meta:
        constraints = [models.CheckConstraint(condition=Q(score__isnull=True) | Q(score__gte=1, score__lte=5), name="interview_score_range")]


class Offer(Base):
    class Status(models.TextChoices):
        DRAFT = "DRAFT"
        APPROVED = "APPROVED"
        ACCEPTED = "ACCEPTED"
        DECLINED = "DECLINED"
        WITHDRAWN = "WITHDRAWN"

    candidate = models.ForeignKey(Candidate, on_delete=models.PROTECT, related_name="offers")
    monthly_salary = models.DecimalField(**MONEY)
    currency = models.CharField(max_length=3)
    start_date = models.DateField()
    status = models.CharField(max_length=10, choices=Status.choices, default=Status.DRAFT, db_index=True)
    created_by = models.UUIDField()
    approved_by = models.UUIDField(null=True, blank=True)


# ----------------------------------------------------------------------------- performance
class ReviewCycle(Base):
    class Status(models.TextChoices):
        DRAFT = "DRAFT"
        ACTIVE = "ACTIVE"
        CLOSED = "CLOSED"

    name = models.CharField(max_length=100, unique=True)
    start_date = models.DateField()
    end_date = models.DateField()
    status = models.CharField(max_length=8, choices=Status.choices, default=Status.DRAFT)


class Goal(Base):
    employee = models.ForeignKey(Employee, on_delete=models.PROTECT, related_name="goals")
    cycle = models.ForeignKey(ReviewCycle, on_delete=models.PROTECT, related_name="goals")
    title = models.CharField(max_length=200)
    weight = models.DecimalField(max_digits=5, decimal_places=2)  # percent; the cycle's goals of one employee total 100
    progress = models.DecimalField(max_digits=5, decimal_places=2, default=0)

    class Meta:
        constraints = [models.CheckConstraint(condition=Q(weight__gt=0, weight__lte=100, progress__gte=0, progress__lte=100), name="goal_ranges")]


class PerformanceReview(Base):
    class Status(models.TextChoices):
        PENDING_SELF = "PENDING_SELF"
        PENDING_MANAGER = "PENDING_MANAGER"
        COMPLETED = "COMPLETED"
        ACKNOWLEDGED = "ACKNOWLEDGED"

    employee = models.ForeignKey(Employee, on_delete=models.PROTECT, related_name="reviews")
    cycle = models.ForeignKey(ReviewCycle, on_delete=models.PROTECT, related_name="reviews")
    status = models.CharField(max_length=16, choices=Status.choices, default=Status.PENDING_SELF, db_index=True)
    self_rating = models.PositiveSmallIntegerField(null=True, blank=True)
    self_comment = models.TextField(blank=True)
    manager_rating = models.PositiveSmallIntegerField(null=True, blank=True)
    manager_comment = models.TextField(blank=True)
    goal_score = models.DecimalField(max_digits=5, decimal_places=2, null=True, blank=True)  # frozen when completed
    reviewed_by = models.UUIDField(null=True, blank=True)

    class Meta:
        constraints = [
            models.UniqueConstraint(fields=["employee", "cycle"], name="one_review_per_cycle"),
            models.CheckConstraint(condition=Q(self_rating__isnull=True) | Q(self_rating__gte=1, self_rating__lte=5), name="self_rating_range"),
            models.CheckConstraint(condition=Q(manager_rating__isnull=True) | Q(manager_rating__gte=1, manager_rating__lte=5), name="manager_rating_range"),
        ]


# ----------------------------------------------------------------------------- learning
class TrainingCourse(Base):
    code = models.CharField(max_length=30, unique=True)
    name = models.CharField(max_length=150)
    provider = models.CharField(max_length=100, blank=True)
    hours = models.DecimalField(max_digits=6, decimal_places=2, default=0)
    validity_months = models.PositiveSmallIntegerField(null=True, blank=True)  # certificates expire after this
    mandatory = models.BooleanField(default=False)
    is_active = models.BooleanField(default=True)


class TrainingRecord(Base):
    employee = models.ForeignKey(Employee, on_delete=models.PROTECT, related_name="trainings")
    course = models.ForeignKey(TrainingCourse, on_delete=models.PROTECT, related_name="records")
    completed_on = models.DateField()
    expires_on = models.DateField(null=True, blank=True)
    score = models.DecimalField(max_digits=5, decimal_places=2, null=True, blank=True)
    recorded_by = models.UUIDField()

    class Meta:
        constraints = [models.UniqueConstraint(fields=["employee", "course", "completed_on"], name="one_training_record_per_day")]


# ----------------------------------------------------------------------------- employee relations and policies
class EmployeeCase(Base):
    class Kind(models.TextChoices):
        GRIEVANCE = "GRIEVANCE"
        DISCIPLINARY = "DISCIPLINARY"
        COMMENDATION = "COMMENDATION"

    class Status(models.TextChoices):
        OPEN = "OPEN"
        INVESTIGATING = "INVESTIGATING"
        CLOSED = "CLOSED"

    employee = models.ForeignKey(Employee, on_delete=models.PROTECT, related_name="cases")
    kind = models.CharField(max_length=14, choices=Kind.choices)
    summary = models.CharField(max_length=300)
    status = models.CharField(max_length=14, choices=Status.choices, default=Status.OPEN, db_index=True)
    opened_by = models.UUIDField()
    outcome = models.CharField(max_length=300, blank=True)


class CaseNote(Base):
    case = models.ForeignKey(EmployeeCase, on_delete=models.CASCADE, related_name="notes")
    author_id = models.UUIDField()
    text = models.TextField()


class HrPolicy(Base):
    class Status(models.TextChoices):
        DRAFT = "DRAFT"
        PUBLISHED = "PUBLISHED"
        RETIRED = "RETIRED"

    code = models.CharField(max_length=30)
    version = models.PositiveSmallIntegerField(default=1)
    title = models.CharField(max_length=150)
    body = models.TextField()
    status = models.CharField(max_length=10, choices=Status.choices, default=Status.DRAFT, db_index=True)
    published_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        constraints = [models.UniqueConstraint(fields=["code", "version"], name="one_policy_version")]


class PolicyAcknowledgment(Base):
    policy = models.ForeignKey(HrPolicy, on_delete=models.PROTECT, related_name="acknowledgments")
    employee = models.ForeignKey(Employee, on_delete=models.PROTECT, related_name="+")

    class Meta:
        constraints = [models.UniqueConstraint(fields=["policy", "employee"], name="one_ack_per_policy_version")]


class Reimbursement(Base):
    class Status(models.TextChoices):
        SUBMITTED = "SUBMITTED"
        APPROVED = "APPROVED"
        REJECTED = "REJECTED"

    employee = models.ForeignKey(Employee, on_delete=models.PROTECT, related_name="reimbursements")
    description = models.CharField(max_length=200)
    expense_date = models.DateField()
    amount = models.DecimalField(**MONEY)
    status = models.CharField(max_length=10, choices=Status.choices, default=Status.SUBMITTED, db_index=True)
    decided_by = models.UUIDField(null=True, blank=True)
    decision_note = models.CharField(max_length=300, blank=True)
    payroll_input = models.ForeignKey(PayrollInput, null=True, blank=True, on_delete=models.PROTECT, related_name="+")

    class Meta:
        constraints = [models.CheckConstraint(condition=Q(amount__gt=0), name="reimbursement_positive")]
