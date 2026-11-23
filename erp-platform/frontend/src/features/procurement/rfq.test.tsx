import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { Route, Routes } from "react-router";

import * as auth from "../../shared/auth/authService";
import { renderWithProviders } from "../../test/utils";
import { RfqDetailPage, validateQuotation } from "./RfqDetailPage";
import { RfqsPage, buildRfqInput, validateRfq } from "./RfqsPage";

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
beforeEach(() => { vi.spyOn(auth, "getAccessToken").mockResolvedValue("tok"); server.use(http.get("*/api/v1/procurement/rfqs/:id/clarifications", () => HttpResponse.json({ results: [] }))); });
afterEach(() => { server.resetHandlers(); vi.restoreAllMocks(); });
afterAll(() => server.close());

const page = (rows: unknown[]) => HttpResponse.json({ results: rows, next: null, previous: null });

describe("validateRfq / buildRfqInput", () => {
  const line = { product: null, description: "Bolts", quantity: "10" };
  const ok = { title: "T", suppliers: ["s1"], source: "manual" as const, requisition: "", lines: [line] };
  it("accepts a complete manual RFQ and builds the payload", () => {
    expect(validateRfq(ok)).toBeNull();
    expect(buildRfqInput({ ...ok, due: "2026-12-01" })).toEqual({ title: "T", suppliers: ["s1"], due_date: "2026-12-01", lines: [{ description: "Bolts", quantity: "10" }] });
  });
  it("needs a title, suppliers, a requisition when sourcing one, and valid lines", () => {
    expect(validateRfq({ ...ok, title: " " })).toMatch(/title/);
    expect(validateRfq({ ...ok, suppliers: [] })).toMatch(/supplier/);
    expect(validateRfq({ ...ok, source: "requisition" })).toMatch(/requisition/);
    expect(validateRfq({ ...ok, source: "requisition", requisition: "r1" })).toBeNull();
    expect(validateRfq({ ...ok, lines: [{ ...line, description: "" }] })).toMatch(/Line 1/);
    expect(validateRfq({ ...ok, lines: [{ ...line, quantity: "0" }] })).toMatch(/quantity/);
    expect(buildRfqInput({ ...ok, due: "", source: "requisition", requisition: "r1" })).toEqual({ title: "T", suppliers: ["s1"], requisition: "r1" });
  });
});

describe("validateQuotation", () => {
  const ok = { supplier: "s", currency: "usd", lead: "7", prices: { a: "1.5", b: "0" } };
  it("accepts complete prices and rejects gaps, negatives and bad currency or lead time", () => {
    expect(validateQuotation(ok, ["a", "b"])).toBeNull();
    expect(validateQuotation({ ...ok, prices: { a: "1.5" } }, ["a", "b"])).toMatch(/every line/);
    expect(validateQuotation({ ...ok, prices: { a: "-1", b: "1" } }, ["a", "b"])).toMatch(/every line/);
    expect(validateQuotation({ ...ok, currency: "US" }, ["a"])).toMatch(/currency/);
    expect(validateQuotation({ ...ok, lead: "1.5" }, ["a"])).toMatch(/whole number/);
    expect(validateQuotation({ ...ok, supplier: "" }, ["a"])).toMatch(/supplier/);
  });
});

