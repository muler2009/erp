"""Risk-based quality and continuous improvement."""
from datetime import timedelta

from django.db import transaction

from modules.quality import core, ncr, models as m
from modules.quality.planning import dec
from shared.api.errors import DomainError, ValidationFailed
from shared.notifications.services import notify

HIGH = 15
MEDIUM = 8


def level(score):
    return "HIGH" if score >= HIGH else "MEDIUM" if score >= MEDIUM else "LOW"


def risk_dict(r, detail=False):
    d = {"id": str(r.id), "number": r.number, "title": r.title, "area": r.area, "category": r.category, "likelihood": r.likelihood, "impact": r.impact, "score": r.score, "level": level(r.score),
         "residual_score": r.residual_score, "residual_level": level(r.residual_score) if r.residual_score else None, "owner_id": str(r.owner_id), "status": r.status,
         "next_review_on": r.next_review_on.isoformat() if r.next_review_on else None, "product_id": str(r.product_id) if r.product_id else None,
         "supplier_id": str(r.supplier_id) if r.supplier_id else None, "project_id": str(r.project_id) if r.project_id else None}
    if detail:
        d.update({"causes": r.causes, "consequences": r.consequences, "links": r.links, "actions": core.list_actions("risk", r.id), "history": core.history("risk", r.id)})
    return d


def _scale(v, label):
    try:
        v = int(v)
    except (TypeError, ValueError):
        raise ValidationFailed(f"{label} must be a whole number from 1 to 5.", code="invalid_fields")
    if not 1 <= v <= 5:
        raise ValidationFailed(f"{label} must be from 1 to 5.", code="invalid_fields")
    return v


def get_risk(pk):
    r = m.Risk.objects.filter(pk=pk).first()
    if r is None:
        raise core.nf("Risk")
    return r


@transaction.atomic
def register(actor, data):
    core.need(data, "title", "area", "likelihood", "impact", "owner_id")
    if data.get("category"):
        core.config_item("RISK_CATEGORY", data["category"])
    r = m.Risk.objects.create(number=core.number("quality.risk"), title=data["title"][:200], area=data["area"][:30], category=data.get("category", ""), causes=data.get("causes", ""),
                              consequences=data.get("consequences", ""), likelihood=_scale(data["likelihood"], "likelihood"), impact=_scale(data["impact"], "impact"), owner_id=data["owner_id"],
                              next_review_on=data.get("next_review_on") or core.today() + timedelta(days=90), product_id=data.get("product_id"), supplier_id=data.get("supplier_id"),
                              project_id=data.get("project_id"), links=data.get("links", []), created_by=actor)
    core.event("risk", r.id, "REGISTERED", actor, to_status="IDENTIFIED", note=f"score {r.score}")
    if r.score >= HIGH:
        notify(list(core.users_with_permission("quality.risk.manage") - {actor}) + [r.owner_id], "quality.risk_high", f"High quality risk {r.number}", r.title[:150], ref_type="quality.risk", ref_id=str(r.id))
    return r


@transaction.atomic
def reassess(actor, pk, *, likelihood, impact, note="", residual=False):
    r = core.lock(m.Risk, pk, "Risk")
    if r.status == "CLOSED":
        raise core.bad_state("The risk is closed.")
    l, i = _scale(likelihood, "likelihood"), _scale(impact, "impact")
    if residual:
        r.residual_likelihood, r.residual_impact = l, i
    else:
        r.likelihood, r.impact = l, i
    r.next_review_on = core.today() + timedelta(days=90)
    r.save()
    core.event("risk", r.id, "REASSESSED", actor, note=f"{'residual ' if residual else ''}{l}x{i}; {note}")
    return r


