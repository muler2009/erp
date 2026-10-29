from rest_framework.parsers import MultiPartParser
from rest_framework.response import Response
from rest_framework.views import APIView

from modules.crm.views import _date
from modules.hr import lifecycle as life
from modules.hr import models as m
from modules.hr import services
from modules.hr.views import _emp, _req_date, _s, perm
from shared.api.errors import ValidationFailed
from shared.api.pagination import paginate


def _grade(g):
    return {"id": str(g.id), "code": g.code, "name": g.name, "min_salary": str(g.min_salary), "max_salary": str(g.max_salary), "is_active": g.is_active}


def _change(c):
    return {"id": str(c.id), "employee": str(c.employee_id), "kind": c.kind, "effective_date": str(c.effective_date), "status": c.status, "reason": c.reason, "department": _s(c.department_id), "position": _s(c.position_id), "manager": _s(c.manager_id), "grade": _s(c.grade_id), "requested_by": str(c.requested_by), "approved_by": _s(c.approved_by)}


def _sep(s):
    return {"id": str(s.id), "employee": str(s.employee_id), "kind": s.kind, "last_working_date": str(s.last_working_date), "reason": s.reason, "status": s.status, "settlement_recorded": s.settlement_recorded, "settlement_amount": str(s.settlement_amount), "settlement_notes": s.settlement_notes}


def _doc(d):
    return {"id": str(d.id), "employee": str(d.employee_id), "doc_type": d.doc_type, "title": d.title, "version": d.version, "file_id": _s(d.file_id), "expires_on": _s(d.expires_on), "is_current": d.is_current}


class Grades(APIView):
    def get_permissions(self):
        return perm("hr.config.manage" if self.request.method == "POST" else "hr.view")

    def get(self, request):
        return Response([_grade(g) for g in m.JobGrade.objects.all().order_by("code")])

    def post(self, request):
        b = request.data
        return Response(_grade(life.create_grade(request.user.id, code=b.get("code", ""), name=b.get("name", ""), min_salary=b.get("min_salary", 0), max_salary=b.get("max_salary", 0))), status=201)


class PositionPlanView(APIView):
    def get_permissions(self):
        return perm("hr.config.manage")

    def put(self, request, pk):
        b = request.data
        plan = life.set_position_plan(request.user.id, pk, approved_headcount=b.get("approved_headcount", 1), grade_id=b.get("grade"), job_description=b.get("job_description", ""), requirements=b.get("requirements", ""))
        return Response({"position": str(plan.position_id), "approved_headcount": plan.approved_headcount})


class HeadcountPlan(APIView):
    def get_permissions(self):
        return perm("hr.view")

    def get(self, request):
        return Response(life.headcount_plan())


class OrgChart(APIView):
    def get_permissions(self):
        return perm("hr.self")

    def get(self, request):
        return Response(life.org_chart(request.user.id))


class Monitoring(APIView):
    def get_permissions(self):
        return perm("hr.self")

    def get(self, request):
        return Response(life.monitoring(request.user.id, int(request.query_params.get("days", 60))))


def _record_add(fn, fields):
    class View(APIView):
        def get_permissions(self):
            return perm("hr.self")

        def post(self, request, pk):
            row = fn(request.user.id, pk, **{k: (_date(request.data.get(k), k) if k.endswith("_on") else request.data.get(k)) for k in fields})
            return Response({"id": str(row.id)}, status=201)

    return View


EmergencyContactAdd = _record_add(life.add_emergency_contact, ["name", "relationship", "phone"])
QualificationAdd = _record_add(life.add_qualification, ["kind", "title", "institution", "awarded_on", "expires_on"])
SkillSet = _record_add(life.set_skill, ["name", "level"])


def _record_delete(model):
    class View(APIView):
        def get_permissions(self):
            return perm("hr.self")

        def delete(self, request, pk):
            life.remove_record(request.user.id, model, pk)
            return Response(status=204)

    return View


EmergencyContactDelete = _record_delete(m.EmergencyContact)
QualificationDelete = _record_delete(m.Qualification)
SkillDelete = _record_delete(m.Skill)


class EmployeeProfile(APIView):
    """Everything on file about one employee (personal records, checklist, history), scoped by who is asking."""

    def get_permissions(self):
        return perm("hr.self")

    def get(self, request, pk):
        e = services.employee_visible(request.user.id, pk)
        d = {**_emp(e, request.user.id), "employment_type": e.employment_type, "probation_end": _s(e.probation_end), "probation_status": e.probation_status, "grade": e.grade.code if e.grade_id else None, "separation_type": e.separation_type}
        d["emergency_contacts"] = [{"id": str(c.id), "name": c.name, "relationship": c.relationship, "phone": c.phone} for c in e.emergency_contacts.all()] if (services.is_hr(request.user.id) or e.user_id == request.user.id) else []
        d["qualifications"] = [{"id": str(q.id), "kind": q.kind, "title": q.title, "institution": q.institution, "expires_on": _s(q.expires_on)} for q in e.qualifications.all()]
        d["skills"] = [{"id": str(s.id), "name": s.name, "level": s.level} for s in e.skills.all()]
        d["documents"] = [_doc(x) for x in e.documents.filter(is_current=True)] if (services.is_hr(request.user.id) or e.user_id == request.user.id) else []
        d["missing_documents"] = life.missing_documents(e) if (services.is_hr(request.user.id) or e.user_id == request.user.id) else []
        return Response(d)


class History(APIView):
    def get_permissions(self):
        return perm("hr.self")

    def get(self, request, pk):
        return Response(life.history(request.user.id, pk))


