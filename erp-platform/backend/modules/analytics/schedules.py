"""Scheduled reports. The file is produced with the owner's permissions and goes only to recipients who may see that data."""
import logging
from datetime import timedelta

from django.db import IntegrityError, transaction

from modules.analytics import core, exports, registry, reports
from modules.analytics import models as m
from shared.api.errors import DomainError, ValidationFailed
from shared.files import services as files
from shared.notifications.services import notify

log = logging.getLogger(__name__)
FREQUENCIES = ("DAILY", "WEEKLY", "MONTHLY")


def next_after(freq, weekday, day_of_month, after):
    """First run date strictly after `after`."""
    d = after + timedelta(days=1)
    if freq == "DAILY":
        return d
    if freq == "WEEKLY":
        return d + timedelta(days=(weekday - d.weekday()) % 7)
    month_day = d.replace(day=day_of_month)
    if month_day >= d:
        return month_day
    first_next = (d.replace(day=28) + timedelta(days=4)).replace(day=1)
    return first_next.replace(day=day_of_month)


def sched_dict(s):
    return {"id": str(s.id), "report_id": str(s.report_id), "report": s.report.name, "frequency": s.frequency, "weekday": s.weekday, "day_of_month": s.day_of_month, "fmt": s.fmt,
            "recipients": s.recipients, "next_run_on": s.next_run_on.isoformat(), "last_run_on": s.last_run_on.isoformat() if s.last_run_on else None, "last_status": s.last_status,
            "last_error": s.last_error, "owner_id": str(s.owner_id), "is_active": s.is_active}


def _eligible(user_ids, ds):
    """Recipients who are active members and may see this dataset. Returns (eligible, dropped)."""
    ids = [u for u in dict.fromkeys(str(x) for x in user_ids)]
    members = {str(x) for x in core.active_members(ids)}
    ok, dropped = [], []
    for u in ids:
        (ok if u in members and core.can(u, "analytics.view") and core.can(u, ds.permission) else dropped).append(u)
    return ok, dropped


def _own(actor, pk):
    s = m.Schedule.objects.select_related("report").filter(pk=pk).first()
    if s is None or s.owner_id != actor:
        raise core.nf("Schedule")
    return s


@transaction.atomic
def create(actor, data):
    core.need(data, "report_id", "frequency", "recipients")
    r = reports.get(actor, data["report_id"])
    if r.owner_id != actor:
        raise core.nf("Report")
    freq = data["frequency"]
    if freq not in FREQUENCIES:
        raise ValidationFailed("frequency must be DAILY, WEEKLY or MONTHLY.", code="invalid_fields")
    weekday, dom = data.get("weekday"), data.get("day_of_month")
    if freq == "WEEKLY" and not (isinstance(weekday, int) and 0 <= weekday <= 6):
        raise ValidationFailed("weekday must be 0 (Monday) to 6 (Sunday).", code="invalid_fields")
    if freq == "MONTHLY" and not (isinstance(dom, int) and 1 <= dom <= 28):
        raise ValidationFailed("day_of_month must be 1 to 28.", code="invalid_fields")
    fmt = (data.get("fmt") or "XLSX").upper()
    if fmt not in exports.FORMATS:
        raise ValidationFailed("fmt must be CSV, XLSX or PDF.", code="invalid_format")
    ds = registry.DATASETS[r.dataset]
    ok, dropped = _eligible(data["recipients"], ds)
    if dropped:
        raise ValidationFailed("These recipients are not active members with access to this data: " + ", ".join(dropped), code="recipient_not_allowed")
    s = m.Schedule.objects.create(report=r, frequency=freq, weekday=weekday if freq == "WEEKLY" else None, day_of_month=dom if freq == "MONTHLY" else None, fmt=fmt, recipients=ok,
                                  next_run_on=next_after(freq, weekday, dom, core.today()), owner_id=actor)
    core.audit("analytics.schedule.created", actor, "analytics.schedule", s.id, report=r.id, freq=freq)
    return s


@transaction.atomic
def update(actor, pk, data):
    s = _own(actor, pk)
    for f in ("frequency", "weekday", "day_of_month", "fmt"):
        if f in data:
            setattr(s, f, data[f])
    if s.frequency not in FREQUENCIES or s.fmt.upper() not in exports.FORMATS:
        raise ValidationFailed("Invalid frequency or format.", code="invalid_fields")
    s.fmt = s.fmt.upper()
    if s.frequency == "WEEKLY" and not (isinstance(s.weekday, int) and 0 <= s.weekday <= 6):
        raise ValidationFailed("weekday must be 0 (Monday) to 6 (Sunday).", code="invalid_fields")
    if s.frequency == "MONTHLY" and not (isinstance(s.day_of_month, int) and 1 <= s.day_of_month <= 28):
        raise ValidationFailed("day_of_month must be 1 to 28.", code="invalid_fields")
    if "recipients" in data:
        ok, dropped = _eligible(data["recipients"], registry.DATASETS[s.report.dataset])
        if dropped:
            raise ValidationFailed("These recipients are not active members with access to this data: " + ", ".join(dropped), code="recipient_not_allowed")
        s.recipients = ok
    if "is_active" in data:
        s.is_active = bool(data["is_active"])
    s.next_run_on = next_after(s.frequency, s.weekday, s.day_of_month, core.today())
    s.save()
    return s


