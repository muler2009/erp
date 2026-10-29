"""Talent and employee-relations services: recruitment, performance, learning, cases, policies, reimbursements."""
from datetime import date, timedelta
from decimal import Decimal

from django.db import IntegrityError, transaction
from django.db.models import Avg, Q
from django.utils import timezone

from modules.hr import models as m
from modules.hr import services as core
from modules.hr.services import _404, _dec, _get, add_months, authz, log_event
from platform_core.audit.services import record_tenant_event
from shared.api.errors import DomainError, ValidationFailed
from shared.sequences import services as sequences
from shared.tenancy import current_tenant

ZERO = Decimal("0")


def _need(actor_id, code):
    if not authz.has_permission(actor_id, code):
        raise DomainError("You do not have permission for this action.", code="permission_denied", status_code=403)


def _me(user_id):
    try:
        return core.employee_for(user_id)
    except DomainError:
        return None


def _bad(msg, code="invalid_request"):
    return ValidationFailed(msg, code=code)


def _state(msg="This action is not allowed in the current state."):
    return DomainError(msg, code="invalid_state_transition")


def _audit(event, actor_id, obj, **meta):
    record_tenant_event(current_tenant(), event, actor_user_id=actor_id, target_type=type(obj).__name__, target_id=obj.id, metadata={k: str(v) for k, v in meta.items()})


# ============================================================================= recruitment
@transaction.atomic
def create_requisition(actor_id, *, title, justification, headcount=1, department_id=None, position_id=None):
    _need(actor_id, "hr.recruitment.manage")
    if not (title or "").strip() or not (justification or "").strip() or int(headcount) < 1:
        raise _bad("A title, a justification and a positive headcount are required.", "invalid_requisition")
    return m.JobRequisition.objects.create(number=sequences.next_number("hr.requisition", for_type="JobRequisition"), title=title.strip()[:150], justification=justification.strip()[:500], headcount=int(headcount), department_id=department_id, position_id=position_id, requested_by=actor_id)


@transaction.atomic
def submit_requisition(actor_id, req_id):
    _need(actor_id, "hr.recruitment.manage")
    r = _get(m.JobRequisition, req_id, "Requisition", lock=True)
    if r.status not in ("DRAFT", "REJECTED"):
        raise _state()
    r.status = "PENDING"
    r.save(update_fields=["status", "updated_at"])
    return r


@transaction.atomic
def decide_requisition(actor_id, req_id, *, approve, note=""):
    _need(actor_id, "hr.recruitment.approve")
    r = _get(m.JobRequisition, req_id, "Requisition", lock=True)
    if r.status != "PENDING":
        raise _state()
    if r.requested_by == actor_id:
        raise DomainError("Separation of duties: you cannot approve your own requisition.", code="separation_of_duties", status_code=403)
    if not approve and not (note or "").strip():
        raise _bad("A note is required to reject.", "reason_required")
    r.status, r.decided_by, r.decision_note = ("APPROVED" if approve else "REJECTED"), actor_id, (note or "")[:300]
    r.save()
    _audit("hr.requisition.decided", actor_id, r, approved=approve)
    return r


@transaction.atomic
def close_requisition(actor_id, req_id):
    _need(actor_id, "hr.recruitment.manage")
    r = _get(m.JobRequisition, req_id, "Requisition", lock=True)
    if r.status != "APPROVED":
        raise _state()
    r.status = "CLOSED"
    r.save(update_fields=["status", "updated_at"])
    m.Candidate.objects.filter(requisition=r, stage__in=["APPLIED", "SCREENING", "INTERVIEW", "OFFER"]).update(stage="REJECTED", reason="Requisition closed")
    return r


