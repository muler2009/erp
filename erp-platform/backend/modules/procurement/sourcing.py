"""RFQ terms and deadlines, weighted evaluation, tenders (sealed bids opened by a committee), award justification and single-source purchases."""
from datetime import datetime, time
from decimal import ROUND_HALF_UP, Decimal

from django.db import transaction
from django.utils import timezone

from modules.procurement import models as m
from modules.procurement import suppliers as supmod
from platform_core.audit.services import record_tenant_event
from platform_core.organizations import services as org
from shared.api.errors import DomainError, ValidationFailed
from shared.notifications.services import notify
from shared.sequences import services as sequences
from shared.tenancy import current_tenant

ZERO = Decimal("0")
EXTRA = {"closing_at", "payment_terms", "delivery_terms", "terms_text", "criteria", "min_technical_score", "open_to_all", "committee", "estimated_value"}


def clean_criteria(criteria):
    if not criteria:
        return []
    names = set()
    for c in criteria:
        if c.get("type") not in ("FINANCIAL", "TECHNICAL") or not (c.get("name") or "").strip():
            raise ValidationFailed("Each criterion needs a name and a type of FINANCIAL or TECHNICAL.", code="invalid_criteria")
        w = Decimal(str(c.get("weight", -1)))
        if w < 0 or w > 100:
            raise ValidationFailed("Criterion weights must be between 0 and 100.", code="invalid_criteria")
        if c["name"] in names:
            raise ValidationFailed("Criterion names must be unique.", code="invalid_criteria")
        names.add(c["name"])
    if sum(Decimal(str(c["weight"])) for c in criteria) != 100:
        raise ValidationFailed("Criterion weights must add up to 100.", code="invalid_criteria")
    if sum(1 for c in criteria if c["type"] == "FINANCIAL") != 1:
        raise ValidationFailed("Exactly one criterion must be FINANCIAL (price).", code="invalid_criteria")
    return [{"name": c["name"].strip(), "type": c["type"], "weight": str(c["weight"])} for c in criteria]


def clean_rfq(extra):
    bad = set(extra) - EXTRA
    if bad:
        raise ValidationFailed(f"Unknown RFQ attribute '{sorted(bad)[0]}'.", code="unknown_attribute")
    if "criteria" in extra:
        extra["criteria"] = clean_criteria(extra["criteria"])
    if extra.get("closing_at") and isinstance(extra["closing_at"], str):
        extra["closing_at"] = datetime.fromisoformat(extra["closing_at"])
        if timezone.is_naive(extra["closing_at"]):
            extra["closing_at"] = timezone.make_aware(extra["closing_at"])
    if extra.get("committee") is not None:
        extra["committee"] = [str(u) for u in extra["committee"]]
    if extra.get("min_technical_score") is not None and not 0 <= int(extra["min_technical_score"]) <= 100:
        raise ValidationFailed("The minimum technical score must be 0-100.", code="invalid_criteria")
    return extra


def deadline_passed(rfq, now=None):
    now = now or timezone.now()
    if rfq.closing_at:
        return now > rfq.closing_at
    if rfq.due_date:
        return now.date() > rfq.due_date
    return False


def check_can_bid(rfq, supplier_id):
    if rfq.status != "OPEN":
        raise DomainError("This RFQ is not open for quotations.", code="invalid_state_transition")
    if deadline_passed(rfq):
        raise DomainError("The submission deadline has passed.", code="bidding_closed")
    if rfq.suppliers.filter(pk=supplier_id).exists():
        return
    if rfq.open_to_all:
        s = m.Supplier.objects.filter(pk=supplier_id).first()
        if s and s.status == "QUALIFIED" and supmod.effective_standing(s) == "GOOD":
            rfq.suppliers.add(s)
            return
        raise ValidationFailed("Only qualified suppliers in good standing may bid.", code="supplier_not_eligible")
    raise ValidationFailed("That supplier was not invited to this RFQ.", code="supplier_not_invited")


