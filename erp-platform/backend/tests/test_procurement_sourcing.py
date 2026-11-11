from datetime import timedelta
from decimal import Decimal as D

import pytest
from django.utils import timezone

from modules.procurement import models as pm
from modules.procurement import services as proc
from modules.procurement import sourcing as so
from shared.api.errors import DomainError, ValidationFailed
from tests.test_procurement import D0, api_env, f, po_lines, qualified  # noqa: F401

CRIT = [{"name": "price", "type": "FINANCIAL", "weight": 60}, {"name": "quality", "type": "TECHNICAL", "weight": 40}]


def bidders(f):
    return f["supplier"], qualified(f, "Bolt Co"), qualified(f, "Cheap Co")


def bid(rfq, sup, price, who=None):
    lid = str(rfq.lines.get().id)
    return proc.record_quotation(None, rfq.id, supplier_id=sup.id, currency="USD", prices={lid: price})


def tender(f, sups, **kw):
    p = f["people"]
    r = so.create_tender(p["po"].id, title="Widgets", lines=[{"product": str(f["widget"].id), "quantity": "10"}], committee=[p["pm"].id, p["pm2"].id], closing_at=timezone.now() + timedelta(days=7), criteria=CRIT, supplier_ids=[s.id for s in sups], **kw)
    return so.publish_tender(p["po"].id, r.id)


@pytest.mark.django_db
def test_criteria_validation_deadline_and_terms(f):
    for bad in ([{"name": "p", "type": "FINANCIAL", "weight": 50}], [{"name": "p", "type": "TECHNICAL", "weight": 100}], [{"name": "p", "type": "FINANCIAL", "weight": 60}, {"name": "q", "type": "OTHER", "weight": 40}]):
        with pytest.raises(ValidationFailed):
            so.clean_criteria(bad)
    r = proc.create_rfq(f["people"]["pm"].id, title="Terms", supplier_ids=[f["supplier"].id], lines=po_lines(f), closing_at=timezone.now() - timedelta(hours=1), payment_terms="Net 30", delivery_terms="DAP", terms_text="No partial deliveries")
    assert (r.payment_terms, r.delivery_terms) == ("Net 30", "DAP")
    with pytest.raises(DomainError) as e:
        bid(r, f["supplier"], "5")
    assert e.value.get_codes() == "bidding_closed"
    with pytest.raises(ValidationFailed):
        proc.create_rfq(None, title="x", supplier_ids=[f["supplier"].id], lines=po_lines(f), bogus=1)


@pytest.mark.django_db
def test_tender_sealed_bids_committee_opening_and_weighted_ranking(f):
    a, b, c = bidders(f)
    p = f["people"]
    with pytest.raises(ValidationFailed):
        so.create_tender(p["po"].id, title="t", lines=po_lines(f), committee=[p["pm"].id], closing_at=timezone.now() + timedelta(days=1), criteria=CRIT, supplier_ids=[a.id])  # committee of one
    t = tender(f, [a, b, c])
    qa, qb, qc = bid(t, a, "10"), bid(t, b, "12"), bid(t, c, "9")
    with pytest.raises(DomainError) as e:
        proc.compare_bids(t.id)
    assert e.value.get_codes() == "bids_sealed"
    with pytest.raises(DomainError):
        so.open_bids(p["pm"].id, t.id)  # still open for bidding
    t.refresh_from_db()
    t.closing_at = timezone.now() - timedelta(minutes=1)
    t.save()
    with pytest.raises(DomainError) as e:
        so.open_bids(p["po"].id, t.id)  # not on the committee
    assert e.value.get_codes() == "not_committee_member"
    so.open_bids(p["pm"].id, t.id)
    with pytest.raises(DomainError):
        so.evaluation(t.id)  # needs both members
    with pytest.raises(DomainError):
        so.open_bids(p["pm"].id, t.id)  # same member twice
    so.open_bids(p["pm2"].id, t.id)
    for q, m1, m2 in ((qa, 90, 80), (qb, 95, 95), (qc, 40, 40)):
        so.score_quotation(p["pm"].id, q.id, {"quality": m1})
        so.score_quotation(p["pm2"].id, q.id, {"quality": m2})
    with pytest.raises(DomainError):
        so.score_quotation(p["po"].id, qa.id, {"quality": 1})
    with pytest.raises(ValidationFailed):
        so.score_quotation(p["pm"].id, qa.id, {"price": 50})  # only technical criteria are scored by people
    ev = so.evaluation(t.id)
    # price scores: c=100, a=90, b=75 ; quality avg: a=85, b=95, c=40 -> totals a=88, b=83, c=76
    assert [r["supplier"] for r in ev["results"]] == ["Acme Supplies", "Bolt Co", "Cheap Co"] and ev["results"][0]["weighted_score"] == "88.00"
    assert ev["recommended"] == str(qa.id)


