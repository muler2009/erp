from datetime import date

from rest_framework.response import Response
from rest_framework.views import APIView

from modules.assets import inspections as ins
from modules.assets import models as m
from modules.assets import warranty as wt
from modules.assets.views import _d, _s, perm
from shared.api.errors import DomainError, ValidationFailed
from shared.api.pagination import paginate


def _tpl(t):
    return {"id": str(t.id), "code": t.code, "name": t.name, "category": _s(t.category_id), "items": t.items, "is_active": t.is_active}


def _ins(i):
    return {"id": str(i.id), "asset": {"id": str(i.asset_id), "number": i.asset.number}, "template": _s(i.template_id), "status": i.status, "scheduled_on": str(i.scheduled_on), "performed_on": _s(i.performed_on), "inspector_id": _s(i.inspector_id), "condition_result": i.condition_result, "results": i.results, "notes": i.notes,
            "findings": [{"id": str(f.id), "description": f.description, "severity": f.severity, "status": f.status, "work_order": _s(f.work_order_id)} for f in i.findings.all()],
            "evidence": [{"file_id": str(e.file_id), "caption": e.caption} for e in i.evidence.all()]}


def _war(w):
    return {"id": str(w.id), "asset": str(w.asset_id), "provider_name": w.provider_name, "reference": w.reference, "start_on": str(w.start_on), "end_on": str(w.end_on), "coverage": w.coverage}


def _claim(c, **extra):
    return {"id": str(c.id), "status": c.status, "description": c.description, "amount_claimed": str(c.amount_claimed), "amount_recovered": str(c.amount_recovered), **extra}


def _pol(p):
    return {"id": str(p.id), "policy_number": p.policy_number, "insurer": p.insurer, "start_on": str(p.start_on), "end_on": str(p.end_on), "premium": str(p.premium), "coverage_amount": str(p.coverage_amount),
            "assets": [{"asset": str(l.asset_id), "insured_value": str(l.insured_value)} for l in p.covered.all()]}


class Templates(APIView):
    def get_permissions(self):
        return perm("assets.view" if self.request.method == "GET" else "assets.maintenance.manage")

    def get(self, request):
        return paginate(request, m.InspectionTemplate.objects.all(), _tpl)

    def post(self, request):
        b = request.data
        return Response(_tpl(ins.create_template(request.user.id, code=b.get("code", ""), name=b.get("name", ""), items=b.get("items"), category_id=b.get("category"))), status=201)


class Inspections(APIView):
    def get_permissions(self):
        return perm("assets.view" if self.request.method == "GET" else "assets.maintenance.manage")

    def get(self, request):
        qs = m.Inspection.objects.select_related("asset").prefetch_related("findings", "evidence")
        if request.query_params.get("status"):
            qs = qs.filter(status=request.query_params["status"])
        if request.query_params.get("asset"):
            qs = qs.filter(asset_id=request.query_params["asset"])
        return paginate(request, qs, _ins)

    def post(self, request):
        b = request.data
        i = ins.schedule(request.user.id, b.get("asset"), scheduled_on=_d(b.get("scheduled_on")) or date.today(), template_id=b.get("template"), inspector_id=b.get("inspector_id"))
        return Response(_ins(m.Inspection.objects.select_related("asset").get(pk=i.pk)), status=201)


class InspectionAction(APIView):
    def get_permissions(self):
        return perm("assets.maintenance.manage")

    def post(self, request, pk, action):
        b, uid = request.data, request.user.id
        if action == "complete":
            ins.complete(uid, pk, results=b.get("results"), condition=b.get("condition", ""), notes=b.get("notes", ""), findings=b.get("findings"), performed_on=_d(b.get("performed_on")))
        elif action == "cancel":
            ins.cancel(uid, pk, b.get("reason", ""))
        elif action == "evidence":
            up = request.FILES.get("file")
            if up is None:
                raise ValidationFailed("A file is required.", code="file_required")
            ins.add_evidence(uid, pk, filename=up.name, data=up.read(), caption=b.get("caption", ""))
        else:
            raise DomainError("Unknown action.", code="not_found", status_code=404)
        return Response(_ins(m.Inspection.objects.select_related("asset").prefetch_related("findings", "evidence").get(pk=pk)))


class FindingAction(APIView):
    def get_permissions(self):
        return perm("assets.maintenance.manage")

    def post(self, request, pk, action):
        b, uid = request.data, request.user.id
        if action == "corrective-action":
            wo = ins.raise_corrective_action(uid, pk, estimated_cost=b.get("estimated_cost", 0), assigned_to_id=b.get("assigned_to_id"))
            return Response({"work_order": wo.number, "status": wo.status}, status=201)
        if action == "resolve":
            f = ins.resolve_finding(uid, pk, notes=b.get("notes", ""))
            return Response({"id": str(f.id), "status": f.status})
        raise DomainError("Unknown action.", code="not_found", status_code=404)


