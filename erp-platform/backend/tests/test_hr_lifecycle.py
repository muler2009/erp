from datetime import date, timedelta

import pytest
from django.db import ProgrammingError, connection, transaction
from django.core.files.uploadedfile import SimpleUploadedFile
from django_tenants.utils import schema_context

from modules.hr import lifecycle as life
from modules.hr import models as hm
from modules.hr import services as hr
from platform_core.organizations import models as om
from platform_core.organizations import services as org
from platform_core.tenants.models import Tenant
from platform_core.users.models import ExternalIdentity, TenantMembership
from shared.api.errors import DomainError, ValidationFailed
from shared.events.models import OutboxEvent
from shared.files import services as files
from tests.conftest import ACME_HOST, Api
from tests.test_hr import hire, setup_env

TODAY = date(2026, 3, 16)


@pytest.fixture
def f(acme):
    tenant = Tenant.objects.get(pk=acme["id"])
    with schema_context(acme["schema"]):
        yield setup_env(tenant)


def dept(code="ENG"):
    return om.Department.objects.create(code=code, name=f"Dept {code}")


def pos(code, title, department=None):
    return om.Position.objects.create(code=code, title=title, department=department)


# ----------------------------------------------------------------------------- records, duplicates, grades, headcount
@pytest.mark.django_db
def test_duplicate_employees_are_detected_by_email_tax_id_and_name(f):
    p = f["people"]
    a = hr.create_employee(p["hrm"].id, first_name="Sara", last_name="Bekele", hire_date=TODAY, email="sara@x.test", tax_id="T-1")
    for kw in (dict(first_name="Other", last_name="Person", email="SARA@x.test"), dict(first_name="Other", last_name="Person", tax_id="T-1"), dict(first_name="sara", last_name="BEKELE", hire_date=TODAY)):
        with pytest.raises(DomainError) as x:
            hr.create_employee(p["hrm"].id, **{"hire_date": TODAY, **kw})
        assert x.value.get_codes() == "duplicate_employee"
    ok = hr.create_employee(p["hrm"].id, first_name="Sara", last_name="Bekele", hire_date=TODAY + timedelta(days=30))  # same name, other person/date
    assert ok.id != a.id
    with pytest.raises(DomainError):
        hr.update_employee(p["hrm"].id, ok.id, email="sara@x.test")
    assert hr.update_employee(p["hrm"].id, ok.id, email="sara@x.test", allow_duplicate=True).email == "sara@x.test"


@pytest.mark.django_db
def test_hire_sets_probation_and_history_and_grade_bands(f):
    p = f["people"]
    e = hr.create_employee(p["hrm"].id, first_name="Pro", last_name="Bation", hire_date=date(2026, 1, 31))
    assert e.probation_end == date(2026, 4, 30) and e.probation_status == "IN_PROGRESS"  # 3 months, month-end safe
    assert [ev.kind for ev in e.events.all()] == ["HIRED"]
    none = hr.create_employee(p["hrm"].id, first_name="No", last_name="Probation", hire_date=TODAY, probation_months=0)
    assert none.probation_status == "NONE" and none.probation_end is None
    life.create_grade(p["hrm"].id, code="G1", name="Grade 1", min_salary="500", max_salary="900")
    with pytest.raises(ValidationFailed):
        life.create_grade(p["hrm"].id, code="G2", name="Bad", min_salary="900", max_salary="500")
    with pytest.raises(DomainError):
        life.create_grade(p["hrm"].id, code="G1", name="Dup")