@pytest.mark.django_db
def test_award_rules_justification_disqualification_and_separation(f):
    a, b, c = bidders(f)
    p = f["people"]
    t = tender(f, [a, b, c], min_technical_score=50)
    qa, qb, qc = bid(t, a, "10"), bid(t, b, "12"), bid(t, c, "9")
    pm.Rfq.objects.filter(pk=t.pk).update(closing_at=timezone.now() - timedelta(minutes=1))
    so.open_bids(p["pm"].id, t.id); so.open_bids(p["pm2"].id, t.id)
    for q, s in ((qa, 85), (qb, 95), (qc, 40)):
        so.score_quotation(p["pm"].id, q.id, {"quality": s})
    ev = {r["supplier"]: r for r in so.evaluation(t.id)["results"]}
    assert ev["Cheap Co"]["compliant"] is False and ev["Cheap Co"]["rank"] is None  # below the technical minimum
    with pytest.raises(DomainError) as e:
        so.award(p["po"].id, t.id, qc.id)  # creator cannot award
    assert e.value.get_codes() == "separation_of_duties"
    with pytest.raises(DomainError) as e:
        so.award(p["pm"].id, t.id, qc.id)
    assert e.value.get_codes() == "justification_required"
    with pytest.raises(DomainError) as e:
        so.award(p["pm"].id, t.id, qb.id)  # not the recommended bid
    assert e.value.get_codes() == "justification_required"
    so.disqualify(p["pm"].id, qb.id, "Missing tax certificate")
    with pytest.raises(DomainError) as e:
        so.award(p["pm"].id, t.id, qb.id, justification="x")
    assert e.value.get_codes() == "disqualified"
    po = so.award(p["pm"].id, t.id, qa.id)
    t.refresh_from_db()
    assert t.status == "AWARDED" and po.supplier_id == a.id
    res = {r["supplier"]: r["outcome"] for r in so.bidder_results(t.id)}
    assert res == {"Acme Supplies": "AWARDED", "Bolt Co": "DISQUALIFIED", "Cheap Co": "NOT_SELECTED"}


@pytest.mark.django_db
def test_open_tender_clarifications_and_single_source(f):
    a, b, _ = bidders(f)
    p = f["people"]
    t = so.create_tender(p["po"].id, title="Open", lines=po_lines(f), committee=[p["pm"].id, p["pm2"].id], closing_at=timezone.now() + timedelta(days=3), criteria=CRIT, open_to_all=True)
    so.publish_tender(p["po"].id, t.id)
    assert bid(t, a, "10") and t.suppliers.count() == 1  # a qualified supplier joined by bidding
    proc.block_supplier(p["pm"].id, b.id, reason="x")
    from modules.procurement import suppliers as sup
    sup.set_standing(p["pm"].id, a.id, "GOOD")
    c = so.ask(p["pm"].id, t.id, supplier_id=a.id, question="Is delivery partial allowed?")
    assert so.answer(p["pm"].id, c.id, "Yes, two lots.").answer == "Yes, two lots."
    with pytest.raises(ValidationFailed):
        so.single_source_po(p["pm"].id, supplier_id=a.id, currency="USD", order_date=D0, lines=po_lines(f), justification="too short")
    po = so.single_source_po(p["pm"].id, supplier_id=a.id, currency="USD", order_date=D0, lines=po_lines(f), justification="Only licensed distributor of the proprietary part")
    assert po.single_source and so.single_source_report()[0]["po"] == po.number


