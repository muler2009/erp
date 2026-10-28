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
    PermissionDef("finance.accounts.view", _T, "finance", "View chart of accounts, tax rates, bank accounts, ledger"),
    PermissionDef("finance.accounts.manage", _T, "finance", "Manage chart of accounts, tax rates, bank accounts"),
    PermissionDef("finance.journal.create", _T, "finance", "Create draft journal entries"),
    PermissionDef("finance.journal.post", _T, "finance", "Post and reverse journal entries"),
    PermissionDef("finance.invoice.view", _T, "finance", "View invoices, credit notes and payments"),
    PermissionDef("finance.invoice.create", _T, "finance", "Create invoices"),
    PermissionDef("finance.invoice.approve", _T, "finance", "Approve invoices"),
    PermissionDef("finance.payment.release", _T, "finance", "Release payments"),
    PermissionDef("crm.view", _T, "crm", "View CRM records you own"),
    PermissionDef("crm.view_all", _T, "crm", "View and act on all CRM records regardless of owner"),
    PermissionDef("crm.manage", _T, "crm", "Manage leads, contacts, accounts, opportunities and activities"),
    PermissionDef("crm.assign", _T, "crm", "Assign and reassign leads and opportunities"),
    PermissionDef("sales.view", _T, "sales", "View quotations, orders, deliveries and price lists"),
    PermissionDef("sales.pricelist.manage", _T, "sales", "Manage price lists"),
    PermissionDef("sales.quote.create", _T, "sales", "Create and send quotations"),
    PermissionDef("sales.order.create", _T, "sales", "Create and submit sales orders"),
    PermissionDef("sales.order.approve", _T, "sales", "Approve sales orders above limits"),
    PermissionDef("sales.delivery.manage", _T, "sales", "Deliver orders and process returns"),
    PermissionDef("sales.invoice.create", _T, "sales", "Create customer invoices from orders"),
    PermissionDef("procurement.view", _T, "procurement", "View suppliers, requisitions, RFQs and purchase orders"),
    PermissionDef("procurement.supplier.manage", _T, "procurement", "Register, qualify and evaluate suppliers"),
    PermissionDef("procurement.requisition.create", _T, "procurement", "Create and submit purchase requisitions"),
    PermissionDef("procurement.requisition.approve", _T, "procurement", "Approve purchase requisitions"),
    PermissionDef("procurement.rfq.manage", _T, "procurement", "Run requests for quotation and award bids"),
    PermissionDef("procurement.purchase_order.create", _T, "procurement", "Create and submit purchase orders"),
    PermissionDef("procurement.purchase_order.approve", _T, "procurement", "Approve purchase orders"),
    PermissionDef("procurement.invoice.match", _T, "procurement", "Run three-way match of supplier invoices"),
    PermissionDef("inventory.view", _T, "inventory", "View products, warehouses, stock and valuation"),
    PermissionDef("inventory.product.manage", _T, "inventory", "Manage products, warehouses, locations and reorder rules"),
    PermissionDef("inventory.goods.receive", _T, "inventory", "Receive goods against purchase orders and stock receipts"),
    PermissionDef("inventory.stock.issue", _T, "inventory", "Issue and transfer stock"),
    PermissionDef("inventory.stock.adjust", _T, "inventory", "Adjust stock and post cycle counts"),
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
    "finance_officer": ("Finance Officer", ["finance.invoice.create", "finance.invoice.view", "finance.journal.create", "finance.accounts.view"]),
    "finance_manager": ("Finance Manager", ["finance.invoice.create", "finance.invoice.view", "finance.invoice.approve", "finance.journal.create", "finance.journal.post", "finance.accounts.view", "finance.accounts.manage", "reports.financial.view"]),
    "finance_controller": ("Finance Controller", ["finance.payment.release", "finance.invoice.view", "finance.accounts.view", "reports.financial.view"]),
    "hr_manager": ("HR Manager", ["hr.payroll.process", "users.view"]),
    "procurement_manager": ("Procurement Manager", ["procurement.view", "procurement.supplier.manage", "procurement.requisition.create", "procurement.requisition.approve", "procurement.rfq.manage", "procurement.purchase_order.create", "procurement.purchase_order.approve", "procurement.invoice.match", "inventory.view"]),
    "sales_manager": ("Sales Manager", ["crm.view", "crm.view_all", "crm.manage", "crm.assign", "sales.view", "sales.pricelist.manage", "sales.quote.create", "sales.order.create", "sales.order.approve", "sales.delivery.manage", "sales.invoice.create", "inventory.view"]),
    "sales_rep": ("Sales Representative", ["crm.view", "crm.manage", "sales.view", "sales.quote.create", "sales.order.create", "inventory.view"]),
    "procurement_officer": ("Procurement Officer", ["procurement.view", "procurement.requisition.create", "procurement.rfq.manage", "procurement.purchase_order.create", "inventory.view"]),
    "warehouse_staff": ("Warehouse Staff", ["sales.view", "sales.delivery.manage", "inventory.view", "inventory.goods.receive", "inventory.stock.issue", "inventory.stock.adjust", "procurement.view"]),
    "employee": ("Standard Employee", ["files.upload", "procurement.requisition.create"]),
    "read_only_auditor": ("Read-Only Auditor", ["crm.view", "crm.view_all", "sales.view", "procurement.view", "inventory.view", "finance.accounts.view", "finance.invoice.view", "audit.view", "users.view", "roles.view", "reports.financial.view", "org.structure.view", "org.reference.view", "workflow.view_all"]),
}

DEFAULT_PLAN_CODE = "standard"
PLATFORM_SUPERADMIN_ROLE = "platform_superadmin"
