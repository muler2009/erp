from datetime import timedelta
from decimal import Decimal as D

import pytest

from modules.inventory import models as im
from modules.sales import models as sm
from modules.sales import pricing
from modules.sales import services as sales
from modules.crm import services as crm
from shared.api.errors import DomainError, ValidationFailed
from tests.test_sales import D0, f, line  # noqa: F401


def quote(f, who, lines, acct=None):
    return sales.create_quotation(f["people"][who].id, account_id=(acct or f["acct"]).id, currency="USD", lines=lines)


def code(exc):
    return exc.value.get_codes()


@pytest.mark.django_db
def test_precedence_contract_customer_promo_standard_and_account_isolation(f):
    p, w = f["people"], f["widget"]
    std = pricing.create_list(p["sm"].id, name="Std", currency="USD", items=[{"product": w.id, "unit_price": "100"}])
    today = D0
    promo = pricing.create_list(p["sm"].id, name="Promo", currency="USD", kind="PROMOTIONAL", valid_from=today - timedelta(days=1), valid_to=today + timedelta(days=5), items=[{"product": w.id, "unit_price": "90"}])
    other = crm.create_account(p["rep2"].id, name="Other")
    cust = pricing.create_list(p["sm"].id, name="Globex", currency="USD", kind="CUSTOMER", account_id=f["acct"].id, items=[{"product": w.id, "unit_price": "80"}])
    assert sales.price_for(w.id, "USD", D("1"), today) == D("90")  # promo beats standard
    assert sales.price_for(w.id, "USD", D("1"), today, f["acct"].id) == D("80")  # customer beats promo
    assert sales.price_for(w.id, "USD", D("1"), today, other.id) == D("90")  # never leaks to another customer
    assert sales.price_for(w.id, "USD", D("1"), today + timedelta(days=30)) == D("100")  # promo expired
    ct = pricing.create_list(p["sm"].id, name="Contract", currency="USD", kind="CONTRACT", account_id=f["acct"].id, valid_from=today, valid_to=today + timedelta(days=9), items=[{"product": w.id, "unit_price": "70"}])
    assert sales.price_for(w.id, "USD", D("1"), today, f["acct"].id) == D("70")
    pricing.set_list_active(p["sm"].id, ct.id, False)
    assert sales.price_for(w.id, "USD", D("1"), today, f["acct"].id) == D("80")
    q = sales.create_quotation(p["rep1"].id, account_id=f["acct"].id, currency="USD", lines=[{"product": w.id, "quantity": "1"}])
    assert q.lines.get().unit_price == D("80")
    for bad in (dict(kind="CUSTOMER"), dict(kind="PROMOTIONAL"), dict(kind="STANDARD", account_id=f["acct"].id), dict(kind="BOGUS")):
        with pytest.raises(ValidationFailed):
            pricing.create_list(p["sm"].id, name="x", currency="USD", items=[], **bad)
    with pytest.raises(DomainError):
        pricing.create_list(p["rep1"].id, name="x", currency="USD")


@pytest.mark.django_db
def test_price_history_is_recorded_for_every_change(f):
    p, w = f["people"], f["widget"]
    pl = pricing.create_list(p["sm"].id, name="Std", currency="USD", items=[{"product": w.id, "unit_price": "100"}])
    pricing.set_item_price(p["sm"].id, pl.id, w.id, "110")
    pricing.set_item_price(p["sm"].id, pl.id, w.id, "110")  # no change, no entry
    pricing.set_item_price(p["sm"].id, pl.id, w.id, "95", min_quantity=5)
    pricing.remove_item(p["sm"].id, pl.id, w.id, 5)
    h = [(c.old_price, c.new_price) for c in reversed(list(pricing.price_history(p["sm"].id, product_id=w.id)))]
    assert h == [(None, D("100")), (D("100"), D("110")), (None, D("95")), (D("95"), None)]
    with pytest.raises(DomainError):
        pricing.price_history(p["rep1"].id)
    with pytest.raises(DomainError):
        pricing.remove_item(p["sm"].id, pl.id, w.id, 77)


