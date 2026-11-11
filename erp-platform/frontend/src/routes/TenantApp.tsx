import { Navigate, Route, Routes } from "react-router";

import { AppLayout } from "../layouts/AppLayout";
import { useGetMeQuery } from "../shared/api/endpoints";
import { AccessProvider } from "../shared/permissions/usePermissions";
import { ErrorState, Spinner } from "../shared/ui/primitives";
import { DashboardPage } from "../features/dashboard/DashboardPage";
import { DepartmentsPage } from "../features/organization/DepartmentsPage";
import { AccountsPage } from "../features/finance/AccountsPage";
import { InvoicesPage } from "../features/finance/InvoicesPage";
import { JournalsPage } from "../features/finance/JournalsPage";
import { TrialBalancePage } from "../features/finance/TrialBalancePage";
import { InboxPage } from "../features/workflow/InboxPage";
import { RequestsPage } from "../features/workflow/RequestsPage";
import { SupplierPaymentsPage } from "../features/procurement/SupplierPaymentsPage";
import { MatchExceptionsPage } from "../features/procurement/MatchPages";
import { RfqDetailPage } from "../features/procurement/RfqDetailPage";
import { RfqsPage } from "../features/procurement/RfqsPage";
import { PurchaseOrdersPage } from "../features/procurement/PurchaseOrdersPage";
import { RequisitionsPage } from "../features/procurement/RequisitionsPage";
import { SuppliersPage } from "../features/procurement/SuppliersPage";
import { ProductsPage } from "../features/inventory/ProductsPage";
import { MyTasksPage } from "../features/projects/MyTasksPage";
import { ProjectPage } from "../features/projects/ProjectPage";
import { ProjectsPage } from "../features/projects/ProjectsPage";
import { PayrollPage } from "../features/hr/PayrollPage";
import { PayslipsPage } from "../features/hr/PayslipsPage";
import { AttendancePage } from "../features/hr/AttendancePage";
import { TimesheetsPage } from "../features/hr/TimesheetsPage";
import { EmployeePage } from "../features/hr/EmployeePage";
import { EmployeesPage } from "../features/hr/EmployeesPage";
import { LeavePage } from "../features/hr/LeavePage";
import { TransfersPage } from "../features/inventory/TransfersPage";
import { ReservationsPage } from "../features/inventory/ReservationsPage";
import { StockCountPage, StockCountsPage } from "../features/inventory/StockCountsPage";
import { StockPage } from "../features/inventory/StockPage";
import { ValuationPage } from "../features/inventory/ValuationPage";
import { WarehousesPage } from "../features/inventory/WarehousesPage";
import { LeadsPage } from "../features/crm/LeadsPage";
import { OpportunitiesPage } from "../features/crm/OpportunitiesPage";
import { OrdersPage } from "../features/sales/OrdersPage";
import { QuotationsPage } from "../features/sales/QuotationsPage";
import { BalanceSheetPage, ProfitLossPage } from "../features/finance/StatementPages";
import { StatementPage, StatementsPage } from "../features/finance/ReconciliationPages";
import { PartnersPage, TaxRatesPage } from "../features/finance/ReferencePages";
import { PaymentsPage } from "../features/finance/PaymentsPage";
import { RolesPage } from "../features/roles/RolesPage";
import { UsersPage } from "../features/users/UsersPage";

export function TenantApp() {
  const { data: me, isLoading, error, refetch } = useGetMeQuery();
  if (isLoading) return <div className="p-8"><Spinner label="Loading your workspace" /></div>;
  if (error || !me) return <div className="p-8"><ErrorState error={error} onRetry={refetch} /></div>;
  return (
    <AccessProvider me={me}>
      <Routes>
        <Route element={<AppLayout me={me} />}>
          <Route path="/app/dashboard" element={<DashboardPage />} />
          <Route path="/app/organization/departments" element={<DepartmentsPage />} />
          <Route path="/app/settings/users" element={<UsersPage />} />
          <Route path="/app/settings/roles" element={<RolesPage />} />
          <Route path="/app/finance/accounts" element={<AccountsPage />} />
          <Route path="/app/finance/journals" element={<JournalsPage />} />
          <Route path="/app/finance/invoices" element={<InvoicesPage />} />
          <Route path="/app/finance/trial-balance" element={<TrialBalancePage />} />
          <Route path="/app/approvals" element={<InboxPage />} />
          <Route path="/app/approvals/requests" element={<RequestsPage currentUserId={me.user.id} />} />
          <Route path="/app/procurement/suppliers" element={<SuppliersPage />} />
          <Route path="/app/procurement/requisitions" element={<RequisitionsPage />} />
          <Route path="/app/procurement/rfqs" element={<RfqsPage />} />
          <Route path="/app/procurement/rfqs/:id" element={<RfqDetailPage />} />
          <Route path="/app/procurement/match-exceptions" element={<MatchExceptionsPage />} />
          <Route path="/app/procurement/payments" element={<SupplierPaymentsPage />} />
          <Route path="/app/procurement/purchase-orders" element={<PurchaseOrdersPage />} />
          <Route path="/app/inventory/products" element={<ProductsPage />} />
          <Route path="/app/inventory/warehouses" element={<WarehousesPage />} />
          <Route path="/app/inventory/stock" element={<StockPage />} />
          <Route path="/app/hr/employees" element={<EmployeesPage />} />
          <Route path="/app/hr/employees/:id" element={<EmployeePage />} />
          <Route path="/app/hr/attendance" element={<AttendancePage />} />
          <Route path="/app/hr/timesheets" element={<TimesheetsPage />} />
          <Route path="/app/projects/projects" element={<ProjectsPage />} />
          <Route path="/app/projects/projects/:id" element={<ProjectPage />} />
          <Route path="/app/projects/my-tasks" element={<MyTasksPage />} />
          <Route path="/app/hr/payroll" element={<PayrollPage />} />
          <Route path="/app/hr/payslips" element={<PayslipsPage />} />
          <Route path="/app/hr/leave" element={<LeavePage />} />
          <Route path="/app/inventory/transfers" element={<TransfersPage />} />
          <Route path="/app/inventory/reservations" element={<ReservationsPage />} />
          <Route path="/app/inventory/counts" element={<StockCountsPage />} />
          <Route path="/app/inventory/counts/:id" element={<StockCountPage />} />
          <Route path="/app/inventory/valuation" element={<ValuationPage />} />
          <Route path="/app/crm/leads" element={<LeadsPage />} />
          <Route path="/app/crm/opportunities" element={<OpportunitiesPage />} />
          <Route path="/app/sales/quotations" element={<QuotationsPage />} />
          <Route path="/app/sales/orders" element={<OrdersPage />} />
          <Route path="/app/finance/payments" element={<PaymentsPage />} />
          <Route path="/app/finance/profit-loss" element={<ProfitLossPage />} />
          <Route path="/app/finance/balance-sheet" element={<BalanceSheetPage />} />
          <Route path="/app/finance/reconciliation" element={<StatementsPage />} />
          <Route path="/app/finance/reconciliation/:id" element={<StatementPage />} />
          <Route path="/app/finance/partners" element={<PartnersPage />} />
          <Route path="/app/finance/tax-rates" element={<TaxRatesPage />} />
          <Route path="*" element={<Navigate to="/app/dashboard" replace />} />
        </Route>
      </Routes>
    </AccessProvider>
  );
}
