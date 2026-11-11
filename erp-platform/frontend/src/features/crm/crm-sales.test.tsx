import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";

import * as auth from "../../shared/auth/authService";
import { renderWithProviders } from "../../test/utils";
import { OrdersPage, orderActions } from "../sales/OrdersPage";
import { QuotationsPage, quoteActions } from "../sales/QuotationsPage";
import { LEAD_FLOW, LeadsPage, leadSchema } from "./LeadsPage";
import { OpportunitiesPage } from "./OpportunitiesPage";

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
beforeEach(() => { vi.spyOn(auth, "getAccessToken").mockResolvedValue("tok"); });
afterEach(() => { server.resetHandlers(); vi.restoreAllMocks(); });
afterAll(() => server.close());

const page = (rows: unknown[]) => HttpResponse.json({ results: rows, next: null, previous: null });
const accounts = http.get("*/api/v1/crm/accounts", () => page([{ id: "acc-1111-2222", name: "Globex", industry: "", segment: "", owner_id: "u", is_active: true, credit_status: "OK", lifecycle_stage: "" }]));
const lead = (over = {}) => ({ id: "ld1", name: "Ada", company: "Initech", email: "ada@i.co", phone: "", status: "NEW", source: "web", owner_id: null, converted_opportunity: null, potential_value: null, currency: "", follow_up_date: null, ...over });
const opp = (over = {}) => ({ id: "op1", name: "Big deal", account: "acc-1111-2222", stage: "PROSPECTING", probability: 10, amount: "5000.0000", currency: "USD", status: "OPEN", expected_close: null, owner_id: "u", lost_reason: "", next_action: "", next_action_date: null, ...over });
const MANAGE = ["crm.view", "crm.manage"];

describe("leadSchema and flow", () => {
  it("validates", () => {
    expect(leadSchema.safeParse({ name: "A", company: "", email: "", phone: "", source: "" }).success).toBe(true);
    expect(leadSchema.safeParse({ name: "", company: "", email: "", phone: "", source: "" }).success).toBe(false);
    expect(leadSchema.safeParse({ name: "A", company: "", email: "bad", phone: "", source: "" }).success).toBe(false);
  });
  it("only allows forward moves", () => {
    expect(LEAD_FLOW.QUALIFIED).toEqual(["DISQUALIFIED"]);
    expect(LEAD_FLOW.CONVERTED).toBeUndefined();
  });
});

describe("LeadsPage", () => {
  it("hides management actions without crm.manage", async () => {
    server.use(http.get("*/api/v1/crm/leads", () => page([lead()])));
    renderWithProviders(<LeadsPage />, { permissions: ["crm.view"] });
    await screen.findByText("Ada");
    expect(screen.queryByRole("button", { name: "New lead" })).toBeNull();
    expect(screen.queryByRole("button", { name: /Qualify/ })).toBeNull();
  });

  it("offers only valid next steps per status", async () => {
    server.use(http.get("*/api/v1/crm/leads", () => page([lead({ id: "a", name: "NewOne" }), lead({ id: "b", name: "QualOne", status: "QUALIFIED" }), lead({ id: "c", name: "DoneOne", status: "CONVERTED" })])));
    renderWithProviders(<LeadsPage />, { permissions: MANAGE });
    await screen.findByText("QualOne");
    expect(screen.getByRole("button", { name: "Mark NewOne contacted" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Convert QualOne" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Convert NewOne" })).toBeNull();
    expect(screen.queryByRole("button", { name: /DoneOne/ })).toBeNull();
  });

  it("qualifies a lead and requires a reason to disqualify", async () => {
    const calls: any[] = [];
    server.use(http.get("*/api/v1/crm/leads", () => page([lead()])), http.post("*/api/v1/crm/leads/ld1/status", async ({ request }) => { calls.push(await request.json()); return HttpResponse.json(lead({ status: "QUALIFIED" })); }));
    renderWithProviders(<LeadsPage />, { permissions: MANAGE });
    await userEvent.click(await screen.findByRole("button", { name: "Qualify Ada" }));
    await waitFor(() => expect(calls).toEqual([{ status: "QUALIFIED", reason: "" }]));
    await userEvent.click(screen.getByRole("button", { name: "Disqualify Ada" }));
    await userEvent.click(screen.getByRole("button", { name: /^Disqualify$/ }));
    expect(await screen.findByText("A reason is required to disqualify a lead.")).toBeInTheDocument();
    expect(calls.length).toBe(1);
  });

  it("converts a qualified lead with a validated currency", async () => {
    let body: any;
    server.use(http.get("*/api/v1/crm/leads", () => page([lead({ status: "QUALIFIED" })])), http.post("*/api/v1/crm/leads/ld1/convert", async ({ request }) => { body = await request.json(); return HttpResponse.json({}, { status: 201 }); }));
    renderWithProviders(<LeadsPage />, { permissions: MANAGE });
    await userEvent.click(await screen.findByRole("button", { name: "Convert Ada" }));
    await userEvent.type(screen.getByLabelText("Expected amount"), "1200.50");
    await userEvent.click(screen.getByRole("button", { name: "Convert to opportunity" }));
    expect(await screen.findByText(/3-letter currency code/)).toBeInTheDocument();
    expect(body).toBeUndefined();
    await userEvent.type(screen.getByLabelText("Currency"), "usd");
    await userEvent.click(screen.getByRole("button", { name: "Convert to opportunity" }));
    await waitFor(() => expect(body).toEqual({ opportunity_name: "Initech opportunity", amount: "1200.50", currency: "USD" }));
  });

  it("creates a lead and maps server field errors", async () => {
    server.use(http.get("*/api/v1/crm/leads", () => page([])), http.post("*/api/v1/crm/leads", () => HttpResponse.json({ error: { code: "duplicate_lead", message: "Duplicate.", details: [{ field: "email", code: "duplicate", message: "A lead with this email exists" }] } }, { status: 409 })));
    renderWithProviders(<LeadsPage />, { permissions: MANAGE });
    await userEvent.click(await screen.findByRole("button", { name: "New lead" }));
    await userEvent.type(screen.getByLabelText("Contact name"), "Bob");
    await userEvent.type(screen.getByLabelText("Email"), "bob@x.co");
    await userEvent.click(document.querySelector("form button[type=submit]")!);
    expect(await screen.findByText("A lead with this email exists")).toBeInTheDocument();
  });
});

