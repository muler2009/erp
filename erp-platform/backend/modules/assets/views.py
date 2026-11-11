from datetime import date

from django.db.models import Q
from rest_framework.response import Response
from rest_framework.views import APIView

from modules.assets import models as m
from modules.assets import services as svc
from platform_core.authorization.permissions import require
from shared.api.errors import ValidationFailed
from shared.api.pagination import paginate


def perm(code):
    return [require(code)()]


def _s(v):
    return None if v is None else str(v)


def _cat(c):
    return {"id": str(c.id), "code": c.code, "name": c.name, "parent": _s(c.parent_id), "prefix": c.prefix, "asset_class": c.asset_class, "purpose": c.purpose, "operational_function": c.operational_function, "capitalization_threshold": str(c.capitalization_threshold), "depreciation_method": c.depreciation_method, "useful_life_months": c.useful_life_months,
            "residual_percent": str(c.residual_percent), "reducing_rate_percent": _s(c.reducing_rate_percent), "tracking": c.tracking, "requires_serial": c.requires_serial, "requires_insurance": c.requires_insurance, "maintenance_interval_days": c.maintenance_interval_days, "inspection_interval_days": c.inspection_interval_days, "is_active": c.is_active}


def _asset(a):
    return {"id": str(a.id), "number": a.number, "name": a.name, "description": a.description, "category": {"id": str(a.category_id), "code": a.category.code}, "asset_class": a.asset_class, "status": a.status, "manufacturer": a.manufacturer, "model": a.model, "serial_number": a.serial_number, "supplier_id": _s(a.supplier_id),
            "acquisition_date": _s(a.acquisition_date), "purchase_cost": str(a.purchase_cost), "currency": a.currency, "location": None if not a.location_id else {"id": str(a.location_id), "code": a.location.code}, "legal_entity_id": _s(a.legal_entity_id), "department_id": _s(a.department_id), "custodian_id": _s(a.custodian_id), "responsible_id": _s(a.responsible_id),
            "barcode": a.barcode, "qr_code": a.qr_code, "rfid_tag": a.rfid_tag, "version": a.version}


def _d(v):
    try:
        return date.fromisoformat(v) if v else None
    except ValueError:
        raise ValidationFailed("Dates must be YYYY-MM-DD.", code="invalid_date")


ASSET_KEYS = ("description", "manufacturer", "model", "serial_number", "supplier_id", "currency", "location_id", "legal_entity_id", "department_id", "custodian_id", "responsible_id", "asset_class", "rfid_tag", "barcode", "qr_code", "purchase_cost")


def _asset_attrs(b):
    out = {k: b[k] for k in ASSET_KEYS if k in b}
    if "acquisition_date" in b:
        out["acquisition_date"] = _d(b["acquisition_date"])
    return out


class Categories(APIView):
    def get_permissions(self):
        return perm("assets.category.manage" if self.request.method == "POST" else "assets.view")

    def get(self, request):
        return Response({"results": [_cat(c) for c in m.AssetCategory.objects.order_by("code")]})

    def post(self, request):
        b = dict(request.data)
        c = svc.create_category(request.user.id, code=b.pop("code", ""), name=b.pop("name", ""), **b)
        return Response(_cat(c), status=201)


class CategoryDetail(APIView):
    def get_permissions(self):
        return perm("assets.category.manage" if self.request.method == "PATCH" else "assets.view")

    def get(self, request, pk):
        from shared.api.errors import DomainError

        c = m.AssetCategory.objects.filter(pk=pk).first()
        if c is None:
            raise DomainError("Category not found.", code="not_found", status_code=404)
        return Response(_cat(c))

    def patch(self, request, pk):
        return Response(_cat(svc.update_category(request.user.id, pk, **dict(request.data))))


class Locations(APIView):
    def get_permissions(self):
        return perm("assets.location.manage" if self.request.method == "POST" else "assets.view")

    def get(self, request):
        return Response({"results": [{"id": str(l.id), "code": l.code, "name": l.name, "parent": _s(l.parent_id), "branch_id": _s(l.branch_id), "is_active": l.is_active} for l in m.AssetLocation.objects.order_by("code")]})

    def post(self, request):
        b = request.data
        l = svc.create_location(request.user.id, code=b.get("code", ""), name=b.get("name", ""), parent_id=b.get("parent"), branch_id=b.get("branch_id"), address=b.get("address", ""))
        return Response({"id": str(l.id), "code": l.code}, status=201)


