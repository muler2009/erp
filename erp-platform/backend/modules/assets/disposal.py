"""Asset disposal and retirement: request, approval by someone else, execution with gain/loss posted to Finance, certificates."""
from decimal import Decimal

from django.db import transaction
from django.db.models import Sum
from django.utils import timezone

from modules.assets import allocation as alloc
from modules.assets import models as m
from modules.assets import services as svc
from modules.assets.depreciation import nbv
from platform_core.audit.services import record_tenant_event
from shared.api.errors import DomainError, ValidationFailed
from shared.sequences import services as sequences
from shared.tenancy import current_tenant

ZERO = Decimal("0")
METHODS = ("SALE", "SCRAP", "DONATION", "WRITE_OFF")
OPEN = ("REQUESTED", "APPROVED")
DISPOSABLE = ("AVAILABLE", "ASSIGNED", "IN_USE", "UNDER_MAINTENANCE", "RETIRED")


def _fin():
    from modules.finance import services as fin

    return fin


def _get(pk, lock=False):
    qs = m.AssetDisposal.objects.select_for_update(of=("self",)) if lock else m.AssetDisposal.objects
    d = qs.select_related("asset").filter(pk=pk).first()
    if d is None:
        raise DomainError("Disposal not found.", code="not_found", status_code=404)
    return d


@transaction.atomic
def request_disposal(actor_id, asset_id, *, method, reason, proposed_on=None, expected_proceeds=0, buyer="", buyer_reference="", count_line_id=None):
    a = svc._get(asset_id, lock=True)
    if method not in METHODS:
        raise ValidationFailed("Method must be SALE, SCRAP, DONATION or WRITE_OFF.", code="invalid_method")
    if not (reason or "").strip():
        raise ValidationFailed("A reason is required.", code="reason_required")
    if a.status not in DISPOSABLE:
        raise DomainError(f"An asset in status {a.status} cannot be disposed of.", code="asset_not_disposable")
    proceeds = svc._dec(expected_proceeds, "expected_proceeds")
    if proceeds < 0 or (method != "SALE" and proceeds > 0):
        raise ValidationFailed("Only a sale can bring proceeds, and they cannot be negative.", code="invalid_proceeds")
    if method == "SALE" and not (buyer or "").strip():
        raise ValidationFailed("A sale needs a buyer.", code="buyer_required")
    if m.AssetDisposal.objects.filter(asset=a, status__in=OPEN).exists():
        raise DomainError("A disposal is already in progress for this asset.", code="already_pending")
    d = m.AssetDisposal.objects.create(number=sequences.next_number("assets.disposal", on_date=proposed_on, for_type="AssetDisposal"), asset=a, method=method, reason=reason, proposed_on=proposed_on or timezone.now().date(), expected_proceeds=proceeds, buyer=buyer[:160], buyer_reference=buyer_reference[:60], requested_by=actor_id, count_line_id=count_line_id)
    svc.log(a, "DISPOSAL_REQUESTED", actor_id=actor_id, number=d.number, method=method)
    return d


@transaction.atomic
def decide(actor_id, disposal_id, *, approve, note=""):
    d = _get(disposal_id, lock=True)
    if d.status != "REQUESTED":
        raise DomainError("Only a requested disposal can be decided.", code="invalid_state")
    if d.requested_by == actor_id:
        raise DomainError("Separation of duties: someone else must approve this disposal.", code="separation_of_duties", status_code=403)
    if not approve and not (note or "").strip():
        raise ValidationFailed("A reason is required to reject.", code="reason_required")
    d.status, d.decided_by, d.decision_note = ("APPROVED" if approve else "REJECTED"), actor_id, note[:300]
    d.save()
    svc.log(d.asset, "DISPOSAL_APPROVED" if approve else "DISPOSAL_REJECTED", actor_id=actor_id, number=d.number)
    return d


@transaction.atomic
def cancel(actor_id, disposal_id):
    d = _get(disposal_id, lock=True)
    if d.status not in OPEN:
        raise DomainError("Only an open disposal can be cancelled.", code="invalid_state")
    d.status = "CANCELLED"
    d.save(update_fields=["status", "updated_at"])
    return d


def _blockers(a):
    from modules.assets.maintenance import OPEN_WO

    if m.AssetAssignment.objects.filter(asset=a, status__in=("REQUESTED", "APPROVED", "ACTIVE")).exists():
        return "The asset is still assigned; record its return first."
    if m.AssetTransfer.objects.filter(asset=a, status__in=("REQUESTED", "APPROVED", "IN_TRANSIT")).exists():
        return "A transfer of this asset is still open."
    if m.WorkOrder.objects.filter(asset=a, status__in=OPEN_WO + ("COMPLETED",)).exists():
        return "Finish or cancel the open work orders first."
    return ""