@transaction.atomic
def add_candidate(actor_id, req_id, *, name, email, phone="", source=""):
    _need(actor_id, "hr.recruitment.manage")
    r = _get(m.JobRequisition, req_id, "Requisition", lock=True)
    if r.status != "APPROVED":
        raise DomainError("Candidates can only be added to an open, approved requisition.", code="requisition_not_open")
    if not (name or "").strip() or "@" not in (email or ""):
        raise _bad("A name and a valid email are required.", "invalid_candidate")
    try:
        with transaction.atomic():
            return m.Candidate.objects.create(requisition=r, name=name.strip()[:150], email=email.strip().lower(), phone=phone[:40], source=source[:60])
    except IntegrityError:
        raise DomainError("This candidate already applied for this requisition.", code="duplicate_candidate")


NEXT = {"APPLIED": ["SCREENING"], "SCREENING": ["INTERVIEW"], "INTERVIEW": []}


@transaction.atomic
def move_candidate(actor_id, candidate_id, stage, reason=""):
    _need(actor_id, "hr.recruitment.manage")
    c = _get(m.Candidate, candidate_id, "Candidate", lock=True)
    if stage in ("REJECTED", "WITHDRAWN"):
        if c.stage in ("HIRED", "REJECTED", "WITHDRAWN"):
            raise _state()
        if not (reason or "").strip():
            raise _bad("A reason is required.", "reason_required")
        m.Interview.objects.filter(candidate=c, status="SCHEDULED").update(status="CANCELLED")
        m.Offer.objects.filter(candidate=c, status__in=["DRAFT", "APPROVED"]).update(status="WITHDRAWN")
        c.stage, c.reason = stage, reason[:300]
    elif stage in NEXT.get(c.stage, []):
        c.stage = stage
    else:
        raise _state(f"A candidate cannot go from {c.stage} to {stage}.")
    c.save()
    return c


@transaction.atomic
def schedule_interview(actor_id, candidate_id, *, interviewer_id, scheduled_at):
    _need(actor_id, "hr.recruitment.manage")
    c = _get(m.Candidate, candidate_id, "Candidate", lock=True)
    if c.stage not in ("SCREENING", "INTERVIEW"):
        raise _state("Interviews are scheduled after screening starts.")
    if not core._active_member(interviewer_id):
        raise _bad("The interviewer must be an active member.", "invalid_interviewer")
    c.stage = "INTERVIEW"
    c.save(update_fields=["stage", "updated_at"])
    return m.Interview.objects.create(candidate=c, interviewer_id=interviewer_id, scheduled_at=scheduled_at)


@transaction.atomic
def submit_feedback(user_id, interview_id, *, score, recommendation, feedback=""):
    i = _get(m.Interview, interview_id, "Interview", lock=True)
    if i.interviewer_id != user_id:
        raise _404("Interview")  # only the assigned interviewer sees and scores it
    if i.status != "SCHEDULED":
        raise _state()
    if int(score) not in range(1, 6) or recommendation not in ("HIRE", "NO_HIRE"):
        raise _bad("Score must be 1-5 and the recommendation HIRE or NO_HIRE.", "invalid_feedback")
    i.score, i.recommendation, i.feedback, i.status = int(score), recommendation, feedback[:2000], "DONE"
    i.save()
    return i


def scorecard(user_id, candidate_id):
    _need(user_id, "hr.recruitment.manage")
    c = _get(m.Candidate, candidate_id, "Candidate")
    done = c.interviews.filter(status="DONE")
    avg = done.aggregate(a=Avg("score"))["a"]
    return {"candidate": c.name, "stage": c.stage, "interviews": done.count(), "average_score": str(round(Decimal(str(avg)), 2)) if avg is not None else None, "hire_votes": done.filter(recommendation="HIRE").count(), "no_hire_votes": done.filter(recommendation="NO_HIRE").count()}