describe("OpportunitiesPage", () => {
  const stages = http.get("*/api/v1/crm/stages", () => HttpResponse.json([{ code: "PROSPECTING", name: "Prospecting", probability: 10, is_won: false, is_lost: false }, { code: "PROPOSAL", name: "Proposal", probability: 50, is_won: false, is_lost: false }, { code: "WON", name: "Won", probability: 100, is_won: true, is_lost: false }]));

  it("shows account names and defaults to open opportunities", async () => {
    let seen = "";
    server.use(accounts, http.get("*/api/v1/crm/opportunities", ({ request }) => { seen = new URL(request.url).search; return page([opp()]); }));
    renderWithProviders(<OpportunitiesPage />, { permissions: ["crm.view"] });
    expect(await screen.findByText("Globex")).toBeInTheDocument();
    expect(seen).toContain("status=OPEN");
    expect(screen.getByText("5,000.00 USD")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Update/ })).toBeNull();
  });

  it("moves the stage (excluding won/lost stages and the current one)", async () => {
    let body: any;
    server.use(accounts, stages, http.get("*/api/v1/crm/opportunities", () => page([opp()])), http.post("*/api/v1/crm/opportunities/op1/stage", async ({ request }) => { body = await request.json(); return HttpResponse.json(opp({ stage: "PROPOSAL" })); }));
    renderWithProviders(<OpportunitiesPage />, { permissions: MANAGE });
    await userEvent.click(await screen.findByRole("button", { name: "Update Big deal" }));
    await screen.findByRole("option", { name: "Proposal (50%)" });
    const names = Array.from((screen.getByLabelText("Move to stage") as HTMLSelectElement).options).map((o) => o.text);
    expect(names).toEqual(["Choose…", "Proposal (50%)"]);
    await userEvent.selectOptions(screen.getByLabelText("Move to stage"), "PROPOSAL");
    await userEvent.click(screen.getByRole("button", { name: "Move" }));
    await waitFor(() => expect(body).toEqual({ stage: "PROPOSAL" }));
  });

  it("requires a reason to mark lost, and wins without one", async () => {
    const hits: string[] = [];
    server.use(accounts, stages, http.get("*/api/v1/crm/opportunities", () => page([opp()])),
      http.post("*/api/v1/crm/opportunities/op1/lose", () => { hits.push("lose"); return HttpResponse.json(opp({ status: "LOST" })); }),
      http.post("*/api/v1/crm/opportunities/op1/win", () => { hits.push("win"); return HttpResponse.json(opp({ status: "WON" })); }));
    renderWithProviders(<OpportunitiesPage />, { permissions: MANAGE });
    await userEvent.click(await screen.findByRole("button", { name: "Update Big deal" }));
    await userEvent.click(screen.getByRole("button", { name: "Mark lost" }));
    expect(await screen.findByText("A reason is required to mark an opportunity lost.")).toBeInTheDocument();
    expect(hits).toEqual([]);
    await userEvent.click(screen.getByRole("button", { name: "Mark won" }));
    await waitFor(() => expect(hits).toEqual(["win"]));
  });
});

