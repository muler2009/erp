import pytest

from modules.crm import models as cm
from modules.crm import records, teams as tm
from modules.crm import services as crm
from shared.api.errors import DomainError, ValidationFailed
from tests.test_sales import f  # noqa: F401


@pytest.mark.django_db
def test_team_leads_and_managers_see_their_teams_records_only(f):
    p = f["people"]
    t = tm.create_team(p["sm"].id, "North", manager_id=p["sm2"].id)
    sub = tm.create_team(p["sm"].id, "North-East", parent_id=t.id)
    tm.set_member(p["sm"].id, t.id, p["rep1"].id)
    tm.set_member(p["sm"].id, sub.id, p["rep2"].id, is_lead=True)
    assert tm.visible_owner_ids(p["rep2"].id) == {p["rep2"].id}  # leading a sub-team with nobody else
    tm.update_team(p["sm"].id, sub.id, parent_id=None)
    tm.update_team(p["sm"].id, t.id, parent_id=sub.id)  # t under sub: fine
    with pytest.raises(ValidationFailed):
        tm.update_team(p["sm"].id, sub.id, parent_id=t.id)  # would close a cycle
    tm.update_team(p["sm"].id, t.id, parent_id=None)
    tm.update_team(p["sm"].id, sub.id, parent_id=t.id)
    # rep2 leads sub (child of t): sees sub's members only; rep1 sits in t, so it is not visible to a sub lead
    assert p["rep1"].id not in tm.visible_owner_ids(p["rep2"].id)
    tm.set_member(p["sm"].id, t.id, p["rep2"].id, is_lead=True)  # moving rep2 to t as lead
    assert {p["rep1"].id, p["rep2"].id} <= tm.visible_owner_ids(p["rep2"].id)
    assert crm._own(cm.CrmAccount, f["acct"].id, p["rep2"].id, "Account").id == f["acct"].id  # rep1's account via team lead
    assert crm.scope(cm.CrmAccount.objects.all(), p["rep2"].id).count() == 1
    tm.remove_member(p["sm"].id, p["rep2"].id)
    with pytest.raises(DomainError):
        crm._own(cm.CrmAccount, f["acct"].id, p["rep2"].id, "Account")
    with pytest.raises(DomainError):
        tm.create_team(p["rep1"].id, "X")
    with pytest.raises(ValidationFailed):
        tm.create_team(p["sm"].id, "North")


@pytest.mark.django_db
def test_territory_assignment_balances_load_and_logs_history(f):
    p = f["people"]
    team = tm.create_team(p["sm"].id, "Ethiopia", manager_id=p["sm"].id)
    tm.set_member(p["sm"].id, team.id, p["rep1"].id)
    tm.set_member(p["sm"].id, team.id, p["rep2"].id)
    tm.set_territory(p["sm"].id, "ET retail", team.id, {"country": ["et"], "industry": ["Retail"]}, priority=10)
    for bad in ({"colour": ["red"]}, {"country": "ET"}):
        with pytest.raises(ValidationFailed):
            tm.set_territory(p["sm"].id, "bad", team.id, bad)
    a = crm.create_account(p["rep1"].id, name="Shop", industry="Retail")
    with pytest.raises(DomainError) as e:
        tm.assign_by_territory(p["sm"].id, a.id)  # no address yet -> no match
    assert e.value.get_codes() == "no_territory"
    records.add_address(p["rep1"].id, a.id, kind="BILLING", line1="Bole Rd", country="ET")
    acct, terr = tm.assign_by_territory(p["sm"].id, a.id)
    assert acct.owner_id == p["rep2"].id and terr.name == "ET retail"  # rep1 already owns one account (Globex), rep2 none
    hist = tm.ownership_history(p["sm"].id, "account", a.id)
    assert [(h.from_owner, h.to_owner, h.reason) for h in hist] == [(p["rep1"].id, p["rep2"].id, "territory ET retail")]
    with pytest.raises(DomainError):
        tm.assign_by_territory(p["rep1"].id, a.id)
    crm.assign_owner(p["sm"].id, "account", a.id, p["rep1"].id)
    assert tm.ownership_history(p["sm"].id, "account", a.id)[-1].to_owner == p["rep1"].id


@pytest.mark.django_db
def test_portfolio_transfer_moves_everything_and_is_logged(f):
    p = f["people"]
    lead = crm.create_lead(p["rep1"].id, name="L1", auto_assign=False)
    opp = crm.create_opportunity(p["rep1"].id, name="O1", account_id=f["acct"].id, amount="100", currency="USD")
    pf = {r["owner_id"]: r for r in tm.portfolio(p["sm"].id)}
    assert pf[str(p["rep1"].id)]["accounts"] == 1 and pf[str(p["rep1"].id)]["open_opportunities"] == 1
    with pytest.raises(ValidationFailed):
        tm.transfer_portfolio(p["sm"].id, p["rep1"].id, p["rep2"].id, " ")
    with pytest.raises(DomainError):
        tm.transfer_portfolio(p["rep1"].id, p["rep1"].id, p["rep2"].id, "leaving")
    assert tm.transfer_portfolio(p["sm"].id, p["rep1"].id, p["rep2"].id, "leaving") == {"account": 1, "opportunity": 1, "lead": 1}
    assert cm.CrmAccount.objects.get(pk=f["acct"].id).owner_id == p["rep2"].id and cm.Lead.objects.get(pk=lead.id).owner_id == p["rep2"].id
    assert tm.ownership_history(p["sm"].id, "opportunity", opp.id)[0].reason == "leaving"
    with pytest.raises(DomainError):
        tm.ownership_history(p["rep1"].id, "account", f["acct"].id)  # no longer theirs
