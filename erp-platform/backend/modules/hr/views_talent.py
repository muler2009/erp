from django.utils import timezone
from rest_framework.response import Response
from rest_framework.views import APIView

from modules.hr import analytics as an
from modules.hr import models as m
from modules.hr import services
from modules.hr import talent as t
from modules.hr.views import _req_date, _s, perm
from modules.hr.views_attendance import _dt
from shared.api.errors import ValidationFailed
from shared.api.pagination import paginate


def _unknown(a):
    raise ValidationFailed(f"Unknown action '{a}'.", code="invalid_action")


# ------------------------------------------------------------------ serializers
def _req(r):
    return {"id": str(r.id), "number": r.number, "title": r.title, "department": _s(r.department_id), "position": _s(r.position_id), "headcount": r.headcount, "justification": r.justification, "status": r.status, "requested_by": str(r.requested_by), "decision_note": r.decision_note}


def _cand(c):
    return {"id": str(c.id), "requisition": str(c.requisition_id), "name": c.name, "email": c.email, "phone": c.phone, "source": c.source, "stage": c.stage, "reason": c.reason, "employee": _s(c.employee_id)}


def _int(i):
    return {"id": str(i.id), "candidate": str(i.candidate_id), "candidate_name": i.candidate.name, "interviewer": str(i.interviewer_id), "scheduled_at": i.scheduled_at.isoformat(), "status": i.status, "score": i.score, "recommendation": i.recommendation}


def _offer(o):
    return {"id": str(o.id), "candidate": str(o.candidate_id), "monthly_salary": str(o.monthly_salary), "currency": o.currency, "start_date": str(o.start_date), "status": o.status}


def _cycle(c):
    return {"id": str(c.id), "name": c.name, "start_date": str(c.start_date), "end_date": str(c.end_date), "status": c.status}


def _goal(g):
    return {"id": str(g.id), "employee": str(g.employee_id), "cycle": str(g.cycle_id), "title": g.title, "weight": str(g.weight), "progress": str(g.progress)}


def _review(user_id):
    def ser(r):
        d = {"id": str(r.id), "employee": str(r.employee_id), "employee_no": r.employee.employee_no, "cycle": r.cycle.name, "status": r.status, "self_rating": r.self_rating, "self_comment": r.self_comment, "goal_score": _s(r.goal_score)}
        if not t.hide_manager_part(user_id, r):
            d.update(manager_rating=r.manager_rating, manager_comment=r.manager_comment)
        return d

    return ser


def _course(c):
    return {"id": str(c.id), "code": c.code, "name": c.name, "provider": c.provider, "hours": str(c.hours), "validity_months": c.validity_months, "mandatory": c.mandatory}


def _train(r):
    return {"id": str(r.id), "employee": str(r.employee_id), "employee_no": r.employee.employee_no, "course": r.course.code, "completed_on": str(r.completed_on), "expires_on": _s(r.expires_on), "score": _s(r.score)}


def _case(c, notes=False):
    d = {"id": str(c.id), "employee": str(c.employee_id), "employee_no": c.employee.employee_no, "kind": c.kind, "summary": c.summary, "status": c.status, "outcome": c.outcome}
    if notes:
        d["notes"] = [{"author": str(n.author_id), "text": n.text, "at": n.created_at.isoformat()} for n in c.notes.order_by("created_at")]
    return d


def _pol(p, acked=None, body=True):
    d = {"id": str(p.id), "code": p.code, "version": p.version, "title": p.title, "status": p.status, "published_at": p.published_at.isoformat() if p.published_at else None}
    if body:
        d["body"] = p.body
    if acked is not None:
        d["acknowledged"] = acked
    return d


def _claim(r):
    return {"id": str(r.id), "employee": str(r.employee_id), "employee_no": r.employee.employee_no, "description": r.description, "expense_date": str(r.expense_date), "amount": str(r.amount), "status": r.status, "decision_note": r.decision_note}