# ------------------------------------------------------------------ tenders
@transaction.atomic
def create_tender(actor_id, *, title, lines, committee, closing_at, criteria, supplier_ids=None, open_to_all=False, requisition_id=None, **extra):
    """A formal tender: bids are sealed until at least two committee members open them together after the closing time."""
    from modules.procurement import services

    committee = [str(u) for u in committee or []]
    if len(set(committee)) < 2:
        raise ValidationFailed("A tender needs a committee of at least two members.", code="committee_required")
    if not criteria:
        raise ValidationFailed("A tender needs weighted evaluation criteria.", code="invalid_criteria")
    if not (supplier_ids or open_to_all):
        raise ValidationFailed("Invite suppliers or make the tender open to all qualified suppliers.", code="invalid_suppliers")
    rfq = services.create_rfq(actor_id, title=title, supplier_ids=supplier_ids or [], lines=None if requisition_id else lines, requisition_id=requisition_id, closing_at=closing_at, criteria=criteria, committee=committee, open_to_all=open_to_all, **extra)
    rfq.kind, rfq.status = "TENDER", "DRAFT"
    rfq.save(update_fields=["kind", "status", "updated_at"])
    return rfq


@transaction.atomic
def publish_tender(actor_id, rfq_id):
    r = m.Rfq.objects.select_for_update().filter(pk=rfq_id, kind="TENDER").first()
    if not r:
        raise DomainError("Tender not found.", code="not_found", status_code=404)
    if r.status != "DRAFT":
        raise DomainError("Only a draft tender can be published.", code="invalid_state_transition")
    if not r.closing_at or r.closing_at <= timezone.now():
        raise ValidationFailed("A tender needs a closing time in the future.", code="invalid_closing")
    r.status = "OPEN"
    r.save(update_fields=["status", "updated_at"])
    for s in r.suppliers.all():
        pass  # suppliers are external parties: invitations are issued outside the system (portal/email integration is out of scope)
    record_tenant_event(current_tenant(), "procurement.tender.published", actor_user_id=actor_id, target_type="Rfq", target_id=r.id, metadata={"number": r.number})
    return r


@transaction.atomic
def close_bidding(actor_id, rfq_id, *, now=None):
    r = m.Rfq.objects.select_for_update().filter(pk=rfq_id).first()
    if not r:
        raise DomainError("RFQ not found.", code="not_found", status_code=404)
    if r.status != "OPEN":
        raise DomainError("Bidding is not open.", code="invalid_state_transition")
    if r.kind == "TENDER" and not deadline_passed(r, now):
        raise DomainError("A tender cannot be closed before its closing time.", code="too_early")
    r.status = "CLOSED"
    r.save(update_fields=["status", "updated_at"])
    return r


@transaction.atomic
def open_bids(actor_id, rfq_id, *, now=None):
    """Each committee member confirms separately; the bids become visible only once two distinct members have opened them."""
    r = m.Rfq.objects.select_for_update().filter(pk=rfq_id, kind="TENDER").first()
    if not r:
        raise DomainError("Tender not found.", code="not_found", status_code=404)
    if r.status == "OPEN" and deadline_passed(r, now):
        r.status = "CLOSED"
    if r.status != "CLOSED":
        raise DomainError("Bids can only be opened after bidding has closed.", code="invalid_state_transition")
    if str(actor_id) not in r.committee:
        raise DomainError("Only tender committee members can open bids.", code="not_committee_member", status_code=403)
    if str(actor_id) in r.opened_by:
        raise DomainError("You have already confirmed the opening.", code="already_confirmed")
    r.opened_by = r.opened_by + [str(actor_id)]
    if len(r.opened_by) >= 2:
        r.opened_at, r.status = timezone.now(), "EVALUATING"
    r.save(update_fields=["status", "opened_by", "opened_at", "updated_at"])
    return r


def bids_visible(r):
    return r.kind != "TENDER" or r.opened_at is not None


@transaction.atomic
def disqualify(actor_id, quotation_id, reason):
    q = m.Quotation.objects.select_for_update().select_related("rfq").filter(pk=quotation_id).first()
    if not q:
        raise DomainError("Quotation not found.", code="not_found", status_code=404)
    if q.rfq.status == "AWARDED":
        raise DomainError("The award has been made.", code="invalid_state_transition")
    if not (reason or "").strip():
        raise ValidationFailed("A reason is required.", code="reason_required")
    q.disqualified, q.disqualification_reason = True, reason[:300]
    q.save(update_fields=["disqualified", "disqualification_reason", "updated_at"])
    return q


