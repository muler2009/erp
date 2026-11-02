"""CRM pipeline and activities, part 2: opportunity detail, stage history, product lines, configurable stages,
forecast grouping, activity scheduling, calendars and overdue reminders."""
from collections import defaultdict
from datetime import datetime, timedelta
from decimal import Decimal, InvalidOperation

from django.db import IntegrityError, transaction
from django.db.models import Q
from django.utils import timezone

from modules.crm import models as m
from modules.crm import services as base
from modules.crm.services import _active_member, _own, scope
from platform_core.authorization import services as authz
from shared.api.errors import DomainError, ValidationFailed
from shared.notifications import services as notifications

PRIORITIES = ("LOW", "MEDIUM", "HIGH")


def _bad(msg, code="invalid_request"):
    return ValidationFailed(msg, code=code)


# ----------------------------------------------------------------------------- opportunity detail
DETAIL_FIELDS = ("competitors", "requirements", "decision_makers", "risks", "next_action", "next_action_date")


@transaction.atomic
def update_opportunity(actor_id, opp_id, *, name=None, amount=None, expected_close="__keep__", contact_id="__keep__", **detail):
    o = _own(m.Opportunity, opp_id, actor_id, "Opportunity", lock=True)
    if o.status != "OPEN":
        raise DomainError("A closed opportunity is read-only.", code="invalid_state_transition")
    if name is not None:
        if not name.strip():
            raise _bad("name is required.", "invalid_name")
        o.name = name.strip()
    if amount is not None:
        try:
            amt = Decimal(str(amount))
        except InvalidOperation:
            raise _bad("amount must be a number.", "invalid_amount")
        if amt < 0:
            raise _bad("amount cannot be negative.", "invalid_amount")
        o.amount = amt
    if expected_close != "__keep__":
        o.expected_close = expected_close
    if contact_id != "__keep__":
        o.contact = _own(m.Contact, contact_id, actor_id, "Contact") if contact_id else None
    for k in DETAIL_FIELDS:
        if k in detail and detail[k] is not None:
            setattr(o, k, detail[k] if k == "next_action_date" else str(detail[k]))
    o.save()
    return o


@transaction.atomic
def move_stage_tracked(actor_id, opp_id, stage_code, note=""):
    """Moves the opportunity and records the change. Stages can only move within the open stages; closing uses win/lose."""
    o = _own(m.Opportunity, opp_id, actor_id, "Opportunity", lock=True)
    if o.status != "OPEN":
        raise DomainError("A closed opportunity cannot change stage.", code="invalid_state_transition")
    st = base._stage(stage_code)
    if st.is_won or st.is_lost:
        raise _bad("Use win/lose to close an opportunity.", "invalid_stage")
    if st.id == o.stage_id:
        raise DomainError("The opportunity is already in this stage.", code="invalid_state_transition")
    m.StageChange.objects.create(opportunity=o, from_stage=o.stage.code, to_stage=st.code, actor_id=actor_id, note=note[:300])
    o.stage = st
    o.save(update_fields=["stage", "updated_at"])
    return o


def _log_close(opp, actor_id, note=""):
    m.StageChange.objects.create(opportunity=opp, from_stage="", to_stage=opp.stage.code, actor_id=actor_id, note=note[:300])


@transaction.atomic
def win(actor_id, opp_id):
    prev = m.Opportunity.objects.select_related("stage").get(pk=opp_id).stage.code if m.Opportunity.objects.filter(pk=opp_id).exists() else ""
    o = base.win_opportunity(actor_id, opp_id)
    m.StageChange.objects.create(opportunity=o, from_stage=prev, to_stage=o.stage.code, actor_id=actor_id, note="Won")
    return o


@transaction.atomic
def lose(actor_id, opp_id, reason):
    prev = m.Opportunity.objects.select_related("stage").get(pk=opp_id).stage.code if m.Opportunity.objects.filter(pk=opp_id).exists() else ""
    o = base.lose_opportunity(actor_id, opp_id, reason)
    m.StageChange.objects.create(opportunity=o, from_stage=prev, to_stage=o.stage.code, actor_id=actor_id, note=reason[:300])
    return o


