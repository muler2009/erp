"""Asset register: categories, locations, asset master, identification, documents and history."""
import re
from decimal import Decimal

from django.db import IntegrityError, transaction
from django.db.models import Q

from modules.assets import models as m
from platform_core.audit.services import record_tenant_event
from shared.api.errors import DomainError, ValidationFailed
from shared.tenancy import current_tenant

ZERO = Decimal("0")
METHODS = ("SL", "RB", "NON")
TRACKING = ("NONE", "BARCODE", "QR", "RFID")

# Statuses an operator may move an asset to by hand. Everything else is set by the process that owns it
# (assignment, transfer, maintenance, disposal) through set_status().
MANUAL_TRANSITIONS = {"REQUESTED": {"ORDERED", "RECEIVED"}, "ORDERED": {"RECEIVED"}, "RECEIVED": {"AVAILABLE"}, "AVAILABLE": {"RETIRED"}}
ALL_TRANSITIONS = {
    "REQUESTED": {"ORDERED", "RECEIVED"}, "ORDERED": {"RECEIVED"}, "RECEIVED": {"AVAILABLE"},
    "AVAILABLE": {"ASSIGNED", "IN_USE", "UNDER_MAINTENANCE", "TRANSFERRED", "DISPOSED", "RETIRED"},
    "ASSIGNED": {"AVAILABLE", "IN_USE", "UNDER_MAINTENANCE", "TRANSFERRED", "DISPOSED"},
    "IN_USE": {"AVAILABLE", "ASSIGNED", "UNDER_MAINTENANCE", "TRANSFERRED", "DISPOSED"},
    "UNDER_MAINTENANCE": {"AVAILABLE", "ASSIGNED", "IN_USE", "DISPOSED"},
    "TRANSFERRED": {"AVAILABLE", "ASSIGNED", "IN_USE"},
    "RETIRED": {"DISPOSED"}, "DISPOSED": set(),
}
ACTIVATION_CHECKS = []  # callables(asset) that may veto RECEIVED -> AVAILABLE (e.g. capitalization approval)
TRACKED_FIELDS = ("department_id", "custodian_id", "responsible_id", "legal_entity_id", "location_id")


def _dec(v, name="amount"):
    try:
        return Decimal(str(v))
    except Exception:
        raise ValidationFailed(f"{name} must be a number.", code="invalid_amount")


def log(asset, event, *, actor_id=None, note="", **detail):
    return m.AssetHistory.objects.create(asset=asset, event_type=event, detail={k: (None if v is None else str(v)) for k, v in detail.items()}, note=note[:300], actor_id=actor_id)


# ----------------------------------------------------------------------------- categories and locations
CATEGORY_FIELDS = {"name", "parent_id", "prefix", "asset_class", "purpose", "operational_function", "capitalization_threshold", "depreciation_method", "useful_life_months", "residual_percent", "reducing_rate_percent", "tracking", "requires_serial", "requires_insurance", "maintenance_interval_days", "inspection_interval_days", "is_active"}


def _clean_category(a):
    bad = set(a) - CATEGORY_FIELDS
    if bad:
        raise ValidationFailed(f"Unknown category attribute '{sorted(bad)[0]}'.", code="unknown_attribute")
    if "asset_class" in a and a["asset_class"] not in m.ASSET_CLASSES:
        raise ValidationFailed("Invalid asset class.", code="invalid_class")
    if "depreciation_method" in a and a["depreciation_method"] not in METHODS:
        raise ValidationFailed("Depreciation method must be SL, RB or NON.", code="invalid_method")
    if "tracking" in a and a["tracking"] not in TRACKING:
        raise ValidationFailed("Invalid tracking requirement.", code="invalid_tracking")
    for k in ("capitalization_threshold", "residual_percent", "reducing_rate_percent"):
        if k in a and a[k] not in (None, ""):
            a[k] = _dec(a[k], k)
            if a[k] < 0:
                raise ValidationFailed(f"{k} cannot be negative.", code="invalid_amount")
    if "residual_percent" in a and a["residual_percent"] > 100:
        raise ValidationFailed("Residual percent cannot exceed 100.", code="invalid_amount")
    if a.get("depreciation_method") == "RB" and not a.get("reducing_rate_percent") and "reducing_rate_percent" in a:
        raise ValidationFailed("Reducing-balance needs an annual rate.", code="rate_required")
    if "useful_life_months" in a and int(a["useful_life_months"]) <= 0:
        raise ValidationFailed("Useful life must be positive.", code="invalid_life")
    if "prefix" in a and not re.fullmatch(r"[A-Z0-9]{1,10}", str(a["prefix"])):
        raise ValidationFailed("Prefix must be 1-10 capital letters or digits.", code="invalid_prefix")
    return a


