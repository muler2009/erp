import uuid
from datetime import date
from decimal import Decimal

from django.shortcuts import get_object_or_404
from rest_framework import serializers
from rest_framework.response import Response
from rest_framework.views import APIView

from modules.inventory import models as m
from modules.inventory import services
from platform_core.authorization.permissions import require
from shared.api.pagination import paginate


ITEM_FIELDS = ("description", "specifications", "subcategory", "item_type", "status", "stock_control", "qr_code", "min_stock", "max_stock", "reorder_level", "safety_stock", "tracks_expiry", "costing_method", "preferred_supplier_id", "purchase_price", "purchase_lead_days")


LOC_FIELDS = ("kind", "zone", "aisle", "rack", "shelf", "bin", "capacity", "is_blocked")


def _extra(b):
    return {k: b[k] for k in ITEM_FIELDS if k in b}


def perm(code):
    return [require(code)()]


def _s(v):
    return None if v is None else str(v)


def _product(p):
    return {"id": str(p.id), "sku": p.sku, "name": p.name, "uom": p.uom, "barcode": p.barcode, "category": p.category, "tracking": p.tracking, "is_stocked": p.is_stocked, "variant_of": _s(p.variant_of_id), "attributes": p.attributes, "is_active": p.is_active, "on_hand": str(services.on_hand(p.id)), **{k: (str(v) if isinstance(v, (Decimal, uuid.UUID)) else v) for k, v in ((f, getattr(p, f)) for f in ITEM_FIELDS)}}


def _movement(x):
    return {"id": str(x.id), "product": x.product.sku, "location": x.location.code, "lot": x.lot.code if x.lot else None, "type": x.movement_type, "quantity": str(x.quantity), "unit_cost": str(x.unit_cost), "ref_type": x.ref_type, "ref_id": x.ref_id, "reason": x.reason, "at": x.created_at}


class Products(APIView):
    def get_permissions(self):
        return perm("inventory.product.manage" if self.request.method == "POST" else "inventory.view")

    def get(self, request):
        qs = m.Product.objects.all()
        q = request.query_params
        if q.get("barcode"):  # barcode / QR scanners resolve a code to a product
            qs = qs.filter(barcode=q["barcode"])
        if q.get("sku"):
            qs = qs.filter(sku=q["sku"])
        if q.get("search"):
            qs = qs.filter(name__icontains=q["search"])
        return paginate(request, qs, _product, ordering="sku")

    def post(self, request):
        b = request.data
        p = services.create_product(request.user.id, sku=b.get("sku", ""), name=b.get("name", ""), uom=b.get("uom", "unit"), barcode=b.get("barcode"), category=b.get("category", ""), tracking=b.get("tracking", "NONE"), is_stocked=bool(b.get("is_stocked", True)), variant_of_id=b.get("variant_of"), attributes=b.get("attributes"), **_extra(b))
        return Response(_product(p), status=201)


class ProductDetail(APIView):
    def get_permissions(self):
        return perm("inventory.product.manage" if self.request.method == "PATCH" else "inventory.view")

    def get(self, request, pk):
        return Response(_product(get_object_or_404(m.Product, pk=pk)))

    def patch(self, request, pk):
        b = request.data
        return Response(_product(services.update_product(request.user.id, pk, name=b.get("name"), barcode=b.get("barcode"), category=b.get("category"), is_active=b.get("is_active"), **_extra(b))))


class Warehouses(APIView):
    def get_permissions(self):
        return perm("inventory.product.manage" if self.request.method == "POST" else "inventory.view")

    def get(self, request):
        return paginate(request, m.Warehouse.objects.all(), lambda w: {"id": str(w.id), "code": w.code, "name": w.name, "is_active": w.is_active, "warehouse_type": w.warehouse_type, "branch_id": _s(w.branch_id), "manager_id": _s(w.manager_id), "address": w.address, "policies": w.policies, "locations": [{"id": str(l.id), "code": l.code, "kind": l.kind, "zone": l.zone, "aisle": l.aisle, "rack": l.rack, "shelf": l.shelf, "bin": l.bin, "capacity": _s(l.capacity), "is_blocked": l.is_blocked} for l in w.locations.all()]}, ordering="code")

    def post(self, request):
        b = request.data
        w = services.create_warehouse(request.user.id, code=b.get("code", ""), name=b.get("name", ""), **{k: b[k] for k in ("warehouse_type", "branch_id", "manager_id", "address", "policies") if k in b})
        return Response({"id": str(w.id), "code": w.code}, status=201)


