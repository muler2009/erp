"""Depreciation and valuation. Register values are kept in base currency and every movement is an immutable value entry
backed by a Finance journal, so the register reconciles to accounts 1500 (cost) and 1590 (accumulated depreciation and impairment).

Depreciation is prospective (IAS 16 style): each month's charge is derived from the asset's current carrying amount, so
improvements, impairments, revaluations and policy changes simply change the following charges.
"""
import calendar
from datetime import date
from decimal import ROUND_HALF_UP, Decimal

from django.db import IntegrityError, transaction
from django.db.models import Sum

from modules.assets import models as m
from modules.assets import services as svc
from platform_core.audit.services import record_tenant_event
from shared.api.errors import DomainError, ValidationFailed
from shared.events import services as events
from shared.tenancy import current_tenant

ZERO = Decimal("0")


def _fin():
    from modules.finance import services as finance

    return finance


def _q(v):
    return _fin()._q(v, _fin().base_currency().decimals)


def nbv(a):
    return a.gross_value - a.accumulated_depreciation - a.impairment_total


def monthly_charge(gross, acc, imp, residual, method, life, done, rate):
    """Charge for the next month given the current state; never takes the carrying amount below residual value."""
    carrying = gross - acc - imp
    depreciable = carrying - residual
    if method == "NON" or depreciable <= 0 or done >= life:
        return ZERO
    remaining = life - done
    if method == "SL":
        charge = depreciable if remaining <= 1 else depreciable / remaining
    else:  # RB
        charge = carrying * (rate or ZERO) / 100 / 12
        if remaining <= 1:
            charge = depreciable
    return min(_q(charge), depreciable)


def _month_end(y, mth):
    return date(y, mth, calendar.monthrange(y, mth)[1])


def _months_between(start, y, mth):
    return (y - start.year) * 12 + mth - start.month + 1


