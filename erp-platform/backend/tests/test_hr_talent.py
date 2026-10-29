from datetime import date, datetime, timedelta, timezone as tz
from decimal import Decimal as D

import pytest

from modules.hr import analytics as an
from modules.hr import models as hm
from modules.hr import payroll_ext as px
from modules.hr import services as hr
from modules.hr import talent as t
from shared.api.errors import DomainError, ValidationFailed
from shared.tenancy import current_tenant
from tests.test_finance import user
from tests.test_hr import MAR, api_env, f, hire, rules  # noqa: F401

FUTURE = date.today() + timedelta(days=30)
WHEN = datetime.now(tz.utc) + timedelta(days=2)


@pytest.fixture
def hrm2(f):
    u = user(current_tenant(), "hrm2@acme.test", "hr_manager")
    f["people"]["hrm2"] = u
    return u


def open_req(f, hrm2, headcount=1):
    p = f["people"]
    r = t.create_requisition(p["hro"].id, title="Accountant", justification="Growth", headcount=headcount)
    t.submit_requisition(p["hro"].id, r.id)
    return t.decide_requisition(hrm2.id, r.id, approve=True)


# ----------------------------------------------------------------------------- recruitment
@pytest.mark.django_db
def test_requisition_approval_and_candidate_rules(f, hrm2):
    p = f["people"]
    with pytest.raises(DomainError):
        t.create_requisition(p["e1"].id, title="x", justification="y")
    r = t.create_requisition(p["hrm"].id, title="Clerk", justification="Cover", headcount=2)
    assert r.number.startswith("REQ-")
    with pytest.raises(DomainError):
        t.add_candidate(p["hrm"].id, r.id, name="A", email="a@x.com")  # not approved yet
    t.submit_requisition(p["hrm"].id, r.id)
    with pytest.raises(DomainError) as x:
        t.decide_requisition(p["hrm"].id, r.id, approve=True)
    assert x.value.get_codes() == "separation_of_duties"
    with pytest.raises(DomainError):
        t.decide_requisition(p["hro"].id, r.id, approve=True)  # no approve permission
    with pytest.raises(ValidationFailed):
        t.decide_requisition(hrm2.id, r.id, approve=False)
    assert t.decide_requisition(hrm2.id, r.id, approve=True).status == "APPROVED"
    c = t.add_candidate(p["hro"].id, r.id, name="Sara Bekele", email="Sara@X.com")
    with pytest.raises(DomainError) as x:
        t.add_candidate(p["hro"].id, r.id, name="Sara again", email="sara@x.com")
    assert x.value.get_codes() == "duplicate_candidate"
    with pytest.raises(DomainError):
        t.move_candidate(p["hro"].id, c.id, "INTERVIEW")  # cannot skip screening
    with pytest.raises(ValidationFailed):
        t.move_candidate(p["hro"].id, c.id, "REJECTED")
    assert t.move_candidate(p["hro"].id, c.id, "REJECTED", "Not a fit").stage == "REJECTED"
    with pytest.raises(DomainError):
        t.move_candidate(p["hro"].id, c.id, "SCREENING")  # terminal