class WarehouseDetail(APIView):
    def get_permissions(self):
        return perm("inventory.product.manage")

    def patch(self, request, pk):
        from modules.inventory import structure
        b = request.data
        w = structure.update_warehouse(request.user.id, pk, **{k: b[k] for k in ("name", "warehouse_type", "branch_id", "manager_id", "address", "policies") if k in b})
        return Response({"id": str(w.id), "code": w.code, "warehouse_type": w.warehouse_type, "policies": w.policies})


class Locations(APIView):
    def get_permissions(self):
        return perm("inventory.product.manage")

    def post(self, request):
        b = request.data
        l = services.create_location(request.user.id, warehouse_id=b.get("warehouse"), code=b.get("code", ""), name=b.get("name", ""), **{k: b[k] for k in LOC_FIELDS if k in b})
        return Response({"id": str(l.id), "code": l.code, "kind": l.kind}, status=201)


class LocationDetail(APIView):
    def get_permissions(self):
        return perm("inventory.product.manage")

    def patch(self, request, pk):
        from modules.inventory import structure
        b = request.data
        l = structure.update_location(request.user.id, pk, **{k: b[k] for k in LOC_FIELDS + ("is_active",) if k in b})
        return Response({"id": str(l.id), "code": l.code, "kind": l.kind, "is_blocked": l.is_blocked, "capacity": _s(l.capacity)})


class LocationUtilisation(APIView):
    def get_permissions(self):
        return perm("inventory.view")

    def get(self, request):
        from modules.inventory import structure
        return Response({"results": structure.utilisation(request.query_params.get("warehouse"))})


class StockLevels(APIView):
    def get_permissions(self):
        return perm("inventory.view")

    def get(self, request):
        qs = m.StockLevel.objects.select_related("product", "location__warehouse", "lot").filter(quantity__gt=0)
        for f, lookup in (("product", "product_id"), ("location", "location_id"), ("warehouse", "location__warehouse_id")):
            if request.query_params.get(f):
                qs = qs.filter(**{lookup: request.query_params[f]})
        return paginate(request, qs, lambda l: {"product": l.product.sku, "warehouse": l.location.warehouse.code, "location": l.location.code, "lot": l.lot.code if l.lot else None, "quantity": str(l.quantity)}, ordering="-updated_at")


class Movements(APIView):
    def get_permissions(self):
        return perm("inventory.view")

    def get(self, request):
        qs = m.StockMovement.objects.select_related("product", "location", "lot")
        if request.query_params.get("product"):
            qs = qs.filter(product_id=request.query_params["product"])
        return paginate(request, qs, _movement)


class MoveIn(serializers.Serializer):
    product = serializers.UUIDField()
    location = serializers.UUIDField(required=False)
    to_location = serializers.UUIDField(required=False)
    quantity = serializers.DecimalField(max_digits=18, decimal_places=4, required=False)
    unit_cost = serializers.DecimalField(max_digits=20, decimal_places=4, required=False)
    delta = serializers.DecimalField(max_digits=18, decimal_places=4, required=False)
    counted_quantity = serializers.DecimalField(max_digits=18, decimal_places=4, required=False)
    lot_code = serializers.CharField(required=False, allow_blank=True, allow_null=True, max_length=60)
    reason = serializers.CharField(required=False, allow_blank=True, default="", max_length=300)


def _in(request):
    v = MoveIn(data=request.data)
    v.is_valid(raise_exception=True)
    return v.validated_data


class Receipts(APIView):
    def get_permissions(self):
        return perm("inventory.goods.receive")

    def post(self, request):
        d = _in(request)
        mv = services.receive_stock(request.user.id, product_id=d["product"], location_id=d.get("location"), quantity=d.get("quantity", 0), unit_cost=d.get("unit_cost", 0), lot_code=d.get("lot_code") or None, ref_type="manual", ref_id="receipt", reason=d["reason"])
        return Response(_movement(m.StockMovement.objects.select_related("product", "location", "lot").get(pk=mv.pk)), status=201)


