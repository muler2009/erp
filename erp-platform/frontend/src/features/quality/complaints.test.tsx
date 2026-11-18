import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { Route, Routes } from "react-router";

import * as auth from "../../shared/auth/authService";
import { renderWithProviders } from "../../test/utils";
import { ComplaintPage, ComplaintsPage, closeBlock, validateComplaint } from "./ComplaintsPage";

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
beforeEach(() => vi.spyOn(auth, "getAccessToken").mockResolvedValue("tok"));
afterEach(() => { server.resetHandlers(); vi.restoreAllMocks(); });
afterAll(() => server.close());

const employees = http.get("*/api/v1/hr/employees", () => HttpResponse.json({ results: [{ id: "e1", employee_no: "E-1", name: "Abel", status: "ACTIVE", user_id: "u1" }, { id: "e2", employee_no: "E-2", name: "Sara", status: "ACTIVE", user_id: "u2" }] }));
const cfg = http.get("*/api/v1/quality/config/:kind", ({ params }) => HttpResponse.json(params.kind === "SEVERITY" ? [{ id: "1", kind: "SEVERITY", code: "CRITICAL", name: "Critical", rank: 3, requires_capa: true, is_active: true }, { id: "2", kind: "SEVERITY", code: "MINOR", name: "Minor", rank: 1, requires_capa: false, is_active: true }] : params.kind === "COMPLAINT_TYPE" ? [{ id: "3", kind: "COMPLAINT_TYPE", code: "DEFECT", name: "Product defect", rank: 1, requires_capa: false, is_active: true }] : [{ id: "4", kind: "NCR_CATEGORY", code: "MATERIAL", name: "Material", rank: 1, requires_capa: false, is_active: true }]));
const products = http.get("*/api/v1/inventory/products", () => HttpResponse.json({ results: [{ id: "p1", sku: "BOLT", name: "Bolt", is_active: true }] }));
const cmp = (o = {}) => ({ id: "k1", number: "CMP-1", complaint_type: "DEFECT", severity: "MINOR", status: "RECEIVED", customer_id: null, customer_name: "Acme", product_id: null, sales_order_id: null, lot_number: "", received_on: "2026-11-10", investigator_id: "u1", capa_id: null, is_recurring: false, responded_on: null, ...o });
const detail = (o = {}) => ({ ...cmp(), description: "Bolts snapped", channel: "email", findings: "", response_text: "", resolution: "", customer_confirmed_on: null, evidence: [], costs: [], actions: [], history: [], ...o });
const M = ["quality.view", "quality.complaint.manage"];
const route = (d: object, permissions: string[]) => { server.use(employees, cfg, http.get("*/api/v1/quality/complaints/k1", () => HttpResponse.json(d))); return renderWithProviders(<Routes><Route path="/app/quality/complaints/:id" element={<ComplaintPage />} /></Routes>, { permissions, route: "/app/quality/complaints/k1" }); };

describe("validators", () => {
  it("complaint and close rules", () => {
    const f = { complaint_type: "DEFECT", severity: "MINOR", description: "d", customer_name: "A", investigator_id: "u1" };
    expect(validateComplaint({ ...f, customer_name: " " })).toMatch(/customer/);
    expect(validateComplaint({ ...f, severity: "" })).toMatch(/severity/);
    expect(validateComplaint({ ...f, investigator_id: "" })).toMatch(/investigates/);
    expect(validateComplaint(f)).toBeNull();
    expect(closeBlock({ capa_id: null }, false, "", " ")).toMatch(/confirmation/);
    expect(closeBlock({ capa_id: null }, true, "2026-11-12", "")).toMatch(/requires a CAPA/);
    expect(closeBlock({ capa_id: "k" }, true, "", "customer unreachable")).toBeNull();
  });
});

