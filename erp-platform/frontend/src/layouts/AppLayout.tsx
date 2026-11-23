import { NotificationBell } from "../features/notifications/NotificationsPage";
import { useState } from "react";
import { NavLink, Outlet } from "react-router";

import { useAuth } from "../shared/auth/AuthProvider";
import { useAccess } from "../shared/permissions/usePermissions";
import { Button } from "../shared/ui/primitives";
import type { TenantMe } from "../shared/api/types";

interface NavItem {
  to: string;
  label: string;
  /** Omitted for screens every workspace member may open (the API still filters what they see). */
  permission?: string;
}

/** Only screens that exist are listed; each is shown only if the user holds its permission (the API enforces it again). */
const NAV: NavItem[] = [
  { to: "/app/dashboard", label: "Dashboard", permission: "analytics.view" },
  { to: "/app/analytics/kpis", label: "KPIs", permission: "analytics.view" },
  { to: "/app/analytics/reports", label: "Reports", permission: "analytics.view" },
  { to: "/app/approvals", label: "Approvals" },
  { to: "/app/approvals/requests", label: "Requests" },
  { to: "/app/finance/accounts", label: "Chart of accounts", permission: "finance.accounts.view" },
  { to: "/app/finance/journals", label: "Journal entries", permission: "finance.accounts.view" },
  { to: "/app/finance/invoices", label: "Invoices", permission: "finance.invoice.view" },
  { to: "/app/finance/partners", label: "Partners", permission: "finance.invoice.view" },
  { to: "/app/finance/tax-rates", label: "Tax rates", permission: "finance.accounts.view" },
  { to: "/app/finance/payments", label: "Payments", permission: "finance.invoice.view" },
  { to: "/app/finance/reconciliation", label: "Bank reconciliation", permission: "finance.accounts.view" },
  { to: "/app/finance/ledger", label: "General ledger", permission: "reports.financial.view" },
  { to: "/app/finance/trial-balance", label: "Trial balance", permission: "reports.financial.view" },
  { to: "/app/finance/profit-loss", label: "Profit and loss", permission: "reports.financial.view" },
  { to: "/app/finance/balance-sheet", label: "Balance sheet", permission: "reports.financial.view" },
  { to: "/app/procurement/overview", label: "Procurement overview", permission: "procurement.view" },
  { to: "/app/procurement/analytics", label: "Procurement analytics", permission: "procurement.view" },
  { to: "/app/procurement/product-sourcing", label: "Product sourcing", permission: "procurement.view" },
  { to: "/app/procurement/spend", label: "Spend by supplier", permission: "procurement.view" },
  { to: "/app/procurement/settings", label: "Procurement settings", permission: "procurement.view" },
  { to: "/app/procurement/receiving", label: "Receiving and inspection", permission: "procurement.view" },
  { to: "/app/procurement/returns", label: "Supplier returns and claims", permission: "procurement.view" },
  { to: "/app/procurement/contracts", label: "Supplier contracts", permission: "procurement.view" },
  { to: "/app/procurement/blanket-orders", label: "Blanket orders", permission: "procurement.view" },
  { to: "/app/procurement/tenders", label: "Tenders", permission: "procurement.view" },
  { to: "/app/procurement/single-source", label: "Single-source orders", permission: "procurement.view" },
  { to: "/app/procurement/supplier-risk", label: "Supplier risk", permission: "procurement.view" },
  { to: "/app/procurement/budgets", label: "Budgets and plans", permission: "procurement.view" },
  { to: "/app/procurement/requisitions", label: "Requisitions", permission: "procurement.view" },
  { to: "/app/procurement/rfqs", label: "RFQs", permission: "procurement.view" },
  { to: "/app/procurement/match-exceptions", label: "Match exceptions", permission: "procurement.invoice.match" },
  { to: "/app/procurement/payments", label: "Supplier payments", permission: "procurement.payment.release" },
  { to: "/app/procurement/purchase-orders", label: "Purchase orders", permission: "procurement.view" },
  { to: "/app/procurement/suppliers", label: "Suppliers", permission: "procurement.view" },
  { to: "/app/inventory/products", label: "Products", permission: "inventory.view" },
  { to: "/app/inventory/stock", label: "Stock", permission: "inventory.view" },
  { to: "/app/inventory/warehouses", label: "Warehouses", permission: "inventory.view" },
  { to: "/app/inventory/transfers", label: "Transfers", permission: "inventory.view" },
  { to: "/app/inventory/reservations", label: "Reservations", permission: "inventory.view" },
  { to: "/app/inventory/counts", label: "Stock counts", permission: "inventory.view" },
  { to: "/app/inventory/stock-control", label: "Stock control", permission: "inventory.view" },
  { to: "/app/inventory/traceability", label: "Lots & serials", permission: "inventory.view" },
  { to: "/app/inventory/adjustments", label: "Adjustments", permission: "inventory.stock.adjust" },
  { to: "/app/inventory/landed-costs", label: "Landed costs", permission: "inventory.view" },
  { to: "/app/inventory/requisitions", label: "Material requests", permission: "inventory.requisition.create" },
  { to: "/app/inventory/reports", label: "Inventory reports", permission: "inventory.view" },
  { to: "/app/inventory/item-setup", label: "Item setup", permission: "inventory.view" },
  { to: "/app/inventory/valuation", label: "Stock valuation", permission: "inventory.view" },
  { to: "/app/manufacturing/orders", label: "Production orders", permission: "manufacturing.view" },
  { to: "/app/manufacturing/plans", label: "Production plans", permission: "manufacturing.view" },
  { to: "/app/manufacturing/planning", label: "Planning & capacity", permission: "manufacturing.view" },
  { to: "/app/manufacturing/boms", label: "Bills of materials", permission: "manufacturing.view" },
  { to: "/app/manufacturing/work-centers", label: "Work centres", permission: "manufacturing.view" },
  { to: "/app/manufacturing/lines", label: "Lines & item profiles", permission: "manufacturing.view" },
  { to: "/app/manufacturing/downtime", label: "Downtime", permission: "manufacturing.view" },
  { to: "/app/manufacturing/reports", label: "Manufacturing reports", permission: "manufacturing.view" },
  { to: "/app/supply-chain/shipments", label: "Shipments", permission: "supply_chain.view" },
  { to: "/app/supply-chain/forecasts", label: "Demand forecasts", permission: "supply_chain.view" },
  { to: "/app/supply-chain/replenishment", label: "Replenishment", permission: "supply_chain.view" },
  { to: "/app/supply-chain/risks", label: "Supply risks", permission: "supply_chain.view" },
  { to: "/app/supply-chain/demands", label: "Demand", permission: "supply_chain.view" },
  { to: "/app/supply-chain/fulfilment", label: "Order fulfilment", permission: "supply_chain.view" },
  { to: "/app/supply-chain/vehicles", label: "Vehicles", permission: "supply_chain.view" },
  { to: "/app/supply-chain/analytics", label: "Supply chain analytics", permission: "supply_chain.view" },
  { to: "/app/supply-chain/carriers", label: "Carriers & routes", permission: "supply_chain.view" },
  { to: "/app/supply-chain/logistics-reports", label: "Logistics reports", permission: "supply_chain.view" },
  { to: "/app/crm/accounts", label: "Accounts", permission: "crm.view" },
  { to: "/app/crm/contacts", label: "Contacts", permission: "crm.view" },
  { to: "/app/crm/leads", label: "Leads", permission: "crm.view" },
  { to: "/app/crm/pipeline-settings", label: "Pipeline stages", permission: "crm.assign" },
  { to: "/app/crm/segments", label: "Customer segments", permission: "crm.view" },
  { to: "/app/crm/dates", label: "Contact dates", permission: "crm.view" },
  { to: "/app/crm/opportunities", label: "Opportunities", permission: "crm.view" },
  { to: "/app/crm/activities", label: "Activities", permission: "crm.view" },
  { to: "/app/crm/campaigns", label: "Campaigns", permission: "crm.campaign.manage" },
  { to: "/app/crm/cases", label: "Service cases", permission: "crm.view" },
  { to: "/app/crm/service-report", label: "Service report", permission: "crm.view" },
  { to: "/app/crm/insights", label: "Customer insights", permission: "crm.view" },
  { to: "/app/crm/teams", label: "Sales teams", permission: "crm.view" },
  { to: "/app/crm/reports", label: "Sales reports", permission: "crm.view" },
  { to: "/app/sales/quotations", label: "Quotations", permission: "sales.view" },
  { to: "/app/sales/orders", label: "Sales orders", permission: "sales.view" },
  { to: "/app/sales/summary", label: "Sales summary", permission: "sales.view" },
  { to: "/app/sales/statements", label: "Customer statements", permission: "sales.view" },
  { to: "/app/sales/pricing", label: "Pricing", permission: "sales.view" },
  { to: "/app/sales/deliveries", label: "Deliveries", permission: "sales.view" },
  { to: "/app/sales/backorders", label: "Backorders", permission: "sales.view" },
  { to: "/app/sales/contracts", label: "Customer contracts", permission: "sales.view" },
  { to: "/app/sales/aging", label: "Receivables aging", permission: "sales.view" },
  { to: "/app/sales/returns", label: "Returns", permission: "sales.view" },
  { to: "/app/sales/analytics", label: "Sales analytics", permission: "sales.view" },
  { to: "/app/sales/commissions", label: "Targets and commission", permission: "crm.view" },
  { to: "/app/documents", label: "Documents", permission: "documents.view" },
  { to: "/app/documents/external", label: "External documents", permission: "documents.view" },
  { to: "/app/documents/reports", label: "Document reports", permission: "documents.view" },
  { to: "/app/documents/setup", label: "Document setup", permission: "documents.admin" },
  { to: "/app/documents/disposals", label: "Document disposal", permission: "documents.disposal.approve" },
  { to: "/app/projects/projects", label: "Projects", permission: "projects.view" },
  { to: "/app/projects/portfolio", label: "Portfolio", permission: "projects.view" },
  { to: "/app/projects/my-tasks", label: "My tasks", permission: "projects.view" },
  { to: "/app/projects/resource-load", label: "Resource load", permission: "projects.view" },
  { to: "/app/assets/register", label: "Assets", permission: "assets.view" },
  { to: "/app/assets/setup", label: "Asset setup", permission: "assets.view" },
  { to: "/app/assets/custody", label: "Asset custody", permission: "assets.view" },
  { to: "/app/assets/depreciation", label: "Depreciation", permission: "assets.view" },
  { to: "/app/assets/maintenance", label: "Maintenance", permission: "assets.view" },
  { to: "/app/assets/inspections", label: "Inspections", permission: "assets.view" },
  { to: "/app/assets/coverage", label: "Insurance", permission: "assets.view" },
  { to: "/app/assets/disposals", label: "Disposals", permission: "assets.view" },
  { to: "/app/assets/counts", label: "Asset counts", permission: "assets.view" },
  { to: "/app/assets/planning", label: "Asset planning", permission: "assets.view" },
  { to: "/app/assets/fleet", label: "Fleet", permission: "assets.view" },
  { to: "/app/quality/dashboard", label: "Quality dashboard", permission: "quality.view" },
  { to: "/app/quality/ncrs", label: "Non-conformances", permission: "quality.view" },
  { to: "/app/quality/capas", label: "CAPAs", permission: "quality.view" },
  { to: "/app/quality/inspections", label: "Inspections", permission: "quality.view" },
  { to: "/app/quality/inspection-plans", label: "Inspection plans", permission: "quality.view" },
  { to: "/app/quality/holds", label: "Quality holds", permission: "quality.view" },
  { to: "/app/quality/audits", label: "Audits", permission: "quality.view" },
  { to: "/app/quality/findings", label: "Audit findings", permission: "quality.view" },
  { to: "/app/quality/suppliers", label: "Supplier quality", permission: "quality.view" },
  { to: "/app/quality/scars", label: "Supplier requests", permission: "quality.view" },
  { to: "/app/quality/complaints", label: "Customer complaints", permission: "quality.view" },
  { to: "/app/quality/risks", label: "Quality risks", permission: "quality.view" },
  { to: "/app/quality/improvement", label: "Improvement", permission: "quality.view" },
  { to: "/app/quality/equipment", label: "Equipment", permission: "quality.view" },
  { to: "/app/quality/inspection-requests", label: "Inspection requests", permission: "quality.view" },
  { to: "/app/quality/punch-list", label: "Punch list", permission: "quality.view" },
  { to: "/app/quality/plans", label: "Quality plans", permission: "quality.view" },
  { to: "/app/quality/standards", label: "Standards", permission: "quality.view" },
  { to: "/app/quality/compliance", label: "Compliance", permission: "quality.view" },
  { to: "/app/quality/reports", label: "Quality reports", permission: "quality.analytics.view" },
  { to: "/app/quality/settings", label: "Quality lists", permission: "quality.admin" },
  { to: "/app/quality/my-actions", label: "My quality actions", permission: "quality.view" },
  { to: "/app/assets/allocations", label: "Allocation and use", permission: "assets.view" },
  { to: "/app/assets/lookup", label: "Find by code", permission: "assets.view" },
  { to: "/app/assets/acquisitions", label: "Acquisitions report", permission: "assets.view" },
  { to: "/app/assets/capitalizations", label: "Capitalisation", permission: "assets.view" },
  { to: "/app/hr/leave", label: "Leave", permission: "hr.self" },
  { to: "/app/hr/attendance", label: "Attendance", permission: "hr.self" },
  { to: "/app/hr/timesheets", label: "Timesheets", permission: "hr.self" },
  { to: "/app/hr/payslips", label: "My payslips", permission: "hr.self" },
  { to: "/app/hr/attendance-admin", label: "Attendance mgmt", permission: "hr.self" },
  { to: "/app/hr/leave-admin", label: "Leave mgmt", permission: "hr.self" },
  { to: "/app/hr/work-time", label: "Work time setup", permission: "hr.self" },
  { to: "/app/hr/compensation", label: "Compensation", permission: "hr.self" },
  { to: "/app/hr/pay-setup", label: "Pay setup", permission: "hr.compensation.view" },
  { to: "/app/hr/payroll", label: "Payroll", permission: "hr.payroll.view" },
  { to: "/app/hr/employees", label: "Employees", permission: "hr.self" },
  { to: "/app/hr/recruitment", label: "Recruitment", permission: "hr.recruitment.manage" },
  { to: "/app/hr/my-interviews", label: "My interviews", permission: "hr.self" },
  { to: "/app/hr/performance", label: "Performance", permission: "hr.self" },
  { to: "/app/hr/learning", label: "Learning", permission: "hr.self" },
  { to: "/app/hr/cases", label: "Employee relations", permission: "hr.self" },
  { to: "/app/hr/policies", label: "Policies", permission: "hr.self" },
  { to: "/app/hr/reimbursements", label: "Reimbursements", permission: "hr.self" },
  { to: "/app/hr/separations", label: "Separations", permission: "hr.self" },
  { to: "/app/hr/organization", label: "Org chart", permission: "hr.self" },
  { to: "/app/hr/monitoring", label: "HR monitoring", permission: "hr.self" },
  { to: "/app/hr/analytics", label: "HR analytics", permission: "hr.analytics.view" },
  { to: "/app/hr/document-requirements", label: "Required documents", permission: "hr.view" },
  { to: "/app/hr/imports", label: "HR imports", permission: "hr.employee.manage" },
  { to: "/app/organization/company", label: "Company", permission: "org.structure.view" },
  { to: "/app/organization/structure", label: "Structure", permission: "org.structure.view" },
  { to: "/app/organization/members", label: "Member assignments", permission: "org.structure.view" },
  { to: "/app/organization/reference", label: "Currencies & calendar", permission: "org.reference.view" },
  { to: "/app/organization/numbering", label: "Numbering", permission: "org.sequences.manage" },
  { to: "/app/settings/users", label: "Users", permission: "users.view" },
  { to: "/app/settings/roles", label: "Roles", permission: "roles.view" },
  { to: "/app/settings/workflows", label: "Approval workflows", permission: "workflow.definitions.manage" },
  { to: "/app/settings/audit", label: "Audit log", permission: "audit.view" },
  { to: "/app/settings/events", label: "Integration events", permission: "events.manage" },
  { to: "/app/settings/general", label: "Workspace settings", permission: "org.settings.manage" },
  { to: "/app/settings/modules", label: "Modules", permission: "modules.view" },
];

