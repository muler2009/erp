from datetime import date, timedelta

import pytest

from modules.crm import models as cm
from modules.crm import pipeline
from modules.crm import services as crm
from modules.sales import models as sm
from modules.sales import quotes
from modules.sales import services as sales
from shared.api.errors import DomainError, ValidationFailed
from shared.notifications.models import Notification
from tests.test_sales import D0, f, line  # noqa: F401


def q(f, who="rep1", lines=None, **kw):
    return sales.create_quotation(f["people"][who].id, account_id=f["acct"].id, currency="USD", lines=lines or [line(f)], **kw)


@pytest.mark.django_db
def test_terms_and_revision_history(f):
    p = f["people"]
    a = q(f, payment_terms="Net 30", delivery_terms="EXW", terms="Prices exclude duties", notes="n")
    assert (a.payment_terms, a.delivery_terms, a.terms, a.version) == ("Net 30", "EXW", "Prices exclude duties", 1)
    sales.update_quotation(p["rep1"].id, a.id, lines=[line(f, qty="20")], payment_terms="Net 45")
    a.refresh_from_db()
    assert (a.version, a.payment_terms, a.delivery_terms) == (2, "Net 45", "EXW") and a.total == 2000
    sales.send_quotation(p["rep1"].id, a.id)
    revised = quotes.revise(p["rep1"].id, a.id, "customer asked for fewer")
    assert (revised.status, revised.version) == ("DRAFT", 3)
    hist = quotes.revisions(p["rep1"].id, a.id)
    assert [(r.version, r.event) for r in hist] == [(1, "EDITED"), (2, "SENT"), (2, "REVISED")]
    assert hist[0].snapshot["lines"][0]["quantity"] == "10.0000" and hist[0].snapshot["payment_terms"] == "Net 30"
    with pytest.raises(DomainError):
        quotes.revisions(p["rep2"].id, a.id)
    with pytest.raises(DomainError):
        quotes.revise(p["rep1"].id, a.id)  # a draft is not revised, it is edited
    with pytest.raises(ValidationFailed):
        q(f, terms="x" * 6000)


@pytest.mark.django_db
def test_large_or_heavily_discounted_quotes_need_approval_by_someone_else(f):
    p = f["people"]
    big = q(f, lines=[line(f, qty="200", price="100")])  # 20000 >= threshold 10000
    assert sales.send_quotation(p["rep1"].id, big.id).status == "PENDING_APPROVAL"
    with pytest.raises(DomainError):
        quotes.approve(p["rep1"].id, big.id)  # reps cannot approve
    mine = q(f, "sm", lines=[line(f, qty="200", price="100")])
    assert sales.send_quotation(p["sm"].id, mine.id).status == "PENDING_APPROVAL"  # creator cannot self-approve by sending
    with pytest.raises(DomainError) as e:
        quotes.approve(p["sm"].id, mine.id)
    assert e.value.get_codes() == "separation_of_duties"
    assert quotes.approve(p["sm2"].id, mine.id).status == "SENT"
    assert quotes.approve(p["sm"].id, big.id).status == "SENT" and sm.Quotation.objects.get(pk=big.id).approved_by == p["sm"].id
    assert Notification.objects.filter(user_id=p["rep1"].id, notification_type="sales.quotation.approved").exists()
    disc = q(f, lines=[{**line(f, qty="1", price="100"), "discount_percent": "20"}])
    assert disc.max_discount == 20
    cm.Opportunity  # discount above the 10 % limit also needs approval (rep has no override but ceiling applies only with rules)
    assert sales.send_quotation(p["rep1"].id, disc.id).status == "PENDING_APPROVAL"
    with pytest.raises(ValidationFailed):
        quotes.reject_approval(p["sm"].id, disc.id, " ")
    assert quotes.reject_approval(p["sm"].id, disc.id, "too generous").status == "DRAFT"
    assert Notification.objects.filter(user_id=p["rep1"].id, notification_type="sales.quotation.returned").exists()
    small = q(f)
    assert sales.send_quotation(p["rep1"].id, small.id).status == "SENT"  # within limits goes straight out


@pytest.mark.django_db
def test_expiry_job_is_idempotent_and_revision_reopens(f):
    p = f["people"]
    a = q(f, valid_until=date.today() + timedelta(days=1))
    sales.send_quotation(p["rep1"].id, a.id)
    fresh = q(f, valid_until=date.today() + timedelta(days=60))
    sales.send_quotation(p["rep1"].id, fresh.id)
    later = date.today() + timedelta(days=5)
    assert quotes.expire_overdue(later) == 1 and quotes.expire_overdue(later) == 0
    a.refresh_from_db()
    assert a.status == "EXPIRED" and a.expired_at is not None
    assert sm.Quotation.objects.get(pk=fresh.id).status == "SENT"
    assert Notification.objects.filter(user_id=p["rep1"].id, notification_type="sales.quotation.expired").count() == 1
    with pytest.raises(DomainError):
        sales.accept_quotation(p["rep1"].id, a.id)
    r = quotes.revise(p["rep1"].id, a.id)
    assert r.status == "DRAFT" and r.expired_at is None


@pytest.mark.django_db
def test_document_is_escaped_and_scoped_and_opportunity_quote(f):
    p = f["people"]
    a = q(f, lines=[{**line(f), "description": "<script>alert(1)</script> widget"}], notes="line1\nline2 <b>")
    html = quotes.document(p["rep1"].id, a.id)
    assert "<script>" not in html and "&lt;script&gt;" in html and a.number in html and "line1<br>line2 &lt;b&gt;" in html
    with pytest.raises(DomainError):
        quotes.document(p["rep2"].id, a.id)
    from modules.sales import pricing

    pricing.create_list(p["sm"].id, name="Std", currency="USD", items=[{"product": f["widget"].id, "unit_price": "100"}])
    opp = crm.create_opportunity(p["rep1"].id, name="Deal", account_id=f["acct"].id, amount="500", currency="USD")
    with pytest.raises(ValidationFailed):
        quotes.from_opportunity(p["rep1"].id, opp.id)  # no product lines yet
    pipeline.set_lines(p["rep1"].id, opp.id, [{"product": f["widget"].id, "quantity": "3", "expected_price": "100"}])
    oq = quotes.from_opportunity(p["rep1"].id, opp.id, payment_terms="Net 15")
    assert oq.opportunity_id == opp.id and oq.total == 300 and oq.payment_terms == "Net 15"
    with pytest.raises(DomainError):
        quotes.from_opportunity(p["rep2"].id, opp.id)


@pytest.mark.django_db
def test_converting_an_approved_manager_price_quote_does_not_trip_the_override_guard(f):
    from modules.sales import pricing

    p = f["people"]
    pricing.create_list(p["sm"].id, name="Std", currency="USD", items=[{"product": f["widget"].id, "unit_price": "100"}])
    a = sales.create_quotation(p["sm"].id, account_id=f["acct"].id, currency="USD", lines=[line(f, price="90")])  # manager override
    sales.send_quotation(p["sm"].id, a.id)
    sales.accept_quotation(p["sm"].id, a.id)
    o = sales.convert_quotation(p["rep1"].id, a.id, order_date=D0)  # rep converts at the agreed price
    assert o.lines.get().unit_price == 90
