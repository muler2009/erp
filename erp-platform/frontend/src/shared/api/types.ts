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
export interface EmployeeProfile extends Employee { employment_type: string; probation_end: string | null; probation_status: string; grade: string | null; separation_type: string; emergency_contacts: { id: string; name: string; relationship: string; phone: string }[]; qualifications: { id: string; kind: string; title: string; institution: string; expires_on: string | null }[]; skills: { id: string; name: string; level: number }[]; documents: HrDocument[]; missing_documents: unknown[] }
export interface HrDocument { id: string; employee: string; doc_type: string; title: string; version: number; file_id: string | null; expires_on: string | null; is_current: boolean }
export interface Contract { id: string; employee: string; kind: string; start_date: string; end_date: string | null; monthly_salary: string; currency: string }
export interface HistoryEvent { kind: string; effective_date: string; details: Record<string, unknown>; actor_id: string | null; recorded_at: string }
export interface AssignmentChange { id: string; employee: string; kind: string; effective_date: string; status: string; reason: string; department: string | null; position: string | null; manager: string | null; grade: string | null; requested_by: string; approved_by: string | null }
export interface Separation { id: string; employee: string; kind: string; last_working_date: string; reason: string; status: string; settlement_recorded: boolean; settlement_amount: string; settlement_notes: string }
export interface EmployeeInput { first_name: string; last_name: string; hire_date: string; email: string; phone: string; department?: string; position?: string; employment_type: string; allow_duplicate?: boolean }

export interface PayComponent { id: string; code: string; name: string; kind: string; calc: string; value: string; taxable: boolean; is_active: boolean }
export interface TaxBracket { lower_bound: string; rate: string }
export interface SalaryRevision { id: string; employee: string; employee_no: string; effective_date: string; old_salary: string; new_salary: string; reason: string; status: string; requested_by: string; decided_by: string | null; decision_note: string }
export interface PayrollInput { id: string; employee: string; employee_no: string; kind: string; month: string; amount: string; taxable: boolean; description: string; status: string; consumed_by_run: string | null }
export interface Loan { id: string; employee: string; employee_no: string; kind: string; principal: string; installments: number; start_month: string; status: string; reason: string; decision_note: string; schedule: { due_month: string; amount: string; repaid: boolean; deducted_in_run: string | null }[] }
export interface PayrollRegister { number: string; period_start: string; period_end: string; status: string; rows: { employee_no: string; name: string; department: string | null; basic: string; allowances: string; overtime: string; other_earnings: string; gross: string; income_tax: string; pension_employee: string; other_deductions: string; net: string; pension_employer: string }[]; totals: Record<string, string> }
export interface PaymentInstructions { number: string; total: string; payments: { employee_no: string; name: string; bank_account: string; amount: string; reference: string }[]; missing_bank_account: string[] }

export interface Correction { id: string; employee: string; work_date: string; check_in: string; check_out: string | null; work_mode: string; reason: string; status: string; decision_note: string }
export interface OvertimeRequest { id: string; employee: string; work_date: string; hours: string; reason: string; status: string; decision_note: string }
export interface AttendanceReportRow { employee_no: string; name: string; period: string; present_days: number; absent_days: number; leave_days: number; late_count: number; late_minutes: number; early_count: number; worked_hours: string; overtime_hours: string; missed_punches: number }
export interface ExceptionRow { employee_no: string; name: string; date: string; exceptions: string[]; correction_status: string | null; overtime_request_status: string | null }
export interface LeaveCalendar { leaves: { employee_no: string; name: string; department: string | null; type: string; start_date: string; end_date: string; days: string; status: string }[]; holidays: { date: string; name: string }[] }
export interface LeaveReportRow { key: string[]; allocated: string; used: string; expired: string; remaining: string; pending: string; utilization_percent: string | null }
export interface LeaveTypeConfig { code: string; name: string; is_paid: boolean; annual_days: string; grant_mode: string; eligibility_months: number; eligible_employment_types: string[]; max_carryover_days: string; carryover_expiry_months: number; allow_half_day: boolean; max_consecutive_days: number; min_notice_days: number; is_active: boolean }
export interface WorkSchedule { id: string; code: string; name: string; work_days: number[]; start_time: string; end_time: string; break_minutes: number; grace_minutes: number; is_default: boolean }
export interface OvertimePolicy { weekday_multiplier: string; rest_day_multiplier: string; holiday_multiplier: string; max_daily_hours: string; monthly_hours_divisor: string }

