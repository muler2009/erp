"""Periodic review, expiry tracking and the daily job."""
from datetime import timedelta

from django.db import transaction

from modules.documents import access, approval, core, distribution
from modules.documents import models as m
from platform_core.authorization.models import RolePermission
from platform_core.authorization.services import models_q_valid
from platform_core.organizations import services as org
from platform_core.organizations.models import Department
from shared.api.errors import DomainError, ValidationFailed
from shared.notifications.services import notify

OUTCOMES = ("NO_CHANGE", "REVISION_REQUIRED", "OBSOLETE")


def users_with_permission(code):
    from django.utils import timezone
    from platform_core.authorization.models import RoleAssignment
    from django.db.models import Q
    roles = RolePermission.objects.filter(permission_code=code).values_list("role_id", flat=True)
    return {r for r in RoleAssignment.objects.filter(role_id__in=roles, scope_type="TENANT").filter(Q(valid_to__isnull=True) | Q(valid_to__gt=timezone.now())).values_list("user_id", flat=True)}


def _escalation_targets(doc):
    head = Department.objects.filter(pk=doc.department_id).values_list("head_user_id", flat=True).first() if doc.department_id else None
    return {head} if head else users_with_permission("documents.admin")


@transaction.atomic
def record_review(actor, doc_id, *, outcome, comment=""):
    d = core.lock_doc(doc_id)
    review = d.reviews.select_for_update().filter(outcome="").order_by("due_on").first()
    allowed = access.can(actor, d, "REVIEW") or (review and review.reviewer_id == actor)
    if not allowed:
        raise core.nf()
    if outcome not in OUTCOMES:
        raise ValidationFailed("outcome must be NO_CHANGE, REVISION_REQUIRED or OBSOLETE.", code="invalid_fields")
    if d.status != "PUBLISHED":
        raise DomainError("Only a published document is reviewed.", code="invalid_state_transition")
    if outcome != "NO_CHANGE" and not (comment or "").strip():
        raise ValidationFailed("A comment is required when the document needs revision or is obsolete.", code="comment_required")
    today = core.today()
    if review is None:
        review = m.DocumentReview.objects.create(document=d, due_on=d.next_review_date or today, reviewer_id=actor)
    review.outcome, review.reviewed_on, review.comment, review.reviewer_id = outcome, today, comment[:500], actor
    review.save()
    d.last_reviewed_on = today
    d.review_notified_on = None
    d.save(update_fields=["last_reviewed_on", "review_notified_on", "updated_at"])
    core.event(d, "REVIEWED", actor, note=f"{outcome}: {comment}")
    if outcome == "NO_CHANGE":
        d.next_review_date = today + timedelta(days=d.category.review_interval_days) if d.category.review_interval_days else None
        d.save(update_fields=["next_review_date", "updated_at"])
    elif outcome == "REVISION_REQUIRED":
        if not d.versions.filter(status__in=("DRAFT", "UNDER_REVIEW", "CHANGES_REQUESTED", "APPROVED")).exclude(pk=d.current_version_id).exists():
            core._new_version(actor, d, change_reason=f"Periodic review: {comment}")
    else:
        approval._obsolete(d, actor, f"Review outcome: {comment}")
    return review


def daily(today):
    """Open reviews and remind owners, escalate overdue reviews once, warn about expiry, chase acknowledgements."""
    notice = int(org.get_setting("documents.review_notice_days", 30))
    expiry_notice = int(org.get_setting("documents.expiry_notice_days", 30))
    out = {"reviews_opened": 0, "review_reminders": 0, "review_escalations": 0, "expiry_notices": 0, "ack_reminders": 0}
    with transaction.atomic():
        for d in m.Document.objects.select_for_update(of=("self",)).filter(status="PUBLISHED", deleted_at__isnull=True, next_review_date__isnull=False, next_review_date__lte=today + timedelta(days=notice)):
            review = d.reviews.filter(outcome="").first()
            created = review is None
            if created:
                review = m.DocumentReview.objects.create(document=d, due_on=d.next_review_date, reviewer_id=d.owner_id)
            out["reviews_opened"] += created
            overdue = review.due_on < today
            if not d.review_notified_on or (today - d.review_notified_on).days >= 7:
                notify([review.reviewer_id], "documents.review_due", f"{'Overdue review' if overdue else 'Review due'}: {d.reference} {d.title}", f"Due {review.due_on}", ref_type="documents.document", ref_id=str(d.id))
                d.review_notified_on = today
                d.save(update_fields=["review_notified_on", "updated_at"])
                out["review_reminders"] += 1
            if overdue and review.escalated_at is None:
                notify(_escalation_targets(d), "documents.review_overdue", f"Review overdue: {d.reference} {d.title}", f"Was due {review.due_on}", ref_type="documents.document", ref_id=str(d.id))
                from django.utils import timezone
                review.escalated_at = timezone.now()
                review.save(update_fields=["escalated_at", "updated_at"])
                out["review_escalations"] += 1
        for d in m.Document.objects.select_for_update(of=("self",)).filter(status="PUBLISHED", deleted_at__isnull=True, expiry_date__isnull=False, expiry_date__lte=today + timedelta(days=expiry_notice)):
            if d.expiry_notified_on and (today - d.expiry_notified_on).days < 7:
                continue
            gone = d.expiry_date < today
            targets = {d.owner_id} | (_escalation_targets(d) if gone else set())
            notify(targets, "documents.expired" if gone else "documents.expiring", f"{'Expired' if gone else 'Expires ' + str(d.expiry_date)}: {d.reference} {d.title}", ref_type="documents.document", ref_id=str(d.id))
            d.expiry_notified_on = today
            d.save(update_fields=["expiry_notified_on", "updated_at"])
            out["expiry_notices"] += 1
        out["ack_reminders"] = distribution.remind(today)
    return out