@pytest.mark.django_db
def test_sourcing_api_permissions(api_env):
    env, api = api_env
    body = {"title": "T", "lines": [{"product": str(env["widget"].id), "quantity": "5"}], "committee": [str(env["people"]["pm"].id), str(env["people"]["pm2"].id)], "closing_at": (timezone.now() + timedelta(days=2)).isoformat(), "criteria": CRIT, "suppliers": [str(env["supplier"].id)]}
    assert api["emp"].post("/api/v1/procurement/tenders", body).status_code == 403
    r = api["po"].post("/api/v1/procurement/tenders", body)
    assert r.status_code == 201 and r.json()["status"] == "DRAFT"
    assert api["po"].post(f"/api/v1/procurement/tenders/{r.json()['id']}/publish").json()["status"] == "OPEN"
    assert api["po"].post(f"/api/v1/procurement/tenders/{r.json()['id']}/open").status_code == 403  # lacks evaluate permission
    assert api["po"].post("/api/v1/procurement/single-source", {"supplier": str(env["supplier"].id), "currency": "USD", "lines": [], "justification": "x" * 30}).status_code == 403


@pytest.mark.django_db
def test_rfq_detail_api_shows_lines_and_bids_but_seals_tender_bids(api_env):
    env, api = api_env
    sid = str(env["supplier"].id)
    rfq = api["po"].post("/api/v1/procurement/rfqs", {"title": "Widgets", "suppliers": [sid], "lines": [{"product": str(env["widget"].id), "quantity": "5"}]})
    assert rfq.status_code == 201
    rid, line_id = rfq.json()["id"], rfq.json()["lines"][0]["id"]
    assert api["emp"].get(f"/api/v1/procurement/rfqs/{rid}").status_code == 403  # needs procurement.view
    assert api["po"].post(f"/api/v1/procurement/rfqs/{rid}/quotations", {"supplier": sid, "currency": "USD", "prices": {line_id: "12.5"}, "lead_time_days": 7}).status_code == 201
    d = api["po"].get(f"/api/v1/procurement/rfqs/{rid}").json()
    assert d["kind"] == "RFQ" and d["sealed"] is False and d["suppliers"] == [{"id": sid, "name": "Api Supplier"}]
    assert d["lines"][0]["id"] == line_id and d["lines"][0]["quantity"].startswith("5")
    assert d["quotations"][0]["prices"] == {line_id: "12.5000"} and d["quotations"][0]["lead_time_days"] == 7
    assert api["po"].get("/api/v1/procurement/rfqs").json()["results"][0]["kind"] == "RFQ"

    body = {"title": "T", "lines": [{"product": str(env["widget"].id), "quantity": "5"}], "committee": [str(env["people"]["pm"].id), str(env["people"]["pm2"].id)], "closing_at": (timezone.now() + timedelta(days=2)).isoformat(), "criteria": CRIT, "suppliers": [sid]}
    t = api["po"].post("/api/v1/procurement/tenders", body).json()
    assert api["po"].post(f"/api/v1/procurement/tenders/{t['id']}/publish").status_code == 200
    tl = api["po"].get(f"/api/v1/procurement/rfqs/{t['id']}").json()["lines"][0]["id"]
    assert api["po"].post(f"/api/v1/procurement/rfqs/{t['id']}/quotations", {"supplier": sid, "currency": "USD", "prices": {tl: "9"}}).status_code == 201
    sealed = api["po"].get(f"/api/v1/procurement/rfqs/{t['id']}").json()
    assert sealed["kind"] == "TENDER" and sealed["sealed"] is True and sealed["quotations"] == [] and sealed["quotation_count"] == 1
    assert api["po"].get(f"/api/v1/procurement/rfqs/{t['id']}/comparison").status_code == 403  # same rule as the comparison endpoint
