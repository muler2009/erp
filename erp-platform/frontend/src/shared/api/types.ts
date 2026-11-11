export interface Page<T> {
  results: T[];
  next: string | null; // opaque cursor for the next page
  previous: string | null;
}

export interface TenantMe {
  context: "tenant";
  user: { id: string; email: string; display_name: string };
  tenant: { id: string; name: string; slug: string; status: string };
  modules: string[];
  permissions: string[];
}

export interface PublicConfig {
  context: "tenant" | "platform";
  oidc: { issuer: string; client_id: string; scope: string };
  tenant: { name: string; slug: string } | null;
}

export interface Membership {
  id: string;
  user_id: string;
  email: string;
  display_name: string;
  status: string;
  roles: { assignment_id: string; role: string; scope_type: string; scope_id: string | null; valid_to: string | null }[];
  created_at: string;
}

export interface Role {
  id: string;
  name: string;
  display_name: string;
  is_system: boolean;
  permissions: string[];
}

export interface Department {
  id: string;
  code: string;
  name: string;
  parent: string | null;
  is_active: boolean;
}

export interface KpiSnapshot {
  as_of: string;
  value: string | null;
  status: "NO_DATA" | "NO_TARGET" | "GOOD" | "WARN" | "CRITICAL";
}

export interface KpiView {
  id: string;
  code: string;
  name: string;
  description: string;
  unit: string;
  direction: "HIGHER" | "LOWER";
  target: string | null;
  restricted: boolean;
  latest: KpiSnapshot | null;
  previous: KpiSnapshot | null;
  change_pct: string | null;
}

export interface DashboardSummary {
  id: string;
  code: string;
  name: string;
  description: string;
  is_system: boolean;
}

export type WidgetData =
  | { id: string; kind: "KPI"; title: string; position: number; restricted: boolean; missing?: boolean; data: KpiView | null }
  | { id: string; kind: "TREND"; title: string; position: number; restricted: boolean; missing?: boolean; data: { kpi: KpiView; series: KpiSnapshot[] } | null }
  | { id: string; kind: "DATASET"; title: string; position: number; restricted: boolean; missing?: boolean; data: { rows: Record<string, unknown>[]; total_rows: number; params: Record<string, string> } | null };

export interface DashboardView extends DashboardSummary {
  widgets: WidgetData[];
}

export interface PlatformMe {
  context: "platform";
  user: { id: string; email: string; display_name: string };
  permissions: string[];
}

export interface PlatformTenant {
  id: string;
  name: string;
  slug: string;
  status: "PROVISIONING" | "ACTIVE" | "SUSPENDED" | "DEACTIVATED" | "PENDING_DELETION" | "PROVISIONING_FAILED" | string;
  plan: string | null;
  suspension_policy: string;
  created_at: string;
  retention_until: string | null;
}

export interface ProvisioningJob {
  id: string;
  tenant_id: string;
  status: string;
  attempts: number;
  last_error: string;
  created_at: string;
  finished_at: string | null;
  steps: { name: string; status: string; attempts: number; error: string }[];
}

export interface PlatformAuditEvent {
  id: string;
  created_at: string;
  action: string;
  actor_user_id: string | null;
  tenant_id: string | null;
  target_type: string;
  target_id: string;
  correlation_id: string;
}

export interface Account {
  id: string; code: string; name: string;
  type: "ASSET" | "LIABILITY" | "EQUITY" | "REVENUE" | "EXPENSE";
  parent: string | null; is_postable: boolean; is_control: boolean; system_key: string | null; is_active: boolean;
}

export interface JournalLine { line_no: number; account: string; account_name: string; debit: string; credit: string; description: string }
export interface JournalEntry {
  id: string; number: string; entry_date: string; memo: string; status: "DRAFT" | "POSTED" | "REVERSED";
  source_type: string; source_id: string; posted_at: string | null; reversed_by: string | null; lines?: JournalLine[];
}