@pytest.mark.django_db
def test_headcount_plan_tracks_vacancies_and_can_be_enforced(f):
    p = f["people"]
    d = dept()
    po = pos("ACC", "Accountant", d)
    life.set_position_plan(p["hrm"].id, po.id, approved_headcount=2, job_description="Books", requirements="Degree")
    hr.create_employee(p["hrm"].id, first_name="A", last_name="One", hire_date=TODAY, position_id=po.id)
    row = life.headcount_plan()[0]
    assert (row["approved"], row["occupied"], row["vacant"]) == (2, 1, 1)
    hr.create_employee(p["hrm"].id, first_name="B", last_name="Two", hire_date=TODAY, position_id=po.id)  # not enforced by default
    assert life.headcount_plan()[0]["vacant"] == 0
    org.update_settings(None, {"hr.enforce_headcount": True})
    with pytest.raises(DomainError) as x:
        hr.create_employee(p["hrm"].id, first_name="C", last_name="Three", hire_date=TODAY, position_id=po.id)
    assert x.value.get_codes() == "headcount_full"


@pytest.mark.django_db
def test_personal_records_are_limited_to_the_owner_and_hr(f):
    p = f["people"]
    e = hire(f, "Self", "e1")
    life.add_emergency_contact(p["e1"].id, e.id, name="Mum", relationship="Mother", phone="+251900")
    life.add_qualification(p["e1"].id, e.id, kind="DEGREE", title="BSc", expires_on=None)
    sk = life.set_skill(p["e1"].id, e.id, name="Excel", level=3)
    assert life.set_skill(p["hrm"].id, e.id, name="Excel", level=4).id == sk.id and e.skills.get().level == 4
    for bad in (dict(name="X", level=6), dict(name="", level=1)):
        with pytest.raises(ValidationFailed):
            life.set_skill(p["e1"].id, e.id, **bad)
    with pytest.raises(DomainError):
        life.add_emergency_contact(p["e2"].id, e.id, name="Spy", relationship="x", phone="1")  # someone else's record
    with pytest.raises(DomainError):
        life.add_qualification(p["e1"].id, e.id, kind="DEGREE", title="MSc", awarded_on=date(2026, 1, 1), expires_on=date(2025, 1, 1))


# ----------------------------------------------------------------------------- assignment changes and history
@pytest.mark.django_db
def test_hr_schedules_effective_dated_promotion_and_history_is_kept(f):
    p = f["people"]
    now = date.today()
    d1, d2 = dept("OPS"), dept("FIN")
    junior, senior = pos("J", "Junior"), pos("S", "Senior")
    g2 = life.create_grade(p["hrm"].id, code="G2", name="Grade 2")
    e = hire(f, "Climb", "e1")
    later = now + timedelta(days=30)
    ch = life.change_assignment(p["hrm"].id, e.id, kind="PROMOTION", effective_date=later, position_id=senior.id, department_id=d2.id, grade_id=g2.id, reason="Annual review")
    e.refresh_from_db()
    assert ch.status == "SCHEDULED" and e.position_id is None  # nothing changes before the effective date
    assert life.apply_due_changes(now) == 0
    assert life.apply_due_changes(later) == 1
    e.refresh_from_db(); ch.refresh_from_db()
    assert (e.position_id, e.department_id, e.grade_id, ch.status) == (senior.id, d2.id, g2.id, "APPLIED")
    ev = e.events.filter(kind="PROMOTION").get()
    assert ev.details["to_position"] == "Senior" and ev.details["to_grade"] == "G2" and ev.effective_date == later
    assert life.apply_due_changes(later + timedelta(days=30)) == 0  # applied once only
    with pytest.raises(ProgrammingError), transaction.atomic():  # history cannot be rewritten, even with raw SQL
        with connection.cursor() as c:
            c.execute("UPDATE hr_employeeevent SET kind = 'X'")
    imm = life.change_assignment(p["hrm"].id, e.id, kind="TRANSFER", effective_date=now - timedelta(days=1), department_id=d1.id, reason="Reorg")
    e.refresh_from_db()
    assert imm.status == "APPLIED" and e.department_id == d1.id  # a past or current date applies at once
    assert [x["kind"] for x in life.history(p["hrm"].id, e.id)] == ["HIRED", "TRANSFER", "PROMOTION"]  # ordered by effective date


