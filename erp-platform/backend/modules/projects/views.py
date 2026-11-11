from datetime import date

from rest_framework.response import Response
from rest_framework.views import APIView

from modules.projects import models as m
from modules.projects import services as svc
from modules.projects import wbs as tk
from platform_core.authorization.permissions import require
from shared.api.errors import DomainError, ValidationFailed
from shared.api.pagination import paginate


def perm(code):
    return [require(code)()]


def _s(v):
    return None if v is None else str(v)


def _d(v):
    try:
        return date.fromisoformat(v) if v else None
    except ValueError:
        raise ValidationFailed("Dates must be YYYY-MM-DD.", code="invalid_date")


def _prj(p):
    return {"id": str(p.id), "code": p.code, "name": p.name, "description": p.description, "status": p.status, "billing_type": p.billing_type, "contract_value": str(p.contract_value), "customer_id": _s(p.customer_id), "manager_id": str(p.manager_id), "department_id": _s(p.department_id), "cost_center_id": _s(p.cost_center_id),
            "priority": p.priority, "start_on": str(p.start_on), "end_on": str(p.end_on), "actual_start": _s(p.actual_start), "actual_end": _s(p.actual_end), "version": p.version}


def _mem(x):
    return {"id": str(x.id), "user_id": str(x.user_id), "role": x.role, "cost_rate": str(x.cost_rate), "bill_rate": str(x.bill_rate), "allocation_percent": str(x.allocation_percent), "is_active": x.is_active}


def _task(t):
    return {"id": str(t.id), "wbs": t.wbs_code, "name": t.name, "parent": _s(t.parent_id), "milestone": t.is_milestone, "status": t.status, "assignee": _s(t.assignee_id), "planned_start": str(t.planned_start), "planned_end": str(t.planned_end), "planned_hours": str(t.planned_hours), "percent_complete": str(t.percent_complete), "actual_start": _s(t.actual_start), "actual_end": _s(t.actual_end)}


class Projects(APIView):
    def get_permissions(self):
        return perm("projects.create" if self.request.method == "POST" else "projects.view")

    def get(self, request):
        qs = svc.visible_projects(request.user.id)
        if request.query_params.get("status"):
            qs = qs.filter(status=request.query_params["status"])
        if request.query_params.get("q"):
            qs = qs.filter(name__icontains=request.query_params["q"])
        return paginate(request, qs, _prj)

    def post(self, request):
        b = request.data
        p = svc.create_project(request.user.id, name=b.get("name", ""), start_on=_d(b.get("start_on")), end_on=_d(b.get("end_on")), manager_id=b.get("manager_id"), description=b.get("description", ""), billing_type=b.get("billing_type", "FIXED"), contract_value=b.get("contract_value", 0), customer_id=b.get("customer_id"), department_id=b.get("department_id"), cost_center_id=b.get("cost_center_id"), priority=b.get("priority", "MEDIUM"))
        return Response(_prj(p), status=201)


class ProjectDetail(APIView):
    def get_permissions(self):
        return perm("projects.view")

    def get(self, request, pk):
        return Response(_prj(svc.require_view(request.user.id, pk)))

    def patch(self, request, pk):
        b = dict(request.data)
        for k in ("start_on", "end_on"):
            if k in b:
                b[k] = _d(b[k])
        return Response(_prj(svc.update_project(request.user.id, pk, **b)))


class ProjectStatus(APIView):
    def get_permissions(self):
        return perm("projects.view")

    def post(self, request, pk):
        return Response(_prj(svc.set_status(request.user.id, pk, request.data.get("status", ""), reason=request.data.get("reason", ""))))


class Members(APIView):
    def get_permissions(self):
        return perm("projects.view")

    def get(self, request, pk):
        svc.require_view(request.user.id, pk)
        return Response({"results": [_mem(x) for x in m.ProjectMember.objects.filter(project_id=pk, is_active=True)]})

    def post(self, request, pk):
        b = request.data
        x = svc.add_member(request.user.id, pk, b.get("user_id"), role=b.get("role", "MEMBER"), cost_rate=b.get("cost_rate", 0), bill_rate=b.get("bill_rate", 0), allocation_percent=b.get("allocation_percent", 100), employee_id=b.get("employee_id"))
        return Response(_mem(x), status=201)


class MemberDetail(APIView):
    def get_permissions(self):
        return perm("projects.view")

    def patch(self, request, pk, user_id):
        return Response(_mem(svc.update_member(request.user.id, pk, user_id, **dict(request.data))))

    def delete(self, request, pk, user_id):
        svc.remove_member(request.user.id, pk, user_id)
        return Response(status=204)


