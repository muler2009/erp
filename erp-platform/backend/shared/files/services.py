"""Secure file storage. Content type is decided by sniffing the bytes against an allowlist, names never reach
the filesystem (random keys), downloads are always attachments with nosniff, and access is checked per file:
owner, `files.manage`, or the owning module's registered access check for the record the file belongs to."""
import hashlib
import os
import re
import unicodedata
import uuid
import zipfile
from io import BytesIO
from pathlib import Path

from django.conf import settings
from django.core import signing
from django.db import connection, transaction
from django.utils import timezone
from django.utils.module_loading import import_string

from platform_core.audit.services import record_tenant_event
from platform_core.authorization import services as authz
from shared.api.errors import DomainError, ValidationFailed
from shared.tenancy import current_tenant
from shared.files.models import StoredFile

LINK_SALT = "erp.files.link"

# extension -> (content type, sniffer name). Anything not listed is refused (SVG/HTML/JS/executables included).
ALLOWED = {
    "pdf": ("application/pdf", "pdf"), "png": ("image/png", "png"), "jpg": ("image/jpeg", "jpeg"), "jpeg": ("image/jpeg", "jpeg"),
    "gif": ("image/gif", "gif"), "txt": ("text/plain", "text"), "csv": ("text/csv", "text"),
    "docx": ("application/vnd.openxmlformats-officedocument.wordprocessingml.document", "ooxml:word/"),
    "xlsx": ("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "ooxml:xl/"),
    "pptx": ("application/vnd.openxmlformats-officedocument.presentationml.presentation", "ooxml:ppt/"),
}
MAX_ZIP_ENTRIES = 5000
MAX_UNCOMPRESSED = 200 * 1024 * 1024

_ACCESS_CHECKS = {}  # ref_type -> callable(user_id, ref_id) -> bool
_SCANNERS = []  # callables(data: bytes, filename: str) that raise ValidationFailed to reject (e.g. a ClamAV adapter)


def register_access_check(ref_type, checker):
    """The module that owns `ref_type` decides who may read files attached to its records."""
    _ACCESS_CHECKS[ref_type] = checker


def register_scanner(scanner):
    _SCANNERS.append(scanner)


# ----------------------------------------------------------------------------- storage backend
class LocalStorage:
    """Filesystem storage under FILE_STORAGE_ROOT/<tenant schema>/. Keys are server-generated UUID paths."""

    def __init__(self, root=None):
        self.root = Path(root or settings.FILE_STORAGE_ROOT).resolve()

    def _path(self, key):
        path = (self.root / key).resolve()
        if self.root not in path.parents:
            raise ValueError("storage key escapes the storage root")
        return path

    def save(self, key, data):
        path = self._path(key)
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(".tmp")
        tmp.write_bytes(data)
        os.replace(tmp, path)

    def open(self, key):
        return self._path(key).open("rb")

    def delete(self, key):
        self._path(key).unlink(missing_ok=True)


def get_storage():
    cls = getattr(settings, "FILE_STORAGE_CLASS", None)
    return import_string(cls)() if cls else LocalStorage()


# ----------------------------------------------------------------------------- validation
def sanitize_name(name):
    name = unicodedata.normalize("NFKC", name or "")
    name = name.replace("\\", "/").split("/")[-1]
    name = re.sub(r"[\x00-\x1f\x7f]", "", name).strip().strip(".")
    return (name or "file")[:200]


def _sniff(kind, data):
    if kind == "pdf":
        return data[:5] == b"%PDF-"
    if kind == "png":
        return data[:8] == b"\x89PNG\r\n\x1a\n"
    if kind == "jpeg":
        return data[:3] == b"\xff\xd8\xff"
    if kind == "gif":
        return data[:6] in (b"GIF87a", b"GIF89a")
    if kind == "text":
        if b"\x00" in data:
            return False
        try:
            data.decode("utf-8")
        except UnicodeDecodeError:
            return False
        return True
    if kind.startswith("ooxml:"):
        try:
            with zipfile.ZipFile(BytesIO(data)) as zf:
                infos = zf.infolist()
                if len(infos) > MAX_ZIP_ENTRIES or sum(i.file_size for i in infos) > MAX_UNCOMPRESSED:
                    return False  # zip-bomb guard
                names = zf.namelist()
                if any(n.startswith("/") or ".." in n.split("/") for n in names):
                    return False
                return "[Content_Types].xml" in names and any(n.startswith(kind.split(":", 1)[1]) for n in names)
        except zipfile.BadZipFile:
            return False
    return False


def validate_upload(filename, data):
    name = sanitize_name(filename)
    if not data:
        raise ValidationFailed("The file is empty.", code="empty_file")
    if len(data) > settings.FILE_MAX_BYTES:
        raise ValidationFailed("The file is too large.", code="file_too_large")
    ext = name.rsplit(".", 1)[-1].lower() if "." in name else ""
    if ext not in ALLOWED:
        raise ValidationFailed("This file type is not allowed.", code="file_type_not_allowed")
    content_type, kind = ALLOWED[ext]
    if not _sniff(kind, data):
        raise ValidationFailed("The file content does not match its extension.", code="file_content_mismatch")
    if kind == "text" and ext == "csv":  # spreadsheet formula injection is handled on export; here just ensure text
        pass
    for scanner in _SCANNERS:
        scanner(data, name)
    return name, content_type


# ----------------------------------------------------------------------------- operations
@transaction.atomic
def upload(actor_id, filename, data, *, ref_type="", ref_id="", request=None):
    name, content_type = validate_upload(filename, data)
    tenant = current_tenant()
    key = f"{tenant.schema_name}/{uuid.uuid4().hex[:2]}/{uuid.uuid4().hex}"
    row = StoredFile.objects.create(original_name=name, content_type=content_type, size=len(data), sha256=hashlib.sha256(data).hexdigest(), storage_key=key, owner_id=actor_id, ref_type=ref_type[:60], ref_id=str(ref_id)[:64])
    get_storage().save(key, data)  # if the write fails the transaction rolls back and no row is left behind
    record_tenant_event(tenant, "file.uploaded", actor_user_id=actor_id, target_type="StoredFile", target_id=row.id, metadata={"name": name, "size": len(data), "sha256": row.sha256}, request=request)
    return row


def can_access(user_id, file):
    if file.status != StoredFile.Status.ACTIVE:
        return False
    if file.owner_id == user_id or authz.has_permission(user_id, "files.manage"):
        return True
    checker = _ACCESS_CHECKS.get(file.ref_type)
    return bool(checker and file.ref_id and checker(user_id, file.ref_id))


def get_for_user(user_id, file_id):
    file = StoredFile.objects.filter(pk=file_id).first()
    if file is None or not can_access(user_id, file):
        raise DomainError("File not found.", code="not_found", status_code=404)  # same answer for missing and forbidden
    return file


def read_for_user(user_id, file_id, *, request=None):
    file = get_for_user(user_id, file_id)
    record_tenant_event(current_tenant(), "file.downloaded", actor_user_id=user_id, target_type="StoredFile", target_id=file.id, request=request)
    return file, get_storage().open(file.storage_key)


def issue_link(user_id, file_id):
    """Short-lived link bound to this tenant, this file and this user."""
    file = get_for_user(user_id, file_id)
    token = signing.dumps({"f": str(file.id), "u": str(user_id), "s": connection.schema_name}, salt=LINK_SALT)
    return token, settings.FILE_LINK_TTL_SECONDS


def redeem_link(token, user_id):
    try:
        data = signing.loads(token, salt=LINK_SALT, max_age=settings.FILE_LINK_TTL_SECONDS)
    except signing.BadSignature:
        raise DomainError("File not found.", code="not_found", status_code=404)
    if data.get("s") != connection.schema_name or data.get("u") != str(user_id):
        raise DomainError("File not found.", code="not_found", status_code=404)
    return read_for_user(user_id, data["f"])


@transaction.atomic
def delete(actor_id, file_id, *, request=None):
    file = StoredFile.objects.select_for_update().filter(pk=file_id).first()
    if file is None or file.status != StoredFile.Status.ACTIVE or not (file.owner_id == actor_id or authz.has_permission(actor_id, "files.manage")):
        raise DomainError("File not found.", code="not_found", status_code=404)
    file.status, file.deleted_at = StoredFile.Status.DELETED, timezone.now()
    file.save(update_fields=["status", "deleted_at"])
    record_tenant_event(current_tenant(), "file.deleted", actor_user_id=actor_id, target_type="StoredFile", target_id=file.id, request=request)
    return file


def purge_deleted(retention_days=None, now=None):
    """Remove blobs and rows deleted longer than the retention period ago."""
    days = settings.FILE_RETENTION_DAYS if retention_days is None else retention_days
    from datetime import timedelta

    cutoff = (now or timezone.now()) - timedelta(days=days)
    storage, count = get_storage(), 0
    for file in StoredFile.objects.filter(status=StoredFile.Status.DELETED, deleted_at__lt=cutoff):
        storage.delete(file.storage_key)
        file.delete()
        count += 1
    return count