@transaction.atomic
def create_offer(actor_id, candidate_id, *, monthly_salary, currency, start_date):
    _need(actor_id, "hr.recruitment.manage")
    c = _get(m.Candidate, candidate_id, "Candidate", lock=True)
    if c.stage != "INTERVIEW" or not c.interviews.filter(status="DONE", recommendation="HIRE").exists():
        raise DomainError("An offer needs a completed interview with a HIRE recommendation.", code="offer_not_ready")
    salary = _dec(monthly_salary, "monthly_salary")
    if salary <= 0 or start_date < timezone.now().date():
        raise _bad("A positive salary and a future start date are required.", "invalid_offer")
    c.stage = "OFFER"
    c.save(update_fields=["stage", "updated_at"])
    return m.Offer.objects.create(candidate=c, monthly_salary=salary, currency=currency, start_date=start_date, created_by=actor_id)


@transaction.atomic
def approve_offer(actor_id, offer_id):
    _need(actor_id, "hr.recruitment.approve")
    o = _get(m.Offer, offer_id, "Offer", lock=True)
    if o.status != "DRAFT":
        raise _state()
    if o.created_by == actor_id:
        raise DomainError("Separation of duties: you cannot approve an offer you drafted.", code="separation_of_duties", status_code=403)
    o.status, o.approved_by = "APPROVED", actor_id
    o.save()
    return o


@transaction.atomic
def respond_offer(actor_id, offer_id, *, accept):
    _need(actor_id, "hr.recruitment.manage")
    o = _get(m.Offer, offer_id, "Offer", lock=True)
    if o.status != "APPROVED":
        raise _state("Only an approved offer can be answered.")
    o.status = "ACCEPTED" if accept else "DECLINED"
    o.save(update_fields=["status", "updated_at"])
    if not accept:
        c = o.candidate
        c.stage, c.reason = "REJECTED", "Offer declined"
        c.save()
    return o


@transaction.atomic
def hire_candidate(actor_id, candidate_id):
    """Turn an accepted offer into an employee record and contract (onboarding then follows the normal checklist)."""
    _need(actor_id, "hr.recruitment.manage")
    c = _get(m.Candidate, candidate_id, "Candidate", lock=True)
    offer = c.offers.filter(status="ACCEPTED").first()
    if c.stage != "OFFER" or offer is None:
        raise DomainError("The candidate has no accepted offer.", code="offer_not_accepted")
    first, _, last = c.name.strip().partition(" ")
    e = core.create_employee(actor_id, first_name=first, last_name=last or "-", hire_date=offer.start_date, email=c.email, phone=c.phone, department_id=c.requisition.department_id, position_id=c.requisition.position_id)
    core.add_contract(actor_id, e.id, start_date=offer.start_date, monthly_salary=offer.monthly_salary, currency=offer.currency)
    c.stage, c.employee = "HIRED", e
    c.save()
    req = c.requisition
    if req.candidates.filter(stage="HIRED").count() >= req.headcount:
        req.status = "CLOSED"
        req.save(update_fields=["status", "updated_at"])
        m.Candidate.objects.filter(requisition=req, stage__in=["APPLIED", "SCREENING", "INTERVIEW", "OFFER"]).update(stage="REJECTED", reason="Position filled")
    return e


def recruitment_funnel(user_id, req_id=None):
    _need(user_id, "hr.recruitment.manage")
    qs = m.Candidate.objects.all()
    if req_id:
        qs = qs.filter(requisition_id=req_id)
    out = {s: 0 for s in m.Candidate.Stage.values}
    for c in qs.values_list("stage", flat=True):
        out[c] += 1
    return out


# ============================================================================= performance
@transaction.atomic
def create_cycle(actor_id, *, name, start_date, end_date):
    _need(actor_id, "hr.performance.manage")
    if end_date < start_date or not (name or "").strip():
        raise _bad("A name and a valid period are required.", "invalid_cycle")
    try:
        with transaction.atomic():
            return m.ReviewCycle.objects.create(name=name.strip()[:100], start_date=start_date, end_date=end_date)
    except IntegrityError:
        raise DomainError("A cycle with this name exists.", code="duplicate_cycle")


