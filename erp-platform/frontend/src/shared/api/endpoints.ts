/**
 * Every backend call the app makes, as RTK Query endpoints. Screens use the generated hooks
 * (useGetMeQuery, useListUsersQuery, useInviteUserMutation, ...) and never call fetch themselves.
 */
import { normalizePage, withCursor } from "./cursor";
import { baseApi } from "./baseApi";
import type { AssignmentChange, ChecklistItem, Contract, EmployeeDetail, EmployeeInput, EmployeeProfile, HistoryEvent, Position, Separation, Project, ProjectInput, ProjectTask, TaskInput, PayrollRun, PayrollRunDetail, Payslip, AttendanceRecord, Timesheet, TimesheetInput, Employee, HrMe, LeaveInput, LeaveRequest, LeaveType, Availability, Reservation, ReservationInput, TransferInput, TransferNote, TransferReceiptLine, TransferRow, CountVariance, StockCountInput, StockCountRow, WorksheetLine, AgeingRow, DueInvoice, SupplierPaymentResult, WhtRow, MatchException, MatchResult, Rfq, RfqComparison, RfqDetail, RfqInput, InvoiceUpdate, PartnerInput, TaxRateInput, BankStatement, LedgerCandidate, StatementInput, BalanceSheet, ProfitLoss, BankAccount, InvoiceInput, Partner, Payment, PaymentInput, TaxRate, CrmAccount, Lead, Opportunity, PipelineStage, Quotation, SalesOrder, DirectoryUser, MovementInput, Product, StockAlert, StockLevelRow, StockMovementRow, ValuationReport, Warehouse, PurchaseOrder, Requisition, Supplier, WorkflowInstance, WorkflowTask, Account, DashboardSummary, Invoice, JournalEntry, TrialBalance, DashboardView, Department, Membership, Page, PlatformAuditEvent, PlatformMe, PlatformTenant, ProvisioningJob, Role, TenantMe } from "./types";

type RawPage<T> = { results: T[]; next: string | null; previous: string | null };