@pytest.mark.django_db
def test_full_hiring_flow_creates_employee_and_contract_and_closes_the_requisition(f, hrm2):
    p = f["people"]
    r = open_req(f, hrm2)
    c = t.add_candidate(p["hro"].id, r.id, name="Abebe Kebede", email="abebe@x.com", phone="0911")
    with pytest.raises(DomainError):
        t.schedule_interview(p["hro"].id, c.id, interviewer_id=p["dm"].id, scheduled_at=WHEN)  # screening first
    t.move_candidate(p["hro"].id, c.id, "SCREENING")
    with pytest.raises(ValidationFailed):
        t.schedule_interview(p["hro"].id, c.id, interviewer_id="00000000-0000-0000-0000-000000000001", scheduled_at=WHEN)
    i = t.schedule_interview(p["hro"].id, c.id, interviewer_id=p["dm"].id, scheduled_at=WHEN)
    with pytest.raises(DomainError):
        t.create_offer(p["hro"].id, c.id, monthly_salary="3000", currency="USD", start_date=FUTURE)  # no feedback yet
    with pytest.raises(DomainError):
        t.submit_feedback(p["dm2"].id, i.id, score=5, recommendation="HIRE")  # not the assigned interviewer
    with pytest.raises(ValidationFailed):
        t.submit_feedback(p["dm"].id, i.id, score=9, recommendation="HIRE")
    t.submit_feedback(p["dm"].id, i.id, score=4, recommendation="HIRE", feedback="Strong")
    with pytest.raises(DomainError):
        t.submit_feedback(p["dm"].id, i.id, score=4, recommendation="HIRE")  # once
    sc = t.scorecard(p["hro"].id, c.id)
    assert sc["average_score"] == "4.00" and sc["hire_votes"] == 1
    o = t.create_offer(p["hro"].id, c.id, monthly_salary="3000", currency="USD", start_date=FUTURE)
    with pytest.raises(DomainError):
        t.respond_offer(p["hro"].id, o.id, accept=True)  # not approved
    with pytest.raises(DomainError) as x:
        t.approve_offer(p["hro"].id, o.id)
    assert x.value.get_codes() in ("separation_of_duties", "permission_denied")
    t.approve_offer(hrm2.id, o.id)
    with pytest.raises(DomainError):
        t.hire_candidate(p["hro"].id, c.id)  # not accepted yet
    t.respond_offer(p["hro"].id, o.id, accept=True)
    e = t.hire_candidate(p["hro"].id, c.id)
    assert e.status == "ONBOARDING" and e.hire_date == FUTURE and e.email == "abebe@x.com"
    assert e.contracts.get().monthly_salary == D("3000")
    c.refresh_from_db()
    r.refresh_from_db()
    assert c.stage == "HIRED" and c.employee_id == e.id and r.status == "CLOSED"
    assert t.recruitment_funnel(p["hro"].id)["HIRED"] == 1


@pytest.mark.django_db
def test_declined_offer_and_closing_a_requisition_reject_open_candidates(f, hrm2):
    p = f["people"]
    r = open_req(f, hrm2, headcount=2)
    c1 = t.add_candidate(p["hro"].id, r.id, name="One One", email="1@x.com")
    c2 = t.add_candidate(p["hro"].id, r.id, name="Two Two", email="2@x.com")
    t.move_candidate(p["hro"].id, c1.id, "SCREENING")
    i = t.schedule_interview(p["hro"].id, c1.id, interviewer_id=p["dm"].id, scheduled_at=WHEN)
    t.submit_feedback(p["dm"].id, i.id, score=5, recommendation="HIRE")
    o = t.create_offer(p["hro"].id, c1.id, monthly_salary="2500", currency="USD", start_date=FUTURE)
    t.approve_offer(hrm2.id, o.id)
    t.respond_offer(p["hro"].id, o.id, accept=False)
    c1.refresh_from_db()
    assert c1.stage == "REJECTED" and c1.reason == "Offer declined"
    t.close_requisition(p["hro"].id, r.id)
    c2.refresh_from_db()
    assert c2.stage == "REJECTED"


# ----------------------------------------------------------------------------- performance
@pytest.mark.django_db
def test_review_cycle_goals_self_then_manager_and_visibility(f):
    p = f["people"]
    boss = hire(f, "Boss", "dm")
    e = hire(f, "Staff", "e1", manager=boss)
    other = hire(f, "Other", "e2")
    cy = t.create_cycle(p["hro"].id, name="2026 H1", start_date=date(2026, 1, 1), end_date=date(2026, 6, 30))
    with pytest.raises(DomainError):
        t.create_cycle(p["hro"].id, name="2026 H1", start_date=date(2026, 1, 1), end_date=date(2026, 6, 30))
    with pytest.raises(DomainError):
        t.create_cycle(p["e1"].id, name="x", start_date=date(2026, 1, 1), end_date=date(2026, 6, 30))
    t.activate_cycle(p["hro"].id, cy.id)
    t.activate_cycle(p["hro"].id, cy.id)  # idempotent
    assert hm.PerformanceReview.objects.filter(cycle=cy).count() == 3
    g1 = t.add_goal(p["dm"].id, e.id, cy.id, title="Close books on time", weight=60)
    g2 = t.add_goal(p["e1"].id, e.id, cy.id, title="Training", weight=40)
    with pytest.raises(ValidationFailed):
        t.add_goal(p["dm"].id, e.id, cy.id, title="Too much", weight=1)  # 100% used
    with pytest.raises(DomainError):
        t.add_goal(p["dm"].id, other.id, cy.id, title="not mine", weight=10)  # not their report
    t.update_progress(p["e1"].id, g1.id, 100)
    t.update_progress(p["dm"].id, g2.id, 50)
    with pytest.raises(DomainError):
        t.update_progress(p["e2"].id, g1.id, 10)
    with pytest.raises(ValidationFailed):
        t.update_progress(p["e1"].id, g1.id, 150)
    rv = hm.PerformanceReview.objects.get(employee=e, cycle=cy)
    with pytest.raises(DomainError):
        t.submit_manager_review(p["dm"].id, rv.id, rating=4)  # self-review first
    with pytest.raises(DomainError):
        t.submit_self_review(p["dm"].id, rv.id, rating=4)  # not the employee
    t.submit_self_review(p["e1"].id, rv.id, rating=5, comment="Great")
    with pytest.raises(DomainError):
        t.submit_manager_review(p["e1"].id, rv.id, rating=5)  # cannot rate yourself
    with pytest.raises(DomainError):
        t.submit_manager_review(p["dm2"].id, rv.id, rating=3)  # not their manager
    assert t.hide_manager_part(p["e1"].id, rv) is False  # manager has not rated yet but the state is PENDING_MANAGER... checked below with refreshed row
    rv.refresh_from_db()
    assert t.hide_manager_part(p["e1"].id, rv) is True
    done = t.submit_manager_review(p["dm"].id, rv.id, rating=4, comment="Solid")
    assert done.status == "COMPLETED" and done.goal_score == D("80.00")  # 60%*100 + 40%*50
    assert t.acknowledge_review(p["e1"].id, rv.id).status == "ACKNOWLEDGED"
    assert {r.employee_id for r in t.reviews_visible(p["e1"].id)} == {e.id}
    assert {r.employee_id for r in t.reviews_visible(p["dm"].id)} == {boss.id, e.id}
    assert t.reviews_visible(p["hro"].id).count() == 3
    t.close_cycle(p["hro"].id, cy.id)
    with pytest.raises(DomainError):
        t.update_progress(p["e1"].id, g1.id, 10)
    assert an.performance(p["hrm"].id, cy.id)["rating_distribution"][4] == 1