@pytest.mark.django_db
def test_manager_requests_transfer_hr_approves_with_separation_of_duties(f):
    p = f["people"]
    boss = hire(f, "Boss", "dm")
    e = hire(f, "Staff", "e1", manager=boss)
    d = dept("NEW")
    ch = life.change_assignment(p["dm"].id, e.id, kind="TRANSFER", effective_date=TODAY, department_id=d.id, reason="Needed there")
    assert ch.status == "PENDING"
    e.refresh_from_db()
    assert e.department_id is None
    with pytest.raises(DomainError) as x:
        life.decide_assignment_change(p["dm"].id, ch.id, approve=True)  # the requester
    assert x.value.get_codes() == "permission_denied" or x.value.get_codes() == "separation_of_duties"
    life.decide_assignment_change(p["hrm"].id, ch.id, approve=True)
    e.refresh_from_db()
    assert e.department_id == d.id
    with pytest.raises(DomainError):
        life.change_assignment(p["e1"].id, e.id, kind="TRANSFER", effective_date=TODAY, department_id=d.id, reason="self")  # an employee changing their own record
    with pytest.raises(DomainError):
        life.change_assignment(p["dm2"].id, e.id, kind="TRANSFER", effective_date=TODAY, department_id=d.id, reason="x")  # not their report
    ch2 = life.change_assignment(p["dm"].id, e.id, kind="TRANSFER", effective_date=TODAY, department_id=dept("X").id, reason="again")
    with pytest.raises(ValidationFailed):
        life.decide_assignment_change(p["hrm"].id, ch2.id, approve=False)  # reject needs a note
    assert life.decide_assignment_change(p["hrm"].id, ch2.id, approve=False, note="no").status == "CANCELLED"


# ----------------------------------------------------------------------------- probation
@pytest.mark.django_db
def test_probation_confirmation_extension_and_failure(f):
    p = f["people"]
    boss = hire(f, "Boss", "dm")
    e1, e2, e3 = hire(f, "P1", "e1", manager=boss), hire(f, "P2", manager=boss), hire(f, "P3", manager=boss)
    with pytest.raises(DomainError):
        life.evaluate_probation(p["dm2"].id, e1.id, outcome="CONFIRM")  # not their report
    with pytest.raises(DomainError):
        life.evaluate_probation(p["e1"].id, e1.id, outcome="CONFIRM")  # self
    with pytest.raises(ValidationFailed):
        life.evaluate_probation(p["dm"].id, e1.id, outcome="EXTEND", notes="needs time")  # no new date
    life.evaluate_probation(p["dm"].id, e1.id, outcome="EXTEND", notes="needs time", new_probation_end=e1.probation_end + timedelta(days=60))
    e1.refresh_from_db()
    assert e1.probation_status == "EXTENDED"
    life.evaluate_probation(p["dm"].id, e1.id, outcome="CONFIRM")
    e1.refresh_from_db()
    assert e1.probation_status == "CONFIRMED"
    with pytest.raises(DomainError):
        life.evaluate_probation(p["dm"].id, e1.id, outcome="CONFIRM")  # no longer on probation
    with pytest.raises(ValidationFailed):
        life.evaluate_probation(p["hrm"].id, e2.id, outcome="FAIL")  # needs notes
    life.evaluate_probation(p["hrm"].id, e2.id, outcome="FAIL", notes="not suitable")
    e2.refresh_from_db()
    assert e2.probation_status == "FAILED" and e2.status == "ACTIVE"  # HR still has to run the separation
    assert hm.ProbationEvaluation.objects.count() == 3