class Assets(APIView):
    def get_permissions(self):
        return perm("assets.asset.manage" if self.request.method == "POST" else "assets.view")

    def get(self, request):
        q = request.query_params
        qs = m.Asset.objects.select_related("category", "location")
        for param, field in (("status", "status"), ("category", "category_id"), ("location", "location_id"), ("department", "department_id"), ("custodian", "custodian_id"), ("class", "asset_class")):
            if q.get(param):
                qs = qs.filter(**{field: q[param]})
        if q.get("q"):
            qs = qs.filter(Q(number__icontains=q["q"]) | Q(name__icontains=q["q"]) | Q(serial_number__icontains=q["q"]))
        return paginate(request, qs, _asset)

    def post(self, request):
        b = request.data
        a = svc.create_asset(request.user.id, category_id=b.get("category"), name=b.get("name", ""), status=b.get("status", "REQUESTED"), **_asset_attrs(b))
        return Response(_asset(svc._get(a.id)), status=201)


class AssetDetail(APIView):
    def get_permissions(self):
        return perm("assets.asset.manage" if self.request.method == "PATCH" else "assets.view")

    def get(self, request, pk):
        return Response(_asset(svc._get(pk)))

    def patch(self, request, pk):
        b = request.data
        attrs = _asset_attrs(b)
        if "name" in b:
            attrs["name"] = b["name"]
        a = svc.update_asset(request.user.id, pk, expected_version=b.get("version"), **attrs)
        return Response(_asset(svc._get(a.id)))


class AssetStatus(APIView):
    def get_permissions(self):
        return perm("assets.asset.manage")

    def post(self, request, pk):
        a = svc.set_status(request.user.id, pk, request.data.get("status", ""), reason=request.data.get("reason", ""), manual=True)
        return Response(_asset(svc._get(a.id)))


class AssetDocuments(APIView):
    def get_permissions(self):
        return perm("assets.asset.manage" if self.request.method == "POST" else "assets.view")

    def get(self, request, pk):
        svc._get(pk)
        return Response({"results": [{"id": str(d.id), "type": d.doc_type, "title": d.title, "file_id": str(d.file_id)} for d in m.AssetDocument.objects.filter(asset_id=pk)]})

    def post(self, request, pk):
        up = request.FILES.get("file")
        if up is None:
            raise ValidationFailed("A file is required.", code="file_required")
        d = svc.add_document(request.user.id, pk, doc_type=request.data.get("doc_type", "OTHER"), title=request.data.get("title", ""), filename=up.name, data=up.read())
        return Response({"id": str(d.id), "file_id": str(d.file_id)}, status=201)


class AssetHistoryView(APIView):
    def get_permissions(self):
        return perm("assets.view")

    def get(self, request, pk):
        return Response({"results": svc.history(pk)})


class AssetLabel(APIView):
    def get_permissions(self):
        return perm("assets.view")

    def get(self, request, pk):
        return Response(svc.label(svc._get(pk)))


class AssetLookup(APIView):
    def get_permissions(self):
        return perm("assets.view")

    def get(self, request):
        return Response(_asset(svc.find_by_code(request.query_params.get("code", ""))))


# ----------------------------------------------------------------------------- acquisition and capitalization (A-B)
from modules.assets import acquisition as acq  # noqa: E402


def _req(r):
    return {"id": str(r.id), "number": r.number, "asset": r.asset.number, "status": r.status, "capitalize": r.capitalize, "total_cost": str(r.total_cost), "base_amount": str(r.base_amount), "capitalization_date": str(r.capitalization_date), "decision_note": r.decision_note}