# ----------------------------------------------------------------------------- learning
@pytest.mark.django_db
def test_training_records_expiry_and_compliance(f):
    p = f["people"]
    a = hire(f, "Alpha", "e1")
    b = hire(f, "Beta", "e2")
    c = t.create_course(p["hro"].id, code="safety", name="Safety", hours=4, validity_months=12, mandatory=True)
    assert c.code == "SAFETY"
    with pytest.raises(DomainError):
        t.create_course(p["hro"].id, code="SAFETY", name="dup")
    with pytest.raises(DomainError):
        t.create_course(p["e1"].id, code="X", name="x")
    today = date.today()
    rec = t.record_training(p["hro"].id, a.id, c.id, completed_on=today - timedelta(days=350), score=90)
    assert rec.expires_on > today
    with pytest.raises(DomainError):
        t.record_training(p["hro"].id, a.id, c.id, completed_on=today - timedelta(days=350))
    with pytest.raises(ValidationFailed):
        t.record_training(p["hro"].id, a.id, c.id, completed_on=today + timedelta(days=1))
    rep = t.training_compliance(p["hro"].id)
    assert [g["employee_no"] for g in rep["gaps"]] == [b.employee_no] and rep["gaps"][0]["reason"] == "MISSING"
    assert [x["employee_no"] for x in rep["expiring"]] == [a.employee_no]
    t.record_training(p["hro"].id, b.id, c.id, completed_on=today - timedelta(days=400))
    assert t.training_compliance(p["hro"].id)["gaps"][0]["reason"] == "EXPIRED"
    assert {r.employee_id for r in t.training_visible(p["e1"].id)} == {a.id}
    assert t.training_visible(p["hro"].id).count() == 2


# ----------------------------------------------------------------------------- cases and policies
@pytest.mark.django_db
def test_cases_are_confidential(f):
    p = f["people"]
    e = hire(f, "Subject", "e1")
    other = hire(f, "Other", "e2")
    c = t.open_case(p["hrm"].id, e.id, kind="DISCIPLINARY", summary="Late repeatedly")
    with pytest.raises(DomainError):
        t.open_case(p["hro"].id, e.id, kind="DISCIPLINARY", summary="x")  # officers lack case handling
    t.add_case_note(p["hrm"].id, c.id, "Interviewed the employee")
    g = t.file_grievance(p["e1"].id, "Unfair schedule")
    assert {x.id for x in t.cases_visible(p["e1"].id)} == {g.id}  # the disciplinary case is invisible to its subject
    assert t.cases_visible(p["e2"].id).count() == 0 and t.cases_visible(p["hro"].id).count() == 0
    assert t.cases_visible(p["hrm"].id).count() == 2
    with pytest.raises(ValidationFailed):
        t.close_case(p["hrm"].id, c.id, " ")
    t.close_case(p["hrm"].id, c.id, "Verbal warning")
    with pytest.raises(DomainError):
        t.add_case_note(p["hrm"].id, c.id, "late note")
    assert hm.EmployeeEvent.objects.filter(employee=e, kind="CASE_DISCIPLINARY").count() == 1


