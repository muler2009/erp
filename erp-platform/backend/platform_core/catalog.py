"""Code-defined catalogs: ERP modules, permissions and system roles.

Permissions are a closed catalog (granular, `module.resource.action`). Platform-scoped permissions can
never be granted inside a tenant: enforced in the service layer AND by a DB check constraint.
"""
from dataclasses import dataclass

MODULES = [
    "organization", "finance", "hr", "crm", "sales", "procurement", "inventory",
    "supply_chain", "manufacturing", "projects", "assets", "quality", "documents", "analytics",
]


@dataclass(frozen=True)
class PermissionDef:
    code: str
    scope: str  # "tenant" | "platform"
    module: str | None  # None = core capability, always available; otherwise requires module entitlement
    description: str


_T = "tenant"
_P = "platform"

PERMISSIONS = [
    # --- tenant core
    PermissionDef("users.view", _T, None, "View users and memberships"),
    PermissionDef("users.create", _T, None, "Invite users"),
    PermissionDef("users.update", _T, None, "Update or reactivate users"),
    PermissionDef("users.deactivate", _T, None, "Deactivate users"),
    PermissionDef("roles.view", _T, None, "View roles and assignments"),
    PermissionDef("roles.manage", _T, None, "Create and edit custom roles"),
    PermissionDef("roles.assign", _T, None, "Assign and revoke roles"),
    PermissionDef("audit.view", _T, None, "View tenant audit log"),
    PermissionDef("modules.view", _T, None, "View module entitlements"),
    PermissionDef("modules.manage", _T, None, "Enable or disable entitled modules"),
    PermissionDef("workflow.definitions.manage", _T, None, "Configure approval workflows"),
    PermissionDef("workflow.view_all", _T, None, "View all workflow instances"),
    PermissionDef("workflow.cancel_any", _T, None, "Cancel any workflow instance"),
    PermissionDef("files.upload", _T, None, "Upload files"),
    PermissionDef("files.manage", _T, None, "Access and delete any file"),
    PermissionDef("events.manage", _T, None, "View and retry dead-lettered events"),
    # --- module permissions (examples from the master prompt; enforced as modules land)
    PermissionDef("org.settings.manage", _T, "organization", "Manage organization settings and company profile"),
    PermissionDef("org.structure.view", _T, "organization", "View departments, teams, positions, units"),
    PermissionDef("org.structure.manage", _T, "organization", "Manage departments, teams, positions, units, cost centers"),
    PermissionDef("org.reference.view", _T, "organization", "View currencies, fiscal calendar, holidays"),
    PermissionDef("org.reference.manage", _T, "organization", "Manage currencies, rates, fiscal years, holidays"),
    PermissionDef("org.fiscal.close", _T, "organization", "Close and reopen fiscal periods"),
    PermissionDef("org.profiles.manage", _T, "organization", "Assign members to departments and positions"),
    PermissionDef("org.sequences.manage", _T, "organization", "Configure numbering sequences"),
    PermissionDef("finance.invoice.create", _T, "finance", "Create invoices"),
    PermissionDef("finance.invoice.approve", _T, "finance", "Approve invoices"),
    PermissionDef("finance.payment.release", _T, "finance", "Release payments"),
    PermissionDef("procurement.purchase_order.approve", _T, "procurement", "Approve purchase orders"),
    PermissionDef("inventory.stock.adjust", _T, "inventory", "Adjust stock"),
    PermissionDef("hr.payroll.process", _T, "hr", "Process payroll"),
    PermissionDef("reports.financial.view", _T, "analytics", "View financial reports"),
    # --- platform
    PermissionDef("platform.tenants.view", _P, None, "View tenants"),
    PermissionDef("platform.tenants.create", _P, None, "Create tenants"),
    PermissionDef("platform.tenants.lifecycle", _P, None, "Suspend, reactivate, deactivate tenants"),
    PermissionDef("platform.tenants.provision", _P, None, "Retry tenant provisioning"),
    PermissionDef("platform.plans.manage", _P, None, "Manage plans and module entitlements"),
    PermissionDef("platform.admins.manage", _P, None, "Propose platform administrators"),
    PermissionDef("platform.admins.approve", _P, None, "Approve platform administrators"),
    PermissionDef("platform.access.request", _P, None, "Request break-glass access to a tenant"),
    PermissionDef("platform.access.approve", _P, None, "Approve break-glass access"),
    PermissionDef("platform.audit.view", _P, None, "View platform audit log"),
]

PERMISSION_BY_CODE = {p.code: p for p in PERMISSIONS}
TENANT_PERMISSION_CODES = sorted(p.code for p in PERMISSIONS if p.scope == _T)
PLATFORM_PERMISSION_CODES = sorted(p.code for p in PERMISSIONS if p.scope == _P)

OWNER_ROLE = "tenant_owner"

_CORE_ADMIN = [
    "users.view", "users.create", "users.update", "users.deactivate",
    "roles.view", "roles.manage", "roles.assign", "audit.view", "modules.view", "modules.manage",
    "org.settings.manage", "org.structure.view", "org.structure.manage", "org.reference.view", "org.reference.manage",
    "org.profiles.manage", "org.sequences.manage", "workflow.definitions.manage", "workflow.view_all",
    "files.upload", "files.manage", "events.manage",
]

# System roles seeded into every tenant. Names/permissions are data: tenants may add their own roles.
DEFAULT_TENANT_ROLES = {
    OWNER_ROLE: ("Tenant Owner", TENANT_PERMISSION_CODES),
    "tenant_admin": ("Tenant Administrator", _CORE_ADMIN),
    "department_manager": ("Department Manager", ["users.view", "org.structure.view", "files.upload"]),
    "finance_officer": ("Finance Officer", ["finance.invoice.create"]),
    "finance_manager": ("Finance Manager", ["finance.invoice.create", "finance.invoice.approve", "reports.financial.view"]),
    "finance_controller": ("Finance Controller", ["finance.payment.release", "reports.financial.view"]),
    "hr_manager": ("HR Manager", ["hr.payroll.process", "users.view"]),
    "procurement_manager": ("Procurement Manager", ["procurement.purchase_order.approve"]),
    "warehouse_staff": ("Warehouse Staff", ["inventory.stock.adjust"]),
    "employee": ("Standard Employee", ["files.upload"]),
    "read_only_auditor": ("Read-Only Auditor", ["audit.view", "users.view", "roles.view", "reports.financial.view", "org.structure.view", "org.reference.view", "workflow.view_all"]),
}

DEFAULT_PLAN_CODE = "standard"
PLATFORM_SUPERADMIN_ROLE = "platform_superadmin"