class Issues(APIView):
    def get_permissions(self):
        return perm("inventory.stock.issue")

    def post(self, request):
        d = _in(request)
        mv = services.issue_stock(request.user.id, product_id=d["product"], location_id=d.get("location"), quantity=d.get("quantity", 0), lot_code=d.get("lot_code") or None, reason=d["reason"], ref_type="manual", ref_id="issue")
        return Response(_movement(m.StockMovement.objects.select_related("product", "location", "lot").get(pk=mv.pk)), status=201)


class Transfers(APIView):
    def get_permissions(self):
        return perm("inventory.stock.issue")

    def post(self, request):
        d = _in(request)
        mv = services.transfer_stock(request.user.id, product_id=d["product"], from_location_id=d.get("location"), to_location_id=d.get("to_location"), quantity=d.get("quantity", 0), lot_code=d.get("lot_code") or None, reason=d["reason"])
        return Response(_movement(m.StockMovement.objects.select_related("product", "location", "lot").get(pk=mv.pk)), status=201)


class Adjustments(APIView):
    def get_permissions(self):
        return perm("inventory.stock.adjust")

    def post(self, request):
        d = _in(request)
        mv = services.adjust_stock(request.user.id, product_id=d["product"], location_id=d.get("location"), delta=d.get("delta"), counted_quantity=d.get("counted_quantity"), lot_code=d.get("lot_code") or None, unit_cost=d.get("unit_cost"), reason=d["reason"])
        return Response(_movement(m.StockMovement.objects.select_related("product", "location", "lot").get(pk=mv.pk)), status=201)


class Valuation(APIView):
    def get_permissions(self):
        return perm("inventory.view")

    def get(self, request):
        from modules.inventory import valuation
        q = request.query_params
        return Response(valuation.valuation_report(as_of=date.fromisoformat(q["as_of"]) if q.get("as_of") else None, warehouse_id=q.get("warehouse")))


class ReorderRules(APIView):
    def get_permissions(self):
        return perm("inventory.product.manage" if self.request.method == "POST" else "inventory.view")

    def get(self, request):
        return Response({"below_minimum": services.reorder_report()})

    def post(self, request):
        b = request.data
        r = services.set_reorder_rule(request.user.id, product_id=b.get("product"), warehouse_id=b.get("warehouse"), min_quantity=b.get("min_quantity"), reorder_quantity=b.get("reorder_quantity"))
        return Response({"id": str(r.id)}, status=201)


class Uoms(APIView):
    def get_permissions(self):
        return perm("inventory.product.manage" if self.request.method == "POST" else "inventory.view")

    def get(self, request):
        return Response({"units": [{"code": u.code, "name": u.name} for u in m.UnitOfMeasure.objects.filter(is_active=True).order_by("code")], "conversions": [{"product": _s(c.product_id), "from": c.from_uom, "to": c.to_uom, "factor": str(c.factor)} for c in m.UomConversion.objects.all().order_by("from_uom", "to_uom")]})

    def post(self, request):
        from modules.inventory import items
        b = request.data
        if b.get("factor") is not None:
            c = items.set_conversion(request.user.id, from_uom=b.get("from"), to_uom=b.get("to"), factor=b["factor"], product_id=b.get("product"))
            return Response({"from": c.from_uom, "to": c.to_uom, "factor": str(c.factor)}, status=201)
        u = items.define_uom(request.user.id, code=b.get("code"), name=b.get("name"))
        return Response({"code": u.code, "name": u.name}, status=201)


class UomConvert(APIView):
    def get_permissions(self):
        return perm("inventory.view")

    def get(self, request):
        from modules.inventory import items
        q = request.query_params
        return Response({"quantity": str(items.convert(q.get("quantity", "1"), q.get("from"), q.get("to"), product_id=q.get("product")))})


class ItemCategories(APIView):
    def get_permissions(self):
        return perm("inventory.product.manage" if self.request.method == "POST" else "inventory.view")

    def get(self, request):
        return Response({"results": [{"id": str(c.id), "code": c.code, "name": c.name, "parent": _s(c.parent_id)} for c in m.ItemCategory.objects.filter(is_active=True).order_by("code")]})

    def post(self, request):
        from modules.inventory import items
        b = request.data
        c = items.save_category(request.user.id, code=b.get("code", ""), name=b.get("name", ""), parent_id=b.get("parent"))
        return Response({"id": str(c.id), "code": c.code, "name": c.name, "parent": _s(c.parent_id)}, status=201)