@pytest.mark.django_db
def test_policy_versions_publish_and_acknowledgments(f):
    p = f["people"]
    a = hire(f, "Alpha", "e1")
    hire(f, "Beta", "e2")
    v1 = t.create_policy(p["hrm"].id, code="conduct", title="Code of conduct", body="Be kind")
    with pytest.raises(DomainError):
        t.acknowledge_policy(p["e1"].id, v1.id)  # draft
    t.update_policy(p["hrm"].id, v1.id, body="Be kind and honest")
    t.publish_policy(p["hrm"].id, v1.id)
    with pytest.raises(DomainError) as x:
        t.update_policy(p["hrm"].id, v1.id, body="sneaky")
    assert x.value.get_codes() == "policy_immutable"
    t.acknowledge_policy(p["e1"].id, v1.id)
    t.acknowledge_policy(p["e1"].id, v1.id)  # idempotent
    assert hm.PolicyAcknowledgment.objects.count() == 1
    assert [o["name"] for o in t.outstanding_acknowledgments(p["hrm"].id, v1.id)] == ["Beta Test"]
    with pytest.raises(DomainError):
        t.outstanding_acknowledgments(p["e1"].id, v1.id)
    v2 = t.create_policy(p["hrm"].id, code="CONDUCT", title="Code of conduct", body="v2")
    assert v2.version == 2
    t.publish_policy(p["hrm"].id, v2.id)
    v1.refresh_from_db()
    assert v1.status == "RETIRED"
    with pytest.raises(DomainError):
        t.acknowledge_policy(p["e1"].id, v1.id)  # old version
    seen = {pol.version: acked for pol, acked in t.policies_for(p["e1"].id)}
    assert seen == {2: False}  # employees see only the current version, and must acknowledge it again


# ----------------------------------------------------------------------------- reimbursements and analytics
@pytest.mark.django_db
def test_reimbursement_becomes_non_taxable_pay_in_the_next_open_month(f, hrm2):
    p = f["people"]
    rules(f)
    e = hire(f, "Claimant", "e1")
    c = t.submit_reimbursement(p["e1"].id, description="Taxi", expense_date=date.today(), amount="45.50")
    with pytest.raises(ValidationFailed):
        t.submit_reimbursement(p["e1"].id, description="Future", expense_date=date.today() + timedelta(days=2), amount="5")
    with pytest.raises(DomainError):
        t.decide_reimbursement(p["e1"].id, c.id, approve=True)
    with pytest.raises(ValidationFailed):
        t.decide_reimbursement(p["hrm"].id, c.id, approve=False)
    c = t.decide_reimbursement(p["hrm"].id, c.id, approve=True)
    pi = c.payroll_input
    assert pi.kind == "REIMBURSEMENT" and pi.taxable is False and pi.status == "APPROVED" and pi.amount == D("45.50")
    run = hr.create_payroll_run(p["hro"].id, pi.month, (pi.month.replace(day=28) + timedelta(days=4)).replace(day=1) - timedelta(days=1))
    s = run.payslips.get()
    assert s.other_earnings == D("45.50") and any(l.code == "REIMBURSEMENT" for l in s.lines.all())
    base = hr.create_payroll_run  # taxable income excludes the reimbursement
    assert s.taxable_income == s.basic - s.pension_employee
    assert {x.id for x in t.my_reimbursements(p["e1"].id)} == {c.id}
    assert t.my_reimbursements(p["e2"].id).count() == 0