describe("ComplaintsPage", () => {
  it("lists complaints, flags recurring ones and hides registering from a viewer", async () => {
    server.use(employees, cfg, http.get("*/api/v1/quality/complaints", () => HttpResponse.json({ results: [cmp({ is_recurring: true })], next: null })));
    renderWithProviders(<ComplaintsPage />, { permissions: ["quality.view"] });
    expect(await screen.findByRole("link", { name: "CMP-1" })).toHaveAttribute("href", "/app/quality/complaints/k1");
    expect(screen.getByText("Recurring")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Register a complaint" })).toBeNull();
  });

  it("registers a complaint", async () => {
    let body: Record<string, unknown> | null = null;
    server.use(employees, cfg, products, http.get("*/api/v1/quality/complaints", () => HttpResponse.json({ results: [], next: null })),
      http.post("*/api/v1/quality/complaints", async ({ request }) => { body = (await request.json()) as Record<string, unknown>; return HttpResponse.json(cmp(), { status: 201 }); }));
    renderWithProviders(<ComplaintsPage />, { permissions: M });
    await userEvent.click(await screen.findByRole("button", { name: "Register a complaint" }));
    const dlg = within(await screen.findByRole("dialog", { name: "Register a complaint" }));
    await dlg.findByRole("option", { name: "Product defect" });
    await dlg.findByRole("option", { name: /Abel/ });
    await userEvent.type(dlg.getByLabelText("Customer"), "Acme");
    await userEvent.selectOptions(dlg.getByLabelText("Complaint type"), "DEFECT");
    await userEvent.selectOptions(dlg.getByLabelText("Severity"), "MINOR");
    await userEvent.type(dlg.getByLabelText("Description"), "Bolts snapped");
    await userEvent.click(dlg.getByRole("button", { name: "Register" }));
    expect(await dlg.findByRole("alert")).toHaveTextContent(/investigates/);
    await userEvent.selectOptions(dlg.getByLabelText("Investigator"), "u1");
    await userEvent.click(dlg.getByRole("button", { name: "Register" }));
    await waitFor(() => expect(body).toEqual({ customer_name: "Acme", complaint_type: "DEFECT", severity: "MINOR", description: "Bolts snapped", investigator_id: "u1" }));
  });
});

describe("ComplaintPage", () => {
  it("records findings", async () => {
    let body: Record<string, unknown> | null = null;
    server.use(http.post("*/api/v1/quality/complaints/k1/investigate", async ({ request }) => { body = (await request.json()) as Record<string, unknown>; return HttpResponse.json(cmp({ status: "INVESTIGATING" })); }));
    route(detail(), M);
    await userEvent.click(await screen.findByRole("button", { name: "Record findings" }));
    const dlg = within(await screen.findByRole("dialog", { name: "Record findings" }));
    await userEvent.type(dlg.getByLabelText(/Findings/), "Heat treatment fault");
    await userEvent.click(dlg.getByRole("button", { name: "Record" }));
    await waitFor(() => expect(body).toEqual({ findings: "Heat treatment fault" }));
  });

  it("offers responding only once investigating", async () => {
    route(detail(), M);
    await screen.findByRole("button", { name: "Record findings" });
    expect(screen.queryByRole("button", { name: "Respond to the customer" })).toBeNull();
  });

  it("responds to the customer", async () => {
    let body: Record<string, unknown> | null = null;
    server.use(http.post("*/api/v1/quality/complaints/k1/respond", async ({ request }) => { body = (await request.json()) as Record<string, unknown>; return HttpResponse.json(cmp({ status: "RESPONDED" })); }));
    route(detail({ status: "INVESTIGATING", findings: "x" }), M);
    await userEvent.click(await screen.findByRole("button", { name: "Respond to the customer" }));
    const dlg = within(await screen.findByRole("dialog", { name: "Respond to the customer" }));
    await userEvent.type(dlg.getByLabelText(/What we told the customer/), "Replacement sent");
    await userEvent.type(dlg.getByLabelText(/Resolution/), "Replaced");
    await userEvent.click(dlg.getByRole("button", { name: "Record response" }));
    await waitFor(() => expect(body).toEqual({ response_text: "Replacement sent", resolution: "Replaced" }));
  });

  it("blocks closing a critical complaint without a CAPA", async () => {
    route(detail({ status: "RESPONDED", severity: "CRITICAL" }), M);
    await screen.findByText(/needs a CAPA before the complaint can be closed/);
    await waitFor(() => expect(screen.getByRole("button", { name: "Close the complaint" })).toBeInTheDocument());
    await userEvent.click(screen.getByRole("button", { name: "Close the complaint" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/requires a CAPA/);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("closes with a confirmation date or a note, and shows server refusals", async () => {
    let body: Record<string, unknown> | null = null;
    server.use(http.post("*/api/v1/quality/complaints/k1/close", async ({ request }) => { body = (await request.json()) as Record<string, unknown>; return HttpResponse.json(cmp({ status: "CLOSED" })); }));
    route(detail({ status: "RESPONDED" }), M);
    await userEvent.click(await screen.findByRole("button", { name: "Close the complaint" }));
    const dlg = within(await screen.findByRole("dialog", { name: "Close the complaint" }));
    await userEvent.click(dlg.getByRole("button", { name: "Close" }));
    expect(await dlg.findByText(/customer's confirmation/)).toBeInTheDocument();
    expect(body).toBeNull();
    fireEvent.change(dlg.getByLabelText(/Customer confirmed on/), { target: { value: "2026-11-12" } });
    await userEvent.click(dlg.getByRole("button", { name: "Close" }));
    await waitFor(() => expect(body).toEqual({ note: "", customer_confirmed_on: "2026-11-12" }));
  });

  it("raises a CAPA, rejecting the same owner and reviewer, and links an existing one", async () => {
    route(detail({ status: "INVESTIGATING" }), M);
    await userEvent.click(await screen.findByRole("button", { name: "Raise a CAPA" }));
    const dlg = within(await screen.findByRole("dialog", { name: "Raise a CAPA for this complaint" }));
    await dlg.findAllByRole("option", { name: /Abel/ });
    await userEvent.selectOptions(dlg.getByLabelText("Owner"), "u1");
    await userEvent.selectOptions(dlg.getByLabelText("Effectiveness reviewer"), "u1");
    fireEvent.change(dlg.getByLabelText("Due date"), { target: { value: "2026-12-30" } });
    await userEvent.click(dlg.getByRole("button", { name: "Raise CAPA" }));
    expect(await dlg.findByText(/must be different people/)).toBeInTheDocument();
  });

  it("shows the linked CAPA and no controls for a viewer", async () => {
    route(detail({ status: "INVESTIGATING", capa_id: "c9" }), ["quality.view"]);
    expect(await screen.findByRole("link", { name: "Open the linked CAPA" })).toHaveAttribute("href", "/app/quality/capas/c9");
    expect(screen.queryByRole("button", { name: "Record findings" })).toBeNull();
  });
});
