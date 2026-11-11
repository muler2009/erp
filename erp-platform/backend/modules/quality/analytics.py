"""Quality dashboard and reports. Every report is a registered query; CSV export covers all of them."""
import csv
from collections import Counter, defaultdict
from datetime import timedelta
from decimal import Decimal
from io import StringIO

from django.db.models import Count, Sum

from modules.quality import calibration, core, models as m, planning, risks

REPORTS = {}


def report(code, title):
    def deco(fn):
        REPORTS[code] = (title, fn)
        return fn
    return deco


def _rng(p):
    return p.get("date_from") or None, p.get("date_to") or None


def _between(qs, field, p):
    a, b = _rng(p)
    if a:
        qs = qs.filter(**{f"{field}__gte": a})
    if b:
        qs = qs.filter(**{f"{field}__lte": b})
    return qs


def dashboard():
    today = core.today()
    insp = m.Inspection.objects.filter(status="COMPLETED", completed_at__date__gte=today - timedelta(days=90))
    done = insp.count()
    passed = insp.filter(result="PASS").count()
    return {
        "open_ncrs": m.Ncr.objects.exclude(status__in=("CLOSED", "REJECTED")).count(),
        "open_ncrs_by_severity": dict(Counter(m.Ncr.objects.exclude(status__in=("CLOSED", "REJECTED")).values_list("severity", flat=True))),
        "overdue_capas": m.Capa.objects.exclude(status__in=("CLOSED", "CANCELLED")).filter(due_date__lt=today).count(),
        "open_capas": m.Capa.objects.exclude(status__in=("CLOSED", "CANCELLED")).count(),
        "inspections_scheduled": m.Inspection.objects.filter(status__in=("SCHEDULED", "IN_PROGRESS")).count(),
        "inspections_overdue": m.Inspection.objects.filter(status="SCHEDULED", scheduled_for__lt=today).count(),
        "inspection_pass_rate_90d": round(100 * passed / done, 1) if done else None,
        "active_holds": m.Hold.objects.filter(status="ACTIVE").count(),
        "open_complaints": m.Complaint.objects.exclude(status="CLOSED").count(),
        "open_findings": m.Finding.objects.exclude(status="CLOSED").count(),
        "audits_planned": m.Audit.objects.filter(status__in=("PLANNED", "IN_PROGRESS")).count(),
        "equipment_overdue": m.Equipment.objects.filter(status="ACTIVE", next_due_on__lt=today).count(),
        "equipment_on_hold": m.Equipment.objects.filter(status="ON_HOLD").count(),
        "high_risks": sum(1 for r in m.Risk.objects.exclude(status="CLOSED") if r.score >= risks.HIGH),
        "overdue_actions": m.Action.objects.filter(status="OPEN", due_date__lt=today).count(),
        "supplier_status": dict(Counter(m.SupplierProfile.objects.values_list("status", flat=True))),
        "compliance": planning.compliance_summary()["compliance_percent"],
        "objectives_missed": sum(1 for o in m.Objective.objects.filter(plan__status="APPROVED") if planning.objective_dict(o)["met"] is False),
    }


@report("ncr-register", "Non-conformance register")
def ncr_register(p):
    qs = _between(m.Ncr.objects.all(), "detected_on", p)
    for k in ("severity", "status", "category", "source", "product_id", "supplier_id", "project_id", "department_id"):
        if p.get(k):
            qs = qs.filter(**{k: p[k]})
    rows = [{"number": n.number, "title": n.title, "source": n.source, "category": n.category, "severity": n.severity, "status": n.status, "detected_on": str(n.detected_on),
             "age_days": ((n.closed_at.date() if n.closed_at else core.today()) - n.detected_on).days, "capa": bool(n.capa_id)} for n in qs.order_by("-detected_on")]
    return rows


@report("ncr-trend", "Non-conformance trend by month")
def ncr_trend(p):
    c = defaultdict(lambda: Counter())
    for n in _between(m.Ncr.objects.exclude(status="REJECTED"), "detected_on", p):
        c[n.detected_on.strftime("%Y-%m")][n.severity] += 1
    return [{"month": k, "total": sum(v.values()), **dict(v)} for k, v in sorted(c.items())]


@report("defect-pareto", "Defects by type (Pareto)")
def defect_pareto(p):
    qs = _between(m.Defect.objects.all(), "occurred_on", p)
    if p.get("product_id"):
        qs = qs.filter(product_id=p["product_id"])
    agg = qs.values("defect_code").annotate(q=Sum("quantity")).order_by("-q")
    total = sum(a["q"] for a in agg) or Decimal(1)
    cum = Decimal(0)
    out = []
    for a in agg:
        cum += a["q"]
        out.append({"defect_code": a["defect_code"], "quantity": str(a["q"]), "percent": str((a["q"] / total * 100).quantize(Decimal("0.1"))), "cumulative_percent": str((cum / total * 100).quantize(Decimal("0.1")))})
    return out