# ------------------------------------------------------------------ recruitment
class Requisitions(APIView):
    def get_permissions(self):
        return perm("hr.recruitment.manage")

    def get(self, request):
        return paginate(request, m.JobRequisition.objects.order_by("-created_at"), _req)

    def post(self, request):
        b = request.data
        return Response(_req(t.create_requisition(request.user.id, title=b.get("title"), justification=b.get("justification"), headcount=b.get("headcount", 1), department_id=b.get("department"), position_id=b.get("position"))), status=201)


class RequisitionAction(APIView):
    def get_permissions(self):
        return perm("hr.recruitment.approve" if self.kwargs.get("action") in ("approve", "reject") else "hr.recruitment.manage")

    def post(self, request, pk, action):
        u, note = request.user.id, request.data.get("note", "")
        fn = {"submit": lambda: t.submit_requisition(u, pk), "approve": lambda: t.decide_requisition(u, pk, approve=True, note=note), "reject": lambda: t.decide_requisition(u, pk, approve=False, note=note), "close": lambda: t.close_requisition(u, pk)}.get(action) or (lambda: _unknown(action))
        return Response(_req(fn()))


class Candidates(APIView):
    def get_permissions(self):
        return perm("hr.recruitment.manage")

    def get(self, request, pk):
        return paginate(request, m.Candidate.objects.filter(requisition_id=pk).order_by("created_at"), _cand)

    def post(self, request, pk):
        b = request.data
        return Response(_cand(t.add_candidate(request.user.id, pk, name=b.get("name"), email=b.get("email"), phone=b.get("phone", ""), source=b.get("source", ""))), status=201)


class CandidateMove(APIView):
    def get_permissions(self):
        return perm("hr.recruitment.manage")

    def post(self, request, pk):
        return Response(_cand(t.move_candidate(request.user.id, pk, request.data.get("stage"), request.data.get("reason", ""))))


class CandidateScorecard(APIView):
    def get_permissions(self):
        return perm("hr.recruitment.manage")

    def get(self, request, pk):
        return Response(t.scorecard(request.user.id, pk))


class CandidateHire(APIView):
    def get_permissions(self):
        return perm("hr.recruitment.manage")

    def post(self, request, pk):
        e = t.hire_candidate(request.user.id, pk)
        return Response({"employee": str(e.id), "employee_no": e.employee_no}, status=201)


class Interviews(APIView):
    def get_permissions(self):
        return perm("hr.recruitment.manage")

    def post(self, request, pk):
        b = request.data
        return Response(_int(t.schedule_interview(request.user.id, pk, interviewer_id=b.get("interviewer"), scheduled_at=_dt(b.get("scheduled_at"), "scheduled_at"))), status=201)


class MyInterviews(APIView):
    def get_permissions(self):
        return perm("hr.self")

    def get(self, request):
        return Response([_int(i) for i in m.Interview.objects.select_related("candidate").filter(interviewer_id=request.user.id, status="SCHEDULED").order_by("scheduled_at")])


class InterviewFeedback(APIView):
    def get_permissions(self):
        return perm("hr.self")

    def post(self, request, pk):
        b = request.data
        return Response(_int(t.submit_feedback(request.user.id, pk, score=b.get("score", 0), recommendation=b.get("recommendation"), feedback=b.get("feedback", ""))))


class Offers(APIView):
    def get_permissions(self):
        return perm("hr.recruitment.manage")

    def post(self, request, pk):
        b = request.data
        return Response(_offer(t.create_offer(request.user.id, pk, monthly_salary=b.get("monthly_salary"), currency=b.get("currency", ""), start_date=_req_date(b.get("start_date"), "start_date"))), status=201)


class OfferAction(APIView):
    def get_permissions(self):
        return perm("hr.recruitment.approve" if self.kwargs.get("action") == "approve" else "hr.recruitment.manage")

    def post(self, request, pk, action):
        u = request.user.id
        fn = {"approve": lambda: t.approve_offer(u, pk), "accept": lambda: t.respond_offer(u, pk, accept=True), "decline": lambda: t.respond_offer(u, pk, accept=False)}.get(action) or (lambda: _unknown(action))
        return Response(_offer(fn()))


class Funnel(APIView):
    def get_permissions(self):
        return perm("hr.recruitment.manage")

    def get(self, request):
        return Response(t.recruitment_funnel(request.user.id, request.query_params.get("requisition")))