def _check_depreciation_current(a, on):
    if not a.is_capitalized or a.depreciation_method == "NON" or not a.depreciation_start:
        return
    idx = lambda y, mo: y * 12 + mo
    latest = m.DepreciationRun.objects.filter(status="POSTED").order_by("-year", "-month").first()
    target = idx(on.year, on.month)
    last = idx(latest.year, latest.month) if latest else 0
    if last > target:
        raise DomainError("Depreciation has been posted beyond the disposal month; choose a later date.", code="period_closed_for_disposal")
    if last < target - 1 and idx(a.depreciation_start.year, a.depreciation_start.month) <= target - 1 and a.depreciated_months < a.useful_life_months:
        raise DomainError("Run depreciation up to the month before the disposal first.", code="depreciation_not_current")


@transaction.atomic
def execute(actor_id, disposal_id, *, executed_on, proceeds=0):
    d = _get(disposal_id, lock=True)
    if d.status != "APPROVED":
        raise DomainError("Only an approved disposal can be executed.", code="approval_required" if d.status == "REQUESTED" else "invalid_state")
    a = svc._get(d.asset_id, lock=True)
    if a.status not in DISPOSABLE:
        raise DomainError(f"An asset in status {a.status} cannot be disposed of.", code="asset_not_disposable")
    block = _blockers(a)
    if block:
        raise DomainError(block, code="disposal_blocked")
    got = svc._dec(proceeds, "proceeds")
    if got < 0 or (d.method != "SALE" and got > 0):
        raise ValidationFailed("Only a sale can bring proceeds, and they cannot be negative.", code="invalid_proceeds")
    if executed_on < (a.capitalized_on or a.acquisition_date or executed_on):
        raise ValidationFailed("The asset cannot be disposed of before it was acquired.", code="invalid_dates")
    _check_depreciation_current(a, executed_on)
    fin = _fin()
    gross, acc, imp, surplus = a.gross_value, a.accumulated_depreciation, a.impairment_total, a.revaluation_surplus
    book = gross - acc - imp
    gain = got - book if a.is_capitalized else ZERO
    entry = None
    if a.is_capitalized and gross > 0:
        q = fin._q
        legs = [("accumulated_depreciation", "debit", q(acc + imp, 4)), ("asset_clearing", "debit", q(got, 4)), ("fixed_assets", "credit", q(gross, 4))]
        legs.append(("disposal_gain_loss", "credit" if gain > 0 else "debit", q(abs(gain), 4)))
        if surplus > 0:
            legs += [("revaluation_surplus", "debit", q(surplus, 4)), ("retained_earnings", "credit", q(surplus, 4))]
        entry = fin.post_system_journal(actor_id, executed_on, f"Disposal of {a.number} ({d.method.lower()})", "asset_disposal", d.id, legs)
        m.AssetValueEntry.objects.create(asset=a, entry_date=executed_on, kind="DISPOSAL", gross_delta=-gross, depreciation_delta=-acc, impairment_delta=-imp, surplus_delta=-surplus, ref=d.number[:60], journal_entry_id=entry.id if entry else None)
    alloc.end_all_for_asset(actor_id, a.id, executed_on)
    svc.set_status(actor_id, a.id, "DISPOSED", reason=f"Disposal {d.number}")
    d.status, d.executed_on, d.executed_by, d.proceeds = "COMPLETED", executed_on, actor_id, got
    d.nbv_at_disposal, d.gain_loss, d.journal_entry_id = (book if a.is_capitalized else ZERO), gain, entry.id if entry else None
    d.save()
    svc.log(a, "DISPOSED", actor_id=actor_id, number=d.number, method=d.method, proceeds=got, gain_loss=gain)
    record_tenant_event(current_tenant(), "assets.disposed", actor_user_id=actor_id, target_type="AssetDisposal", target_id=d.id, metadata={"number": d.number, "asset": a.number, "gain_loss": str(gain)})
    return d


def certificate(disposal_id):
    d = _get(disposal_id)
    if d.status != "COMPLETED":
        raise DomainError("A certificate exists only for a completed disposal.", code="invalid_state")
    a = d.asset
    return {"number": d.number, "asset": a.number, "name": a.name, "serial_number": a.serial_number, "method": d.method, "executed_on": str(d.executed_on), "buyer": d.buyer, "buyer_reference": d.buyer_reference, "reason": d.reason,
            "net_book_value": str(d.nbv_at_disposal), "proceeds": str(d.proceeds), "gain_loss": str(d.gain_loss), "approved_by": str(d.decided_by), "executed_by": str(d.executed_by)}


def disposal_report(date_from, date_to):
    qs = m.AssetDisposal.objects.filter(status="COMPLETED", executed_on__range=(date_from, date_to)).select_related("asset").order_by("executed_on")
    rows = [{"number": d.number, "asset": d.asset.number, "method": d.method, "executed_on": str(d.executed_on), "nbv": str(d.nbv_at_disposal), "proceeds": str(d.proceeds), "gain_loss": str(d.gain_loss)} for d in qs]
    t = qs.aggregate(p=Sum("proceeds"), g=Sum("gain_loss"), n=Sum("nbv_at_disposal"))
    return {"rows": rows, "totals": {"proceeds": str(t["p"] or ZERO), "nbv": str(t["n"] or ZERO), "gain_loss": str(t["g"] or ZERO)}}
