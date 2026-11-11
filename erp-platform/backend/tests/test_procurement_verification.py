from decimal import Decimal as D

import pytest

from modules.finance import models as fm
from modules.finance import services as fin
from modules.procurement import models as pm
from modules.procurement import services as proc
from modules.procurement import verification as vf
from platform_core.organizations import services as org
from shared.api.errors import DomainError, ValidationFailed
from tests.test_procurement import D0, api_env, approved_po, f, gl, grni_invoice, receive  # noqa: F401


def inv_with_ref(f, amount, ref):
    i = grni_invoice(f, f["supplier"], amount)
    i.supplier_ref = ref
    i.save(update_fields=["supplier_ref"])
    return i


@pytest.mark.django_db
def test_duplicate_invoice_is_an_exception_and_not_overridable(f):
    p = f["people"]
    po = approved_po(f, "10", "10")
    receive(f, po, "10")
    first = inv_with_ref(f, "40", "INV/001")
    assert proc.match_invoice(p["pm"].id, first.id, po.id).status == "MATCHED"
    dup = inv_with_ref(f, "40", "inv-001")
    m = proc.match_invoice(p["pm"].id, dup.id, po.id)
    assert m.status == "EXCEPTION" and "duplicate_invoice" in m.detail["problems"]
    with pytest.raises(DomainError) as e:
        vf.override(p["mgr"].id, m.id, reason="ok")
    assert e.value.get_codes() == "duplicate_not_overridable"
    other = inv_with_ref(f, "40", "INV-777")  # same value and date, different number: only a warning
    m2 = proc.match_invoice(p["pm"].id, other.id, po.id)
    assert m2.status == "MATCHED" and m2.detail["possible_duplicates"]


@pytest.mark.django_db
def test_override_rules_and_posting(f):
    p = f["people"]
    po = approved_po(f, "10", "10")
    receive(f, po, "5")
    invc = inv_with_ref(f, "80", "A-1")
    m = proc.match_invoice(p["pm"].id, invc.id, po.id)
    assert m.status == "EXCEPTION" and [x["invoice"] for x in vf.exceptions()] == [str(invc.id)]
    with pytest.raises(ValidationFailed):
        vf.override(p["mgr"].id, m.id, reason=" ")
    with pytest.raises(DomainError) as e:
        vf.override(p["pm"].id, m.id, reason="urgent")  # the person who ran the match
    assert e.value.get_codes() == "separation_of_duties"
    assert vf.override(p["mgr"].id, m.id, reason="Goods arrived, receipt pending").status == "OVERRIDDEN"
    po.refresh_from_db()
    assert po.invoiced_value == D("80") and vf.exceptions() == []
    assert fin.post_invoice(p["mgr2"].id, invc.id).status == "POSTED"
    with pytest.raises(DomainError):
        vf.override(p["mgr"].id, m.id, reason="again")


@pytest.mark.django_db
def test_two_way_match_is_opt_in(f):
    p = f["people"]
    po = approved_po(f, "10", "10")
    invc = inv_with_ref(f, "50", "B-1")  # nothing received
    with pytest.raises(DomainError) as e:
        proc.match_invoice(p["pm"].id, invc.id, po.id, mode="TWO_WAY")
    assert e.value.get_codes() == "two_way_disabled"
    assert proc.match_invoice(p["pm"].id, invc.id, po.id).status == "EXCEPTION"
    org.update_settings(None, {"procurement.allow_two_way_match": True})
    ok = proc.match_invoice(p["pm"].id, invc.id, po.id, mode="TWO_WAY")
    assert ok.status == "MATCHED" and ok.detail["mode"] == "TWO_WAY"
    big = inv_with_ref(f, "500", "B-2")  # still bounded by the order value
    assert proc.match_invoice(p["pm"].id, big.id, po.id, mode="TWO_WAY").status == "EXCEPTION"


@pytest.mark.django_db
def test_inspection_pending_blocks_match(f):
    from modules.inventory import services as inv
    p = f["people"]
    inv.create_location(None, warehouse_id=f["loc_a"].warehouse_id, code="QC", kind="QUARANTINE")
    po = approved_po(f, "10", "10")
    line = po.lines.get()
    proc.receive_goods(p["wh"].id, po.id, location_id=f["loc_a"].id, receipt_date=D0, lines=[{"po_line": str(line.id), "quantity": "10", "inspect": True}])
    m = proc.match_invoice(p["pm"].id, inv_with_ref(f, "100", "C-1").id, po.id)
    assert m.status == "EXCEPTION" and "inspection_pending" in m.detail["problems"]


@pytest.mark.django_db
def test_debit_note_against_posted_invoice(f):
    p = f["people"]
    po = approved_po(f, "10", "10")
    receive(f, po, "10")
    invc = inv_with_ref(f, "100", "D-1")
    proc.match_invoice(p["pm"].id, invc.id, po.id)
    grni = str(fm.Account.objects.get(system_key="grni").id)
    line = lambda a: [{"description": "Damaged", "quantity": "1", "unit_price": a, "account": grni}]
    with pytest.raises(DomainError):
        vf.debit_note(p["officer"].id, invc.id, lines=line("10"), reason="r", invoice_date=D0)  # not posted yet
    fin.post_invoice(p["mgr2"].id, invc.id)
    with pytest.raises(ValidationFailed):
        vf.debit_note(p["officer"].id, invc.id, lines=line("10"), reason="", invoice_date=D0)
    cn = vf.debit_note(p["officer"].id, invc.id, lines=line("30"), reason="Damaged goods", invoice_date=D0)
    assert cn.kind == "SUPPLIER_CREDIT_NOTE" and cn.credit_for_id == invc.id and cn.total == D("30")
    with pytest.raises(DomainError) as e:
        vf.debit_note(p["officer"].id, invc.id, lines=line("80"), reason="too much", invoice_date=D0)
    assert e.value.get_codes() == "credit_exceeds_invoice"


@pytest.mark.django_db
def test_verification_over_http_permissions(api_env):
    env, api = api_env
    for who in ("emp", "wh"):
        assert api[who].get("/api/v1/procurement/match-exceptions").status_code == 403
        assert api[who].post("/api/v1/procurement/matches/00000000-0000-0000-0000-000000000001/override", {"reason": "x"}).status_code == 403
        assert api[who].post("/api/v1/procurement/invoices/00000000-0000-0000-0000-000000000001/debit-notes", {}).status_code == 403
    assert api["pm"].get("/api/v1/procurement/match-exceptions").json() == {"results": []}
    assert api["pm"].post("/api/v1/procurement/matches/00000000-0000-0000-0000-000000000001/override", {"reason": "x"}).status_code == 404
