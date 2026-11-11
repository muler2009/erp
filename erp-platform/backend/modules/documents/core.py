"""Document registration, versions, links, templates and file access."""
import re
import zipfile
from datetime import timedelta
from io import BytesIO

from django.db import IntegrityError, transaction
from django.utils import timezone

from modules.documents import access
from modules.documents import models as m
from platform_core.audit.services import record_tenant_event
from platform_core.organizations import services as org
from platform_core.users.models import TenantMembership
from shared.api.errors import DomainError, ValidationFailed
from shared.files import services as files
from shared.files.models import StoredFile
from shared.tenancy import current_tenant

DEFAULT_CLASSES = (("PUBLIC", "Public", 1), ("INTERNAL", "Internal", 2), ("CONFIDENTIAL", "Confidential", 3), ("RESTRICTED", "Restricted", 4))
EDITABLE_VERSION = ("DRAFT", "CHANGES_REQUESTED")
MAX_TEXT = 200_000


def audit(action, actor, target_type, target_id, **meta):
    record_tenant_event(current_tenant(), action, actor_user_id=actor, target_type=target_type, target_id=target_id, metadata={k: str(v) for k, v in meta.items()})


def nf(label="Document"):
    return DomainError(f"{label} not found.", code="not_found", status_code=404)


def event(doc, action, actor, *, version=None, from_status="", to_status="", note=""):
    return m.DocumentEvent.objects.create(document=doc, version=version, action=action, actor_id=actor, from_status=from_status, to_status=to_status, note=(note or "")[:500])


def set_status(doc, to, actor, action, *, version=None, note=""):
    old = doc.status
    doc.status = to
    doc.save(update_fields=["status", "updated_at"])
    event(doc, action, actor, version=version, from_status=old, to_status=to, note=note)


def ensure_defaults():
    if not m.Classification.objects.exists():
        for code, name, rank in DEFAULT_CLASSES:
            m.Classification.objects.get_or_create(code=code, defaults={"name": name, "rank": rank})


def lock_doc(pk):
    d = m.Document.objects.select_for_update().select_related("category", "classification").filter(pk=pk, deleted_at__isnull=True).first()
    if d is None:
        raise nf()
    return d


def get_doc(user_id, pk, action="VIEW"):
    """Same answer for missing and forbidden so references can't be probed."""
    d = m.Document.objects.select_related("category", "classification", "current_version").filter(pk=pk, deleted_at__isnull=True, disposed_at__isnull=True).first()
    if d is None or not access.can(user_id, d, "VIEW"):
        raise nf()
    if action != "VIEW" and not access.can(user_id, d, action):
        raise DomainError("You are not allowed to do that with this document.", code="forbidden", status_code=403)
    return d


# ----------------------------------------------------------------------------- configuration
@transaction.atomic
def create_category(actor, *, code, name, number_prefix, doc_type="OTHER", parent_id=None, number_padding=4, is_controlled=True, requires_expiry=False,
                    review_interval_days=None, retention_years=None, default_classification=None, required_metadata=None):
    ensure_defaults()
    if doc_type not in m.DOC_TYPES or not re.fullmatch(r"[A-Z0-9][A-Z0-9-]{0,11}", number_prefix or ""):
        raise ValidationFailed("A valid document type and a number prefix (capitals, digits, dashes) are required.", code="invalid_fields")
    if not (code or "").strip() or not (name or "").strip() or not 1 <= int(number_padding) <= 8:
        raise ValidationFailed("A code and a name are required.", code="invalid_fields")
    if parent_id and not m.Category.objects.filter(pk=parent_id).exists():
        raise ValidationFailed("Unknown parent category.", code="invalid_parent")
    cls = m.Classification.objects.filter(code=default_classification).first() if default_classification else m.Classification.objects.get(code="INTERNAL")
    if cls is None:
        raise ValidationFailed("Unknown classification.", code="invalid_classification")
    for k, v in (("review_interval_days", review_interval_days), ("retention_years", retention_years)):
        if v is not None and int(v) <= 0:
            raise ValidationFailed(f"{k} must be positive.", code="invalid_fields")
    try:
        with transaction.atomic():
            c = m.Category.objects.create(code=code.strip()[:20], name=name.strip()[:120], parent_id=parent_id, doc_type=doc_type, number_prefix=number_prefix, number_padding=int(number_padding), is_controlled=is_controlled,
                                          requires_expiry=requires_expiry, review_interval_days=review_interval_days, retention_years=retention_years, default_classification=cls, required_metadata=list(required_metadata or []))
    except IntegrityError:
        raise DomainError("A category with this code exists.", code="duplicate_code")
    audit("documents.category.created", actor, "Category", c.id)
    return c


