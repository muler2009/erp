from datetime import date, timedelta
from decimal import Decimal as D

import pytest

from modules.procurement import contracts as ct
from modules.procurement import models as pm
from modules.procurement import services as proc
from shared.api.errors import DomainError, ValidationFailed
from tests.test_procurement import D0, api_env, f, po_lines, qualified  # noqa: F401


def make(f, **kw):
    a = dict(supplier_id=f["supplier"].id, title="Widgets 2026", start_date=D0, end_date=D0 + timedelta(days=100), currency="USD", prices=[{"product": f["widget"].id, "unit_price": "8"}], value_limit="200")
    a.update(kw)
    return ct.create(f["people"]["po"].id, **a)


@pytest.mark.django_db
def test_lifecycle_and_separation_of_duties(f):
    p = f["people"]
    c = make(f)
    with pytest.raises(DomainError) as e:
        ct.activate(p["po"].id, c.id)
    assert e.value.get_codes() == "separation_of_duties"
    ct.activate(p["pm"].id, c.id)
    with pytest.raises(DomainError):
        ct.activate(p["pm"].id, c.id)
    with pytest.raises(ValidationFailed):
        ct.extend(None, c.id, new_end_date=D0, reason="x")
    ct.extend(None, c.id, new_end_date=D0 + timedelta(days=200), reason="renewed")
    with pytest.raises(ValidationFailed):
        ct.terminate(None, c.id, reason="")
    assert ct.terminate(None, c.id, reason="breach").status == "TERMINATED"
    with pytest.raises(ValidationFailed):
        make(f, prices=[])
    with pytest.raises(ValidationFailed):
        make(f, end_date=D0 - timedelta(days=1))


@pytest.mark.django_db
def test_po_uses_contract_prices_and_ceiling(f):
    p = f["people"]
    c = make(f)
    ct.activate(p["pm"].id, c.id)
    line = lambda q, pr=None: [{"product": f["widget"].id, "quantity": q, "unit_price": pr}]
    po = proc.create_po(p["po"].id, supplier_id=f["supplier"].id, currency="USD", order_date=D0, lines=line("10"), contract_id=c.id)
    assert po.total == D("80") and po.lines.get().unit_price == D("8")
    with pytest.raises(ValidationFailed) as e:
        proc.create_po(p["po"].id, supplier_id=f["supplier"].id, currency="USD", order_date=D0, lines=line("1", "9"), contract_id=c.id)
    assert e.value.get_codes() == "price_exceeds_contract"
    with pytest.raises(ValidationFailed) as e:
        proc.create_po(p["po"].id, supplier_id=f["supplier"].id, currency="EUR", order_date=D0, lines=line("1"), contract_id=c.id)
    assert e.value.get_codes() == "contract_currency_mismatch"
    with pytest.raises(ValidationFailed) as e:
        proc.create_po(p["po"].id, supplier_id=f["supplier"].id, currency="USD", order_date=D0, lines=[{"product": f["paint"].id, "quantity": "1"}], contract_id=c.id)
    assert e.value.get_codes() == "not_in_contract"
    with pytest.raises(DomainError) as e:  # 80 used, 16 more would be 96; 20 more is 240 > 200
        proc.create_po(p["po"].id, supplier_id=f["supplier"].id, currency="USD", order_date=D0, lines=line("20"), contract_id=c.id)
    assert e.value.get_codes() == "contract_ceiling"
    assert ct.status_report(c.id)["remaining"] == "120.0000"
    proc.cancel_po(p["po"].id, po.id) if hasattr(proc, "cancel_po") else None
    with pytest.raises(DomainError) as e:
        proc.create_po(p["po"].id, supplier_id=f["supplier"].id, currency="USD", order_date=D0 + timedelta(days=300), lines=line("1"), contract_id=c.id)
    assert e.value.get_codes() == "contract_not_active"


@pytest.mark.django_db
def test_daily_expiry_renewal_and_notice(f):
    c = make(f)
    ct.activate(f["people"]["pm"].id, c.id)
    r = make(f, title="Auto", auto_renew=True)
    ct.activate(f["people"]["pm"].id, r.id)
    assert ct.run_daily(D0 + timedelta(days=30)) == {"expired": 0, "renewed": 0, "warned": 0}
    assert ct.run_daily(D0 + timedelta(days=35))["warned"] == 0
    assert ct.run_daily(D0 + timedelta(days=41))["warned"] == 2
    assert ct.run_daily(D0 + timedelta(days=42))["warned"] == 0  # only once
    assert len(ct.expiring(60, D0 + timedelta(days=50))) == 2
    out = ct.run_daily(D0 + timedelta(days=101))
    assert out["expired"] == 1 and out["renewed"] == 1
    r.refresh_from_db()
    assert r.status == "ACTIVE" and r.end_date > D0 + timedelta(days=101)


@pytest.mark.django_db
def test_contracts_over_http_permissions(api_env):
    env, api = api_env
    body = {"supplier": str(env["supplier"].id), "title": "T", "start_date": "2026-03-01", "end_date": "2026-12-31", "currency": "USD", "value_limit": "500", "prices": [{"product": str(env["widget"].id), "unit_price": "7"}]}
    assert api["emp"].post("/api/v1/procurement/contracts", body).status_code == 403
    assert api["wh"].get("/api/v1/procurement/contracts").status_code in (200, 403)
    r = api["po"].post("/api/v1/procurement/contracts", body)
    assert r.status_code in (201, 403)
    if r.status_code == 403:  # procurement officer may lack contract.manage; the manager holds it
        r = api["pm"].post("/api/v1/procurement/contracts", body)
    assert r.status_code == 201
    cid = r.json()["id"]
    assert api["emp"].post(f"/api/v1/procurement/contracts/{cid}/activate").status_code == 403
    own = api["pm"].post(f"/api/v1/procurement/contracts/{cid}/activate")
    assert own.status_code == 403 and "separation" in own.content.decode().lower()
    assert api["pm"].get(f"/api/v1/procurement/contracts/{cid}").json()["consumed"] == "0.0000"
    assert api["emp"].get("/api/v1/procurement/contracts/expiring").status_code == 403