describe("quote and order action rules", () => {
  const all = () => true;
  it("quotations follow their state", () => {
    expect(quoteActions("DRAFT", all).map((a) => a.action)).toEqual(["send"]);
    expect(quoteActions("SENT", all).map((a) => a.action)).toEqual(["accept", "reject"]);
    expect(quoteActions("ACCEPTED", all).map((a) => a.action)).toEqual(["convert"]);
    expect(quoteActions("CONVERTED", all)).toEqual([]);
    expect(quoteActions("ACCEPTED", (p) => p === "sales.quote.create")).toEqual([]); // cannot convert without order permission
  });
  it("orders follow their state and permissions", () => {
    expect(orderActions("DRAFT", all).map((a) => a.action)).toEqual(["submit", "cancel"]);
    expect(orderActions("PENDING_APPROVAL", all).map((a) => a.action)).toEqual(["approve", "cancel"]);
    expect(orderActions("PENDING_APPROVAL", (p) => p === "sales.order.create").map((a) => a.action)).toEqual(["cancel"]);
    expect(orderActions("DELIVERED", all).map((a) => a.action)).toEqual(["invoice"]);
    expect(orderActions("CANCELLED", all)).toEqual([]);
  });
});

describe("QuotationsPage", () => {
  const quote = (status: string) => ({ id: "q1", number: "QT-1", account: "acc-1111-2222", currency: "USD", status, valid_until: "2026-12-31", subtotal: "100.0000", tax_total: "15.0000", total: "115.0000", version: 2, lines: [{ id: "l1", line_no: 1, product: null, description: "Widgets", quantity: "10.0000", unit_price: "10.0000", discount_percent: "0.0000", net_unit_price: "10.0000", line_total: "100.0000", tax_amount: "15.0000" }] });
  it("shows lines and converts an accepted quotation", async () => {
    let converted = false;
    server.use(accounts, http.get("*/api/v1/sales/quotations", () => page([quote("ACCEPTED")])), http.get("*/api/v1/sales/quotations/q1", () => HttpResponse.json(quote("ACCEPTED"))),
      http.post("*/api/v1/sales/quotations/q1/convert", () => { converted = true; return HttpResponse.json({ id: "o1" }, { status: 201 }); }));
    renderWithProviders(<QuotationsPage />, { permissions: ["sales.view", "sales.order.create"] });
    expect(await screen.findByText("Globex")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "QT-1" }));
    expect(await screen.findByText("Widgets")).toBeInTheDocument();
    expect(screen.getAllByText("115.00").length).toBeGreaterThan(0);
    await userEvent.click(screen.getByRole("button", { name: "Convert to order" }));
    await waitFor(() => expect(converted).toBe(true));
  });
  it("explains a pending discount approval", async () => {
    server.use(accounts, http.get("*/api/v1/sales/quotations", () => page([quote("PENDING_APPROVAL")])), http.get("*/api/v1/sales/quotations/q1", () => HttpResponse.json(quote("PENDING_APPROVAL"))));
    renderWithProviders(<QuotationsPage />, { permissions: ["sales.view"] });
    await userEvent.click(await screen.findByRole("button", { name: "QT-1" }));
    expect(await screen.findByText("Waiting for discount approval.")).toBeInTheDocument();
  });
});

describe("OrdersPage", () => {
  const order = (status: string) => ({ id: "o1", number: "SO-1", account: "acc-1111-2222", currency: "USD", order_date: "2026-03-01", status, subtotal: "100.0000", tax_total: "15.0000", total: "115.0000", approval_required: true, workflow_instance_id: null, version: 1, hold_reason: "", lines: [{ id: "l1", line_no: 1, product: null, description: "Widgets", quantity: "10.0000", unit_price: "10.0000", discount_percent: "0", net_unit_price: "10", line_total: "100.0000", tax_amount: "15.0000", delivered_quantity: "10.0000", invoiced_quantity: "0.0000" }] });
  it("shows delivered vs invoiced and creates an invoice", async () => {
    let invoiced = false;
    server.use(accounts, http.get("*/api/v1/sales/orders", () => page([order("DELIVERED")])), http.get("*/api/v1/sales/orders/o1", () => HttpResponse.json(order("DELIVERED"))), http.post("*/api/v1/sales/orders/o1/invoice", () => { invoiced = true; return HttpResponse.json({ id: "i1" }, { status: 201 }); }));
    renderWithProviders(<OrdersPage />, { permissions: ["sales.view", "sales.invoice.create"] });
    await userEvent.click(await screen.findByRole("button", { name: "SO-1" }));
    expect(await screen.findByText("Widgets")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Create invoice" }));
    await waitFor(() => expect(invoiced).toBe(true));
  });
  it("shows the server's refusal when approving", async () => {
    server.use(accounts, http.get("*/api/v1/sales/orders", () => page([order("PENDING_APPROVAL")])), http.get("*/api/v1/sales/orders/o1", () => HttpResponse.json(order("PENDING_APPROVAL"))),
      http.post("*/api/v1/sales/orders/o1/approve", () => HttpResponse.json({ error: { code: "separation_of_duties", message: "You cannot approve an order you created.", details: [] } }, { status: 403 })));
    renderWithProviders(<OrdersPage />, { permissions: ["sales.view", "sales.order.approve"] });
    await userEvent.click(await screen.findByRole("button", { name: "SO-1" }));
    await userEvent.click(await screen.findByRole("button", { name: "Approve" }));
    expect(await screen.findByText("You cannot approve an order you created.")).toBeInTheDocument();
  });
});