class Availability(APIView):
    def get_permissions(self):
        return perm("inventory.view")

    def get(self, request):
        from modules.inventory import availability
        q = request.query_params
        if not q.get("product"):
            raise services.ValidationFailed("product is required.", code="product_required")
        return Response(availability.availability(q["product"], q.get("warehouse")))


class Reservations(APIView):
    def get_permissions(self):
        return perm("inventory.stock.issue" if self.request.method == "POST" else "inventory.view")

    def get(self, request):
        qs = m.StockReservation.objects.select_related("product").filter(status=request.query_params.get("status", "ACTIVE"))
        return paginate(request, qs, lambda r: {"id": str(r.id), "sku": r.product.sku, "quantity": str(r.quantity), "status": r.status, "ref_type": r.ref_type, "ref_id": r.ref_id, "expires_on": _s(r.expires_on), "warehouse": _s(r.warehouse_id)}, ordering="-created_at")

    def post(self, request):
        from modules.inventory import availability
        b = request.data
        r = availability.reserve(request.user.id, product_id=b.get("product"), quantity=b.get("quantity"), warehouse_id=b.get("warehouse"), ref_type=b.get("ref_type", ""), ref_id=b.get("ref_id", ""), note=b.get("note", ""), expires_on=b.get("expires_on"))
        return Response({"id": str(r.id), "status": r.status, "quantity": str(r.quantity)}, status=201)


class ReservationRelease(APIView):
    def get_permissions(self):
        return perm("inventory.stock.issue")

    def post(self, request, pk):
        from modules.inventory import availability
        return Response({"status": availability.release(request.user.id, pk).status})


class StockAlerts(APIView):
    def get_permissions(self):
        return perm("inventory.view")

    def get(self, request):
        from modules.inventory import availability
        return Response({"results": availability.alerts()})


class StockAgeing(APIView):
    def get_permissions(self):
        return perm("inventory.view")

    def get(self, request):
        from modules.inventory import availability
        return Response({"results": availability.ageing()})


class SlowMoving(APIView):
    def get_permissions(self):
        return perm("inventory.view")

    def get(self, request):
        from modules.inventory import availability
        return Response({"slow_moving": availability.slow_moving(int(request.query_params.get("days", 90))), "excess": availability.excess()})


def _transfer(o):
    from modules.inventory import transfers
    return transfers.note(o.id)


class TransferOrders(APIView):
    def get_permissions(self):
        return perm("inventory.stock.issue" if self.request.method == "POST" else "inventory.view")

    def get(self, request):
        qs = m.TransferOrder.objects.select_related("from_warehouse", "to_warehouse")
        if request.query_params.get("status"):
            qs = qs.filter(status=request.query_params["status"])
        return paginate(request, qs, lambda o: {"id": str(o.id), "number": o.number, "status": o.status, "from": o.from_warehouse.code, "to": o.to_warehouse.code}, ordering="-created_at")

    def post(self, request):
        from modules.inventory import transfers
        b = request.data
        o = transfers.create(request.user.id, from_warehouse_id=b.get("from_warehouse"), to_warehouse_id=b.get("to_warehouse"), lines=b.get("lines") or [], reason=b.get("reason", ""), expected_date=b.get("expected_date"))
        return Response(_transfer(o), status=201)


class TransferDetail(APIView):
    def get_permissions(self):
        return perm("inventory.view")

    def get(self, request, pk):
        from modules.inventory import transfers
        return Response(transfers.note(pk))


class TransferAction(APIView):
    """POST /transfers/<id>/<action>: submit, cancel, dispatch (stock.issue) | approve, reject (transfer.approve) | receive (goods.receive)."""
    PERMS = {"submit": "inventory.stock.issue", "cancel": "inventory.stock.issue", "dispatch": "inventory.stock.issue", "approve": "inventory.transfer.approve", "reject": "inventory.transfer.approve", "receive": "inventory.goods.receive"}

    def get_permissions(self):
        return perm(self.PERMS.get(self.kwargs.get("action"), "inventory.transfer.approve"))

    def post(self, request, pk, action):
        from modules.inventory import transfers
        if action not in self.PERMS:
            raise services.DomainError("Unknown action.", code="not_found", status_code=404)
        b, u = request.data, request.user.id
        if action == "approve":
            transfers.approve(u, pk, note=b.get("note", ""))
        elif action == "reject":
            transfers.reject(u, pk, note=b.get("note", ""))
        elif action == "dispatch":
            transfers.dispatch(u, pk, carrier=b.get("carrier", ""))
        elif action == "receive":
            transfers.receive(u, pk, b.get("lines") or [])
        else:
            getattr(transfers, action)(u, pk)
        return Response(transfers.note(pk))