@transaction.atomic
def update_category(actor, pk, **f):
    c = m.Category.objects.select_for_update().filter(pk=pk).first()
    if c is None:
        raise nf("Category")
    for k in ("name", "number_padding", "is_controlled", "requires_expiry", "review_interval_days", "retention_years", "required_metadata", "is_active"):
        if k in f:
            setattr(c, k, f[k])
    if "default_classification" in f:
        cls = m.Classification.objects.filter(code=f["default_classification"]).first()
        if cls is None:
            raise ValidationFailed("Unknown classification.", code="invalid_classification")
        c.default_classification = cls
    c.save()
    audit("documents.category.updated", actor, "Category", c.id)
    return c


@transaction.atomic
def create_folder(actor, *, name, parent_id=None, department_id=None, project_id=None):
    if not (name or "").strip() or "/" in name:
        raise ValidationFailed("A folder name without slashes is required.", code="invalid_fields")
    if parent_id and not m.Folder.objects.filter(pk=parent_id, is_active=True).exists():
        raise ValidationFailed("Unknown parent folder.", code="invalid_parent")
    if project_id:
        _validate_link("PROJECT", str(project_id))
    try:
        with transaction.atomic():
            return m.Folder.objects.create(name=name.strip()[:120], parent_id=parent_id, department_id=department_id, project_id=project_id)
    except IntegrityError:
        raise DomainError("A folder with this name exists here.", code="duplicate_name")


# ----------------------------------------------------------------------------- links
def _model_exists(path, name):
    def check(ref):
        import importlib
        mod = importlib.import_module(path)
        return getattr(mod, name).objects.filter(pk=ref).exists()
    return check


LINK_VALIDATORS = {
    "PROJECT": _model_exists("modules.projects.models", "Project"), "TASK": _model_exists("modules.projects.models", "Task"),
    "SUPPLIER": _model_exists("modules.procurement.models", "Supplier"), "CUSTOMER": _model_exists("modules.crm.models", "CrmAccount"),
    "EMPLOYEE": _model_exists("modules.hr.models", "Employee"), "ASSET": _model_exists("modules.assets.models", "Asset"),
    "PRODUCT": _model_exists("modules.inventory.models", "Product"),
    "PROCESS": None, "LOCATION": None, "CONTRACT": None,  # free references
}


def register_link_type(code, validator):
    """Other modules (quality, manufacturing...) make their records linkable to documents."""
    LINK_VALIDATORS[code] = validator


def _validate_link(link_type, ref_id):
    if link_type not in LINK_VALIDATORS:
        raise ValidationFailed("Unknown link type.", code="invalid_link_type")
    check = LINK_VALIDATORS[link_type]
    if check is not None:
        try:
            ok = check(ref_id)
        except (ValueError, Exception):
            ok = False
        if not ok:
            raise ValidationFailed(f"Unknown {link_type.lower()}.", code="invalid_link")


@transaction.atomic
def add_link(actor, doc_id, link_type, ref_id, label=""):
    d = lock_doc(doc_id)
    if not access.can(actor, d, "EDIT") or d.status == "ARCHIVED":
        raise nf()
    ref_id = str(ref_id or "")[:64]
    if not ref_id:
        raise ValidationFailed("ref_id is required.", code="invalid_fields")
    _validate_link(link_type, ref_id)
    if link_type == "PROJECT" and not d.project_id:
        d.project_id = ref_id
        d.save(update_fields=["project_id", "updated_at"])
    row, created = m.DocumentLink.objects.get_or_create(document=d, link_type=link_type, ref_id=ref_id, defaults={"label": label[:200], "created_by": actor})
    if created:
        event(d, "LINKED", actor, note=f"{link_type} {ref_id}")
    return row


@transaction.atomic
def remove_link(actor, link_id):
    row = m.DocumentLink.objects.select_related("document").filter(pk=link_id).first()
    if row is None or not access.can(actor, row.document, "EDIT") or row.document.status == "ARCHIVED":
        raise nf("Link")
    event(row.document, "UNLINKED", actor, note=f"{row.link_type} {row.ref_id}")
    row.delete()


# ----------------------------------------------------------------------------- text index
def extract_text(filename, data):
    """Plain text for search: text files and Word documents. Other formats are not indexed."""
    ext = filename.rsplit(".", 1)[-1].lower() if "." in filename else ""
    try:
        if ext in ("txt", "csv"):
            return data.decode("utf-8", "ignore")[:MAX_TEXT]
        if ext in ("docx", "xlsx", "pptx"):
            part = {"docx": "word/document.xml", "xlsx": "xl/sharedStrings.xml"}.get(ext)
            with zipfile.ZipFile(BytesIO(data)) as zf:
                names = [part] if part and part in zf.namelist() else [n for n in zf.namelist() if n.startswith("ppt/slides/slide")]
                raw = " ".join(zf.read(n).decode("utf-8", "ignore") for n in names)
            return re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", raw))[:MAX_TEXT]
    except Exception:
        return ""
    return ""


