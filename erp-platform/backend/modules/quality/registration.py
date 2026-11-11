from shared.events.services import register_event
from shared.sequences.models import NumberSequence
from shared.sequences.services import register_default_sequence
from shared.workflows import services as workflows

Y = NumberSequence.Reset.YEARLY
for code, label, fmt in [
    ("quality.plan", "Quality plans", "QP-{yyyy}-{seq:04d}"),
    ("quality.inspection_plan", "Inspection plans", "IP-{yyyy}-{seq:04d}"),
    ("quality.inspection", "Inspections", "INS-{yyyy}-{seq:05d}"),
    ("quality.hold", "Quality holds", "QH-{yyyy}-{seq:05d}"),
    ("quality.ncr", "Non-conformance reports", "NCR-{yyyy}-{seq:05d}"),
    ("quality.capa", "Corrective and preventive actions", "CAPA-{yyyy}-{seq:04d}"),
    ("quality.audit", "Quality audits", "AUD-{yyyy}-{seq:04d}"),
    ("quality.finding", "Audit findings", "FND-{yyyy}-{seq:05d}"),
    ("quality.scar", "Supplier corrective action requests", "SCAR-{yyyy}-{seq:04d}"),
    ("quality.complaint", "Customer complaints", "CC-{yyyy}-{seq:05d}"),
    ("quality.risk", "Quality risks", "QR-{yyyy}-{seq:04d}"),
    ("quality.suggestion", "Improvement suggestions", "SUG-{yyyy}-{seq:04d}"),
    ("quality.initiative", "Improvement initiatives", "INI-{yyyy}-{seq:04d}"),
    ("quality.inspection_request", "Project inspection requests", "IRQ-{yyyy}-{seq:05d}"),
    ("quality.punch", "Punch list items", "PL-{yyyy}-{seq:05d}"),
]:
    register_default_sequence(code, label, fmt, Y)

register_event("quality.inspection.completed", required=["inspection", "result"])
register_event("quality.hold.placed", required=["hold", "product"])
register_event("quality.hold.released", required=["hold", "product"])
register_event("quality.ncr.closed", required=["ncr"])
register_event("quality.capa.closed", required=["capa"])
register_event("quality.supplier.status_changed", required=["supplier", "status"])


def _outcome(instance):
    from modules.quality import approvals
    approvals.on_outcome(instance)


def _event(instance, event):
    from modules.quality import approvals
    approvals.on_event(instance, event)


for subject in ("quality.plan", "quality.ncr", "quality.capa"):
    workflows.register_subject(subject, on_outcome=_outcome, on_event=_event)


def _guard(product, loc, lot, purpose, dest):
    from modules.quality import holds
    holds.guard_stock(product, lot, purpose)


from modules.inventory import structure as _inv  # noqa: E402

_inv.register_issue_guard(_guard)


def _task_guard(task, new_status):
    from modules.quality import projectqa
    projectqa.task_guard(task, new_status)


from modules.projects import wbs as _wbs  # noqa: E402

_wbs.register_task_guard(_task_guard)


from shared.files import services as _files  # noqa: E402

for _rt in ("ncr", "capa", "inspection", "audit", "complaint", "inspection_request", "equipment", "hold", "scar", "finding", "risk", "initiative", "punch"):
    _files.register_access_check(f"quality.{_rt}", lambda user_id, ref_id: __import__("modules.quality.core", fromlist=["x"])._file_access(user_id, ref_id))