@report("inspection-summary", "Inspection pass rate")
def inspection_summary(p):
    qs = m.Inspection.objects.filter(status="COMPLETED")
    qs = _between(qs, "completed_at__date", p) if False else qs
    a, b = _rng(p)
    if a:
        qs = qs.filter(completed_at__date__gte=a)
    if b:
        qs = qs.filter(completed_at__date__lte=b)
    by = p.get("group_by", "stage")
    if by not in ("stage", "product_id", "supplier_id", "project_id"):
        by = "stage"
    groups = defaultdict(lambda: Counter())
    qty = defaultdict(lambda: [Decimal(0), Decimal(0)])
    for i in qs:
        k = str(getattr(i, by) or "-")
        groups[k][i.result] += 1
        qty[k][0] += i.quantity_inspected or Decimal(0)
        qty[k][1] += i.quantity_rejected
    return [{by: k, "total": sum(v.values()), "pass": v["PASS"], "fail": v["FAIL"], "conditional": v["CONDITIONAL"], "pass_rate": round(100 * v["PASS"] / sum(v.values()), 1),
             "rejection_rate": str((qty[k][1] / qty[k][0] * 100).quantize(Decimal("0.01"))) if qty[k][0] else None} for k, v in sorted(groups.items())]


@report("capa-status", "CAPA status and effectiveness")
def capa_status(p):
    qs = m.Capa.objects.all()
    for k in ("status", "kind", "owner_id"):
        if p.get(k):
            qs = qs.filter(**{k: p[k]})
    rows = []
    for c in qs.order_by("due_date"):
        closed = c.status == "CLOSED"
        rows.append({"number": c.number, "kind": c.kind, "status": c.status, "due_date": str(c.due_date), "overdue": not closed and c.status != "CANCELLED" and c.due_date < core.today(),
                     "cycles": c.cycles, "closed_on_time": (c.closed_at.date() <= c.due_date) if closed and c.closed_at else None, "source_type": c.source_type})
    return rows


@report("audit-findings", "Audit findings")
def audit_findings(p):
    qs = m.Finding.objects.all()
    for k in ("status", "severity", "audit_id"):
        if p.get(k):
            qs = qs.filter(**{k: p[k]})
    return [{"number": f.number, "audit": f.audit.number, "type": f.finding_type, "severity": f.severity, "status": f.status, "due_date": str(f.due_date) if f.due_date else None,
             "overdue": f.status != "CLOSED" and bool(f.due_date and f.due_date < core.today())} for f in qs.select_related("audit").order_by("-created_at")]


@report("supplier-scorecard", "Supplier quality scorecard")
def supplier_scorecard(p):
    from modules.procurement.models import Supplier
    names = dict(Supplier.objects.values_list("id", "name")) if hasattr(Supplier, "name") else {}
    rows = []
    for pr in m.SupplierProfile.objects.all():
        e = m.SupplierEvaluation.objects.filter(supplier_id=pr.supplier_id).order_by("-period_to", "-created_at").first()
        rows.append({"supplier_id": str(pr.supplier_id), "supplier": names.get(pr.supplier_id, ""), "status": pr.status, "score": str(e.score) if e else None, "rejection_rate": str(e.rejection_rate) if e else None,
                     "outcome": e.outcome if e else None, "open_scars": m.Scar.objects.filter(supplier_id=pr.supplier_id).exclude(status="CLOSED").count(),
                     "expired_certificates": m.SupplierCertificate.objects.filter(supplier_id=pr.supplier_id, expires_on__lt=core.today()).count()})
    return rows


@report("complaints", "Customer complaints")
def complaints(p):
    qs = _between(m.Complaint.objects.all(), "received_on", p)
    for k in ("status", "severity", "complaint_type", "product_id", "customer_id"):
        if p.get(k):
            qs = qs.filter(**{k: p[k]})
    out = []
    for c in qs.order_by("-received_on"):
        out.append({"number": c.number, "type": c.complaint_type, "severity": c.severity, "status": c.status, "received_on": str(c.received_on),
                    "days_to_respond": (c.responded_on - c.received_on).days if c.responded_on else None, "recurring": c.is_recurring})
    return out