class AcquisitionView(APIView):
    def get_permissions(self):
        return perm("assets.acquisition.manage" if self.request.method == "POST" else "assets.view")

    def get(self, request, pk):
        return Response(acq.acquisition_view(pk))

    def post(self, request, pk):
        b = request.data
        a = acq.record_acquisition(request.user.id, pk, source=b.get("source", ""), cost=b.get("cost"), po_id=b.get("po"), goods_receipt_id=b.get("goods_receipt"), invoice_id=b.get("invoice"), contract_id=b.get("contract"), reference_note=b.get("reference_note", ""), delivered_on=_d(b.get("delivered_on")), currency=b.get("currency"))
        return Response(acq.acquisition_view(a.asset_id), status=201)


class AcquisitionAction(APIView):
    def get_permissions(self):
        return perm("assets.acquisition.manage")

    def post(self, request, pk, action):
        b, uid = request.data, request.user.id
        if action == "cost":
            acq.add_cost(uid, pk, kind=b.get("kind", ""), description=b.get("description", ""), amount=b.get("amount"), invoice_id=b.get("invoice"))
        elif action == "accept":
            acq.accept_delivery(uid, pk, delivered_on=_d(b.get("delivered_on")) or date.today(), notes=b.get("notes", ""))
        elif action == "commission":
            acq.commission(uid, pk, passed=b.get("passed") is True, on_date=_d(b.get("date")) or date.today(), notes=b.get("notes", ""))
        elif action == "capitalize":
            return Response(_req(acq.request_capitalization(uid, pk, capitalization_date=_d(b.get("date")) or date.today())), status=201)
        else:
            from shared.api.errors import DomainError

            raise DomainError("Unknown action.", code="not_found", status_code=404)
        return Response(acq.acquisition_view(pk))


class Capitalizations(APIView):
    def get_permissions(self):
        return perm("assets.view")

    def get(self, request):
        qs = m.CapitalizationRequest.objects.select_related("asset").order_by("-created_at")
        if request.query_params.get("status"):
            qs = qs.filter(status=request.query_params["status"])
        return Response({"results": [_req(r) for r in qs[:200]]})


class CapitalizationDecision(APIView):
    def get_permissions(self):
        return perm("assets.capitalization.approve")

    def post(self, request, pk, action):
        if action == "approve":
            r = acq.approve_capitalization(request.user.id, pk)
        elif action == "reject":
            r = acq.reject_capitalization(request.user.id, pk, note=request.data.get("note", ""))
        else:
            from shared.api.errors import DomainError

            raise DomainError("Unknown action.", code="not_found", status_code=404)
        return Response(_req(m.CapitalizationRequest.objects.select_related("asset").get(pk=r.pk)))


class AcquisitionReport(APIView):
    def get_permissions(self):
        return perm("assets.view")

    def get(self, request):
        q = request.query_params
        return Response({"results": acq.acquisition_report(_d(q.get("from")) or date(2000, 1, 1), _d(q.get("to")) or date.today())})


# ----------------------------------------------------------------------------- custody and transfers (A-C)
from django.http import HttpResponse  # noqa: E402

from modules.assets import custody as cu  # noqa: E402
from shared.api.errors import DomainError  # noqa: E402


def _asg(a):
    return {"id": str(a.id), "number": a.number, "asset": a.asset.number, "assignee_type": a.assignee_type, "assignee_id": _s(a.assignee_id), "project": a.assignee_ref, "kind": a.kind, "status": a.status, "assigned_on": str(a.assigned_on), "expected_return_on": _s(a.expected_return_on), "returned_on": _s(a.returned_on), "condition_out": a.condition_out, "condition_in": a.condition_in, "acknowledged": bool(a.acknowledged_at)}


def _tr(t):
    return {"id": str(t.id), "number": t.number, "asset": t.asset.number, "status": t.status, "reason": t.reason, "effective_date": str(t.effective_date), "to_location": _s(t.to_location_id), "to_department": _s(t.to_department_id), "to_custodian": _s(t.to_custodian_id), "to_project": t.to_project_ref, "condition_out": t.condition_out, "condition_in": t.condition_in}


