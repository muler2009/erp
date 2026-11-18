import type { OrgKind } from "../../shared/api/types";

export interface OrgField {
  name: string;
  label: string;
  type: "text" | "textarea" | "select" | "user" | "currency";
  required?: boolean;
  /** For selects: which kind of record offers the choices. */
  from?: OrgKind;
}

export interface OrgKindConfig {
  kind: OrgKind;
  label: string;
  singular: string;
  /** Field that holds the human name (positions use "title"). */
  nameField: "name" | "title";
  fields: OrgField[];
}

const code: OrgField = { name: "code", label: "Code", type: "text", required: true };
const name: OrgField = { name: "name", label: "Name", type: "text", required: true };

export const ORG_KINDS: OrgKindConfig[] = [
  { kind: "departments", label: "Departments", singular: "department", nameField: "name", fields: [code, name,
    { name: "parent", label: "Parent department", type: "select", from: "departments" },
    { name: "business_unit", label: "Business unit", type: "select", from: "business-units" },
    { name: "branch", label: "Branch", type: "select", from: "branches" },
    { name: "head_user_id", label: "Head", type: "user" }] },
  { kind: "teams", label: "Teams", singular: "team", nameField: "name", fields: [code, name,
    { name: "department", label: "Department", type: "select", from: "departments", required: true },
    { name: "lead_user_id", label: "Team lead", type: "user" }] },
  { kind: "positions", label: "Positions", singular: "position", nameField: "title", fields: [code,
    { name: "title", label: "Title", type: "text", required: true },
    { name: "department", label: "Department", type: "select", from: "departments" },
    { name: "description", label: "Description", type: "textarea" }] },
  { kind: "business-units", label: "Business units", singular: "business unit", nameField: "name", fields: [code, name,
    { name: "head_user_id", label: "Head", type: "user" }] },
  { kind: "cost-centers", label: "Cost centers", singular: "cost center", nameField: "name", fields: [code, name,
    { name: "department", label: "Department", type: "select", from: "departments" },
    { name: "business_unit", label: "Business unit", type: "select", from: "business-units" },
    { name: "manager_user_id", label: "Manager", type: "user" }] },
  { kind: "branches", label: "Branches", singular: "branch", nameField: "name", fields: [code, name,
    { name: "legal_entity", label: "Legal entity", type: "select", from: "legal-entities" },
    { name: "address", label: "Address", type: "textarea" }] },
  { kind: "legal-entities", label: "Legal entities", singular: "legal entity", nameField: "name", fields: [code, name,
    { name: "registration_number", label: "Registration number", type: "text" },
    { name: "tax_id", label: "Tax ID", type: "text" },
    { name: "country", label: "Country (2-letter code)", type: "text" },
    { name: "currency", label: "Currency", type: "currency" }] },
];
