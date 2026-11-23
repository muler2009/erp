import { PipelineSettingsPage } from "../features/crm/CrmSetup";
import { PortfolioPage } from "../features/projects/HealthPortfolio";
import { CrmSegmentsPage, SalesSummaryPage, SpendReportPage } from "../features/reports/ModuleReports";
import { WorkflowDefinitionsPage } from "../features/workflow/DefinitionsPage";
import { EventOutboxPage, TenantAuditPage } from "../features/audit/AuditEventsPages";
import { ModulesPage, TenantSettingsPage } from "../features/settings/TenantSettingsPage";
import { NotificationPreferencesPage, NotificationsPage } from "../features/notifications/NotificationsPage";
import { AcquisitionsReportPage, AssetLookupPage } from "../features/assets/AssetTools";
import { LedgerPage } from "../features/finance/AccountEdit";
import { ProcurementSettingsPage, ProductSourcingPage } from "../features/procurement/ProcurementTools";
import { UpcomingDatesPage } from "../features/crm/AccountExtras";
import { DocRequirementsPage } from "../features/hr/DocRequirementsPage";
import { CustomerStatementPage } from "../features/sales/StatementPage";
import { KpisPage } from "../features/analytics/KpisPage";
import { ReportsPage } from "../features/analytics/ReportsPage";
import { FleetPage } from "../features/assets/FleetPage";
import { CapaListPage } from "../features/quality/CapaListPage";
import { CapaPage } from "../features/quality/CapaPage";
import { InspectionPlansPage, InspectionPlanPage } from "../features/quality/InspectionPlansPage";
import { InspectionsPage as QualityInspectionsPage } from "../features/quality/InspectionsPage";
import { InspectionPage } from "../features/quality/InspectionPage";
import { HoldsPage, HoldPage } from "../features/quality/HoldsPage";
import { AuditsPage } from "../features/quality/AuditsPage";
import { AuditPage } from "../features/quality/AuditPage";
import { FindingsPage, FindingPage } from "../features/quality/FindingsPage";
import { ChecklistTemplatesPage } from "../features/quality/ChecklistTemplatesPage";
import { SupplierQualityListPage, SupplierQualityPage } from "../features/quality/SupplierQualityPage";
import { ScarsPage, ScarPage } from "../features/quality/ScarsPage";
import { ComplaintsPage, ComplaintPage } from "../features/quality/ComplaintsPage";
import { RisksPage, RiskPage } from "../features/quality/RisksPage";
import { ImprovementPage, InitiativePage } from "../features/quality/ImprovementPage";
import { EquipmentDetailPage, EquipmentPage } from "../features/quality/EquipmentPage";
import { InspectionRequestsPage, PunchListPage, RequestPage } from "../features/quality/ProjectQaPage";
import { MasterPlanPage, MasterPlansPage } from "../features/quality/MasterPlansPage";
import { CompliancePage, StandardPage, StandardsPage } from "../features/quality/StandardsPage";
import { ReportsPage as QualityReportsPage } from "../features/quality/ReportsPage";
import { QualitySettingsPage } from "../features/quality/QualitySettingsPage";
import { MyActionsPage } from "../features/quality/MyActionsPage";
import { NcrListPage } from "../features/quality/NcrListPage";
import { NcrPage } from "../features/quality/NcrPage";
import { QualityDashboardPage } from "../features/quality/QualityDashboardPage";
import { AllocationsPage } from "../features/assets/AllocationsPage";
import { DisposalsPage } from "../features/assets/DisposalsPage";
import { CountsPage } from "../features/assets/CountsPage";
import { PlanningPage } from "../features/assets/PlanningPage";
import { InspectionsPage } from "../features/assets/InspectionsPage";
import { CoveragePage } from "../features/assets/CoveragePage";
import { MaintenancePage } from "../features/assets/MaintenancePage";
import { DepreciationPage } from "../features/assets/DepreciationPage";
import { AssetCustodyPage } from "../features/assets/AssetCustodyPage";
import { CapitalizationsPage } from "../features/assets/CapitalizationsPage";
import { AssetsPage } from "../features/assets/AssetsPage";
import { AssetPage } from "../features/assets/AssetPage";
import { AssetSetupPage } from "../features/assets/AssetSetupPage";
import { ProjectSchedulePage } from "../features/projects/ProjectSchedulePage";
import { ProjectBillingPage } from "../features/projects/ProjectBillingPage";
import { ResourceLoadPage } from "../features/projects/ResourceLoadPage";
import { ProjectFinancePage } from "../features/projects/ProjectFinancePage";
import { ProjectExpensesPage } from "../features/projects/ProjectExpensesPage";
import { ProjectRegisterPage } from "../features/projects/ProjectRegisterPage";
import { ProjectTeamPage } from "../features/projects/ProjectTeamPage";
import { SeparationsPage } from "../features/hr/SeparationsPage";
import { OrgPage } from "../features/hr/OrgPage";
import { MonitoringPage } from "../features/hr/MonitoringPage";
import { HrAnalyticsPage } from "../features/hr/HrAnalyticsPage";
import { ImportPage } from "../features/hr/ImportPage";
import { PerformancePage } from "../features/hr/PerformancePage";
import { LearningPage } from "../features/hr/LearningPage";
import { CasesPage } from "../features/hr/CasesPage";
import { PoliciesPage } from "../features/hr/PoliciesPage";
import { ReimbursementsPage } from "../features/hr/ReimbursementsPage";
import { RecruitmentPage } from "../features/hr/RecruitmentPage";
import { CandidatesPage, MyInterviewsPage } from "../features/hr/CandidatesPage";
import { Navigate, Route, Routes } from "react-router";