def _can_see_requisition(user_id, req):
    from platform_core.authorization import services as authz
    return req.requester_id == user_id or authz.has_permission(user_id, "inventory.view") or authz.has_permission(user_id, "inventory.requisition.approve")


class MaterialRequisitions(APIView):
    def get_permissions(self):
        return perm("inventory.requisition.create")

    def get(self, request):
        from platform_core.authorization import services as authz
        qs = m.MaterialRequisition.objects.select_related("warehouse")
        if not (authz.has_permission(request.user.id, "inventory.view") or authz.has_permission(request.user.id, "inventory.requisition.approve")):
            qs = qs.filter(requester_id=request.user.id)
        if request.query_params.get("status"):
            qs = qs.filter(status=request.query_params["status"])
        return paginate(request, qs, lambda r: {"id": str(r.id), "number": r.number, "status": r.status, "warehouse": r.warehouse.code, "destination_type": r.destination_type}, ordering="-created_at")

    def post(self, request):
        from modules.inventory import requisitions
        b = request.data
        r = requisitions.create(request.user.id, warehouse_id=b.get("warehouse"), lines=b.get("lines") or [], destination_type=b.get("destination_type", "DEPARTMENT"), destination_ref=b.get("destination_ref", ""), department_id=b.get("department"), purpose=b.get("purpose", ""), needed_by=b.get("needed_by"))
        return Response(requisitions.detail(r.id), status=201)


class MaterialRequisitionDetail(APIView):
    def get_permissions(self):
        return perm("inventory.requisition.create")

    def get(self, request, pk):
        from modules.inventory import requisitions
        r = get_object_or_404(m.MaterialRequisition, pk=pk)
        if not _can_see_requisition(request.user.id, r):
            raise services.DomainError("Requisition not found.", code="not_found", status_code=404)
        return Response({**requisitions.detail(pk), "availability": requisitions.line_availability(pk)})


class MaterialRequisitionAction(APIView):
    PERMS = {"submit": "inventory.requisition.create", "cancel": "inventory.requisition.create", "approve": "inventory.requisition.approve", "reject": "inventory.requisition.approve", "issue": "inventory.stock.issue", "close": "inventory.stock.issue", "return": "inventory.stock.issue"}

    def get_permissions(self):
        return perm(self.PERMS.get(self.kwargs.get("action"), "inventory.stock.issue"))

    def post(self, request, pk, action):
        from modules.inventory import requisitions as rq
        if action not in self.PERMS:
            raise services.DomainError("Unknown action.", code="not_found", status_code=404)
        b, u = request.data, request.user.id
        if action in ("approve", "reject", "issue", "close"):
            r = get_object_or_404(m.MaterialRequisition, pk=pk)
        if action == "submit":
            rq.submit(u, pk)
        elif action == "cancel":
            rq.cancel(u, pk)
        elif action == "approve":
            rq.approve(u, pk, note=b.get("note", ""))
        elif action == "reject":
            rq.reject(u, pk, note=b.get("note", ""))
        elif action == "issue":
            rq.issue(u, pk, location_id=b.get("location"), lines=b.get("lines"), received_by=b.get("received_by", ""), notes=b.get("notes", ""))
        elif action == "close":
            rq.close(u, pk)
        elif action == "return":
            rq.return_issued(u, b.get("voucher_line"), quantity=b.get("quantity"), location_id=b.get("location"), reason=b.get("reason", ""))
        return Response(rq.detail(pk))


def _adj(r):
    from modules.inventory import adjustments
    return adjustments.serialize(r)


