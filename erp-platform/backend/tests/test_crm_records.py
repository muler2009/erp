from datetime import date, timedelta

import pytest

from modules.crm import models as cm
from modules.crm import records as rec
from modules.crm import services as crm
from modules.sales import services as sales
from shared.api.errors import DomainError, ValidationFailed
from tests.test_sales import D0, f, line, order  # noqa: F401


@pytest.mark.django_db
def test_lead_qualification_data_and_validation(f):
    p = f["people"]
    l = rec.create_lead_checked(p["rep1"].id, name="Abel T", company="Zeta Ltd", email="abel@zeta.com", auto_assign=False, details={"priority": "HIGH", "qualification": "HOT", "budget": "5000", "currency": "USD", "industry": "Retail", "follow_up_date": D0})
    assert (l.priority, l.qualification, str(l.budget), l.currency, l.follow_up_date) == ("HIGH", "HOT", "5000", "USD", D0)
    for bad in ({"priority": "URGENT"}, {"qualification": "LUKEWARM"}, {"budget": "-1"}, {"currency": "ZZZ"}):
        with pytest.raises(ValidationFailed):
            rec.update_lead(p["rep1"].id, l.id, **bad)
    assert rec.update_lead(p["rep1"].id, l.id, priority="LOW", interests="ERP").priority == "LOW"
    with pytest.raises(DomainError):
        rec.update_lead(p["rep2"].id, l.id, priority="LOW")  # not the owner → hidden
    assert rec.update_lead(p["sm"].id, l.id, industry="Wholesale").industry == "Wholesale"


@pytest.mark.django_db
def test_duplicates_are_detected_and_merge_keeps_history(f):
    p = f["people"]
    a = rec.create_lead_checked(p["rep1"].id, name="Sara K", company="Acme", email="Sara@Acme.com", phone="+251 911 223344", auto_assign=False)
    with pytest.raises(DomainError) as x:
        rec.create_lead_checked(p["rep1"].id, name="S Kebede", email="sara@acme.com", auto_assign=False)
    assert x.value.get_codes() == "possible_duplicate"
    with pytest.raises(DomainError):
        rec.create_lead_checked(p["rep1"].id, name="Other", phone="0911223344", auto_assign=False)  # same phone, other prefix
    b = rec.create_lead_checked(p["rep1"].id, name="Sara Kebede", email="sara@acme.com", auto_assign=False, allow_duplicate=True, details={"priority": "HIGH", "industry": "Food"})
    crm.log_activity(p["rep1"].id, type="CALL", subject="Intro call", lead_id=b.id)
    d = rec.find_lead_duplicates(p["rep1"].id, email="sara@acme.com")
    assert {x["id"] for x in d["leads"]} == {str(a.id), str(b.id)}
    keep = rec.merge_leads(p["rep1"].id, a.id, b.id)
    assert keep.priority == "HIGH" and keep.industry == "Food" and keep.activities.count() == 1
    b.refresh_from_db()
    assert b.status == "MERGED" and b.merged_into_id == a.id
    with pytest.raises(DomainError):
        rec.merge_leads(p["rep1"].id, a.id, b.id)
    with pytest.raises(ValidationFailed):
        rec.merge_leads(p["rep1"].id, a.id, a.id)
    with pytest.raises(DomainError):
        crm.set_lead_status(p["rep1"].id, b.id, "CONTACTED")  # a merged lead is out of the pipeline
    assert rec.find_lead_duplicates(p["rep2"].id, email="sara@acme.com")["leads"] == []  # others' leads stay private


@pytest.mark.django_db
def test_import_is_all_or_nothing_and_flags_duplicates(f):
    p = f["people"]
    crm.create_lead(p["rep1"].id, name="Existing", email="old@x.com", auto_assign=False)
    rows = rec.parse_csv("name,company,email,phone,priority,budget\nNew One,Co,new@x.com,0911000001,high,100\nOld Dup,Co,OLD@x.com,,,\n,NoName,n@x.com,,,\nBad,Co,b@x.com,,urgent,abc\nSame,Co,new@x.com,,,\n")
    res = rec.import_leads(p["rep1"].id, rows, dry_run=False)
    assert res["valid"] is False and res["created"] == 0
    errs = {e["row"]: e["errors"] for e in res["errors"]}
    assert "duplicate of an existing lead" in errs[2] and "name is required" in errs[3] and "invalid priority" in errs[4] and "invalid budget" in errs[4] and "duplicate inside the file" in errs[5]
    assert cm.Lead.objects.count() == 1  # nothing was created
    good = rows[:1]
    dry = rec.import_leads(p["rep1"].id, good)
    assert dry["valid"] is True and dry["dry_run"] is True and cm.Lead.objects.count() == 1
    done = rec.import_leads(p["rep1"].id, good, dry_run=False, source="EXPO")
    assert done["created"] == 1
    l = cm.Lead.objects.get(email="new@x.com")
    assert l.source == "EXPO" and l.priority == "HIGH" and l.budget == 100
    with pytest.raises(ValidationFailed):
        rec.import_leads(p["rep1"].id, [{"name": f"n{i}"} for i in range(501)])