# ------------------------------------------------------------------ performance
class Cycles(APIView):
    def get_permissions(self):
        return perm("hr.performance.manage" if self.request.method == "POST" else "hr.self")

    def get(self, request):
        return Response([_cycle(c) for c in m.ReviewCycle.objects.order_by("-start_date")])

    def post(self, request):
        b = request.data
        return Response(_cycle(t.create_cycle(request.user.id, name=b.get("name"), start_date=_req_date(b.get("start_date"), "start_date"), end_date=_req_date(b.get("end_date"), "end_date"))), status=201)


class CycleAction(APIView):
    def get_permissions(self):
        return perm("hr.performance.manage")

    def post(self, request, pk, action):
        fn = {"activate": t.activate_cycle, "close": t.close_cycle}.get(action) or (lambda *a: _unknown(action))
        return Response(_cycle(fn(request.user.id, pk)))


class Reviews(APIView):
    def get_permissions(self):
        return perm("hr.self")

    def get(self, request):
        return paginate(request, t.reviews_visible(request.user.id, request.query_params.get("cycle")).order_by("employee__employee_no"), _review(request.user.id))


class ReviewAction(APIView):
    def get_permissions(self):
        return perm("hr.self")

    def post(self, request, pk, action):
        u, b = request.user.id, request.data
        fn = {"self": lambda: t.submit_self_review(u, pk, rating=b.get("rating", 0), comment=b.get("comment", "")), "manager": lambda: t.submit_manager_review(u, pk, rating=b.get("rating", 0), comment=b.get("comment", "")), "acknowledge": lambda: t.acknowledge_review(u, pk)}.get(action) or (lambda: _unknown(action))
        return Response(_review(u)(fn()))


class Goals(APIView):
    def get_permissions(self):
        return perm("hr.self")

    def get(self, request):
        qs = m.Goal.objects.filter(employee__in=services.visible_employees(request.user.id))
        if request.query_params.get("cycle"):
            qs = qs.filter(cycle_id=request.query_params["cycle"])
        return paginate(request, qs.order_by("created_at"), _goal)

    def post(self, request):
        b = request.data
        return Response(_goal(t.add_goal(request.user.id, b.get("employee"), b.get("cycle"), title=b.get("title"), weight=b.get("weight", 0))), status=201)


class GoalProgress(APIView):
    def get_permissions(self):
        return perm("hr.self")

    def post(self, request, pk):
        return Response(_goal(t.update_progress(request.user.id, pk, request.data.get("progress"))))


# ------------------------------------------------------------------ learning
class Courses(APIView):
    def get_permissions(self):
        return perm("hr.learning.manage" if self.request.method == "POST" else "hr.self")

    def get(self, request):
        return Response([_course(c) for c in m.TrainingCourse.objects.filter(is_active=True).order_by("code")])

    def post(self, request):
        b = request.data
        return Response(_course(t.create_course(request.user.id, code=b.get("code"), name=b.get("name"), hours=b.get("hours", 0), validity_months=b.get("validity_months"), mandatory=b.get("mandatory", False), provider=b.get("provider", ""))), status=201)


class TrainingRecords(APIView):
    def get_permissions(self):
        return perm("hr.learning.manage" if self.request.method == "POST" else "hr.self")

    def get(self, request):
        return paginate(request, t.training_visible(request.user.id).order_by("-completed_on"), _train)

    def post(self, request):
        b = request.data
        return Response(_train(t.record_training(request.user.id, b.get("employee"), b.get("course"), completed_on=_req_date(b.get("completed_on"), "completed_on"), score=b.get("score"))), status=201)


class TrainingCompliance(APIView):
    def get_permissions(self):
        return perm("hr.learning.manage")

    def get(self, request):
        return Response(t.training_compliance(request.user.id, within_days=int(request.query_params.get("within_days", 30))))


# ------------------------------------------------------------------ cases
class Cases(APIView):
    def get_permissions(self):
        return perm("hr.cases.manage" if self.request.method == "POST" else "hr.self")

    def get(self, request):
        return paginate(request, t.cases_visible(request.user.id).order_by("-created_at"), _case)

    def post(self, request):
        b = request.data
        return Response(_case(t.open_case(request.user.id, b.get("employee"), kind=b.get("kind"), summary=b.get("summary"))), status=201)