describe("RfqsPage", () => {
  it("lists RFQs and creates one from entered lines", async () => {
    server.use(
      http.get("*/api/v1/procurement/rfqs", () => page([{ id: "r1", number: "RFQ-1", title: "Bolts", kind: "RFQ", status: "OPEN", due_date: null, requisition: null }])),
      http.get("*/api/v1/procurement/suppliers", () => page([{ id: "s1", name: "Acme Supply", tax_id: "", email: "", status: "QUALIFIED", partner: null, qualified_at: null }])),
      http.get("*/api/v1/procurement/requisitions", () => page([])),
    );
    let body: any = null;
    server.use(http.post("*/api/v1/procurement/rfqs", async ({ request }) => { body = await request.json(); return HttpResponse.json({ id: "r2", number: "RFQ-2" }, { status: 201 }); }));
    renderWithProviders(<RfqsPage />, { permissions: ["procurement.view", "procurement.rfq.manage"] });
    expect(await screen.findByText("RFQ-1")).toBeInTheDocument();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "New RFQ" }));
    await user.click(await screen.findByRole("button", { name: "Create RFQ" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/title/);
    await user.type(screen.getByLabelText("Title"), "Fasteners");
    await user.click(await screen.findByLabelText("Acme Supply"));
    await user.type(screen.getByLabelText("Line 1 description"), "M8 bolts");
    await user.clear(screen.getByLabelText("Line 1 quantity")); await user.type(screen.getByLabelText("Line 1 quantity"), "250");
    await user.click(screen.getByRole("button", { name: "Create RFQ" }));
    await waitFor(() => expect(body).not.toBeNull());
    expect(body).toEqual({ title: "Fasteners", suppliers: ["s1"], lines: [{ description: "M8 bolts", quantity: "250" }] });
  });
  it("hides New RFQ without the manage permission", async () => {
    server.use(http.get("*/api/v1/procurement/rfqs", () => page([])));
    renderWithProviders(<RfqsPage />, { permissions: ["procurement.view"] });
    await screen.findByText("No RFQs yet");
    expect(screen.queryByRole("button", { name: "New RFQ" })).toBeNull();
  });
});