export function AppLayout({ me }: { me: TenantMe }) {
  const { can } = useAccess();
  const { logout } = useAuth();
  const [open, setOpen] = useState(false);
  const items = NAV.filter((i) => !i.permission || can(i.permission));

  return (
    <div className="min-h-screen bg-slate-50 md:flex">
      <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50 focus:rounded focus:bg-white focus:px-3 focus:py-2">
        Skip to content
      </a>
      <aside id="main-nav" className={`${open ? "block" : "hidden"} w-full border-r border-slate-200 bg-white md:block md:w-60 md:shrink-0`}>
        <div className="border-b border-slate-100 px-4 py-4">
          <p className="text-xs uppercase tracking-wide text-slate-400">Workspace</p>
          <p className="truncate font-semibold text-slate-900">{me.tenant.name}</p>
        </div>
        <nav aria-label="Main" className="p-2">
          <ul>
            {items.map((i) => (
              <li key={i.to}>
                <NavLink
                  to={i.to}
                  end
                  onClick={() => setOpen(false)}
                  className={({ isActive }) =>
                    `block rounded-md px-3 py-2 text-sm ${isActive ? "bg-brand-50 font-medium text-brand-700" : "text-slate-600 hover:bg-slate-100"}`
                  }
                >
                  {i.label}
                </NavLink>
              </li>
            ))}
          </ul>
          {items.length === 0 && <p className="px-3 py-2 text-sm text-slate-500">No screens are available for your account yet.</p>}
        </nav>
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center justify-between gap-3 border-b border-slate-200 bg-white px-4 py-3">
          <Button variant="secondary" className="md:hidden" aria-expanded={open} aria-controls="main-nav" onClick={() => setOpen((o) => !o)}>
            Menu
          </Button>
          <div className="ml-auto flex items-center gap-3 text-sm">
            <NotificationBell />
            <span className="text-slate-600">{me.user.display_name || me.user.email}</span>
            <Button variant="secondary" onClick={logout}>
              Sign out
            </Button>
          </div>
        </header>
        <main id="main" className="flex-1 p-4 md:p-6">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