# ----------------------------------------------------------------------------- separation
@pytest.mark.django_db
def test_resignation_to_clearance_settlement_and_access_revocation(f):
    p = f["people"]
    boss = hire(f, "Boss", "dm")
    e = hire(f, "Quit", "e1", manager=boss)
    lwd = date.today() + timedelta(days=30)
    with pytest.raises(ValidationFailed):
        hr.submit_resignation(p["e1"].id, last_working_date=date(2020, 1, 1), reason="x")
    req = hr.submit_resignation(p["e1"].id, last_working_date=lwd, reason="New job")
    with pytest.raises(DomainError):
        hr.submit_resignation(p["e1"].id, last_working_date=lwd, reason="again")
    hr.withdraw_resignation(p["e1"].id, req.id)
    req = hr.submit_resignation(p["e1"].id, last_working_date=lwd, reason="New job")
    with pytest.raises(ValidationFailed):
        hr.decide_resignation(p["hrm"].id, req.id, accept=False)
    sep = hr.decide_resignation(p["hrm"].id, req.id, accept=True)
    e.refresh_from_db()
    assert sep.status == "ACCEPTED" and e.status == "OFFBOARDING" and e.separation_type == "RESIGNATION"
    items = {i.title: i for i in e.checklist.filter(kind="OFFBOARDING")}
    with pytest.raises(DomainError):
        hr.complete_checklist_item(p["e2"].id, items["Exit interview"].id)  # a colleague
    with pytest.raises(DomainError):
        hr.complete_checklist_item(p["e1"].id, items["Hand over work and responsibilities"].id)  # manager's task, not the leaver's
    hr.complete_checklist_item(p["dm"].id, items["Hand over work and responsibilities"].id)  # the line manager's task
    for i in e.checklist.filter(kind="OFFBOARDING", done_at__isnull=True):
        hr.complete_checklist_item(p["hrm"].id, i.id)
    with pytest.raises(DomainError):
        hr.complete_offboarding(p["hrm"].id, e.id)  # settlement missing
    hr.record_settlement(p["hrm"].id, e.id, amount="2500", notes="Leave encashment")
    hr.complete_offboarding(p["hrm"].id, e.id)
    e.refresh_from_db()
    ms = TenantMembership.objects.get(user=p["e1"])
    assert e.status == "TERMINATED" and ms.status == "DEACTIVATED"  # IAM access revoked
    assert [x.kind for x in e.events.all()][-2:] == ["SEPARATION", "SEPARATION"]
    assert OutboxEvent.objects.filter(event_type="hr.employee.terminated", payload__employee_id=str(e.id)).count() == 1


@pytest.mark.django_db
def test_onboarding_tasks_can_be_done_by_the_new_employee(f):
    p = f["people"]
    e = hr.create_employee(p["hrm"].id, first_name="New", last_name="Joiner", hire_date=TODAY, user_id=p["e1"].id)
    mine = e.checklist.get(title="Acknowledge HR policies")
    it = e.checklist.get(title="Set up workstation and accounts")
    hr.complete_checklist_item(p["e1"].id, mine.id)
    with pytest.raises(DomainError):
        hr.complete_checklist_item(p["e1"].id, it.id)  # IT task: not theirs
    assert it.due_date == TODAY + timedelta(days=14)


# ----------------------------------------------------------------------------- documents
@pytest.mark.django_db
def test_document_versions_requirements_and_access(f, settings):
    p = f["people"]
    e1, e2 = hire(f, "Doc", "e1"), hire(f, "Other", "e2")
    life.set_document_requirement(p["hrm"].id, doc_type="ID", title="National ID")
    life.set_document_requirement(p["hrm"].id, doc_type="CONTRACT", title="Signed contract", employment_type="PART_TIME")
    assert [r["doc_type"] for r in life.missing_documents(e1)] == ["ID"]
    d1 = life.add_document(p["hrm"].id, e1.id, doc_type="ID", title="National ID", filename="id.pdf", data=b"%PDF-1.4 first", expires_on=date(2026, 12, 31))
    d2 = life.add_document(p["e1"].id, e1.id, doc_type="ID", title="National ID", filename="id2.pdf", data=b"%PDF-1.4 second")
    d1.refresh_from_db()
    assert (d1.version, d1.is_current, d2.version, d2.is_current) == (1, False, 2, True) and life.missing_documents(e1) == []
    from shared.files.models import StoredFile

    sf = StoredFile.objects.get(pk=d2.file_id)
    assert files.can_access(p["e1"].id, sf) and files.can_access(p["hrm"].id, sf)
    assert not files.can_access(p["e2"].id, sf) and not files.can_access(p["dm"].id, sf)
    with pytest.raises(DomainError):
        life.add_document(p["e2"].id, e1.id, doc_type="ID", title="x", filename="a.pdf", data=b"%PDF-1.4")
    mon = life.monitoring(p["hrm"].id, within_days=400, today=date(2026, 3, 16))
    assert [d["title"] for d in mon["documents_expiring"]] == []  # the expiring version was superseded


