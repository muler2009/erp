from datetime import date
from decimal import Decimal as D

import pytest

from modules.crm import campaigns as cp
from modules.crm import models as cm
from modules.crm import records as rec
from modules.crm import services as crm
from shared.api.errors import DomainError, ValidationFailed
from tests.test_sales import D0, f  # noqa: F401

START, END = date(2026, 3, 1), date(2026, 3, 31)


def camp(f, **kw):
    kw = {"name": "Spring promo", "start_date": START, "end_date": END, "currency": "USD", "budget": "1000", "audience": {"kind": "leads", "industry": "Retail"}, **kw}
    return cp.create_campaign(f["people"]["sm"].id, **kw)


def leads(f):
    p = f["people"]["rep1"].id
    out = []
    for n, (consent, email) in enumerate([(True, "a@x.com"), (False, "b@x.com"), (True, ""), (True, "d@x.com")]):
        l = crm.create_lead(p, name=f"Lead{n}", email=email, auto_assign=False)
        rec.update_lead(p, l.id, industry="Retail")
        cp.set_lead_consent(p, l.id, consent=consent)
        out.append(l)
    cp.set_lead_consent(p, out[3].id, opt_out=True)
    return out


@pytest.mark.django_db
def test_campaign_creation_rules_and_permissions(f):
    p = f["people"]
    c = camp(f)
    assert c.number.startswith("CMP-2026-")
    with pytest.raises(DomainError):
        cp.create_campaign(p["rep1"].id, name="x", start_date=START, end_date=END, currency="USD")
    for bad in ({"end_date": date(2026, 2, 1)}, {"budget": "-1"}, {"channel": "PIGEON"}, {"currency": "ZZZ"}, {"name": " "}, {"audience": {"kind": "leads", "bank_balance": 5}}):
        with pytest.raises(ValidationFailed):
            camp(f, **bad)


@pytest.mark.django_db
def test_audience_respects_consent_and_opt_out(f):
    p = f["people"]
    ls = leads(f)
    c = camp(f)
    res = cp.build_audience(p["sm"].id, c.id)
    assert res == {"added": 1, "excluded": 3}  # a@x.com only; no consent / no address / opted out are excluded
    why = {m.lead.name: m.excluded_reason for m in c.members.filter(status="EXCLUDED").select_related("lead")}
    assert why == {"Lead1": "no consent", "Lead2": "no address", "Lead3": "opted out"}
    assert cp.build_audience(p["sm"].id, c.id) == {"added": 0, "excluded": 0}  # re-run adds nothing twice
    cp.set_status(p["sm"].id, c.id, "ACTIVE")
    cp.set_lead_consent(p["rep1"].id, ls[0].id, opt_out=True)  # consent withdrawn after the list was built
    sent, blocked = cp.record_sent(p["sm"].id, c.id)
    assert (sent, blocked) == (0, 1)
    assert c.members.get(lead=ls[0]).excluded_reason == "consent withdrawn"


@pytest.mark.django_db
def test_contact_audience_uses_account_criteria_and_contact_consent(f):
    p = f["people"]
    rep = p["rep1"].id
    a = crm.create_account(rep, name="Retailer", industry="Retail")
    ok = crm.create_contact(rep, first_name="Yes", email="y@x.com", account_id=a.id)
    no = crm.create_contact(rep, first_name="No", email="n@x.com", account_id=a.id)
    rec.set_consent(rep, ok.id, email=True)
    c = camp(f, audience={"kind": "contacts", "industry": "Retail"})
    assert cp.build_audience(p["sm"].id, c.id) == {"added": 1, "excluded": 1}
    assert c.members.get(contact=no).excluded_reason == "no consent"
    cp.set_status(p["sm"].id, c.id, "ACTIVE")
    assert cp.record_sent(p["sm"].id, c.id) == (1, 0)
    mem = c.members.get(contact=ok)
    assert cp.record_response(p["sm"].id, mem.id).status == "RESPONDED"
    with pytest.raises(DomainError):
        cp.record_response(p["sm"].id, mem.id)


@pytest.mark.django_db
def test_lifecycle_and_empty_audience_cannot_activate(f):
    p = f["people"]
    c = camp(f)
    with pytest.raises(DomainError) as x:
        cp.set_status(p["sm"].id, c.id, "ACTIVE")
    assert x.value.get_codes() == "empty_audience"
    ev = camp(f, name="Expo", channel="EVENT", audience={})
    assert cp.set_status(p["sm"].id, ev.id, "ACTIVE").status == "ACTIVE"
    with pytest.raises(DomainError):
        cp.set_status(p["sm"].id, ev.id, "DRAFT")
    cp.set_status(p["sm"].id, ev.id, "COMPLETED")
    with pytest.raises(DomainError):
        cp.build_audience(p["sm"].id, ev.id)


@pytest.mark.django_db
def test_budget_is_enforced_and_report_computes_roi(f):
    p = f["people"]
    c = camp(f, channel="EVENT", audience={}, budget="500")
    cp.set_status(p["sm"].id, c.id, "ACTIVE")
    cp.add_expense(p["sm"].id, c.id, on_date=START, description="Venue", amount="300")
    with pytest.raises(DomainError) as x:
        cp.add_expense(p["sm"].id, c.id, on_date=START, description="Banners", amount="250")
    assert x.value.get_codes() == "budget_exceeded"
    with pytest.raises(ValidationFailed):
        cp.add_expense(p["sm"].id, c.id, on_date=START, description=" ", amount="5")
    with pytest.raises(DomainError):
        cp.update_budget(p["rep1"].id, c.id, "900")
    with pytest.raises(ValidationFailed):
        cp.update_budget(p["sm"].id, c.id, "100")  # below spend
    cp.update_budget(p["sm"].id, c.id, "600")
    cp.add_expense(p["sm"].id, c.id, on_date=START, description="Banners", amount="100")
    l1 = cp.capture_lead(p["sm"].id, c.id, name="Visitor One", email="v1@x.com", marketing_consent=True)
    cp.capture_lead(p["sm"].id, c.id, name="Visitor Two", email="v2@x.com")
    with pytest.raises(DomainError):
        cp.capture_lead(p["sm"].id, c.id, name="Dup", email="v1@x.com")
    assert l1.campaign_id == c.id and l1.source == f"CAMPAIGN:{c.number}"
    crm.set_lead_status(p["sm"].id, l1.id, "QUALIFIED")
    lead, o = crm.convert_lead(p["sm"].id, l1.id, amount="2000", currency="USD")
    assert o.campaign_id == c.id  # attribution follows the lead into the opportunity
    crm.win_opportunity(p["sm"].id, o.id)
    r = cp.campaign_report(p["sm"].id, c.id)
    assert (r["leads_generated"], r["leads_converted"], r["spent"], r["remaining"], r["won_revenue"]) == (2, 1, "400.0000", "200.0000", "2000.0000")
    assert r["roi_percent"] == "400.00" and r["cost_per_lead"] == "200.00"  # (2000-400)/400
    assert cp.campaigns_overview(p["sm"].id)[0]["campaign"] == c.number
    with pytest.raises(DomainError):
        cp.campaign_report(p["rep1"].id, c.id)