@transaction.atomic
def activate_cycle(actor_id, cycle_id):
    """Opens the cycle and creates a review for every employee who was active in it (idempotent)."""
    _need(actor_id, "hr.performance.manage")
    cy = _get(m.ReviewCycle, cycle_id, "Cycle", lock=True)
    if cy.status == "CLOSED":
        raise _state()
    for e in m.Employee.objects.filter(status="ACTIVE", hire_date__lte=cy.end_date):
        m.PerformanceReview.objects.get_or_create(employee=e, cycle=cy)
    cy.status = "ACTIVE"
    cy.save(update_fields=["status", "updated_at"])
    return cy


@transaction.atomic
def close_cycle(actor_id, cycle_id):
    _need(actor_id, "hr.performance.manage")
    cy = _get(m.ReviewCycle, cycle_id, "Cycle", lock=True)
    if cy.status != "ACTIVE":
        raise _state()
    cy.status = "CLOSED"
    cy.save(update_fields=["status", "updated_at"])
    return cy


def _may_manage(user_id, e):
    return core.acts_as_manager(user_id, e) or authz.has_permission(user_id, "hr.performance.manage")


@transaction.atomic
def add_goal(actor_id, employee_id, cycle_id, *, title, weight):
    e = _get(m.Employee, employee_id, "Employee", lock=True)
    if not core.can_see(actor_id, e) or not _may_manage(actor_id, e) and e.user_id != actor_id:
        raise _404("Employee")
    cy = _get(m.ReviewCycle, cycle_id, "Cycle")
    if cy.status == "CLOSED":
        raise _state("The cycle is closed.")
    w = _dec(weight, "weight")
    used = sum((g.weight for g in m.Goal.objects.filter(employee=e, cycle=cy)), ZERO)
    if not (0 < w <= 100) or used + w > 100 or not (title or "").strip():
        raise _bad("A title is required and the goal weights of one cycle may not exceed 100%.", "invalid_goal")
    return m.Goal.objects.create(employee=e, cycle=cy, title=title.strip()[:200], weight=w)


@transaction.atomic
def update_progress(user_id, goal_id, progress):
    g = _get(m.Goal, goal_id, "Goal", lock=True)
    e = g.employee
    if e.user_id != user_id and not _may_manage(user_id, e):
        raise _404("Goal")
    if g.cycle.status == "CLOSED":
        raise _state("The cycle is closed.")
    p = _dec(progress, "progress")
    if not 0 <= p <= 100:
        raise _bad("Progress is a percentage between 0 and 100.", "invalid_progress")
    g.progress = p
    g.save(update_fields=["progress", "updated_at"])
    return g


def _review(user_id, review_id, lock=False):
    r = _get(m.PerformanceReview, review_id, "Review", lock=lock)
    e = r.employee
    if e.user_id != user_id and not _may_manage(user_id, e):
        raise _404("Review")
    return r


@transaction.atomic
def submit_self_review(user_id, review_id, *, rating, comment=""):
    r = _review(user_id, review_id, lock=True)
    if r.employee.user_id != user_id:
        raise _404("Review")
    if r.status != "PENDING_SELF" or r.cycle.status != "ACTIVE":
        raise _state()
    if int(rating) not in range(1, 6):
        raise _bad("Rating must be between 1 and 5.", "invalid_rating")
    r.self_rating, r.self_comment, r.status = int(rating), comment[:2000], "PENDING_MANAGER"
    r.save()
    return r


@transaction.atomic
def submit_manager_review(user_id, review_id, *, rating, comment=""):
    r = _review(user_id, review_id, lock=True)
    if r.employee.user_id == user_id:
        raise DomainError("Separation of duties: you cannot rate yourself as manager.", code="separation_of_duties", status_code=403)
    if not _may_manage(user_id, r.employee):
        raise _404("Review")
    if r.status != "PENDING_MANAGER" or r.cycle.status != "ACTIVE":
        raise _state("The employee's self-review comes first.")
    if int(rating) not in range(1, 6):
        raise _bad("Rating must be between 1 and 5.", "invalid_rating")
    goals = list(r.employee.goals.filter(cycle=r.cycle))
    total_w = sum((g.weight for g in goals), ZERO)
    r.goal_score = (sum((g.weight * g.progress for g in goals), ZERO) / total_w).quantize(Decimal("0.01")) if total_w else None
    r.manager_rating, r.manager_comment, r.reviewed_by, r.status = int(rating), comment[:2000], user_id, "COMPLETED"
    r.save()
    return r


