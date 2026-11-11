import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";

import * as auth from "../../shared/auth/authService";
import { renderWithProviders } from "../../test/utils";
import { PurchaseOrdersPage } from "./PurchaseOrdersPage";
import { RequisitionsPage, requisitionSchema } from "./RequisitionsPage";
import { SuppliersPage, supplierSchema } from "./SuppliersPage";

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
beforeEach(() => { vi.spyOn(auth, "getAccessToken").mockResolvedValue("tok"); });
afterEach(() => { server.resetHandlers(); vi.restoreAllMocks(); });
afterAll(() => server.close());

const page = (rows: unknown[]) => HttpResponse.json({ results: rows, next: null, previous: null });
const supplier = (over = {}) => ({ id: "s1", name: "Globex", tax_id: "T1", email: "g@x.co", status: "PROSPECT", partner: null, qualified_at: null, ...over });

describe("schemas", () => {
  it("supplier: name required, email optional but valid", () => {
    expect(supplierSchema.safeParse({ name: "A", tax_id: "", email: "" }).success).toBe(true);
    expect(supplierSchema.safeParse({ name: "", tax_id: "", email: "" }).success).toBe(false);
    expect(supplierSchema.safeParse({ name: "A", tax_id: "", email: "nope" }).success).toBe(false);
  });
  it("requisition: needs a line with a positive quantity and a non-negative price", () => {
    const ok = { title: "Laptops", needed_by: "", lines: [{ description: "Laptop", quantity: "2", estimated_unit_price: "999.99" }] };
    expect(requisitionSchema.safeParse(ok).success).toBe(true);
    expect(requisitionSchema.safeParse({ ...ok, lines: [] }).success).toBe(false);
    expect(requisitionSchema.safeParse({ ...ok, lines: [{ ...ok.lines[0], quantity: "0" }] }).success).toBe(false);
    expect(requisitionSchema.safeParse({ ...ok, lines: [{ ...ok.lines[0], estimated_unit_price: "-1" }] }).success).toBe(false);
    expect(requisitionSchema.safeParse({ ...ok, lines: [{ ...ok.lines[0], quantity: "1e2" }] }).success).toBe(false);
  });
});

describe("SuppliersPage", () => {
  it("hides management actions without the permission", async () => {
    server.use(http.get("*/api/v1/procurement/suppliers", () => page([supplier()])));
    renderWithProviders(<SuppliersPage />, { permissions: ["procurement.view"] });
    await screen.findByText("Globex");
    expect(screen.queryByRole("button", { name: "New supplier" })).toBeNull();
    expect(screen.queryByRole("button", { name: /Qualify/ })).toBeNull();
  });

  it("qualifies a prospect with notes", async () => {
    let body: any;
    server.use(http.get("*/api/v1/procurement/suppliers", () => page([supplier()])), http.post("*/api/v1/procurement/suppliers/s1/qualify", async ({ request }) => { body = await request.json(); return HttpResponse.json(supplier({ status: "QUALIFIED" })); }));
    renderWithProviders(<SuppliersPage />, { permissions: ["procurement.view", "procurement.supplier.manage"] });
    await userEvent.click(await screen.findByRole("button", { name: "Qualify Globex" }));
    await userEvent.type(screen.getByLabelText("Notes (optional)"), "Audited");
    await userEvent.click(screen.getByRole("button", { name: "Qualify supplier" }));
    await waitFor(() => expect(body).toEqual({ notes: "Audited" }));
  });

  it("requires a reason to block", async () => {
    let called = false;
    server.use(http.get("*/api/v1/procurement/suppliers", () => page([supplier({ status: "QUALIFIED" })])), http.post("*/api/v1/procurement/suppliers/s1/block", () => { called = true; return HttpResponse.json(supplier()); }));
    renderWithProviders(<SuppliersPage />, { permissions: ["procurement.view", "procurement.supplier.manage"] });
    await userEvent.click(await screen.findByRole("button", { name: "Block Globex" }));
    await userEvent.click(screen.getByRole("button", { name: "Block supplier" }));
    expect(await screen.findByText("A reason is required to block a supplier.")).toBeInTheDocument();
    expect(called).toBe(false);
  });

  it("creates a supplier and maps server field errors", async () => {
    server.use(http.get("*/api/v1/procurement/suppliers", () => page([])), http.post("*/api/v1/procurement/suppliers", () => HttpResponse.json({ error: { code: "validation_error", message: "Invalid.", details: [{ field: "tax_id", code: "duplicate", message: "Tax ID already registered" }] } }, { status: 400 })));
    renderWithProviders(<SuppliersPage />, { permissions: ["procurement.view", "procurement.supplier.manage"] });
    await userEvent.click(await screen.findByRole("button", { name: "New supplier" }));
    await userEvent.type(screen.getByLabelText("Name"), "Initech");
    await userEvent.type(screen.getByLabelText("Tax ID"), "T9");
    await userEvent.click(document.querySelector("form button[type=submit]")!);
    expect(await screen.findByText("Tax ID already registered")).toBeInTheDocument();
  });
});

