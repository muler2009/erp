"""Acquisition and capitalization: documented source, delivery acceptance, commissioning, extra costs, approval and ledger posting."""
from decimal import Decimal

from django.db import transaction
from django.db.models import Sum
from django.utils import timezone

from modules.assets import models as m
from modules.assets import services as svc
from platform_core.audit.services import record_tenant_event
from shared.api.errors import DomainError, ValidationFailed
from shared.notifications.services import notify
from shared.sequences import services as sequences
from shared.tenancy import current_tenant
from shared.workflows import services as workflows

ZERO = Decimal("0")
SOURCES = ("PURCHASE", "DONATION", "CONSTRUCTION", "TRANSFER", "OPENING")
COST_KINDS = ("FREIGHT", "INSTALLATION", "DUTY", "TESTING", "OTHER")
SUBJECT = "assets.capitalization"


def _acq(asset_id, lock=False):
    qs = m.AssetAcquisition.objects.select_for_update(of=("self",)) if lock else m.AssetAcquisition.objects
    a = qs.select_related("asset__category").filter(asset_id=asset_id).first()
    if a is None:
        raise DomainError("Record the asset's acquisition first.", code="acquisition_required", status_code=409)
    return a


def _check_references(source, po_id, receipt_id, invoice_id, contract_id, note):
    from modules.finance import models as fm
    from modules.procurement import models as pm

    supplier = None
    if po_id:
        po = pm.PurchaseOrder.objects.filter(pk=po_id).first()
        if po is None or po.status in ("DRAFT", "PENDING_APPROVAL", "CANCELLED"):
            raise ValidationFailed("The purchase order does not exist or is not approved.", code="invalid_po")
        supplier = po.supplier_id
    if receipt_id and not pm.GoodsReceipt.objects.filter(pk=receipt_id).exists():
        raise ValidationFailed("Goods receipt not found.", code="invalid_receipt")
    if invoice_id and not fm.Invoice.objects.filter(pk=invoice_id, kind="SUPPLIER_INVOICE").exclude(status="VOID").exists():
        raise ValidationFailed("Supplier invoice not found.", code="invalid_invoice")
    if contract_id and not pm.SupplierContract.objects.filter(pk=contract_id).exists():
        raise ValidationFailed("Supplier contract not found.", code="invalid_contract")
    if source == "PURCHASE" and not (po_id or receipt_id or invoice_id or contract_id):
        raise ValidationFailed("A purchased asset must reference a purchase order, goods receipt, supplier invoice or contract.", code="documentation_required")
    if source != "PURCHASE" and not (note or "").strip():
        raise ValidationFailed("Describe the basis of the acquisition (donor, project, transfer or opening balance reference).", code="documentation_required")
    return supplier


@transaction.atomic
def record_acquisition(actor_id, asset_id, *, source, cost, po_id=None, goods_receipt_id=None, invoice_id=None, contract_id=None, reference_note="", delivered_on=None, currency=None):
    asset = svc._get(asset_id, lock=True)
    if asset.status not in ("REQUESTED", "ORDERED", "RECEIVED"):
        raise DomainError("Acquisition can only be recorded before the asset is activated.", code="invalid_state")
    if source not in SOURCES:
        raise ValidationFailed("Unknown acquisition source.", code="invalid_source")
    if m.AssetAcquisition.objects.filter(asset=asset).exists():
        raise DomainError("This asset already has an acquisition record.", code="already_recorded")
    c = svc._dec(cost, "cost")
    if c < 0 or (c == 0 and source != "TRANSFER"):
        raise ValidationFailed("The acquisition cost must be positive.", code="invalid_amount")
    supplier = _check_references(source, po_id, goods_receipt_id, invoice_id, contract_id, reference_note)
    acq = m.AssetAcquisition.objects.create(asset=asset, source=source, po_id=po_id, goods_receipt_id=goods_receipt_id, invoice_id=invoice_id, contract_id=contract_id, reference_note=reference_note[:300], cost=c, delivered_on=delivered_on, recorded_by=actor_id)
    asset.purchase_cost = c
    asset.acquisition_date = delivered_on or asset.acquisition_date
    if currency:
        asset.currency = currency
    if supplier and not asset.supplier_id:
        asset.supplier_id = supplier
    asset.version += 1
    asset.save()
    svc.log(asset, "ACQUISITION_RECORDED", actor_id=actor_id, source=source, cost=c, po=po_id, receipt=goods_receipt_id, invoice=invoice_id, contract=contract_id)
    return acq