class Tasks(APIView):
    def get_permissions(self):
        return perm("projects.view")

    def get(self, request, pk):
        svc.require_view(request.user.id, pk)
        qs = m.Task.objects.filter(project_id=pk)
        if request.query_params.get("assignee"):
            qs = qs.filter(assignee_id=request.query_params["assignee"])
        return Response({"results": [_task(t) for t in qs]})

    def post(self, request, pk):
        b = request.data
        t = tk.create_task(request.user.id, pk, name=b.get("name", ""), planned_start=_d(b.get("planned_start")), planned_end=_d(b.get("planned_end")), parent_id=b.get("parent"), is_milestone=bool(b.get("milestone")), assignee_id=b.get("assignee"), planned_hours=b.get("planned_hours", 0), description=b.get("description", ""))
        return Response(_task(t), status=201)


class TaskDetail(APIView):
    def get_permissions(self):
        return perm("projects.view")

    def _visible(self, request, pk):
        t = m.Task.objects.filter(pk=pk).first()
        if t is None:
            raise DomainError("Task not found.", code="not_found", status_code=404)
        svc.require_view(request.user.id, t.project_id)
        return t

    def get(self, request, pk):
        return Response(_task(self._visible(request, pk)))

    def patch(self, request, pk):
        b = dict(request.data)
        for k in ("planned_start", "planned_end"):
            if k in b:
                b[k] = _d(b[k])
        if "assignee" in b:
            b["assignee_id"] = b.pop("assignee")
        return Response(_task(tk.update_task(request.user.id, pk, **b)))

    def delete(self, request, pk):
        tk.delete_task(request.user.id, pk)
        return Response(status=204)


class TaskProgress(APIView):
    def get_permissions(self):
        return perm("projects.task.update")

    def post(self, request, pk):
        b = request.data
        return Response(_task(tk.update_progress(request.user.id, pk, status=b.get("status"), percent=b.get("percent"), note=b.get("note", ""))))


class TaskShift(APIView):
    def get_permissions(self):
        return perm("projects.view")

    def post(self, request, pk):
        moved = tk.shift_task(request.user.id, pk, request.data.get("days", 0), cascade=bool(request.data.get("cascade", True)))
        return Response({"moved": [_task(t) for t in moved]})


class Dependencies(APIView):
    def get_permissions(self):
        return perm("projects.view")

    def post(self, request):
        b = request.data
        d = tk.add_dependency(request.user.id, b.get("predecessor"), b.get("successor"), kind=b.get("kind", "FS"), lag_days=b.get("lag_days", 0))
        return Response({"id": str(d.id), "kind": d.kind, "lag_days": d.lag_days}, status=201)


class DependencyDetail(APIView):
    def get_permissions(self):
        return perm("projects.view")

    def delete(self, request, pk):
        tk.remove_dependency(request.user.id, pk)
        return Response(status=204)


class Gantt(APIView):
    def get_permissions(self):
        return perm("projects.view")

    def get(self, request, pk):
        svc.require_view(request.user.id, pk)
        return Response(tk.schedule(pk))


class MyTasks(APIView):
    def get_permissions(self):
        return perm("projects.view")

    def get(self, request):
        qs = m.Task.objects.filter(assignee_id=request.user.id, project__status="ACTIVE").exclude(status__in=("DONE", "CANCELLED")).select_related("project").order_by("planned_end")
        return Response({"results": [{**_task(t), "project": t.project.code} for t in qs]})


# ----------------------------------------------------------------------------- budgets, expenses, cost (P-B)
from modules.projects import costs as cs  # noqa: E402
from modules.projects import resources as rs  # noqa: E402


def _exp(e):
    return {"id": str(e.id), "project": str(e.project_id), "task": _s(e.task_id), "category": e.category, "description": e.description, "amount": str(e.amount), "incurred_on": str(e.incurred_on), "claimant_id": str(e.claimant_id), "invoice_id": _s(e.invoice_id), "status": e.status, "decision_note": e.decision_note}


class Budgets(APIView):
    def get_permissions(self):
        return perm("projects.view")

    def get(self, request, pk):
        svc.require_view(request.user.id, pk)
        return Response({"results": [cs.budget_view(b) for b in m.ProjectBudget.objects.filter(project_id=pk).order_by("-revision").prefetch_related("lines")]})

    def post(self, request, pk):
        b = cs.create_budget(request.user.id, pk, request.data.get("lines"), reason=request.data.get("reason", ""))
        return Response(cs.budget_view(b), status=201)