describe("RequisitionsPage", () => {
  const req = (over = {}) => ({ id: "r1", number: "PR-1", title: "Laptops", status: "DRAFT", requester_id: "u1", estimated_total: "200.0000", needed_by: null, workflow_instance_id: null, priority: null, lines: [{ id: "l1", line_no: 1, product: null, description: "Laptop", quantity: "2.0000", ordered_quantity: "0", estimated_unit_price: "100.0000" }], ...over });

  it("shows the exact estimated total while typing and submits decimal strings", async () => {
    let body: any;
    server.use(http.get("*/api/v1/procurement/requisitions", () => page([])), http.post("*/api/v1/procurement/requisitions", async ({ request }) => { body = await request.json(); return HttpResponse.json(req(), { status: 201 }); }));
    renderWithProviders(<RequisitionsPage />, { permissions: ["procurement.view", "procurement.requisition.create"] });
    await userEvent.click(await screen.findByRole("button", { name: "New requisition" }));
    await userEvent.type(screen.getByLabelText("Title"), "Laptops");
    await userEvent.type(screen.getByLabelText("Line 1 item"), "Laptop");
    await userEvent.clear(screen.getByLabelText("Line 1 quantity"));
    await userEvent.type(screen.getByLabelText("Line 1 quantity"), "3");
    await userEvent.clear(screen.getByLabelText("Line 1 price"));
    await userEvent.type(screen.getByLabelText("Line 1 price"), "19.99");
    expect(screen.getByText("Estimated total 59.97")).toBeInTheDocument();
    await userEvent.click(document.querySelector("form button[type=submit]")!);
    await waitFor(() => expect(body).toEqual({ title: "Laptops", needed_by: null, lines: [{ description: "Laptop", quantity: "3", estimated_unit_price: "19.99" }] }));
  });

  it("submits a draft, but offers approve only to approvers", async () => {
    let submitted = false;
    server.use(
      http.get("*/api/v1/procurement/requisitions", () => page([req()])),
      http.get("*/api/v1/procurement/requisitions/r1", () => HttpResponse.json(req())),
      http.post("*/api/v1/procurement/requisitions/r1/submit", () => { submitted = true; return HttpResponse.json(req({ status: "SUBMITTED" })); }),
    );
    renderWithProviders(<RequisitionsPage />, { permissions: ["procurement.view", "procurement.requisition.create"] });
    await userEvent.click(await screen.findByRole("button", { name: "PR-1" }));
    expect(await screen.findByText("Laptop")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Submit for approval" }));
    await waitFor(() => expect(submitted).toBe(true));
  });

  it("shows the approve button for an approver on a submitted requisition and surfaces refusals", async () => {
    server.use(
      http.get("*/api/v1/procurement/requisitions", () => page([req({ status: "SUBMITTED" })])),
      http.get("*/api/v1/procurement/requisitions/r1", () => HttpResponse.json(req({ status: "SUBMITTED" }))),
      http.post("*/api/v1/procurement/requisitions/r1/approve", () => HttpResponse.json({ error: { code: "separation_of_duties", message: "You cannot approve your own requisition.", details: [] } }, { status: 403 })),
    );
    renderWithProviders(<RequisitionsPage />, { permissions: ["procurement.view", "procurement.requisition.approve"] });
    await userEvent.click(await screen.findByRole("button", { name: "PR-1" }));
    await userEvent.click(await screen.findByRole("button", { name: "Approve" }));
    expect(await screen.findByText("You cannot approve your own requisition.")).toBeInTheDocument();
  });
});

describe("PurchaseOrdersPage", () => {
  const po = (status: string) => ({ id: "p1", number: "PO-7", supplier: { id: "s1", name: "Globex" }, currency: "USD", status, order_date: "2026-02-01", expected_date: null, total: "1500.0000", invoiced_value: "0.0000", version: 1, workflow_instance_id: null, contract: null, lines: [{ id: "l1", line_no: 1, product: null, description: "Chairs", quantity: "10.0000", unit_price: "150.0000", received_quantity: "4.0000" }] });

  it("shows ordered vs received and actions by state and permission", async () => {
    server.use(http.get("*/api/v1/procurement/purchase-orders", () => page([po("PENDING_APPROVAL")])), http.get("*/api/v1/procurement/purchase-orders/p1", () => HttpResponse.json(po("PENDING_APPROVAL"))));
    renderWithProviders(<PurchaseOrdersPage />, { permissions: ["procurement.view", "procurement.purchase_order.create"] });
    await userEvent.click(await screen.findByRole("button", { name: "PO-7" }));
    expect(await screen.findByText("Chairs")).toBeInTheDocument();
    expect(screen.getByText("4.00")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
    expect(screen.getByRole("button", { name: "Cancel order" })).toBeInTheDocument();
  });

  it("approves a pending order and filters by status", async () => {
    let approved = false; let seen = "";
    server.use(
      http.get("*/api/v1/procurement/purchase-orders", ({ request }) => { seen = new URL(request.url).search; return page([po("PENDING_APPROVAL")]); }),
      http.get("*/api/v1/procurement/purchase-orders/p1", () => HttpResponse.json(po("PENDING_APPROVAL"))),
      http.post("*/api/v1/procurement/purchase-orders/p1/approve", () => { approved = true; return HttpResponse.json(po("APPROVED")); }),
    );
    renderWithProviders(<PurchaseOrdersPage />, { permissions: ["procurement.view", "procurement.purchase_order.approve"] });
    await userEvent.selectOptions(await screen.findByLabelText("Status"), "APPROVED");
    await waitFor(() => expect(seen).toContain("status=APPROVED"));
    await userEvent.click(await screen.findByRole("button", { name: "PO-7" }));
    await userEvent.click(await screen.findByRole("button", { name: "Approve" }));
    await waitFor(() => expect(approved).toBe(true));
  });
});

import { buildReceipt } from "./PurchaseOrdersPage";

describe("receiving goods", () => {
  const order: any = { id: "p1", lines: [
    { id: "l1", line_no: 1, product: "prod", description: "Chairs", quantity: "10.0000", unit_price: "1", received_quantity: "4.0000" },
    { id: "l2", line_no: 2, product: null, description: "Installation", quantity: "1.0000", unit_price: "1", received_quantity: "0.0000" },
  ] };
  it("validates before sending", () => {
    expect(buildReceipt(order, "", { l1: "1" }, "")).toEqual({ error: "Choose the location the goods go to." });
    expect(buildReceipt(order, "loc", {}, "")).toMatchObject({ error: expect.stringContaining("at least one line") });
    expect(buildReceipt(order, "loc", { l1: "0" }, "")).toMatchObject({ error: expect.stringContaining("Line 1") });
    expect(buildReceipt(order, "loc", { l1: "1e1" }, "")).toMatchObject({ error: expect.stringContaining("Line 1") });
  });
  it("sends only lines with a quantity, and requires an acceptance note for service-only receipts", () => {
    expect(buildReceipt(order, "loc", { l1: "6" }, "")).toEqual({ lines: [{ po_line: "l1", quantity: "6" }] });
    expect(buildReceipt(order, "loc", { l2: "1" }, "")).toEqual({ error: "A service receipt needs an acceptance note." });
    expect(buildReceipt(order, "loc", { l2: "1" }, "Installed on site")).toEqual({ lines: [{ po_line: "l2", quantity: "1" }] });
  });

  it("receives against an approved order and shows server refusals (over-receipt)", async () => {
    let body: any;
    const po = { id: "p1", number: "PO-7", supplier: { id: "s1", name: "Globex" }, currency: "USD", status: "APPROVED", order_date: "2026-02-01", expected_date: null, total: "1500.0000", invoiced_value: "0.0000", version: 1, workflow_instance_id: null, contract: null, lines: order.lines };
    server.use(
      http.get("*/api/v1/procurement/purchase-orders", () => page([po])),
      http.get("*/api/v1/procurement/purchase-orders/p1", () => HttpResponse.json(po)),
      http.get("*/api/v1/inventory/warehouses", () => page([{ id: "w1", code: "MAIN", name: "Main", is_active: true, warehouse_type: "STANDARD", address: "", locations: [{ id: "loc1", code: "A1", kind: "BIN", zone: "", aisle: "", rack: "", shelf: "", bin: "", capacity: null, is_blocked: false }] }])),
      http.post("*/api/v1/procurement/purchase-orders/p1/receive", async ({ request }) => {
        body = await request.json();
        return body.lines[0].quantity === "99" ? HttpResponse.json({ error: { code: "over_receipt", message: "Over-receipt needs approval.", details: [] } }, { status: 409 }) : HttpResponse.json({ id: "g1", number: "GR-1" }, { status: 201 });
      }),
    );
    renderWithProviders(<PurchaseOrdersPage />, { permissions: ["procurement.view", "inventory.goods.receive"] });
    await userEvent.click(await screen.findByRole("button", { name: "PO-7" }));
    await userEvent.click(await screen.findByRole("button", { name: "Receive goods" }));
    await screen.findByRole("option", { name: "MAIN / A1" });
    await userEvent.selectOptions(screen.getByLabelText("Receive into"), "loc1");
    await userEvent.type(screen.getByLabelText(/Chairs/), "99");
    await userEvent.click(screen.getByRole("button", { name: "Confirm receipt" }));
    expect(await screen.findByText("Over-receipt needs approval.")).toBeInTheDocument();
    await userEvent.clear(screen.getByLabelText(/Chairs/));
    await userEvent.type(screen.getByLabelText(/Chairs/), "6");
    await userEvent.click(screen.getByRole("button", { name: "Confirm receipt" }));
    await waitFor(() => expect(body).toEqual({ location: "loc1", delivery_note: "", notes: "", lines: [{ po_line: "l1", quantity: "6" }] }));
  });
});
