from datetime import date, timedelta
from decimal import Decimal as D

import pytest

from modules.hr import models as hm
from modules.hr import services as hr
from modules.sales import commissions as cx
from modules.sales import returns as rt
from modules.sales import services as sales
from platform_core.tenants.models import Tenant
from shared.api.errors import DomainError, ValidationFailed
from shared.tenancy import current_tenant
from tests.test_finance import user
from tests.test_sales import D0, confirmed, deliver, f, line  # noqa: F401

START, END = date(2026, 3, 1), date(2026, 3, 31)
TIERS = [{"from": "0", "rate": "2"}, {"from": "1000", "rate": "5"}]


def plan(f, **kw):
    p = f["people"]
    pl = cx.create_plan(p["sm"].id, "Standard", TIERS, **kw)
    cx.assign_plan(p["sm"].id, p["rep1"].id, pl.id)
    return pl


@pytest.mark.django_db
def test_plan_validation_targets_and_attainment(f):
    p = f["people"]
    for bad in ([], [{"from": "5", "rate": "1"}], [{"from": "0", "rate": "1"}, {"from": "0", "rate": "2"}], [{"from": "0", "rate": "101"}]):
        with pytest.raises(ValidationFailed):
            cx.create_plan(p["sm"].id, "Bad", bad)
    with pytest.raises(DomainError):
        cx.create_plan(p["rep1"].id, "Mine", TIERS)
    plan(f)
    confirmed(f, [line(f, qty="10", price="100")])  # D0 in March, 1000 net
    cx.set_target(p["sm"].id, p["rep1"].id, START, END, "2000")
    a = cx.attainment(p["rep1"].id, p["rep1"].id, START, END)
    assert (D(a["net_sales"]), a["attainment_percent"], D(a["remaining"])) == (1000, 50.0, 1000)
    with pytest.raises(DomainError):
        cx.attainment(p["rep2"].id, p["rep1"].id, START, END)
    with pytest.raises(DomainError):
        cx.set_target(p["rep1"].id, p["rep1"].id, START, END, "1")
    assert cx.team_attainment(p["sm"].id, START, END)[0]["owner_id"] == str(p["rep1"].id)


@pytest.mark.django_db
def test_tiered_commission_with_return_reversal_and_approval(f):
    p = f["people"]
    plan(f)
    o = confirmed(f, [line(f, qty="20", price="100")])  # 2000 net
    deliver(f, o)
    st = cx.calculate(p["sm"].id, p["rep1"].id, START, END)
    assert (st.sales_amount, st.returns_amount) == (2000, 0) and st.commission == D("70.00")  # 1000*2% + 1000*5%
    again = cx.calculate(p["sm"].id, p["rep1"].id, START, END)
    assert again.id == st.id  # a draft is recalculated, not duplicated
    rr = rt.request_return(p["rep1"].id, o.id, reason="faulty", lines=[{"order_line": o.lines.get().id, "quantity": "5"}], today=D0)
    rt.decide(p["sm"].id, rr.id, True)
    rt.receive(p["wh"].id, rr.id, location_id=f["loc_a"].id, return_date=D0)
    st = cx.calculate(p["sm"].id, p["rep1"].id, START, END)
    assert st.returns_amount == 500 and st.commission == D("45.00")  # net 1500 -> 1000*2% + 500*5%
    with pytest.raises(DomainError):
        cx.approve(p["rep1"].id, st.id)
    with pytest.raises(DomainError) as e:
        cx.calculate(p["sm"].id, p["rep2"].id, START, END)
    assert e.value.get_codes() == "no_plan"
    assert cx.statements(p["rep1"].id).count() == 0  # drafts are not visible to the rep
    st = cx.approve(p["sm"].id, st.id)
    assert cx.statements(p["rep1"].id).count() == 1 and cx.statements(p["rep2"].id).count() == 0
    with pytest.raises(DomainError):
        cx.calculate(p["sm"].id, p["rep1"].id, START, END)  # immutable once approved


@pytest.mark.django_db
def test_category_rate_and_transfer_to_hr_payroll_input(f):
    p = f["people"]
    tenant = Tenant.objects.get(pk=current_tenant().pk)
    hrm = user(tenant, f"hrm@{tenant.slug}.test", "hr_manager")
    hr.seed_defaults()
    pl = plan(f, category_rates={"Paint": "10"})
    f["paint"].category = "Paint"
    f["paint"].save()
    from modules.sales import pricing

    o = confirmed(f, [line(f, qty="10", price="50", product=f["paint"])])  # 500 in the Paint category
    st = cx.calculate(p["sm"].id, p["rep1"].id, START, END)
    assert st.commission == D("50.00") and st.details["Paint"]["rate"] == "10"
    with pytest.raises(DomainError):
        cx.transfer_to_payroll(p["sm"].id, st.id)  # not approved yet
    cx.approve(p["sm"].id, st.id)
    with pytest.raises(DomainError) as e:
        cx.transfer_to_payroll(p["sm"].id, st.id)  # rep1 is not an employee yet
    assert e.value.get_codes() == "no_employee"
    emp = hr.create_employee(hrm.id, first_name="Rep", last_name="One", hire_date=date(2026, 1, 5), user_id=p["rep1"].id)
    for item in emp.checklist.all():
        hr.complete_checklist_item(hrm.id, item.id)
    hr.activate_employee(hrm.id, emp.id)
    st, inp = cx.transfer_to_payroll(p["sm"].id, st.id)
    assert st.status == "TRANSFERRED" and inp.kind == "COMMISSION" and inp.amount == D("50.00") and inp.month == date(2026, 4, 1) and inp.status == "PENDING" and inp.employee_id == emp.id
    with pytest.raises(DomainError):
        cx.transfer_to_payroll(p["sm"].id, st.id)  # once only
