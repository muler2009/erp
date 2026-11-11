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
  { to: "/app/approvals", label: "Approvals" },
  { to: "/app/approvals/requests", label: "Requests" },
  { to: "/app/finance/accounts", label: "Chart of accounts", permission: "finance.accounts.view" },
  { to: "/app/finance/journals", label: "Journal entries", permission: "finance.accounts.view" },
  { to: "/app/finance/invoices", label: "Invoices", permission: "finance.invoice.view" },
  { to: "/app/finance/partners", label: "Partners", permission: "finance.invoice.view" },
  { to: "/app/finance/tax-rates", label: "Tax rates", permission: "finance.accounts.view" },
  { to: "/app/finance/payments", label: "Payments", permission: "finance.invoice.view" },
  { to: "/app/finance/reconciliation", label: "Bank reconciliation", permission: "finance.accounts.view" },
  { to: "/app/finance/trial-balance", label: "Trial balance", permission: "reports.financial.view" },
  { to: "/app/finance/profit-loss", label: "Profit and loss", permission: "reports.financial.view" },
  { to: "/app/finance/balance-sheet", label: "Balance sheet", permission: "reports.financial.view" },
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
  { to: "/app/inventory/valuation", label: "Stock valuation", permission: "inventory.view" },
  { to: "/app/crm/leads", label: "Leads", permission: "crm.view" },
  { to: "/app/crm/opportunities", label: "Opportunities", permission: "crm.view" },
  { to: "/app/sales/quotations", label: "Quotations", permission: "sales.view" },
  { to: "/app/sales/orders", label: "Sales orders", permission: "sales.view" },
  { to: "/app/projects/projects", label: "Projects", permission: "projects.view" },
  { to: "/app/projects/my-tasks", label: "My tasks", permission: "projects.view" },
  { to: "/app/hr/leave", label: "Leave", permission: "hr.self" },
  { to: "/app/hr/attendance", label: "Attendance", permission: "hr.self" },
  { to: "/app/hr/timesheets", label: "Timesheets", permission: "hr.self" },
  { to: "/app/hr/payslips", label: "My payslips", permission: "hr.self" },
  { to: "/app/hr/payroll", label: "Payroll", permission: "hr.payroll.view" },
  { to: "/app/hr/employees", label: "Employees", permission: "hr.self" },
  { to: "/app/organization/departments", label: "Departments", permission: "org.structure.view" },
  { to: "/app/settings/users", label: "Users", permission: "users.view" },
  { to: "/app/settings/roles", label: "Roles", permission: "roles.view" },
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