class BudgetAction(APIView):
    def get_permissions(self):
        return perm("projects.budget.approve" if self.kwargs.get("action") in ("approve", "reject") else "projects.view")

    def post(self, request, pk, action):
        b, uid = request.data, request.user.id
        if action == "submit":
            r = cs.submit_budget(uid, pk)
        elif action == "approve":
            r = cs.decide_budget(uid, pk, approve=True)
        elif action == "reject":
            r = cs.decide_budget(uid, pk, approve=False, note=b.get("note", ""))
        elif action == "lines":
            r = cs.replace_lines(uid, pk, b.get("lines"))
        else:
            raise DomainError("Unknown action.", code="not_found", status_code=404)
        return Response(cs.budget_view(m.ProjectBudget.objects.prefetch_related("lines").get(pk=r.pk)))


class Expenses(APIView):
    def get_permissions(self):
        return perm("projects.expense.submit" if self.request.method == "POST" else "projects.view")

    def get(self, request, pk):
        p = svc.require_view(request.user.id, pk)
        qs = m.ProjectExpense.objects.filter(project=p)
        if not svc.can_manage(request.user.id, p):
            qs = qs.filter(claimant_id=request.user.id)  # members see only their own claims
        if request.query_params.get("status"):
            qs = qs.filter(status=request.query_params["status"])
        return paginate(request, qs, _exp)

    def post(self, request, pk):
        b = request.data
        e = cs.submit_expense(request.user.id, pk, category=b.get("category", ""), description=b.get("description", ""), amount=b.get("amount"), incurred_on=_d(b.get("incurred_on")) or date.today(), task_id=b.get("task"), invoice_id=b.get("invoice_id"))
        return Response(_exp(e), status=201)


class ExpenseAction(APIView):
    def get_permissions(self):
        return perm("projects.expense.submit" if self.kwargs.get("action") == "receipt" else "projects.view")

    def post(self, request, pk, action):
        b = request.data
        if action == "approve":
            return Response(_exp(cs.decide_expense(request.user.id, pk, approve=True)))
        if action == "reject":
            return Response(_exp(cs.decide_expense(request.user.id, pk, approve=False, note=b.get("note", ""))))
        if action == "receipt":
            up = request.FILES.get("file")
            if up is None:
                raise ValidationFailed("A file is required.", code="file_required")
            f = cs.add_receipt(request.user.id, pk, filename=up.name, data=up.read())
            return Response({"file_id": str(f.id)}, status=201)
        raise DomainError("Unknown action.", code="not_found", status_code=404)


class CostReport(APIView):
    def get_permissions(self):
        return perm("projects.view")

    def get(self, request, pk):
        p = svc.require_view(request.user.id, pk)
        if not svc.can_see_costs(request.user.id, p):
            raise DomainError("Only the project manager and finance can see project costs.", code="forbidden", status_code=403)
        return Response(cs.cost_report(pk))


class TimeReport(APIView):
    def get_permissions(self):
        return perm("projects.view")

    def get(self, request, pk):
        p = svc.require_view(request.user.id, pk)
        if not svc.can_see_costs(request.user.id, p):
            raise DomainError("Only the project manager and finance can see project costs.", code="forbidden", status_code=403)
        t = cs.time_cost(pk, _d(request.query_params.get("from")), _d(request.query_params.get("to")))
        return Response({"rows": t["rows"], "hours": str(t["hours"]), "cost": str(t["cost"]), "unmatched_hours": str(t["unmatched_hours"])})


class ResourceLoad(APIView):
    def get_permissions(self):
        return perm("projects.view_all")

    def get(self, request):
        f, t = _d(request.query_params.get("from")), _d(request.query_params.get("to"))
        if not (f and t):
            raise ValidationFailed("from and to are required (YYYY-MM-DD).", code="period_required")
        return Response(rs.resource_load(f, t, request.query_params.get("weekly_hours", 40)))


# ----------------------------------------------------------------------------- risks, issues, billing, reporting (P-C)
from modules.projects import billing as bl  # noqa: E402
from modules.projects import reporting as rp  # noqa: E402
from modules.projects import risks as rk  # noqa: E402


def _risk(r):
    return {"id": str(r.id), "title": r.title, "description": r.description, "category": r.category, "probability": r.probability, "impact": r.impact, "score": r.score, "status": r.status, "owner_id": _s(r.owner_id), "mitigation": r.mitigation, "review_on": _s(r.review_on)}