@transaction.atomic
def stop(actor, pk):
    s = _own(actor, pk)
    s.is_active = False
    s.last_status = "STOPPED"
    s.save(update_fields=["is_active", "last_status", "updated_at"])
    return s


def list_schedules(user_id):
    return m.Schedule.objects.select_related("report").filter(owner_id=user_id).order_by("next_run_on")


def _fail(s, on, run, message):
    s.last_status, s.last_error, s.last_run_on = "FAILED", message[:300], on
    s.next_run_on = next_after(s.frequency, s.weekday, s.day_of_month, on)
    s.save(update_fields=["last_status", "last_error", "last_run_on", "next_run_on", "updated_at"])
    run.status, run.error = "FAILED", message[:300]
    run.save(update_fields=["status", "error", "updated_at"])
    notify([s.owner_id], "analytics.schedule_failed", f"Scheduled report failed: {s.report.name}", message[:200], ref_type="analytics.schedule", ref_id=str(s.id))
    return run


def run_schedule(s, on=None):
    """One delivery for one day. Running it again for the same day does nothing."""
    on = on or core.today()
    try:
        with transaction.atomic():
            run = m.ReportRun.objects.create(report=s.report, schedule=s, run_date=on, dataset=s.report.dataset, params={}, fmt=s.fmt, requested_by=s.owner_id, status="OK")
    except IntegrityError:
        return None
    try:
        r = s.report
        if not r.is_active:
            return _fail(s, on, run, "The report was archived.")
        if s.owner_id not in core.active_members([s.owner_id]) or not (core.can(s.owner_id, "analytics.export") and core.can(s.owner_id, registry.DATASETS[r.dataset].permission)):
            return _fail(s, on, run, "The owner no longer has access to this data or to exports.")
        recipients, dropped = _eligible(s.recipients, registry.DATASETS[r.dataset])
        if not recipients:
            return _fail(s, on, run, "No recipient is allowed to receive this report any more.")
        _, ds, resolved, rows = reports.run(s.owner_id, r.id, on=on)
        data, ctype, ext = exports.export(rows, s.fmt, r.name, reports.subtitle(ds, resolved))
        name = exports.filename(r.name, ext, on)
        sf = files.upload(s.owner_id, name, data, ref_type="analytics.run", ref_id=str(run.id))
        run.params, run.row_count, run.file_id, run.delivered_to = {k: str(v) for k, v in resolved.items()}, len(rows), sf.id, recipients
        run.error = f"{len(dropped)} recipient(s) skipped: no longer allowed" if dropped else ""
        run.save()
        notify([m_ for m_ in recipients], "analytics.report_ready", f"Report ready: {r.name}", f"{len(rows)} row(s), {s.fmt}", ref_type="analytics.run", ref_id=str(run.id))
        s.last_status, s.last_error, s.last_run_on = "OK", run.error, on
        s.next_run_on = next_after(s.frequency, s.weekday, s.day_of_month, on)
        s.save(update_fields=["last_status", "last_error", "last_run_on", "next_run_on", "updated_at"])
        return run
    except (DomainError, ValidationFailed) as e:
        return _fail(s, on, run, getattr(e, "message", None) or str(e))
    except Exception as e:  # never lose a failure: it is recorded on the run and the owner is told
        log.exception("Scheduled report %s failed", s.id)
        return _fail(s, on, run, f"Unexpected error: {type(e).__name__}")


def run_due(on=None):
    on = on or core.today()
    done = failed = 0
    for s in m.Schedule.objects.select_related("report").filter(is_active=True, next_run_on__lte=on):
        run = run_schedule(s, on)
        if run is None:  # already ran today (e.g. run now): just move the schedule on
            s.next_run_on = next_after(s.frequency, s.weekday, s.day_of_month, on)
            s.save(update_fields=["next_run_on", "updated_at"])
            continue
        done += 1
        failed += 1 if run.status == "FAILED" else 0
    return {"runs": done, "failed": failed}


def run_now(actor, pk):
    s = _own(actor, pk)
    on = core.today()
    if m.ReportRun.objects.filter(schedule=s, run_date=on).exists():
        raise DomainError("This schedule already ran today.", code="already_ran", status_code=409)
    return run_schedule(s, on)


def file_access(user_id, ref_id):
    x = m.ReportRun.objects.filter(pk=ref_id).first()
    if x is None:
        return False
    if str(user_id) not in set(x.delivered_to) and x.requested_by != user_id:
        return False
    ds = registry.DATASETS.get(x.dataset)
    return bool(ds) and core.can(user_id, ds.permission)