@pytest.mark.django_db
def test_analytics_figures_and_permissions(f):
    p = f["people"]
    a = hire(f, "Stay", "e1", hire_date=date(2020, 1, 6))
    gone = hire(f, "Gone", hire_date=date(2024, 1, 8))
    hr.start_offboarding(p["hrm"].id, gone.id, termination_date=date(2026, 3, 13), reason="Better offer", separation_type="RESIGNATION")
    for i in gone.checklist.filter(kind="OFFBOARDING"):
        hr.complete_checklist_item(p["hrm"].id, i.id)
    hr.record_settlement(p["hrm"].id, gone.id, amount="0")
    hr.complete_offboarding(p["hrm"].id, gone.id)
    with pytest.raises(DomainError):
        an.dashboard(p["e1"].id)
    h = an.headcount(p["hrm"].id, date(2026, 3, 1))
    assert h["total"] == 2
    assert an.headcount(p["hrm"].id, date(2026, 6, 1))["total"] == 1
    tv = an.turnover(p["hrm"].id, 2026)
    assert tv["leavers"] == 1 and tv["average_headcount"] == "1.5" and tv["turnover_percent"] == "66.67" and tv["by_type"] == {"RESIGNATION": 1}
    assert an.tenure_bands(p["hrm"].id, date(2026, 6, 1)) == {"<1y": 0, "1-3y": 0, "3-5y": 0, "5y+": 1}
    assert an.payroll_cost(p["hrm"].id, 2026) == []
    with pytest.raises(DomainError):
        an.payroll_cost(p["auditor"].id, 2026)
    d = an.dashboard(p["auditor"].id, 2026)
    assert d["payroll_cost"] is None and d["headcount"]["total"] >= 1


@pytest.mark.django_db
def test_talent_http_permissions(api_env):
    env, api = api_env
    assert api["e1"].get("/api/v1/hr/recruitment/requisitions").status_code == 403
    r = api["hro"].post("/api/v1/hr/recruitment/requisitions", {"title": "Driver", "justification": "New route", "headcount": 1})
    assert r.status_code == 201
    rid = r.json()["id"]
    assert api["hro"].post(f"/api/v1/hr/recruitment/requisitions/{rid}/submit").status_code == 200
    assert api["hro"].post(f"/api/v1/hr/recruitment/requisitions/{rid}/approve").status_code == 403
    assert api["hrm"].post(f"/api/v1/hr/recruitment/requisitions/{rid}/approve").json()["status"] == "APPROVED"
    assert api["hrm"].post(f"/api/v1/hr/recruitment/requisitions/{rid}/nonsense").status_code == 400
    rc = api["hro"].post(f"/api/v1/hr/recruitment/requisitions/{rid}/candidates", {"name": "Zed Z", "email": "z@x.com"})
    assert rc.status_code == 201, rc.json()
    assert api["e1"].get("/api/v1/hr/recruitment/interviews/mine").status_code == 200
    assert api["e1"].get("/api/v1/hr/learning/courses").status_code == 200
    assert api["e1"].post("/api/v1/hr/learning/courses", {"code": "X", "name": "x"}).status_code == 403
    assert api["hro"].post("/api/v1/hr/learning/courses", {"code": "X1", "name": "Intro", "hours": "2"}).status_code == 201
    assert api["e1"].post("/api/v1/hr/cases/grievance", {"summary": "Noise"}).status_code == 201
    assert len(api["e1"].get("/api/v1/hr/cases").json()["results"]) == 1
    assert api["e2"].get("/api/v1/hr/cases").json()["results"] == []
    assert api["hro"].post("/api/v1/hr/cases", {"employee": "x", "kind": "DISCIPLINARY", "summary": "x"}).status_code == 403
    pol = api["hrm"].post("/api/v1/hr/policies", {"code": "IT", "title": "IT use", "body": "Use wisely"})
    assert pol.status_code == 201
    pid = pol.json()["id"]
    assert api["e1"].post(f"/api/v1/hr/policies/{pid}/publish").status_code == 403
    assert api["hrm"].post(f"/api/v1/hr/policies/{pid}/publish").json()["status"] == "PUBLISHED"
    assert api["e1"].post(f"/api/v1/hr/policies/{pid}/acknowledge").json()["acknowledged"] is True
    assert api["e1"].get("/api/v1/hr/policies").json()[0]["acknowledged"] is True
    assert api["e1"].get("/api/v1/hr/analytics/dashboard").status_code == 403
    assert api["hrm"].get("/api/v1/hr/analytics/dashboard").status_code == 200
    assert api["auditor"].get("/api/v1/hr/analytics/turnover?year=2026").status_code == 200
    assert api["hrm"].get("/api/v1/hr/analytics/bogus").status_code == 400
    cl = api["e1"].post("/api/v1/hr/reimbursements", {"description": "Taxi", "expense_date": "2026-03-01", "amount": "20"})
    assert cl.status_code == 201
    assert api["e1"].post(f"/api/v1/hr/reimbursements/{cl.json()['id']}/approve").status_code == 403
    assert api["hrm"].post(f"/api/v1/hr/reimbursements/{cl.json()['id']}/approve").json()["status"] == "APPROVED"