@transaction.atomic
def acknowledge_review(user_id, review_id):
    r = _review(user_id, review_id, lock=True)
    if r.employee.user_id != user_id:
        raise _404("Review")
    if r.status != "COMPLETED":
        raise _state()
    r.status = "ACKNOWLEDGED"
    r.save(update_fields=["status", "updated_at"])
    return r


def reviews_visible(user_id, cycle_id=None):
    qs = m.PerformanceReview.objects.select_related("employee", "cycle")
    if cycle_id:
        qs = qs.filter(cycle_id=cycle_id)
    if authz.has_permission(user_id, "hr.performance.manage"):
        return qs
    return qs.filter(employee__in=core.visible_employees(user_id))


def hide_manager_part(user_id, r):
    """The employee sees the manager's rating only once the review is completed."""
    return r.employee.user_id == user_id and r.status == "PENDING_MANAGER"


# ============================================================================= learning
@transaction.atomic
def create_course(actor_id, *, code, name, hours=0, validity_months=None, mandatory=False, provider=""):
    _need(actor_id, "hr.learning.manage")
    if not (code or "").strip() or not (name or "").strip() or _dec(hours, "hours") < 0:
        raise _bad("A code, a name and non-negative hours are required.", "invalid_course")
    try:
        with transaction.atomic():
            return m.TrainingCourse.objects.create(code=code.strip().upper()[:30], name=name.strip()[:150], hours=_dec(hours, "hours"), validity_months=validity_months, mandatory=bool(mandatory), provider=provider[:100])
    except IntegrityError:
        raise DomainError("A course with this code exists.", code="duplicate_course")


@transaction.atomic
def record_training(actor_id, employee_id, course_id, *, completed_on, score=None):
    _need(actor_id, "hr.learning.manage")
    e = _get(m.Employee, employee_id, "Employee")
    c = _get(m.TrainingCourse, course_id, "Course")
    if completed_on > timezone.now().date() or completed_on < e.hire_date - timedelta(days=3650):
        raise _bad("The completion date cannot be in the future.", "invalid_date")
    exp = add_months(completed_on, c.validity_months) if c.validity_months else None
    try:
        with transaction.atomic():
            return m.TrainingRecord.objects.create(employee=e, course=c, completed_on=completed_on, expires_on=exp, score=score, recorded_by=actor_id)
    except IntegrityError:
        raise DomainError("This completion is already recorded.", code="duplicate_record")


def training_visible(user_id, employee=None):
    qs = m.TrainingRecord.objects.select_related("employee", "course")
    if not authz.has_permission(user_id, "hr.learning.manage") and not core.is_hr(user_id):
        qs = qs.filter(employee__in=core.visible_employees(user_id))
    return qs.filter(employee=employee) if employee else qs


def training_compliance(user_id, on_date=None, within_days=30):
    """Mandatory courses missing or expired per active employee, plus certificates about to expire."""
    _need(user_id, "hr.learning.manage")
    on_date = on_date or timezone.now().date()
    gaps, expiring = [], []
    mandatory = list(m.TrainingCourse.objects.filter(mandatory=True, is_active=True))
    for e in m.Employee.objects.filter(status="ACTIVE"):
        for c in mandatory:
            recs = list(m.TrainingRecord.objects.filter(employee=e, course=c).order_by("-completed_on"))
            valid = next((r for r in recs if r.expires_on is None or r.expires_on >= on_date), None)
            if valid is None:
                gaps.append({"employee_no": e.employee_no, "name": e.name, "course": c.code, "reason": "EXPIRED" if recs else "MISSING"})
            elif valid.expires_on and valid.expires_on <= on_date + timedelta(days=within_days):
                expiring.append({"employee_no": e.employee_no, "name": e.name, "course": c.code, "expires_on": str(valid.expires_on)})
    return {"gaps": gaps, "expiring": expiring}