export type InvoiceStatus = "DRAFT" | "SUBMITTED" | "APPROVED" | "POSTED" | "PAID" | "VOID";
export interface InvoiceLine { line_no: number; description: string; quantity: string; unit_price: string; account: string; tax_rate: string | null; line_total: string; tax_amount: string }
export interface Invoice {
  id: string; kind: string; number: string; supplier_ref: string; partner: { id: string; name: string };
  invoice_date: string; due_date: string | null; currency: string; status: InvoiceStatus;
  subtotal: string; tax_total: string; total: string; paid_amount: string; outstanding: string; credit_for?: string | null; version?: number; lines?: InvoiceLine[];
}

export interface TrialBalance {
  as_of: string; total_debit: string; total_credit: string; balanced: boolean;
  rows: { code: string; name: string; type: string; debit: string; credit: string; balance_debit: string; balance_credit: string }[];
}

export interface WorkflowTask {
  id: string; instance_id: string; subject_type: string; subject_id: string; title: string; amount: string | null;
  stage_order: number; status: string; due_at: string | null; requester_id: string;
}
export type InstanceStatus = "PENDING" | "CHANGES_REQUESTED" | "APPROVED" | "REJECTED" | "CANCELLED" | string;
export interface WorkflowInstance {
  id: string; subject_type: string; subject_id: string; title: string; amount: string | null; status: InstanceStatus;
  round: number; requester_id: string; definition: string; created_at: string; completed_at: string | null;
  tasks?: { id: string; round: number; stage_order: number; assignee_id: string; status: string; due_at: string | null; handed_over_from: string | null; comment: string }[];
  history?: { action: string; actor_id: string | null; round: number; stage_order: number | null; comment: string; at: string }[];
}

export interface DirectoryUser { id: string; display_name: string }

export interface Supplier { id: string; name: string; tax_id: string; email: string; status: string; partner: string | null; qualified_at: string | null }
export interface RequisitionLine { id: string; line_no: number; product: string | null; description: string; quantity: string; ordered_quantity: string; estimated_unit_price: string }
export interface Requisition {
  id: string; number: string; title: string; status: string; requester_id: string; estimated_total: string; needed_by: string | null;
  workflow_instance_id: string | null; priority: string | null; lines?: RequisitionLine[];
}
export interface PurchaseOrderLine { id: string; line_no: number; product: string | null; description: string; quantity: string; unit_price: string; received_quantity: string }
export interface PurchaseOrder {
  id: string; number: string; supplier: { id: string; name: string }; currency: string; status: string; order_date: string;
  expected_date: string | null; total: string; invoiced_value: string; version: number; workflow_instance_id: string | null; lines?: PurchaseOrderLine[];
}

export interface Product {
  id: string; sku: string; name: string; uom: string; barcode: string | null; category: string; tracking: "NONE" | "LOT" | "SERIAL";
  is_stocked: boolean; is_active: boolean; on_hand: string; min_stock?: string | null; reorder_level?: string | null; status?: string;
}
export interface WarehouseLocation { id: string; code: string; kind: string; zone: string; aisle: string; rack: string; shelf: string; bin: string; capacity: string | null; is_blocked: boolean }
export interface Warehouse { id: string; code: string; name: string; is_active: boolean; warehouse_type: string; address: string; locations: WarehouseLocation[] }
export interface StockLevelRow { product: string; warehouse: string; location: string; lot: string | null; quantity: string }
export interface StockMovementRow { id: string; product: string; location: string; lot: string | null; type: string; quantity: string; unit_cost: string; ref_type: string; ref_id: string; reason: string; at: string }
export interface ValuationReport { as_of?: string; rows: { sku: string; name: string; quantity: string; average_cost: string; value: string }[]; total_value: string }
export interface StockAlert { sku: string; name: string; on_hand: string; alert: string; threshold?: string }
export type MovementInput = { kind: "receive" | "issue" | "transfer" | "adjust"; body: { product: string; location: string; to_location?: string; quantity?: string; unit_cost?: string; counted_quantity?: string; lot_code?: string; reason: string } };

