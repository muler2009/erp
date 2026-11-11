"""Quality management. Records are never deleted: they are closed, cancelled or superseded, so the history stays complete."""
import uuid

from django.db import models
from django.db.models import F, Q
from django.utils import timezone

MONEY = dict(max_digits=20, decimal_places=4)
QTY = dict(max_digits=18, decimal_places=4)


class Base(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    created_at = models.DateTimeField(default=timezone.now, db_index=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        abstract = True


class ConfigItem(Base):
    """Administrator-defined lists: NCR_CATEGORY, SEVERITY, ANALYSIS_METHOD, AUDIT_TYPE, COMPLAINT_TYPE, FINDING_TYPE, RISK_CATEGORY, DEFECT_TYPE, IMPROVEMENT_CATEGORY, INSPECTION_TYPE."""
    kind = models.CharField(max_length=24, db_index=True)
    code = models.CharField(max_length=30)
    name = models.CharField(max_length=120)
    rank = models.PositiveSmallIntegerField(default=1)  # severity rank; higher is worse
    requires_capa = models.BooleanField(default=False)  # severity levels: a closed record needs a CAPA
    is_active = models.BooleanField(default=True)

    class Meta:
        constraints = [models.UniqueConstraint(fields=["kind", "code"], name="qm_config_unique")]


class Event(models.Model):
    """Append-only history for every quality record."""
    id = models.BigAutoField(primary_key=True)
    record_type = models.CharField(max_length=24)
    record_id = models.UUIDField()
    action = models.CharField(max_length=30)
    from_status = models.CharField(max_length=24, blank=True)
    to_status = models.CharField(max_length=24, blank=True)
    actor_id = models.UUIDField(null=True, blank=True)
    note = models.CharField(max_length=500, blank=True)
    at = models.DateTimeField(default=timezone.now, db_index=True)

    class Meta:
        indexes = [models.Index(fields=["record_type", "record_id"], name="qm_event_rec_idx")]


class Evidence(Base):
    """Photographs, certificates and other proof attached to a quality record."""
    record_type = models.CharField(max_length=24)
    record_id = models.UUIDField()
    file_id = models.UUIDField()
    file_name = models.CharField(max_length=255)
    kind = models.CharField(max_length=20, default="EVIDENCE")  # PHOTO CERTIFICATE EVIDENCE REPORT
    description = models.CharField(max_length=300, blank=True)
    uploaded_by = models.UUIDField()

    class Meta:
        indexes = [models.Index(fields=["record_type", "record_id"], name="qm_evidence_rec_idx")]


class Action(Base):
    """A task with an owner and a deadline that belongs to an NCR, CAPA, audit finding, complaint, risk or improvement."""
    parent_type = models.CharField(max_length=24)
    parent_id = models.UUIDField()
    action_type = models.CharField(max_length=12)  # CONTAINMENT CORRECTION CORRECTIVE PREVENTIVE MITIGATION
    description = models.CharField(max_length=500)
    owner_id = models.UUIDField(db_index=True)
    due_date = models.DateField(db_index=True)
    status = models.CharField(max_length=20, default="OPEN")  # OPEN DONE VERIFIED CANCELLED
    completed_at = models.DateTimeField(null=True, blank=True)
    completion_note = models.CharField(max_length=500, blank=True)
    verified_by = models.UUIDField(null=True, blank=True)
    last_reminder_on = models.DateField(null=True, blank=True)
    escalated_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        indexes = [models.Index(fields=["parent_type", "parent_id"], name="qm_action_parent_idx")]


class CostEntry(Base):
    ref_type = models.CharField(max_length=24)
    ref_id = models.UUIDField()
    category = models.CharField(max_length=12)  # SCRAP REWORK RETURN WARRANTY INSPECTION PREVENTION OTHER
    amount = models.DecimalField(**MONEY)
    incurred_on = models.DateField()
    description = models.CharField(max_length=300, blank=True)
    recorded_by = models.UUIDField()

    class Meta:
        constraints = [models.CheckConstraint(condition=Q(amount__gt=0), name="qm_cost_positive")]


# ----------------------------------------------------------------------------- planning
class QualityPlan(Base):
    number = models.CharField(max_length=30, unique=True)
    title = models.CharField(max_length=200)
    scope_type = models.CharField(max_length=12)  # DEPARTMENT PROJECT PRODUCT PROCESS CONTRACT
    scope_ref = models.CharField(max_length=64, blank=True)
    scope_label = models.CharField(max_length=200, blank=True)
    standards = models.TextField(blank=True)  # standards, acceptance criteria and inspection requirements in prose
    owner_id = models.UUIDField(db_index=True)
    department_id = models.UUIDField(null=True, blank=True)
    status = models.CharField(max_length=20, default="DRAFT", db_index=True)  # DRAFT PENDING_APPROVAL APPROVED SUPERSEDED
    revision = models.PositiveIntegerField(default=1)
    workflow_instance_id = models.UUIDField(null=True, blank=True)
    approved_by = models.UUIDField(null=True, blank=True)
    approved_at = models.DateTimeField(null=True, blank=True)
    valid_from = models.DateField(null=True, blank=True)
    valid_to = models.DateField(null=True, blank=True)
    created_by = models.UUIDField()


class PlanRevision(models.Model):
    id = models.BigAutoField(primary_key=True)
    plan = models.ForeignKey(QualityPlan, on_delete=models.PROTECT, related_name="revisions")
    revision = models.PositiveIntegerField()
    snapshot = models.JSONField()
    reason = models.CharField(max_length=300)
    changed_by = models.UUIDField()
    approved_by = models.UUIDField(null=True, blank=True)
    at = models.DateTimeField(default=timezone.now)


class Objective(Base):
    plan = models.ForeignKey(QualityPlan, on_delete=models.CASCADE, related_name="objectives")
    name = models.CharField(max_length=200)
    metric = models.CharField(max_length=30)  # free key, or REJECTION_RATE / NCR_COUNT / ON_TIME_CAPA / COMPLAINT_COUNT computed by analytics
    target = models.DecimalField(**QTY)
    direction = models.CharField(max_length=6, default="LOWER")  # LOWER is better | HIGHER is better
    unit = models.CharField(max_length=20, blank=True)
    owner_id = models.UUIDField()


class ObjectiveMeasurement(Base):
    objective = models.ForeignKey(Objective, on_delete=models.CASCADE, related_name="measurements")
    period = models.DateField()
    value = models.DecimalField(**QTY)
    recorded_by = models.UUIDField()

    class Meta:
        constraints = [models.UniqueConstraint(fields=["objective", "period"], name="qm_measure_once")]


class ControlPoint(Base):
    plan = models.ForeignKey(QualityPlan, on_delete=models.CASCADE, related_name="control_points")
    name = models.CharField(max_length=200)
    stage = models.CharField(max_length=60, blank=True)
    frequency = models.CharField(max_length=60, blank=True)
    acceptance_criteria = models.CharField(max_length=300, blank=True)
    responsible_id = models.UUIDField()
    department_id = models.UUIDField(null=True, blank=True)
    inspection_plan_id = models.UUIDField(null=True, blank=True)


# ----------------------------------------------------------------------------- standards and compliance
class Standard(Base):
    code = models.CharField(max_length=40, unique=True)
    name = models.CharField(max_length=200)
    kind = models.CharField(max_length=12, default="STANDARD")  # STANDARD REGULATION POLICY PROCEDURE
    issuer = models.CharField(max_length=120, blank=True)
    version = models.CharField(max_length=30, blank=True)
    effective_from = models.DateField(null=True, blank=True)
    status = models.CharField(max_length=20, default="ACTIVE")  # ACTIVE SUPERSEDED WITHDRAWN


class StandardChange(Base):
    standard = models.ForeignKey(Standard, on_delete=models.CASCADE, related_name="changes")
    from_version = models.CharField(max_length=30, blank=True)
    to_version = models.CharField(max_length=30)
    summary = models.CharField(max_length=500)
    effective_on = models.DateField(null=True, blank=True)
    impact = models.CharField(max_length=500, blank=True)
    recorded_by = models.UUIDField()


class Requirement(Base):
    standard = models.ForeignKey(Standard, on_delete=models.CASCADE, related_name="requirements")
    clause = models.CharField(max_length=40)
    text = models.TextField()
    department_id = models.UUIDField(null=True, blank=True)
    owner_id = models.UUIDField()
    status = models.CharField(max_length=20, default="NOT_ASSESSED")  # NOT_ASSESSED COMPLIANT PARTIAL NON_COMPLIANT NOT_APPLICABLE
    next_review_on = models.DateField(null=True, blank=True)
    needs_review = models.BooleanField(default=False)  # set when the standard changes

    class Meta:
        constraints = [models.UniqueConstraint(fields=["standard", "clause"], name="qm_requirement_clause")]


class RequirementMapping(Base):
    requirement = models.ForeignKey(Requirement, on_delete=models.CASCADE, related_name="mappings")
    document_id = models.UUIDField()  # the procedure or policy in the document module that addresses it
    note = models.CharField(max_length=200, blank=True)

    class Meta:
        constraints = [models.UniqueConstraint(fields=["requirement", "document_id"], name="qm_mapping_once")]


class Assessment(Base):
    """Append-only compliance assessment history."""
    requirement = models.ForeignKey(Requirement, on_delete=models.CASCADE, related_name="assessments")
    status = models.CharField(max_length=20)
    assessed_on = models.DateField()
    assessor_id = models.UUIDField()
    gap = models.CharField(max_length=500, blank=True)
    notes = models.CharField(max_length=500, blank=True)
    evidence_document_id = models.UUIDField(null=True, blank=True)


# ----------------------------------------------------------------------------- inspections
STAGES = ("INCOMING", "IN_PROCESS", "FINAL", "PROJECT", "EQUIPMENT", "SUPPLIER")


class InspectionPlan(Base):
    number = models.CharField(max_length=30, unique=True)
    title = models.CharField(max_length=200)
    stage = models.CharField(max_length=12)
    subject_type = models.CharField(max_length=10)  # PRODUCT MATERIAL EQUIPMENT PROCESS SERVICE SITE
    product_id = models.UUIDField(null=True, blank=True, db_index=True)
    project_id = models.UUIDField(null=True, blank=True, db_index=True)
    frequency = models.CharField(max_length=60, blank=True)
    sampling = models.CharField(max_length=8, default="ALL")  # ALL PERCENT FIXED
    sample_value = models.DecimalField(null=True, blank=True, **QTY)
    department_id = models.UUIDField(null=True, blank=True)
    inspector_id = models.UUIDField(null=True, blank=True)
    is_itp = models.BooleanField(default=False)
    revision = models.PositiveIntegerField(default=1)
    status = models.CharField(max_length=20, default="ACTIVE")  # ACTIVE INACTIVE
    created_by = models.UUIDField()


class Parameter(Base):
    plan = models.ForeignKey(InspectionPlan, on_delete=models.CASCADE, related_name="parameters")
    name = models.CharField(max_length=120)
    kind = models.CharField(max_length=8, default="NUMERIC")  # NUMERIC BOOLEAN TEXT
    lower = models.DecimalField(null=True, blank=True, **QTY)
    upper = models.DecimalField(null=True, blank=True, **QTY)
    target = models.DecimalField(null=True, blank=True, **QTY)
    unit = models.CharField(max_length=20, blank=True)
    mandatory = models.BooleanField(default=True)
    critical = models.BooleanField(default=False)  # a failed critical parameter fails the inspection outright
    position = models.PositiveSmallIntegerField(default=1)
    is_active = models.BooleanField(default=True)


class Inspection(Base):
    number = models.CharField(max_length=30, unique=True)
    plan = models.ForeignKey(InspectionPlan, on_delete=models.PROTECT, related_name="inspections")
    stage = models.CharField(max_length=12)
    status = models.CharField(max_length=20, default="SCHEDULED", db_index=True)  # SCHEDULED IN_PROGRESS COMPLETED CANCELLED
    result = models.CharField(max_length=12, default="PENDING")  # PENDING PASS FAIL CONDITIONAL
    scheduled_for = models.DateField(db_index=True)
    inspector_id = models.UUIDField(db_index=True)
    department_id = models.UUIDField(null=True, blank=True)
    ref_type = models.CharField(max_length=40, blank=True)  # procurement.goods_receipt, manufacturing.order, projects.project, assets.asset ...
    ref_id = models.CharField(max_length=64, blank=True)
    product_id = models.UUIDField(null=True, blank=True, db_index=True)
    supplier_id = models.UUIDField(null=True, blank=True, db_index=True)
    project_id = models.UUIDField(null=True, blank=True, db_index=True)
    lot_number = models.CharField(max_length=60, blank=True, db_index=True)
    quantity_total = models.DecimalField(default=0, **QTY)
    quantity_inspected = models.DecimalField(default=0, **QTY)
    quantity_accepted = models.DecimalField(default=0, **QTY)
    quantity_rejected = models.DecimalField(default=0, **QTY)
    summary = models.CharField(max_length=500, blank=True)
    conditional_note = models.CharField(max_length=500, blank=True)
    started_at = models.DateTimeField(null=True, blank=True)
    completed_at = models.DateTimeField(null=True, blank=True)
    reinspection_of = models.ForeignKey("self", null=True, blank=True, on_delete=models.PROTECT, related_name="reinspections")
    created_by = models.UUIDField()

    class Meta:
        constraints = [models.CheckConstraint(condition=Q(quantity_accepted__gte=0) & Q(quantity_rejected__gte=0), name="qm_inspection_qty_nonneg")]


class InspectionEquipment(Base):
    inspection = models.ForeignKey(Inspection, on_delete=models.CASCADE, related_name="equipment_used")
    equipment = models.ForeignKey("Equipment", on_delete=models.PROTECT, related_name="uses")

    class Meta:
        constraints = [models.UniqueConstraint(fields=["inspection", "equipment"], name="qm_inspection_equipment_once")]


class Result(Base):
    """Measured results. A correction adds a new row and retires the old one; nothing is overwritten."""
    inspection = models.ForeignKey(Inspection, on_delete=models.PROTECT, related_name="results")
    parameter = models.ForeignKey(Parameter, on_delete=models.PROTECT, related_name="+")
    value = models.DecimalField(null=True, blank=True, **QTY)
    text = models.CharField(max_length=300, blank=True)
    passed = models.BooleanField()
    comment = models.CharField(max_length=500, blank=True)
    recorded_by = models.UUIDField()
    is_current = models.BooleanField(default=True)
    superseded_by = models.ForeignKey("self", null=True, blank=True, on_delete=models.PROTECT, related_name="supersedes")
    correction_reason = models.CharField(max_length=300, blank=True)

    class Meta:
        constraints = [models.UniqueConstraint(fields=["inspection", "parameter"], condition=Q(is_current=True), name="qm_one_current_result")]


class Defect(Base):
    inspection = models.ForeignKey(Inspection, null=True, blank=True, on_delete=models.PROTECT, related_name="defects")
    ncr_id = models.UUIDField(null=True, blank=True)
    product_id = models.UUIDField(null=True, blank=True, db_index=True)
    defect_code = models.CharField(max_length=30)
    quantity = models.DecimalField(**QTY)
    lot_number = models.CharField(max_length=60, blank=True)
    note = models.CharField(max_length=300, blank=True)
    recorded_by = models.UUIDField()
    occurred_on = models.DateField()


class Hold(Base):
    """A quality hold. While it is active the stock cannot be issued or sold; only an authorised release lifts it."""
    number = models.CharField(max_length=30, unique=True)
    product_id = models.UUIDField(db_index=True)
    lot_number = models.CharField(max_length=60, blank=True)
    quantity = models.DecimalField(default=0, **QTY)
    reason = models.CharField(max_length=500)
    source_type = models.CharField(max_length=24, blank=True)
    source_id = models.UUIDField(null=True, blank=True)
    status = models.CharField(max_length=20, default="ACTIVE", db_index=True)  # ACTIVE RELEASED REJECTED
    placed_by = models.UUIDField()
    released_by = models.UUIDField(null=True, blank=True)
    released_at = models.DateTimeField(null=True, blank=True)
    release_note = models.CharField(max_length=500, blank=True)
    disposition = models.CharField(max_length=12, blank=True)  # ACCEPT REJECT REWORK REPAIR SCRAP CONDITIONAL
    disposition_by = models.UUIDField(null=True, blank=True)
    disposition_note = models.CharField(max_length=500, blank=True)
    disposition_at = models.DateTimeField(null=True, blank=True)
    reinspection_id = models.UUIDField(null=True, blank=True)


# ----------------------------------------------------------------------------- non-conformances
class Ncr(Base):
    number = models.CharField(max_length=30, unique=True)
    title = models.CharField(max_length=200)
    source = models.CharField(max_length=12)  # INSPECTION AUDIT PRODUCTION PROJECT COMPLAINT SUPPLIER OTHER
    source_ref_type = models.CharField(max_length=30, blank=True)
    source_ref_id = models.CharField(max_length=64, blank=True)
    category = models.CharField(max_length=30)
    severity = models.CharField(max_length=30)
    department_id = models.UUIDField(null=True, blank=True)
    product_id = models.UUIDField(null=True, blank=True, db_index=True)
    supplier_id = models.UUIDField(null=True, blank=True, db_index=True)
    project_id = models.UUIDField(null=True, blank=True, db_index=True)
    lot_number = models.CharField(max_length=60, blank=True)
    location = models.CharField(max_length=200, blank=True)
    detected_on = models.DateField()
    description = models.TextField()
    affected_items = models.CharField(max_length=500, blank=True)
    containment = models.CharField(max_length=500, blank=True)
    containment_by = models.UUIDField(null=True, blank=True)
    investigator_id = models.UUIDField(null=True, blank=True)
    root_cause = models.TextField(blank=True)
    proposed_correction = models.TextField(blank=True)
    status = models.CharField(max_length=20, default="OPEN", db_index=True)  # OPEN INVESTIGATING PENDING_APPROVAL APPROVED IMPLEMENTING VERIFYING CLOSED REJECTED
    reopened_count = models.PositiveSmallIntegerField(default=0)
    workflow_instance_id = models.UUIDField(null=True, blank=True)
    verified_by = models.UUIDField(null=True, blank=True)
    verification_note = models.CharField(max_length=500, blank=True)
    closed_at = models.DateTimeField(null=True, blank=True)
    capa_id = models.UUIDField(null=True, blank=True)
    reported_by = models.UUIDField()


# ----------------------------------------------------------------------------- CAPA
class Capa(Base):
    number = models.CharField(max_length=30, unique=True)
    kind = models.CharField(max_length=10)  # CORRECTIVE PREVENTIVE
    title = models.CharField(max_length=200)
    source_type = models.CharField(max_length=14)  # NCR AUDIT_FINDING COMPLAINT INSPECTION RISK IMPROVEMENT OTHER
    source_id = models.UUIDField(null=True, blank=True)
    problem = models.TextField()
    justification = models.TextField(blank=True)
    owner_id = models.UUIDField(db_index=True)
    reviewer_id = models.UUIDField()
    due_date = models.DateField(db_index=True)
    status = models.CharField(max_length=20, default="DRAFT", db_index=True)  # DRAFT ANALYSIS PENDING_APPROVAL APPROVED IMPLEMENTING VERIFYING CLOSED CANCELLED
    containment = models.TextField(blank=True)
    correction = models.TextField(blank=True)
    corrective = models.TextField(blank=True)
    preventive = models.TextField(blank=True)
    workflow_instance_id = models.UUIDField(null=True, blank=True)
    implemented_at = models.DateTimeField(null=True, blank=True)
    effectiveness_due = models.DateField(null=True, blank=True)
    closed_at = models.DateTimeField(null=True, blank=True)
    cycles = models.PositiveSmallIntegerField(default=1)  # increases each time effectiveness verification fails
    department_id = models.UUIDField(null=True, blank=True)
    supplier_id = models.UUIDField(null=True, blank=True)
    created_by = models.UUIDField()


class RootCause(Base):
    capa = models.ForeignKey(Capa, on_delete=models.CASCADE, related_name="analyses")
    method = models.CharField(max_length=30)
    details = models.JSONField(default=dict)
    conclusion = models.TextField()
    analysed_by = models.UUIDField()
    cycle = models.PositiveSmallIntegerField(default=1)


class EffectivenessReview(Base):
    capa = models.ForeignKey(Capa, on_delete=models.CASCADE, related_name="reviews")
    verified_by = models.UUIDField()
    verified_on = models.DateField()
    effective = models.BooleanField()
    notes = models.CharField(max_length=500)
    cycle = models.PositiveSmallIntegerField(default=1)


# ----------------------------------------------------------------------------- audits
class ChecklistTemplate(Base):
    name = models.CharField(max_length=120, unique=True)
    audit_type = models.CharField(max_length=30)
    questions = models.JSONField(default=list)  # [{"question", "requirement" (standard code:clause) , "procedure" (document reference)}]
    is_active = models.BooleanField(default=True)


class Audit(Base):
    number = models.CharField(max_length=30, unique=True)
    program = models.CharField(max_length=120, blank=True)
    audit_type = models.CharField(max_length=30)
    title = models.CharField(max_length=200)
    scope = models.TextField()
    objectives = models.TextField(blank=True)
    criteria = models.CharField(max_length=500, blank=True)
    planned_start = models.DateField()
    planned_end = models.DateField()
    lead_auditor_id = models.UUIDField(db_index=True)
    auditee_department_id = models.UUIDField(null=True, blank=True)
    supplier_id = models.UUIDField(null=True, blank=True)
    status = models.CharField(max_length=20, default="PLANNED", db_index=True)  # PLANNED IN_PROGRESS REPORTED CLOSED CANCELLED
    follow_up_of = models.ForeignKey("self", null=True, blank=True, on_delete=models.PROTECT, related_name="follow_ups")
    summary = models.TextField(blank=True)
    reported_at = models.DateTimeField(null=True, blank=True)
    created_by = models.UUIDField()

    class Meta:
        constraints = [models.CheckConstraint(condition=Q(planned_end__gte=F("planned_start")), name="qm_audit_dates")]


class AuditMember(Base):
    audit = models.ForeignKey(Audit, on_delete=models.CASCADE, related_name="team")
    user_id = models.UUIDField()
    role = models.CharField(max_length=10, default="AUDITOR")  # LEAD AUDITOR OBSERVER

    class Meta:
        constraints = [models.UniqueConstraint(fields=["audit", "user_id"], name="qm_audit_member_once")]


class ChecklistItem(Base):
    audit = models.ForeignKey(Audit, on_delete=models.CASCADE, related_name="checklist")
    position = models.PositiveSmallIntegerField()
    question = models.CharField(max_length=500)
    requirement = models.ForeignKey(Requirement, null=True, blank=True, on_delete=models.SET_NULL, related_name="+")
    procedure_document_id = models.UUIDField(null=True, blank=True)
    response = models.CharField(max_length=12, default="PENDING")  # PENDING CONFORMS NONCONFORMS OBSERVATION NOT_APPLICABLE
    note = models.CharField(max_length=500, blank=True)
    answered_by = models.UUIDField(null=True, blank=True)


class Finding(Base):
    number = models.CharField(max_length=30, unique=True)
    audit = models.ForeignKey(Audit, on_delete=models.PROTECT, related_name="findings")
    checklist_item = models.ForeignKey(ChecklistItem, null=True, blank=True, on_delete=models.SET_NULL, related_name="+")
    finding_type = models.CharField(max_length=30)
    severity = models.CharField(max_length=30)
    description = models.TextField()
    requirement_ref = models.CharField(max_length=120, blank=True)
    status = models.CharField(max_length=20, default="OPEN", db_index=True)  # OPEN ACTION_ASSIGNED CLOSED
    due_date = models.DateField(null=True, blank=True)
    owner_id = models.UUIDField(null=True, blank=True)
    capa_id = models.UUIDField(null=True, blank=True)
    closed_at = models.DateTimeField(null=True, blank=True)
    closed_by = models.UUIDField(null=True, blank=True)
    closure_note = models.CharField(max_length=500, blank=True)
    recorded_by = models.UUIDField()


# ----------------------------------------------------------------------------- suppliers
class SupplierProfile(Base):
    supplier_id = models.UUIDField(unique=True)
    status = models.CharField(max_length=20, default="PENDING")  # PENDING APPROVED CONDITIONAL RESTRICTED BLOCKED
    status_reason = models.CharField(max_length=300, blank=True)
    min_score = models.DecimalField(max_digits=5, decimal_places=2, default=70)
    max_rejection_rate = models.DecimalField(max_digits=5, decimal_places=2, default=5)
    criteria_note = models.CharField(max_length=500, blank=True)
    changed_by = models.UUIDField(null=True, blank=True)


class SupplierCertificate(Base):
    supplier_id = models.UUIDField(db_index=True)
    name = models.CharField(max_length=120)
    number = models.CharField(max_length=60, blank=True)
    issuer = models.CharField(max_length=120, blank=True)
    issued_on = models.DateField(null=True, blank=True)
    expires_on = models.DateField(null=True, blank=True, db_index=True)
    document_id = models.UUIDField(null=True, blank=True)
    last_reminder_on = models.DateField(null=True, blank=True)
    recorded_by = models.UUIDField()


class SupplierEvaluation(Base):
    supplier_id = models.UUIDField(db_index=True)
    period_from = models.DateField()
    period_to = models.DateField()
    lots_inspected = models.PositiveIntegerField(default=0)
    lots_rejected = models.PositiveIntegerField(default=0)
    quantity_inspected = models.DecimalField(default=0, **QTY)
    quantity_rejected = models.DecimalField(default=0, **QTY)
    ncr_count = models.PositiveIntegerField(default=0)
    scar_open = models.PositiveIntegerField(default=0)
    rejection_rate = models.DecimalField(max_digits=7, decimal_places=2, default=0)
    score = models.DecimalField(max_digits=5, decimal_places=2)
    outcome = models.CharField(max_length=12)  # MEETS BELOW
    evaluated_by = models.UUIDField()


class Scar(Base):
    """Supplier corrective action request."""
    number = models.CharField(max_length=30, unique=True)
    supplier_id = models.UUIDField(db_index=True)
    ncr = models.ForeignKey(Ncr, null=True, blank=True, on_delete=models.PROTECT, related_name="scars")
    description = models.TextField()
    due_date = models.DateField(db_index=True)
    status = models.CharField(max_length=20, default="OPEN", db_index=True)  # OPEN RESPONDED ACCEPTED REJECTED CLOSED
    response = models.TextField(blank=True)
    responded_at = models.DateTimeField(null=True, blank=True)
    reviewed_by = models.UUIDField(null=True, blank=True)
    review_note = models.CharField(max_length=500, blank=True)
    owner_id = models.UUIDField()
    created_by = models.UUIDField()


# ----------------------------------------------------------------------------- complaints
class Complaint(Base):
    number = models.CharField(max_length=30, unique=True)
    complaint_type = models.CharField(max_length=30)
    severity = models.CharField(max_length=30)
    customer_id = models.UUIDField(null=True, blank=True, db_index=True)
    customer_name = models.CharField(max_length=200, blank=True)
    product_id = models.UUIDField(null=True, blank=True, db_index=True)
    sales_order_id = models.UUIDField(null=True, blank=True)
    delivery_id = models.UUIDField(null=True, blank=True)
    project_id = models.UUIDField(null=True, blank=True)
    lot_number = models.CharField(max_length=60, blank=True)
    description = models.TextField()
    received_on = models.DateField()
    channel = models.CharField(max_length=20, blank=True)
    investigator_id = models.UUIDField(db_index=True)
    findings = models.TextField(blank=True)
    response_text = models.TextField(blank=True)
    responded_on = models.DateField(null=True, blank=True)
    resolution = models.CharField(max_length=500, blank=True)
    status = models.CharField(max_length=20, default="RECEIVED", db_index=True)  # RECEIVED INVESTIGATING RESPONDED CLOSED
    customer_confirmed_on = models.DateField(null=True, blank=True)
    capa_id = models.UUIDField(null=True, blank=True)
    is_recurring = models.BooleanField(default=False)
    recorded_by = models.UUIDField()


# ----------------------------------------------------------------------------- risks
class Risk(Base):
    number = models.CharField(max_length=30, unique=True)
    title = models.CharField(max_length=200)
    area = models.CharField(max_length=30)
    category = models.CharField(max_length=30, blank=True)
    causes = models.TextField(blank=True)
    consequences = models.TextField(blank=True)
    likelihood = models.PositiveSmallIntegerField()
    impact = models.PositiveSmallIntegerField()
    residual_likelihood = models.PositiveSmallIntegerField(null=True, blank=True)
    residual_impact = models.PositiveSmallIntegerField(null=True, blank=True)
    owner_id = models.UUIDField(db_index=True)
    status = models.CharField(max_length=20, default="IDENTIFIED", db_index=True)  # IDENTIFIED MITIGATING ACCEPTED CLOSED
    next_review_on = models.DateField(null=True, blank=True, db_index=True)
    last_reminder_on = models.DateField(null=True, blank=True)
    product_id = models.UUIDField(null=True, blank=True)
    supplier_id = models.UUIDField(null=True, blank=True)
    project_id = models.UUIDField(null=True, blank=True)
    links = models.JSONField(default=list)  # [{"type": "AUDIT", "id": "..."}]
    created_by = models.UUIDField()

    class Meta:
        constraints = [models.CheckConstraint(condition=Q(likelihood__gte=1, likelihood__lte=5, impact__gte=1, impact__lte=5), name="qm_risk_scale")]

    @property
    def score(self):
        return self.likelihood * self.impact

    @property
    def residual_score(self):
        return self.residual_likelihood * self.residual_impact if self.residual_likelihood and self.residual_impact else None


# ----------------------------------------------------------------------------- calibration
class Equipment(Base):
    tag = models.CharField(max_length=40, unique=True)
    name = models.CharField(max_length=200)
    manufacturer = models.CharField(max_length=120, blank=True)
    model = models.CharField(max_length=120, blank=True)
    serial_number = models.CharField(max_length=120, blank=True)
    department_id = models.UUIDField(null=True, blank=True)
    location = models.CharField(max_length=200, blank=True)
    responsible_id = models.UUIDField(db_index=True)
    asset_id = models.UUIDField(null=True, blank=True)
    interval_days = models.PositiveIntegerField()
    last_calibrated_on = models.DateField(null=True, blank=True)
    next_due_on = models.DateField(null=True, blank=True, db_index=True)
    status = models.CharField(max_length=20, default="ACTIVE")  # ACTIVE ON_HOLD RETIRED
    hold_reason = models.CharField(max_length=300, blank=True)
    last_reminder_on = models.DateField(null=True, blank=True)

    class Meta:
        constraints = [models.CheckConstraint(condition=Q(interval_days__gt=0), name="qm_equipment_interval")]


class Calibration(Base):
    equipment = models.ForeignKey(Equipment, on_delete=models.PROTECT, related_name="calibrations")
    status = models.CharField(max_length=20, default="SCHEDULED")  # SCHEDULED DONE CANCELLED
    scheduled_for = models.DateField()
    performed_on = models.DateField(null=True, blank=True)
    performed_by = models.CharField(max_length=200, blank=True)
    result = models.CharField(max_length=10, blank=True)  # PASS FAIL ADJUSTED
    as_found = models.CharField(max_length=500, blank=True)
    certificate_ref = models.CharField(max_length=100, blank=True)
    out_of_tolerance = models.BooleanField(default=False)
    next_due_on = models.DateField(null=True, blank=True)
    recorded_by = models.UUIDField(null=True, blank=True)


class ImpactAssessment(Base):
    """Inspections that relied on equipment found out of calibration: each has to be judged before the equipment returns to service."""
    calibration = models.ForeignKey(Calibration, on_delete=models.CASCADE, related_name="impacts")
    inspection = models.ForeignKey(Inspection, on_delete=models.PROTECT, related_name="+")
    status = models.CharField(max_length=20, default="PENDING")  # PENDING NOT_AFFECTED REINSPECT
    note = models.CharField(max_length=500, blank=True)
    assessed_by = models.UUIDField(null=True, blank=True)
    assessed_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        constraints = [models.UniqueConstraint(fields=["calibration", "inspection"], name="qm_impact_once")]


# ----------------------------------------------------------------------------- continuous improvement
class Suggestion(Base):
    number = models.CharField(max_length=30, unique=True)
    title = models.CharField(max_length=200)
    description = models.TextField()
    category = models.CharField(max_length=30, blank=True)
    submitted_by = models.UUIDField()
    status = models.CharField(max_length=20, default="SUBMITTED")  # SUBMITTED ACCEPTED REJECTED CONVERTED
    decision_note = models.CharField(max_length=500, blank=True)
    decided_by = models.UUIDField(null=True, blank=True)


class Initiative(Base):
    number = models.CharField(max_length=30, unique=True)
    title = models.CharField(max_length=200)
    description = models.TextField(blank=True)
    suggestion = models.ForeignKey(Suggestion, null=True, blank=True, on_delete=models.PROTECT, related_name="initiatives")
    owner_id = models.UUIDField(db_index=True)
    target_date = models.DateField()
    objective = models.ForeignKey(Objective, null=True, blank=True, on_delete=models.SET_NULL, related_name="initiatives")
    capa_id = models.UUIDField(null=True, blank=True)
    metric = models.CharField(max_length=60, blank=True)
    baseline_value = models.DecimalField(null=True, blank=True, **QTY)
    target_value = models.DecimalField(null=True, blank=True, **QTY)
    result_value = models.DecimalField(null=True, blank=True, **QTY)
    progress = models.PositiveSmallIntegerField(default=0)
    status = models.CharField(max_length=20, default="PROPOSED", db_index=True)  # PROPOSED APPROVED IN_PROGRESS COMPLETED CANCELLED
    completed_on = models.DateField(null=True, blank=True)
    lessons_learned = models.TextField(blank=True)
    created_by = models.UUIDField()

    class Meta:
        constraints = [models.CheckConstraint(condition=Q(progress__lte=100), name="qm_initiative_progress")]


# ----------------------------------------------------------------------------- project and construction quality
class InspectionRequest(Base):
    number = models.CharField(max_length=30, unique=True)
    project_id = models.UUIDField(db_index=True)
    plan = models.ForeignKey(InspectionPlan, null=True, blank=True, on_delete=models.PROTECT, related_name="requests")
    kind = models.CharField(max_length=12, default="WORK")  # WORK MATERIAL COMPLETION HANDOVER
    activity_task_id = models.UUIDField(null=True, blank=True, db_index=True)
    location = models.CharField(max_length=200, blank=True)
    drawing_document_id = models.UUIDField(null=True, blank=True)
    contractor = models.CharField(max_length=200, blank=True)
    requested_by = models.UUIDField()
    requested_for = models.DateField()
    hold_point = models.BooleanField(default=False)  # dependent activities may not start until this is approved
    status = models.CharField(max_length=20, default="REQUESTED", db_index=True)  # REQUESTED SCHEDULED INSPECTED APPROVED REJECTED CANCELLED
    inspection = models.ForeignKey(Inspection, null=True, blank=True, on_delete=models.PROTECT, related_name="+")
    decided_by = models.UUIDField(null=True, blank=True)
    decision_note = models.CharField(max_length=500, blank=True)


class PunchItem(Base):
    number = models.CharField(max_length=30, unique=True)
    project_id = models.UUIDField(db_index=True)
    location = models.CharField(max_length=200, blank=True)
    description = models.CharField(max_length=500)
    severity = models.CharField(max_length=8, default="MINOR")  # MINOR MAJOR
    assigned_to = models.UUIDField(null=True, blank=True)
    contractor = models.CharField(max_length=200, blank=True)
    due_date = models.DateField(null=True, blank=True, db_index=True)
    status = models.CharField(max_length=20, default="OPEN", db_index=True)  # OPEN FIXED VERIFIED CLOSED
    request = models.ForeignKey(InspectionRequest, null=True, blank=True, on_delete=models.SET_NULL, related_name="punch_items")
    fixed_note = models.CharField(max_length=500, blank=True)
    verified_by = models.UUIDField(null=True, blank=True)
    raised_by = models.UUIDField()