# ----------------------------------------------------------------------------- versions
def _label(doc, number, change_type):
    if org.get_setting("documents.version_scheme", "MAJOR_MINOR") == "SEQUENTIAL":
        return str(number)
    last = doc.versions.order_by("-number").first()
    if last is None:
        return "1.0"
    major, _, minor = last.label.partition(".")
    major, minor = int(major or 1), int(minor or 0)
    return f"{major}.{minor + 1}" if change_type == "MINOR" else f"{major + 1}.0"


def _attach_file(actor, version, filename, data):
    f = files.upload(actor, filename, data, ref_type="documents.version", ref_id=str(version.id))
    version.file_id, version.file_name, version.sha256, version.size = f.id, f.original_name, f.sha256, f.size
    version.save(update_fields=["file_id", "file_name", "sha256", "size", "updated_at"])
    text = extract_text(f.original_name, data)
    m.VersionText.objects.update_or_create(version=version, defaults={"content": text})
    return f


def _release_file(version):
    if version.file_id:
        StoredFile.objects.filter(pk=version.file_id).update(status="DELETED", deleted_at=timezone.now())


def _new_version(actor, doc, *, change_reason, change_type="MAJOR", file=None):
    number = (doc.versions.order_by("-number").values_list("number", flat=True).first() or 0) + 1
    v = m.DocumentVersion(document=doc, number=number, label=_label(doc, number, change_type), change_reason=(change_reason or "")[:500], created_by=actor)
    v.save()
    if file:
        _attach_file(actor, v, *file)
    event(doc, "VERSION_CREATED", actor, version=v, note=f"{v.label}: {change_reason or ''}")
    return v


def _check_dates(effective, expiry):
    if effective and expiry and expiry < effective:
        raise ValidationFailed("The expiry date cannot be before the effective date.", code="invalid_dates")


def _check_metadata(category, metadata):
    missing = [k for k in category.required_metadata if not str((metadata or {}).get(k, "")).strip()]
    if missing:
        raise ValidationFailed(f"Required metadata missing: {', '.join(missing)}.", code="metadata_required")


def _check_user(user_id):
    if not TenantMembership.objects.filter(tenant=current_tenant(), user_id=user_id, status="ACTIVE").exists():
        raise ValidationFailed("The owner must be an active member.", code="invalid_owner")


@transaction.atomic
def register_document(actor, *, title, category_id, owner_id=None, folder_id=None, classification=None, department_id=None, project_id=None, description="", origin="",
                       tags=None, metadata=None, effective_date=None, expiry_date=None, reference=None, direction="INTERNAL", is_template=False, links=None, file=None, change_reason="Initial issue"):
    ensure_defaults()
    cat = m.Category.objects.select_for_update().filter(pk=category_id, is_active=True).first()
    if cat is None or not (title or "").strip():
        raise ValidationFailed("A title and an active category are required.", code="invalid_fields")
    if direction not in ("INTERNAL", "INCOMING", "OUTGOING"):
        raise ValidationFailed("Invalid direction.", code="invalid_fields")
    owner_id = owner_id or actor
    _check_user(owner_id)
    cls = m.Classification.objects.filter(code=classification, is_active=True).first() if classification else (cat.default_classification or m.Classification.objects.get(code="INTERNAL"))
    if cls is None:
        raise ValidationFailed("Unknown classification.", code="invalid_classification")
    folder = None
    if folder_id:
        folder = m.Folder.objects.filter(pk=folder_id, is_active=True).first()
        if folder is None:
            raise ValidationFailed("Unknown folder.", code="invalid_folder")
        department_id = department_id or folder.department_id
        project_id = project_id or folder.project_id
    if project_id:
        _validate_link("PROJECT", str(project_id))
    _check_dates(effective_date, expiry_date)
    if tags is not None and (not isinstance(tags, list) or any(not isinstance(t, str) for t in tags)):
        raise ValidationFailed("tags must be a list of strings.", code="invalid_fields")
    if reference:
        ref = reference.strip()[:40]
        if m.Document.objects.filter(reference=ref).exists():
            raise DomainError("This document reference is already used.", code="duplicate_reference")
    else:
        cat.counter += 1
        cat.save(update_fields=["counter", "updated_at"])
        ref = f"{cat.number_prefix}-{cat.counter:0{cat.number_padding}d}"
    try:
        with transaction.atomic():
            d = m.Document.objects.create(reference=ref, title=title.strip()[:250], description=description, category=cat, folder=folder, classification=cls, owner_id=owner_id, department_id=department_id, project_id=project_id,
                                          origin=origin[:200], tags=sorted(set(t.strip().lower() for t in (tags or []) if t.strip())), metadata=metadata or {}, direction=direction, is_template=is_template or cat.doc_type == "TEMPLATE",
                                          effective_date=effective_date, expiry_date=expiry_date, created_by=actor)
    except IntegrityError:
        raise DomainError("This document reference is already used.", code="duplicate_reference")
    event(d, "REGISTERED", actor, to_status="DRAFT", note=origin)
    _new_version(actor, d, change_reason=change_reason, file=file)
    for ln in links or []:
        _validate_link(ln["type"], str(ln["ref_id"]))
        m.DocumentLink.objects.get_or_create(document=d, link_type=ln["type"], ref_id=str(ln["ref_id"])[:64], defaults={"label": ln.get("label", "")[:200], "created_by": actor})
    audit("documents.document.registered", actor, "Document", d.id, reference=d.reference)
    return d