export interface CrmAccount { id: string; name: string; industry: string; segment: string; owner_id: string; is_active: boolean; credit_status: string; lifecycle_stage: string }
export type LeadStatus = "NEW" | "CONTACTED" | "QUALIFIED" | "DISQUALIFIED" | "CONVERTED" | "MERGED";
export interface Lead { id: string; name: string; company: string; email: string; phone: string; status: LeadStatus; source: string; owner_id: string | null; converted_opportunity: string | null; potential_value: string | null; currency: string; follow_up_date: string | null }
export interface PipelineStage { code: string; name: string; probability: number; is_won: boolean; is_lost: boolean }
export interface Opportunity { id: string; name: string; account: string; stage: string; probability: number; amount: string; currency: string; status: "OPEN" | "WON" | "LOST"; expected_close: string | null; owner_id: string; lost_reason: string; next_action: string; next_action_date: string | null }
export interface SalesLine { id: string; line_no: number; product: string | null; description: string; quantity: string; unit_price: string; discount_percent: string; net_unit_price: string; line_total: string; tax_amount: string; delivered_quantity?: string; invoiced_quantity?: string }
export interface Quotation { id: string; number: string; account: string; currency: string; status: string; valid_until: string | null; subtotal: string; tax_total: string; total: string; version: number; lines?: SalesLine[] }
export interface SalesOrder { id: string; number: string; account: string; currency: string; order_date: string; status: string; subtotal: string; tax_total: string; total: string; approval_required: boolean; workflow_instance_id: string | null; version: number; hold_reason: string; lines?: SalesLine[] }

export interface Partner { id: string; name: string; is_customer: boolean; is_supplier: boolean; tax_id: string }
export interface TaxRate { id: string; account?: string; code: string; name: string; kind: "SALES" | "PURCHASE"; rate: string; is_active: boolean }
export interface BankAccount { id: string; name: string; currency: string; is_cash: boolean; is_active: boolean }
export interface Payment { id: string; number: string; kind: "RECEIPT" | "DISBURSEMENT"; partner: string; payment_date: string; currency: string; amount: string; allocations: { invoice: string; amount: string }[] }
export interface InvoiceInput { kind: string; partner: string; credit_for?: string; invoice_date: string; due_date?: string; currency?: string; supplier_ref?: string; lines: { description: string; quantity: string; unit_price: string; account: string; tax_rate: string | null }[] }
export interface PaymentInput { kind: "RECEIPT" | "DISBURSEMENT"; partner: string; bank_account: string; payment_date: string; memo: string; allocations: { invoice: string; amount: string }[] }

export interface ReportRow { code: string; name: string; amount: string }
export interface ProfitLoss { from: string; to: string; revenue: ReportRow[]; expenses: ReportRow[]; total_revenue: string; total_expenses: string; net_profit: string }
export interface BalanceSheet { as_of: string; assets: ReportRow[]; liabilities: ReportRow[]; equity: ReportRow[]; current_earnings: string; total_assets: string; total_liabilities: string; total_equity: string; balanced: boolean }

export interface BankStatementLine { id: string; line_no: number; date: string; description: string; amount: string; matched: boolean; ledger_entry: string | null }
export interface BankStatement { id: string; bank_account: string; bank_account_name: string; currency: string; statement_date: string; opening_balance: string; closing_balance: string; status: "OPEN" | "RECONCILED"; reconciled_at: string | null; lines?: BankStatementLine[] }
export interface LedgerCandidate { id: string; entry: string; date: string; description: string; amount: string }
export interface StatementInput { bank_account: string; statement_date: string; opening_balance: string; closing_balance: string; lines: { date: string; description: string; amount: string }[] }
export interface PartnerInput { name: string; is_customer: boolean; is_supplier: boolean; tax_id: string }
export interface TaxRateInput { code: string; name: string; kind: "SALES" | "PURCHASE"; rate: string; account: string }
export interface InvoiceUpdate { id: string; version: number; invoice_date: string; due_date?: string | null; supplier_ref?: string; lines: InvoiceInput["lines"] }

