"""Sales teams, territories and portfolio access.  Team managers and leads see the records of their team (and sub-teams);
ownership changes are always logged."""
from collections import defaultdict

from django.db import transaction
from django.db.models import Count, Sum

from modules.crm import models as m
from platform_core.audit.services import record_tenant_event
from platform_core.authorization import services as authz
from shared.api.errors import DomainError, ValidationFailed
from shared.tenancy import current_tenant


def _manager(actor_id):
    if not authz.has_permission(actor_id, "crm.assign"):
        raise DomainError("Only a sales manager can manage teams and territories.", code="permission_denied", status_code=403)


# ----------------------------------------------------------------------------- visibility
def visible_owner_ids(user_id):
    """The user themself plus every member of the teams they manage or lead, including sub-teams."""
    ids = {user_id}
    roots = set(m.SalesTeam.objects.filter(manager_id=user_id, is_active=True).values_list("id", flat=True))
    roots |= set(m.TeamMember.objects.filter(user_id=user_id, is_lead=True, team__is_active=True).values_list("team_id", flat=True))
    if not roots:
        return ids
    children = defaultdict(list)
    for tid, pid in m.SalesTeam.objects.filter(is_active=True).values_list("id", "parent_id"):
        children[pid].append(tid)
    seen, stack = set(), list(roots)
    while stack:
        t = stack.pop()
        if t in seen:
            continue
        seen.add(t)
        stack.extend(children.get(t, []))
    ids |= set(m.TeamMember.objects.filter(team_id__in=seen).values_list("user_id", flat=True))
    ids |= set(m.SalesTeam.objects.filter(id__in=seen, manager_id__isnull=False).values_list("manager_id", flat=True))
    return ids


# ----------------------------------------------------------------------------- teams
@transaction.atomic
def create_team(actor_id, name, manager_id=None, parent_id=None):
    _manager(actor_id)
    if not (name or "").strip():
        raise ValidationFailed("A team needs a name.", code="invalid_team")
    parent = None
    if parent_id:
        parent = m.SalesTeam.objects.filter(pk=parent_id, is_active=True).first()
        if parent is None:
            raise DomainError("Parent team not found.", code="not_found", status_code=404)
    if m.SalesTeam.objects.filter(name=name.strip()).exists():
        raise ValidationFailed("A team with that name exists.", code="duplicate_team")
    return m.SalesTeam.objects.create(name=name.strip()[:100], manager_id=manager_id, parent=parent)


@transaction.atomic
def update_team(actor_id, team_id, *, manager_id="__keep__", parent_id="__keep__", is_active=None):
    _manager(actor_id)
    t = m.SalesTeam.objects.select_for_update().filter(pk=team_id).first()
    if t is None:
        raise DomainError("Team not found.", code="not_found", status_code=404)
    if parent_id != "__keep__":
        if parent_id:
            p = m.SalesTeam.objects.filter(pk=parent_id).first()
            node = p
            while node is not None:  # a team cannot sit under itself
                if node.id == t.id:
                    raise ValidationFailed("That would create a cycle in the team hierarchy.", code="hierarchy_cycle")
                node = node.parent
            t.parent = p
        else:
            t.parent = None
    if manager_id != "__keep__":
        t.manager_id = manager_id
    if is_active is not None:
        t.is_active = bool(is_active)
    t.save()
    return t


@transaction.atomic
def set_member(actor_id, team_id, user_id, is_lead=False):
    _manager(actor_id)
    from modules.crm.services import _active_member

    t = m.SalesTeam.objects.filter(pk=team_id, is_active=True).first()
    if t is None:
        raise DomainError("Team not found.", code="not_found", status_code=404)
    if not _active_member(user_id):
        raise ValidationFailed("The user must be an active member.", code="invalid_owner")
    tm, _ = m.TeamMember.objects.update_or_create(user_id=user_id, defaults={"team": t, "is_lead": bool(is_lead)})  # moving between teams is allowed
    return tm


def remove_member(actor_id, user_id):
    _manager(actor_id)
    n, _ = m.TeamMember.objects.filter(user_id=user_id).delete()
    if not n:
        raise DomainError("That person is not in a team.", code="not_found", status_code=404)


def tree(actor_id=None):
    teams = list(m.SalesTeam.objects.filter(is_active=True).order_by("name"))
    members = defaultdict(list)
    for tm in m.TeamMember.objects.all():
        members[tm.team_id].append({"user_id": str(tm.user_id), "is_lead": tm.is_lead})
    kids = defaultdict(list)
    for t in teams:
        kids[t.parent_id].append(t)

    def node(t):
        return {"id": str(t.id), "name": t.name, "manager_id": str(t.manager_id) if t.manager_id else None, "members": members.get(t.id, []), "children": [node(c) for c in kids.get(t.id, [])]}

    return [node(t) for t in kids.get(None, [])]


# ----------------------------------------------------------------------------- ownership history
def log_change(record_type, record_id, from_owner, to_owner, changed_by, reason=""):
    if from_owner != to_owner:
        m.OwnershipChange.objects.create(record_type=record_type, record_id=record_id, from_owner=from_owner, to_owner=to_owner, changed_by=changed_by, reason=reason[:200])


def ownership_history(user_id, record_type, record_id):
    from modules.crm import services as base

    model = {"account": m.CrmAccount, "lead": m.Lead, "opportunity": m.Opportunity}.get(record_type)
    if model is None:
        raise ValidationFailed("Unknown record type.", code="invalid_record_type")
    base._own(model, record_id, user_id, record_type.capitalize())
    return list(m.OwnershipChange.objects.filter(record_type=record_type, record_id=record_id).order_by("changed_at"))


