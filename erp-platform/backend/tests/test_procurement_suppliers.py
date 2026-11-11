from datetime import date, timedelta
from decimal import Decimal as D

import pytest
from django.utils import timezone

from modules.procurement import models as pm
from modules.procurement import services as proc
from modules.procurement import suppliers as sup
from shared.api.errors import DomainError, ValidationFailed
from tests.test_procurement import D0, api_env, f, po_lines, qualified  # noqa: F401

T = timezone.now().date()


@pytest.mark.django_db
def test_profile_validation_and_duplicates(f):
    s = proc.create_supplier(None, name="Full Ltd", tax_id="TAX-1", category="Packaging", payment_terms_days=45, risk_level="MEDIUM", address={"city": "Addis"}, currency="USD")
    assert (s.category, s.payment_terms_days, s.risk_level, s.standing) == ("Packaging", 45, "MEDIUM", "GOOD")
    with pytest.raises(DomainError) as e:
        proc.create_supplier(None, name="Other", tax_id="TAX-1")
    assert e.value.get_codes() == "duplicate_supplier"
    for bad in ({"risk_level": "EXTREME"}, {"payment_terms_days": 999}, {"address": "x"}, {"bogus": 1}):
        with pytest.raises(ValidationFailed):
            sup.update_supplier(None, s.id, **bad)
    assert sup.update_supplier(None, s.id, phone="+251", is_preferred=True).is_preferred


@pytest.mark.django_db
def test_bank_details_need_second_person_and_are_masked(f):
    pm1, pm2 = f["people"]["pm"].id, f["people"]["pm2"].id
    s = f["supplier"]
    b = sup.add_bank_account(pm1, s.id, bank_name="CBE", account_name="Acme", account_number="1000 2345 6789", currency="USD", is_default=True)
    assert sup.payable_bank_account(s.id) is None  # unverified details are never payable
    with pytest.raises(DomainError) as e:
        sup.verify_bank_account(pm1, b.id)
    assert e.value.get_codes() == "separation_of_duties"
    sup.verify_bank_account(pm2, b.id)
    assert sup.payable_bank_account(s.id, "USD").id == b.id
    assert sup.mask(b.account_number) == "********6789"
    with pytest.raises(ValidationFailed):
        sup.add_bank_account(pm1, s.id, bank_name="", account_name="x", account_number="1")


@pytest.mark.django_db
def test_standing_blocks_orders_and_documents_expire(f):
    s, pm1 = f["supplier"], f["people"]["pm"].id
    sup.add_document(pm1, s.id, doc_type="tax_certificate", expiry_date=T - timedelta(days=1))
    sup.add_document(pm1, s.id, doc_type="insurance", expiry_date=T + timedelta(days=10))
    sup.add_document(pm1, s.id, doc_type="licence", expiry_date=T + timedelta(days=400))
    assert [(d["doc_type"], d["status"]) for d in sup.expiring_documents(30)] == [("TAX_CERTIFICATE", "EXPIRED"), ("INSURANCE", "EXPIRING")]
    with pytest.raises(ValidationFailed):
        sup.set_standing(pm1, s.id, "SUSPENDED", reason="")
    sup.set_standing(pm1, s.id, "SUSPENDED", reason="late deliveries", until=T + timedelta(days=5))
    with pytest.raises(DomainError) as e:
        proc.create_po(f["people"]["po"].id, supplier_id=s.id, currency="USD", order_date=D0, lines=po_lines(f))
    assert e.value.get_codes() == "supplier_not_in_good_standing"
    assert sup.effective_standing(pm.Supplier.objects.get(pk=s.pk), T + timedelta(days=6)) == "GOOD"  # suspension lapses
    sup.set_standing(pm1, s.id, "BLACKLISTED", reason="fraud")
    with pytest.raises(ValidationFailed):
        proc.create_rfq(pm1, title="x", supplier_ids=[s.id], lines=po_lines(f))
    with pytest.raises(ValidationFailed):
        sup.set_standing(pm1, s.id, "GOOD", reason="")
    sup.set_standing(pm1, s.id, "GOOD", reason="cleared after review")
    assert proc.create_po(f["people"]["po"].id, supplier_id=s.id, currency="USD", order_date=D0, lines=po_lines(f))
    assert [r for r in sup.risk_report() if r["supplier"] == s.name][0]["expired_documents"] == 1


@pytest.mark.django_db
def test_catalogue_price_history_and_preferred_ranking(f):
    a, b = f["supplier"], qualified(f, "Bolt Co")
    pm1, w = f["people"]["pm"].id, f["widget"].id
    sup.set_catalogue_price(pm1, a.id, w, unit_price="10", currency="USD", valid_from=T - timedelta(days=60))
    sup.set_catalogue_price(pm1, a.id, w, unit_price="12", currency="USD", valid_from=T - timedelta(days=10), lead_time_days=5)
    sup.set_catalogue_price(pm1, b.id, w, unit_price="11", currency="USD", valid_from=T - timedelta(days=30), is_preferred=True)
    with pytest.raises(ValidationFailed):
        sup.set_catalogue_price(pm1, a.id, w, unit_price="9", currency="USD", valid_from=T - timedelta(days=20))  # starts before the current price
    assert sup.current_price(a.id, w, T - timedelta(days=40)).unit_price == D("10")
    assert sup.current_price(a.id, w).unit_price == D("12")
    hist = sup.price_history(w, a.id)
    assert [h["unit_price"] for h in hist] == ["12.0000", "10.0000"] and hist[1]["valid_to"] == str(T - timedelta(days=11))
    ranked = sup.preferred_suppliers(w)
    assert [r["supplier"] for r in ranked] == ["Bolt Co", "Acme Supplies"]  # preferred first, despite the higher price
    sup.set_standing(pm1, b.id, "SUSPENDED", reason="audit")
    assert [r["supplier"] for r in sup.preferred_suppliers(w)] == ["Acme Supplies"]


@pytest.mark.django_db
def test_supplier_master_api(api_env):
    env, api = api_env
    sid = str(env["supplier"].id)
    assert api["po"].post(f"/api/v1/procurement/suppliers/{sid}/contacts", {"name": "Joe"}).status_code == 403
    assert api["pm"].post(f"/api/v1/procurement/suppliers/{sid}/contacts", {"name": "Joe", "role": "Sales"}).status_code == 201
    assert api["po"].post(f"/api/v1/procurement/suppliers/{sid}/bank-accounts", {"bank_name": "B", "account_name": "A", "account_number": "123456"}).status_code == 403
    r = api["pm"].post(f"/api/v1/procurement/suppliers/{sid}/bank-accounts", {"bank_name": "B", "account_name": "A", "account_number": "1234567890"})
    assert r.status_code == 201
    assert api["pm"].post(f"/api/v1/procurement/bank-accounts/{r.json()['id']}/verify").status_code == 403  # same person
    listed = api["pm"].get(f"/api/v1/procurement/suppliers/{sid}/bank-accounts").json()["results"][0]
    assert listed["account_number"] == "******7890" and listed["verified"] is False
    assert api["pm"].get(f"/api/v1/procurement/suppliers/{sid}/profile").json()["contacts"][0]["name"] == "Joe"
    assert api["emp"].get("/api/v1/procurement/supplier-risk").status_code == 403
    assert api["po"].get("/api/v1/procurement/supplier-risk").status_code == 200