export interface Rfq { id: string; number: string; title: string; kind: "RFQ" | "TENDER"; status: string; due_date: string | null; requisition: string | null }
export interface RfqQuotation { id: string; supplier: { id: string; name: string }; currency: string; lead_time_days: number; disqualified: boolean; disqualification_reason: string; is_awarded: boolean; prices: Record<string, string> }
export interface RfqDetail extends Rfq { closing_at: string | null; open_to_all: boolean; suppliers: { id: string; name: string }[]; lines: { id: string; line_no: number; description: string; quantity: string; product: string | null }[]; sealed: boolean; quotation_count: number; quotations: RfqQuotation[] }
export interface RfqComparison { rfq: string; quotations: { quotation: string; supplier: string; total_base: string; lead_time_days: number }[]; best_per_line: Record<string, { supplier: string; quotation: string; base_unit_price: string }>; lowest_total: string | null }
export interface RfqInput { title: string; suppliers: string[]; due_date?: string; requisition?: string; lines?: { product?: string; description: string; quantity: string }[] }

export interface MatchDetail { ordered_value: string; received_value: string; previously_invoiced: string; invoice_goods_value: string; tolerance_percent: string; mode: "THREE_WAY" | "TWO_WAY"; possible_duplicates: string[]; problems: Record<string, string> }
export interface MatchResult { status: "MATCHED" | "EXCEPTION" | "OVERRIDDEN"; detail: MatchDetail }
export interface MatchException { match: string; invoice: string; invoice_number: string; supplier_ref: string; po: string; problems: Record<string, string>; goods_value: string; raised_at: string }

export interface DueInvoice { invoice: string; number: string; supplier_ref: string; supplier: string; currency: string; total: string; outstanding: string; due_date: string; days_overdue: number; discount_available: string; wht: string; payable: boolean; standing: string }
export interface AgeingRow { supplier: string; currency: string; current: string; "1-30": string; "31-60": string; "61-90": string; "90+": string; total: string }
export interface WhtRow { supplier: string; tax_id: string; currency: string; withheld: string }
export interface SupplierPaymentResult { payment: string; amount: string; replayed: boolean }

export interface StockCountRow { id: string; number: string; warehouse: string; kind: "CYCLE" | "FULL"; status: "DRAFT" | "IN_PROGRESS" | "SUBMITTED" | "APPROVED" | "CANCELLED"; freeze: boolean; created_at: string }
export interface WorksheetLine { line: string; sku: string; name: string; location: string; lot: string; counted: string | null; assigned_to: string | null; recount: boolean }
export interface CountVariance { line: string; sku: string; location: string; lot: string; system: string; counted: string; variance: string; variance_pct: string | null; variance_value: string }
export interface StockCountInput { warehouse: string; kind: "CYCLE" | "FULL"; freeze: boolean; planned_date?: string; locations?: string[]; products?: string[]; note: string }

export interface TransferRow { id: string; number: string; status: string; from: string; to: string }
export interface TransferLine { id: string; sku: string; name: string; from_location: string; lot: string; quantity: string; dispatched: string; received: string; rejected: string; damaged: string }
export interface TransferNote { id: string; number: string; status: string; from: string; to: string; reason: string; carrier: string; expected_date: string | null; requested_by: string | null; approved_by: string | null; lines: TransferLine[] }
export interface TransferInput { from_warehouse: string; to_warehouse: string; reason: string; expected_date?: string; lines: { product: string; from_location: string; quantity: string; lot_code?: string }[] }
export interface TransferReceiptLine { line: string; accepted: string; rejected: string; damaged: string; to_location?: string }
export interface Reservation { id: string; sku: string; quantity: string; status: string; ref_type: string; ref_id: string; expires_on: string | null; warehouse: string | null }
export interface ReservationInput { product: string; quantity: string; warehouse?: string; ref_type: string; ref_id: string; note: string; expires_on?: string }
export interface Availability { on_hand: string; quarantined: string; in_transit: string; reserved: string; allocated: string; available: string }

export interface Employee { id: string; employee_no: string; name: string; first_name: string; last_name: string; email: string; status: string; hire_date: string; termination_date: string | null; department: string | null; position: string | null; manager: string | null; user_id: string | null; phone?: string }
export interface LeaveBalance { leave_type: string; year: number; [k: string]: string | number }
export interface HrMe extends Employee { leave_balances: LeaveBalance[] }
export interface LeaveType { code: string; name: string; is_paid: boolean; annual_days: string }
export interface LeaveRequest { id: string; employee: string; leave_type: string; start_date: string; end_date: string; days: string; status: string; reason: string; decision_note: string; half_day: string; workflow_instance_id: string | null }
export interface LeaveInput { leave_type: string; start_date: string; end_date: string; reason: string; half_day?: string }