@transaction.atomic
def add_cost(actor_id, asset_id, *, kind, description, amount, invoice_id=None):
    acq = _acq(asset_id, lock=True)
    if kind not in COST_KINDS:
        raise ValidationFailed("Unknown cost kind.", code="invalid_kind")
    amt = svc._dec(amount, "amount")
    if amt <= 0:
        raise ValidationFailed("The amount must be positive.", code="invalid_amount")
    if m.CapitalizationRequest.objects.filter(asset_id=asset_id, status__in=("SUBMITTED", "APPROVED")).exists():
        raise DomainError("Costs cannot be added once capitalization is submitted; use a capital improvement later.", code="invalid_state")
    row = m.AcquisitionCost.objects.create(acquisition=acq, kind=kind, description=description[:200], amount=amt, invoice_id=invoice_id)
    svc.log(acq.asset, "COST_ADDED", actor_id=actor_id, kind=kind, amount=amt)
    return row


def total_cost(acq):
    return acq.cost + (acq.extra_costs.aggregate(t=Sum("amount"))["t"] or ZERO)


@transaction.atomic
def accept_delivery(actor_id, asset_id, *, delivered_on, notes=""):
    acq = _acq(asset_id, lock=True)
    asset = svc._get(asset_id, lock=True)
    if acq.accepted_on:
        raise DomainError("Delivery was already accepted.", code="already_recorded")
    if asset.status not in ("REQUESTED", "ORDERED"):
        raise DomainError("Only a requested or ordered asset can be received.", code="invalid_state")
    if asset.category.requires_serial and not asset.serial_number:
        raise ValidationFailed("Record the serial number before accepting delivery.", code="serial_required")
    acq.delivered_on, acq.accepted_on, acq.accepted_by = delivered_on, delivered_on, actor_id
    acq.save(update_fields=["delivered_on", "accepted_on", "accepted_by", "updated_at"])
    asset.acquisition_date = delivered_on
    asset.save(update_fields=["acquisition_date", "updated_at"])
    svc.set_status(actor_id, asset_id, "RECEIVED", reason=notes or "Delivery accepted")
    return acq


@transaction.atomic
def commission(actor_id, asset_id, *, passed, on_date, notes=""):
    acq = _acq(asset_id, lock=True)
    if not acq.accepted_on:
        raise DomainError("Accept delivery before inspection and commissioning.", code="invalid_state")
    if not passed and not (notes or "").strip():
        raise ValidationFailed("Say why inspection failed.", code="reason_required")
    acq.commissioning_passed, acq.commissioned_on, acq.commissioned_by, acq.commissioning_notes = bool(passed), on_date, actor_id, notes[:300]
    acq.save()
    svc.log(acq.asset, "COMMISSIONED" if passed else "COMMISSIONING_FAILED", actor_id=actor_id, note=notes)
    return acq


# ----------------------------------------------------------------------------- capitalization
def _counter(source):
    return "donated_income" if source == "DONATION" else "asset_clearing"


@transaction.atomic
def request_capitalization(actor_id, asset_id, *, capitalization_date):
    acq = _acq(asset_id, lock=True)
    asset = svc._get(asset_id, lock=True)
    if asset.status != "RECEIVED":
        raise DomainError("Only a received asset can be submitted for capitalization.", code="invalid_state")
    if not acq.commissioning_passed:
        raise DomainError("The asset must pass inspection and commissioning first.", code="commissioning_required")
    if m.CapitalizationRequest.objects.filter(asset=asset, status="SUBMITTED").exists():
        raise DomainError("A capitalization request is already pending.", code="already_pending")
    total = total_cost(acq)
    capitalize = total > 0 and total >= asset.category.capitalization_threshold
    req = m.CapitalizationRequest.objects.create(number=sequences.next_number("assets.capitalization", on_date=capitalization_date, for_type="CapitalizationRequest"), asset=asset, capitalize=capitalize, total_cost=total, capitalization_date=capitalization_date, requested_by=actor_id)
    if workflows.WorkflowDefinition.objects.filter(subject_type=SUBJECT, is_active=True).exists():
        inst = workflows.submit(actor_id, SUBJECT, str(req.id), amount=total, title=f"Capitalize {asset.number} {total}")
        req.workflow_instance_id = inst.id
        req.save(update_fields=["workflow_instance_id"])
    svc.log(asset, "CAPITALIZATION_REQUESTED", actor_id=actor_id, request=req.number, total=total, capitalize=capitalize)
    return req


