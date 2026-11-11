from shared.events.services import register_event
from shared.files import services as _files
from shared.sequences.models import NumberSequence
from shared.sequences.services import register_default_sequence
from shared.workflows.services import register_subject

register_event("assets.depreciation.posted", required=["run_id", "period", "total"])
register_default_sequence("assets.work_order", "Maintenance work orders", "WO-{yyyy}-{seq:05d}", NumberSequence.Reset.YEARLY)
register_default_sequence("assets.breakdown", "Asset breakdowns", "BD-{yyyy}-{seq:05d}", NumberSequence.Reset.YEARLY)
register_default_sequence("assets.disposal", "Asset disposals", "DSP-{yyyy}-{seq:05d}", NumberSequence.Reset.YEARLY)
register_default_sequence("assets.count", "Physical verification counts", "CNT-{yyyy}-{seq:05d}", NumberSequence.Reset.YEARLY)
register_default_sequence("assets.assignment", "Asset assignments", "ASG-{yyyy}-{seq:05d}", NumberSequence.Reset.YEARLY)
register_default_sequence("assets.transfer", "Asset transfers", "ATR-{yyyy}-{seq:05d}", NumberSequence.Reset.YEARLY)
register_default_sequence("assets.capitalization", "Asset capitalization requests", "CAP-{yyyy}-{seq:05d}", NumberSequence.Reset.YEARLY)


def _cap_outcome(instance):
    from modules.assets import acquisition

    acquisition.on_workflow_outcome(instance)


register_subject("assets.capitalization", on_outcome=_cap_outcome)

_files.register_access_check("assets.asset", lambda u, rid: __import__("modules.assets.services", fromlist=["x"]).can_read_documents(u, rid))

_files.register_access_check("assets.inspection", lambda u, rid: __import__("modules.assets.inspections", fromlist=["x"]).can_read_evidence(u, rid))

from modules.assets import services as _svc  # noqa: E402


def _capitalization_check(asset):
    from modules.assets import models as m

    if not m.CapitalizationRequest.objects.filter(asset=asset, status="APPROVED").exists():
        from shared.api.errors import DomainError

        raise DomainError("An approved capitalization request is required before the asset enters the register.", code="capitalization_required")


_svc.ACTIVATION_CHECKS.append(_capitalization_check)
