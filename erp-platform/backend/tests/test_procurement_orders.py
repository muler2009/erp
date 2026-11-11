from datetime import date, timedelta
from decimal import Decimal as D

import pytest

from modules.procurement import budgets as bd
from modules.procurement import models as pm
from modules.procurement import orders_ext as ox
from modules.procurement import services as proc
from shared.api.errors import DomainError, ValidationFailed
from tests.test_procurement import D0, api_env, approved_po, f, gl, po_lines, qualified, receive  # noqa: F401


@pytest.mark.django_db
def test_schedule_acknowledgment_and_overdue_report(f):
    po = approved_po(f, "10", "10")
    line = po.lines.get()
    with pytest.raises(ValidationFailed):
        ox.set_schedule(None, line.id, [{"due_date": D0, "quantity": "11"}])
    ox.set_schedule(None, line.id, [{"due_date": D0 + timedelta(days=5), "quantity": "4"}, {"due_date": D0 + timedelta(days=20), "quantity": "6"}])
    assert [(r["days_late"], r["open_quantity"]) for r in ox.overdue_lines(D0 + timedelta(days=8))] == [(3, "4.0000")]
    receive(f, po, "3")
    assert ox.overdue_lines(D0 + timedelta(days=8))[0]["open_quantity"] == "1.0000"  # receipts fill the earliest delivery first
    assert ox.overdue_lines(D0 + timedelta(days=30))[0]["open_quantity"] == "7.0000"
    with pytest.raises(ValidationFailed):
        ox.acknowledge(None, po.id, reference="")
    assert ox.acknowledge(None, po.id, reference="ACK-77", promised_date=D0 + timedelta(days=6)).acknowledgment_ref == "ACK-77"
    draft = proc.create_po(f["people"]["po"].id, supplier_id=f["supplier"].id, currency="USD", order_date=D0, lines=po_lines(f))
    with pytest.raises(DomainError):
        ox.acknowledge(None, draft.id, reference="x")


@pytest.mark.django_db
def test_amendment_rules_approval_and_budget(f):
    p = f["people"]
    b = bd.create_budget(None, code="B", name="b", fiscal_year=2026, amount="300")
    po = proc.create_po(p["po"].id, supplier_id=f["supplier"].id, currency="USD", order_date=D0, lines=po_lines(f, "10", "10"), budget_id=b.id)
    proc.submit_po(p["po"].id, po.id)
    proc.approve_po(p["pm"].id, po.id)
    line = po.lines.get()
    receive(f, po, "4")
    with pytest.raises(ValidationFailed) as e:
        ox.request_amendment(p["po"].id, po.id, reason="r", lines=[{"line": line.id, "quantity": "3"}])
    assert e.value.get_codes() == "below_received"
    with pytest.raises(ValidationFailed) as e:
        ox.request_amendment(p["po"].id, po.id, reason="r", lines=[{"line": line.id, "unit_price": "9"}])
    assert e.value.get_codes() == "price_locked"
    a = ox.request_amendment(p["po"].id, po.id, reason="Need more", lines=[{"line": line.id, "quantity": "20"}], expected_date=D0 + timedelta(days=9))
    assert (a.old_total, a.new_total) == (D("100"), D("200"))
    with pytest.raises(DomainError):
        ox.request_amendment(p["po"].id, po.id, reason="again", lines=[{"line": line.id, "quantity": "21"}])  # one at a time
    with pytest.raises(DomainError) as e:
        ox.decide_amendment(p["po"].id, a.id, approve=True)
    assert e.value.get_codes() == "separation_of_duties"
    ox.decide_amendment(p["pm"].id, a.id, approve=True)
    po.refresh_from_db(); line.refresh_from_db()
    assert (po.total, po.version, line.quantity, po.expected_date) == (D("200"), 2, 20, D0 + timedelta(days=9)) and bd.budget_status(b)["committed"] == "200.0000"
    over = ox.request_amendment(p["po"].id, po.id, reason="huge", lines=[{"line": line.id, "quantity": "40"}])  # 400 > 300 budget
    with pytest.raises(DomainError) as e:
        ox.decide_amendment(p["pm"].id, over.id, approve=True)
    assert e.value.get_codes() == "budget_exceeded"
    with pytest.raises(ValidationFailed):
        ox.decide_amendment(p["pm"].id, over.id, approve=False, note="")
    assert ox.decide_amendment(p["pm"].id, over.id, approve=False, note="no budget").status == "REJECTED"