def stage_history(user_id, opp_id):
    o = _own(m.Opportunity, opp_id, user_id, "Opportunity")
    return [{"from": c.from_stage, "to": c.to_stage, "at": c.at.isoformat(), "actor": str(c.actor_id) if c.actor_id else None, "note": c.note} for c in o.stage_changes.order_by("at")]


@transaction.atomic
def set_lines(actor_id, opp_id, lines):
    """Products the customer is considering. Replaces the list; the opportunity amount follows when `sync_amount`."""
    from modules.inventory.models import Product

    o = _own(m.Opportunity, opp_id, actor_id, "Opportunity", lock=True)
    if o.status != "OPEN":
        raise DomainError("A closed opportunity is read-only.", code="invalid_state_transition")
    rows, seen = [], set()
    for r in lines:
        p = Product.objects.filter(pk=r.get("product"), is_active=True).first()
        try:
            q, price = Decimal(str(r.get("quantity"))), Decimal(str(r.get("expected_price", 0)))
        except InvalidOperation:
            raise _bad("Quantity and price must be numbers.", "invalid_line")
        if p is None or q <= 0 or price < 0 or p.id in seen:
            raise _bad("Each line needs a distinct active product, a positive quantity and a non-negative price.", "invalid_line")
        seen.add(p.id)
        rows.append(m.OpportunityLine(opportunity=o, product=p, quantity=q, expected_price=price))
    o.lines.all().delete()
    m.OpportunityLine.objects.bulk_create(rows)
    return o


# ----------------------------------------------------------------------------- configurable stages
@transaction.atomic
def configure_stage(actor_id, code, *, name=None, position=None, probability=None):
    """Pipeline configuration is a manager job (crm.assign). Won and lost stages are fixed system stages."""
    if not authz.has_permission(actor_id, "crm.assign"):
        raise DomainError("Only sales managers can configure the pipeline.", code="permission_denied", status_code=403)
    code = (code or "").strip().upper()
    st = m.PipelineStage.objects.select_for_update().filter(code=code).first()
    if st is not None and (st.is_won or st.is_lost):
        raise DomainError("The won and lost stages are fixed.", code="stage_protected")
    if probability is not None and not 0 <= int(probability) <= 100:
        raise _bad("Probability is 0-100.", "invalid_probability")
    if st is None:
        if not code or not (name or "").strip() or position is None or probability is None:
            raise _bad("A new stage needs a code, name, position and probability.", "invalid_stage")
        return m.PipelineStage.objects.create(code=code[:30], name=name.strip()[:80], position=int(position), probability=int(probability))
    for f, v in (("name", name), ("position", position), ("probability", probability)):
        if v is not None:
            setattr(st, f, v)
    st.save()
    return st


@transaction.atomic
def retire_stage(actor_id, code):
    if not authz.has_permission(actor_id, "crm.assign"):
        raise DomainError("Only sales managers can configure the pipeline.", code="permission_denied", status_code=403)
    st = m.PipelineStage.objects.filter(code=code).first()
    if st is None:
        raise DomainError("Stage not found.", code="not_found", status_code=404)
    if st.is_won or st.is_lost:
        raise DomainError("The won and lost stages are fixed.", code="stage_protected")
    if st.opportunities.exists():
        raise DomainError("Move the opportunities out of this stage first.", code="stage_in_use")
    st.delete()


# ----------------------------------------------------------------------------- forecast
def forecast_by(user_id, group="owner"):
    """Open pipeline, total and weighted, grouped by owner, stage, product or month (per currency)."""
    if group not in ("owner", "stage", "product", "month"):
        raise _bad("group must be owner, stage, product or month.", "invalid_group")
    out = defaultdict(lambda: {"count": 0, "amount": Decimal(0), "weighted": Decimal(0)})
    for o in scope(m.Opportunity.objects.filter(status="OPEN").select_related("stage").prefetch_related("lines__product"), user_id):
        w = o.amount * o.stage.probability / 100
        if group == "product":
            lines = list(o.lines.all())
            total = sum((l.quantity * l.expected_price for l in lines), Decimal(0))
            for l in lines:  # spread the opportunity amount across its products by line value
                share = (l.quantity * l.expected_price / total) if total else Decimal(1) / len(lines)
                key = (l.product.sku, o.currency)
                out[key]["count"] += 1
                out[key]["amount"] += o.amount * share
                out[key]["weighted"] += w * share
            if not lines:
                key = ("(no products)", o.currency)
                out[key]["count"] += 1
                out[key]["amount"] += o.amount
                out[key]["weighted"] += w
            continue
        k = {"owner": str(o.owner_id), "stage": o.stage.code, "month": o.expected_close.strftime("%Y-%m") if o.expected_close else "unscheduled"}[group]
        row = out[(k, o.currency)]
        row["count"] += 1
        row["amount"] += o.amount
        row["weighted"] += w
    return [{"group": k[0], "currency": k[1], "count": v["count"], "amount": str(v["amount"].quantize(Decimal("0.01"))), "weighted": str(v["weighted"].quantize(Decimal("0.01")))} for k, v in sorted(out.items())]