export interface JobRequisition { id: string; number: string; title: string; department: string | null; position: string | null; headcount: number; justification: string; status: string; requested_by: string; decision_note: string }
export interface Interview { id: string; candidate: string; candidate_name: string; interviewer: string; scheduled_at: string; status: string; score: number | null; recommendation: string }
export interface Offer { id: string; candidate: string; monthly_salary: string; currency: string; start_date: string; status: string }
export interface Candidate { id: string; requisition: string; name: string; email: string; phone: string; source: string; stage: string; reason: string; employee: string | null; offer: Offer | null; interviews: Interview[] }
export interface Scorecard { candidate: string; stage: string; interviews: number; average_score: string | null; hire_votes: number; no_hire_votes: number }

export interface ReviewCycle { id: string; name: string; start_date: string; end_date: string; status: string }
export interface Goal { id: string; employee: string; cycle: string; title: string; weight: string; progress: string }
export interface PerfReview { id: string; employee: string; employee_no: string; cycle: string; status: string; self_rating: number | null; self_comment: string; goal_score: string | null; manager_rating?: number | null; manager_comment?: string }
export interface Course { id: string; code: string; name: string; provider: string; hours: string; validity_months: number | null; mandatory: boolean }
export interface TrainingRecord { id: string; employee: string; employee_no: string; course: string; completed_on: string; expires_on: string | null; score: string | null }
export interface Compliance { gaps: { employee_no: string; name: string; course: string; reason: string }[]; expiring: { employee_no: string; name: string; course: string; expires_on: string }[] }
export interface HrCase { id: string; employee: string; employee_no: string; kind: string; summary: string; status: string; outcome: string; notes?: { author: string; text: string; at: string }[] }
export interface HrPolicy { id: string; code: string; version: number; title: string; status: string; published_at: string | null; body?: string; acknowledged?: boolean }
export interface Claim { id: string; employee: string; employee_no: string; description: string; expense_date: string; amount: string; status: string; decision_note: string }

export interface JobGrade { id: string; code: string; name: string; min_salary: string; max_salary: string; is_active: boolean }
export interface OrgNode { id: string; employee_no: string; name: string; position: string | null; department: string | null; reports: OrgNode[] }
export interface HeadcountPlanRow { position: string; position_id: string; department: string | null; grade: string | null; approved: number; occupied: number; vacant: number; over_headcount: number }
export interface MonitoringReport { probation_ending: { employee: string; name: string; probation_end: string }[]; contracts_expiring: { employee: string; name: string; end_date: string }[]; documents_expiring: { employee: string; title: string; expires_on: string }[]; qualifications_expiring: { employee: string; title: string; expires_on: string }[]; retirements: { employee: string; name: string; retirement_date: string }[] }
export interface ImportReport { committed: boolean; rows: { row: number; ok: boolean; errors: string[] }[]; created: string[]; valid_rows: number; error_rows: number }
export interface PunchReport { created: number; updated: number; skipped: number; unknown_employees: string[]; invalid_rows: number }
export interface HrDashboard { headcount: { as_of: string; total: number; by_department: Record<string, number>; by_employment_type: Record<string, number> }; turnover: { year: number; leavers: number; average_headcount: string; turnover_percent: string | null; by_type: Record<string, number> }; tenure: Record<string, number>; absenteeism: { month: string; leave_days: string }[]; recruitment: { open_requisitions: number; funnel: Record<string, number> }; payroll_cost: { month: string; gross: string; employer_pension: string; employer_cost: string; net: string }[] | null }