export const api = baseApi.injectEndpoints({
  endpoints: (build) => ({
    getMe: build.query<TenantMe, void>({
      query: () => "api/v1/me",
      providesTags: ["Me"],
    }),

    listUsers: build.query<Page<Membership>, { cursor?: string | null } | void>({
      query: (arg) => withCursor("api/v1/users", arg?.cursor),
      transformResponse: (raw: RawPage<Membership>) => normalizePage(raw),
      providesTags: ["Users"],
    }),
    inviteUser: build.mutation<Membership, { email: string; display_name: string; role_ids: string[] }>({
      query: (body) => ({ url: "api/v1/users/invite", method: "POST", body }),
      invalidatesTags: ["Users"],
    }),
    deactivateUser: build.mutation<unknown, string>({
      query: (membershipId) => ({ url: `api/v1/users/${membershipId}/deactivate`, method: "POST" }),
      invalidatesTags: ["Users"],
    }),
    reactivateUser: build.mutation<unknown, string>({
      query: (membershipId) => ({ url: `api/v1/users/${membershipId}/reactivate`, method: "POST" }),
      invalidatesTags: ["Users"],
    }),

    listRoles: build.query<Role[], void>({
      query: () => "api/v1/roles",
      providesTags: ["Roles"],
    }),

    listDepartments: build.query<Page<Department>, { cursor?: string | null } | void>({
      query: (arg) => withCursor("api/v1/org/departments", arg?.cursor),
      transformResponse: (raw: RawPage<Department>) => normalizePage(raw),
      providesTags: ["Departments"],
    }),

    listDashboards: build.query<DashboardSummary[], void>({
      query: () => "api/v1/analytics/dashboards",
      providesTags: ["Dashboards"],
    }),
    getDashboard: build.query<DashboardView, string>({
      query: (id) => `api/v1/analytics/dashboards/${id}`,
      providesTags: (_r, _e, id) => [{ type: "Dashboards", id }],
    }),
    getPlatformMe: build.query<PlatformMe, void>({
      query: () => "api/v1/platform/me",
      providesTags: ["Me"],
    }),
    listTenants: build.query<Page<PlatformTenant>, { cursor?: string | null } | void>({
      query: (arg) => withCursor("api/v1/platform/tenants", arg?.cursor),
      transformResponse: (raw: RawPage<PlatformTenant>) => normalizePage(raw),
      providesTags: ["Tenants"],
    }),
    createTenant: build.mutation<
      { tenant: PlatformTenant; job: ProvisioningJob },
      { body: { name: string; slug: string; plan: string; admin_email: string; admin_display_name: string }; idempotencyKey: string }
    >({
      query: ({ body, idempotencyKey }) => ({ url: "api/v1/platform/tenants", method: "POST", body, headers: { "Idempotency-Key": idempotencyKey } }),
      invalidatesTags: ["Tenants"],
    }),
    tenantLifecycle: build.mutation<PlatformTenant, { id: string; action: "suspend" | "reactivate" | "deactivate" | "request_deletion" | "recover" }>({
      query: ({ id, action }) => ({ url: `api/v1/platform/tenants/${id}/lifecycle/${action}`, method: "POST", body: {} }),
      invalidatesTags: ["Tenants", "Audit"],
    }),
    retryProvisioning: build.mutation<unknown, string>({
      query: (id) => ({ url: `api/v1/platform/tenants/${id}/provision`, method: "POST", body: {} }),
      invalidatesTags: ["Tenants"],
    }),
    listPlatformAudit: build.query<Page<PlatformAuditEvent>, { cursor?: string | null } | void>({
      query: (arg) => withCursor("api/v1/platform/audit-events", arg?.cursor),
      transformResponse: (raw: RawPage<PlatformAuditEvent>) => normalizePage(raw),
      providesTags: ["Audit"],
    }),

    listAccounts: build.query<Page<Account>, { cursor?: string | null } | void>({
      query: (arg) => withCursor("api/v1/finance/accounts", arg?.cursor),
      transformResponse: (raw: RawPage<Account>) => normalizePage(raw),
      providesTags: ["Accounts"],
    }),
    createAccount: build.mutation<Account, { code: string; name: string; type: string; is_postable: boolean }>({
      query: (body) => ({ url: "api/v1/finance/accounts", method: "POST", body }),
      invalidatesTags: ["Accounts"],
    }),
    listJournals: build.query<Page<JournalEntry>, { cursor?: string | null; status?: string } | void>({
      query: (arg) => withCursor("api/v1/finance/journals", arg?.cursor, arg?.status ? { status: arg.status } : {}),
      transformResponse: (raw: RawPage<JournalEntry>) => normalizePage(raw),
      providesTags: ["Journals"],
    }),
    getJournal: build.query<JournalEntry, string>({
      query: (id) => `api/v1/finance/journals/${id}`,
      providesTags: (_r, _e, id) => [{ type: "Journals", id }],
    }),
    createJournal: build.mutation<JournalEntry, { entry_date: string; memo: string; lines: { account: string; debit: string; credit: string; description: string }[] }>({
      query: (body) => ({ url: "api/v1/finance/journals", method: "POST", body }),
      invalidatesTags: ["Journals"],
    }),
    journalAction: build.mutation<JournalEntry, { id: string; action: "post" | "reverse" }>({
      query: ({ id, action }) => ({ url: `api/v1/finance/journals/${id}/${action}`, method: "POST", body: {} }),
      invalidatesTags: ["Journals", "Reports"],
    }),
    listInvoices: build.query<Page<Invoice>, { cursor?: string | null; kind?: string; status?: string } | void>({
      query: (arg) => withCursor("api/v1/finance/invoices", arg?.cursor, { ...(arg?.kind ? { kind: arg.kind } : {}), ...(arg?.status ? { status: arg.status } : {}) }),
      transformResponse: (raw: RawPage<Invoice>) => normalizePage(raw),
      providesTags: ["Invoices"],
    }),
    getInvoice: build.query<Invoice, string>({
      query: (id) => `api/v1/finance/invoices/${id}`,
      providesTags: (_r, _e, id) => [{ type: "Invoices", id }],
    }),
    invoiceAction: build.mutation<Invoice, { id: string; action: "submit" | "approve" | "post" | "void" }>({
      query: ({ id, action }) => ({ url: `api/v1/finance/invoices/${id}/${action}`, method: "POST", body: {} }),
      invalidatesTags: ["Invoices", "Reports"],
    }),
    applyCredit: build.mutation<{ id: string; amount: string }, { creditNoteId: string; invoice: string; amount: string }>({
      query: ({ creditNoteId, ...body }) => ({ url: `api/v1/finance/invoices/${creditNoteId}/apply-credit`, method: "POST", body }),
      invalidatesTags: ["Invoices", "Reports"],
    }),
    listBankStatements: build.query<Page<BankStatement>, { cursor?: string | null } | void>({
      query: (arg) => withCursor("api/v1/finance/bank-statements", arg?.cursor),
      transformResponse: (raw: RawPage<BankStatement>) => normalizePage(raw),
      providesTags: ["BankStatements"],
    }),
    getBankStatement: build.query<BankStatement, string>({
      query: (id) => `api/v1/finance/bank-statements/${id}`,
      providesTags: ["BankStatements"],
    }),
    createBankStatement: build.mutation<BankStatement, StatementInput>({
      query: (body) => ({ url: "api/v1/finance/bank-statements", method: "POST", body }),
      invalidatesTags: ["BankStatements"],
    }),
    listStatementCandidates: build.query<Page<LedgerCandidate>, { id: string; amount: string }>({
      query: ({ id, amount }) => withCursor(`api/v1/finance/bank-statements/${id}/candidates`, null, { amount }),
      transformResponse: (raw: RawPage<LedgerCandidate>) => normalizePage(raw),
      providesTags: ["BankStatements"],
    }),
    matchBankLine: build.mutation<unknown, { id: string; lineId: string; journalLine: string }>({
      query: ({ id, lineId, journalLine }) => ({ url: `api/v1/finance/bank-statements/${id}/lines/${lineId}/match`, method: "POST", body: { journal_line: journalLine } }),
      invalidatesTags: ["BankStatements"],
    }),
    unmatchBankLine: build.mutation<unknown, { id: string; lineId: string }>({
      query: ({ id, lineId }) => ({ url: `api/v1/finance/bank-statements/${id}/lines/${lineId}/unmatch`, method: "POST", body: {} }),
      invalidatesTags: ["BankStatements"],
    }),
    reconcileStatement: build.mutation<BankStatement, string>({
      query: (id) => ({ url: `api/v1/finance/bank-statements/${id}/reconcile`, method: "POST", body: {} }),
      invalidatesTags: ["BankStatements"],
    }),
    getTrialBalance: build.query<TrialBalance, { asOf: string }>({
      query: ({ asOf }) => withCursor("api/v1/finance/reports/trial-balance", null, { as_of: asOf }),
      providesTags: ["Reports"],
    }),

    getProfitLoss: build.query<ProfitLoss, { from: string; to: string }>({
      query: ({ from, to }) => withCursor("api/v1/finance/reports/profit-loss", null, { from, to }),
      providesTags: ["Reports"],
    }),
    getBalanceSheet: build.query<BalanceSheet, { asOf: string }>({
      query: ({ asOf }) => withCursor("api/v1/finance/reports/balance-sheet", null, { as_of: asOf }),
      providesTags: ["Reports"],
    }),

    listInbox: build.query<Page<WorkflowTask>, { cursor?: string | null } | void>({
      query: (arg) => withCursor("api/v1/workflows/inbox", arg?.cursor),
      transformResponse: (raw: RawPage<WorkflowTask>) => normalizePage(raw),
      providesTags: ["Workflow"],
    }),
    listWorkflowInstances: build.query<Page<WorkflowInstance>, { cursor?: string | null; status?: string } | void>({
      query: (arg) => withCursor("api/v1/workflows/instances", arg?.cursor, arg?.status ? { status: arg.status } : {}),
      transformResponse: (raw: RawPage<WorkflowInstance>) => normalizePage(raw),
      providesTags: ["Workflow"],
    }),
    getWorkflowInstance: build.query<WorkflowInstance, string>({
      query: (id) => `api/v1/workflows/instances/${id}`,
      providesTags: (_r, _e, id) => [{ type: "Workflow", id }],
    }),
    decideTask: build.mutation<WorkflowInstance, { taskId: string; decision: "APPROVE" | "REJECT" | "REQUEST_CHANGES"; comment: string }>({
      query: ({ taskId, decision, comment }) => ({ url: `api/v1/workflows/tasks/${taskId}/decide`, method: "POST", body: { decision, comment } }),
      // A decision can change the business record too (e.g. an invoice becomes APPROVED).
      invalidatesTags: ["Workflow", "Invoices", "Journals"],
    }),
    cancelWorkflow: build.mutation<WorkflowInstance, { id: string; comment: string }>({
      query: ({ id, comment }) => ({ url: `api/v1/workflows/instances/${id}/cancel`, method: "POST", body: { comment } }),
      invalidatesTags: ["Workflow", "Invoices"],
    }),

    searchDirectory: build.query<DirectoryUser[], string>({
      query: (q) => withCursor("api/v1/directory/users", null, { q }),
      transformResponse: (raw: { results: DirectoryUser[] }) => raw.results,
    }),
    delegateTask: build.mutation<unknown, { taskId: string; toUserId: string; comment: string }>({
      query: ({ taskId, toUserId, comment }) => ({ url: `api/v1/workflows/tasks/${taskId}/delegate`, method: "POST", body: { to_user_id: toUserId, comment } }),
      invalidatesTags: ["Workflow"],
    }),
    resubmitWorkflow: build.mutation<WorkflowInstance, { id: string; comment: string; amount?: string }>({
      query: ({ id, ...body }) => ({ url: `api/v1/workflows/instances/${id}/resubmit`, method: "POST", body }),
      invalidatesTags: ["Workflow", "Invoices"],
    }),

    listSuppliers: build.query<Page<Supplier>, { cursor?: string | null; status?: string } | void>({
      query: (arg) => withCursor("api/v1/procurement/suppliers", arg?.cursor, arg?.status ? { status: arg.status } : {}),
      transformResponse: (raw: RawPage<Supplier>) => normalizePage(raw),
      providesTags: ["Suppliers"],
    }),
    createSupplier: build.mutation<Supplier, { name: string; tax_id: string; email: string }>({
      query: (body) => ({ url: "api/v1/procurement/suppliers", method: "POST", body }),
      invalidatesTags: ["Suppliers"],
    }),
    supplierAction: build.mutation<Supplier, { id: string; action: "qualify" | "block"; text: string }>({
      query: ({ id, action, text }) => ({ url: `api/v1/procurement/suppliers/${id}/${action}`, method: "POST", body: action === "qualify" ? { notes: text } : { reason: text } }),
      invalidatesTags: ["Suppliers"],
    }),
    listRfqs: build.query<Page<Rfq>, { cursor?: string | null } | void>({
      query: (arg) => withCursor("api/v1/procurement/rfqs", arg?.cursor),
      transformResponse: (raw: RawPage<Rfq>) => normalizePage(raw),
      providesTags: ["Rfqs"],
    }),
    getRfq: build.query<RfqDetail, string>({
      query: (id) => `api/v1/procurement/rfqs/${id}`,
      providesTags: ["Rfqs"],
    }),
    getRfqComparison: build.query<RfqComparison, string>({
      query: (id) => `api/v1/procurement/rfqs/${id}/comparison`,
      providesTags: ["Rfqs"],
    }),
    createRfq: build.mutation<{ id: string; number: string }, RfqInput>({
      query: (body) => ({ url: "api/v1/procurement/rfqs", method: "POST", body }),
      invalidatesTags: ["Rfqs", "Requisitions"],
    }),
    recordQuotation: build.mutation<{ id: string }, { rfqId: string; supplier: string; currency: string; lead_time_days: number; prices: Record<string, string> }>({
      query: ({ rfqId, ...body }) => ({ url: `api/v1/procurement/rfqs/${rfqId}/quotations`, method: "POST", body }),
      invalidatesTags: ["Rfqs"],
    }),
    awardRfq: build.mutation<{ po: string; number: string }, { rfqId: string; quotation: string; justification: string }>({
      query: ({ rfqId, ...body }) => ({ url: `api/v1/procurement/rfqs/${rfqId}/award-justified`, method: "POST", body }),
      invalidatesTags: ["Rfqs", "PurchaseOrders", "Requisitions"],
    }),
    matchInvoice: build.mutation<MatchResult, { orderId: string; invoice: string; mode: "THREE_WAY" | "TWO_WAY" }>({
      query: ({ orderId, ...body }) => ({ url: `api/v1/procurement/purchase-orders/${orderId}/match-invoice`, method: "POST", body }),
      invalidatesTags: ["Matches", "PurchaseOrders", "Invoices"],
    }),
    listMatchExceptions: build.query<Page<MatchException>, void>({
      query: () => "api/v1/procurement/match-exceptions",
      transformResponse: (raw: RawPage<MatchException>) => normalizePage(raw),
      providesTags: ["Matches"],
    }),
    overrideMatch: build.mutation<{ status: string }, { match: string; reason: string }>({
      query: ({ match, reason }) => ({ url: `api/v1/procurement/matches/${match}/override`, method: "POST", body: { reason } }),
      invalidatesTags: ["Matches", "PurchaseOrders", "Invoices"],
    }),
    listDueInvoices: build.query<{ results: DueInvoice[] }, { asOf: string; withinDays: number }>({
      query: ({ asOf, withinDays }) => withCursor("api/v1/procurement/payments/due", null, { as_of: asOf, within_days: String(withinDays) }),
      providesTags: ["SupplierPayments"],
    }),
    getAgeing: build.query<{ results: AgeingRow[] }, { asOf: string }>({
      query: ({ asOf }) => withCursor("api/v1/procurement/payments/ageing", null, { as_of: asOf }),
      providesTags: ["SupplierPayments"],
    }),
    getWhtReport: build.query<{ results: WhtRow[] }, { from: string; to: string }>({
      query: ({ from, to }) => withCursor("api/v1/procurement/payments/wht-report", null, { from, to }),
      providesTags: ["SupplierPayments"],
    }),
    paySupplierInvoice: build.mutation<SupplierPaymentResult, { invoice: string; idempotencyKey: string; bank_account: string; payment_date: string; take_discount: boolean; withhold: boolean; memo: string }>({
      query: ({ invoice, idempotencyKey, ...body }) => ({ url: `api/v1/procurement/invoices/${invoice}/pay`, method: "POST", body, headers: { "Idempotency-Key": idempotencyKey } }),
      invalidatesTags: ["SupplierPayments", "Invoices", "Payments", "Reports"],
    }),
    listRequisitions: build.query<Page<Requisition>, { cursor?: string | null } | void>({
      query: (arg) => withCursor("api/v1/procurement/requisitions", arg?.cursor),
      transformResponse: (raw: RawPage<Requisition>) => normalizePage(raw),
      providesTags: ["Requisitions"],
    }),
    getRequisition: build.query<Requisition, string>({
      query: (id) => `api/v1/procurement/requisitions/${id}`,
      providesTags: (_r, _e, id) => [{ type: "Requisitions", id }],
    }),
    createRequisition: build.mutation<Requisition, { title: string; needed_by: string | null; lines: { description: string; quantity: string; estimated_unit_price: string }[] }>({
      query: (body) => ({ url: "api/v1/procurement/requisitions", method: "POST", body }),
      invalidatesTags: ["Requisitions"],
    }),
    requisitionAction: build.mutation<Requisition, { id: string; action: "submit" | "approve" | "cancel" }>({
      query: ({ id, action }) => ({ url: `api/v1/procurement/requisitions/${id}/${action}`, method: "POST", body: {} }),
      invalidatesTags: ["Requisitions", "Workflow"],
    }),
    listPurchaseOrders: build.query<Page<PurchaseOrder>, { cursor?: string | null; status?: string } | void>({
      query: (arg) => withCursor("api/v1/procurement/purchase-orders", arg?.cursor, arg?.status ? { status: arg.status } : {}),
      transformResponse: (raw: RawPage<PurchaseOrder>) => normalizePage(raw),
      providesTags: ["PurchaseOrders"],
    }),
    getPurchaseOrder: build.query<PurchaseOrder, string>({
      query: (id) => `api/v1/procurement/purchase-orders/${id}`,
      providesTags: (_r, _e, id) => [{ type: "PurchaseOrders", id }],
    }),
    purchaseOrderAction: build.mutation<PurchaseOrder, { id: string; action: "submit" | "approve" | "cancel" }>({
      query: ({ id, action }) => ({ url: `api/v1/procurement/purchase-orders/${id}/${action}`, method: "POST", body: {} }),
      invalidatesTags: ["PurchaseOrders", "Workflow"],
    }),

    listProducts: build.query<Page<Product>, { cursor?: string | null; search?: string } | void>({
      query: (arg) => withCursor("api/v1/inventory/products", arg?.cursor, arg?.search ? { search: arg.search } : {}),
      transformResponse: (raw: RawPage<Product>) => normalizePage(raw),
      providesTags: ["Products"],
    }),
    createProduct: build.mutation<Product, { sku: string; name: string; uom: string; tracking: string; is_stocked: boolean; barcode?: string; category?: string }>({
      query: (body) => ({ url: "api/v1/inventory/products", method: "POST", body }),
      invalidatesTags: ["Products"],
    }),
    listUnits: build.query<{ code: string; name: string }[], void>({
      query: () => "api/v1/inventory/uoms",
      transformResponse: (raw: { units: { code: string; name: string }[] }) => raw.units,
    }),
    listStockCounts: build.query<StockCountRow[], void>({
      query: () => "api/v1/inventory/stock-counts",
      transformResponse: (raw: { results: StockCountRow[] }) => raw.results,
      providesTags: ["StockCounts"],
    }),
    getCountWorksheet: build.query<WorksheetLine[], string>({
      query: (id) => `api/v1/inventory/stock-counts/${id}`,
      transformResponse: (raw: { worksheet: WorksheetLine[] }) => raw.worksheet,
      providesTags: ["StockCounts"],
    }),
    createStockCount: build.mutation<{ id: string; number: string }, StockCountInput>({
      query: (body) => ({ url: "api/v1/inventory/stock-counts", method: "POST", body }),
      invalidatesTags: ["StockCounts"],
    }),
    stockCountAction: build.mutation<{ status?: string; results?: CountVariance[] }, { id: string; action: "start" | "submit" | "approve" | "cancel" | "recount" | "variances" | "record"; body?: Record<string, unknown> }>({
      query: ({ id, action, body }) => ({ url: `api/v1/inventory/stock-counts/${id}/${action}`, method: "POST", body: body ?? {} }),
      invalidatesTags: (_r, _e, a) => (a.action === "variances" ? [] : a.action === "approve" ? ["StockCounts", "Stock"] : ["StockCounts"]),
    }),
    listTransfers: build.query<Page<TransferRow>, { cursor?: string | null } | void>({
      query: (arg) => withCursor("api/v1/inventory/transfer-orders", arg?.cursor),
      transformResponse: (raw: RawPage<TransferRow>) => normalizePage(raw),
      providesTags: ["Transfers"],
    }),
    getTransfer: build.query<TransferNote, string>({
      query: (id) => `api/v1/inventory/transfer-orders/${id}`,
      providesTags: ["Transfers"],
    }),
    createTransfer: build.mutation<TransferNote, TransferInput>({
      query: (body) => ({ url: "api/v1/inventory/transfer-orders", method: "POST", body }),
      invalidatesTags: ["Transfers"],
    }),
    transferAction: build.mutation<TransferNote, { id: string; action: "submit" | "cancel" | "approve" | "reject" | "dispatch" | "receive"; body?: { note?: string; carrier?: string; lines?: TransferReceiptLine[] } }>({
      query: ({ id, action, body }) => ({ url: `api/v1/inventory/transfer-orders/${id}/${action}`, method: "POST", body: body ?? {} }),
      invalidatesTags: ["Transfers", "Stock"],
    }),
    listReservations: build.query<Page<Reservation>, { cursor?: string | null; status?: string }>({
      query: ({ cursor, status }) => withCursor("api/v1/inventory/reservations", cursor, status ? { status } : {}),
      transformResponse: (raw: RawPage<Reservation>) => normalizePage(raw),
      providesTags: ["Reservations"],
    }),
    createReservation: build.mutation<{ id: string }, ReservationInput>({
      query: (body) => ({ url: "api/v1/inventory/reservations", method: "POST", body }),
      invalidatesTags: ["Reservations"],
    }),
    releaseReservation: build.mutation<{ status: string }, string>({
      query: (id) => ({ url: `api/v1/inventory/reservations/${id}/release`, method: "POST", body: {} }),
      invalidatesTags: ["Reservations"],
    }),
    getAvailability: build.query<Availability, { product: string; warehouse?: string }>({
      query: ({ product, warehouse }) => withCursor("api/v1/inventory/availability", null, { product, ...(warehouse ? { warehouse } : {}) }),
      providesTags: ["Reservations", "Stock"],
    }),
    listEmployees: build.query<Page<Employee>, { cursor?: string | null; status?: string }>({
      query: ({ cursor, status }) => withCursor("api/v1/hr/employees", cursor, status ? { status } : {}),
      transformResponse: (raw: RawPage<Employee>) => normalizePage(raw),
      providesTags: ["Employees"],
    }),
    getHrMe: build.query<HrMe, void>({ query: () => "api/v1/hr/me", providesTags: ["Leave"] }),
    listLeaveTypes: build.query<LeaveType[], void>({ query: () => "api/v1/hr/leave/types" }),
    listLeaveRequests: build.query<Page<LeaveRequest>, { cursor?: string | null; status?: string }>({
      query: ({ cursor, status }) => withCursor("api/v1/hr/leave/requests", cursor, status ? { status } : {}),
      transformResponse: (raw: RawPage<LeaveRequest>) => normalizePage(raw),
      providesTags: ["Leave"],
    }),
    requestLeave: build.mutation<LeaveRequest, LeaveInput>({
      query: (body) => ({ url: "api/v1/hr/leave/requests", method: "POST", body }),
      invalidatesTags: ["Leave", "Workflow"],
    }),
    leaveAction: build.mutation<LeaveRequest, { id: string; action: "cancel" | "approve" | "reject"; note?: string }>({
      query: ({ id, action, note }) => ({ url: `api/v1/hr/leave/requests/${id}/${action}`, method: "POST", body: note ? { note } : {} }),
      invalidatesTags: ["Leave", "Workflow"],
    }),
    listAttendance: build.query<Page<AttendanceRecord>, { cursor?: string | null; employee?: string }>({
      query: ({ cursor, employee }) => withCursor("api/v1/hr/attendance", cursor, employee ? { employee } : {}),
      transformResponse: (raw: RawPage<AttendanceRecord>) => normalizePage(raw),
      providesTags: ["Attendance"],
    }),
    checkIn: build.mutation<unknown, { work_mode: string }>({
      query: (body) => ({ url: "api/v1/hr/me/check-in", method: "POST", body }),
      invalidatesTags: ["Attendance"],
    }),
    checkOut: build.mutation<AttendanceRecord, void>({
      query: () => ({ url: "api/v1/hr/me/check-out", method: "POST", body: {} }),
      invalidatesTags: ["Attendance"],
    }),
    listTimesheets: build.query<Page<Timesheet>, { cursor?: string | null }>({
      query: ({ cursor }) => withCursor("api/v1/hr/timesheets", cursor),
      transformResponse: (raw: RawPage<Timesheet>) => normalizePage(raw),
      providesTags: ["Timesheets"],
    }),
    saveTimesheet: build.mutation<Timesheet, TimesheetInput>({
      query: (body) => ({ url: "api/v1/hr/timesheets", method: "PUT", body }),
      invalidatesTags: ["Timesheets"],
    }),
    timesheetAction: build.mutation<Timesheet, { id: string; action: "submit" | "approve" | "reject"; note?: string }>({
      query: ({ id, action, note }) => ({ url: `api/v1/hr/timesheets/${id}/${action}`, method: "POST", body: note ? { note } : {} }),
      invalidatesTags: ["Timesheets"],
    }),
    listPayrollRuns: build.query<Page<PayrollRun>, { cursor?: string | null }>({
      query: ({ cursor }) => withCursor("api/v1/hr/payroll/runs", cursor),
      transformResponse: (raw: RawPage<PayrollRun>) => normalizePage(raw),
      providesTags: ["Payroll"],
    }),
    getPayrollRun: build.query<PayrollRunDetail, string>({ query: (id) => `api/v1/hr/payroll/runs/${id}`, providesTags: ["Payroll"] }),
    createPayrollRun: build.mutation<PayrollRun, { period_start: string; period_end: string }>({
      query: (body) => ({ url: "api/v1/hr/payroll/runs", method: "POST", body }),
      invalidatesTags: ["Payroll"],
    }),
    payrollAction: build.mutation<PayrollRun, { id: string; action: "recalculate" | "submit" | "cancel" | "approve" | "reject" | "post" | "pay"; body?: { note?: string; payment_date?: string } }>({
      query: ({ id, action, body }) => ({ url: `api/v1/hr/payroll/runs/${id}/${action}`, method: "POST", body: body ?? {} }),
      invalidatesTags: ["Payroll", "Payslips", "Workflow", "Journals"],
    }),
    listMyPayslips: build.query<Page<Payslip>, { cursor?: string | null }>({
      query: ({ cursor }) => withCursor("api/v1/hr/me/payslips", cursor),
      transformResponse: (raw: RawPage<Payslip>) => normalizePage(raw),
      providesTags: ["Payslips"],
    }),
    listProjects: build.query<Page<Project>, { cursor?: string | null; status?: string; q?: string }>({
      query: ({ cursor, status, q }) => withCursor("api/v1/projects/projects", cursor, { ...(status ? { status } : {}), ...(q ? { q } : {}) }),
      transformResponse: (raw: RawPage<Project>) => normalizePage(raw),
      providesTags: ["Projects"],
    }),
    getProject: build.query<Project, string>({ query: (id) => `api/v1/projects/projects/${id}`, providesTags: ["Projects"] }),
    createProject: build.mutation<Project, ProjectInput>({
      query: (body) => ({ url: "api/v1/projects/projects", method: "POST", body }),
      invalidatesTags: ["Projects"],
    }),
    setProjectStatus: build.mutation<Project, { id: string; status: string; reason: string }>({
      query: ({ id, ...body }) => ({ url: `api/v1/projects/projects/${id}/status`, method: "POST", body }),
      invalidatesTags: ["Projects", "ProjectTasks"],
    }),
    listProjectTasks: build.query<{ results: ProjectTask[] }, string>({ query: (id) => `api/v1/projects/projects/${id}/tasks`, providesTags: ["ProjectTasks"] }),
    createProjectTask: build.mutation<ProjectTask, { project: string; body: TaskInput }>({
      query: ({ project, body }) => ({ url: `api/v1/projects/projects/${project}/tasks`, method: "POST", body }),
      invalidatesTags: ["ProjectTasks"],
    }),
    updateTaskProgress: build.mutation<ProjectTask, { id: string; percent?: string; status?: string; note?: string }>({
      query: ({ id, ...body }) => ({ url: `api/v1/projects/tasks/${id}/progress`, method: "POST", body }),
      invalidatesTags: ["ProjectTasks"],
    }),
    listMyTasks: build.query<{ results: ProjectTask[] }, void>({ query: () => "api/v1/projects/my-tasks", providesTags: ["ProjectTasks"] }),
    listPositions: build.query<Page<Position>, void>({
      query: () => "api/v1/org/positions",
      transformResponse: (raw: RawPage<Position>) => normalizePage(raw),
      providesTags: ["Positions"],
    }),
    getEmployee: build.query<EmployeeDetail, string>({ query: (id) => `api/v1/hr/employees/${id}`, providesTags: ["EmployeeRecord"] }),
    getEmployeeProfile: build.query<EmployeeProfile, string>({ query: (id) => `api/v1/hr/employees/${id}/profile`, providesTags: ["EmployeeRecord"] }),
    getEmployeeHistory: build.query<HistoryEvent[], string>({ query: (id) => `api/v1/hr/employees/${id}/history`, providesTags: ["EmployeeRecord"] }),
    getEmployeeContracts: build.query<Contract[], string>({ query: (id) => `api/v1/hr/employees/${id}/contracts`, providesTags: ["EmployeeRecord"] }),
    getAssignmentChanges: build.query<AssignmentChange[], string>({ query: (id) => `api/v1/hr/employees/${id}/assignment-changes`, providesTags: ["EmployeeRecord"] }),
    createEmployee: build.mutation<Employee, EmployeeInput>({
      query: (body) => ({ url: "api/v1/hr/employees", method: "POST", body }),
      invalidatesTags: ["Employees"],
    }),
    updateEmployee: build.mutation<Employee, { id: string; body: Record<string, unknown> }>({
      query: ({ id, body }) => ({ url: `api/v1/hr/employees/${id}`, method: "PATCH", body }),
      invalidatesTags: ["Employees", "EmployeeRecord"],
    }),
    employeeAction: build.mutation<Employee, { id: string; action: "activate" | "offboard" | "terminate"; body?: Record<string, unknown> }>({
      query: ({ id, action, body }) => ({ url: `api/v1/hr/employees/${id}/${action}`, method: "POST", body: body ?? {} }),
      invalidatesTags: ["Employees", "EmployeeRecord", "Separations"],
    }),
    completeChecklistItem: build.mutation<ChecklistItem, string>({
      query: (id) => ({ url: `api/v1/hr/checklist/${id}/done`, method: "POST", body: {} }),
      invalidatesTags: ["EmployeeRecord"],
    }),
    addContract: build.mutation<Contract, { id: string; body: { start_date: string; end_date?: string; monthly_salary: string; currency: string; kind: string } }>({
      query: ({ id, body }) => ({ url: `api/v1/hr/employees/${id}/contracts`, method: "POST", body }),
      invalidatesTags: ["EmployeeRecord"],
    }),
    endContract: build.mutation<Contract, { id: string; end_date: string }>({
      query: ({ id, ...body }) => ({ url: `api/v1/hr/contracts/${id}/end`, method: "POST", body }),
      invalidatesTags: ["EmployeeRecord"],
    }),
    changeAssignment: build.mutation<AssignmentChange, { id: string; body: Record<string, unknown> }>({
      query: ({ id, body }) => ({ url: `api/v1/hr/employees/${id}/assignment-changes`, method: "POST", body }),
      invalidatesTags: ["EmployeeRecord"],
    }),
    assignmentDecision: build.mutation<AssignmentChange, { id: string; action: "approve" | "reject" | "cancel"; note?: string }>({
      query: ({ id, action, note }) => ({ url: `api/v1/hr/assignment-changes/${id}/${action}`, method: "POST", body: note ? { note } : {} }),
      invalidatesTags: ["EmployeeRecord", "Employees"],
    }),
    evaluateProbation: build.mutation<{ id: string; outcome: string }, { id: string; body: { outcome: string; notes: string; new_probation_end?: string } }>({
      query: ({ id, body }) => ({ url: `api/v1/hr/employees/${id}/probation`, method: "POST", body }),
      invalidatesTags: ["EmployeeRecord", "Employees"],
    }),
    recordSettlement: build.mutation<Separation, { id: string; amount: string; notes: string }>({
      query: ({ id, ...body }) => ({ url: `api/v1/hr/employees/${id}/settlement`, method: "POST", body }),
      invalidatesTags: ["EmployeeRecord", "Separations"],
    }),
    addPersonalRecord: build.mutation<{ id: string }, { id: string; kind: "emergency-contacts" | "qualifications" | "skills"; body: Record<string, string> }>({
      query: ({ id, kind, body }) => ({ url: `api/v1/hr/employees/${id}/${kind}`, method: "POST", body }),
      invalidatesTags: ["EmployeeRecord"],
    }),
    removePersonalRecord: build.mutation<void, { kind: "emergency-contacts" | "qualifications" | "skills"; id: string }>({
      query: ({ kind, id }) => ({ url: `api/v1/hr/${kind}/${id}`, method: "DELETE" }),
      invalidatesTags: ["EmployeeRecord"],
    }),
    uploadEmployeeDocument: build.mutation<unknown, { id: string; form: FormData }>({
      query: ({ id, form }) => ({ url: `api/v1/hr/employees/${id}/documents`, method: "POST", body: form }),
      invalidatesTags: ["EmployeeRecord"],
    }),
    listWarehouses: build.query<Page<Warehouse>, { cursor?: string | null } | void>({
      query: (arg) => withCursor("api/v1/inventory/warehouses", arg?.cursor),
      transformResponse: (raw: RawPage<Warehouse>) => normalizePage(raw),
      providesTags: ["Warehouses"],
    }),
    createWarehouse: build.mutation<unknown, { code: string; name: string }>({
      query: (body) => ({ url: "api/v1/inventory/warehouses", method: "POST", body }),
      invalidatesTags: ["Warehouses"],
    }),
    createLocation: build.mutation<unknown, { warehouse: string; code: string; name: string }>({
      query: (body) => ({ url: "api/v1/inventory/locations", method: "POST", body }),
      invalidatesTags: ["Warehouses"],
    }),
    listStockLevels: build.query<Page<StockLevelRow>, { cursor?: string | null; warehouse?: string } | void>({
      query: (arg) => withCursor("api/v1/inventory/stock", arg?.cursor, arg?.warehouse ? { warehouse: arg.warehouse } : {}),
      transformResponse: (raw: RawPage<StockLevelRow>) => normalizePage(raw),
      providesTags: ["Stock"],
    }),
    listMovements: build.query<Page<StockMovementRow>, { cursor?: string | null } | void>({
      query: (arg) => withCursor("api/v1/inventory/movements", arg?.cursor),
      transformResponse: (raw: RawPage<StockMovementRow>) => normalizePage(raw),
      providesTags: ["Stock"],
    }),
    recordMovement: build.mutation<StockMovementRow, MovementInput>({
      query: ({ kind, body }) => ({ url: `api/v1/inventory/${kind === "receive" ? "receipts" : kind === "issue" ? "issues" : kind === "transfer" ? "transfers" : "adjustments"}`, method: "POST", body }),
      invalidatesTags: ["Stock", "Products"],
    }),
    getValuation: build.query<ValuationReport, void>({
      query: () => "api/v1/inventory/valuation",
      providesTags: ["Stock"],
    }),
    listStockAlerts: build.query<StockAlert[], void>({
      query: () => "api/v1/inventory/alerts",
      transformResponse: (raw: { results: StockAlert[] }) => raw.results,
      providesTags: ["Stock"],
    }),

    receiveGoods: build.mutation<{ id: string; number: string }, { id: string; location: string; delivery_note: string; notes: string; lines: { po_line: string; quantity: string }[] }>({
      query: ({ id, ...body }) => ({ url: `api/v1/procurement/purchase-orders/${id}/receive`, method: "POST", body }),
      invalidatesTags: ["PurchaseOrders", "Stock", "Products"],
    }),

    listCrmAccounts: build.query<Page<CrmAccount>, { cursor?: string | null; q?: string } | void>({
      query: (arg) => withCursor("api/v1/crm/accounts", arg?.cursor, arg?.q ? { q: arg.q } : {}),
      transformResponse: (raw: RawPage<CrmAccount>) => normalizePage(raw),
      providesTags: ["CrmAccounts"],
    }),
    listLeads: build.query<Page<Lead>, { cursor?: string | null; status?: string } | void>({
      query: (arg) => withCursor("api/v1/crm/leads", arg?.cursor, arg?.status ? { status: arg.status } : {}),
      transformResponse: (raw: RawPage<Lead>) => normalizePage(raw),
      providesTags: ["Leads"],
    }),
    createLead: build.mutation<Lead, { name: string; company: string; email: string; phone: string; source: string }>({
      query: (body) => ({ url: "api/v1/crm/leads", method: "POST", body }),
      invalidatesTags: ["Leads"],
    }),
    setLeadStatus: build.mutation<Lead, { id: string; status: string; reason: string }>({
      query: ({ id, ...body }) => ({ url: `api/v1/crm/leads/${id}/status`, method: "POST", body }),
      invalidatesTags: ["Leads"],
    }),
    convertLead: build.mutation<unknown, { id: string; opportunity_name: string; amount: string; currency: string }>({
      query: ({ id, ...body }) => ({ url: `api/v1/crm/leads/${id}/convert`, method: "POST", body }),
      invalidatesTags: ["Leads", "Opportunities", "CrmAccounts"],
    }),
    listStages: build.query<PipelineStage[], void>({ query: () => "api/v1/crm/stages" }),
    listOpportunities: build.query<Page<Opportunity>, { cursor?: string | null; status?: string } | void>({
      query: (arg) => withCursor("api/v1/crm/opportunities", arg?.cursor, arg?.status ? { status: arg.status } : {}),
      transformResponse: (raw: RawPage<Opportunity>) => normalizePage(raw),
      providesTags: ["Opportunities"],
    }),
    opportunityAction: build.mutation<Opportunity, { id: string; action: "stage" | "win" | "lose"; stage?: string; reason?: string }>({
      query: ({ id, action, stage, reason }) => ({ url: `api/v1/crm/opportunities/${id}/${action}`, method: "POST", body: action === "stage" ? { stage } : action === "lose" ? { reason } : {} }),
      invalidatesTags: ["Opportunities"],
    }),
    listQuotations: build.query<Page<Quotation>, { cursor?: string | null; status?: string } | void>({
      query: (arg) => withCursor("api/v1/sales/quotations", arg?.cursor, arg?.status ? { status: arg.status } : {}),
      transformResponse: (raw: RawPage<Quotation>) => normalizePage(raw),
      providesTags: ["Quotations"],
    }),
    getQuotation: build.query<Quotation, string>({
      query: (id) => `api/v1/sales/quotations/${id}`,
      providesTags: (_r, _e, id) => [{ type: "Quotations", id }],
    }),
    quotationAction: build.mutation<unknown, { id: string; action: "send" | "accept" | "reject" | "convert" }>({
      query: ({ id, action }) => ({ url: `api/v1/sales/quotations/${id}/${action}`, method: "POST", body: {} }),
      invalidatesTags: ["Quotations", "SalesOrders"],
    }),
    listSalesOrders: build.query<Page<SalesOrder>, { cursor?: string | null; status?: string } | void>({
      query: (arg) => withCursor("api/v1/sales/orders", arg?.cursor, arg?.status ? { status: arg.status } : {}),
      transformResponse: (raw: RawPage<SalesOrder>) => normalizePage(raw),
      providesTags: ["SalesOrders"],
    }),
    getSalesOrder: build.query<SalesOrder, string>({
      query: (id) => `api/v1/sales/orders/${id}`,
      providesTags: (_r, _e, id) => [{ type: "SalesOrders", id }],
    }),
    salesOrderAction: build.mutation<unknown, { id: string; action: "submit" | "approve" | "cancel" | "invoice" }>({
      query: ({ id, action }) => ({ url: `api/v1/sales/orders/${id}/${action}`, method: "POST", body: {} }),
      invalidatesTags: ["SalesOrders", "Workflow", "Invoices"],
    }),

    listPartners: build.query<Page<Partner>, void>({
      query: () => "api/v1/finance/partners",
      transformResponse: (raw: RawPage<Partner>) => normalizePage(raw),
      providesTags: ["FinanceRefs"],
    }),
    listTaxRates: build.query<Page<TaxRate>, void>({
      query: () => "api/v1/finance/tax-rates",
      transformResponse: (raw: RawPage<TaxRate>) => normalizePage(raw),
      providesTags: ["FinanceRefs"],
    }),
    listBankAccounts: build.query<Page<BankAccount>, void>({
      query: () => "api/v1/finance/bank-accounts",
      transformResponse: (raw: RawPage<BankAccount>) => normalizePage(raw),
      providesTags: ["FinanceRefs"],
    }),
    createInvoice: build.mutation<Invoice, InvoiceInput>({
      query: (body) => ({ url: "api/v1/finance/invoices", method: "POST", body }),
      invalidatesTags: ["Invoices"],
    }),
    updateInvoice: build.mutation<Invoice, InvoiceUpdate>({
      query: ({ id, ...body }) => ({ url: `api/v1/finance/invoices/${id}`, method: "PUT", body }),
      invalidatesTags: ["Invoices"],
    }),
    createPartner: build.mutation<{ id: string }, PartnerInput>({
      query: (body) => ({ url: "api/v1/finance/partners", method: "POST", body }),
      invalidatesTags: ["FinanceRefs"],
    }),
    createTaxRate: build.mutation<{ id: string }, TaxRateInput>({
      query: (body) => ({ url: "api/v1/finance/tax-rates", method: "POST", body }),
      invalidatesTags: ["FinanceRefs"],
    }),
    recordPayment: build.mutation<Payment, { body: PaymentInput; idempotencyKey: string }>({
      query: ({ body, idempotencyKey }) => ({ url: "api/v1/finance/payments", method: "POST", body, headers: { "Idempotency-Key": idempotencyKey } }),
      invalidatesTags: ["Invoices", "Payments", "Reports"],
    }),
    listPayments: build.query<Page<Payment>, { cursor?: string | null } | void>({
      query: (arg) => withCursor("api/v1/finance/payments", arg?.cursor),
      transformResponse: (raw: RawPage<Payment>) => normalizePage(raw),
      providesTags: ["Payments"],
    }),

    seedDashboards: build.mutation<unknown, void>({
      query: () => ({ url: "api/v1/analytics/dashboards/defaults", method: "POST" }),
      invalidatesTags: ["Dashboards"],
    }),
  }),
});