@transaction.atomic
def set_status(actor, pk, *, status, note=""):
    r = core.lock(m.Risk, pk, "Risk")
    if status not in ("MITIGATING", "ACCEPTED", "CLOSED"):
        raise ValidationFailed("status must be MITIGATING, ACCEPTED or CLOSED.", code="invalid_fields")
    if r.status == "CLOSED":
        raise core.bad_state("The risk is closed.")
    if status == "ACCEPTED" and r.score >= HIGH:
        raise DomainError("A high risk cannot be accepted; mitigate it first.", code="high_risk", status_code=409)
    if status == "ACCEPTED" and not note:
        raise ValidationFailed("Record the reason for accepting the risk.", code="invalid_fields")
    if status == "MITIGATING" and not core.open_actions("risk", r.id, ("MITIGATION",)).exists():
        raise ValidationFailed("Assign a mitigation action first.", code="actions_required")
    if status == "CLOSED":
        if m.Action.objects.filter(parent_type="risk", parent_id=r.id, status__in=("OPEN", "DONE")).exists():
            raise DomainError("Every mitigation action must be verified first.", code="actions_unverified", status_code=409)
        if r.residual_score is None:
            raise ValidationFailed("Record the residual risk before closing.", code="residual_required")
    core.set_status(r, "risk", status, actor, status, note=note)
    return r


def list_risks(**f):
    qs = m.Risk.objects.all().order_by("-created_at")
    for k in ("status", "area", "category", "owner_id", "product_id", "supplier_id", "project_id"):
        if f.get(k):
            qs = qs.filter(**{k: f[k]})
    rows = list(qs)
    if f.get("level"):
        rows = [r for r in rows if level(r.score) == f["level"]]
    return rows


def risk_matrix():
    grid = {f"{l}x{i}": 0 for l in range(1, 6) for i in range(1, 6)}
    for r in m.Risk.objects.exclude(status="CLOSED"):
        grid[f"{r.likelihood}x{r.impact}"] += 1
    return grid


def reminders(on):
    n = 0
    for r in m.Risk.objects.exclude(status="CLOSED").filter(next_review_on__lte=on).filter(last_reminder_on__isnull=True) | m.Risk.objects.exclude(status="CLOSED").filter(next_review_on__lte=on, last_reminder_on__lt=on - timedelta(days=6)):
        notify([r.owner_id], "quality.risk_review", f"Risk review due: {r.number}", r.title[:150], ref_type="quality.risk", ref_id=str(r.id))
        r.last_reminder_on = on
        r.save(update_fields=["last_reminder_on"])
        n += 1
    return n


# ----------------------------------------------------------------------------- continuous improvement
def suggestion_dict(s):
    return {"id": str(s.id), "number": s.number, "title": s.title, "description": s.description, "category": s.category, "status": s.status, "submitted_by": str(s.submitted_by), "decision_note": s.decision_note}


@transaction.atomic
def suggest(actor, data):
    core.need(data, "title", "description")
    if data.get("category"):
        core.config_item("IMPROVEMENT_CATEGORY", data["category"])
    s = m.Suggestion.objects.create(number=core.number("quality.suggestion"), title=data["title"][:200], description=data["description"], category=data.get("category", ""), submitted_by=actor)
    core.event("suggestion", s.id, "SUBMITTED", actor, to_status="SUBMITTED")
    notify(list(core.users_with_permission("quality.improvement.manage") - {actor}), "quality.suggestion", f"Improvement suggestion {s.number}", s.title[:150], ref_type="quality.suggestion", ref_id=str(s.id))
    return s


@transaction.atomic
def decide_suggestion(actor, pk, *, accept, note):
    s = core.lock(m.Suggestion, pk, "Suggestion")
    if s.status != "SUBMITTED":
        raise core.bad_state("The suggestion has already been decided.")
    if not note:
        raise ValidationFailed("Give the reason for the decision.", code="invalid_fields")
    s.decision_note, s.decided_by = note[:500], actor
    core.set_status(s, "suggestion", "ACCEPTED" if accept else "REJECTED", actor, "ACCEPTED" if accept else "REJECTED", note=note)
    notify([s.submitted_by], "quality.suggestion_decided", f"Your suggestion {s.number} was {'accepted' if accept else 'declined'}", note[:150], ref_type="quality.suggestion", ref_id=str(s.id))
    return s


def list_suggestions(**f):
    qs = m.Suggestion.objects.all().order_by("-created_at")
    if f.get("status"):
        qs = qs.filter(status=f["status"])
    if f.get("submitted_by"):
        qs = qs.filter(submitted_by=f["submitted_by"])
    return qs