def _issue(i):
    return {"id": str(i.id), "title": i.title, "severity": i.severity, "status": i.status, "assigned_to": _s(i.assigned_to), "due_on": _s(i.due_on), "task": _s(i.task_id), "risk": _s(i.risk_id), "resolution": i.resolution}


class Risks(APIView):
    def get_permissions(self):
        return perm("projects.view")

    def get(self, request, pk):
        svc.require_view(request.user.id, pk)
        return Response({"results": [_risk(r) for r in rk.view_risks(pk)]})

    def post(self, request, pk):
        b = request.data
        r = rk.raise_risk(request.user.id, pk, title=b.get("title", ""), probability=b.get("probability"), impact=b.get("impact"), description=b.get("description", ""), category=b.get("category", ""), owner_id=b.get("owner_id"), mitigation=b.get("mitigation", ""), review_on=_d(b.get("review_on")))
        return Response(_risk(r), status=201)


class RiskDetail(APIView):
    def get_permissions(self):
        return perm("projects.view")

    def patch(self, request, pk):
        b = request.data
        r = rk.update_risk(request.user.id, pk, status=b.get("status"), probability=b.get("probability"), impact=b.get("impact"), mitigation=b.get("mitigation"), owner_id=b.get("owner_id"), review_on=_d(b.get("review_on")), note=b.get("note", ""))
        return Response(_risk(r))


class Issues(APIView):
    def get_permissions(self):
        return perm("projects.view")

    def get(self, request, pk):
        svc.require_view(request.user.id, pk)
        qs = m.Issue.objects.filter(project_id=pk).order_by("-created_at")
        if request.query_params.get("status"):
            qs = qs.filter(status=request.query_params["status"])
        return Response({"results": [_issue(i) for i in qs]})

    def post(self, request, pk):
        b = request.data
        i = rk.raise_issue(request.user.id, pk, title=b.get("title", ""), severity=b.get("severity", "MEDIUM"), description=b.get("description", ""), task_id=b.get("task"), risk_id=b.get("risk"), assigned_to=b.get("assigned_to"), due_on=_d(b.get("due_on")))
        return Response(_issue(i), status=201)


class IssueDetail(APIView):
    def get_permissions(self):
        return perm("projects.view")

    def patch(self, request, pk):
        b = request.data
        return Response(_issue(rk.update_issue(request.user.id, pk, status=b.get("status"), severity=b.get("severity"), assigned_to=b.get("assigned_to"), due_on=_d(b.get("due_on")), resolution=b.get("resolution", ""))))


class Billing(APIView):
    def get_permissions(self):
        return perm("projects.billing.manage" if self.request.method == "POST" else "projects.view")

    def get(self, request, pk):
        p = svc.require_view(request.user.id, pk)
        if not svc.can_see_costs(request.user.id, p):
            raise DomainError("Only the project manager and finance can see billing.", code="forbidden", status_code=403)
        return Response(bl.billing_summary(pk))

    def post(self, request, pk):
        b = request.data
        r = bl.invoice_project(request.user.id, pk, kind=b.get("kind", ""), invoice_date=_d(b.get("invoice_date")) or date.today(), amount=b.get("amount"), description=b.get("description", ""), task_id=b.get("task"), period_start=_d(b.get("period_start")), period_end=_d(b.get("period_end")), tax_rate_id=b.get("tax_rate"))
        return Response({"invoice_id": str(r.invoice_id), "kind": r.kind, "amount": str(r.amount)}, status=201)


class TimeBillingPreview(APIView):
    def get_permissions(self):
        return perm("projects.billing.manage")

    def get(self, request, pk):
        svc.require_manage(request.user.id, pk, editable=False)
        f, t = _d(request.query_params.get("from")), _d(request.query_params.get("to"))
        if not (f and t):
            raise ValidationFailed("from and to are required (YYYY-MM-DD).", code="period_required")
        r = bl.time_billing_preview(pk, f, t)
        return Response({"rows": r["rows"], "amount": str(r["amount"])})


class Profitability(APIView):
    def get_permissions(self):
        return perm("projects.view")

    def get(self, request, pk):
        p = svc.require_view(request.user.id, pk)
        if not svc.can_see_costs(request.user.id, p):
            raise DomainError("Only the project manager and finance can see profitability.", code="forbidden", status_code=403)
        return Response(rp.profitability(pk))


class Health(APIView):
    def get_permissions(self):
        return perm("projects.view")

    def get(self, request, pk):
        svc.require_view(request.user.id, pk)
        return Response(rp.health(pk))


class Portfolio(APIView):
    def get_permissions(self):
        return perm("projects.view")

    def get(self, request):
        return Response(rp.portfolio(request.user.id))
