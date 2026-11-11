"""Supply chain risk management: risk register with mitigation actions, disruptions, critical and single-source materials,
alternative sourcing and automatic detection of supply risks."""
from collections import defaultdict
from datetime import timedelta
from decimal import Decimal

from django.db import transaction
from django.utils import timezone

from modules.inventory import models as im
from modules.procurement import models as pm
from modules.supply_chain import models as m
from modules.supply_chain.logistics import audit, dec
from platform_core.organizations import services as org
from shared.api.errors import DomainError, ValidationFailed
from shared.notifications.services import notify
from shared.sequences import services as sequences

CATS = ("SUPPLIER", "LOGISTICS", "INVENTORY", "PRODUCTION", "OTHER")


def _critical_score():
    return int(org.get_setting("supply_chain.critical_risk_score", 15))


@transaction.atomic
def create_risk(actor, *, category, title, likelihood, impact, owner_id, description="", supplier_id=None, product_id=None, financial_impact=0):
    if category not in CATS or not (title or "").strip() or not (1 <= int(likelihood) <= 5 and 1 <= int(impact) <= 5):
        raise ValidationFailed("A category, a title and likelihood and impact between 1 and 5 are required.", code="invalid_fields")
    if supplier_id and not pm.Supplier.objects.filter(pk=supplier_id).exists():
        raise ValidationFailed("Unknown supplier.", code="invalid_supplier")
    if product_id and not im.Product.objects.filter(pk=product_id).exists():
        raise ValidationFailed("Unknown product.", code="invalid_product")
    fin = dec(financial_impact, "financial_impact")
    if fin < 0:
        raise ValidationFailed("financial_impact cannot be negative.", code="invalid_amount")
    r = m.SupplyRisk.objects.create(number=sequences.next_number("supply_chain.risk", on_date=timezone.now().date(), for_type="Supply risk"), category=category, title=title[:200], description=description, supplier_id=supplier_id or None, product_id=product_id or None,
                                    likelihood=int(likelihood), impact=int(impact), financial_impact=fin, owner_id=owner_id, created_by=actor)
    if r.score >= _critical_score():
        notify([owner_id], "supply_chain.critical_risk", f"Critical supply risk {r.number}: {r.title}", f"Score {r.score}", ref_type="supply_chain.risk", ref_id=str(r.id))
    audit("supply_chain.risk.created", actor, "SupplyRisk", r.id, score=r.score)
    return r


@transaction.atomic
def update_risk(actor, pk, *, status=None, likelihood=None, impact=None, owner_id=None):
    r = m.SupplyRisk.objects.select_for_update().filter(pk=pk).first()
    if r is None:
        raise DomainError("Risk not found.", code="not_found", status_code=404)
    if status is not None:
        if status not in ("OPEN", "MITIGATING", "ACCEPTED", "CLOSED"):
            raise ValidationFailed("Invalid status.", code="invalid_fields")
        if status == "CLOSED" and r.actions.filter(status="OPEN").exists():
            raise DomainError("Complete or cancel the open mitigation actions first.", code="open_actions")
        r.status = status
    for k, v in (("likelihood", likelihood), ("impact", impact)):
        if v is not None:
            if not 1 <= int(v) <= 5:
                raise ValidationFailed(f"{k} must be 1-5.", code="invalid_fields")
            setattr(r, k, int(v))
    if owner_id:
        r.owner_id = owner_id
    r.save()
    return r


@transaction.atomic
def add_action(actor, risk_id, *, description, owner_id, due_date):
    r = m.SupplyRisk.objects.select_for_update().filter(pk=risk_id).first()
    if r is None:
        raise DomainError("Risk not found.", code="not_found", status_code=404)
    if r.status == "CLOSED" or not (description or "").strip():
        raise ValidationFailed("An open risk and a description are required.", code="invalid_fields")
    a = m.MitigationAction.objects.create(risk=r, description=description[:300], owner_id=owner_id, due_date=due_date)
    if r.status == "OPEN":
        r.status = "MITIGATING"
        r.save(update_fields=["status", "updated_at"])
    notify([owner_id], "supply_chain.mitigation_assigned", f"Mitigation action for {r.number}", description[:200], ref_type="supply_chain.risk", ref_id=str(r.id))
    return a