# ----------------------------------------------------------------------------- bulk import
@pytest.mark.django_db
def test_bulk_import_reports_errors_and_is_all_or_nothing(f):
    p = f["people"]
    hr.create_employee(p["hrm"].id, first_name="Exist", last_name="Ing", hire_date=TODAY, email="exist@x.test")
    rows = [{"first_name": "Ok", "last_name": "One", "hire_date": "2026-03-16", "email": "one@x.test"},
            {"first_name": "Dup", "last_name": "Exist", "hire_date": "2026-03-16", "email": "exist@x.test"},
            {"first_name": "", "last_name": "NoName", "hire_date": "bad"},
            {"first_name": "Same", "last_name": "File", "hire_date": "2026-03-16", "email": "ONE@x.test"}]
    rep = life.import_employees(p["hrm"].id, rows, commit=True)
    assert rep["committed"] is False and rep["valid_rows"] == 1 and rep["error_rows"] == 3
    assert "duplicate of existing" in rep["rows"][1]["errors"][0] and "in this file" in rep["rows"][3]["errors"][0]
    assert hm.Employee.objects.count() == 1  # nothing created because of the errors
    good = rows[:1] + [{"first_name": "Two", "last_name": "Fine", "hire_date": "2026-03-17", "employment_type": "part_time"}]
    assert life.import_employees(p["hrm"].id, good)["committed"] is False  # dry run by default
    done = life.import_employees(p["hrm"].id, good, commit=True)
    assert done["committed"] and len(done["created"]) == 2 and hm.Employee.objects.count() == 3
    assert life.import_employees(p["hrm"].id, life.parse_csv("first_name,last_name,hire_date\nCsv,Person,2026-04-01\n"), commit=True)["created"]
    with pytest.raises(ValidationFailed):
        life.import_employees(p["hrm"].id, [{}] * 501)


# ----------------------------------------------------------------------------- org chart and monitoring
@pytest.mark.django_db
def test_org_chart_and_monitoring_lists_are_scoped(f):
    p = f["people"]
    boss = hire(f, "Boss", "dm")
    staff = hire(f, "Staff", "e1", manager=boss)
    hire(f, "Lone", "e2")
    life.add_qualification(p["hrm"].id, staff.id, kind="LICENSE", title="Forklift", expires_on=date(2026, 4, 1))
    hr.update_employee(p["hrm"].id, staff.id, date_of_birth=date(1966, 4, 10))
    full = life.org_chart(p["hrm"].id)
    assert {n["name"] for n in full} == {"Boss Test", "Lone Test"} and full[0]["reports"] if full[0]["name"] == "Boss Test" else True
    tree = life.org_chart(p["dm"].id)
    assert tree[0]["name"] == "Boss Test" and [r["name"] for r in tree[0]["reports"]] == ["Staff Test"]
    assert [n["name"] for n in life.org_chart(p["e2"].id)] == ["Lone Test"]
    day = date(2026, 3, 16)
    mon_hr = life.monitoring(p["hrm"].id, 60, today=day)
    assert {x["employee"] for x in mon_hr["probation_ending"]} <= {e.employee_no for e in hm.Employee.objects.all()}
    assert [q["title"] for q in mon_hr["qualifications_expiring"]] == ["Forklift"]
    assert [r["name"] for r in mon_hr["retirements"]] == ["Staff Test"]  # born 1966-04-10, retirement age 60 → 2026-04-10
    assert [q["title"] for q in life.monitoring(p["dm"].id, 60, today=day)["qualifications_expiring"]] == ["Forklift"]  # manager sees a report's
    assert life.monitoring(p["e2"].id, 60, today=day)["qualifications_expiring"] == []  # a colleague does not