@report("calibration-due", "Calibration schedule")
def calibration_due(p):
    return [calibration.equipment_dict(e) for e in calibration.list_equipment(status=p.get("status"), overdue=p.get("overdue"), due_within=p.get("due_within") or 60)]


@report("cost-of-quality", "Cost of quality")
def cost_of_quality(p):
    qs = _between(m.CostEntry.objects.all(), "incurred_on", p)
    agg = qs.values("category").annotate(total=Sum("amount"), n=Count("id")).order_by("-total")
    kinds = {"PREVENTION": "Prevention", "INSPECTION": "Appraisal", "SCRAP": "Internal failure", "REWORK": "Internal failure", "RETURN": "External failure", "WARRANTY": "External failure", "OTHER": "Other"}
    rows = [{"category": a["category"], "class": kinds[a["category"]], "total": str(a["total"]), "entries": a["n"]} for a in agg]
    return rows


@report("risk-register", "Quality risk register")
def risk_register(p):
    return [{"number": r.number, "title": r.title, "area": r.area, "score": r.score, "level": risks.level(r.score), "residual_score": r.residual_score, "status": r.status,
             "next_review_on": str(r.next_review_on) if r.next_review_on else None} for r in risks.list_risks(status=p.get("status"), area=p.get("area"), level=p.get("level"))]


@report("compliance", "Standards compliance")
def compliance(p):
    return [{"standard": s.code, "name": s.name, **planning.compliance_summary(s.id)["counts"], "percent": planning.compliance_summary(s.id)["compliance_percent"]} for s in m.Standard.objects.filter(status="ACTIVE")]


@report("improvement", "Improvement initiatives")
def improvement(p):
    return [{"number": i.number, "title": i.title, "status": i.status, "progress": i.progress, "target_date": str(i.target_date), "baseline": str(i.baseline_value) if i.baseline_value is not None else None,
             "target": str(i.target_value) if i.target_value is not None else None, "result": str(i.result_value) if i.result_value is not None else None} for i in m.Initiative.objects.order_by("target_date")]


@report("holds", "Quality holds")
def holds_report(p):
    qs = m.Hold.objects.all()
    if p.get("status"):
        qs = qs.filter(status=p["status"])
    return [{"number": h.number, "product_id": str(h.product_id), "lot": h.lot_number, "status": h.status, "disposition": h.disposition, "reason": h.reason[:120],
             "age_days": ((h.released_at.date() if h.released_at else core.today()) - h.created_at.date()).days} for h in qs.order_by("-created_at")]


@report("actions", "Quality actions")
def actions_report(p):
    qs = m.Action.objects.all()
    for k in ("status", "owner_id", "parent_type"):
        if p.get(k):
            qs = qs.filter(**{k: p[k]})
    if p.get("overdue"):
        qs = qs.filter(status="OPEN", due_date__lt=core.today())
    return [core.action_dict(a) for a in qs.order_by("due_date")]


@report("project-inspections", "Project inspections and punch list")
def project_inspections(p):
    pid = p.get("project_id")
    rq = m.InspectionRequest.objects.filter(project_id=pid) if pid else m.InspectionRequest.objects.all()
    pl = m.PunchItem.objects.filter(project_id=pid) if pid else m.PunchItem.objects.all()
    return [{"requests": dict(Counter(rq.values_list("status", flat=True))), "hold_points_open": rq.filter(hold_point=True).exclude(status__in=("APPROVED", "CANCELLED")).count(),
             "punch": dict(Counter(pl.values_list("status", flat=True))), "punch_major_open": pl.filter(severity="MAJOR").exclude(status="CLOSED").count()}]


@report("objectives", "Quality objectives")
def objectives(p):
    return [{"plan": o.plan.number, **planning.objective_dict(o)} for o in m.Objective.objects.filter(plan__status="APPROVED").select_related("plan")]


def run(code, params):
    if code not in REPORTS:
        raise core.nf("Report")
    title, fn = REPORTS[code]
    rows = fn(params)
    return {"code": code, "title": title, "rows": rows, "count": len(rows)}


def to_csv(rows):
    out = StringIO()
    if not rows:
        return ""
    flat = [{k: (v if not isinstance(v, (dict, list)) else str(v)) for k, v in r.items()} for r in rows]
    cols = list(flat[0].keys())
    w = csv.DictWriter(out, fieldnames=cols, extrasaction="ignore")
    w.writeheader()
    for r in flat:
        w.writerow({k: ("'" + str(v) if isinstance(v, str) and v[:1] in "=+-@" else v) for k, v in r.items()})
    return out.getvalue()


def list_reports():
    return [{"code": c, "title": t} for c, (t, _) in REPORTS.items()]