export interface AttendanceRecord { id: string; employee: string; work_date: string; check_in: string; check_out: string | null; hours: string | null }
export interface TimesheetEntry { work_date: string; hours: string; project_ref: string; description: string }
export interface Timesheet { id: string; employee: string; week_start: string; status: string; decision_note: string; entries: TimesheetEntry[]; total_hours: string }
export interface TimesheetInput { week_start: string; entries: TimesheetEntry[] }

export interface PayrollRun { id: string; number: string; period_start: string; period_end: string; status: string; gross_total: string; tax_total: string; pension_employee_total: string; pension_employer_total: string; deduction_total: string; net_total: string; created_by: string; approved_by: string | null; workflow_instance_id: string | null; version: number }
export interface PayslipLine { code: string; name: string; kind: string; amount: string }
export interface Payslip { id: string; run: string; period_start: string; period_end: string; employee: string; employee_no: string; working_days: string; payable_days: string; unpaid_leave_days: string; basic: string; allowances: string; overtime_pay: string; other_earnings: string; gross: string; taxable_income: string; income_tax: string; pension_employee: string; other_deductions: string; net: string; lines?: PayslipLine[] }
export interface PayrollRunDetail extends PayrollRun { payslips: Payslip[] }

export interface Project { id: string; code: string; name: string; description: string; status: string; billing_type: string; contract_value: string; customer_id: string | null; manager_id: string; department_id: string | null; cost_center_id: string | null; priority: string; start_on: string; end_on: string; actual_start: string | null; actual_end: string | null; version: number }
export interface ProjectInput { name: string; start_on: string; end_on: string; manager_id?: string; description: string; billing_type: string; contract_value: string }
export interface ProjectTask { id: string; wbs: string; name: string; parent: string | null; milestone: boolean; status: string; assignee: string | null; planned_start: string; planned_end: string; planned_hours: string; percent_complete: string; actual_start: string | null; actual_end: string | null; project?: string }
export interface TaskInput { name: string; planned_start: string; planned_end: string; milestone: boolean; planned_hours: string; assignee?: string; parent?: string }

export interface Position { id: string; code: string; title: string; department: string | null; description: string; is_active: boolean }
export interface ChecklistItem { id: string; kind: string; title: string; done_at: string | null }
export interface EmployeeDetail extends Employee { checklist: ChecklistItem[]; bank_account?: string; tax_id?: string }
export interface EmployeeProfile extends Employee { employment_type: string; probation_end: string | null; probation_status: string; grade: string | null; separation_type: string; emergency_contacts: { id: string; name: string; relationship: string; phone: string }[]; qualifications: { id: string; kind: string; title: string; institution: string; expires_on: string | null }[]; skills: { id: string; name: string; level: string }[]; documents: HrDocument[]; missing_documents: unknown[] }
export interface HrDocument { id: string; employee: string; doc_type: string; title: string; version: number; file_id: string | null; expires_on: string | null; is_current: boolean }
export interface Contract { id: string; employee: string; kind: string; start_date: string; end_date: string | null; monthly_salary: string; currency: string }
export interface HistoryEvent { kind: string; effective_date: string; details: Record<string, unknown>; actor_id: string | null; recorded_at: string }
export interface AssignmentChange { id: string; employee: string; kind: string; effective_date: string; status: string; reason: string; department: string | null; position: string | null; manager: string | null; grade: string | null; requested_by: string; approved_by: string | null }
export interface Separation { id: string; employee: string; kind: string; last_working_date: string; reason: string; status: string; settlement_recorded: boolean; settlement_amount: string; settlement_notes: string }
export interface EmployeeInput { first_name: string; last_name: string; hire_date: string; email: string; phone: string; department?: string; position?: string; employment_type: string; allow_duplicate?: boolean }