# ----------------------------------------------------------------------------- HTTP
@pytest.fixture
def api_env(world, idp, acme):
    tenant = Tenant.objects.get(pk=acme["id"])
    with schema_context(acme["schema"]):
        env = setup_env(tenant)
        boss = hire(env, "Boss", "dm")
        hire(env, "Staff", "e1", manager=boss)
        hire(env, "Other", "e2")
    apis = {}
    for key in ("hrm", "dm", "e1", "e2"):
        ExternalIdentity.objects.create(user=env["people"][key], issuer="https://kc.test/realms/erp", subject=f"{key}-sub")
        apis[key] = Api(ACME_HOST)
        assert apis[key].login(idp, f"{key}-sub").status_code == 302
    return env, apis


@pytest.mark.django_db
def test_profile_documents_and_import_over_http(api_env):
    env, api = api_env
    emps = {x["name"]: x["id"] for x in api["hrm"].get("/api/v1/hr/employees").json()["results"]}
    mine, other = emps["Staff Test"], emps["Other Test"]
    prof = api["e1"].get(f"/api/v1/hr/employees/{mine}/profile").json()
    assert prof["probation_status"] == "IN_PROGRESS" and "bank_account" in prof
    assert api["e1"].get(f"/api/v1/hr/employees/{other}/profile").status_code == 404
    assert "bank_account" not in api["dm"].get(f"/api/v1/hr/employees/{mine}/profile").json()  # the manager sees a report, not their bank details
    up = SimpleUploadedFile("id.pdf", b"%PDF-1.4 id", content_type="application/pdf")
    r = api["e1"].client.post(f"/api/v1/hr/employees/{mine}/documents", {"file": up, "doc_type": "ID", "title": "National ID"}, HTTP_HOST=ACME_HOST)
    assert r.status_code == 201, r.content
    fid = r.json()["file_id"]
    assert api["e1"].get(f"/api/v1/files/{fid}/content").status_code == 200
    assert api["e2"].get(f"/api/v1/files/{fid}/content").status_code == 404 or api["e2"].get(f"/api/v1/files/{fid}/content").status_code == 403
    assert api["hrm"].get(f"/api/v1/files/{fid}/content").status_code == 200
    assert api["dm"].get(f"/api/v1/hr/employees/{mine}/documents").json() == []
    assert api["e1"].post("/api/v1/hr/employees/import", {"rows": [], "commit": True}).status_code == 403
    rep = api["hrm"].post("/api/v1/hr/employees/import", {"csv": "first_name,last_name,hire_date\nA,B,2026-03-01\n", "commit": True}).json()
    assert rep["committed"] and len(rep["created"]) == 1
    assert api["e1"].post(f"/api/v1/hr/employees/{mine}/skills", {"name": "Python", "level": 4}).status_code == 201
    assert api["e2"].post(f"/api/v1/hr/employees/{mine}/skills", {"name": "Hack", "level": 5}).status_code == 404
    res = api["e1"].post("/api/v1/hr/me/resignation", {"last_working_date": str(date.today() + timedelta(days=20)), "reason": "Moving"})
    assert res.status_code == 201
    assert api["e1"].post(f"/api/v1/hr/separations/{res.json()['id']}/accept").status_code == 403
    assert api["hrm"].post(f"/api/v1/hr/separations/{res.json()['id']}/accept").json()["status"] == "ACCEPTED"
    assert api["hrm"].get("/api/v1/hr/org-chart").status_code == 200 and api["e1"].get("/api/v1/hr/monitoring").status_code == 200