class AssignmentChanges(APIView):
    def get_permissions(self):
        return perm("hr.self")

    def get(self, request, pk):
        e = services.employee_visible(request.user.id, pk)
        return Response([_change(c) for c in e.assignment_changes.order_by("-effective_date")])

    def post(self, request, pk):
        b = request.data
        ch = life.change_assignment(request.user.id, pk, kind=b.get("kind", ""), effective_date=_req_date(b.get("effective_date"), "effective_date"), department_id=b.get("department"), position_id=b.get("position"), manager_id=b.get("manager"), clear_manager=bool(b.get("clear_manager")), grade_id=b.get("grade"), reason=b.get("reason", ""))
        return Response(_change(ch), status=201)


class AssignmentDecide(APIView):
    def get_permissions(self):
        return perm("hr.employee.manage")

    def post(self, request, pk, decision):
        if decision not in ("approve", "reject"):
            raise ValidationFailed("Unknown decision.", code="invalid_decision")
        return Response(_change(life.decide_assignment_change(request.user.id, pk, approve=decision == "approve", note=request.data.get("note", ""))))


class AssignmentCancel(APIView):
    def get_permissions(self):
        return perm("hr.self")

    def post(self, request, pk):
        return Response(_change(life.cancel_assignment_change(request.user.id, pk)))


class Probation(APIView):
    def get_permissions(self):
        return perm("hr.self")

    def post(self, request, pk):
        b = request.data
        ev = life.evaluate_probation(request.user.id, pk, outcome=b.get("outcome", ""), notes=b.get("notes", ""), new_probation_end=_date(b.get("new_probation_end"), "new_probation_end"))
        return Response({"id": str(ev.id), "outcome": ev.outcome}, status=201)


# ----------------------------------------------------------------------------- separation
class EmployeeOffboardView(APIView):
    def get_permissions(self):
        return perm("hr.employee.manage")

    def post(self, request, pk):
        b = request.data
        e = services.start_offboarding(request.user.id, pk, termination_date=_req_date(b.get("termination_date"), "termination_date"), reason=b.get("reason", ""), separation_type=b.get("separation_type", "TERMINATION"))
        return Response(_emp(e, request.user.id))


class Resignation(APIView):
    def get_permissions(self):
        return perm("hr.self")

    def post(self, request):
        b = request.data
        return Response(_sep(services.submit_resignation(request.user.id, last_working_date=_req_date(b.get("last_working_date"), "last_working_date"), reason=b.get("reason", ""))), status=201)


class ResignationWithdraw(APIView):
    def get_permissions(self):
        return perm("hr.self")

    def post(self, request, pk):
        return Response(_sep(services.withdraw_resignation(request.user.id, pk)))


class SeparationDecide(APIView):
    def get_permissions(self):
        return perm("hr.employee.manage")

    def post(self, request, pk, decision):
        if decision not in ("accept", "reject"):
            raise ValidationFailed("Unknown decision.", code="invalid_decision")
        return Response(_sep(services.decide_resignation(request.user.id, pk, accept=decision == "accept", note=request.data.get("note", ""))))


class Separations(APIView):
    def get_permissions(self):
        return perm("hr.employee.manage")

    def get(self, request):
        qs = m.Separation.objects.all()
        if request.query_params.get("status"):
            qs = qs.filter(status=request.query_params["status"])
        return paginate(request, qs, _sep)


class Settlement(APIView):
    def get_permissions(self):
        return perm("hr.employee.manage")

    def post(self, request, pk):
        return Response(_sep(services.record_settlement(request.user.id, pk, amount=request.data.get("amount", 0), notes=request.data.get("notes", ""))))


# ----------------------------------------------------------------------------- documents and import
class Documents(APIView):
    parser_classes = [MultiPartParser]

    def get_permissions(self):
        return perm("hr.self")

    def get(self, request, pk):
        e = services.employee_visible(request.user.id, pk)
        if not (services.is_hr(request.user.id) or e.user_id == request.user.id):
            return Response([])
        return Response([_doc(d) for d in e.documents.order_by("doc_type", "-version")])

    def post(self, request, pk):
        up = request.FILES.get("file")
        if up is None:
            raise ValidationFailed("A 'file' part is required.", code="file_required")
        from django.conf import settings

        if up.size > settings.FILE_MAX_BYTES:
            raise ValidationFailed("The file is too large.", code="file_too_large")
        d = life.add_document(request.user.id, pk, doc_type=request.data.get("doc_type", ""), title=request.data.get("title", ""), filename=up.name, data=up.read(), expires_on=_date(request.data.get("expires_on"), "expires_on"))
        return Response(_doc(d), status=201)


class DocumentRequirements(APIView):
    def get_permissions(self):
        return perm("hr.config.manage" if self.request.method == "POST" else "hr.view")

    def get(self, request):
        return Response([{"doc_type": r.doc_type, "title": r.title, "employment_type": r.employment_type} for r in m.DocumentRequirement.objects.all()])

    def post(self, request):
        b = request.data
        r = life.set_document_requirement(request.user.id, doc_type=b.get("doc_type", ""), title=b.get("title", ""), employment_type=b.get("employment_type", ""))
        return Response({"doc_type": r.doc_type, "title": r.title}, status=201)


class ImportEmployees(APIView):
    def get_permissions(self):
        return perm("hr.employee.manage")

    def post(self, request):
        b = request.data
        rows = life.parse_csv(b["csv"]) if b.get("csv") else (b.get("rows") or [])
        return Response(life.import_employees(request.user.id, rows, commit=bool(b.get("commit"))))
