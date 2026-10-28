from datetime import date

from django.shortcuts import get_object_or_404
from rest_framework import serializers
from rest_framework.response import Response
from rest_framework.views import APIView

from modules.inventory import models as m
from modules.inventory import services
from platform_core.authorization.permissions import require
from shared.api.pagination import paginate


def perm(code):
    return [require(code)()]


def _s(v):
    return None if v is None else str(v)


def _product(p):
    return {"id": str(p.id), "sku": p.sku, "name": p.name, "uom": p.uom, "barcode": p.barcode, "category": p.category, "tracking": p.tracking, "is_stocked": p.is_stocked, "variant_of": _s(p.variant_of_id), "attributes": p.attributes, "is_active": p.is_active, "on_hand": str(services.on_hand(p.id))}


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
        p = services.create_product(request.user.id, sku=b.get("sku", ""), name=b.get("name", ""), uom=b.get("uom", "unit"), barcode=b.get("barcode"), category=b.get("category", ""), tracking=b.get("tracking", "NONE"), is_stocked=bool(b.get("is_stocked", True)), variant_of_id=b.get("variant_of"), attributes=b.get("attributes"))
        return Response(_product(p), status=201)


class ProductDetail(APIView):
    def get_permissions(self):
        return perm("inventory.product.manage" if self.request.method == "PATCH" else "inventory.view")

    def get(self, request, pk):
        return Response(_product(get_object_or_404(m.Product, pk=pk)))

    def patch(self, request, pk):
        b = request.data
        return Response(_product(services.update_product(request.user.id, pk, name=b.get("name"), barcode=b.get("barcode"), category=b.get("category"), is_active=b.get("is_active"))))


class Warehouses(APIView):
    def get_permissions(self):
        return perm("inventory.product.manage" if self.request.method == "POST" else "inventory.view")

    def get(self, request):
        return paginate(request, m.Warehouse.objects.all(), lambda w: {"id": str(w.id), "code": w.code, "name": w.name, "is_active": w.is_active, "locations": [{"id": str(l.id), "code": l.code} for l in w.locations.all()]}, ordering="code")

    def post(self, request):
        w = services.create_warehouse(request.user.id, code=request.data.get("code", ""), name=request.data.get("name", ""))
        return Response({"id": str(w.id), "code": w.code}, status=201)


class Locations(APIView):
    def get_permissions(self):
        return perm("inventory.product.manage")

    def post(self, request):
        l = services.create_location(request.user.id, warehouse_id=request.data.get("warehouse"), code=request.data.get("code", ""), name=request.data.get("name", ""))
        return Response({"id": str(l.id), "code": l.code}, status=201)


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
        return Response(services.valuation())


class ReorderRules(APIView):
    def get_permissions(self):
        return perm("inventory.product.manage" if self.request.method == "POST" else "inventory.view")

    def get(self, request):
        return Response({"below_minimum": services.reorder_report()})

    def post(self, request):
        b = request.data
        r = services.set_reorder_rule(request.user.id, product_id=b.get("product"), warehouse_id=b.get("warehouse"), min_quantity=b.get("min_quantity"), reorder_quantity=b.get("reorder_quantity"))
        return Response({"id": str(r.id)}, status=201)
