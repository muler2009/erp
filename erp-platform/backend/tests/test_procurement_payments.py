from datetime import timedelta
from decimal import Decimal as D

import pytest

from modules.finance import models as fm
from modules.finance import services as fin
from modules.procurement import models as pm
from modules.procurement import payments as pay
from modules.procurement import services as proc
from modules.procurement import suppliers as sup
from shared.api.errors import DomainError, ValidationFailed
from tests.test_procurement import D0, api_env, approved_po, f, gl, grni_invoice, receive  # noqa: F401


def verified_bank(f):
    p = f["people"]
    b = sup.add_bank_account(p["po"].id, f["supplier"].id, bank_name="Bank", account_name="Acme", account_number="123456", currency="USD", is_default=True)
    sup.verify_bank_account(p["pm"].id, b.id)


def posted(f, amount="100", ref="P-1"):
    p = f["people"]
    po = approved_po(f, "10", "10")
    receive(f, po, "10")
    i = grni_invoice(f, f["supplier"], amount)
    i.supplier_ref = ref
    i.save(update_fields=["supplier_ref"])
    proc.match_invoice(p["pm"].id, i.id, po.id)
    fin.post_invoice(p["mgr2"].id, i.id)
    i.refresh_from_db()
    return i


def terms(f, **kw):
    sup.update_supplier(f["people"]["pm"].id, f["supplier"].id, **kw)


@pytest.mark.django_db
def test_plain_payment_needs_verified_bank_and_is_idempotent(f):
    p = f["people"]
    i = posted(f)
    kw = dict(idempotency_key="k1", invoice_id=i.id, bank_account_id=f["bank_usd"].id, payment_date=D0)
    with pytest.raises(DomainError) as e:
        pay.pay_invoice(p["ctrl"].id, **kw)
    assert e.value.get_codes() == "no_verified_bank"
    verified_bank(f)
    with pytest.raises(DomainError) as e:
        pay.pay_invoice(p["mgr2"].id, **kw)  # posted it
    assert e.value.get_codes() == "separation_of_duties"
    pmt, created = pay.pay_invoice(p["ctrl"].id, **kw)
    again, created2 = pay.pay_invoice(p["ctrl"].id, **kw)
    assert created and not created2 and again.id == pmt.id and pmt.amount == D("100")
    i.refresh_from_db()
    assert i.status == "PAID" and gl("2100") == D("0")
    with pytest.raises(DomainError):
        pay.pay_invoice(p["ctrl"].id, **{**kw, "idempotency_key": "k2"})  # nothing left


@pytest.mark.django_db
def test_early_discount_and_withholding(f):
    p = f["people"]
    terms(f, early_discount_percent="2", early_discount_days=10, wht_percent="5")
    verified_bank(f)
    i = posted(f, "100")
    assert pay.discount_for(i, D0 + timedelta(days=10))[1] == D("2.00") and pay.discount_for(i, D0 + timedelta(days=11))[1] == 0
    pmt, _ = pay.pay_invoice(p["ctrl"].id, idempotency_key="d1", invoice_id=i.id, bank_account_id=f["bank_usd"].id, payment_date=D0 + timedelta(days=5))
    assert pmt.amount == D("93.00")  # 100 - 2 discount - 5 withheld
    i.refresh_from_db()
    assert i.status == "PAID" and i.outstanding == 0
    assert gl("2100") == D("0") and gl("2310") == D("5") and abs(gl("4200")) == D("2")
    assert [x["withheld"] for x in pay.wht_report(D0, D0 + timedelta(days=30))] == ["5.0000"]
    st = pay.statement(f["supplier"].id, D0, D0 + timedelta(days=30))
    assert {r["type"] for r in st["rows"]} == {"invoice", "payment", "discount", "withholding tax"}
    assert st["closing"]["USD"] == "0.0000"


@pytest.mark.django_db
def test_late_payment_gets_no_discount_and_can_opt_out(f):
    p = f["people"]
    terms(f, early_discount_percent="2", early_discount_days=10, wht_percent="10")
    verified_bank(f)
    i = posted(f, "100")
    pmt, _ = pay.pay_invoice(p["ctrl"].id, idempotency_key="l1", invoice_id=i.id, bank_account_id=f["bank_usd"].id, payment_date=D0 + timedelta(days=20), withhold=False)
    assert pmt.amount == D("100")
    with pytest.raises(ValidationFailed):
        terms(f, wht_percent="80")


@pytest.mark.django_db
def test_due_list_ageing_and_blacklist(f):
    p = f["people"]
    verified_bank(f)
    i = posted(f, "100")  # invoice dated D0, net 30
    assert pay.due_list(D0 + timedelta(days=10)) == []
    rows = pay.due_list(D0 + timedelta(days=45))
    assert rows[0]["days_overdue"] == 15 and rows[0]["payable"] is True
    assert pay.due_list(D0 + timedelta(days=10), within_days=25)[0]["invoice"] == str(i.id)
    a = pay.ageing(D0 + timedelta(days=45))[0]
    assert a["1-30"] == "100.0000" and a["total"] == "100.0000"
    assert pay.ageing(D0 + timedelta(days=5))[0]["current"] == "100.0000"
    sup.set_standing(p["pm"].id, f["supplier"].id, "BLACKLISTED", reason="Fraud")
    with pytest.raises(DomainError) as e:
        pay.pay_invoice(p["ctrl"].id, idempotency_key="b1", invoice_id=i.id, bank_account_id=f["bank_usd"].id, payment_date=D0)
    assert e.value.get_codes() == "supplier_blacklisted"


@pytest.mark.django_db
def test_payments_over_http_permissions(api_env):
    env, api = api_env
    for who in ("emp", "wh", "pm", "po"):
        assert api[who].get("/api/v1/procurement/payments/due").status_code == 403
        assert api[who].get("/api/v1/procurement/payments/ageing").status_code == 403
        assert api[who].post("/api/v1/procurement/invoices/00000000-0000-0000-0000-000000000001/pay", {"payment_date": "2026-03-15", "bank_account": "x"}).status_code == 403
    assert api["emp"].get(f"/api/v1/procurement/suppliers/{env['supplier'].id}/statement").status_code == 403
    assert api["pm"].get(f"/api/v1/procurement/suppliers/{env['supplier'].id}/statement").status_code == 200
