from shared.events.services import register_event
from shared.files import services as files
from shared.sequences.models import NumberSequence
from shared.sequences.services import register_default_sequence
from shared.workflows import services as workflows

register_default_sequence("documents.transmittal", "Document transmittals", "TR-{yyyy}-{seq:04d}", NumberSequence.Reset.YEARLY)
register_default_sequence("documents.rfi", "Requests for information", "RFI-{yyyy}-{seq:04d}", NumberSequence.Reset.YEARLY)
register_event("documents.version.published", required=["document", "version"])
register_event("documents.document.obsoleted", required=["document"])


def _outcome(instance):
    from modules.documents import approval
    approval.on_outcome(instance)


def _event(instance, event):
    from modules.documents import approval
    approval.on_event(instance, event)


def _file_access(user_id, ref_id):
    from modules.documents import access
    return access.can_read_version_file(user_id, ref_id)


workflows.register_subject("documents.version", on_outcome=_outcome, on_event=_event)
files.register_access_check("documents.version", _file_access)