class AdjustmentRequests(APIView):
    def get_permissions(self):
        return perm("inventory.stock.adjust")

    def get(self, request):
        qs = m.AdjustmentRequest.objects.select_related("product", "location")
        if request.query_params.get("status"):
            qs = qs.filter(status=request.query_params["status"])
        return paginate(request, qs, _adj, ordering="-created_at")

    def post(self, request):
        from modules.inventory import adjustments
        d = request.data
        r = adjustments.request(request.user.id, product_id=d.get("product"), location_id=d.get("location"), delta=d.get("delta"), counted_quantity=d.get("counted_quantity"), lot_code=d.get("lot_code") or None, unit_cost=d.get("unit_cost"), reason_code=d.get("reason_code", "OTHER"), reason=d.get("reason", ""))
        return Response(_adj(r), status=201)


class AdjustmentAction(APIView):
    PERMS = {"approve": "inventory.adjustment.approve", "reject": "inventory.adjustment.approve", "evidence": "inventory.stock.adjust"}

    def get_permissions(self):
        return perm(self.PERMS.get(self.kwargs.get("action"), "inventory.adjustment.approve"))

    def post(self, request, pk, action):
        from modules.inventory import adjustments
        if action not in self.PERMS:
            raise services.DomainError("Unknown action.", code="not_found", status_code=404)
        if action == "evidence":
            up = request.FILES.get("file")
            if up is None:
                raise services.ValidationFailed("A file is required.", code="file_required")
            f = adjustments.attach_evidence(request.user.id, pk, up.name, up.read())
            return Response({"file_id": str(f.id), "name": f.original_name}, status=201)
        r = adjustments.approve(request.user.id, pk, note=request.data.get("note", "")) if action == "approve" else adjustments.reject(request.user.id, pk, note=request.data.get("note", ""))
        return Response(_adj(r))


class AdjustmentPolicy(APIView):
    def get_permissions(self):
        return perm("inventory.adjustment.approve" if self.request.method == "PUT" else "inventory.view")

    def get(self, request):
        from modules.inventory import adjustments
        t = adjustments.get_threshold()
        return Response({"threshold": None if t is None else str(t)})

    def put(self, request):
        from modules.inventory import adjustments
        t = adjustments.set_threshold(request.user.id, request.data.get("threshold"))
        return Response({"threshold": None if t is None else str(t)})


class StockCounts(APIView):
    def get_permissions(self):
        return perm("inventory.stock.adjust" if self.request.method == "POST" else "inventory.view")

    def get(self, request):
        from modules.inventory import stocktake
        return Response({"results": stocktake.history(request.query_params.get("product"))})

    def post(self, request):
        from modules.inventory import stocktake
        b = request.data
        c = stocktake.create(request.user.id, warehouse_id=b.get("warehouse"), kind=b.get("kind", "CYCLE"), freeze=b.get("freeze", False), planned_date=b.get("planned_date"), location_ids=b.get("locations"), product_ids=b.get("products"), note=b.get("note", ""))
        return Response({"id": str(c.id), "number": c.number, "status": c.status}, status=201)


class StockCountDetail(APIView):
    def get_permissions(self):
        return perm("inventory.stock.adjust")

    def get(self, request, pk):
        from modules.inventory import stocktake
        return Response({"worksheet": stocktake.worksheet(pk)})


class StockCountAction(APIView):
    PERMS = {"start": "inventory.stock.adjust", "assign": "inventory.stock.adjust", "record": "inventory.stock.adjust", "submit": "inventory.stock.adjust", "recount": "inventory.adjustment.approve", "approve": "inventory.adjustment.approve", "cancel": "inventory.stock.adjust", "variances": "inventory.stock.adjust"}

    def get_permissions(self):
        return perm(self.PERMS.get(self.kwargs.get("action"), "inventory.adjustment.approve"))

    def post(self, request, pk, action):
        from modules.inventory import stocktake as st
        if action not in self.PERMS:
            raise services.DomainError("Unknown action.", code="not_found", status_code=404)
        b, u = request.data, request.user.id
        if action == "assign":
            return Response({"assigned": st.assign(u, pk, user_id=b.get("user"), line_ids=b.get("lines"), location_id=b.get("location"))})
        if action == "record":
            l = st.record(u, b.get("line"), counted_quantity=b.get("counted_quantity"), note=b.get("note", ""))
            return Response({"line": str(l.id), "counted": str(l.counted_quantity)})
        if action == "recount":
            st.request_recount(u, pk, b.get("lines") or [])
        elif action == "variances":
            return Response({"results": st.variances(pk)})
        else:
            getattr(st, action)(u, pk)
        return Response({"status": m.StockCount.objects.get(pk=pk).status})


