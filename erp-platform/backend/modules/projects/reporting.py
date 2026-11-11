"""Profitability, health and the portfolio view."""
from decimal import Decimal

from django.utils import timezone

from modules.projects import billing, costs, risks
from modules.projects import models as m
from modules.projects import services as svc

ZERO = Decimal("0")
Q4 = Decimal("0.0001")


def profitability(project_id, today=None):
    p = svc.get_project(project_id)
    summary = billing.billing_summary(p.id)
    rep = costs.cost_report(p.id, today)
    revenue, billed = Decimal(summary["recognized"]), Decimal(summary["billed"])
    ac = Decimal(rep["totals"]["actual"])
    margin = revenue - ac
    ev = rep["earned_value"]
    eac = Decimal(ev["eac"]) if ev["eac"] else ac
    pct = Decimal(ev["percent_complete"])
    expected_revenue = p.contract_value if p.billing_type == "FIXED" else billed
    earned_revenue = (p.contract_value * pct / 100).quantize(Q4) if p.billing_type == "FIXED" else revenue
    return {"project": p.code, "billing_type": p.billing_type, "revenue_recognized": str(revenue), "billed": str(billed), "actual_cost": str(ac), "margin": str(margin.quantize(Q4)), "margin_percent": None if revenue <= 0 else str((margin / revenue * 100).quantize(Decimal("0.01"))),
            "forecast": {"revenue": str(expected_revenue), "cost": str(eac.quantize(Q4)), "margin": str((expected_revenue - eac).quantize(Q4))},
            "under_billed": str((earned_revenue - billed).quantize(Q4)) if p.billing_type == "FIXED" else None}


def health(project_id, today=None):
    p = svc.get_project(project_id)
    today = today or timezone.now().date()
    ev = costs.cost_report(p.id, today)["earned_value"]
    reg = risks.register_summary(p.id)
    overdue = m.Task.objects.filter(project=p, planned_end__lt=today).exclude(status__in=("DONE", "CANCELLED")).count()
    overdue_ms = m.Task.objects.filter(project=p, is_milestone=True, planned_end__lt=today).exclude(status__in=("DONE", "CANCELLED")).count()
    cpi = Decimal(ev["cpi"]) if ev["cpi"] else None
    # schedule index is only meaningful once a reasonable share of the plan has elapsed
    spi = Decimal(ev["spi"]) if ev["spi"] and Decimal(ev["planned_percent"]) >= 10 else None
    reasons, rag = [], "GREEN"
    red = []
    if cpi is not None and cpi < Decimal("0.8"):
        red.append("COST_OVERRUN")
    if spi is not None and spi < Decimal("0.8") and p.status == "ACTIVE":
        red.append("BEHIND_SCHEDULE")
    if reg["critical_issues"]:
        red.append("CRITICAL_ISSUE")
    if overdue_ms:
        red.append("MILESTONE_OVERDUE")
    if p.status == "ACTIVE" and p.end_on < today:
        red.append("PAST_END_DATE")
    amber = []
    if cpi is not None and cpi < Decimal("0.95"):
        amber.append("COST_PRESSURE")
    if spi is not None and spi < Decimal("0.95") and p.status == "ACTIVE":
        amber.append("SCHEDULE_PRESSURE")
    if overdue:
        amber.append("OVERDUE_TASKS")
    if reg["high_risks"] or reg["high_issues"]:
        amber.append("OPEN_HIGH_RISK_OR_ISSUE")
    rag = "RED" if red else ("AMBER" if amber else "GREEN")
    return {"project": p.code, "rag": rag, "reasons": red + amber, "cpi": ev["cpi"], "spi": ev["spi"], "percent_complete": ev["percent_complete"], "overdue_tasks": overdue, **reg}


def portfolio(user_id, today=None):
    rows = []
    for p in svc.visible_projects(user_id).order_by("code"):
        h = health(p.id, today) if p.status in ("ACTIVE", "ON_HOLD", "PLANNING") else {"rag": None, "reasons": [], "percent_complete": str(costs.progress_percent(p.id))}
        row = {"id": str(p.id), "code": p.code, "name": p.name, "status": p.status, "manager_id": str(p.manager_id), "start_on": str(p.start_on), "end_on": str(p.end_on), "rag": h["rag"], "reasons": h["reasons"], "percent_complete": h["percent_complete"]}
        if svc.can_see_costs(user_id, p):
            row["margin"] = profitability(p.id, today)["margin"]
        rows.append(row)
    by = {}
    for r in rows:
        by[r["status"]] = by.get(r["status"], 0) + 1
    return {"by_status": by, "rag": {k: sum(1 for r in rows if r["rag"] == k) for k in ("RED", "AMBER", "GREEN")}, "projects": rows}
