export const CUSTOMER_TYPES: [string, string][] = [["BUSINESS", "Business"], ["INDIVIDUAL", "Individual"]];
export const LIFECYCLES: [string, string][] = [["PROSPECT", "Prospect"], ["ACTIVE", "Active"], ["AT_RISK", "At risk"], ["CHURNED", "Churned"]];
export const CHANNELS: [string, string][] = [["EMAIL", "Email"], ["PHONE", "Phone"], ["SMS", "SMS"]];
export const CONTACT_ROLES: [string, string][] = [["DECISION_MAKER", "Decision maker"], ["INFLUENCER", "Influencer"], ["BILLING", "Billing"], ["TECHNICAL", "Technical"], ["USER", "User"], ["OTHER", "Other"]];
export const CREDIT: [string, string][] = [["OK", "OK"], ["ON_HOLD", "On hold"], ["BLOCKED", "Blocked"]];
export const label = (list: [string, string][], v: string | undefined) => list.find(([k]) => k === v)?.[1] ?? v ?? "";
