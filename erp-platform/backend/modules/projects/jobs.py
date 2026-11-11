"""Daily housekeeping for one tenant; every step is idempotent."""
from django.db import transaction
from django.utils import timezone

from modules.projects import models as m
from modules.projects import risks
from shared.notifications.services import notify


@transaction.atomic
def _task_and_project_reminders(today):
    sent = 0
    for t in m.Task.objects.select_for_update(of=("self",)).filter(planned_end__lt=today, project__status="ACTIVE").exclude(status__in=("DONE", "CANCELLED")).select_related("project"):
        if t.last_reminder_on and (today - t.last_reminder_on).days < 7:
            continue
        who = {x for x in (t.assignee_id, t.project.manager_id) if x}
        notify(list(who), "projects.task_overdue", f"Overdue: {t.project.code} {t.wbs_code} {t.name[:80]}", f"Planned end {t.planned_end}", ref_type="projects.task", ref_id=str(t.id))
        t.last_reminder_on = today
        t.save(update_fields=["last_reminder_on", "updated_at"])
        sent += 1
    for p in m.Project.objects.select_for_update(of=("self",)).filter(status="ACTIVE", end_on__lt=today):
        if p.last_reminder_on and (today - p.last_reminder_on).days < 7:
            continue
        notify([p.manager_id], "projects.past_end", f"{p.code} is past its planned end ({p.end_on})", "Extend the project dates or close it.", ref_type="projects.project", ref_id=str(p.id))
        p.last_reminder_on = today
        p.save(update_fields=["last_reminder_on", "updated_at"])
        sent += 1
    return sent


def run_daily(today=None):
    today = today or timezone.now().date()
    return {"overdue_reminders": _task_and_project_reminders(today), "register_reminders": risks.run_reminders(today)}