# ============================================================================= employee relations
@transaction.atomic
def open_case(actor_id, employee_id, *, kind, summary):
    _need(actor_id, "hr.cases.manage")
    e = _get(m.Employee, employee_id, "Employee")
    if kind not in m.EmployeeCase.Kind.values or not (summary or "").strip():
        raise _bad("A valid kind and a summary are required.", "invalid_case")
    c = m.EmployeeCase.objects.create(employee=e, kind=kind, summary=summary.strip()[:300], opened_by=actor_id)
    _audit("hr.case.opened", actor_id, c, kind=kind)
    return c


@transaction.atomic
def file_grievance(user_id, summary):
    e = _me(user_id)
    if e is None or not (summary or "").strip():
        raise _bad("A summary is required.", "invalid_case")
    return m.EmployeeCase.objects.create(employee=e, kind="GRIEVANCE", summary=summary.strip()[:300], opened_by=user_id)


@transaction.atomic
def add_case_note(actor_id, case_id, text):
    _need(actor_id, "hr.cases.manage")
    c = _get(m.EmployeeCase, case_id, "Case", lock=True)
    if c.status == "CLOSED" or not (text or "").strip():
        raise _state("Closed cases take no notes, and a note needs text.")
    if c.status == "OPEN":
        c.status = "INVESTIGATING"
        c.save(update_fields=["status", "updated_at"])
    return m.CaseNote.objects.create(case=c, author_id=actor_id, text=text.strip())


@transaction.atomic
def close_case(actor_id, case_id, outcome):
    _need(actor_id, "hr.cases.manage")
    c = _get(m.EmployeeCase, case_id, "Case", lock=True)
    if c.status == "CLOSED":
        raise _state("The case is already closed.")
    if not (outcome or "").strip():
        raise _bad("An outcome is required to close a case.", "reason_required")
    c.status, c.outcome = "CLOSED", outcome.strip()[:300]
    c.save()
    if c.kind != "GRIEVANCE":
        log_event(c.employee, "CASE_" + c.kind, timezone.now().date(), actor_id, outcome=c.outcome)
    _audit("hr.case.closed", actor_id, c)
    return c


def cases_visible(user_id):
    """HR case handlers see all; everyone else only grievances they filed about themselves — never notes."""
    qs = m.EmployeeCase.objects.select_related("employee")
    if authz.has_permission(user_id, "hr.cases.manage"):
        return qs
    e = _me(user_id)
    return qs.filter(employee=e, kind="GRIEVANCE", opened_by=user_id) if e else qs.none()


# ============================================================================= policies
@transaction.atomic
def create_policy(actor_id, *, code, title, body):
    _need(actor_id, "hr.policy.manage")
    code = (code or "").strip().upper()
    if not code or not (title or "").strip() or not (body or "").strip():
        raise _bad("A code, a title and a body are required.", "invalid_policy")
    last = m.HrPolicy.objects.select_for_update().filter(code=code).order_by("-version").first()
    return m.HrPolicy.objects.create(code=code, version=(last.version + 1 if last else 1), title=title.strip()[:150], body=body)


@transaction.atomic
def update_policy(actor_id, policy_id, *, title=None, body=None):
    _need(actor_id, "hr.policy.manage")
    p = _get(m.HrPolicy, policy_id, "Policy", lock=True)
    if p.status != "DRAFT":
        raise DomainError("A published version is immutable; create a new version.", code="policy_immutable")
    p.title, p.body = title or p.title, body or p.body
    p.save()
    return p