class Assignments(APIView):
    def get_permissions(self):
        return perm("assets.custody.manage" if self.request.method == "POST" else "assets.view")

    def get(self, request):
        qs = m.AssetAssignment.objects.select_related("asset").order_by("-created_at")
        for p, f in (("status", "status"), ("asset", "asset_id"), ("assignee", "assignee_id")):
            if request.query_params.get(p):
                qs = qs.filter(**{f: request.query_params[p]})
        return paginate(request, qs, _asg)

    def post(self, request):
        b = request.data
        a = cu.request_assignment(request.user.id, b.get("asset"), assignee_type=b.get("assignee_type", ""), assignee_id=b.get("assignee_id"), assignee_ref=b.get("project", ""), kind=b.get("kind", "PERMANENT"), assigned_on=_d(b.get("assigned_on")) or date.today(), expected_return_on=_d(b.get("expected_return_on")), purpose=b.get("purpose", ""))
        return Response(_asg(m.AssetAssignment.objects.select_related("asset").get(pk=a.pk)), status=201)


class AssignmentAction(APIView):
    def get_permissions(self):
        a = self.kwargs.get("action")
        if a in ("approve", "reject"):
            return perm("assets.custody.approve")
        if a == "acknowledge":
            return perm("assets.custody.acknowledge")
        return perm("assets.custody.manage")

    def post(self, request, pk, action):
        b, uid = request.data, request.user.id
        if action == "approve":
            a = cu.approve_assignment(uid, pk, approve=True)
        elif action == "reject":
            a = cu.approve_assignment(uid, pk, approve=False, note=b.get("note", ""))
        elif action == "handover":
            a = cu.hand_over(uid, pk, condition=b.get("condition", ""), notes=b.get("notes", ""))
        elif action == "acknowledge":
            a = cu.acknowledge_custody(uid, pk)
        elif action == "return":
            a = cu.record_return(uid, pk, condition=b.get("condition", ""), notes=b.get("notes", ""), returned_on=_d(b.get("returned_on")))
        elif action == "cancel":
            a = cu.cancel_assignment(uid, pk)
        else:
            raise DomainError("Unknown action.", code="not_found", status_code=404)
        return Response(_asg(m.AssetAssignment.objects.select_related("asset").get(pk=a.pk)))


class HandoverForm(APIView):
    def get_permissions(self):
        return perm("assets.view")

    def get(self, request, pk):
        if request.query_params.get("format") == "html" or request.query_params.get("export") == "html":
            return HttpResponse(cu.handover_html(pk), content_type="text/html")
        return Response(cu.handover_form(pk))


class CustodyReport(APIView):
    def get_permissions(self):
        return perm("assets.view")

    def get(self, request):
        q = request.query_params
        return Response({"results": cu.custody_report(employee_id=q.get("employee"), department_id=q.get("department")), "unreturned": cu.unreturned(), "unacknowledged": cu.unacknowledged()})


class Transfers(APIView):
    def get_permissions(self):
        return perm("assets.custody.manage" if self.request.method == "POST" else "assets.view")

    def get(self, request):
        return Response({"results": cu.transfer_history(request.query_params.get("asset"))})

    def post(self, request):
        b = request.data
        t = cu.request_transfer(request.user.id, b.get("asset"), reason=b.get("reason", ""), effective_date=_d(b.get("effective_date")) or date.today(), to_location_id=b.get("to_location"), to_department_id=b.get("to_department"), to_custodian_id=b.get("to_custodian"), to_project_ref=b.get("to_project", ""))
        return Response(_tr(m.AssetTransfer.objects.select_related("asset").get(pk=t.pk)), status=201)


class TransferAction(APIView):
    def get_permissions(self):
        a = self.kwargs.get("action")
        if a in ("approve", "reject"):
            return perm("assets.custody.approve")
        if a == "receive":
            return perm("assets.custody.acknowledge")
        return perm("assets.custody.manage")

    def post(self, request, pk, action):
        b, uid = request.data, request.user.id
        if action == "approve":
            t = cu.decide_transfer(uid, pk, approve=True)
        elif action == "reject":
            t = cu.decide_transfer(uid, pk, approve=False, note=b.get("note", ""))
        elif action == "dispatch":
            t = cu.dispatch_transfer(uid, pk, condition=b.get("condition", ""))
        elif action == "receive":
            t = cu.receive_transfer(uid, pk, condition=b.get("condition", ""), notes=b.get("notes", ""))
        elif action == "cancel":
            t = cu.cancel_transfer(uid, pk)
        else:
            raise DomainError("Unknown action.", code="not_found", status_code=404)
        return Response(_tr(m.AssetTransfer.objects.select_related("asset").get(pk=t.pk)))


