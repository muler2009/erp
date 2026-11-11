from decimal import Decimal as D

import pytest

from modules.inventory import items
from modules.inventory import models as im
from modules.inventory import services as inv
from shared.api.errors import DomainError, ValidationFailed
from tests.test_inventory import D0, api_env, f, recv  # noqa: F401
from tests.test_finance import user
from platform_core.users.models import ExternalIdentity
from tests.conftest import ACME_HOST, Api


@pytest.mark.django_db
def test_item_master_attributes_and_validation(f):
    p = inv.create_product(None, sku="IM-1", name="Bolt", item_type="SPARE_PART", min_stock="10", max_stock="100", reorder_level="20", safety_stock="5", qr_code="QR-1", tracks_expiry=True, costing_method="FIFO", purchase_price="1.25", purchase_lead_days=7, subcategory="Fasteners", description="M8", specifications="steel")
    assert (p.item_type, p.min_stock, p.costing_method, p.status, p.is_active) == ("SPARE_PART", D("10"), "FIFO", "ACTIVE", True)
    for bad in ({"qr_code": "QR-1"}, {"min_stock": "5", "max_stock": "1"}, {"item_type": "WIDGET"}, {"min_stock": "-1"}, {"bogus": 1}):
        with pytest.raises((DomainError, ValidationFailed)):
            inv.create_product(None, sku=f"BAD-{len(str(bad))}{next(iter(bad))}", name="x", **bad)
    ns = inv.create_product(None, sku="NS-1", name="Licence", stock_control="NON_STOCK")
    assert ns.is_stocked is False


@pytest.mark.django_db
def test_status_lifecycle_and_locks(f):
    recv(f, "5", "2")
    with pytest.raises(DomainError):
        inv.update_product(None, f["widget"].id, status="INACTIVE")  # stock on hand
    with pytest.raises(DomainError):
        inv.update_product(None, f["widget"].id, costing_method="FIFO")  # costing locked while stock exists
    d = inv.update_product(None, f["widget"].id, status="DISCONTINUED")
    assert d.status == "DISCONTINUED" and d.is_active is True  # may still be sold down
    p = inv.create_product(None, sku="IM-2", name="Old")
    p = inv.update_product(None, p.id, is_active=False)
    assert (p.status, p.is_active) == ("INACTIVE", False)
    assert inv.update_product(None, p.id, is_active=True).status == "ACTIVE"


@pytest.mark.django_db
def test_uom_conversions_and_categories(f):
    for c, n in (("kg", "Kilogram"), ("g", "Gram"), ("box", "Box"), ("unit", "Unit")):
        items.define_uom(None, code=c, name=n)
    items.set_conversion(None, from_uom="kg", to_uom="g", factor="1000")
    items.set_conversion(None, from_uom="box", to_uom="unit", factor="10")
    items.set_conversion(None, from_uom="box", to_uom="unit", factor="12", product_id=f["widget"].id)
    assert items.convert("2", "kg", "g") == D("2000")
    assert items.convert("500", "g", "kg") == D("0.5")
    assert items.convert("2", "box", "unit") == D("20")
    assert items.convert("2", "box", "unit", product_id=f["widget"].id) == D("24")  # product-specific override
    with pytest.raises(DomainError):
        items.convert("1", "kg", "box")
    with pytest.raises(ValidationFailed):
        items.set_conversion(None, from_uom="kg", to_uom="kg", factor="1")
    with pytest.raises(ValidationFailed):
        items.set_conversion(None, from_uom="kg", to_uom="g", factor="0")
    a = items.save_category(None, code="RAW", name="Raw")
    b = items.save_category(None, code="STEEL", name="Steel", parent_id=a.id)
    with pytest.raises(ValidationFailed):
        items.save_category(None, code="RAW", name="Raw", parent_id=b.id, category_id=a.id)  # cycle
    with pytest.raises(DomainError):
        items.save_category(None, code="RAW", name="dup")


@pytest.mark.django_db
def test_item_master_api(api_env, idp, acme):
    env, api = api_env
    from django_tenants.utils import schema_context
    from platform_core.tenants.models import Tenant
    with schema_context(acme["schema"]):
        im_user = user(Tenant.objects.get(pk=acme["id"]), "invmgr@acme.test", "inventory_manager")
    ExternalIdentity.objects.create(user=im_user, issuer="https://kc.test/realms/erp", subject="invmgr-sub")
    api["mgr"] = Api(ACME_HOST)
    assert api["mgr"].login(idp, "invmgr-sub").status_code == 302
    body = {"sku": "API-1", "name": "Pipe", "item_type": "RAW_MATERIAL", "min_stock": "3", "costing_method": "FIFO"}
    assert api["po"].post("/api/v1/inventory/products", body).status_code == 403
    r = api["mgr"].post("/api/v1/inventory/products", body)
    assert r.status_code == 201 and r.json()["item_type"] == "RAW_MATERIAL" and r.json()["min_stock"] == "3"
    assert api["mgr"].patch(f"/api/v1/inventory/products/{r.json()['id']}", {"status": "DISCONTINUED"}).json()["status"] == "DISCONTINUED"
    assert api["mgr"].post("/api/v1/inventory/products", {**body, "sku": "API-2", "item_type": "NOPE"}).status_code == 400
    assert api["emp"].get("/api/v1/inventory/uoms").status_code == 403
    assert api["po"].post("/api/v1/inventory/uoms", {"code": "kg", "name": "Kg"}).status_code == 403
    assert api["mgr"].post("/api/v1/inventory/uoms", {"code": "kg", "name": "Kg"}).status_code == 201
    assert api["mgr"].post("/api/v1/inventory/uoms", {"code": "g", "name": "g"}).status_code == 201
    assert api["mgr"].post("/api/v1/inventory/uoms", {"from": "kg", "to": "g", "factor": "1000"}).status_code == 201
    assert api["wh"].get("/api/v1/inventory/uoms/convert?quantity=2&from=kg&to=g").json()["quantity"].startswith("2000")
    assert api["mgr"].post("/api/v1/inventory/categories", {"code": "C1", "name": "Cat"}).status_code == 201
    assert api["wh"].get("/api/v1/inventory/categories").json()["results"][0]["code"] == "C1"