export const {
  useGetMeQuery,
  useListUsersQuery,
  useInviteUserMutation,
  useDeactivateUserMutation,
  useReactivateUserMutation,
  useListRolesQuery,
  useListDepartmentsQuery,
  useListDashboardsQuery,
  useGetDashboardQuery,
  useSeedDashboardsMutation,
  useListPartnersQuery,
  useUpdateInvoiceMutation,
  useCreatePartnerMutation,
  useCreateTaxRateMutation,
  useListTaxRatesQuery,
  useListBankAccountsQuery,
  useCreateInvoiceMutation,
  useRecordPaymentMutation,
  useListPaymentsQuery,
  useListCrmAccountsQuery,
  useListLeadsQuery,
  useCreateLeadMutation,
  useSetLeadStatusMutation,
  useConvertLeadMutation,
  useListStagesQuery,
  useListOpportunitiesQuery,
  useOpportunityActionMutation,
  useListQuotationsQuery,
  useGetQuotationQuery,
  useQuotationActionMutation,
  useListSalesOrdersQuery,
  useGetSalesOrderQuery,
  useSalesOrderActionMutation,
  useReceiveGoodsMutation,
  useListProductsQuery,
  useCreateProductMutation,
  useListUnitsQuery,
  useListWarehousesQuery,
  useListPositionsQuery,
  useGetEmployeeQuery,
  useGetEmployeeProfileQuery,
  useGetEmployeeHistoryQuery,
  useGetEmployeeContractsQuery,
  useGetAssignmentChangesQuery,
  useCreateEmployeeMutation,
  useUpdateEmployeeMutation,
  useEmployeeActionMutation,
  useCompleteChecklistItemMutation,
  useAddContractMutation,
  useEndContractMutation,
  useChangeAssignmentMutation,
  useAssignmentDecisionMutation,
  useEvaluateProbationMutation,
  useRecordSettlementMutation,
  useAddPersonalRecordMutation,
  useRemovePersonalRecordMutation,
  useUploadEmployeeDocumentMutation,
  useListProjectsQuery,
  useGetProjectQuery,
  useCreateProjectMutation,
  useSetProjectStatusMutation,
  useListProjectTasksQuery,
  useCreateProjectTaskMutation,
  useUpdateTaskProgressMutation,
  useListMyTasksQuery,
  useListPayrollRunsQuery,
  useGetPayrollRunQuery,
  useCreatePayrollRunMutation,
  usePayrollActionMutation,
  useListMyPayslipsQuery,
  useListAttendanceQuery,
  useCheckInMutation,
  useCheckOutMutation,
  useListTimesheetsQuery,
  useSaveTimesheetMutation,
  useTimesheetActionMutation,
  useListEmployeesQuery,
  useGetHrMeQuery,
  useListLeaveTypesQuery,
  useListLeaveRequestsQuery,
  useRequestLeaveMutation,
  useLeaveActionMutation,
  useListTransfersQuery,
  useGetTransferQuery,
  useCreateTransferMutation,
  useTransferActionMutation,
  useListReservationsQuery,
  useCreateReservationMutation,
  useReleaseReservationMutation,
  useGetAvailabilityQuery,
  useListStockCountsQuery,
  useGetCountWorksheetQuery,
  useCreateStockCountMutation,
  useStockCountActionMutation,
  useCreateWarehouseMutation,
  useCreateLocationMutation,
  useListStockLevelsQuery,
  useListMovementsQuery,
  useRecordMovementMutation,
  useGetValuationQuery,
  useListStockAlertsQuery,
  useListSuppliersQuery,
  useCreateSupplierMutation,
  useSupplierActionMutation,
  useListRequisitionsQuery,
  useListDueInvoicesQuery,
  useGetAgeingQuery,
  useGetWhtReportQuery,
  usePaySupplierInvoiceMutation,
  useMatchInvoiceMutation,
  useListMatchExceptionsQuery,
  useOverrideMatchMutation,
  useListRfqsQuery,
  useGetRfqQuery,
  useGetRfqComparisonQuery,
  useCreateRfqMutation,
  useRecordQuotationMutation,
  useAwardRfqMutation,
  useGetRequisitionQuery,
  useCreateRequisitionMutation,
  useRequisitionActionMutation,
  useListPurchaseOrdersQuery,
  useGetPurchaseOrderQuery,
  usePurchaseOrderActionMutation,
  useSearchDirectoryQuery,
  useDelegateTaskMutation,
  useResubmitWorkflowMutation,
  useListInboxQuery,
  useListWorkflowInstancesQuery,
  useGetWorkflowInstanceQuery,
  useDecideTaskMutation,
  useCancelWorkflowMutation,
  useListAccountsQuery,
  useCreateAccountMutation,
  useListJournalsQuery,
  useGetJournalQuery,
  useCreateJournalMutation,
  useJournalActionMutation,
  useListInvoicesQuery,
  useGetInvoiceQuery,
  useInvoiceActionMutation,
  useGetTrialBalanceQuery,
  useListBankStatementsQuery,
  useGetBankStatementQuery,
  useCreateBankStatementMutation,
  useListStatementCandidatesQuery,
  useMatchBankLineMutation,
  useUnmatchBankLineMutation,
  useReconcileStatementMutation,
  useApplyCreditMutation,
  useGetProfitLossQuery,
  useGetBalanceSheetQuery,
  useGetPlatformMeQuery,
  useListTenantsQuery,
  useCreateTenantMutation,
  useTenantLifecycleMutation,
  useRetryProvisioningMutation,
  useListPlatformAuditQuery,
} = api;
