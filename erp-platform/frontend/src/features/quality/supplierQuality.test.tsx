import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { Route, Routes } from "react-router";

import * as auth from "../../shared/auth/authService";
import { renderWithProviders } from "../../test/utils";
import { ScarPage, ScarsPage, validateScar } from "./ScarsPage";
import { SupplierQualityListPage, SupplierQualityPage, validateCertificate, validateEvaluation, validateSupplierStatus } from "./SupplierQualityPage";

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
beforeEach(() => vi.spyOn(auth, "getAccessToken").mockResolvedValue("tok"));
afterEach(() => { server.resetHandlers(); vi.restoreAllMocks(); });
afterAll(() => server.close());

const employees = http.get("*/api/v1/hr/employees", () => HttpResponse.json({ results: [{ id: "e1", employee_no: "E-1", name: "Abel", status: "ACTIVE", user_id: "u1" }] }));
const suppliers = http.get("*/api/v1/procurement/suppliers", () => HttpResponse.json({ results: [{ id: "s1", name: "Bolt Co", tax_id: "", email: "", status: "QUALIFIED", partner: null, qualified_at: null }], next: null }));
const profile = (o = {}) => ({ supplier_id: "s1", status: "PENDING", status_reason: "", min_score: "70.00", max_rejection_rate: "5.00", criteria_note: "", certificates: [], latest_evaluation: null, open_scars: 0, ...o });
const scar = (o = {}) => ({ id: "r1", number: "SCAR-1", supplier_id: "s1", ncr_id: null, description: "Fix heat treatment", due_date: "2026-12-01", status: "OPEN", response: "", review_note: "", owner_id: "u1", overdue: false, history: [], ...o });
const M = ["quality.view", "quality.supplier.manage"];
const supRoute = (p: object, permissions: string[], extra: ReturnType<typeof http.get>[] = []) => {
  server.use(suppliers, http.get("*/api/v1/quality/suppliers/s1/profile", () => HttpResponse.json(p)), ...extra);
  return renderWithProviders(<Routes><Route path="/app/quality/suppliers/:id" element={<SupplierQualityPage />} /></Routes>, { permissions, route: "/app/quality/suppliers/s1" });
};
const evalsEmpty = http.get("*/api/v1/quality/suppliers/s1/evaluations", () => HttpResponse.json([]));
const scarsEmpty = http.get("*/api/v1/quality/scars", () => HttpResponse.json({ results: [], next: null }));
const scarRoute = (d: object, permissions: string[]) => { server.use(employees, suppliers, http.get("*/api/v1/quality/scars/r1", () => HttpResponse.json(d))); return renderWithProviders(<Routes><Route path="/app/quality/scars/:id" element={<ScarPage />} /></Routes>, { permissions, route: "/app/quality/scars/r1" }); };

describe("validators", () => {
  it("status, certificate, evaluation, request", () => {
    expect(validateSupplierStatus("", "r", "", "", 0)).toMatch(/Choose/);
    expect(validateSupplierStatus("BLOCKED", " ", "", "", 0)).toMatch(/reason/);
    expect(validateSupplierStatus("APPROVED", "ok", "", "", 2)).toMatch(/Close the open/);
    expect(validateSupplierStatus("BLOCKED", "bad", "", "", 2)).toBeNull();
    expect(validateSupplierStatus("CONDITIONAL", "r", "150", "", 0)).toMatch(/minimum score/);
    expect(validateSupplierStatus("CONDITIONAL", "r", "70", "x", 0)).toMatch(/maximum rejection rate/);
    expect(validateCertificate(" ", "", "")).toMatch(/Name/);
    expect(validateCertificate("ISO", "2026-05-01", "2026-04-01")).toMatch(/expires before/);
    expect(validateCertificate("ISO", "2026-05-01", "2027-05-01")).toBeNull();
    expect(validateEvaluation("", "2026-01-01")).toMatch(/both dates/);
    expect(validateEvaluation("2026-02-01", "2026-01-01")).toMatch(/ends before/);
    expect(validateScar({ supplier_id: "", description: "d", due_date: "d", owner_id: "u" })).toMatch(/supplier/);
    expect(validateScar({ supplier_id: "s", description: "d", due_date: "d", owner_id: "u" })).toBeNull();
  });
});