# ----------------------------------------------------------------------------- territories
def _list(v):
    if v in (None, ""):
        return []
    if not isinstance(v, (list, tuple)) or not all(isinstance(x, str) and x.strip() for x in v):
        raise ValidationFailed("Criteria values must be lists of text.", code="invalid_territory")
    return [x.strip() for x in v]


def set_territory(actor_id, name, team_id, criteria, priority=100, is_active=True):
    _manager(actor_id)
    team = m.SalesTeam.objects.filter(pk=team_id, is_active=True).first()
    if team is None or not (name or "").strip():
        raise ValidationFailed("A name and an active team are required.", code="invalid_territory")
    bad = set(criteria or {}) - {"country", "industry", "segment"}
    if bad:
        raise ValidationFailed(f"Unknown criteria: {', '.join(sorted(bad))}.", code="invalid_territory")
    clean = {k: _list(v) for k, v in (criteria or {}).items() if _list(v)}
    clean["country"] = [c.upper() for c in clean.get("country", [])]
    if not clean["country"]:
        clean.pop("country")
    t, _ = m.Territory.objects.update_or_create(name=name.strip()[:100], defaults={"team": team, "criteria": clean, "priority": priority, "is_active": bool(is_active)})
    return t


def territory_for(account):
    countries = {a.country.upper() for a in account.addresses.all() if a.country}
    for t in m.Territory.objects.filter(is_active=True, team__is_active=True).select_related("team").order_by("priority", "name"):
        c = t.criteria
        if c.get("country") and not (countries & set(c["country"])):
            continue
        if c.get("industry") and account.industry not in c["industry"]:
            continue
        if c.get("segment") and account.segment not in c["segment"]:
            continue
        return t
    return None


def _load(user_ids):
    rows = m.CrmAccount.objects.filter(owner_id__in=user_ids, is_active=True).values("owner_id").annotate(n=Count("id"))
    load = {u: 0 for u in user_ids}
    for r in rows:
        load[r["owner_id"]] = r["n"]
    return load


@transaction.atomic
def assign_by_territory(actor_id, account_id):
    """Give the account to the least loaded member of the first matching territory's team."""
    _manager(actor_id)
    acct = m.CrmAccount.objects.select_for_update().filter(pk=account_id).first()
    if acct is None:
        raise DomainError("Account not found.", code="not_found", status_code=404)
    t = territory_for(acct)
    if t is None:
        raise DomainError("No territory matches this account.", code="no_territory", status_code=409)
    members = list(t.team.members.values_list("user_id", flat=True))
    if not members:
        raise DomainError("The matching territory's team has no members.", code="empty_team", status_code=409)
    load = _load(members)
    new = min(members, key=lambda u: (load[u], str(u)))
    old, acct.owner_id = acct.owner_id, new
    acct.save(update_fields=["owner_id", "updated_at"])
    log_change("account", acct.id, old, new, actor_id, f"territory {t.name}")
    record_tenant_event(current_tenant(), "crm.owner.changed", actor_user_id=actor_id, target_type="CrmAccount", target_id=acct.id, metadata={"from": str(old), "to": str(new), "territory": t.name})
    return acct, t


# ----------------------------------------------------------------------------- portfolios
@transaction.atomic
def transfer_portfolio(actor_id, from_user, to_user, reason):
    """Move every active account, open opportunity and open lead from one person to another (leaver or reorganisation)."""
    _manager(actor_id)
    from modules.crm.services import _active_member

    if not (reason or "").strip() or from_user == to_user:
        raise ValidationFailed("A reason and two different people are required.", code="invalid_transfer")
    if not _active_member(to_user):
        raise ValidationFailed("The receiving person must be an active member.", code="invalid_owner")
    counts = {}
    for kind, qs in (("account", m.CrmAccount.objects.filter(owner_id=from_user, is_active=True)), ("opportunity", m.Opportunity.objects.filter(owner_id=from_user, status="OPEN")), ("lead", m.Lead.objects.filter(owner_id=from_user, status__in=("NEW", "CONTACTED", "QUALIFIED")))):
        ids = list(qs.select_for_update().values_list("id", flat=True))
        for rid in ids:
            log_change(kind, rid, from_user, to_user, actor_id, reason)
        qs.model.objects.filter(id__in=ids).update(owner_id=to_user)
        counts[kind] = len(ids)
    record_tenant_event(current_tenant(), "crm.portfolio.transferred", actor_user_id=actor_id, target_type="User", target_id=from_user, metadata={"to": str(to_user), **{k: str(v) for k, v in counts.items()}})
    return counts


def portfolio(user_id):
    """Per person in the viewer's visible set: accounts, open opportunities and their value."""
    ids = visible_owner_ids(user_id) if not authz.has_permission(user_id, "crm.view_all") else None
    accts = m.CrmAccount.objects.filter(is_active=True)
    opps = m.Opportunity.objects.filter(status="OPEN")
    if ids is not None:
        accts, opps = accts.filter(owner_id__in=ids), opps.filter(owner_id__in=ids)
    out = defaultdict(lambda: {"accounts": 0, "open_opportunities": 0, "open_value": {}})
    for r in accts.values("owner_id").annotate(n=Count("id")):
        out[r["owner_id"]]["accounts"] = r["n"]
    for r in opps.values("owner_id", "currency").annotate(n=Count("id"), v=Sum("amount")):
        o = out[r["owner_id"]]
        o["open_opportunities"] += r["n"]
        o["open_value"][r["currency"]] = str(r["v"])
    return [{"owner_id": str(k), **v} for k, v in sorted(out.items(), key=lambda kv: -kv[1]["accounts"])]
