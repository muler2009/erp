from shared.events.services import register_event
from shared.sequences.models import NumberSequence
from shared.sequences.services import register_default_sequence

register_default_sequence("projects.project", "Projects", "PRJ-{yyyy}-{seq:04d}", NumberSequence.Reset.YEARLY)
register_event("projects.project.status_changed", required=["project", "old", "new"])


from modules.projects import closure  # noqa: E402
from shared.files import services as _files  # noqa: E402


def _no_pending_expenses(project):
    from modules.projects import models as m
    from shared.api.errors import DomainError

    n = m.ProjectExpense.objects.filter(project=project, status="SUBMITTED").count()
    if n:
        raise DomainError(f"{n} expense(s) are still awaiting a decision.", code="expenses_pending")


closure.CHECKS.append(_no_pending_expenses)
_files.register_access_check("projects.expense", lambda u, rid: __import__("modules.projects.costs", fromlist=["x"]).can_read_receipt(u, rid))


def _no_blocking_issues(project):
    from modules.projects import risks

    risks.no_blocking_issues(project)


closure.CHECKS.append(_no_blocking_issues)