# ----------------------------------------------------------------------------- schedule
def schedule(asset_id, *, limit=600):
    a = svc._get(asset_id)
    if not a.is_capitalized:
        raise DomainError("Only a capitalized asset has a depreciation schedule.", code="not_capitalized")
    gross, acc, imp, done = a.gross_value, a.accumulated_depreciation, a.impairment_total, a.depreciated_months
    first = a.depreciation_start
    y, mth = first.year, first.month
    # next unposted month
    y, mth = (first.year + (first.month - 1 + done) // 12, (first.month - 1 + done) % 12 + 1)
    rows = []
    while len(rows) < limit:
        c = monthly_charge(gross, acc, imp, a.residual_value, a.depreciation_method, a.useful_life_months, done, a.reducing_rate_percent)
        if c <= 0:
            break
        acc += c
        done += 1
        q4 = lambda v: str(v.quantize(Decimal("0.0001")))
        rows.append({"period": f"{y:04d}-{mth:02d}", "charge": q4(c), "accumulated": q4(acc + imp), "nbv": q4(gross - acc - imp)})
        y, mth = (y + 1, 1) if mth == 12 else (y, mth + 1)
    return rows


# ----------------------------------------------------------------------------- monthly run
@transaction.atomic
def run_depreciation(actor_id, year, month):
    fin = _fin()
    if not 1 <= month <= 12:
        raise ValidationFailed("month must be 1-12.", code="invalid_period")
    end = _month_end(year, month)
    last = m.DepreciationRun.objects.select_for_update().filter(status="POSTED").order_by("-year", "-month").first()
    if last:
        if (year, month) <= (last.year, last.month):
            raise DomainError(f"Depreciation for {year}-{month:02d} was already posted (latest run is {last.year}-{last.month:02d}).", code="already_run")
        nxt = (last.year + 1, 1) if last.month == 12 else (last.year, last.month + 1)
        if (year, month) != nxt:
            raise DomainError(f"Run depreciation in sequence: the next period is {nxt[0]}-{nxt[1]:02d}.", code="run_out_of_sequence")
    assets = m.Asset.objects.select_for_update().filter(is_capitalized=True, depreciation_start__lte=end).exclude(status="DISPOSED").exclude(depreciation_method="NON").order_by("number")
    plan, total = [], ZERO
    for a in assets:
        missing = _months_between(a.depreciation_start, year, month) - a.depreciated_months
        if missing <= 0:
            continue
        gross, acc, imp, done = a.gross_value, a.accumulated_depreciation, a.impairment_total, a.depreciated_months
        before, charged = gross - acc - imp, ZERO
        for _ in range(missing):
            c = monthly_charge(gross, acc, imp, a.residual_value, a.depreciation_method, a.useful_life_months, done, a.reducing_rate_percent)
            acc += c
            charged += c
            done += 1
        if charged > 0 or missing > 0:
            plan.append((a, missing, charged, before))
            total += charged
    if not plan or total <= 0:
        raise DomainError("No asset has depreciation to post for this period.", code="nothing_to_depreciate")
    entry = fin.post_system_journal(actor_id, end, f"Depreciation {year}-{month:02d}", "asset_depreciation", f"{year}-{month:02d}", [("depreciation_expense", "debit", total), ("accumulated_depreciation", "credit", total)])
    try:
        with transaction.atomic():
            run = m.DepreciationRun.objects.create(year=year, month=month, total_amount=total, asset_count=len([p for p in plan if p[2] > 0]), journal_entry_id=entry.id, run_by=actor_id)
    except IntegrityError:
        raise DomainError("Depreciation for this period was posted by someone else.", code="already_run")
    for a, missing, charged, before in plan:
        a.accumulated_depreciation += charged
        a.depreciated_months += missing
        a.save(update_fields=["accumulated_depreciation", "depreciated_months", "updated_at"])
        m.DepreciationLine.objects.create(run=run, asset=a, months=missing, amount=charged, nbv_before=before, nbv_after=nbv(a))
        if charged > 0:
            m.AssetValueEntry.objects.create(asset=a, entry_date=end, kind="DEPRECIATION", depreciation_delta=charged, ref=f"{year}-{month:02d}", journal_entry_id=entry.id)
    record_tenant_event(current_tenant(), "assets.depreciation.posted", actor_user_id=actor_id, target_type="DepreciationRun", target_id=run.id, metadata={"period": f"{year}-{month:02d}", "total": str(total)})
    events.emit("assets.depreciation.posted", {"run_id": str(run.id), "period": f"{year}-{month:02d}", "total": str(total)}, dedup_key=f"depreciation-{year}-{month:02d}-{run.id}")
    return run


@transaction.atomic
def reverse_run(actor_id, run_id, *, reason):
    fin = _fin()
    run = m.DepreciationRun.objects.select_for_update().filter(pk=run_id).first()
    if run is None:
        raise DomainError("Run not found.", code="not_found", status_code=404)
    if run.status != "POSTED":
        raise DomainError("This run was already reversed.", code="invalid_state")
    if not (reason or "").strip():
        raise ValidationFailed("A reason is required.", code="reason_required")
    latest = m.DepreciationRun.objects.filter(status="POSTED").order_by("-year", "-month").first()
    if latest.id != run.id:
        raise DomainError("Only the latest depreciation run can be reversed.", code="not_latest")
    end = _month_end(run.year, run.month)
    lines = list(run.lines.select_related("asset"))
    if any(l.asset.status == "DISPOSED" for l in lines):
        raise DomainError("An asset in this run has been disposed; reverse the disposal first.", code="asset_disposed")
    entry = fin.post_system_journal(actor_id, end, f"Reversal of depreciation {run.year}-{run.month:02d}", "asset_depreciation_reversal", f"{run.year}-{run.month:02d}", [("accumulated_depreciation", "debit", run.total_amount), ("depreciation_expense", "credit", run.total_amount)])
    for l in lines:
        a = m.Asset.objects.select_for_update().get(pk=l.asset_id)
        a.accumulated_depreciation -= l.amount
        a.depreciated_months -= l.months
        a.save(update_fields=["accumulated_depreciation", "depreciated_months", "updated_at"])
        if l.amount > 0:
            m.AssetValueEntry.objects.create(asset=a, entry_date=end, kind="DEPRECIATION_REVERSAL", depreciation_delta=-l.amount, ref=f"{run.year}-{run.month:02d}", journal_entry_id=entry.id)
    run.status, run.reversed_by, run.reversal_reason, run.reversal_entry_id = "REVERSED", actor_id, reason[:300], entry.id
    run.save()
    record_tenant_event(current_tenant(), "assets.depreciation.reversed", actor_user_id=actor_id, target_type="DepreciationRun", target_id=run.id, metadata={"period": f"{run.year}-{run.month:02d}", "reason": reason[:200]})
    return run


# ----------------------------------------------------------------------------- improvements, revaluation, impairment
@transaction.atomic
def request_adjustment(actor_id, asset_id, *, kind, amount, effective_date, reason, extend_life_months=0):
    a = svc._get(asset_id, lock=True)
    if kind not in ("IMPROVEMENT", "REVALUATION", "IMPAIRMENT"):
        raise ValidationFailed("kind must be IMPROVEMENT, REVALUATION or IMPAIRMENT.", code="invalid_kind")
    if not a.is_capitalized or a.status in ("DISPOSED",):
        raise DomainError("Only a capitalized, undisposed asset can be adjusted.", code="not_capitalized")
    amt = svc._dec(amount, "amount")
    if amt < 0 or (amt == 0 and kind != "REVALUATION"):
        raise ValidationFailed("The amount must be positive.", code="invalid_amount")
    if not (reason or "").strip():
        raise ValidationFailed("A reason is required.", code="reason_required")
    if kind == "IMPAIRMENT" and amt > nbv(a):
        raise ValidationFailed("An impairment cannot exceed the asset's net book value.", code="exceeds_nbv")
    if kind == "REVALUATION" and amt < a.residual_value:
        raise ValidationFailed("The revalued carrying amount cannot be below the residual value.", code="below_residual")
    if m.ValuationAdjustment.objects.filter(asset=a, status="REQUESTED").exists():
        raise DomainError("This asset already has a pending adjustment.", code="already_pending")
    adj = m.ValuationAdjustment.objects.create(asset=a, kind=kind, amount=amt, effective_date=effective_date, reason=reason[:300], extend_life_months=int(extend_life_months or 0), requested_by=actor_id)
    svc.log(a, f"{kind}_REQUESTED", actor_id=actor_id, amount=amt, reason=reason)
    return adj


@transaction.atomic
def decide_adjustment(actor_id, adjustment_id, *, approve, note=""):
    fin = _fin()
    adj = m.ValuationAdjustment.objects.select_for_update().filter(pk=adjustment_id).first()
    if adj is None:
        raise DomainError("Adjustment not found.", code="not_found", status_code=404)
    if adj.status != "REQUESTED":
        raise DomainError("Only a requested adjustment can be decided.", code="invalid_state")
    if adj.requested_by == actor_id:
        raise DomainError("Separation of duties: someone else must approve the adjustment.", code="separation_of_duties", status_code=403)
    if not approve:
        if not (note or "").strip():
            raise ValidationFailed("A reason is required to reject.", code="reason_required")
        adj.status, adj.decided_by, adj.decision_note = "REJECTED", actor_id, note[:300]
        adj.save()
        return adj
    a = svc._get(adj.asset_id, lock=True)
    if a.status == "DISPOSED":
        raise DomainError("The asset has been disposed.", code="asset_disposed")
    d, amt = adj.effective_date, _q(adj.amount)
    legs, gross_d, imp_d, surplus_d = [], ZERO, ZERO, ZERO
    if adj.kind == "IMPROVEMENT":
        gross_d = amt
        legs = [("fixed_assets", "debit", amt), ("asset_clearing", "credit", amt)]
    elif adj.kind == "IMPAIRMENT":
        if amt > nbv(a):
            raise ValidationFailed("An impairment cannot exceed the asset's net book value.", code="exceeds_nbv")
        imp_d = amt
        legs = [("impairment_loss", "debit", amt), ("accumulated_depreciation", "credit", amt)]
    else:  # REVALUATION to a new carrying amount
        delta = amt - nbv(a)
        if delta > 0:
            gross_d, surplus_d = delta, delta
            legs = [("fixed_assets", "debit", delta), ("revaluation_surplus", "credit", delta)]
        elif delta < 0:
            down = -delta
            from_surplus = min(down, a.revaluation_surplus)
            loss = down - from_surplus
            imp_d, surplus_d = down, -from_surplus
            legs = [("revaluation_surplus", "debit", from_surplus), ("impairment_loss", "debit", loss), ("accumulated_depreciation", "credit", down)]
    entry = fin.post_system_journal(actor_id, d, f"{adj.kind.title()} of {a.number}", f"asset_{adj.kind.lower()}", adj.id, legs)
    a.gross_value += gross_d
    a.impairment_total += imp_d
    a.revaluation_surplus += surplus_d
    if adj.kind == "IMPROVEMENT":
        a.capitalized_cost += adj.amount
        a.useful_life_months += adj.extend_life_months
    a.version += 1
    a.save()
    m.AssetValueEntry.objects.create(asset=a, entry_date=d, kind=adj.kind, gross_delta=gross_d, impairment_delta=imp_d, surplus_delta=surplus_d, ref=str(adj.id)[:8], journal_entry_id=entry.id if entry else None)
    adj.status, adj.decided_by, adj.journal_entry_id = "APPROVED", actor_id, entry.id if entry else None
    adj.save()
    svc.log(a, f"{adj.kind}_POSTED", actor_id=actor_id, amount=adj.amount, nbv=nbv(a))
    return adj


@transaction.atomic
def change_policy(actor_id, asset_id, *, reason, useful_life_months=None, residual_value=None, method=None, reducing_rate_percent=None, depreciation_start=None):
    """Prospective change of the asset's depreciation parameters; past charges stay as posted."""
    a = svc._get(asset_id, lock=True)
    if not a.is_capitalized:
        raise DomainError("Only a capitalized asset has a depreciation policy.", code="not_capitalized")
    if not (reason or "").strip():
        raise ValidationFailed("A reason is required.", code="reason_required")
    old = (a.useful_life_months, a.residual_value, a.depreciation_method, a.reducing_rate_percent)
    if useful_life_months is not None:
        if int(useful_life_months) < a.depreciated_months or int(useful_life_months) <= 0:
            raise ValidationFailed("The useful life cannot be shorter than the months already depreciated.", code="invalid_life")
        a.useful_life_months = int(useful_life_months)
    if residual_value is not None:
        r = svc._dec(residual_value, "residual_value")
        if r < 0 or r > nbv(a):
            raise ValidationFailed("Residual value must be between zero and the net book value.", code="invalid_residual")
        a.residual_value = r
    if method is not None:
        if method not in ("SL", "RB", "NON"):
            raise ValidationFailed("Method must be SL, RB or NON.", code="invalid_method")
        a.depreciation_method = method
    if reducing_rate_percent is not None:
        a.reducing_rate_percent = svc._dec(reducing_rate_percent, "rate")
    if a.depreciation_method == "RB" and not a.reducing_rate_percent:
        raise ValidationFailed("Reducing-balance needs an annual rate.", code="rate_required")
    if depreciation_start is not None:
        if a.depreciated_months:
            raise DomainError("The start date cannot change once depreciation has been posted.", code="start_locked")
        a.depreciation_start = depreciation_start.replace(day=1)
    a.version += 1
    a.save()
    svc.log(a, "DEPRECIATION_POLICY_CHANGED", actor_id=actor_id, note=reason, old=old, new=(a.useful_life_months, a.residual_value, a.depreciation_method, a.reducing_rate_percent))
    return a


# ----------------------------------------------------------------------------- reports and reconciliation
def valuation_report(as_of=None, category_id=None):
    qs = m.AssetValueEntry.objects.all()
    if as_of:
        qs = qs.filter(entry_date__lte=as_of)
    if category_id:
        qs = qs.filter(asset__category_id=category_id)
    rows = {}
    for r in qs.values("asset_id", "asset__number", "asset__name", "asset__category__code").annotate(g=Sum("gross_delta"), d=Sum("depreciation_delta"), i=Sum("impairment_delta")):
        gross, dep, imp = r["g"] or ZERO, r["d"] or ZERO, r["i"] or ZERO
        rows[r["asset_id"]] = {"asset": r["asset__number"], "name": r["asset__name"], "category": r["asset__category__code"], "gross_value": str(gross), "accumulated_depreciation": str(dep), "impairment": str(imp), "net_book_value": str(gross - dep - imp)}
    out = sorted(rows.values(), key=lambda r: r["asset"])
    tot = lambda k: str(sum((Decimal(r[k]) for r in out), ZERO))
    return {"as_of": None if not as_of else str(as_of), "rows": out, "totals": {"gross_value": tot("gross_value"), "accumulated_depreciation": tot("accumulated_depreciation"), "impairment": tot("impairment"), "net_book_value": tot("net_book_value")}}


def depreciation_report(year):
    return [{"id": str(r.id), "period": f"{r.year}-{r.month:02d}", "status": r.status, "total": str(r.total_amount), "assets": r.asset_count} for r in m.DepreciationRun.objects.filter(year=year).order_by("month")]


def reconcile():
    """Register against the ledger: cost account 1500 and accumulated depreciation/impairment account 1590."""
    fin = _fin()
    from modules.finance import models as fm

    reg = m.AssetValueEntry.objects.aggregate(g=Sum("gross_delta"), d=Sum("depreciation_delta"), i=Sum("impairment_delta"))
    gross, accum = reg["g"] or ZERO, (reg["d"] or ZERO) + (reg["i"] or ZERO)
    gl_cost = fin.account_balance(fm.Account.objects.get(system_key="fixed_assets"))
    gl_acc = -fin.account_balance(fm.Account.objects.get(system_key="accumulated_depreciation"))
    return {"register_cost": str(gross), "ledger_cost": str(gl_cost), "cost_difference": str(gross - gl_cost), "register_accumulated": str(accum), "ledger_accumulated": str(gl_acc), "accumulated_difference": str(accum - gl_acc), "reconciled": gross == gl_cost and accum == gl_acc}