@transaction.atomic
def create_category(actor_id, *, code, name, **attrs):
    if not re.fullmatch(r"[A-Z0-9_-]{1,20}", code or ""):
        raise ValidationFailed("Code must be capital letters, digits, - or _.", code="invalid_code")
    if m.AssetCategory.objects.filter(code=code).exists():
        raise DomainError("A category with this code already exists.", code="code_taken")
    attrs.setdefault("prefix", re.sub(r"[^A-Z0-9]", "", code)[:10] or "AST")
    a = _clean_category({"name": name, **attrs})
    parent_id = a.pop("parent_id", None)
    if parent_id and not m.AssetCategory.objects.filter(pk=parent_id).exists():
        raise DomainError("Parent category not found.", code="not_found", status_code=404)
    cat = m.AssetCategory.objects.create(code=code, parent_id=parent_id, **a)
    record_tenant_event(current_tenant(), "assets.category.created", actor_user_id=actor_id, target_type="AssetCategory", target_id=cat.id, metadata={"code": code})
    return cat


@transaction.atomic
def update_category(actor_id, category_id, **attrs):
    cat = m.AssetCategory.objects.select_for_update().filter(pk=category_id).first()
    if cat is None:
        raise DomainError("Category not found.", code="not_found", status_code=404)
    a = _clean_category({k: v for k, v in attrs.items() if v is not None})
    if "parent_id" in a:
        p = m.AssetCategory.objects.filter(pk=a["parent_id"]).first() if a["parent_id"] else None
        while p is not None:  # no cycles
            if p.id == cat.id:
                raise ValidationFailed("A category cannot be its own ancestor.", code="category_cycle")
            p = p.parent
    for k, v in a.items():
        setattr(cat, k, v)
    cat.save()
    record_tenant_event(current_tenant(), "assets.category.updated", actor_user_id=actor_id, target_type="AssetCategory", target_id=cat.id, metadata={"fields": ",".join(sorted(a))})
    return cat


@transaction.atomic
def create_location(actor_id, *, code, name, parent_id=None, branch_id=None, address=""):
    if m.AssetLocation.objects.filter(code=code).exists():
        raise DomainError("A location with this code already exists.", code="code_taken")
    if parent_id and not m.AssetLocation.objects.filter(pk=parent_id).exists():
        raise DomainError("Parent location not found.", code="not_found", status_code=404)
    return m.AssetLocation.objects.create(code=code, name=name, parent_id=parent_id, branch_id=branch_id, address=address[:300])


# ----------------------------------------------------------------------------- asset master
ASSET_FIELDS = {"name", "description", "manufacturer", "model", "serial_number", "supplier_id", "acquisition_date", "purchase_cost", "currency", "location_id", "legal_entity_id", "department_id", "custodian_id", "responsible_id", "asset_class", "rfid_tag", "barcode", "qr_code"}


