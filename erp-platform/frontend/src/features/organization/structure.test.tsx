import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";

import * as auth from "../../shared/auth/authService";
import { renderWithProviders } from "../../test/utils";
import { CompanyPage } from "./CompanyPage";
import { StructurePage } from "./StructurePage";

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
beforeEach(() => vi.spyOn(auth, "getAccessToken").mockResolvedValue("tok"));
afterEach(() => { server.resetHandlers(); vi.restoreAllMocks(); });
afterAll(() => server.close());

const dept = (o = {}) => ({ id: "d1", code: "FIN", name: "Finance", is_active: true, version: 3, parent: null, business_unit: null, branch: null, head_user_id: null, ...o });
const employees = http.get("*/api/v1/hr/employees", () => HttpResponse.json({ results: [{ id: "e1", employee_no: "E-1", name: "Abel", status: "ACTIVE", user_id: "u1" }] }));
const list = (kind: string, rows: object[]) => http.get(`*/api/v1/org/${kind}`, () => HttpResponse.json({ results: rows, next: null, previous: null }));
const MANAGE = ["org.structure.view", "org.structure.manage"];

describe("StructurePage", () => {
  it("lists records and switches between kinds", async () => {
    server.use(list("departments", [dept()]), list("positions", [{ id: "p1", code: "ACC", title: "Accountant", is_active: false, version: 1 }]));
    renderWithProviders(<StructurePage />, { permissions: ["org.structure.view"] });
    expect(await screen.findByText("Finance")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Add department/ })).not.toBeInTheDocument(); // view-only
    await userEvent.click(screen.getByRole("tab", { name: "Positions" }));
    expect(await screen.findByText("Accountant")).toBeInTheDocument();
    expect(screen.getByText("Inactive")).toBeInTheDocument();
  });

  it("creates a team under a department chosen from the real list", async () => {
    let body: Record<string, unknown> = {};
    server.use(employees, list("teams", []), list("departments", [dept()]),
      http.post("*/api/v1/org/teams", async ({ request }) => { body = (await request.json()) as Record<string, unknown>; return HttpResponse.json({ id: "t1" }, { status: 201 }); }));
    renderWithProviders(<StructurePage />, { permissions: MANAGE });
    await userEvent.click(await screen.findByRole("tab", { name: "Teams" }));
    await userEvent.click(await screen.findByRole("button", { name: "Add team" }));
    const d = within(await screen.findByRole("dialog", { name: "New team" }));
    await userEvent.click(d.getByRole("button", { name: "Create" }));
    expect(await d.findByRole("alert")).toHaveTextContent("Code is required");
    await userEvent.type(d.getByLabelText("Code"), "AP");
    await userEvent.type(d.getByLabelText("Name"), "Payables");
    await userEvent.click(d.getByRole("button", { name: "Create" }));
    expect(await d.findByRole("alert")).toHaveTextContent("Department is required");
    await waitFor(() => expect(d.getByRole("option", { name: "FIN Finance" })).toBeInTheDocument());
    await userEvent.selectOptions(d.getByLabelText("Department"), "d1");
    await userEvent.click(d.getByRole("button", { name: "Create" }));
    await waitFor(() => expect(body).toMatchObject({ code: "AP", name: "Payables", department: "d1", lead_user_id: null }));
  });

  it("edits with the loaded version, can deactivate, and cannot make a department its own parent", async () => {
    let body: Record<string, unknown> = {};
    server.use(employees, list("departments", [dept(), dept({ id: "d2", code: "OPS", name: "Operations" })]),
      http.patch("*/api/v1/org/departments/d1", async ({ request }) => { body = (await request.json()) as Record<string, unknown>; return HttpResponse.json(dept({ version: 4 })); }));
    renderWithProviders(<StructurePage />, { permissions: MANAGE });
    await userEvent.click((await screen.findAllByRole("button", { name: "Edit" }))[0]!);
    const d = within(await screen.findByRole("dialog", { name: "Edit department" }));
    expect((d.getByLabelText("Code") as HTMLInputElement).value).toBe("FIN");
    await waitFor(() => expect(d.getByRole("option", { name: "OPS Operations" })).toBeInTheDocument());
    expect(d.queryByRole("option", { name: "FIN Finance" })).not.toBeInTheDocument();
    await userEvent.click(d.getByLabelText("Active"));
    await userEvent.click(d.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(body).toMatchObject({ code: "FIN", is_active: false, version: 3, parent: null }));
  });

  it("shows a version conflict instead of overwriting", async () => {
    server.use(employees, list("departments", [dept()]),
      http.patch("*/api/v1/org/departments/d1", () => HttpResponse.json({ error: { code: "version_conflict", message: "The record was modified by someone else; reload and retry." } }, { status: 409 })));
    renderWithProviders(<StructurePage />, { permissions: MANAGE });
    await userEvent.click(await screen.findByRole("button", { name: "Edit" }));
    const d = within(await screen.findByRole("dialog", { name: "Edit department" }));
    await userEvent.click(d.getByRole("button", { name: "Save changes" }));
    expect(await d.findByRole("alert")).toHaveTextContent("modified by someone else");
  });
});

const usd = { id: "cu1", code: "USD", name: "US dollar", symbol: "$", decimals: 2, is_active: true };
const currencies = http.get("*/api/v1/org/currencies", () => HttpResponse.json({ results: [usd], next: null, previous: null }));

describe("CompanyPage", () => {
  const company = { id: "c1", legal_name: "Acme PLC", trade_name: "", registration_number: "", tax_id: "", country: "ET", address: "", phone: "", email: "", base_currency: null, fiscal_year_start_month: 7, work_days: [], version: 2 };

  it("saves changes with the version and the chosen working days", async () => {
    let body: Record<string, unknown> = {};
    server.use(currencies, http.get("*/api/v1/org/company", () => HttpResponse.json(company)),
      http.patch("*/api/v1/org/company", async ({ request }) => { body = (await request.json()) as Record<string, unknown>; return HttpResponse.json({ ...company, version: 3 }); }));
    renderWithProviders(<CompanyPage />, { permissions: ["org.structure.view", "org.settings.manage"] });
    const name = await screen.findByLabelText("Legal name");
    expect((screen.getByLabelText("Mon") as HTMLInputElement).checked).toBe(true); // empty list = Mon–Fri
    await waitFor(() => expect(screen.getByRole("option", { name: "USD US dollar" })).toBeInTheDocument());
    await userEvent.selectOptions(screen.getByLabelText("Base currency"), "cu1");
    await userEvent.click(screen.getByLabelText("Sat"));
    await userEvent.clear(name);
    await userEvent.type(name, "Acme Holdings");
    await userEvent.click(screen.getByRole("button", { name: "Save company profile" }));
    expect(await screen.findByRole("status")).toHaveTextContent("saved");
    expect(body).toMatchObject({ legal_name: "Acme Holdings", fiscal_year_start_month: 7, version: 2, base_currency: "cu1", work_days: [1, 2, 3, 4, 5, 6] });
  });

  it("requires a legal name and is read-only without the settings permission", async () => {
    server.use(currencies, http.get("*/api/v1/org/company", () => HttpResponse.json(company)));
    renderWithProviders(<CompanyPage />, { permissions: ["org.structure.view"] });
    expect(await screen.findByLabelText("Legal name")).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Save company profile" })).not.toBeInTheDocument();
  });
});