# ------------------------------------------------------------------ evaluation
@transaction.atomic
def score_quotation(actor_id, quotation_id, scores, comment=""):
    q = m.Quotation.objects.select_related("rfq").filter(pk=quotation_id).first()
    if not q:
        raise DomainError("Quotation not found.", code="not_found", status_code=404)
    r = q.rfq
    if r.kind == "TENDER":
        if r.status != "EVALUATING":
            raise DomainError("Bids can be scored only after they have been opened.", code="invalid_state_transition")
        if str(actor_id) not in r.committee:
            raise DomainError("Only committee members can score bids.", code="not_committee_member", status_code=403)
    elif r.committee and str(actor_id) not in r.committee:
        raise DomainError("Only the evaluation committee can score quotations.", code="not_committee_member", status_code=403)
    tech = {c["name"] for c in r.criteria if c["type"] == "TECHNICAL"}
    for name, val in scores.items():
        if name not in tech:
            raise ValidationFailed(f"'{name}' is not a technical criterion of this RFQ.", code="unknown_criterion")
        v = int(val)
        if not 0 <= v <= 100:
            raise ValidationFailed("Scores must be between 0 and 100.", code="invalid_score")
        m.QuotationScore.objects.update_or_create(quotation=q, criterion=name, scored_by=actor_id, defaults={"score": v, "comment": comment[:300]})
    return q


def _base_total(q, on_date):
    rate = org.get_rate(q.currency, on_date)
    return sum((ql.unit_price * rate * ql.rfq_line.quantity for ql in q.lines.select_related("rfq_line")), ZERO)


def evaluation(rfq_id, on_date=None):
    """Weighted ranking. Financial score = lowest price / this price x 100; technical scores average the evaluators' marks."""
    r = m.Rfq.objects.filter(pk=rfq_id).first()
    if not r:
        raise DomainError("RFQ not found.", code="not_found", status_code=404)
    on_date = on_date or timezone.now().date()
    quotes = list(r.quotations.select_related("supplier"))
    if not bids_visible(r):
        raise DomainError("Bids are sealed until the committee opens them.", code="bids_sealed", status_code=403)
    totals = {q.id: _base_total(q, on_date) for q in quotes}
    eligible = [q for q in quotes if not q.disqualified]
    lowest = min((totals[q.id] for q in eligible if totals[q.id] > 0), default=None)
    rows = []
    for q in quotes:
        detail, total_score = {}, ZERO
        reasons = [q.disqualification_reason] if q.disqualified else []
        for c in r.criteria:
            w = Decimal(c["weight"])
            if c["type"] == "FINANCIAL":
                sc = (lowest / totals[q.id] * 100) if lowest and totals[q.id] > 0 else ZERO
            else:
                marks = [s.score for s in q.scores.filter(criterion=c["name"])]
                sc = Decimal(sum(marks)) / len(marks) if marks else ZERO
            detail[c["name"]] = str(sc.quantize(Decimal("0.01"), ROUND_HALF_UP))
            total_score += sc * w / 100
            if c["type"] == "TECHNICAL" and r.min_technical_score is not None and sc < r.min_technical_score:
                reasons.append(f"{c['name']} below the minimum of {r.min_technical_score}")
        rows.append({"quotation": str(q.id), "supplier": q.supplier.name, "total_base": str(totals[q.id].quantize(Decimal("0.01"))), "scores": detail, "weighted_score": total_score.quantize(Decimal("0.01"), ROUND_HALF_UP), "compliant": not reasons, "issues": reasons})
    ok = sorted([x for x in rows if x["compliant"]], key=lambda x: (-x["weighted_score"], Decimal(x["total_base"])))
    for i, x in enumerate(ok, start=1):
        x["rank"] = i
    for x in rows:
        x.setdefault("rank", None)
        x["weighted_score"] = str(x["weighted_score"])
    return {"rfq": r.number, "criteria": r.criteria, "results": sorted(rows, key=lambda x: (x["rank"] is None, x["rank"] or 0)), "recommended": ok[0]["quotation"] if ok else None}