def _clean_asset(a, category=None):
    bad = set(a) - ASSET_FIELDS
    if bad:
        raise ValidationFailed(f"Unknown asset attribute '{sorted(bad)[0]}'.", code="unknown_attribute")
    if "asset_class" in a and a["asset_class"] not in m.ASSET_CLASSES:
        raise ValidationFailed("Invalid asset class.", code="invalid_class")
    if "purchase_cost" in a:
        a["purchase_cost"] = _dec(a["purchase_cost"], "purchase_cost")
        if a["purchase_cost"] < 0:
            raise ValidationFailed("Cost cannot be negative.", code="invalid_amount")
    if "name" in a and not str(a["name"]).strip():
        raise ValidationFailed("name is required.", code="invalid_name")
    if a.get("location_id") and not m.AssetLocation.objects.filter(pk=a["location_id"], is_active=True).exists():
        raise ValidationFailed("Unknown or inactive location.", code="invalid_location")
    for k in ("barcode", "qr_code", "rfid_tag", "serial_number"):
        if k in a and a[k] is not None:
            a[k] = str(a[k]).strip()
    return a


def _next_number(cat):
    locked = m.AssetCategory.objects.select_for_update().get(pk=cat.pk)
    n = locked.next_seq
    locked.next_seq = n + 1
    locked.save(update_fields=["next_seq"])
    return f"{locked.prefix}-{n:06d}"


@transaction.atomic
def create_asset(actor_id, *, category_id, name, status="REQUESTED", **attrs):
    cat = m.AssetCategory.objects.filter(pk=category_id, is_active=True).first()
    if cat is None:
        raise ValidationFailed("Choose an active asset category.", code="invalid_category")
    if status not in ("REQUESTED", "ORDERED", "RECEIVED"):
        raise ValidationFailed("A new asset starts as Requested, Ordered or Received; it becomes Available once activated.", code="invalid_status")
    attrs.setdefault("asset_class", cat.asset_class)
    a = _clean_asset({"name": name, **attrs}, cat)
    if cat.requires_serial and status == "RECEIVED" and not a.get("serial_number"):
        raise ValidationFailed("This category requires a serial number once the asset is received.", code="serial_required")
    number = _next_number(cat)
    a.setdefault("barcode", number)
    a.setdefault("qr_code", f"AST:{number}")
    if cat.tracking == "RFID" and status == "RECEIVED" and not a.get("rfid_tag"):
        raise ValidationFailed("This category is tracked by RFID: provide the tag.", code="rfid_required")
    try:
        with transaction.atomic():
            asset = m.Asset.objects.create(number=number, category=cat, status=status, created_by=actor_id, **a)
    except IntegrityError:
        raise DomainError("Barcode, QR code, RFID tag or manufacturer/model/serial is already used by another asset.", code="identifier_taken")
    log(asset, "REGISTERED", actor_id=actor_id, status=status, category=cat.code, cost=asset.purchase_cost)
    record_tenant_event(current_tenant(), "assets.asset.registered", actor_user_id=actor_id, target_type="Asset", target_id=asset.id, metadata={"number": number})
    return asset


def _get(asset_id, lock=False):
    qs = m.Asset.objects.select_for_update(of=("self",)) if lock else m.Asset.objects
    a = qs.select_related("category").filter(pk=asset_id).first()
    if a is None:
        raise DomainError("Asset not found.", code="not_found", status_code=404)
    return a


@transaction.atomic
def update_asset(actor_id, asset_id, *, expected_version=None, **attrs):
    asset = _get(asset_id, lock=True)
    if asset.status in ("DISPOSED",):
        raise DomainError("A disposed asset's record is closed.", code="asset_disposed")
    if expected_version is not None and expected_version != asset.version:
        raise DomainError("The asset was changed by someone else.", code="version_conflict")
    a = _clean_asset({k: v for k, v in attrs.items() if k in ASSET_FIELDS and v is not None})
    if "purchase_cost" in a and asset.status not in ("REQUESTED", "ORDERED", "RECEIVED") and a["purchase_cost"] != asset.purchase_cost:
        raise DomainError("The cost of an active asset changes only through capitalization, improvement or revaluation.", code="cost_locked")
    changes = {}
    for k, v in a.items():
        old = getattr(asset, k)
        if str(old) != str(v):
            changes[k] = (old, v)
            setattr(asset, k, v)
    if not changes:
        return asset
    asset.version += 1
    try:
        with transaction.atomic():
            asset.save()
    except IntegrityError:
        raise DomainError("Barcode, QR code, RFID tag or manufacturer/model/serial is already used by another asset.", code="identifier_taken")
    for k, (old, new) in changes.items():
        log(asset, "OWNERSHIP_CHANGED" if k in TRACKED_FIELDS else "UPDATED", actor_id=actor_id, field=k, old=old, new=new)
    return asset