@pytest.mark.django_db
def test_blanket_order_releases_and_expiry(f):
    p = f["people"]
    b = ox.create_blanket(p["po"].id, supplier_id=f["supplier"].id, currency="USD", order_date=D0, valid_to=D0 + timedelta(days=60), lines=po_lines(f, "100", "8"))
    proc.submit_po(p["po"].id, b.id)
    proc.approve_po(p["pm"].id, b.id)
    bl = b.lines.get()
    with pytest.raises(DomainError) as e:
        receive(f, b, "1")
    assert e.value.get_codes() == "blanket_not_receivable"
    r1 = ox.release_blanket(p["po"].id, b.id, [{"blanket_line": bl.id, "quantity": "30"}], order_date=D0 + timedelta(days=1))
    assert r1.kind == "RELEASE" and r1.total == D("240") and r1.lines.get().unit_price == D("8")
    with pytest.raises(DomainError) as e:
        ox.release_blanket(p["po"].id, b.id, [{"blanket_line": bl.id, "quantity": "71"}], order_date=D0 + timedelta(days=1))
    assert e.value.get_codes() == "over_release"
    with pytest.raises(DomainError) as e:
        ox.release_blanket(p["po"].id, b.id, [{"blanket_line": bl.id, "quantity": "1"}], order_date=D0 + timedelta(days=61))
    assert e.value.get_codes() == "blanket_expired"
    proc.cancel_po(p["po"].id, r1.id)
    bl.refresh_from_db()
    assert bl.released_quantity == 0  # cancelled release frees the ceiling


@pytest.mark.django_db
def test_short_close_releases_budget_and_document(f):
    p = f["people"]
    b = bd.create_budget(None, code="B", name="b", fiscal_year=2026, amount="500")
    po = proc.create_po(p["po"].id, supplier_id=f["supplier"].id, currency="USD", order_date=D0, lines=po_lines(f, "10", "10"), budget_id=b.id)
    with pytest.raises(DomainError):
        ox.document(po.id)  # not yet issued
    proc.submit_po(p["po"].id, po.id)
    proc.approve_po(p["pm"].id, po.id)
    ox.set_schedule(None, po.lines.get().id, [{"due_date": D0 + timedelta(days=3), "quantity": "10"}])
    receive(f, po, "6")
    assert bd.budget_status(b)["committed"] == "100.0000"
    with pytest.raises(ValidationFailed):
        ox.close_po(p["pm"].id, po.id, reason="")
    assert ox.close_po(p["pm"].id, po.id, reason="Supplier cannot deliver the rest").status == "CLOSED"
    assert bd.budget_status(b)["committed"] == "60.0000"  # only what was received stays committed
    d = ox.document(po.id)
    assert d["total"] == "100.0000" and d["lines"][0]["schedule"][0]["quantity"] == "10.0000" and d["payment_terms"] == "Net 30"
    html = ox.document_html(po.id)
    assert po.number in html and "<script" not in html


@pytest.mark.django_db
def test_order_extension_api(api_env):
    env, api = api_env
    from tests.test_procurement import po_lines as pl
    body = {"supplier": str(env["supplier"].id), "currency": "USD", "order_date": "2026-03-15", "lines": pl(env, "10", "5")}
    po = api["po"].post("/api/v1/procurement/purchase-orders", body).json()
    assert api["po"].patch(f"/api/v1/procurement/purchase-orders/{po['id']}/terms", {"payment_terms": "Net 45"}).json()["payment_terms"] == "Net 45"
    assert api["emp"].get(f"/api/v1/procurement/purchase-orders/{po['id']}/document").status_code == 403
    assert api["po"].get(f"/api/v1/procurement/purchase-orders/{po['id']}/document").status_code == 409  # not approved yet
    assert api["po"].post(f"/api/v1/procurement/purchase-orders/{po['id']}/close", {"reason": "x"}).status_code == 403
    assert api["po"].get("/api/v1/procurement/overdue-deliveries").status_code == 200