# ----------------------------------------------------------------------------- activities
@transaction.atomic
def schedule_activity(actor_id, *, type, subject, due_at=None, notes="", priority="MEDIUM", assignee_id=None, lead_id=None, opportunity_id=None, account_id=None):
    if priority not in PRIORITIES:
        raise _bad("Priority must be LOW, MEDIUM or HIGH.", "invalid_priority")
    if assignee_id and assignee_id != actor_id:
        if not authz.has_permission(actor_id, "crm.assign"):
            raise DomainError("You cannot assign activities to other people.", code="permission_denied", status_code=403)
        if not _active_member(assignee_id):
            raise _bad("The assignee must be an active member.", "invalid_assignee")
    a = base.log_activity(actor_id, type=type, subject=subject, due_at=due_at, notes=notes, lead_id=lead_id, opportunity_id=opportunity_id, account_id=account_id)
    a.priority, a.assignee_id = priority, assignee_id or actor_id
    a.save(update_fields=["priority", "assignee_id", "updated_at"])
    if a.assignee_id != actor_id:
        notifications.notify([a.assignee_id], "crm.activity.assigned", f"New {a.type.lower()}: {a.subject}", ref_type="Activity", ref_id=a.id)
    return a


@transaction.atomic
def complete_with_outcome(actor_id, activity_id, outcome=""):
    a = m.Activity.objects.select_for_update().filter(pk=activity_id).first()
    if a is None or not (base.sees_all(actor_id) or actor_id in (a.owner_id, a.assignee_id)):
        raise DomainError("Activity not found.", code="not_found", status_code=404)
    if a.done_at:
        raise DomainError("This activity is already done.", code="invalid_state_transition")
    a.done_at, a.outcome = timezone.now(), outcome[:300]
    a.save()
    for rec in (a.opportunity, a.lead):
        if rec is not None and hasattr(rec, "last_activity_at"):
            rec.last_activity_at = a.done_at
            rec.save(update_fields=["last_activity_at", "updated_at"])
    return a


def my_activities(user_id, d_from=None, d_to=None, *, team=False):
    """Personal calendar (assigned to or owned by me); `team=True` shows everyone's when the user can see all."""
    qs = m.Activity.objects.all()
    if team:
        if not base.sees_all(user_id):
            raise DomainError("The team calendar is for sales managers.", code="permission_denied", status_code=403)
    else:
        qs = qs.filter(Q(assignee_id=user_id) | Q(owner_id=user_id, assignee_id__isnull=True))
    if d_from:
        qs = qs.filter(due_at__gte=d_from)
    if d_to:
        qs = qs.filter(due_at__lte=d_to)
    return qs.order_by("due_at")


def overdue(user_id, now=None):
    now = now or timezone.now()
    return my_activities(user_id, team=base.sees_all(user_id)).filter(done_at__isnull=True, due_at__lt=now)


def send_overdue_reminders(now=None):
    """Daily job: one reminder per overdue activity per day to its assignee. Idempotent within a day."""
    now = now or timezone.now()
    sent = 0
    for a in m.Activity.objects.filter(done_at__isnull=True, due_at__lt=now).filter(Q(reminded_at__isnull=True) | Q(reminded_at__lt=now - timedelta(hours=23))):
        who = a.assignee_id or a.owner_id
        notifications.notify([who], "crm.activity.overdue", f"Overdue: {a.subject}", f"Due {a.due_at:%Y-%m-%d %H:%M}", ref_type="Activity", ref_id=a.id)
        m.Activity.objects.filter(pk=a.pk).update(reminded_at=now)
        sent += 1
    return sent
