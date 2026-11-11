from shared.events.services import register_event
from shared.files import services as files

register_event("analytics.report.delivered", required=["run"])


def _check(user_id, ref_id):
    from modules.analytics import schedules
    return schedules.file_access(user_id, ref_id)


files.register_access_check("analytics.run", _check)