@transaction.atomic
def set_status(actor_id, asset_id, new_status, *, reason="", manual=False):
    asset = _get(asset_id, lock=True)
    if new_status not in m.STATUSES:
        raise ValidationFailed("Unknown status.", code="invalid_status")
    if new_status == asset.status:
        return asset
    table = MANUAL_TRANSITIONS if manual else ALL_TRANSITIONS
    if new_status not in table.get(asset.status, set()):
        raise DomainError(f"An asset cannot move from {asset.status} to {new_status} this way.", code="invalid_state_transition")
    if new_status == "AVAILABLE" and asset.status == "RECEIVED":
        cat = asset.category
        if cat.requires_serial and not asset.serial_number:
            raise ValidationFailed("A serial number is required before the asset becomes available.", code="serial_required")
        for check in ACTIVATION_CHECKS:
            check(asset)
    if new_status == "RETIRED" and not (reason or "").strip():
        raise ValidationFailed("A reason is required to retire an asset.", code="reason_required")
    old = asset.status
    asset.status = new_status
    asset.version += 1
    asset.save(update_fields=["status", "version", "updated_at"])
    log(asset, "STATUS_CHANGED", actor_id=actor_id, note=reason, old=old, new=new_status)
    return asset


# ----------------------------------------------------------------------------- identification
def find_by_code(code):
    """Resolve whatever a scanner returns: asset number, barcode, QR payload or RFID tag."""
    code = (code or "").strip()
    if not code:
        raise ValidationFailed("A code is required.", code="code_required")
    a = m.Asset.objects.select_related("category", "location").filter(Q(number=code) | Q(barcode=code) | Q(qr_code=code) | Q(rfid_tag=code)).first()
    if a is None:
        raise DomainError("No asset carries this code.", code="not_found", status_code=404)
    return a


def label(asset):
    return {"number": asset.number, "name": asset.name, "barcode": asset.barcode, "qr_payload": asset.qr_code, "rfid_tag": asset.rfid_tag, "category": asset.category.code, "location": asset.location.code if asset.location else ""}


# ----------------------------------------------------------------------------- documents
DOC_TYPES = ("IMAGE", "INVOICE", "WARRANTY", "CERTIFICATE", "MANUAL", "OTHER")


@transaction.atomic
def add_document(actor_id, asset_id, *, doc_type, title, filename, data):
    from shared.files import services as files

    asset = _get(asset_id)
    if doc_type not in DOC_TYPES:
        raise ValidationFailed("Unknown document type.", code="invalid_doc_type")
    f = files.upload(actor_id, filename, data, ref_type="assets.asset", ref_id=str(asset.id))
    d = m.AssetDocument.objects.create(asset=asset, doc_type=doc_type, title=(title or filename)[:200], file_id=f.id, uploaded_by=actor_id)
    log(asset, "DOCUMENT_ADDED", actor_id=actor_id, doc_type=doc_type, title=d.title)
    return d


def can_read_documents(user_id, ref_id):
    from platform_core.authorization import services as authz

    return bool(m.Asset.objects.filter(pk=ref_id).exists() and authz.has_permission(user_id, "assets.view"))


def history(asset_id):
    _get(asset_id)
    return [{"at": h.created_at.isoformat(), "event": h.event_type, "detail": h.detail, "note": h.note, "actor": None if not h.actor_id else str(h.actor_id)} for h in m.AssetHistory.objects.filter(asset_id=asset_id)]