@transaction.atomic
def update_document(actor, pk, **f):
    d = lock_doc(pk)
    if not access.can(actor, d, "EDIT") or d.status == "ARCHIVED":
        raise nf()
    changed = []
    for k in ("title", "description", "origin"):
        if k in f and f[k] is not None:
            if k == "title" and not f[k].strip():
                raise ValidationFailed("A title is required.", code="invalid_fields")
            setattr(d, k, f[k][:250] if k == "title" else f[k])
            changed.append(k)
    if "tags" in f and f["tags"] is not None:
        d.tags = sorted(set(t.strip().lower() for t in f["tags"] if t.strip()))
        changed.append("tags")
    if "metadata" in f and f["metadata"] is not None:
        d.metadata = f["metadata"]
        changed.append("metadata")
    for k in ("department_id", "project_id"):
        if k in f:
            if k == "project_id" and f[k]:
                _validate_link("PROJECT", str(f[k]))
            setattr(d, k, f[k] or None)
            changed.append(k)
    if f.get("owner_id"):
        _check_user(f["owner_id"])
        d.owner_id = f["owner_id"]
        changed.append("owner")
    if "folder_id" in f:
        if f["folder_id"] and not m.Folder.objects.filter(pk=f["folder_id"], is_active=True).exists():
            raise ValidationFailed("Unknown folder.", code="invalid_folder")
        d.folder_id = f["folder_id"] or None
        changed.append("folder")
    if f.get("classification"):
        cls = m.Classification.objects.filter(code=f["classification"], is_active=True).first()
        if cls is None:
            raise ValidationFailed("Unknown classification.", code="invalid_classification")
        if cls.rank < d.classification.rank and not org.get_setting("documents.allow_declassify", True):
            raise DomainError("Lowering the classification is not allowed.", code="declassify_blocked")
        d.classification = cls
        changed.append("classification")
    for k in ("effective_date", "expiry_date"):
        if k in f:
            setattr(d, k, f[k])
            changed.append(k)
    _check_dates(d.effective_date, d.expiry_date)
    d.save()
    event(d, "UPDATED", actor, note=", ".join(changed))
    audit("documents.document.updated", actor, "Document", d.id, fields=",".join(changed))
    return d


@transaction.atomic
def upload_version(actor, doc_id, filename, data, *, change_reason=""):
    """Put the file into the editable (draft or changes-requested) version. Approved, published and superseded versions are never overwritten."""
    d = lock_doc(doc_id)
    if not access.can(actor, d, "UPLOAD") or d.status == "ARCHIVED":
        raise nf()
    v = d.versions.select_for_update().filter(status__in=EDITABLE_VERSION).order_by("-number").first()
    if v is None:
        raise DomainError("There is no draft version to upload into. Create a revision first.", code="no_draft_version")
    old = v.sha256
    if v.file_id:
        _release_file(v)
    _attach_file(actor, v, filename, data)
    if change_reason:
        v.change_reason = change_reason[:500]
        v.save(update_fields=["change_reason", "updated_at"])
    event(d, "FILE_REPLACED" if old else "FILE_ADDED", actor, version=v, note=f"{v.file_name} {v.sha256[:12]}")
    return v