def _finish(req, approver_id):
    from modules.finance import services as finance
    from platform_core.organizations import services as org

    asset = svc._get(req.asset_id, lock=True)
    acq = _acq(asset.id)
    if req.capitalize:
        base = finance.base_currency()
        cur = asset.currency or base.code
        rate = org.get_rate(cur, req.capitalization_date) if cur != base.code else Decimal("1")
        amount = finance._q(req.total_cost * rate, base.decimals)
        entry = finance.post_system_journal(approver_id, req.capitalization_date, f"Capitalize {asset.number}", "asset_capitalization", req.id, [("fixed_assets", "debit", amount), (_counter(acq.source), "credit", amount)])
        req.base_amount, req.journal_entry_id = amount, entry.id if entry else None
        cat = asset.category
        asset.is_capitalized, asset.capitalized_cost, asset.capitalized_on = True, req.total_cost, req.capitalization_date
        asset.gross_value, asset.depreciation_method, asset.useful_life_months, asset.reducing_rate_percent = amount, cat.depreciation_method, cat.useful_life_months, cat.reducing_rate_percent
        asset.residual_value = finance._q(amount * cat.residual_percent / 100, base.decimals)
        asset.depreciation_start = req.capitalization_date.replace(day=1)
        asset.save()
        m.AssetValueEntry.objects.create(asset=asset, entry_date=req.capitalization_date, kind="CAPITALIZATION", gross_delta=amount, ref=req.number, journal_entry_id=req.journal_entry_id)
    req.status, req.decided_by = "APPROVED", approver_id
    req.save()
    svc.set_status(approver_id, asset.id, "AVAILABLE", reason=f"Capitalization {req.number} approved")
    record_tenant_event(current_tenant(), "assets.capitalization.approved", actor_user_id=approver_id, target_type="Asset", target_id=asset.id, metadata={"number": asset.number, "capitalized": str(req.capitalize), "total": str(req.total_cost)})


@transaction.atomic
def approve_capitalization(actor_id, request_id):
    req = m.CapitalizationRequest.objects.select_for_update().filter(pk=request_id).first()
    if req is None:
        raise DomainError("Request not found.", code="not_found", status_code=404)
    if req.status != "SUBMITTED":
        raise DomainError("Only a submitted request can be approved.", code="invalid_state")
    if req.workflow_instance_id:
        raise DomainError("This request is governed by an approval workflow; decide it in the approval inbox.", code="workflow_governed")
    if req.requested_by == actor_id:
        raise DomainError("Separation of duties: you cannot approve your own request.", code="separation_of_duties", status_code=403)
    _finish(req, actor_id)
    return req


@transaction.atomic
def reject_capitalization(actor_id, request_id, *, note):
    req = m.CapitalizationRequest.objects.select_for_update().filter(pk=request_id).first()
    if req is None:
        raise DomainError("Request not found.", code="not_found", status_code=404)
    if req.status != "SUBMITTED" or req.workflow_instance_id:
        raise DomainError("Only a submitted request outside a workflow can be rejected here.", code="invalid_state")
    if not (note or "").strip():
        raise ValidationFailed("A reason is required.", code="reason_required")
    req.status, req.decided_by, req.decision_note = "REJECTED", actor_id, note[:300]
    req.save()
    svc.log(req.asset, "CAPITALIZATION_REJECTED", actor_id=actor_id, note=note)
    return req


def on_workflow_outcome(instance):
    with transaction.atomic():
        req = m.CapitalizationRequest.objects.select_for_update().filter(pk=instance.subject_id).first()
        if req is None or req.workflow_instance_id != instance.id or req.status != "SUBMITTED":
            return
        if instance.status == "APPROVED":
            last = instance.actions.filter(action="APPROVED").order_by("-created_at").first()
            _finish(req, last.actor_id if last else req.requested_by)
        else:
            req.status, req.decision_note = "REJECTED", "Rejected in workflow"
            req.save()


def acquisition_view(asset_id):
    a = _acq(asset_id)
    return {"asset": a.asset.number, "source": a.source, "po_id": None if not a.po_id else str(a.po_id), "goods_receipt_id": None if not a.goods_receipt_id else str(a.goods_receipt_id), "invoice_id": None if not a.invoice_id else str(a.invoice_id), "contract_id": None if not a.contract_id else str(a.contract_id),
            "cost": str(a.cost), "extra_costs": [{"kind": c.kind, "description": c.description, "amount": str(c.amount)} for c in a.extra_costs.all()], "total_cost": str(total_cost(a)), "delivered_on": None if not a.delivered_on else str(a.delivered_on),
            "accepted_on": None if not a.accepted_on else str(a.accepted_on), "commissioning_passed": a.commissioning_passed, "commissioned_on": None if not a.commissioned_on else str(a.commissioned_on)}


def acquisition_report(date_from, date_to):
    rows = []
    for r in m.CapitalizationRequest.objects.filter(status="APPROVED", capitalization_date__gte=date_from, capitalization_date__lte=date_to).select_related("asset__category").order_by("capitalization_date"):
        rows.append({"number": r.number, "asset": r.asset.number, "name": r.asset.name, "category": r.asset.category.code, "date": str(r.capitalization_date), "capitalized": r.capitalize, "total_cost": str(r.total_cost), "base_amount": str(r.base_amount)})
    return rows