# ----------------------------------------------------------------------------- depreciation and valuation (A-D)
from modules.assets import depreciation as dp  # noqa: E402


def _adj(a):
    return {"id": str(a.id), "asset": a.asset.number, "kind": a.kind, "status": a.status, "amount": str(a.amount), "effective_date": str(a.effective_date), "reason": a.reason, "extend_life_months": a.extend_life_months, "decision_note": a.decision_note}


def _run(r):
    return {"id": str(r.id), "period": f"{r.year}-{r.month:02d}", "status": r.status, "total": str(r.total_amount), "assets": r.asset_count}


class DepreciationRuns(APIView):
    def get_permissions(self):
        return perm("assets.depreciation.run" if self.request.method == "POST" else "assets.view")

    def get(self, request):
        return Response({"results": dp.depreciation_report(int(request.query_params.get("year", date.today().year)))})

    def post(self, request):
        b = request.data
        try:
            y, mth = int(b.get("year")), int(b.get("month"))
        except (TypeError, ValueError):
            raise ValidationFailed("year and month are required.", code="invalid_period")
        return Response(_run(dp.run_depreciation(request.user.id, y, mth)), status=201)


class DepreciationReverse(APIView):
    def get_permissions(self):
        return perm("assets.depreciation.run")

    def post(self, request, pk):
        return Response(_run(dp.reverse_run(request.user.id, pk, reason=request.data.get("reason", ""))))


class AssetSchedule(APIView):
    def get_permissions(self):
        return perm("assets.view")

    def get(self, request, pk):
        return Response({"results": dp.schedule(pk)})


class Adjustments(APIView):
    def get_permissions(self):
        return perm("assets.view")

    def get(self, request):
        qs = m.ValuationAdjustment.objects.select_related("asset").order_by("-created_at")
        if request.query_params.get("status"):
            qs = qs.filter(status=request.query_params["status"])
        return Response({"results": [_adj(a) for a in qs[:200]]})


class AssetAdjustments(APIView):
    def get_permissions(self):
        return perm("assets.valuation.manage")

    def post(self, request, pk):
        b = request.data
        a = dp.request_adjustment(request.user.id, pk, kind=b.get("kind", ""), amount=b.get("amount"), effective_date=_d(b.get("effective_date")) or date.today(), reason=b.get("reason", ""), extend_life_months=b.get("extend_life_months", 0))
        return Response(_adj(m.ValuationAdjustment.objects.select_related("asset").get(pk=a.pk)), status=201)


class AdjustmentDecision(APIView):
    def get_permissions(self):
        return perm("assets.valuation.approve")

    def post(self, request, pk, action):
        if action not in ("approve", "reject"):
            raise DomainError("Unknown action.", code="not_found", status_code=404)
        a = dp.decide_adjustment(request.user.id, pk, approve=action == "approve", note=request.data.get("note", ""))
        return Response(_adj(m.ValuationAdjustment.objects.select_related("asset").get(pk=a.pk)))


class DepreciationPolicy(APIView):
    def get_permissions(self):
        return perm("assets.valuation.manage")

    def post(self, request, pk):
        b = request.data
        a = dp.change_policy(request.user.id, pk, reason=b.get("reason", ""), useful_life_months=b.get("useful_life_months"), residual_value=b.get("residual_value"), method=b.get("method"), reducing_rate_percent=b.get("reducing_rate_percent"), depreciation_start=_d(b.get("depreciation_start")))
        return Response(_asset(svc._get(a.id)))


class ValuationReport(APIView):
    def get_permissions(self):
        return perm("assets.view")

    def get(self, request):
        q = request.query_params
        return Response(dp.valuation_report(_d(q.get("as_of")), q.get("category")))


class Reconciliation(APIView):
    def get_permissions(self):
        return perm("assets.view")

    def get(self, request):
        return Response(dp.reconcile())