@transaction.atomic
def award(actor_id, rfq_id, quotation_id, *, justification="", order_date=None):
    """Award with the checks a formal process needs: no disqualified/non-compliant winner, a justification when the winner is not the
    recommended bid, and for tenders a creator/awarder split plus an evaluated committee."""
    from modules.procurement import services

    r = m.Rfq.objects.select_for_update().filter(pk=rfq_id).first()
    if not r:
        raise DomainError("RFQ not found.", code="not_found", status_code=404)
    q = m.Quotation.objects.filter(pk=quotation_id, rfq=r).first()
    if not q:
        raise DomainError("Quotation not found.", code="not_found", status_code=404)
    if q.disqualified:
        raise DomainError("A disqualified bid cannot be awarded.", code="disqualified")
    if r.kind == "TENDER":
        if r.status != "EVALUATING":
            raise DomainError("A tender is awarded after its bids have been opened and evaluated.", code="invalid_state_transition")
        if r.created_by == actor_id:
            raise DomainError("Separation of duties: the tender's creator cannot award it.", code="separation_of_duties", status_code=403)
    if r.criteria:
        ev = evaluation(r.id)
        row = next(x for x in ev["results"] if x["quotation"] == str(q.id))
        if not row["compliant"] and not justification.strip():
            raise DomainError("This bid does not meet the evaluation requirements; a justification is required.", code="justification_required")
        recommended = ev["recommended"]
    else:
        cmp = services.compare_bids(r.id, order_date)
        recommended = cmp["lowest_total"]
    if recommended and recommended != str(q.id) and not justification.strip():
        raise DomainError("Awarding a bid other than the recommended one needs a written justification.", code="justification_required")
    r.award_justification = justification[:500]
    if r.kind == "TENDER":
        r.status = "OPEN"  # services.award_rfq closes it as AWARDED
    r.save(update_fields=["award_justification", "status", "updated_at"])
    po = services.award_rfq(actor_id, r.id, quotation_id, order_date=order_date)
    for other in r.quotations.exclude(pk=q.pk).select_related("supplier"):
        record_tenant_event(current_tenant(), "procurement.rfq.unsuccessful", actor_user_id=actor_id, target_type="Quotation", target_id=other.id, metadata={"supplier": other.supplier.name})
    return po


def bidder_results(rfq_id):
    """Outcome per bidder for debriefing unsuccessful suppliers."""
    r = m.Rfq.objects.filter(pk=rfq_id).first()
    if not r or r.status != "AWARDED":
        raise DomainError("Results are available once the RFQ is awarded.", code="not_awarded")
    ev = evaluation(r.id) if r.criteria else None
    ranks = {x["quotation"]: x for x in ev["results"]} if ev else {}
    return [{"supplier": q.supplier.name, "outcome": "AWARDED" if q.is_awarded else "DISQUALIFIED" if q.disqualified else "NOT_SELECTED", "rank": ranks.get(str(q.id), {}).get("rank"), "weighted_score": ranks.get(str(q.id), {}).get("weighted_score"), "reason": q.disqualification_reason} for q in r.quotations.select_related("supplier")]


# ------------------------------------------------------------------ clarifications
@transaction.atomic
def ask(actor_id, rfq_id, *, supplier_id, question):
    r = m.Rfq.objects.filter(pk=rfq_id).first()
    if not r or r.status not in ("OPEN",):
        raise DomainError("Questions can be asked while bidding is open.", code="invalid_state_transition")
    if not r.suppliers.filter(pk=supplier_id).exists() and not r.open_to_all:
        raise ValidationFailed("That supplier is not a bidder on this RFQ.", code="supplier_not_invited")
    if not (question or "").strip():
        raise ValidationFailed("A question is required.", code="invalid_question")
    return m.RfqClarification.objects.create(rfq=r, supplier_id=supplier_id, question=question[:500])


@transaction.atomic
def answer(actor_id, clarification_id, text):
    c = m.RfqClarification.objects.select_for_update().filter(pk=clarification_id).first()
    if not c:
        raise DomainError("Clarification not found.", code="not_found", status_code=404)
    if not (text or "").strip():
        raise ValidationFailed("An answer is required.", code="invalid_answer")
    c.answer, c.answered_by = text[:1000], actor_id
    c.save(update_fields=["answer", "answered_by", "updated_at"])
    return c


# ------------------------------------------------------------------ single source
@transaction.atomic
def single_source_po(actor_id, *, supplier_id, currency, order_date, lines, justification, **kw):
    """Direct purchase without competition: allowed only with a written justification, flagged on the order and in the audit trail."""
    from modules.procurement import services

    if len((justification or "").strip()) < 20:
        raise ValidationFailed("A single-source purchase needs a written justification (at least 20 characters).", code="justification_required")
    po = services.create_po(actor_id, supplier_id=supplier_id, currency=currency, order_date=order_date, lines=lines, **kw)
    po.single_source, po.single_source_justification = True, justification[:500]
    po.save(update_fields=["single_source", "single_source_justification", "updated_at"])
    record_tenant_event(current_tenant(), "procurement.po.single_source", actor_user_id=actor_id, target_type="PurchaseOrder", target_id=po.id, metadata={"number": po.number, "justification": justification[:200]})
    return po


def single_source_report():
    return [{"po": o.number, "supplier": o.supplier.name, "total": str(o.total), "currency": o.currency, "justification": o.single_source_justification, "status": o.status} for o in m.PurchaseOrder.objects.select_related("supplier").filter(single_source=True).order_by("-created_at")]