@transaction.atomic
def complete_action(actor, action_id):
    a = m.MitigationAction.objects.select_for_update().filter(pk=action_id).first()
    if a is None:
        raise DomainError("Action not found.", code="not_found", status_code=404)
    if a.status != "OPEN":
        raise DomainError("Only an open action can be completed.", code="invalid_state_transition")
    a.status, a.completed_at = "DONE", timezone.now()
    a.save()
    return a


@transaction.atomic
def record_disruption(actor, *, category, title, cause, started_on, supplier_id=None, product_id=None, shipment_id=None, risk_id=None, operational_impact="", financial_impact=0):
    if category not in CATS or not (title or "").strip() or not (cause or "").strip():
        raise ValidationFailed("A category, a title and a cause are required.", code="invalid_fields")
    fin = dec(financial_impact, "financial_impact")
    if fin < 0:
        raise ValidationFailed("financial_impact cannot be negative.", code="invalid_amount")
    d = m.Disruption.objects.create(category=category, title=title[:200], cause=cause[:500], started_on=started_on, supplier_id=supplier_id or None, product_id=product_id or None, shipment_id=shipment_id or None, risk_id=risk_id or None,
                                    operational_impact=operational_impact[:500], financial_impact=fin, reported_by=actor)
    audit("supply_chain.disruption.recorded", actor, "Disruption", d.id)
    return d


@transaction.atomic
def resolve_disruption(actor, pk, *, resolution, ended_on=None):
    d = m.Disruption.objects.select_for_update().filter(pk=pk).first()
    if d is None:
        raise DomainError("Disruption not found.", code="not_found", status_code=404)
    if d.status != "OPEN" or not (resolution or "").strip():
        raise DomainError("An open disruption and a resolution are required.", code="invalid_state_transition")
    d.status, d.resolution, d.ended_on = "RESOLVED", resolution[:500], ended_on or timezone.now().date()
    d.save()
    return d


@transaction.atomic
def mark_critical(actor, product_id, *, reason, min_sources=2):
    if not im.Product.objects.filter(pk=product_id).exists() or not (reason or "").strip():
        raise ValidationFailed("A product and a reason are required.", code="invalid_fields")
    row, _ = m.CriticalMaterial.objects.update_or_create(product_id=product_id, defaults={"reason": reason[:300], "min_sources": max(1, int(min_sources))})
    return row


@transaction.atomic
def add_alternative(actor, *, product_id, supplier_id, rank=1, lead_time_days=0, notes=""):
    if not im.Product.objects.filter(pk=product_id).exists() or not pm.Supplier.objects.filter(pk=supplier_id).exists():
        raise ValidationFailed("A known product and supplier are required.", code="invalid_fields")
    if pm.Supplier.objects.filter(pk=supplier_id, status="BLOCKED").exists():
        raise DomainError("A blocked supplier cannot be an alternative source.", code="supplier_blocked")
    row, _ = m.AlternativeSource.objects.update_or_create(product_id=product_id, supplier_id=supplier_id, defaults={"rank": int(rank), "lead_time_days": int(lead_time_days), "notes": notes[:300]})
    return row


def sourcing(product_id):
    """Distinct qualified supplier sources (catalogue plus recorded alternatives)."""
    ids = {str(x) for x in pm.SupplierItem.objects.filter(product_id=product_id, supplier__status="QUALIFIED").values_list("supplier_id", flat=True)}
    ids |= {str(x) for x in m.AlternativeSource.objects.filter(product_id=product_id).values_list("supplier_id", flat=True)}
    return ids


def critical_materials_report():
    rows = []
    for c in m.CriticalMaterial.objects.select_related("product"):
        src = sourcing(c.product_id)
        rows.append({"product": c.product.sku, "reason": c.reason, "sources": len(src), "required_sources": c.min_sources, "single_source": len(src) <= 1, "at_risk": len(src) < c.min_sources})
    return sorted(rows, key=lambda r: (not r["at_risk"], r["product"]))


