from datetime import date
from decimal import Decimal as D

import pytest

from modules.assets import acquisition as acq
from modules.assets import models as am
from modules.assets import services as svc
from modules.finance import models as fm
from modules.finance import services as fin
from modules.procurement import services as proc
from shared.api.errors import DomainError, ValidationFailed
from tests.test_assets import D0, activate, api_env, f, laptop  # noqa: F401


def gl(code):
    return fin.account_balance(fm.Account.objects.get(code=code))


def seed(f):
    fin.seed_defaults() if hasattr(fin, "seed_defaults") else None


@pytest.mark.django_db
def test_capitalization_flow_posts_to_finance_and_activates(f):
    u, u2 = f["people"]["am_"].id, f["people"]["am2"].id
    a = laptop(f)
    with pytest.raises(DomainError) as e:
        acq.accept_delivery(u, a.id, delivered_on=D0)
    assert e.value.get_codes() == "acquisition_required"
    with pytest.raises(ValidationFailed) as e:
        acq.record_acquisition(u, a.id, source="PURCHASE", cost="1200")
    assert e.value.get_codes() == "documentation_required"
    with pytest.raises(ValidationFailed):
        acq.record_acquisition(u, a.id, source="PURCHASE", cost="1200", po_id="00000000-0000-0000-0000-000000000001")
    acq.record_acquisition(u, a.id, source="OPENING", cost="1200", reference_note="Migrated from legacy register")
    with pytest.raises(DomainError):
        acq.record_acquisition(u, a.id, source="OPENING", cost="1", reference_note="again")
    acq.add_cost(u, a.id, kind="FREIGHT", description="Shipping", amount="50")
    acq.add_cost(u, a.id, kind="INSTALLATION", description="Setup", amount="50")
    with pytest.raises(DomainError):
        acq.request_capitalization(u, a.id, capitalization_date=D0)  # not received
    acq.accept_delivery(u, a.id, delivered_on=D0)
    with pytest.raises(DomainError) as e:
        acq.request_capitalization(u, a.id, capitalization_date=D0)
    assert e.value.get_codes() == "commissioning_required"
    with pytest.raises(ValidationFailed):
        acq.commission(u, a.id, passed=False, on_date=D0)
    acq.commission(u, a.id, passed=True, on_date=D0, notes="Powers on, imaged")
    req = acq.request_capitalization(u, a.id, capitalization_date=D0)
    assert req.capitalize and req.total_cost == D("1300")
    with pytest.raises(DomainError):
        acq.add_cost(u, a.id, kind="OTHER", description="late", amount="1")
    with pytest.raises(DomainError) as e:
        acq.approve_capitalization(u, req.id)
    assert e.value.get_codes() == "separation_of_duties"
    assert gl("1500") == 0
    acq.approve_capitalization(u2, req.id)
    a.refresh_from_db()
    assert a.status == "AVAILABLE" and a.is_capitalized and a.capitalized_cost == D("1300")
    assert gl("1500") == D("1300") and abs(gl("1510")) == D("1300")
    assert acq.acquisition_view(a.id)["total_cost"] == "1300.0000"
    assert [r["asset"] for r in acq.acquisition_report(D0, D0)] == [a.number]


@pytest.mark.django_db
def test_below_threshold_is_registered_but_not_capitalized(f):
    a = laptop(f, serial_number="CHEAP", purchase_cost="100")
    activate(f, a, cost="100")
    assert a.status == "AVAILABLE" and not a.is_capitalized and a.capitalized_cost == 0
    assert gl("1500") == 0


@pytest.mark.django_db
def test_donation_credits_income_and_rejection_blocks_activation(f):
    u, u2 = f["people"]["am_"].id, f["people"]["am2"].id
    a = laptop(f, serial_number="GIFT")
    acq.record_acquisition(u, a.id, source="DONATION", cost="900", reference_note="Donated by NGO, valued by committee")
    acq.accept_delivery(u, a.id, delivered_on=D0)
    acq.commission(u, a.id, passed=True, on_date=D0)
    req = acq.request_capitalization(u, a.id, capitalization_date=D0)
    with pytest.raises(ValidationFailed):
        acq.reject_capitalization(u2, req.id, note="")
    acq.reject_capitalization(u2, req.id, note="Valuation unsupported")
    with pytest.raises(DomainError) as e:
        svc.set_status(u, a.id, "AVAILABLE", manual=True)
    assert e.value.get_codes() == "capitalization_required"
    again = acq.request_capitalization(u, a.id, capitalization_date=D0)
    acq.approve_capitalization(u2, again.id)
    assert gl("1500") == D("900") and abs(gl("4300")) == D("900")


@pytest.mark.django_db
def test_purchase_links_to_procurement_documents(f):
    from tests.test_procurement import approved_po
    # a purchase order from the procurement suite's fixtures is not available here, so build the minimum
    from modules.procurement import models as pm
    u = f["people"]["am_"].id
    a = laptop(f, serial_number="BUY")
    sup = pm.Supplier.objects.create(name="Dell", tax_id="T-D", status="QUALIFIED")
    po = pm.PurchaseOrder.objects.create(number="PO-X", supplier=sup, currency="USD", order_date=D0, status="APPROVED", total=1200, created_by=u)
    draft = pm.PurchaseOrder.objects.create(number="PO-Y", supplier=sup, currency="USD", order_date=D0, status="DRAFT", total=1, created_by=u)
    with pytest.raises(ValidationFailed) as e:
        acq.record_acquisition(u, a.id, source="PURCHASE", cost="1200", po_id=draft.id)
    assert e.value.get_codes() == "invalid_po"
    acq.record_acquisition(u, a.id, source="PURCHASE", cost="1200", po_id=po.id)
    a.refresh_from_db()
    assert a.supplier_id == sup.id and acq.acquisition_view(a.id)["po_id"] == str(po.id)


@pytest.mark.django_db
def test_acquisition_over_http_permissions(api_env):
    env, api = api_env
    r = api["am"].post("/api/v1/assets/assets", {"category": str(env["cat"].id), "name": "Server", "serial_number": "S1"})
    aid = r.json()["id"]
    body = {"source": "OPENING", "cost": "2000", "reference_note": "Opening balances"}
    assert api["emp"].post(f"/api/v1/assets/assets/{aid}/acquisition", body).status_code == 403
    assert api["auditor"].post(f"/api/v1/assets/assets/{aid}/acquisition", body).status_code == 403
    assert api["am"].post(f"/api/v1/assets/assets/{aid}/acquisition", body).status_code == 201
    assert api["auditor"].get(f"/api/v1/assets/assets/{aid}/acquisition").status_code == 200
    assert api["am"].post(f"/api/v1/assets/assets/{aid}/acquisition/accept", {"delivered_on": "2026-03-15"}).status_code == 200
    assert api["am"].post(f"/api/v1/assets/assets/{aid}/acquisition/commission", {"passed": True}).status_code == 200
    cap = api["am"].post(f"/api/v1/assets/assets/{aid}/acquisition/capitalize", {"date": "2026-03-15"})
    assert cap.status_code == 201
    cid = cap.json()["id"]
    assert api["emp"].post(f"/api/v1/assets/capitalizations/{cid}/approve").status_code == 403
    assert api["auditor"].post(f"/api/v1/assets/capitalizations/{cid}/approve").status_code == 403
    assert api["am"].post(f"/api/v1/assets/capitalizations/{cid}/approve").status_code == 403  # own request
    assert api["auditor"].get("/api/v1/assets/capitalizations").status_code == 200