class ConditionReport(APIView):
    def get_permissions(self):
        return perm("assets.view")

    def get(self, request):
        return Response({**ins.condition_report(), "overdue_inspections": ins.overdue()})


class Warranties(APIView):
    def get_permissions(self):
        return perm("assets.view" if self.request.method == "GET" else "assets.insurance.manage")

    def get(self, request, pk):
        w = wt.active_warranty(pk)
        return Response({"in_force": None if w is None else _war(w), "all": [_war(x) for x in m.Warranty.objects.filter(asset_id=pk).order_by("-end_on")]})

    def post(self, request, pk):
        b = request.data
        w = wt.add_warranty(request.user.id, pk, provider_name=b.get("provider_name", ""), start_on=_d(b.get("start_on")), end_on=_d(b.get("end_on")), provider_supplier_id=b.get("provider_supplier_id"), reference=b.get("reference", ""), coverage=b.get("coverage", ""))
        return Response(_war(w), status=201)


class WarrantyClaims(APIView):
    def get_permissions(self):
        return perm("assets.insurance.manage")

    def post(self, request, pk):
        b = request.data
        c = wt.file_claim(request.user.id, pk, description=b.get("description", ""), amount_claimed=b.get("amount_claimed", 0), breakdown_id=b.get("breakdown_id"), claim_date=_d(b.get("claim_date")))
        return Response(_claim(c), status=201)


class ClaimDecision(APIView):
    def get_permissions(self):
        return perm("assets.insurance.manage")

    def post(self, request, kind, pk, action):
        status = {"accept": "ACCEPTED", "reject": "REJECTED", "settle": "SETTLED"}.get(action)
        if status is None or kind not in ("warranty", "insurance"):
            raise DomainError("Unknown action.", code="not_found", status_code=404)
        fn = wt.decide_warranty_claim if kind == "warranty" else wt.decide_insurance_claim
        return Response(_claim(fn(request.user.id, pk, status=status, amount_recovered=request.data.get("amount_recovered", 0))))


class Policies(APIView):
    def get_permissions(self):
        return perm("assets.view" if self.request.method == "GET" else "assets.insurance.manage")

    def get(self, request):
        return paginate(request, m.InsurancePolicy.objects.prefetch_related("covered"), _pol)

    def post(self, request):
        b = request.data
        p = wt.create_policy(request.user.id, policy_number=b.get("policy_number", ""), insurer=b.get("insurer", ""), start_on=_d(b.get("start_on")), end_on=_d(b.get("end_on")), premium=b.get("premium", 0), coverage_amount=b.get("coverage_amount", 0), notes=b.get("notes", ""), asset_ids=b.get("assets"))
        return Response(_pol(m.InsurancePolicy.objects.prefetch_related("covered").get(pk=p.pk)), status=201)


class PolicyAction(APIView):
    def get_permissions(self):
        return perm("assets.insurance.manage")

    def post(self, request, pk, action):
        b, uid = request.data, request.user.id
        if action == "cover":
            wt.cover(uid, pk, b.get("asset"), b.get("insured_value"))
        elif action == "uncover":
            wt.uncover(uid, pk, b.get("asset"))
        elif action == "renew":
            p = wt.renew_policy(uid, pk, policy_number=b.get("policy_number", ""), start_on=_d(b.get("start_on")), end_on=_d(b.get("end_on")), premium=b.get("premium", 0), coverage_amount=b.get("coverage_amount"))
            return Response(_pol(m.InsurancePolicy.objects.prefetch_related("covered").get(pk=p.pk)), status=201)
        elif action == "claims":
            c = wt.file_insurance_claim(uid, pk, b.get("asset"), incident_date=_d(b.get("incident_date")), description=b.get("description", ""), amount_claimed=b.get("amount_claimed", 0))
            return Response(_claim(c), status=201)
        else:
            raise DomainError("Unknown action.", code="not_found", status_code=404)
        return Response(_pol(m.InsurancePolicy.objects.prefetch_related("covered").get(pk=pk)))


class CoverageReports(APIView):
    def get_permissions(self):
        return perm("assets.view")

    def get(self, request, report):
        if report == "uninsured":
            return Response(wt.uninsured_assets())
        if report == "expiring":
            return Response(wt.expiring(int(request.query_params.get("days", 30))))
        raise DomainError("Unknown report.", code="not_found", status_code=404)