describe("RfqDetailPage", () => {
  const rfq = (o: object = {}) => ({
    id: "r1", number: "RFQ-1", title: "Bolts", kind: "RFQ", status: "OPEN", due_date: null, requisition: null, closing_at: null, open_to_all: false,
    suppliers: [{ id: "s1", name: "Acme" }, { id: "s2", name: "Bolt Co" }, { id: "s3", name: "Late Co" }],
    lines: [{ id: "l1", line_no: 1, description: "M8 bolts", quantity: "10.0000", product: null }],
    sealed: false, quotation_count: 2,
    quotations: [
      { id: "q1", supplier: { id: "s1", name: "Acme" }, currency: "USD", lead_time_days: 7, disqualified: false, disqualification_reason: "", is_awarded: false, prices: { l1: "12.0000" } },
      { id: "q2", supplier: { id: "s2", name: "Bolt Co" }, currency: "USD", lead_time_days: 3, disqualified: false, disqualification_reason: "", is_awarded: false, prices: { l1: "10.0000" } },
    ], ...o,
  });
  const cmp = { rfq: "RFQ-1", quotations: [{ quotation: "q2", supplier: "Bolt Co", total_base: "100.00", lead_time_days: 3 }, { quotation: "q1", supplier: "Acme", total_base: "120.00", lead_time_days: 7 }], best_per_line: { l1: { supplier: "Bolt Co", quotation: "q2", base_unit_price: "10.0000" } }, lowest_total: "q2" };
  const view = (perms: string[]) => renderWithProviders(<Routes><Route path="/app/procurement/rfqs/:id" element={<RfqDetailPage />} /></Routes>, { permissions: perms, route: "/app/procurement/rfqs/r1" });

  it("shows the comparison with the lowest bid marked", async () => {
    server.use(http.get("*/api/v1/procurement/rfqs/r1", () => HttpResponse.json(rfq())), http.get("*/api/v1/procurement/rfqs/r1/comparison", () => HttpResponse.json(cmp)));
    view(["procurement.view"]);
    expect(await screen.findByText("M8 bolts")).toBeInTheDocument();
    await screen.findByText("Lowest");
    expect(screen.getByText("Total in company currency").closest("tr")).toHaveTextContent("100.00");
    expect(screen.queryByRole("button", { name: /^Award/ })).toBeNull();
  });

  it("requires a justification to award a bid that is not the lowest, and sends it", async () => {
    server.use(http.get("*/api/v1/procurement/rfqs/r1", () => HttpResponse.json(rfq())), http.get("*/api/v1/procurement/rfqs/r1/comparison", () => HttpResponse.json(cmp)));
    let body: any = null;
    server.use(http.post("*/api/v1/procurement/rfqs/r1/award-justified", async ({ request }) => { body = await request.json(); return HttpResponse.json({ po: "p1", number: "PO-1" }, { status: 201 }); }));
    view(["procurement.view", "procurement.tender.award"]);
    const user = userEvent.setup();
    await screen.findByText("Lowest");
    await user.click(screen.getByRole("button", { name: "Award Acme" }));
    const dlg = await screen.findByRole("dialog", { name: "Award to Acme" });
    await user.click(within(dlg).getByRole("button", { name: "Award and create order" }));
    expect(await within(dlg).findByRole("alert")).toHaveTextContent(/justification is required/);
    expect(body).toBeNull();
    await user.type(within(dlg).getByLabelText(/Justification/), "Only supplier meeting the spec");
    await user.click(within(dlg).getByRole("button", { name: "Award and create order" }));
    await waitFor(() => expect(body).toEqual({ quotation: "q1", justification: "Only supplier meeting the spec" }));
  });

  it("awards the lowest bid without a justification and shows server refusals", async () => {
    server.use(
      http.get("*/api/v1/procurement/rfqs/r1", () => HttpResponse.json(rfq())), http.get("*/api/v1/procurement/rfqs/r1/comparison", () => HttpResponse.json(cmp)),
      http.post("*/api/v1/procurement/rfqs/r1/award-justified", () => HttpResponse.json({ error: { code: "disqualified", message: "A disqualified bid cannot be awarded.", details: [] } }, { status: 409 })),
    );
    view(["procurement.view", "procurement.tender.award"]);
    const user = userEvent.setup();
    await screen.findByText("Lowest");
    await user.click(screen.getByRole("button", { name: "Award Bolt Co" }));
    await user.click(await screen.findByRole("button", { name: "Award and create order" }));
    expect(await screen.findByText(/disqualified bid cannot be awarded/)).toBeInTheDocument();
  });

  it("records a quotation for an invited supplier that has not quoted yet", async () => {
    server.use(http.get("*/api/v1/procurement/rfqs/r1", () => HttpResponse.json(rfq())), http.get("*/api/v1/procurement/rfqs/r1/comparison", () => HttpResponse.json(cmp)));
    let body: any = null;
    server.use(http.post("*/api/v1/procurement/rfqs/r1/quotations", async ({ request }) => { body = await request.json(); return HttpResponse.json({ id: "q3" }, { status: 201 }); }));
    view(["procurement.view", "procurement.rfq.manage"]);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Record quotation" }));
    const supplier = screen.getByLabelText("Supplier");
    expect(within(supplier).queryByRole("option", { name: "Acme" })).toBeNull();
    await user.selectOptions(supplier, "s3");
    await user.click(screen.getByRole("button", { name: "Save quotation" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/every line/);
    await user.type(screen.getByLabelText(/Unit price: M8 bolts/), "9.75");
    await user.click(screen.getByRole("button", { name: "Save quotation" }));
    await waitFor(() => expect(body).toEqual({ supplier: "s3", currency: "USD", lead_time_days: 0, prices: { l1: "9.75" } }));
  });

  it("keeps sealed tender bids hidden and offers no actions on an awarded RFQ", async () => {
    server.use(http.get("*/api/v1/procurement/rfqs/r1", () => HttpResponse.json(rfq({ kind: "TENDER", sealed: true, quotations: [], quotation_count: 3 }))));
    const first = view(["procurement.view", "procurement.rfq.manage", "procurement.tender.award"]);
    expect(await screen.findByText(/sealed until the tender committee/)).toBeInTheDocument();
    expect(screen.getByText(/3 quotation\(s\) received/)).toBeInTheDocument();
    first.unmount();
    server.use(http.get("*/api/v1/procurement/rfqs/r1", () => HttpResponse.json(rfq({ status: "AWARDED" }))), http.get("*/api/v1/procurement/rfqs/r1/comparison", () => HttpResponse.json(cmp)));
    view(["procurement.view", "procurement.rfq.manage", "procurement.tender.award"]);
    await screen.findByText("Lowest");
    expect(screen.queryByRole("button", { name: /^Award|Record quotation/ })).toBeNull();
  });
});