@transaction.atomic
def publish_policy(actor_id, policy_id):
    _need(actor_id, "hr.policy.manage")
    p = _get(m.HrPolicy, policy_id, "Policy", lock=True)
    if p.status != "DRAFT":
        raise _state()
    m.HrPolicy.objects.filter(code=p.code, status="PUBLISHED").update(status="RETIRED")
    p.status, p.published_at = "PUBLISHED", timezone.now()
    p.save()
    _audit("hr.policy.published", actor_id, p, code=p.code, version=p.version)
    return p


@transaction.atomic
def acknowledge_policy(user_id, policy_id):
    e = _me(user_id)
    p = _get(m.HrPolicy, policy_id, "Policy")
    if e is None or e.status not in ("ACTIVE", "ONBOARDING"):
        raise DomainError("Only employees can acknowledge policies.", code="permission_denied", status_code=403)
    if p.status != "PUBLISHED":
        raise _state("Only the current published version can be acknowledged.")
    a, _ = m.PolicyAcknowledgment.objects.get_or_create(policy=p, employee=e)  # idempotent
    return a


def outstanding_acknowledgments(user_id, policy_id):
    _need(user_id, "hr.policy.manage")
    p = _get(m.HrPolicy, policy_id, "Policy")
    done = set(m.PolicyAcknowledgment.objects.filter(policy=p).values_list("employee_id", flat=True))
    return [{"employee_no": e.employee_no, "name": e.name} for e in m.Employee.objects.filter(status__in=["ACTIVE", "ONBOARDING"]).exclude(id__in=done)]


def policies_for(user_id):
    e = _me(user_id)
    qs = m.HrPolicy.objects.all() if authz.has_permission(user_id, "hr.policy.manage") else m.HrPolicy.objects.filter(status="PUBLISHED")
    acked = set(m.PolicyAcknowledgment.objects.filter(employee=e).values_list("policy_id", flat=True)) if e else set()
    return [(p, p.id in acked) for p in qs.order_by("code", "-version")]


# ============================================================================= reimbursements
@transaction.atomic
def submit_reimbursement(user_id, *, description, expense_date, amount):
    e = _me(user_id)
    amt = _dec(amount, "amount")
    if e is None or e.status != "ACTIVE" or amt <= 0 or not (description or "").strip() or expense_date > timezone.now().date():
        raise _bad("An active employee, a description, a positive amount and a past date are required.", "invalid_claim")
    return m.Reimbursement.objects.create(employee=e, description=description.strip()[:200], expense_date=expense_date, amount=amt)


@transaction.atomic
def decide_reimbursement(actor_id, claim_id, *, approve, note=""):
    """Approval queues a non-taxable payroll input for the next month that is not yet locked."""
    _need(actor_id, "hr.reimbursement.approve")
    r = _get(m.Reimbursement, claim_id, "Claim", lock=True)
    if r.status != "SUBMITTED":
        raise _state()
    if r.employee.user_id == actor_id:
        raise DomainError("Separation of duties: you cannot approve your own claim.", code="separation_of_duties", status_code=403)
    r.decided_by, r.decision_note = actor_id, (note or "")[:300]
    if not approve:
        if not (note or "").strip():
            raise _bad("A note is required to reject.", "reason_required")
        r.status = "REJECTED"
        r.save()
        return r
    month = timezone.now().date().replace(day=1)
    while m.PayrollRun.objects.exclude(status__in=["DRAFT", "CANCELLED"]).filter(period_start=month).exists():
        month = add_months(month, 1)
    pi = m.PayrollInput.objects.create(employee=r.employee, kind="REIMBURSEMENT", month=month, amount=r.amount, taxable=False, description=f"Reimbursement: {r.description}"[:200], status="APPROVED", created_by=actor_id, decided_by=actor_id)
    r.status, r.payroll_input = "APPROVED", pi
    r.save()
    return r


def my_reimbursements(user_id):
    e = _me(user_id)
    qs = m.Reimbursement.objects.select_related("employee")
    if authz.has_permission(user_id, "hr.reimbursement.approve"):
        return qs
    return qs.filter(employee=e) if e else qs.none()