import { AppLayout } from "../layouts/AppLayout";
import { useGetMeQuery } from "../shared/api/endpoints";
import { AccessProvider } from "../shared/permissions/usePermissions";
import { ErrorState, Spinner } from "../shared/ui/primitives";
import { DashboardPage } from "../features/dashboard/DashboardPage";
import { CompanyPage } from "../features/organization/CompanyPage";
import { MembersPage } from "../features/organization/MembersPage";
import { NumberingPage } from "../features/organization/NumberingPage";
import { ReferencePage } from "../features/organization/ReferencePage";
import { StructurePage } from "../features/organization/StructurePage";
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
import { ProcurementOverviewPage } from "../features/procurement/OverviewPage";
import { ProcurementAnalyticsPage } from "../features/procurement/AnalyticsPage";
import { ReceivingPage } from "../features/procurement/ReceivingPage";
import { ReturnsClaimsPage } from "../features/procurement/ReturnsClaimsPage";
import { PurchaseContractsPage } from "../features/procurement/PurchaseContractsPage";
import { BlanketOrdersPage } from "../features/procurement/BlanketOrdersPage";
import { SupplierProfilePage } from "../features/procurement/SupplierProfilePage";
import TendersPage from "../features/procurement/TendersPage";
import { SingleSourcePage } from "../features/procurement/SingleSourcePage";
import { AdjustmentsPage } from "../features/inventory/AdjustmentsPage";
import { LandedCostsPage } from "../features/inventory/LandedCostsPage";
import { MaterialRequisitionsPage } from "../features/inventory/MaterialRequisitionsPage";
import { ProductionOrdersPage } from "../features/manufacturing/ProductionOrdersPage";
import { PlanningPage as MfgPlanningPage } from "../features/manufacturing/PlanningPage";
import { PlansPage } from "../features/manufacturing/PlansPage";
import { BomsPage } from "../features/manufacturing/BomsPage";
import { ForecastsPage } from "../features/supply_chain/ForecastsPage";
import { ReplenishmentPage } from "../features/supply_chain/ReplenishmentPage";
import { RisksPage as SupplyRisksPage } from "../features/supply_chain/RisksPage";
import { DemandsPage } from "../features/supply_chain/DemandsPage";
import { FulfilmentPage } from "../features/supply_chain/FulfilmentPage";
import { VehiclesPage as ScVehiclesPage } from "../features/supply_chain/VehiclesPage";
import { SupplyAnalyticsPage } from "../features/supply_chain/SupplyAnalyticsPage";
import { ShipmentsPage } from "../features/supply_chain/ShipmentsPage";
import { LogisticsSetupPage } from "../features/supply_chain/LogisticsSetupPage";
import { LogisticsReportsPage } from "../features/supply_chain/LogisticsReportsPage";
import { LinesProfilePage } from "../features/manufacturing/LinesProfilePage";
import { DowntimePage } from "../features/manufacturing/DowntimePage";
import { AnalyticsPage as MfgAnalyticsPage } from "../features/manufacturing/AnalyticsPage";
import { WorkCentersPage } from "../features/manufacturing/WorkCentersPage";
import { InventoryReportsPage } from "../features/inventory/InventoryReportsPage";
import { ItemSetupPage } from "../features/inventory/ItemSetupPage";
import { StockControlPage } from "../features/inventory/StockControlPage";
import { TraceabilityPage } from "../features/inventory/TraceabilityPage";
import { SupplierRiskPage } from "../features/procurement/SupplierRiskPage";
import { BudgetsPage } from "../features/procurement/BudgetsPage";
import { SuppliersPage } from "../features/procurement/SuppliersPage";
import { ProductsPage } from "../features/inventory/ProductsPage";
import { MyTasksPage } from "../features/projects/MyTasksPage";
import { ProjectPage } from "../features/projects/ProjectPage";
import { ProjectsPage } from "../features/projects/ProjectsPage";
import { AttendanceAdminPage } from "../features/hr/AttendanceAdminPage";
import { LeaveAdminPage } from "../features/hr/LeaveAdminPage";
import { WorkTimePage } from "../features/hr/WorkTimePage";
import { CompensationPage } from "../features/hr/CompensationPage";
import { PaySetupPage } from "../features/hr/PaySetupPage";
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
import { InsightsPage } from "../features/crm/InsightsPage";
import { TeamsPage } from "../features/crm/TeamsPage";
import { ServiceCaseDetailPage } from "../features/crm/ServiceCaseDetailPage";
import { ServiceCasesPage } from "../features/crm/ServiceCasesPage";
import { ServiceReportPage } from "../features/crm/ServiceReportPage";
import { CampaignDetailPage } from "../features/crm/CampaignDetailPage";
import { CampaignsPage } from "../features/crm/CampaignsPage";
import { ActivitiesPage } from "../features/crm/ActivitiesPage";
import { CrmReportsPage } from "../features/crm/CrmReportsPage";
import { OpportunityDetailPage } from "../features/crm/OpportunityDetailPage";
import { AccountDetailPage } from "../features/crm/AccountDetailPage";
import { CrmAccountsPage } from "../features/crm/AccountsPage";
import { ContactsPage } from "../features/crm/ContactsPage";
import { LeadsPage } from "../features/crm/LeadsPage";
import { OpportunitiesPage } from "../features/crm/OpportunitiesPage";
import { OrdersPage } from "../features/sales/OrdersPage";
import { DeliveriesPage } from "../features/sales/DeliveriesPage";
import { DeliveryDetailPage } from "../features/sales/DeliveryDetailPage";
import { AcknowledgementsPage } from "../features/documents/AcknowledgementsPage";
import { DocumentAdminPage } from "../features/documents/DocumentAdminPage";
import { DocumentReportsPage } from "../features/documents/DocumentReportsPage";
import { ExternalPage } from "../features/documents/ExternalPage";
import { FavouritesPage } from "../features/documents/FavouritesPage";
import { DisposalPage } from "../features/documents/DisposalPage";
import { DocumentDetailPage } from "../features/documents/DocumentDetailPage";
import { DocumentsPage } from "../features/documents/DocumentsPage";
import { BackordersPage } from "../features/sales/BackordersPage";
import { AgingPage } from "../features/sales/AgingPage";
import { ContractsPage } from "../features/sales/ContractsPage";
import { ContractDetailPage } from "../features/sales/ContractDetailPage";
import { CommissionsPage } from "../features/sales/CommissionsPage";
import { SalesAnalyticsPage } from "../features/sales/AnalyticsPage";
import { ReturnsPage } from "../features/sales/ReturnsPage";
import { PricingPage } from "../features/sales/PricingPage";
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
          <Route path="/app/organization/company" element={<CompanyPage />} />
          <Route path="/app/organization/structure" element={<StructurePage />} />
          <Route path="/app/organization/reference" element={<ReferencePage />} />
          <Route path="/app/organization/numbering" element={<NumberingPage />} />
          <Route path="/app/organization/members" element={<MembersPage />} />
          <Route path="/app/organization/departments" element={<Navigate to="/app/organization/structure" replace />} />
          <Route path="/app/settings/users" element={<UsersPage />} />
          <Route path="/app/settings/roles" element={<RolesPage />} />
          <Route path="/app/finance/accounts" element={<AccountsPage />} />
          <Route path="/app/finance/journals" element={<JournalsPage />} />
          <Route path="/app/finance/invoices" element={<InvoicesPage />} />
          <Route path="/app/finance/ledger" element={<LedgerPage />} />
          <Route path="/app/finance/trial-balance" element={<TrialBalancePage />} />
          <Route path="/app/crm/pipeline-settings" element={<PipelineSettingsPage />} />
          <Route path="/app/crm/segments" element={<CrmSegmentsPage />} />
          <Route path="/app/sales/summary" element={<SalesSummaryPage />} />
          <Route path="/app/procurement/spend" element={<SpendReportPage />} />
          <Route path="/app/settings/workflows" element={<WorkflowDefinitionsPage />} />
          <Route path="/app/settings/audit" element={<TenantAuditPage />} />
          <Route path="/app/settings/events" element={<EventOutboxPage />} />
          <Route path="/app/settings/general" element={<TenantSettingsPage />} />
          <Route path="/app/settings/modules" element={<ModulesPage />} />
          <Route path="/app/notifications" element={<NotificationsPage />} />
          <Route path="/app/notifications/preferences" element={<NotificationPreferencesPage />} />
          <Route path="/app/approvals" element={<InboxPage />} />
          <Route path="/app/approvals/requests" element={<RequestsPage currentUserId={me.user.id} />} />
          <Route path="/app/procurement/overview" element={<ProcurementOverviewPage />} />
          <Route path="/app/procurement/settings" element={<ProcurementSettingsPage />} />
          <Route path="/app/procurement/product-sourcing" element={<ProductSourcingPage />} />
          <Route path="/app/procurement/analytics" element={<ProcurementAnalyticsPage />} />
          <Route path="/app/procurement/receiving" element={<ReceivingPage />} />
          <Route path="/app/procurement/returns" element={<ReturnsClaimsPage />} />
          <Route path="/app/procurement/contracts" element={<PurchaseContractsPage />} />
          <Route path="/app/procurement/blanket-orders" element={<BlanketOrdersPage />} />
          <Route path="/app/procurement/suppliers/:id" element={<SupplierProfilePage />} />
          <Route path="/app/procurement/tenders" element={<TendersPage />} />
          <Route path="/app/procurement/single-source" element={<SingleSourcePage />} />
          <Route path="/app/procurement/supplier-risk" element={<SupplierRiskPage />} />
          <Route path="/app/procurement/budgets" element={<BudgetsPage />} />
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
          <Route path="/app/hr/recruitment" element={<RecruitmentPage />} />
          <Route path="/app/hr/recruitment/:id" element={<CandidatesPage />} />
          <Route path="/app/hr/my-interviews" element={<MyInterviewsPage />} />
          <Route path="/app/hr/performance" element={<PerformancePage />} />
          <Route path="/app/hr/separations" element={<SeparationsPage />} />
          <Route path="/app/hr/organization" element={<OrgPage />} />
          <Route path="/app/hr/monitoring" element={<MonitoringPage />} />
          <Route path="/app/analytics/kpis" element={<KpisPage />} />
          <Route path="/app/analytics/reports" element={<ReportsPage />} />
          <Route path="/app/hr/analytics" element={<HrAnalyticsPage />} />
          <Route path="/app/hr/document-requirements" element={<DocRequirementsPage />} />
          <Route path="/app/hr/imports" element={<ImportPage />} />
          <Route path="/app/hr/learning" element={<LearningPage />} />
          <Route path="/app/hr/cases" element={<CasesPage />} />
          <Route path="/app/hr/policies" element={<PoliciesPage />} />
          <Route path="/app/hr/reimbursements" element={<ReimbursementsPage />} />
          <Route path="/app/hr/employees/:id" element={<EmployeePage />} />
          <Route path="/app/hr/attendance" element={<AttendancePage />} />
          <Route path="/app/hr/timesheets" element={<TimesheetsPage />} />
          <Route path="/app/projects/projects" element={<ProjectsPage />} />
          <Route path="/app/projects/projects/:id" element={<ProjectPage />} />
          <Route path="/app/projects/projects/:id/finance" element={<ProjectFinancePage />} />
          <Route path="/app/projects/projects/:id/expenses" element={<ProjectExpensesPage />} />
          <Route path="/app/projects/projects/:id/risks" element={<ProjectRegisterPage />} />
          <Route path="/app/projects/projects/:id/team" element={<ProjectTeamPage />} />
          <Route path="/app/projects/projects/:id/schedule" element={<ProjectSchedulePage />} />
          <Route path="/app/projects/projects/:id/billing" element={<ProjectBillingPage />} />
          <Route path="/app/projects/portfolio" element={<PortfolioPage />} />
          <Route path="/app/projects/resource-load" element={<ResourceLoadPage />} />
          <Route path="/app/assets/lookup" element={<AssetLookupPage />} />
          <Route path="/app/assets/acquisitions" element={<AcquisitionsReportPage />} />
          <Route path="/app/assets/register" element={<AssetsPage />} />
          <Route path="/app/assets/register/:id" element={<AssetPage />} />
          <Route path="/app/assets/setup" element={<AssetSetupPage />} />
          <Route path="/app/assets/custody" element={<AssetCustodyPage />} />
          <Route path="/app/assets/depreciation" element={<DepreciationPage />} />
          <Route path="/app/assets/maintenance" element={<MaintenancePage />} />
          <Route path="/app/assets/inspections" element={<InspectionsPage />} />
          <Route path="/app/assets/coverage" element={<CoveragePage />} />
          <Route path="/app/assets/disposals" element={<DisposalsPage />} />
          <Route path="/app/assets/counts" element={<CountsPage />} />
          <Route path="/app/assets/planning" element={<PlanningPage />} />
          <Route path="/app/assets/fleet" element={<FleetPage />} />
          <Route path="/app/assets/allocations" element={<AllocationsPage />} />
          <Route path="/app/quality/dashboard" element={<QualityDashboardPage />} />
          <Route path="/app/quality/ncrs" element={<NcrListPage />} />
          <Route path="/app/quality/ncrs/:id" element={<NcrPage />} />
          <Route path="/app/quality/my-actions" element={<MyActionsPage />} />
          <Route path="/app/quality/capas" element={<CapaListPage />} />
          <Route path="/app/quality/capas/:id" element={<CapaPage />} />
          <Route path="/app/quality/inspection-plans" element={<InspectionPlansPage />} />
          <Route path="/app/quality/inspection-plans/:id" element={<InspectionPlanPage />} />
          <Route path="/app/quality/inspections" element={<QualityInspectionsPage />} />
          <Route path="/app/quality/inspections/:id" element={<InspectionPage />} />
          <Route path="/app/quality/holds" element={<HoldsPage />} />
          <Route path="/app/quality/holds/:id" element={<HoldPage />} />
          <Route path="/app/quality/audits" element={<AuditsPage />} />
          <Route path="/app/quality/audits/:id" element={<AuditPage />} />
          <Route path="/app/quality/findings" element={<FindingsPage />} />
          <Route path="/app/quality/findings/:id" element={<FindingPage />} />
          <Route path="/app/quality/checklist-templates" element={<ChecklistTemplatesPage />} />
          <Route path="/app/quality/suppliers" element={<SupplierQualityListPage />} />
          <Route path="/app/quality/suppliers/:id" element={<SupplierQualityPage />} />
          <Route path="/app/quality/scars" element={<ScarsPage />} />
          <Route path="/app/quality/scars/:id" element={<ScarPage />} />
          <Route path="/app/quality/complaints" element={<ComplaintsPage />} />
          <Route path="/app/quality/complaints/:id" element={<ComplaintPage />} />
          <Route path="/app/quality/risks" element={<RisksPage />} />
          <Route path="/app/quality/risks/:id" element={<RiskPage />} />
          <Route path="/app/quality/improvement" element={<ImprovementPage />} />
          <Route path="/app/quality/initiatives/:id" element={<InitiativePage />} />
          <Route path="/app/quality/equipment" element={<EquipmentPage />} />
          <Route path="/app/quality/equipment/:id" element={<EquipmentDetailPage />} />
          <Route path="/app/quality/inspection-requests" element={<InspectionRequestsPage />} />
          <Route path="/app/quality/inspection-requests/:id" element={<RequestPage />} />
          <Route path="/app/quality/punch-list" element={<PunchListPage />} />
          <Route path="/app/quality/plans" element={<MasterPlansPage />} />
          <Route path="/app/quality/plans/:id" element={<MasterPlanPage />} />
          <Route path="/app/quality/standards" element={<StandardsPage />} />
          <Route path="/app/quality/standards/:id" element={<StandardPage />} />
          <Route path="/app/quality/compliance" element={<CompliancePage />} />
          <Route path="/app/quality/reports" element={<QualityReportsPage />} />
          <Route path="/app/quality/settings" element={<QualitySettingsPage />} />
          <Route path="/app/assets/capitalizations" element={<CapitalizationsPage />} />
          <Route path="/app/projects/my-tasks" element={<MyTasksPage />} />
          <Route path="/app/hr/attendance-admin" element={<AttendanceAdminPage />} />
          <Route path="/app/hr/leave-admin" element={<LeaveAdminPage />} />
          <Route path="/app/hr/work-time" element={<WorkTimePage />} />
          <Route path="/app/hr/compensation" element={<CompensationPage />} />
          <Route path="/app/hr/pay-setup" element={<PaySetupPage />} />
          <Route path="/app/hr/payroll" element={<PayrollPage />} />
          <Route path="/app/hr/payslips" element={<PayslipsPage />} />
          <Route path="/app/hr/leave" element={<LeavePage />} />
          <Route path="/app/inventory/transfers" element={<TransfersPage />} />
          <Route path="/app/inventory/reservations" element={<ReservationsPage />} />
          <Route path="/app/inventory/counts" element={<StockCountsPage />} />
          <Route path="/app/inventory/counts/:id" element={<StockCountPage />} />
          <Route path="/app/inventory/stock-control" element={<StockControlPage />} />
          <Route path="/app/inventory/traceability" element={<TraceabilityPage />} />
          <Route path="/app/inventory/adjustments" element={<AdjustmentsPage />} />
          <Route path="/app/inventory/landed-costs" element={<LandedCostsPage />} />
          <Route path="/app/inventory/requisitions" element={<MaterialRequisitionsPage />} />
          <Route path="/app/inventory/reports" element={<InventoryReportsPage />} />
          <Route path="/app/inventory/item-setup" element={<ItemSetupPage />} />
          <Route path="/app/manufacturing/work-centers" element={<WorkCentersPage />} />
          <Route path="/app/manufacturing/orders" element={<ProductionOrdersPage />} />
          <Route path="/app/manufacturing/plans" element={<PlansPage />} />
          <Route path="/app/manufacturing/planning" element={<MfgPlanningPage />} />
          <Route path="/app/manufacturing/boms" element={<BomsPage />} />
          <Route path="/app/supply-chain/shipments" element={<ShipmentsPage />} />
          <Route path="/app/supply-chain/forecasts" element={<ForecastsPage />} />
          <Route path="/app/supply-chain/replenishment" element={<ReplenishmentPage />} />
          <Route path="/app/supply-chain/risks" element={<SupplyRisksPage />} />
          <Route path="/app/supply-chain/demands" element={<DemandsPage />} />
          <Route path="/app/supply-chain/fulfilment" element={<FulfilmentPage />} />
          <Route path="/app/supply-chain/vehicles" element={<ScVehiclesPage />} />
          <Route path="/app/supply-chain/analytics" element={<SupplyAnalyticsPage />} />
          <Route path="/app/supply-chain/carriers" element={<LogisticsSetupPage />} />
          <Route path="/app/supply-chain/logistics-reports" element={<LogisticsReportsPage />} />
          <Route path="/app/manufacturing/lines" element={<LinesProfilePage />} />
          <Route path="/app/manufacturing/downtime" element={<DowntimePage />} />
          <Route path="/app/manufacturing/reports" element={<MfgAnalyticsPage />} />
          <Route path="/app/inventory/valuation" element={<ValuationPage />} />
          <Route path="/app/crm/accounts" element={<CrmAccountsPage />} />
          <Route path="/app/crm/accounts/:id" element={<AccountDetailPage />} />
          <Route path="/app/crm/contacts" element={<ContactsPage />} />
          <Route path="/app/crm/dates" element={<UpcomingDatesPage />} />
          <Route path="/app/crm/leads" element={<LeadsPage />} />
          <Route path="/app/crm/opportunities" element={<OpportunitiesPage />} />
          <Route path="/app/crm/opportunities/:id" element={<OpportunityDetailPage />} />
          <Route path="/app/crm/activities" element={<ActivitiesPage />} />
          <Route path="/app/crm/campaigns" element={<CampaignsPage />} />
          <Route path="/app/crm/campaigns/:id" element={<CampaignDetailPage />} />
          <Route path="/app/crm/cases" element={<ServiceCasesPage />} />
          <Route path="/app/crm/cases/:id" element={<ServiceCaseDetailPage />} />
          <Route path="/app/crm/service-report" element={<ServiceReportPage />} />
          <Route path="/app/crm/teams" element={<TeamsPage />} />
          <Route path="/app/crm/insights" element={<InsightsPage />} />
          <Route path="/app/crm/reports" element={<CrmReportsPage />} />
          <Route path="/app/sales/quotations" element={<QuotationsPage />} />
          <Route path="/app/sales/deliveries" element={<DeliveriesPage />} />
          <Route path="/app/sales/deliveries/:id" element={<DeliveryDetailPage />} />
          <Route path="/app/documents" element={<DocumentsPage />} />
          <Route path="/app/documents/acknowledgements" element={<AcknowledgementsPage />} />
          <Route path="/app/documents/external" element={<ExternalPage />} />
          <Route path="/app/documents/setup" element={<DocumentAdminPage />} />
          <Route path="/app/documents/reports" element={<DocumentReportsPage />} />
          <Route path="/app/documents/favourites" element={<FavouritesPage />} />
          <Route path="/app/documents/disposals" element={<DisposalPage />} />
          <Route path="/app/documents/:id" element={<DocumentDetailPage />} />
          <Route path="/app/sales/backorders" element={<BackordersPage />} />
          <Route path="/app/sales/aging" element={<AgingPage />} />
          <Route path="/app/sales/contracts" element={<ContractsPage />} />
          <Route path="/app/sales/contracts/:id" element={<ContractDetailPage />} />
          <Route path="/app/sales/commissions" element={<CommissionsPage />} />
          <Route path="/app/sales/analytics" element={<SalesAnalyticsPage />} />
          <Route path="/app/sales/returns" element={<ReturnsPage />} />
          <Route path="/app/sales/pricing" element={<PricingPage />} />
          <Route path="/app/sales/statements" element={<CustomerStatementPage />} />
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
