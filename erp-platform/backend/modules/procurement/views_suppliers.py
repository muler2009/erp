from datetime import date

from django.shortcuts import get_object_or_404
from rest_framework.response import Response
from rest_framework.views import APIView

from modules.procurement import models as m
from modules.procurement import suppliers
from platform_core.authorization.permissions import require
from shared.api.errors import DomainError, ValidationFailed


def perm(code):
    return [require(code)()]


def _d(v):
    return date.fromisoformat(v) if v else None


class SupplierProfile(APIView):
    def get_permissions(self):
        return perm("procurement.view")

    def get(self, request, pk):
        return Response(suppliers.profile(get_object_or_404(m.Supplier, pk=pk)))


class SupplierContacts(APIView):
    def get_permissions(self):
        return perm("procurement.supplier.manage")

    def post(self, request, pk):
        b = request.data
        c = suppliers.add_contact(request.user.id, pk, name=b.get("name", ""), role=b.get("role", ""), email=b.get("email", ""), phone=b.get("phone", ""), is_primary=bool(b.get("is_primary")))
        return Response({"id": str(c.id), "primary": c.is_primary}, status=201)


class SupplierBanks(APIView):
    def get_permissions(self):
        return perm("procurement.supplier.bank")

    def get(self, request, pk):
        return Response({"results": [{"id": str(b.id), "bank_name": b.bank_name, "account_name": b.account_name, "account_number": suppliers.mask(b.account_number), "currency": b.currency, "default": b.is_default, "verified": b.verified_at is not None} for b in m.SupplierBank.objects.filter(supplier_id=pk)]})

    def post(self, request, pk):
        b = request.data
        a = suppliers.add_bank_account(request.user.id, pk, bank_name=b.get("bank_name", ""), account_name=b.get("account_name", ""), account_number=b.get("account_number", ""), currency=b.get("currency", ""), is_default=bool(b.get("is_default")))
        return Response({"id": str(a.id), "verified": False}, status=201)


class SupplierBankVerify(APIView):
    def get_permissions(self):
        return perm("procurement.supplier.bank")

    def post(self, request, pk):
        return Response({"verified": suppliers.verify_bank_account(request.user.id, pk).verified_at is not None})


class SupplierDocuments(APIView):
    def get_permissions(self):
        return perm("procurement.supplier.manage")

    def post(self, request, pk):
        b = request.data
        d = suppliers.add_document(request.user.id, pk, doc_type=b.get("doc_type", ""), reference=b.get("reference", ""), expiry_date=_d(b.get("expiry_date")), file_id=b.get("file_id"))
        return Response({"id": str(d.id)}, status=201)


class ExpiringDocuments(APIView):
    def get_permissions(self):
        return perm("procurement.view")

    def get(self, request):
        return Response({"results": suppliers.expiring_documents(int(request.query_params.get("days", 30)))})


class SupplierStanding(APIView):
    def get_permissions(self):
        return perm("procurement.supplier.manage")

    def post(self, request, pk):
        b = request.data
        s = suppliers.set_standing(request.user.id, pk, b.get("standing", ""), reason=b.get("reason", ""), until=_d(b.get("until")))
        return Response({"standing": s.standing})


class SupplierCatalogue(APIView):
    def get_permissions(self):
        return perm("procurement.supplier.manage" if self.request.method == "POST" else "procurement.view")

    def get(self, request, pk):
        return Response({"results": suppliers.price_history(request.query_params.get("product"), pk) if request.query_params.get("product") else [{"product": str(i.product_id), "unit_price": str(i.unit_price), "currency": i.currency, "valid_from": str(i.valid_from), "valid_to": None if not i.valid_to else str(i.valid_to)} for i in m.SupplierItem.objects.filter(supplier_id=pk, valid_to__isnull=True)]})

    def post(self, request, pk):
        b = request.data
        i = suppliers.set_catalogue_price(request.user.id, pk, b.get("product"), unit_price=b.get("unit_price"), currency=b.get("currency", ""), valid_from=_d(b.get("valid_from")), min_order_quantity=b.get("min_order_quantity", 1), lead_time_days=int(b.get("lead_time_days", 0)), supplier_sku=b.get("supplier_sku", ""), is_preferred=bool(b.get("is_preferred")))
        return Response({"id": str(i.id), "unit_price": str(i.unit_price)}, status=201)


class ProductSuppliers(APIView):
    def get_permissions(self):
        return perm("procurement.view")

    def get(self, request, product_id):
        return Response({"preferred": suppliers.preferred_suppliers(product_id), "history": suppliers.price_history(product_id)})


class SupplierRisk(APIView):
    def get_permissions(self):
        return perm("procurement.view")

    def get(self, request):
        return Response({"results": suppliers.risk_report()})
