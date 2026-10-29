from shared.events.services import register_event
from shared.sequences.models import NumberSequence
from shared.sequences.services import register_default_sequence
from shared.workflows.services import register_subject

R = NumberSequence.Reset
register_default_sequence("hr.employee", "Employee numbers", "EMP-{seq:05d}", R.NEVER)
register_default_sequence("hr.requisition", "Job requisitions", "REQ-{yyyy}-{seq:04d}", R.YEARLY)
register_default_sequence("hr.payroll", "Payroll runs", "PR-{yyyy}-{seq:04d}", R.YEARLY)

register_event("hr.employee.created", required=["employee_id", "employee_no"])
register_event("hr.employee.terminated", required=["employee_id", "termination_date"])
register_event("hr.payroll.posted", required=["run_id", "number", "net_total"])
register_event("hr.payroll.paid", required=["run_id", "number", "net_total"])
register_event("hr.payroll.reversed", required=["run_id", "number"])

from modules.hr import services  # noqa: E402

register_subject("hr.leave", on_outcome=lambda instance: services._on_leave_outcome(instance))
register_subject("hr.payroll", on_outcome=lambda instance: services._on_payroll_outcome(instance))