@pytest.mark.django_db
def test_override_discount_ceiling_and_price_floor_are_enforced_server_side(f):
    p, w = f["people"], f["widget"]
    pricing.create_list(p["sm"].id, name="Std", currency="USD", items=[{"product": w.id, "unit_price": "100"}])
    with pytest.raises(ValidationFailed) as e:  # rep supplies a cheaper price than the list
        quote(f, "rep1", [line(f, price="60")])
    assert code(e) == "price_override_denied"
    assert quote(f, "rep1", [line(f, price="100")]).total == D("1000")  # same price as the list is fine
    assert quote(f, "sm", [line(f, price="60")]).total == D("600")  # manager holds the override permission
    pricing.set_profile(p["sm"].id, w.id, max_discount_percent="15", min_price="85")
    pricing.set_discount_rule(p["sm"].id, "CLASSIFICATION", "VIP", "5")
    with pytest.raises(ValidationFailed) as e:
        quote(f, "rep1", [{"product": w.id, "quantity": "1", "discount_percent": "16"}])
    assert code(e) == "discount_limit_exceeded"
    with pytest.raises(ValidationFailed) as e:  # 100 - 14% = 86 passes the floor, 15% = 85 passes, so use a price list of 90 and 15%
        pricing.set_profile(p["sm"].id, w.id, min_price="90")
        quote(f, "rep1", [{"product": w.id, "quantity": "1", "discount_percent": "15"}])
    assert code(e) == "below_minimum_price"
    pricing.set_profile(p["sm"].id, w.id, min_price="0")
    assert quote(f, "rep1", [{"product": w.id, "quantity": "1", "discount_percent": "15"}]).total == D("85")
    crm.update_account  # classification ceiling
    from modules.crm import records

    records.update_account_profile(p["rep1"].id, f["acct"].id, classification="VIP")
    with pytest.raises(ValidationFailed) as e:
        quote(f, "rep1", [{"product": w.id, "quantity": "1", "discount_percent": "6"}])
    assert code(e) == "discount_limit_exceeded"
    assert quote(f, "sm", [{"product": w.id, "quantity": "1", "discount_percent": "40"}]).total == D("60")  # override holder may exceed
    for bad in ("-1", "abc"):
        with pytest.raises(ValidationFailed):
            pricing.set_profile(p["sm"].id, w.id, min_price=bad)
    with pytest.raises(DomainError):
        pricing.set_profile(p["rep1"].id, w.id, min_price="1")


@pytest.mark.django_db
def test_min_margin_over_average_cost(f):
    p, w = f["people"], f["widget"]  # stock was received at cost 5
    pricing.set_profile(p["sm"].id, w.id, min_margin_percent="50")
    with pytest.raises(ValidationFailed) as e:
        quote(f, "rep1", [line(f, price="7")])
    assert code(e) == "below_minimum_margin"
    assert quote(f, "rep1", [line(f, price="8")]).total == D("80")


@pytest.mark.django_db
def test_sellable_flag_default_tax_and_bundles(f):
    p, w, paint = f["people"], f["widget"], f["paint"]
    pricing.set_profile(p["sm"].id, paint.id, is_discontinued=True)
    with pytest.raises(ValidationFailed) as e:
        quote(f, "rep1", [line(f, product=paint)])
    assert code(e) == "not_sellable"
    assert paint.sku not in [c["sku"] for c in pricing.catalog()] and paint.sku in [c["sku"] for c in pricing.catalog(only_sellable=False)]
    pricing.set_profile(p["sm"].id, paint.id, is_discontinued=False)
    pricing.set_profile(p["sm"].id, w.id, default_tax_rate_id=f["vat_s"].id)
    q = quote(f, "rep1", [{"product": w.id, "quantity": "2", "unit_price": "100"}])
    assert q.lines.get().tax_rate_id == f["vat_s"].id and q.tax_total > 0
    pricing.create_list(p["sm"].id, name="Std", currency="USD", items=[{"product": w.id, "unit_price": "100"}, {"product": paint.id, "unit_price": "20"}])
    kit = im.Product.objects.create(sku="KIT-1", name="Starter kit", is_stocked=False)
    pricing.set_bundle(p["sm"].id, kit.id, [{"product": w.id, "quantity": "2"}, {"product": paint.id, "quantity": "1"}])
    q = quote(f, "rep1", [{"product": kit.id, "quantity": "3"}])
    assert sorted((l.product_id, l.quantity) for l in q.lines.all()) == sorted([(w.id, D("6")), (paint.id, D("3"))])
    for bad in ([], [{"product": kit.id, "quantity": "1"}], [{"product": w.id, "quantity": "0"}], [{"product": w.id, "quantity": "1"}, {"product": w.id, "quantity": "1"}]):
        with pytest.raises(ValidationFailed):
            pricing.set_bundle(p["sm"].id, kit.id, bad)
    assert any(c["is_bundle"] for c in pricing.catalog())