def single_source_products():
    """Stocked products bought from exactly one qualified supplier with no alternative recorded."""
    by = defaultdict(set)
    for r in pm.SupplierItem.objects.filter(supplier__status="QUALIFIED").values_list("product_id", "supplier_id"):
        by[r[0]].add(str(r[1]))
    out = []
    for pid, sup in by.items():
        if len(sourcing(pid)) == 1:
            out.append({"product": im.Product.objects.get(pk=pid).sku, "supplier_id": next(iter(sup))})
    return sorted(out, key=lambda r: r["product"])


def detect_supply_risks(today):
    """Signals the planner should look at: overdue purchase orders, orders that cannot arrive before they are needed,
    products below zero projected balance, late shipments and critical materials without enough sources."""
    from modules.manufacturing import mrp
    from modules.supply_chain import planning as pl
    out = []
    for po in pm.PurchaseOrder.objects.filter(status__in=("APPROVED", "PARTIALLY_RECEIVED"), expected_date__lt=today).select_related("supplier"):
        out.append({"type": "OVERDUE_PURCHASE_ORDER", "ref": po.number, "supplier": po.supplier.name, "detail": f"expected {po.expected_date}, {(today - po.expected_date).days} days late"})
    for s in pl.run_preview(today):
        if s["start_by"] < today:
            out.append({"type": "DELIVERY_DELAY_RISK", "ref": s["sku"], "detail": f"{s['action']} {s['quantity']} needed by {s['need_by']} but lead time is {s['lead_days']} days"})
    for b in pl.balance(pl._demands(today, 30), today):
        if Decimal(b["shortage"]) > 0:
            out.append({"type": "PROJECTED_SHORTAGE", "ref": b["sku"], "detail": f"short {b['shortage']}"})
    for sh in m.Shipment.objects.filter(status__in=("DISPATCHED", "IN_TRANSIT"), planned_arrival__lt=today):
        out.append({"type": "LATE_SHIPMENT", "ref": sh.number, "detail": f"planned arrival {sh.planned_arrival}"})
    for c in critical_materials_report():
        if c["at_risk"]:
            out.append({"type": "CRITICAL_SOURCING", "ref": c["product"], "detail": f"{c['sources']} source(s), {c['required_sources']} required"})
    return out


def risk_report():
    return [{"number": r.number, "category": r.category, "title": r.title, "score": r.score, "status": r.status, "owner": str(r.owner_id), "financial_impact": str(r.financial_impact), "open_actions": r.actions.filter(status="OPEN").count()}
            for r in m.SupplyRisk.objects.all().order_by("-likelihood", "-impact")]


def incident_history(date_from, date_to):
    return [{"id": str(d.id), "category": d.category, "title": d.title, "cause": d.cause, "started_on": str(d.started_on), "ended_on": str(d.ended_on) if d.ended_on else None, "financial_impact": str(d.financial_impact), "status": d.status}
            for d in m.Disruption.objects.filter(started_on__gte=date_from, started_on__lte=date_to).order_by("-started_on")]


@transaction.atomic
def daily(today):
    """Remind owners of critical open risks (weekly) and of mitigation actions past due (weekly)."""
    n = 0
    for r in m.SupplyRisk.objects.select_for_update(of=("self",)).filter(status__in=("OPEN", "MITIGATING")):
        if r.score >= _critical_score() and (not r.last_reminder_on or (today - r.last_reminder_on).days >= 7):
            notify([r.owner_id], "supply_chain.critical_risk", f"Critical supply risk {r.number} is still {r.status.lower()}", r.title, ref_type="supply_chain.risk", ref_id=str(r.id))
            r.last_reminder_on = today
            r.save(update_fields=["last_reminder_on", "updated_at"])
            n += 1
    for a in m.MitigationAction.objects.select_for_update(of=("self",)).filter(status="OPEN", due_date__lt=today).select_related("risk"):
        if not a.last_reminder_on or (today - a.last_reminder_on).days >= 7:
            notify([a.owner_id], "supply_chain.mitigation_overdue", f"Mitigation action for {a.risk.number} is overdue", a.description[:200], ref_type="supply_chain.risk", ref_id=str(a.risk_id))
            a.last_reminder_on = today
            a.save(update_fields=["last_reminder_on", "updated_at"])
            n += 1
    return n
