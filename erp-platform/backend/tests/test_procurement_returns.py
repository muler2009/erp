from decimal import Decimal as D

import pytest

from modules.finance import models as fm
from modules.finance import services as fin
from modules.inventory import services as inv
from modules.procurement import models as pm
from modules.procurement import returns as rt
from modules.procurement import services as proc
from modules.procurement import verification as vf
from shared.api.errors import DomainError, ValidationFailed
from tests.test_procurement import D0, api_env, approved_po, f, gl, grni_invoice, receive  # noqa: F401


def posted_invoice(f, po, amount):
    p = f["people"]
    i = grni_invoice(f, f["supplier"], amount)
    proc.match_invoice(p["pm"].id, i.id, po.id)
    fin.post_invoice(p["mgr2"].id, i.id)
    return i


def new_return(f, po, qty, who="po"):
    return rt.create_return(f["people"][who].id, po.id, location_id=f["loc_a"].id, return_date=D0, reason="Defective", lines=[{"po_line": str(po.lines.get().id), "quantity": qty}])


@pytest.mark.django_db
def test_uninvoiced_return_reverses_accrual_and_reopens_order(f):
    p = f["people"]
    po = approved_po(f, "10", "10")
    receive(f, po, "10")
    r = new_return(f, po, "4")
    assert r.return_value == D("40")
    with pytest.raises(ValidationFailed) as e:
        new_return(f, po, "7")  # 6 left after the 4 already promised
    assert e.value.get_codes() == "over_return"
    with pytest.raises(DomainError) as e:
        rt.approve_return(p["po"].id, r.id)
    assert e.value.get_codes() == "separation_of_duties"
    rt.approve_return(p["pm"].id, r.id)
    d = rt.dispatch_return(p["wh"].id, r.id)
    po.refresh_from_db()
    assert d.status == "DISPATCHED" and d.credit_due == 0 and po.status == "PARTIALLY_RECEIVED"
    assert po.lines.get().received_quantity == D("6") and inv.on_hand(f["widget"].id, f["loc_a"].id) == 6
    assert gl("1200") == D("60") and gl("2200") == D("60")
    assert rt.close_return(p["pm"].id, r.id).status == "CLOSED"
    receive(f, po, "4")  # replacement delivery
    po.refresh_from_db()
    assert po.status == "RECEIVED"


@pytest.mark.django_db
def test_invoiced_return_needs_credit_note(f):
    p = f["people"]
    po = approved_po(f, "10", "10")
    receive(f, po, "10")
    invc = posted_invoice(f, po, "100")
    r = new_return(f, po, "3")
    rt.approve_return(p["pm"].id, r.id)
    d = rt.dispatch_return(p["wh"].id, r.id)
    assert d.credit_due == D("30")
    with pytest.raises(DomainError) as e:
        rt.close_return(p["pm"].id, r.id)
    assert e.value.get_codes() == "credit_required"
    grni = str(fm.Account.objects.get(system_key="grni").id)
    small = vf.debit_note(p["officer"].id, invc.id, lines=[{"description": "x", "quantity": "1", "unit_price": "10", "account": grni}], reason="r", invoice_date=D0)
    with pytest.raises(ValidationFailed) as e:
        rt.link_credit(p["pm"].id, r.id, small.id)
    assert e.value.get_codes() == "credit_too_small"
    cn = vf.debit_note(p["officer"].id, invc.id, lines=[{"description": "Returned", "quantity": "1", "unit_price": "30", "account": grni}], reason="Return", invoice_date=D0)
    done = rt.link_credit(p["pm"].id, r.id, cn.id)
    po.refresh_from_db()
    assert done.status == "CREDITED" and po.invoiced_value == D("70")


@pytest.mark.django_db
def test_cancel_and_state_guards(f):
    p = f["people"]
    po = approved_po(f, "10", "10")
    with pytest.raises(DomainError):
        new_return(f, po, "1")  # nothing received: over_return is a validation error, so create first
    receive(f, po, "5")
    r = new_return(f, po, "2")
    with pytest.raises(DomainError):
        rt.dispatch_return(p["wh"].id, r.id)  # not approved
    assert rt.cancel_return(p["po"].id, r.id).status == "CANCELLED"
    with pytest.raises(DomainError):
        rt.approve_return(p["pm"].id, r.id)


@pytest.mark.django_db
def test_claim_lifecycle(f):
    p = f["people"]
    po = approved_po(f, "10", "10")
    c = rt.create_claim(p["po"].id, supplier_id=f["supplier"].id, kind="DAMAGE", description="Crates crushed", amount="25", order_id=po.id)
    assert c.currency == "USD" and c.number.startswith("CL-")
    with pytest.raises(DomainError):
        rt.decide_claim(p["pm"].id, c.id, accept=True)  # not submitted
    rt.submit_claim(p["po"].id, c.id)
    with pytest.raises(DomainError) as e:
        rt.decide_claim(p["po"].id, c.id, accept=True)
    assert e.value.get_codes() == "separation_of_duties"
    with pytest.raises(ValidationFailed):
        rt.decide_claim(p["pm"].id, c.id, accept=True, amount="30")
    assert rt.decide_claim(p["pm"].id, c.id, accept=True, amount="20").amount_accepted == D("20")
    with pytest.raises(ValidationFailed):
        rt.settle_claim(p["pm"].id, c.id, "00000000-0000-0000-0000-000000000001")
    rej = rt.create_claim(p["po"].id, supplier_id=f["supplier"].id, kind="LATE", description="Late", amount="5", order_id=po.id)
    rt.submit_claim(p["po"].id, rej.id)
    with pytest.raises(ValidationFailed):
        rt.decide_claim(p["pm"].id, rej.id, accept=False)
    assert rt.decide_claim(p["pm"].id, rej.id, accept=False, note="Within terms").status == "REJECTED"
    s = rt.summary()
    assert s[0]["claims"] == 2 and s[0]["accepted"] == "20.0000"


@pytest.mark.django_db
def test_returns_over_http_permissions(api_env, acme):
    from django_tenants.utils import schema_context
    env, api = api_env
    with schema_context(acme["schema"]):
        po = approved_po(env, "10", "10")
        receive(env, po, "10")
        line = po.lines.get()
    body = {"order": str(po.id), "location": str(env["loc_a"].id), "reason": "Wrong spec", "lines": [{"po_line": str(line.id), "quantity": "2"}]}
    assert api["emp"].post("/api/v1/procurement/returns", body).status_code == 403
    r = api["pm"].post("/api/v1/procurement/returns", body)
    assert r.status_code == 201
    rid = r.json()["id"]
    assert api["emp"].post(f"/api/v1/procurement/returns/{rid}/approve").status_code == 403
    assert api["pm"].post(f"/api/v1/procurement/returns/{rid}/approve").status_code == 403  # own return
    assert api["emp"].get("/api/v1/procurement/claims").status_code == 403
    assert api["pm"].get("/api/v1/procurement/returns/summary").status_code == 200