@pytest.mark.django_db
def test_account_hierarchy_addresses_credit_and_history(f):
    p = f["people"]
    hq = crm.create_account(p["rep1"].id, name="HQ Group")
    br = crm.create_account(p["rep1"].id, name="Branch Co")
    rec.update_account_profile(p["rep1"].id, br.id, parent_id=hq.id, customer_type="BUSINESS", classification="A")
    with pytest.raises(DomainError) as x:
        rec.update_account_profile(p["rep1"].id, hq.id, parent_id=br.id)
    assert x.value.get_codes() == "hierarchy_cycle"
    with pytest.raises(DomainError):
        rec.update_account_profile(p["rep1"].id, hq.id, parent_id=hq.id)
    with pytest.raises(ValidationFailed):
        rec.update_account_profile(p["rep1"].id, hq.id, customer_type="ALIEN")
    a1 = rec.add_address(p["rep1"].id, hq.id, kind="BILLING", line1="1 Main St", country="et")
    a2 = rec.add_address(p["rep1"].id, hq.id, kind="BILLING", line1="2 Side St", is_default=True)
    a1.refresh_from_db()
    assert a1.is_default is False and a2.is_default and a1.country == "ET"
    rec.delete_address(p["rep1"].id, a2.id)
    a1.refresh_from_db()
    assert a1.is_default is True  # the next one takes over
    with pytest.raises(ValidationFailed):
        rec.add_address(p["rep1"].id, hq.id, kind="MOON", line1="x")
    with pytest.raises(DomainError):
        rec.delete_address(p["rep2"].id, a1.id)
    with pytest.raises(DomainError) as x:
        rec.set_credit(p["rep1"].id, hq.id, credit_status="BLOCKED", note="late")  # reps cannot
    assert x.value.get_codes() == "permission_denied"
    with pytest.raises(ValidationFailed):
        rec.set_credit(p["sm"].id, hq.id, credit_status="ON_HOLD")  # note required
    acc = rec.set_credit(p["sm"].id, hq.id, credit_status="ON_HOLD", note="Overdue invoices", credit_limit="20000")
    assert acc.credit_status == "ON_HOLD" and acc.credit_limit == 20000 and acc.restriction_note
    assert rec.set_credit(p["sm"].id, hq.id, credit_status="OK").restriction_note == ""
    fields = list(hq.history.order_by("at").values_list("field", flat=True))
    assert fields.count("credit_status") == 2 and "credit_limit" in fields
    br.refresh_from_db()
    assert [c.name for c in br.parent.children.all()] == ["Branch Co"]


@pytest.mark.django_db
def test_contact_roles_links_consent_and_dates(f):
    p = f["people"]
    a1 = crm.create_account(p["rep1"].id, name="One")
    a2 = crm.create_account(p["rep1"].id, name="Two")
    c = crm.create_contact(p["rep1"].id, first_name="Dawit", account_id=a1.id)
    rec.update_contact(p["rep1"].id, c.id, role="DECISION_MAKER", preferred_channel="EMAIL", job_title="CFO")
    with pytest.raises(ValidationFailed):
        rec.update_contact(p["rep1"].id, c.id, role="BOSS")
    with pytest.raises(ValidationFailed):
        rec.update_contact(p["rep1"].id, c.id, preferred_channel="FAX")
    rec.link_contact(p["rep1"].id, c.id, a2.id, "Advisor")
    rec.link_contact(p["rep1"].id, c.id, a2.id, "Consultant")  # idempotent, updates the role
    assert c.links.get().role == "Consultant"
    assert rec.can_contact(c, "EMAIL") is False  # no consent recorded = no contact
    c = rec.set_consent(p["rep1"].id, c.id, email=True, sms=True)
    assert rec.can_contact(c, "EMAIL") and rec.can_contact(c, "SMS") and not rec.can_contact(c, "PHONE")
    rec.set_consent(p["rep1"].id, c.id, opt_out=True)
    c.refresh_from_db()
    assert not rec.can_contact(c, "EMAIL") and c.consent_email is False and c.opted_out_at
    with pytest.raises(ValidationFailed):
        rec.can_contact(c, "PIGEON")
    with pytest.raises(DomainError):
        rec.set_consent(p["rep2"].id, c.id, email=True)
    soon = date.today() + timedelta(days=10)
    rec.add_contact_date(p["rep1"].id, c.id, label="Birthday", on_date=soon.replace(year=1985), remind_days_before=3)
    up = rec.upcoming_contact_dates(p["rep1"].id)
    assert up[0]["label"] == "Birthday" and up[0]["date"] == str(soon) and up[0]["remind_on"] == str(soon - timedelta(days=3))
    assert rec.upcoming_contact_dates(p["rep2"].id) == []


@pytest.mark.django_db
def test_unified_timeline_collects_every_interaction(f):
    p = f["people"]
    acct = f["acct"]
    crm.log_activity(p["rep1"].id, type="MEETING", subject="Kick-off", account_id=acct.id)
    opp = crm.create_opportunity(p["rep1"].id, name="Big deal", account_id=acct.id, amount="1000", currency="USD")
    o = order(f)
    rec.update_account_profile(p["rep1"].id, acct.id, classification="B")
    tl = rec.account_timeline(p["rep1"].id, acct.id)
    kinds = {e["kind"] for e in tl}
    assert {"activity", "opportunity", "order", "change"} <= kinds
    assert tl == sorted(tl, key=lambda e: e["at"], reverse=True)
    assert any(o.number in e["summary"] for e in tl)
    with pytest.raises(DomainError):
        rec.account_timeline(p["rep2"].id, acct.id)  # not their account
    assert rec.account_timeline(p["sm"].id, acct.id)