describe("supplier quality", () => {
  it("lists suppliers", async () => {
    server.use(suppliers);
    renderWithProviders(<SupplierQualityListPage />, { permissions: ["quality.view"] });
    expect(await screen.findByRole("link", { name: "Bolt Co" })).toHaveAttribute("href", "/app/quality/suppliers/s1");
  });

  it("shows expired certificates and the latest evaluations, with no controls for a viewer", async () => {
    supRoute(profile({ certificates: [{ id: "c1", supplier_id: "s1", name: "ISO 9001", number: "9", issuer: "BV", issued_on: "2024-01-01", expires_on: "2025-01-01", expired: true, document_id: null }] }), ["quality.view"],
      [http.get("*/api/v1/quality/suppliers/s1/evaluations", () => HttpResponse.json([{ id: "v1", supplier_id: "s1", period_from: "2026-01-01", period_to: "2026-06-30", lots_inspected: 10, lots_rejected: 1, quantity_inspected: "100", quantity_rejected: "5", ncr_count: 1, scar_open: 0, rejection_rate: "5.00", score: "85.00", outcome: "MEETS" }])), scarsEmpty]);
    expect(await screen.findByText("Expired")).toBeInTheDocument();
    expect(await screen.findByText("Meets criteria")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Change status" })).toBeNull();
  });

  it("refuses to approve while requests are open, before calling the server", async () => {
    supRoute(profile({ open_scars: 2 }), M, [evalsEmpty, scarsEmpty]);
    await userEvent.click(await screen.findByRole("button", { name: "Change status" }));
    const dlg = within(await screen.findByRole("dialog", { name: "Change supplier status" }));
    await userEvent.selectOptions(dlg.getByLabelText(/New status/), "APPROVED");
    await userEvent.type(dlg.getByLabelText(/Reason/), "Audit passed");
    await userEvent.click(dlg.getByRole("button", { name: "Change status" }));
    expect(await dlg.findByText(/Close the open corrective action requests/)).toBeInTheDocument();
  });

  it("changes status with criteria", async () => {
    let body: Record<string, unknown> | null = null;
    supRoute(profile(), M, [evalsEmpty, scarsEmpty, http.post("*/api/v1/quality/suppliers/s1/status", async ({ request }) => { body = (await request.json()) as Record<string, unknown>; return HttpResponse.json(profile({ status: "APPROVED" })); })]);
    await userEvent.click(await screen.findByRole("button", { name: "Change status" }));
    const dlg = within(await screen.findByRole("dialog", { name: "Change supplier status" }));
    await userEvent.selectOptions(dlg.getByLabelText(/New status/), "APPROVED");
    await userEvent.type(dlg.getByLabelText(/Reason/), "Audit passed");
    await userEvent.type(dlg.getByLabelText(/Minimum score/), "80");
    await userEvent.click(dlg.getByRole("button", { name: "Change status" }));
    await waitFor(() => expect(body).toEqual({ status: "APPROVED", reason: "Audit passed", min_score: "80" }));
  });

  it("adds a certificate and rejects one that expires before issue", async () => {
    let body: Record<string, unknown> | null = null;
    supRoute(profile(), M, [evalsEmpty, scarsEmpty, http.post("*/api/v1/quality/suppliers/s1/certificates", async ({ request }) => { body = (await request.json()) as Record<string, unknown>; return HttpResponse.json({}, { status: 201 }); })]);
    await userEvent.click(await screen.findByRole("button", { name: "Add a certificate" }));
    const dlg = within(await screen.findByRole("dialog", { name: "Add a certificate" }));
    await userEvent.type(dlg.getByLabelText(/^Certificate/), "ISO 9001");
    fireEvent.change(dlg.getByLabelText("Issued on"), { target: { value: "2026-05-01" } });
    fireEvent.change(dlg.getByLabelText("Expires on"), { target: { value: "2026-04-01" } });
    await userEvent.click(dlg.getByRole("button", { name: "Add" }));
    expect(await dlg.findByText(/expires before it was issued/)).toBeInTheDocument();
    expect(body).toBeNull();
    fireEvent.change(dlg.getByLabelText("Expires on"), { target: { value: "2027-05-01" } });
    await userEvent.click(dlg.getByRole("button", { name: "Add" }));
    await waitFor(() => expect(body).toEqual({ name: "ISO 9001", issued_on: "2026-05-01", expires_on: "2027-05-01" }));
  });

  it("evaluates a period and can apply the status", async () => {
    let body: Record<string, unknown> | null = null;
    supRoute(profile({ status: "APPROVED" }), M, [evalsEmpty, scarsEmpty, http.post("*/api/v1/quality/suppliers/s1/evaluations", async ({ request }) => { body = (await request.json()) as Record<string, unknown>; return HttpResponse.json({}, { status: 201 }); })]);
    await userEvent.click(await screen.findByRole("button", { name: "Evaluate performance" }));
    const dlg = within(await screen.findByRole("dialog", { name: "Evaluate performance" }));
    fireEvent.change(dlg.getByLabelText(/From/), { target: { value: "2026-01-01" } });
    fireEvent.change(dlg.getByLabelText(/To/), { target: { value: "2026-06-30" } });
    await userEvent.selectOptions(dlg.getByLabelText(/If the supplier falls below/), "yes");
    await userEvent.click(dlg.getByRole("button", { name: "Evaluate" }));
    await waitFor(() => expect(body).toEqual({ date_from: "2026-01-01", date_to: "2026-06-30", apply_status: true }));
  });
});

describe("corrective action requests", () => {
  it("lists requests and raises one", async () => {
    let body: Record<string, unknown> | null = null;
    server.use(employees, suppliers, http.get("*/api/v1/quality/scars", () => HttpResponse.json({ results: [scar({ overdue: true })], next: null })),
      http.post("*/api/v1/quality/scars", async ({ request }) => { body = (await request.json()) as Record<string, unknown>; return HttpResponse.json(scar(), { status: 201 }); }));
    renderWithProviders(<ScarsPage />, { permissions: M });
    expect(await screen.findByRole("link", { name: "SCAR-1" })).toHaveAttribute("href", "/app/quality/scars/r1");
    expect(screen.getByText("Overdue")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Raise a request" }));
    const dlg = within(await screen.findByRole("dialog", { name: "Raise a corrective action request" }));
    await dlg.findByRole("option", { name: "Bolt Co" });
    await dlg.findByRole("option", { name: /Abel/ });
    await userEvent.selectOptions(dlg.getByLabelText("Supplier"), "s1");
    await userEvent.type(dlg.getByLabelText("What must be corrected"), "Fix heat treatment");
    await userEvent.selectOptions(dlg.getByLabelText("Followed up by"), "u1");
    await userEvent.click(dlg.getByRole("button", { name: "Raise request" }));
    expect(await dlg.findByRole("alert")).toHaveTextContent(/due date/);
    fireEvent.change(dlg.getByLabelText("Respond by"), { target: { value: "2026-12-01" } });
    await userEvent.click(dlg.getByRole("button", { name: "Raise request" }));
    await waitFor(() => expect(body).toEqual({ supplier_id: "s1", description: "Fix heat treatment", due_date: "2026-12-01", owner_id: "u1" }));
  });

  it("walks response, review and close by status", async () => {
    scarRoute(scar(), M);
    expect(await screen.findByRole("button", { name: "Record the supplier's response" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Accept the response" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Close the request" })).toBeNull();
  });

  it("records a response", async () => {
    let body: Record<string, unknown> | null = null;
    server.use(http.post("*/api/v1/quality/scars/r1/response", async ({ request }) => { body = (await request.json()) as Record<string, unknown>; return HttpResponse.json(scar({ status: "RESPONDED" })); }));
    scarRoute(scar(), M);
    await userEvent.click(await screen.findByRole("button", { name: "Record the supplier's response" }));
    const dlg = within(await screen.findByRole("dialog", { name: "Record the supplier's response" }));
    await userEvent.type(dlg.getByLabelText(/Response/), "Furnace recalibrated");
    await userEvent.click(dlg.getByRole("button", { name: "Record" }));
    await waitFor(() => expect(body).toEqual({ response: "Furnace recalibrated" }));
  });

  it("rejects a response with accept false and a note", async () => {
    let body: Record<string, unknown> | null = null;
    server.use(http.post("*/api/v1/quality/scars/r1/review", async ({ request }) => { body = (await request.json()) as Record<string, unknown>; return HttpResponse.json(scar({ status: "REJECTED" })); }));
    scarRoute(scar({ status: "RESPONDED", response: "Done" }), M);
    await userEvent.click(await screen.findByRole("button", { name: "Reject the response" }));
    const dlg = within(await screen.findByRole("dialog", { name: "Reject the response" }));
    await userEvent.type(dlg.getByLabelText(/Why it is not acceptable/), "No evidence");
    await userEvent.click(dlg.getByRole("button", { name: "Reject" }));
    await waitFor(() => expect(body).toEqual({ accept: false, note: "No evidence" }));
  });

  it("closes an accepted request, shows the refusal, and gives a viewer nothing", async () => {
    server.use(http.post("*/api/v1/quality/scars/r1/close", () => HttpResponse.json({ error: { code: "invalid_state", message: "Only an accepted response can be closed." } }, { status: 409 })));
    scarRoute(scar({ status: "ACCEPTED", response: "Done" }), M);
    await userEvent.click(await screen.findByRole("button", { name: "Close the request" }));
    const dlg = within(await screen.findByRole("dialog", { name: "Close the request" }));
    await userEvent.click(dlg.getByRole("button", { name: "Close" }));
    expect(await dlg.findByText(/Only an accepted response/)).toBeInTheDocument();
  });

  it("offers no actions to a viewer", async () => {
    scarRoute(scar(), ["quality.view"]);
    await screen.findByText(/SCAR-1/);
    expect(screen.queryByRole("button", { name: "Record the supplier's response" })).toBeNull();
  });
});