class LandedCosts(APIView):
    def get_permissions(self):
        return perm("inventory.landed_cost.manage" if self.request.method == "POST" else "inventory.view")

    def get(self, request):
        return paginate(request, m.LandedCost.objects.all(), lambda c: {"id": str(c.id), "number": c.number, "ref_type": c.ref_type, "ref_id": c.ref_id, "description": c.description, "amount": str(c.amount), "basis": c.basis, "allocations": [{"sku": a.product.sku, "share": str(a.share), "to_inventory": str(a.to_inventory), "to_cogs": str(a.to_cogs)} for a in c.allocations.select_related("product")]}, ordering="-created_at")

    def post(self, request):
        from modules.inventory import valuation
        b = request.data
        c = valuation.post_landed_cost(request.user.id, ref_type=b.get("ref_type", ""), ref_id=b.get("ref_id", ""), amount=b.get("amount"), description=b.get("description", ""), basis=b.get("basis", "VALUE"), on_date=date.fromisoformat(b["date"]) if b.get("date") else None)
        return Response({"id": str(c.id), "number": c.number}, status=201)


class LotStatus(APIView):
    def get_permissions(self):
        return perm("inventory.stock.adjust")

    def post(self, request, product_id, lot_code):
        from modules.inventory import tracking
        lot = tracking.set_lot_status(request.user.id, product_id, lot_code, request.data.get("status", ""), request.data.get("note", ""))
        return Response({"lot": lot.code, "status": lot.status})


class LotTrace(APIView):
    def get_permissions(self):
        return perm("inventory.view")

    def get(self, request, product_id, lot_code):
        from modules.inventory import tracking
        return Response(tracking.trace_lot(product_id, lot_code))


class PickSuggestion(APIView):
    def get_permissions(self):
        return perm("inventory.view")

    def get(self, request):
        from modules.inventory import tracking
        q = request.query_params
        return Response({"picks": tracking.pick(q.get("product"), q.get("warehouse"), q.get("quantity"), q.get("policy", "FEFO"))})


class ExpiredStock(APIView):
    def get_permissions(self):
        return perm("inventory.view")

    def get(self, request):
        from modules.inventory import tracking
        return Response({"results": tracking.expired_stock()})


class SerialInfo(APIView):
    def get_permissions(self):
        return perm("inventory.view")

    def get(self, request, product_id, serial):
        from modules.inventory import tracking
        return Response(tracking.serial_history(product_id, serial))


class InventoryReport(APIView):
    """GET /reports/<name>[?export=csv]: stock-card, summary, movements, abc, turnover, adjustments, transfers, valuation-by-warehouse."""

    def get_permissions(self):
        return perm("inventory.view")

    def get(self, request, name):
        from django.http import HttpResponse

        from modules.inventory import reports
        q = request.query_params
        d = lambda k: date.fromisoformat(q[k]) if q.get(k) else None  # noqa: E731
        if name == "stock-card":
            data = reports.stock_card(q.get("product"), date_from=d("from"), date_to=d("to"), warehouse_id=q.get("warehouse"))
            rows = data["rows"]
        elif name == "summary":
            rows = reports.stock_summary(q.get("group_by", "warehouse"))
            data = {"results": rows}
        elif name == "movements":
            rows = reports.movements(product_id=q.get("product"), warehouse_id=q.get("warehouse"), movement_type=q.get("type"), date_from=d("from"), date_to=d("to"))
            data = {"results": rows}
        elif name == "abc":
            rows = reports.abc_analysis(int(q.get("days", 365)))
            data = {"results": rows}
        elif name == "turnover":
            data = reports.turnover(int(q.get("days", 365)))
            rows = [data]
        elif name == "adjustments":
            data = reports.adjustments_report(d("from"), d("to"))
            rows = data["rows"]
        elif name == "transfers":
            rows = reports.transfers_report(q.get("status"))
            data = {"results": rows}
        else:
            raise services.DomainError("Unknown report.", code="not_found", status_code=404)
        if q.get("export") == "csv":
            resp = HttpResponse(reports.to_csv(rows), content_type="text/csv")
            resp["Content-Disposition"] = f'attachment; filename="{name}.csv"'
            return resp
        return Response(data)