@transaction.atomic
def create_revision(actor, doc_id, *, change_reason, change_type="MAJOR", file=None):
    d = lock_doc(doc_id)
    if not access.can(actor, d, "UPLOAD"):
        raise nf()
    if d.status in ("ARCHIVED", "OBSOLETE"):
        raise DomainError("An archived or obsolete document cannot be revised.", code="invalid_state_transition")
    if not (change_reason or "").strip() or change_type not in ("MAJOR", "MINOR"):
        raise ValidationFailed("A reason for the change is required.", code="reason_required")
    if not d.versions.filter(status__in=("PUBLISHED", "APPROVED")).exists():
        raise DomainError("Only an approved or published document can be revised; edit the draft instead.", code="no_approved_version")
    if d.versions.filter(status__in=("DRAFT", "UNDER_REVIEW", "CHANGES_REQUESTED", "APPROVED")).exclude(pk=getattr(d.current_version, "pk", None)).exists():
        raise DomainError("A revision is already in progress.", code="revision_in_progress")
    v = _new_version(actor, d, change_reason=change_reason, change_type=change_type, file=file)
    audit("documents.version.created", actor, "DocumentVersion", v.id, label=v.label)
    return v


@transaction.atomic
def delete_document(actor, doc_id):
    """Only drafts that were never approved can be deleted. Anything else follows archive and disposal rules."""
    d = lock_doc(doc_id)
    if not access.can(actor, d, "DELETE"):
        raise nf()
    if d.status != "DRAFT" or d.versions.filter(approved_at__isnull=False).exists() or d.current_version_id:
        raise DomainError("Only a draft that was never approved can be deleted. Archive the document instead.", code="delete_not_allowed")
    for v in d.versions.all():
        _release_file(v)
    d.deleted_at = timezone.now()
    d.save(update_fields=["deleted_at", "updated_at"])
    event(d, "DELETED", actor)
    audit("documents.document.deleted", actor, "Document", d.id, reference=d.reference)


# ----------------------------------------------------------------------------- templates
@transaction.atomic
def create_from_template(actor, template_id, *, title, category_id, owner_id=None, folder_id=None, department_id=None, project_id=None, links=None, metadata=None):
    t = m.Document.objects.select_related("current_version").filter(pk=template_id, is_template=True, deleted_at__isnull=True).first()
    if t is None or not access.can(actor, t, "VIEW"):
        raise nf("Template")
    if t.status != "PUBLISHED" or t.current_version is None:
        raise DomainError("Only an approved, published template can be used. This one is obsolete or not yet approved.", code="template_not_published")
    v = t.current_version
    file = None
    if v.file_id:
        sf = StoredFile.objects.filter(pk=v.file_id, status="ACTIVE").first()
        if sf is None:
            raise DomainError("The template file is not available.", code="template_file_missing")
        file = (sf.original_name, files.get_storage().open(sf.storage_key).read())
    d = register_document(actor, title=title, category_id=category_id, owner_id=owner_id, folder_id=folder_id, department_id=department_id, project_id=project_id, metadata=metadata, links=links,
                          origin=f"From template {t.reference} v{v.label}", file=file, change_reason=f"Created from template {t.reference} v{v.label}")
    d.template, d.template_version = t, v
    d.save(update_fields=["template", "template_version", "updated_at"])
    event(d, "FROM_TEMPLATE", actor, note=f"{t.reference} v{v.label}")
    return d


# ----------------------------------------------------------------------------- reading
def open_version(actor, version_id, *, request=None, action="DOWNLOAD"):
    """Return (stored file, handle) for a version the user may read, and record the access."""
    v = m.DocumentVersion.objects.select_related("document__classification").filter(pk=version_id).first()
    if v is None or v.document.deleted_at or not v.file_id or not access.can_read_version(actor, v, action):
        raise nf("Version")
    m.AccessLog.objects.create(document=v.document, version=v, user_id=actor, action=action)
    return files.read_for_user(actor, v.file_id, request=request)


def version_dict(v, *, with_file=True):
    return {"id": str(v.id), "number": v.number, "label": v.label, "status": v.status, "change_reason": v.change_reason, "file_name": v.file_name, "size": v.size, "sha256": v.sha256, "created_by": str(v.created_by),
            "created_at": str(v.created_at), "submitted_at": v.submitted_at and str(v.submitted_at), "approved_at": v.approved_at and str(v.approved_at), "published_at": v.published_at and str(v.published_at),
            "published_by": v.published_by and str(v.published_by), "superseded_at": v.superseded_at and str(v.superseded_at), "workflow_instance_id": v.workflow_instance_id and str(v.workflow_instance_id), "rejection_note": v.rejection_note}


def today():
    return timezone.now().date()


def add_days(d, n):
    return d + timedelta(days=n)
