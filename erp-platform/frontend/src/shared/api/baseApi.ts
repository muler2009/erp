import { createApi, fetchBaseQuery, type BaseQueryFn, type FetchArgs, type FetchBaseQueryError } from "@reduxjs/toolkit/query/react";

import { getAccessToken, renew, signIn } from "../auth/authService";
import { toApiError, type ApiError } from "./errors";

const raw = fetchBaseQuery({
  baseUrl: `${window.location.origin}/`,
  prepareHeaders: async (headers) => {
    const token = await getAccessToken();
    if (token) headers.set("Authorization", `Bearer ${token}`);
    headers.set("Accept", "application/json");
    return headers;
  },
});

/**
 * Adds a bearer token, retries once after a renewal when the server answers 401, and turns every failure into the
 * same ApiError shape so screens never parse the backend envelope themselves.
 */
const baseQuery: BaseQueryFn<string | FetchArgs, unknown, ApiError> = async (args, api, extra) => {
  let result = await raw(args, api, extra);
  if (result.error?.status === 401) {
    const user = await renew();
    if (user) {
      result = await raw(args, api, extra);
    } else {
      void signIn(window.location.pathname + window.location.search);
    }
  }
  if (result.error) {
    const e = result.error as FetchBaseQueryError;
    return { error: toApiError(e.status, "data" in e ? e.data : undefined) };
  }
  return { data: result.data, meta: result.meta };
};

export const baseApi = createApi({
  reducerPath: "api",
  baseQuery,
  tagTypes: ["Me", "Users", "Roles", "Departments", "Dashboards", "Tenants", "Audit", "Accounts", "Journals", "Invoices", "Reports", "Workflow", "Suppliers", "Requisitions", "PurchaseOrders", "Products", "Warehouses", "Stock", "Leads", "Opportunities", "CrmAccounts", "Quotations", "SalesOrders", "Payments", "FinanceRefs", "BankStatements", "Rfqs", "Matches", "SupplierPayments", "StockCounts", "Transfers", "Reservations", "Employees", "Leave", "Attendance", "Timesheets", "Payroll", "Payslips", "Projects", "ProjectTasks", "Positions", "EmployeeRecord", "Separations", "Components", "TaxBrackets", "Revisions", "PayInputs", "Loans", "Corrections", "Overtime", "LeaveConfig", "Schedules", "JobRequisitions", "Candidates", "Interviews", "Cycles", "Reviews", "Goals", "Courses", "Training", "Cases", "Policies", "Claims", "Grades", "HrReports", "ProjBudgets", "ProjExpenses", "ProjMoney", "ProjRegister", "ProjTeam", "ProjSchedule", "FixedAssets", "AssetCats", "AssetLocs", "AssetCustody", "AssetAcq", "AssetCaps", "AssetDep", "AssetMaint", "AssetCover", "AssetLife", "AssetFleet", "Quality"],
  endpoints: () => ({}),
});