export interface BudgetLine { category: string; description: string; amount: string }
export interface ProjectBudget { id: string; project: string; revision: number; status: string; reason: string; total: string; lines: BudgetLine[] }
export interface ProjectExpense { id: string; project: string; task: string | null; category: string; description: string; amount: string; incurred_on: string; claimant_id: string; invoice_id: string | null; status: string; decision_note: string }
export interface CostReport { project: string; has_approved_budget: boolean; budget_revision: number | null; rows: { category: string; budget: string; actual: string; variance: string; over_budget: boolean; planned: string | null }[]; pending_expenses: string; unmatched_hours: string; hours: string; totals: { budget: string; actual: string; variance: string }; earned_value: { percent_complete: string; planned_percent: string; bac: string; pv: string; ev: string; ac: string; cpi: string | null; spi: string | null; eac: string | null; vac: string | null } }
export interface ProjectProfit { project: string; billing_type: string; revenue_recognized: string; billed: string; actual_cost: string; margin: string; margin_percent: string | null; forecast: { revenue: string; cost: string; margin: string }; under_billed: string | null }
export interface ProjectBilling { project: string; rows: { invoice_id: string; kind: string; amount: string; description: string; invoice_status: string }[]; billed: string; recognized: string; paid: string; contract_value: string; remaining: string | null }
export interface ProjectRisk { id: string; title: string; description: string; category: string; probability: number; impact: number; score: number; status: string; owner_id: string | null; mitigation: string; review_on: string | null }
export interface ProjectIssue { id: string; title: string; severity: string; status: string; assigned_to: string | null; due_on: string | null; task: string | null; risk: string | null; resolution: string }
export interface ProjectMember { id: string; user_id: string; role: string; cost_rate: string; bill_rate: string; allocation_percent: string; is_active: boolean }

export interface GanttTask { id: string; wbs: string; name: string; parent: string | null; milestone: boolean; status: string; start: string; end: string; percent: string; assignee: string | null; summary: boolean; hours: string; predecessors: { id: string; task: string; kind: string; lag_days: number }[]; slack_days?: number; critical?: boolean }
export interface Gantt { project: string; start: string; end: string; tasks: GanttTask[]; critical_path: string[] }
export interface ProjectTimeReport { rows: { user_id: string; hours: string; cost: string; rate: string }[]; hours: string; cost: string; unmatched_hours: string }
export interface BillingPreview { rows: { user_id: string; hours: string; rate: string; amount: string }[]; amount: string }
export interface ResourceLoadRow { user_id: string; projects: string[]; allocation_percent: string; over_allocated: boolean; planned_hours: string; capacity_hours: string; load_percent: string; overloaded: boolean }

export interface FixedAsset { id: string; number: string; name: string; description: string; category: { id: string; code: string }; asset_class: string; status: string; manufacturer: string; model: string; serial_number: string; acquisition_date: string | null; purchase_cost: string; currency: string; location: { id: string; code: string } | null; department_id: string | null; custodian_id: string | null; barcode: string; qr_code: string; rfid_tag: string; version: number }
export interface AssetCategory { id: string; code: string; name: string; parent: string | null; prefix: string; asset_class: string; capitalization_threshold: string; depreciation_method: string; useful_life_months: number; residual_percent: string; reducing_rate_percent: string | null; tracking: string; requires_serial: boolean; requires_insurance: boolean; is_active: boolean }
export interface AssetLocation { id: string; code: string; name: string; parent: string | null; is_active: boolean }
export interface AssetHistoryRow { at: string; event: string; detail: Record<string, unknown> | string; note: string; actor: string | null }
export interface DepreciationRow { period: string; charge: string; accumulated: string; nbv: string }

export interface AssetAssignment { id: string; number: string; asset: string; assignee_type: string; assignee_id: string | null; project: string; kind: string; status: string; assigned_on: string; expected_return_on: string | null; returned_on: string | null; condition_out: string; condition_in: string; acknowledged: boolean }
export interface AssetTransfer { id: string; number: string; asset: string; status: string; reason: string; effective_date: string; from_location: string | null; to_location: string | null; condition_out: string; condition_in: string }
export interface CustodyExceptions { unreturned: { assignment: string; asset: string; expected_return_on?: string }[]; unacknowledged: { assignment: string; asset: string; assignee_type: string; since: string }[] }
export interface Acquisition { asset: string; source: string; cost: string; extra_costs: { kind: string; description: string; amount: string }[]; total_cost: string; delivered_on: string | null; accepted_on: string | null; commissioning_passed: boolean | null; commissioned_on: string | null }
export interface CapitalizationRequest { id: string; number: string; asset: string; status: string; capitalize: boolean; total_cost: string; base_amount: string; capitalization_date: string; decision_note: string }

