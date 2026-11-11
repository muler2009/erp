from datetime import timedelta
from decimal import Decimal as D

import pytest

from modules.procurement import models as pm
from modules.supply_chain import delivery as dv
from tests.test_procurement import D0, approved_po, f, receive  # noqa: F401


@pytest.mark.django_db
def test_supplier_delivery_performance_and_lead_time_suggestions(f):
    sup = f["supplier"]
    pm.SupplierItem.objects.create(supplier=sup, product=f["widget"] if "widget" in f else approved_po(f, "1", "1").lines.first().product, unit_price=1, currency="USD", lead_time_days=2, valid_from=D0 - timedelta(days=30))
    # three orders placed on D0: the receipts (all dated D0 by the helper) are same-day, so move the order dates back to model a slow supplier
    pos = []
    for qty, expected_offset, ordered_back in (("10", 5, 10), ("10", -1, 10), ("5", 5, 10)):
        po = approved_po(f, qty, "10")
        po.expected_date = D0 + timedelta(days=expected_offset)
        po.order_date = D0 - timedelta(days=ordered_back)
        po.save(update_fields=["expected_date", "order_date"])
        pos.append(po)
    receive(f, pos[0], "10")
    receive(f, pos[1], "10")
    receive(f, pos[2], "3")  # short delivery
    row = dv.supplier_delivery_performance(D0 - timedelta(days=11), D0)[0]
    assert row["orders"] == 3 and row["on_time_pct"] == "66.67" and row["in_full_pct"] == "66.67" and row["avg_days_late"] == "1.00"
    assert row["actual_lead_days"] == "10.00"
    sug = dv.lead_time_suggestions(D0 - timedelta(days=11), D0)
    assert len(sug) == 1 and sug[0]["suggested_lead_days"] == 10
    assert dv.lead_time_suggestions(D0 - timedelta(days=11), D0, min_orders=4) == []
    assert dv.supplier_delivery_performance(D0 + timedelta(days=50), D0 + timedelta(days=60)) == []