class Grievance(APIView):
    def get_permissions(self):
        return perm("hr.self")

    def post(self, request):
        return Response(_case(t.file_grievance(request.user.id, request.data.get("summary"))), status=201)


class CaseDetail(APIView):
    def get_permissions(self):
        return perm("hr.self")

    def get(self, request, pk):
        c = t.cases_visible(request.user.id).filter(pk=pk).first()
        if c is None:
            raise services._404("Case")
        from platform_core.authorization import services as authz

        return Response(_case(c, notes=authz.has_permission(request.user.id, "hr.cases.manage")))


class CaseAction(APIView):
    def get_permissions(self):
        return perm("hr.cases.manage")

    def post(self, request, pk, action):
        if action == "notes":
            n = t.add_case_note(request.user.id, pk, request.data.get("text"))
            return Response({"id": str(n.id)}, status=201)
        if action == "close":
            return Response(_case(t.close_case(request.user.id, pk, request.data.get("outcome"))))
        _unknown(action)


# ------------------------------------------------------------------ policies
class Policies(APIView):
    def get_permissions(self):
        return perm("hr.policy.manage" if self.request.method == "POST" else "hr.self")

    def get(self, request):
        return Response([_pol(p, acked) for p, acked in t.policies_for(request.user.id)])

    def post(self, request):
        b = request.data
        return Response(_pol(t.create_policy(request.user.id, code=b.get("code"), title=b.get("title"), body=b.get("body"))), status=201)


class PolicyUpdate(APIView):
    def get_permissions(self):
        return perm("hr.policy.manage")

    def put(self, request, pk):
        return Response(_pol(t.update_policy(request.user.id, pk, title=request.data.get("title"), body=request.data.get("body"))))

    def get(self, request, pk):
        return Response(t.outstanding_acknowledgments(request.user.id, pk))


class PolicyAction(APIView):
    def get_permissions(self):
        return perm("hr.self" if self.kwargs.get("action") == "acknowledge" else "hr.policy.manage")

    def post(self, request, pk, action):
        if action == "publish":
            return Response(_pol(t.publish_policy(request.user.id, pk)))
        if action == "acknowledge":
            a = t.acknowledge_policy(request.user.id, pk)
            return Response({"policy": str(a.policy_id), "acknowledged": True})
        _unknown(action)


# ------------------------------------------------------------------ reimbursements
class Reimbursements(APIView):
    def get_permissions(self):
        return perm("hr.self")

    def get(self, request):
        return paginate(request, t.my_reimbursements(request.user.id).order_by("-created_at"), _claim)

    def post(self, request):
        b = request.data
        return Response(_claim(t.submit_reimbursement(request.user.id, description=b.get("description"), expense_date=_req_date(b.get("expense_date"), "expense_date"), amount=b.get("amount"))), status=201)


class ReimbursementAction(APIView):
    def get_permissions(self):
        return perm("hr.reimbursement.approve")

    def post(self, request, pk, action):
        if action not in ("approve", "reject"):
            _unknown(action)
        return Response(_claim(t.decide_reimbursement(request.user.id, pk, approve=action == "approve", note=request.data.get("note", ""))))


# ------------------------------------------------------------------ analytics
class Analytics(APIView):
    def get_permissions(self):
        return perm("hr.analytics.view")

    def get(self, request, kind):
        u, q = request.user.id, request.query_params
        year = int(q.get("year", timezone.now().year))
        fn = {"dashboard": lambda: an.dashboard(u, year), "headcount": lambda: an.headcount(u), "turnover": lambda: an.turnover(u, year), "tenure": lambda: an.tenure_bands(u), "payroll-cost": lambda: an.payroll_cost(u, year), "absenteeism": lambda: an.absenteeism(u, year), "recruitment": lambda: an.recruitment(u), "performance": lambda: an.performance(u, q.get("cycle"))}.get(kind) or (lambda: _unknown(kind))
        return Response(fn())
