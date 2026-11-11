"""Document management. Every record here lives in the tenant schema. Files themselves are shared StoredFile rows
(ref_type "documents.version"); this module decides who may read them."""
import uuid

from django.db import models
from django.db.models import F, Q
from django.utils import timezone


class Base(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    created_at = models.DateTimeField(default=timezone.now, db_index=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        abstract = True


DOC_TYPES = ["POLICY", "PROCEDURE", "WORK_INSTRUCTION", "FORM", "TEMPLATE", "MANUAL", "CONTRACT", "REPORT", "DRAWING", "SPECIFICATION",
             "CERTIFICATE", "INSPECTION_RECORD", "PROJECT_DOCUMENT", "EMPLOYEE_RECORD", "CORRESPONDENCE", "SUBMITTAL", "OTHER"]
STATUSES = ["DRAFT", "UNDER_REVIEW", "CHANGES_REQUESTED", "APPROVED", "PUBLISHED", "OBSOLETE", "ARCHIVED"]


def _choices(values):
    return [(v, v) for v in values]


class Classification(Base):
    """Confidentiality level. Rank 1-2 are open to ordinary readers, 3 needs the confidential permission or a grant, 4 only a grant."""
    code = models.CharField(max_length=20, unique=True)
    name = models.CharField(max_length=80)
    rank = models.PositiveSmallIntegerField()
    is_active = models.BooleanField(default=True)

    class Meta:
        constraints = [models.CheckConstraint(condition=Q(rank__gte=1, rank__lte=4), name="doc_class_rank")]


class Category(Base):
    code = models.CharField(max_length=20, unique=True)
    name = models.CharField(max_length=120)
    parent = models.ForeignKey("self", null=True, blank=True, on_delete=models.PROTECT, related_name="children")
    doc_type = models.CharField(max_length=20, choices=_choices(DOC_TYPES), default="OTHER")
    number_prefix = models.CharField(max_length=12)
    number_padding = models.PositiveSmallIntegerField(default=4)
    counter = models.PositiveIntegerField(default=0)
    is_controlled = models.BooleanField(default=True)  # controlled documents must be approved before they are published
    requires_expiry = models.BooleanField(default=False)
    review_interval_days = models.PositiveIntegerField(null=True, blank=True)
    retention_years = models.PositiveSmallIntegerField(null=True, blank=True)
    default_classification = models.ForeignKey(Classification, null=True, blank=True, on_delete=models.PROTECT, related_name="+")
    required_metadata = models.JSONField(default=list, blank=True)
    is_active = models.BooleanField(default=True)

    class Meta:
        constraints = [models.CheckConstraint(condition=~Q(parent=F("id")), name="doc_cat_not_own_parent")]


class Folder(Base):
    name = models.CharField(max_length=120)
    parent = models.ForeignKey("self", null=True, blank=True, on_delete=models.PROTECT, related_name="children")
    department_id = models.UUIDField(null=True, blank=True, db_index=True)
    project_id = models.UUIDField(null=True, blank=True, db_index=True)
    is_active = models.BooleanField(default=True)

    class Meta:
        constraints = [models.UniqueConstraint(fields=["parent", "name"], name="doc_folder_unique_name"),
                       models.UniqueConstraint(fields=["name"], condition=Q(parent__isnull=True), name="doc_folder_unique_root")]


class Document(Base):
    reference = models.CharField(max_length=40, unique=True)
    title = models.CharField(max_length=250)
    description = models.TextField(blank=True)
    category = models.ForeignKey(Category, on_delete=models.PROTECT, related_name="documents")
    folder = models.ForeignKey(Folder, null=True, blank=True, on_delete=models.PROTECT, related_name="documents")
    classification = models.ForeignKey(Classification, on_delete=models.PROTECT, related_name="documents")
    status = models.CharField(max_length=20, choices=_choices(STATUSES), default="DRAFT", db_index=True)
    owner_id = models.UUIDField(db_index=True)
    department_id = models.UUIDField(null=True, blank=True, db_index=True)
    project_id = models.UUIDField(null=True, blank=True, db_index=True)
    origin = models.CharField(max_length=200, blank=True)
    tags = models.JSONField(default=list, blank=True)
    metadata = models.JSONField(default=dict, blank=True)
    direction = models.CharField(max_length=10, default="INTERNAL")  # INTERNAL | INCOMING | OUTGOING
    is_template = models.BooleanField(default=False)
    template = models.ForeignKey("self", null=True, blank=True, on_delete=models.PROTECT, related_name="instances")
    template_version = models.ForeignKey("DocumentVersion", null=True, blank=True, on_delete=models.PROTECT, related_name="+")
    current_version = models.ForeignKey("DocumentVersion", null=True, blank=True, on_delete=models.SET_NULL, related_name="+")
    effective_date = models.DateField(null=True, blank=True)
    expiry_date = models.DateField(null=True, blank=True, db_index=True)
    next_review_date = models.DateField(null=True, blank=True, db_index=True)
    last_reviewed_on = models.DateField(null=True, blank=True)
    review_notified_on = models.DateField(null=True, blank=True)
    expiry_notified_on = models.DateField(null=True, blank=True)
    archived_at = models.DateTimeField(null=True, blank=True)
    archived_by = models.UUIDField(null=True, blank=True)
    retention_until = models.DateField(null=True, blank=True)
    legal_hold = models.BooleanField(default=False)
    disposed_at = models.DateTimeField(null=True, blank=True)
    deleted_at = models.DateTimeField(null=True, blank=True)
    created_by = models.UUIDField()

    class Meta:
        indexes = [models.Index(fields=["status", "category"], name="doc_status_cat_idx")]
        constraints = [models.CheckConstraint(condition=Q(expiry_date__isnull=True) | Q(effective_date__isnull=True) | Q(expiry_date__gte=F("effective_date")), name="doc_expiry_after_effective")]


class DocumentVersion(Base):
    document = models.ForeignKey(Document, on_delete=models.PROTECT, related_name="versions")
    number = models.PositiveIntegerField()
    label = models.CharField(max_length=20)
    status = models.CharField(max_length=20, default="DRAFT", db_index=True)  # DRAFT UNDER_REVIEW CHANGES_REQUESTED APPROVED PUBLISHED SUPERSEDED OBSOLETE
    change_reason = models.CharField(max_length=500, blank=True)
    file_id = models.UUIDField(null=True, blank=True)
    file_name = models.CharField(max_length=255, blank=True)
    sha256 = models.CharField(max_length=64, blank=True)
    size = models.PositiveBigIntegerField(default=0)
    created_by = models.UUIDField()
    submitted_at = models.DateTimeField(null=True, blank=True)
    approved_at = models.DateTimeField(null=True, blank=True)
    published_at = models.DateTimeField(null=True, blank=True)
    published_by = models.UUIDField(null=True, blank=True)
    superseded_at = models.DateTimeField(null=True, blank=True)
    workflow_instance_id = models.UUIDField(null=True, blank=True)
    rejection_note = models.CharField(max_length=500, blank=True)

    class Meta:
        constraints = [
            models.UniqueConstraint(fields=["document", "number"], name="doc_version_number"),
            models.UniqueConstraint(fields=["document"], condition=Q(status="PUBLISHED"), name="doc_one_published_version"),
        ]


class VersionText(models.Model):
    version = models.OneToOneField(DocumentVersion, primary_key=True, on_delete=models.CASCADE, related_name="text")
    content = models.TextField()


class DocumentLink(Base):
    document = models.ForeignKey(Document, on_delete=models.CASCADE, related_name="links")
    link_type = models.CharField(max_length=40)
    ref_id = models.CharField(max_length=64)
    label = models.CharField(max_length=200, blank=True)
    created_by = models.UUIDField()

    class Meta:
        constraints = [models.UniqueConstraint(fields=["document", "link_type", "ref_id"], name="doc_link_unique")]
        indexes = [models.Index(fields=["link_type", "ref_id"], name="doc_link_ref_idx")]


class DocumentEvent(models.Model):
    """Append-only lifecycle, registration and distribution history."""
    id = models.BigAutoField(primary_key=True)
    document = models.ForeignKey(Document, on_delete=models.PROTECT, related_name="events")
    version = models.ForeignKey(DocumentVersion, null=True, blank=True, on_delete=models.PROTECT, related_name="events")
    action = models.CharField(max_length=30, db_index=True)
    from_status = models.CharField(max_length=20, blank=True)
    to_status = models.CharField(max_length=20, blank=True)
    actor_id = models.UUIDField(null=True, blank=True)
    note = models.CharField(max_length=500, blank=True)
    at = models.DateTimeField(default=timezone.now, db_index=True)


class DocumentReview(Base):
    document = models.ForeignKey(Document, on_delete=models.CASCADE, related_name="reviews")
    due_on = models.DateField(db_index=True)
    reviewer_id = models.UUIDField()
    outcome = models.CharField(max_length=20, blank=True)  # NO_CHANGE | REVISION_REQUIRED | OBSOLETE once done
    reviewed_on = models.DateField(null=True, blank=True)
    comment = models.CharField(max_length=500, blank=True)
    escalated_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        constraints = [models.UniqueConstraint(fields=["document"], condition=Q(outcome=""), name="doc_one_open_review")]


class Distribution(Base):
    document = models.ForeignKey(Document, on_delete=models.CASCADE, related_name="distributions")
    version = models.ForeignKey(DocumentVersion, on_delete=models.PROTECT, related_name="distributions")
    target_type = models.CharField(max_length=12)  # USER | DEPARTMENT | ROLE
    target_id = models.CharField(max_length=64)
    requires_acknowledgement = models.BooleanField(default=False)
    due_date = models.DateField(null=True, blank=True)
    distributed_by = models.UUIDField()


class Acknowledgement(Base):
    document = models.ForeignKey(Document, on_delete=models.CASCADE, related_name="acknowledgements")
    version = models.ForeignKey(DocumentVersion, on_delete=models.PROTECT, related_name="acknowledgements")
    user_id = models.UUIDField(db_index=True)
    status = models.CharField(max_length=12, default="PENDING")  # PENDING | ACKNOWLEDGED | WITHDRAWN
    due_date = models.DateField(null=True, blank=True)
    acknowledged_at = models.DateTimeField(null=True, blank=True)
    last_reminder_on = models.DateField(null=True, blank=True)

    class Meta:
        constraints = [models.UniqueConstraint(fields=["version", "user_id"], name="doc_ack_once_per_version")]


class AccessGrant(Base):
    document = models.ForeignKey(Document, null=True, blank=True, on_delete=models.CASCADE, related_name="grants")
    folder = models.ForeignKey(Folder, null=True, blank=True, on_delete=models.CASCADE, related_name="grants")
    subject_type = models.CharField(max_length=12)  # USER | DEPARTMENT | ROLE | PROJECT
    subject_id = models.CharField(max_length=64)
    actions = models.JSONField(default=list)
    expires_at = models.DateTimeField(null=True, blank=True)
    granted_by = models.UUIDField()
    revoked_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        constraints = [models.CheckConstraint(condition=(Q(document__isnull=False) & Q(folder__isnull=True)) | (Q(document__isnull=True) & Q(folder__isnull=False)), name="doc_grant_one_target")]


class AccessLog(models.Model):
    id = models.BigAutoField(primary_key=True)
    document = models.ForeignKey(Document, on_delete=models.PROTECT, related_name="access_log")
    version = models.ForeignKey(DocumentVersion, null=True, blank=True, on_delete=models.PROTECT, related_name="+")
    user_id = models.UUIDField(db_index=True)
    action = models.CharField(max_length=12)  # VIEW | DOWNLOAD
    at = models.DateTimeField(default=timezone.now, db_index=True)


class ExternalRecord(Base):
    """Correspondence, submissions and submittals exchanged with outside parties."""
    document = models.OneToOneField(Document, on_delete=models.CASCADE, related_name="external")
    direction = models.CharField(max_length=10)  # INCOMING | OUTGOING
    party_type = models.CharField(max_length=12)  # SUPPLIER CONTRACTOR CONSULTANT CUSTOMER AUTHORITY OTHER
    party_name = models.CharField(max_length=200)
    party_id = models.CharField(max_length=64, blank=True)
    sender = models.CharField(max_length=200, blank=True)
    recipient = models.CharField(max_length=200, blank=True)
    party_reference = models.CharField(max_length=100, blank=True)
    received_on = models.DateField(null=True, blank=True)
    sent_on = models.DateField(null=True, blank=True)
    response_due_on = models.DateField(null=True, blank=True)
    responded_on = models.DateField(null=True, blank=True)
    submission_status = models.CharField(max_length=14, default="RECEIVED")  # RECEIVED UNDER_REVIEW ACCEPTED REJECTED RESUBMITTED SENT
    contract_ref = models.CharField(max_length=100, blank=True)
    resubmission_of = models.ForeignKey("self", null=True, blank=True, on_delete=models.PROTECT, related_name="resubmissions")


class ReviewComment(Base):
    document = models.ForeignKey(Document, on_delete=models.CASCADE, related_name="comments")
    version = models.ForeignKey(DocumentVersion, null=True, blank=True, on_delete=models.PROTECT, related_name="+")
    author_id = models.UUIDField()
    comment = models.TextField()
    response = models.TextField(blank=True)
    responded_by = models.UUIDField(null=True, blank=True)
    status = models.CharField(max_length=10, default="OPEN")  # OPEN | RESOLVED


class Transmittal(Base):
    number = models.CharField(max_length=40, unique=True)
    project_id = models.UUIDField(null=True, blank=True, db_index=True)
    direction = models.CharField(max_length=10)  # OUTGOING | INCOMING
    party_name = models.CharField(max_length=200)
    purpose = models.CharField(max_length=20, default="FOR_INFORMATION")  # FOR_INFORMATION FOR_REVIEW FOR_APPROVAL FOR_CONSTRUCTION AS_BUILT
    sent_on = models.DateField()
    response_due_on = models.DateField(null=True, blank=True)
    notes = models.CharField(max_length=500, blank=True)
    created_by = models.UUIDField()


class TransmittalItem(Base):
    transmittal = models.ForeignKey(Transmittal, on_delete=models.CASCADE, related_name="items")
    document = models.ForeignKey(Document, on_delete=models.PROTECT, related_name="+")
    version = models.ForeignKey(DocumentVersion, on_delete=models.PROTECT, related_name="+")

    class Meta:
        constraints = [models.UniqueConstraint(fields=["transmittal", "document"], name="doc_transmittal_item_once")]


class Rfi(Base):
    number = models.CharField(max_length=40, unique=True)
    project_id = models.UUIDField(db_index=True)
    subject = models.CharField(max_length=250)
    question = models.TextField()
    raised_by = models.UUIDField()
    assigned_to = models.UUIDField()
    due_date = models.DateField(null=True, blank=True)
    status = models.CharField(max_length=10, default="OPEN")  # OPEN ANSWERED CLOSED
    response = models.TextField(blank=True)
    answered_at = models.DateTimeField(null=True, blank=True)
    document = models.ForeignKey(Document, null=True, blank=True, on_delete=models.SET_NULL, related_name="+")


class DisposalRequest(Base):
    document = models.ForeignKey(Document, on_delete=models.PROTECT, related_name="disposals")
    requested_by = models.UUIDField()
    reason = models.CharField(max_length=500)
    status = models.CharField(max_length=10, default="PENDING")  # PENDING APPROVED REJECTED EXECUTED
    decided_by = models.UUIDField(null=True, blank=True)
    decided_at = models.DateTimeField(null=True, blank=True)
    decision_note = models.CharField(max_length=500, blank=True)
    executed_at = models.DateTimeField(null=True, blank=True)
    snapshot = models.JSONField(default=dict)  # reference, title, hashes: evidence that survives the content


class SavedSearch(Base):
    user_id = models.UUIDField(db_index=True)
    name = models.CharField(max_length=100)
    params = models.JSONField(default=dict)

    class Meta:
        constraints = [models.UniqueConstraint(fields=["user_id", "name"], name="doc_saved_search_name")]


class Favorite(Base):
    user_id = models.UUIDField(db_index=True)
    document = models.ForeignKey(Document, on_delete=models.CASCADE, related_name="+")

    class Meta:
        constraints = [models.UniqueConstraint(fields=["user_id", "document"], name="doc_favorite_once")]
