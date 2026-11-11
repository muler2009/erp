"""Physical verification: scan-based counts against the register, discrepancy investigation and approved resolution."""
from django.db import transaction
from django.utils import timezone

from modules.assets import disposal as disp
from modules.assets import models as m
from modules.assets import services as svc
from shared.api.errors import DomainError, ValidationFailed
from shared.sequences import services as sequences

IN_SERVICE = ("AVAILABLE", "ASSIGNED", "IN_USE", "UNDER_MAINTENANCE", "TRANSFERRED")
RESOLUTIONS = {"MISSING": ("FOUND", "WRITE_OFF_REQUESTED", "CONFIRMED_LOCATION"), "FOUND_ELSEWHERE": ("LOCATION_UPDATED", "CONFIRMED_LOCATION"), "UNEXPECTED": ("LOCATION_UPDATED", "CONFIRMED_LOCATION"), "CONDITION_CHANGED": ("CONDITION_UPDATED", "CONFIRMED_LOCATION")}


def _count(pk, lock=False):
    qs = m.VerificationCount.objects.select_for_update(of=("self",)) if lock else m.VerificationCount.objects
    c = qs.filter(pk=pk).first()
    if c is None:
        raise DomainError("Count not found.", code="not_found", status_code=404)
    return c


@transaction.atomic
def start_count(actor_id, *, name, location_id=None, category_id=None, started_on=None):
    if not (name or "").strip():
        raise ValidationFailed("Name the count.", code="name_required")
    qs = m.Asset.objects.filter(status__in=IN_SERVICE)
    if location_id:
        qs = qs.filter(location_id=location_id)
    if category_id:
        qs = qs.filter(category_id=category_id)
    day = started_on or timezone.now().date()
    c = m.VerificationCount.objects.create(number=sequences.next_number("assets.count", on_date=day, for_type="VerificationCount"), name=name[:160], scope_location_id=location_id, scope_category_id=category_id, started_on=day, created_by=actor_id)
    m.CountLine.objects.bulk_create([m.CountLine(count=c, asset=a, expected_location_id=a.location_id, expected_custodian_id=a.custodian_id) for a in qs])
    return c


@transaction.atomic
def scan(actor_id, count_id, code, *, location_id=None, condition=None):
    c = _count(count_id, lock=True)
    if c.status != "OPEN":
        raise DomainError("This count is no longer open for scanning.", code="invalid_state")
    if condition and condition not in m.CONDITIONS:
        raise ValidationFailed("Unknown condition.", code="invalid_condition")
    a = svc.find_by_code(code)
    if a.status not in IN_SERVICE:
        raise DomainError(f"{a.number} is {a.status} and is not part of a count.", code="asset_not_countable")
    line = m.CountLine.objects.select_for_update().filter(count=c, asset=a).first()
    if line is None:
        line = m.CountLine(count=c, asset=a, expected=False, expected_location_id=a.location_id, expected_custodian_id=a.custodian_id)
    if line.found:
        raise DomainError("This asset was already scanned in this count.", code="already_pending")
    line.found, line.scanned_at, line.scanned_by = True, timezone.now(), actor_id
    line.found_location_id = location_id or c.scope_location_id or a.location_id
    line.found_condition = condition or ""
    if not line.expected:
        line.discrepancy = "UNEXPECTED"
    elif line.found_location_id and line.expected_location_id and line.found_location_id != line.expected_location_id:
        line.discrepancy = "FOUND_ELSEWHERE"
    elif condition and condition != a.condition:
        line.discrepancy = "CONDITION_CHANGED"
    line.save()
    return line


@transaction.atomic
def complete_count(actor_id, count_id):
    c = _count(count_id, lock=True)
    if c.status != "OPEN":
        raise DomainError("Only an open count can be completed.", code="invalid_state")
    missing = m.CountLine.objects.filter(count=c, found__isnull=True, expected=True)
    n = missing.update(found=False, discrepancy="MISSING")
    c.status, c.counted_by = "IN_REVIEW", actor_id
    c.save()
    return {"count": c.number, "missing": n, "discrepancies": m.CountLine.objects.filter(count=c).exclude(discrepancy="").count()}


@transaction.atomic
def resolve(actor_id, line_id, *, resolution, notes):
    line = m.CountLine.objects.select_for_update(of=("self",)).select_related("count", "asset").filter(pk=line_id).first()
    if line is None:
        raise DomainError("Line not found.", code="not_found", status_code=404)
    c = line.count
    if c.status != "IN_REVIEW":
        raise DomainError("Discrepancies are resolved once the count is complete and before it is closed.", code="invalid_state")
    if not line.discrepancy or line.resolution:
        raise DomainError("This line has no open discrepancy.", code="invalid_state")
    if actor_id == c.counted_by:
        raise DomainError("Separation of duties: the person who counted cannot resolve the discrepancies.", code="separation_of_duties", status_code=403)
    if resolution not in RESOLUTIONS[line.discrepancy]:
        raise ValidationFailed(f"A {line.discrepancy} discrepancy can be resolved with: {', '.join(RESOLUTIONS[line.discrepancy])}.", code="invalid_resolution")
    if not (notes or "").strip():
        raise ValidationFailed("Record the outcome of the investigation.", code="notes_required")
    a = svc._get(line.asset_id, lock=True)
    if resolution == "LOCATION_UPDATED":
        svc.update_asset(actor_id, a.id, location_id=line.found_location_id)
    elif resolution == "CONDITION_UPDATED":
        a.condition = line.found_condition
        a.save(update_fields=["condition", "updated_at"])
    elif resolution == "WRITE_OFF_REQUESTED":
        disp.request_disposal(actor_id, a.id, method="WRITE_OFF", reason=f"Missing in count {c.number}: {notes}", count_line_id=line.id)
    elif resolution == "FOUND":
        line.found = True
    line.resolution, line.resolution_notes, line.resolved_by = resolution, notes[:300], actor_id
    line.save()
    svc.log(a, "VERIFICATION_RESOLVED", actor_id=actor_id, count=c.number, discrepancy=line.discrepancy, resolution=resolution)
    return line


@transaction.atomic
def close_count(actor_id, count_id):
    c = _count(count_id, lock=True)
    if c.status != "IN_REVIEW":
        raise DomainError("Only a count in review can be closed.", code="invalid_state")
    if m.CountLine.objects.filter(count=c).exclude(discrepancy="").filter(resolution="").exists():
        raise DomainError("Resolve every discrepancy before closing the count.", code="discrepancies_open")
    c.status, c.closed_by = "CLOSED", actor_id
    c.save()
    return c


@transaction.atomic
def cancel_count(actor_id, count_id):
    c = _count(count_id, lock=True)
    if c.status not in ("OPEN", "IN_REVIEW"):
        raise DomainError("This count is already finished.", code="invalid_state")
    c.status = "CANCELLED"
    c.save(update_fields=["status", "updated_at"])
    return c


def count_report(count_id):
    c = _count(count_id)
    lines = list(m.CountLine.objects.filter(count=c).select_related("asset"))
    disc = [l for l in lines if l.discrepancy]
    return {"count": c.number, "status": c.status, "expected": sum(l.expected for l in lines), "found": sum(1 for l in lines if l.found), "accuracy_percent": None if not sum(l.expected for l in lines) else str(round(100 * sum(1 for l in lines if l.expected and l.found and not l.discrepancy) / sum(l.expected for l in lines), 2)),
            "discrepancies": [{"id": str(l.id), "asset": l.asset.number, "kind": l.discrepancy, "resolution": l.resolution, "notes": l.resolution_notes} for l in disc]}