def initiative_dict(i, detail=False):
    d = {"id": str(i.id), "number": i.number, "title": i.title, "status": i.status, "owner_id": str(i.owner_id), "target_date": i.target_date.isoformat(), "progress": i.progress,
         "suggestion_id": str(i.suggestion_id) if i.suggestion_id else None, "objective_id": str(i.objective_id) if i.objective_id else None, "metric": i.metric,
         "baseline_value": str(i.baseline_value) if i.baseline_value is not None else None, "target_value": str(i.target_value) if i.target_value is not None else None,
         "result_value": str(i.result_value) if i.result_value is not None else None}
    if detail:
        d.update({"description": i.description, "lessons_learned": i.lessons_learned, "capa_id": str(i.capa_id) if i.capa_id else None, "actions": core.list_actions("initiative", i.id), "history": core.history("initiative", i.id)})
    return d


def get_initiative(pk):
    i = m.Initiative.objects.filter(pk=pk).first()
    if i is None:
        raise core.nf("Initiative")
    return i


@transaction.atomic
def create_initiative(actor, data):
    core.need(data, "title", "owner_id", "target_date")
    sug = None
    if data.get("suggestion_id"):
        sug = core.lock(m.Suggestion, data["suggestion_id"], "Suggestion")
        if sug.status != "ACCEPTED":
            raise DomainError("Only an accepted suggestion becomes an initiative.", code="suggestion_not_accepted", status_code=409)
    i = m.Initiative.objects.create(number=core.number("quality.initiative"), title=data["title"][:200], description=data.get("description", ""), suggestion=sug, owner_id=data["owner_id"],
                                    target_date=data["target_date"], objective_id=data.get("objective_id"), metric=data.get("metric", ""),
                                    baseline_value=dec(data["baseline_value"]) if data.get("baseline_value") not in (None, "") else None,
                                    target_value=dec(data["target_value"]) if data.get("target_value") not in (None, "") else None, created_by=actor)
    if sug:
        core.set_status(sug, "suggestion", "CONVERTED", actor, "CONVERTED", note=i.number)
    core.event("initiative", i.id, "CREATED", actor, to_status="PROPOSED")
    return i


@transaction.atomic
def initiative_status(actor, pk, *, status, progress=None, result_value=None, lessons_learned="", note=""):
    i = core.lock(m.Initiative, pk, "Initiative")
    if status not in ("APPROVED", "IN_PROGRESS", "COMPLETED", "CANCELLED"):
        raise ValidationFailed("Unknown status.", code="invalid_fields")
    order = {"PROPOSED": 0, "APPROVED": 1, "IN_PROGRESS": 2, "COMPLETED": 3, "CANCELLED": 3}
    if i.status in ("COMPLETED", "CANCELLED") or (status != "CANCELLED" and order[status] <= order[i.status]):
        raise core.bad_state("That status change is not allowed.")
    if status == "APPROVED" and i.created_by == actor:
        raise DomainError("An initiative must be approved by someone other than its creator.", code="separation_of_duties", status_code=403)
    fields = {}
    if progress is not None:
        p = int(progress)
        if not 0 <= p <= 100:
            raise ValidationFailed("progress must be 0-100.", code="invalid_fields")
        fields["progress"] = p
    if status == "COMPLETED":
        if m.Action.objects.filter(parent_type="initiative", parent_id=i.id, status__in=("OPEN", "DONE")).exists():
            raise DomainError("Every action must be verified first.", code="actions_unverified", status_code=409)
        if result_value in (None, "") or not lessons_learned:
            raise ValidationFailed("Record the result and the lessons learned.", code="result_required")
        fields.update(progress=100, result_value=dec(result_value), lessons_learned=lessons_learned, completed_on=core.today())
    if status == "CANCELLED" and not note:
        raise ValidationFailed("Give the reason.", code="invalid_fields")
    core.set_status(i, "initiative", status, actor, status, note=note, **fields)
    return i


def list_initiatives(**f):
    qs = m.Initiative.objects.all().order_by("-created_at")
    for k in ("status", "owner_id"):
        if f.get(k):
            qs = qs.filter(**{k: f[k]})
    return qs