export interface DepRun { id: string; period: string; status: string; total: string; assets: number }
export interface Valuation { as_of: string | null; rows: { asset: string; name: string; category: string; gross_value: string; accumulated_depreciation: string; impairment: string; net_book_value: string }[]; totals: { gross_value: string; accumulated_depreciation: string; impairment: string; net_book_value: string } }
export interface Reconciliation { register_cost: string; ledger_cost: string; cost_difference: string; register_accumulated: string; ledger_accumulated: string; accumulated_difference: string; reconciled: boolean }
export interface ValueAdjustment { id: string; asset: string; kind: string; status: string; amount: string; effective_date: string; reason: string; extend_life_months: number; decision_note: string }

export interface WorkOrderMaterial { product_id: string | null; description: string; quantity: string; unit_cost: string }
export interface WorkOrder { id: string; number: string; asset: { id: string; number: string }; kind: string; status: string; priority: string; description: string; scheduled_on: string | null; due_on: string | null; assigned_to_id: string | null; provider_supplier_id: string | null; estimated_cost: string; labor_hours: string; labor_cost: string; material_cost: string; external_cost: string; total_cost: string; breakdown_id: string | null; plan_id: string | null; requested_by: string; approved_by: string | null; completed_by: string | null; verified_by: string | null; completed_on: string | null; materials: WorkOrderMaterial[] }
export interface Breakdown { id: string; number: string; asset: { id: string; number: string }; reported_at: string; symptoms: string; cause: string; failure_code: string; severity: string; status: string; restored_at: string | null; downtime_hours: string | null }
export interface MaintenancePlan { id: string; asset: string; name: string; kind: string; trigger: string; interval_days: number | null; interval_usage: string | null; lead_days: number | null; next_due_on: string | null; next_due_meter: string | null; last_done_on: string | null; is_active: boolean; estimated_cost: string }
export interface MaintCostRow { key: string; work_orders: number; labor: string; material: string; external: string; total: string }
export interface BreakdownRow { asset: string; name: string; breakdowns: number; downtime_hours: string; mttr_hours: string | null; mtbf_hours: string; repeated_failure_codes: string[]; recurring: boolean }
export interface MaintScheduleRow { plan: string; asset: string; trigger: string; next_due_on: string | null; next_due_meter: string | null; meter: string }
export interface UnavailableRow { asset: string; name: string; since: string; open_work_orders: string[] }

export interface InspectionItem { text: string; kind: "PASS_FAIL" | "READING"; result?: string }
export interface InspectionTemplate { id: string; code: string; name: string; category: string | null; items: InspectionItem[]; is_active: boolean }
export interface InspectionFinding { id: string; description: string; severity: string; status: string; work_order: string | null }
export interface AssetInspection { id: string; asset: { id: string; number: string }; template: string | null; status: string; scheduled_on: string; performed_on: string | null; inspector_id: string | null; condition_result: string; results: InspectionItem[]; notes: string; findings: InspectionFinding[]; evidence: { file_id: string; caption: string }[] }
export interface ConditionReport { by_category: ({ category: string } & Record<string, number | string>)[]; never_inspected: number; open_findings: number; overdue_inspections: { id: string; asset: string; scheduled_on: string; days_overdue: number }[] }
export interface Warranty { id: string; asset: string; provider_name: string; reference: string; start_on: string; end_on: string; coverage: string }
export interface WarrantyList { in_force: Warranty | null; all: Warranty[] }
export interface AssetClaim { id: string; kind: "warranty" | "insurance"; status: string; description: string; amount_claimed: string; amount_recovered: string; asset: string; source: string; date: string }
export interface InsurancePolicy { id: string; policy_number: string; insurer: string; start_on: string; end_on: string; premium: string; coverage_amount: string; assets: { asset: string; insured_value: string }[] }
export interface UninsuredRow { asset: string; name: string; category: string; gross_value: string }
export interface ExpiringCoverage { warranties: { asset: string; provider: string; end_on: string }[]; policies: { policy: string; insurer: string; end_on: string; renewed: boolean }[] }
