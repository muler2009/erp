import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";

import * as auth from "../../shared/auth/authService";
import { renderWithProviders } from "../../test/utils";
import { MaterialRequisitionsPage, requisitionInput, requisitionProblem, returnProblem, type MrDraft } from "./MaterialRequisitionsPage";

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
beforeEach(() => vi.spyOn(auth, "getAccessToken").mockResolvedValue("tok"));
afterEach(() => { server.resetHandlers(); vi.restoreAllMocks(); });
afterAll(() => server.close());

const prod = { id: "p1", sku: "CH-1", name: "Chain", uom: "pc", barcode: null, category: "", tracking: "NONE", is_stocked: true, is_active: true, on_hand: "5" };
const mk = (o: Partial<MrDraft> = {}): MrDraft => ({ warehouse: "w1", destination_type: "DEPARTMENT", destination_ref: "", purpose: "", needed_by: "", lines: [{ product: prod as never, quantity: "2" }], ...o });
const WH = { id: "w1", code: "MAIN", name: "Main", is_active: true, warehouse_type: "MAIN", address: "", locations: [{ id: "l1", code: "A1", kind: "STORAGE", zone: "", aisle: "", rack: "", shelf: "", bin: "", capacity: null, is_blocked: false }] };
const whs = http.get("*/api/v1/inventory/warehouses", () => HttpResponse.json({ results: [WH], next: null }));
const detail = (o = {}) => ({ id: "r1", number: "MR-1", status: "DRAFT", warehouse: "MAIN", destination_type: "DEPARTMENT", destination_ref: "", purpose: "Repairs", requester: "u1", approved_by: null, needed_by: null, lines: [{ id: "ln1", sku: "CH-1", quantity: "5.0000", issued: "0.0000", returned: "0.0000", backorder: "5.0000" }], vouchers: [], availability: [{ line: "ln1", sku: "CH-1", requested: "5", available: "3.0000" }], ...o });
const list = (rows: object[]) => http.get("*/api/v1/inventory/requisitions", () => HttpResponse.json({ results: rows, next: null }));
const lrow = (o = {}) => ({ id: "r1", number: "MR-1", status: "DRAFT", warehouse: "MAIN", destination_type: "DEPARTMENT", ...o });
const getD = (o = {}) => http.get("*/api/v1/inventory/requisitions/r1", () => HttpResponse.json(detail(o)));
const open = async () => userEvent.click(await screen.findByRole("button", { name: "Open MR-1" }));

describe("helpers", () => {
  it("requisitionProblem", () => {
    expect(requisitionProblem(mk())).toBeNull();
    expect(requisitionProblem(mk({ warehouse: "" }))).toMatch(/warehouse/);
    expect(requisitionProblem(mk({ destination_type: "PROJECT" }))).toMatch(/project/);
    expect(requisitionProblem(mk({ lines: [] }))).toMatch(/at least one/);
    expect(requisitionProblem(mk({ lines: [{ product: null, quantity: "1" }] }))).toMatch(/choose the item/);
    expect(requisitionProblem(mk({ lines: [{ product: prod as never, quantity: "0" }] }))).toMatch(/more than 0/);
    expect(requisitionProblem(mk({ lines: [{ product: prod as never, quantity: "1" }, { product: prod as never, quantity: "1" }] }))).toMatch(/only once/);
  });
  it("requisitionInput and returnProblem", () => {
    expect(requisitionInput(mk({ needed_by: "2026-12-01" }))).toMatchObject({ warehouse: "w1", needed_by: "2026-12-01", lines: [{ product: "p1", quantity: "2" }] });
    expect(returnProblem("2", "l1", "unused", 3)).toBeNull();
    expect(returnProblem("x", "l1", "r", 3)).toMatch(/quantity/);
    expect(returnProblem("5", "l1", "r", 3)).toMatch(/Only 3/);
    expect(returnProblem("1", "", "r", 3)).toMatch(/location/);
    expect(returnProblem("1", "l1", " ", 3)).toMatch(/reason/);
  });
});

describe("MaterialRequisitionsPage", () => {
  it("empty state, and no New button without create permission", async () => {
    server.use(list([]));
    renderWithProviders(<MaterialRequisitionsPage />, { permissions: ["inventory.view"] });
    expect(await screen.findByText("No requisitions")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "New requisition" })).toBeNull();
  });

  it("creates a requisition", async () => {
    let body: unknown = null;
    server.use(list([]), whs, http.get("*/api/v1/inventory/products", () => HttpResponse.json({ results: [prod], next: null })),
      http.post("*/api/v1/inventory/requisitions", async ({ request }) => { body = await request.json(); return HttpResponse.json(detail(), { status: 201 }); }));
    renderWithProviders(<MaterialRequisitionsPage />, { permissions: ["inventory.view", "inventory.requisition.create"] });
    await userEvent.click(await screen.findByRole("button", { name: "New requisition" }));
    await userEvent.click(await screen.findByRole("button", { name: "Create requisition" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/warehouse/);
    await userEvent.selectOptions(await screen.findByLabelText("Take from warehouse"), "w1");
    await userEvent.type(screen.getByRole("combobox", { name: "Item 1" }), "ch");
    await userEvent.click(await screen.findByRole("button", { name: /CH-1/ }));
    await userEvent.clear(screen.getByLabelText("Quantity 1"));
    await userEvent.type(screen.getByLabelText("Quantity 1"), "4");
    await userEvent.click(screen.getByRole("button", { name: "Create requisition" }));
    await waitFor(() => expect(body).toMatchObject({ warehouse: "w1", destination_type: "DEPARTMENT", lines: [{ product: "p1", quantity: "4" }] }));
  });

  it("submits a draft for approval", async () => {
    let hit = false;
    server.use(list([lrow()]), getD(), whs, http.post("*/api/v1/inventory/requisitions/r1/submit", () => { hit = true; return HttpResponse.json(detail({ status: "SUBMITTED" })); }));
    renderWithProviders(<MaterialRequisitionsPage />, { permissions: ["inventory.view", "inventory.requisition.create"] });
    await open();
    expect(await screen.findByText("3.00")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Submit for approval" }));
    await waitFor(() => expect(hit).toBe(true));
  });

  it("approver can approve but not a plain requester; reject needs a reason", async () => {
    let body: unknown = null;
    server.use(list([lrow({ status: "SUBMITTED" })]), getD({ status: "SUBMITTED" }), whs, http.post("*/api/v1/inventory/requisitions/r1/reject", async ({ request }) => { body = await request.json(); return HttpResponse.json(detail({ status: "REJECTED" })); }));
    const v = renderWithProviders(<MaterialRequisitionsPage />, { permissions: ["inventory.view", "inventory.requisition.create"] });
    await open();
    await screen.findByText("Requisition MR-1");
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
    v.unmount();
    renderWithProviders(<MaterialRequisitionsPage />, { permissions: ["inventory.view", "inventory.requisition.approve"] });
    await open();
    await userEvent.click(await screen.findByRole("button", { name: "Reject" }));
    await screen.findByLabelText("Reason");
    await userEvent.click(screen.getAllByRole("button", { name: "Reject" }).at(-1)!);
    expect(await screen.findByText("Give a reason for rejecting.")).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText("Reason"), "Not needed");
    await userEvent.click(screen.getAllByRole("button", { name: "Reject" }).at(-1)!);
    await waitFor(() => expect(body).toEqual({ note: "Not needed" }));
  });

  it("issues items from a location of the requisition's warehouse", async () => {
    let body: unknown = null;
    server.use(list([lrow({ status: "APPROVED" })]), getD({ status: "APPROVED" }), whs, http.post("*/api/v1/inventory/requisitions/r1/issue", async ({ request }) => { body = await request.json(); return HttpResponse.json(detail({ status: "ISSUED" })); }));
    renderWithProviders(<MaterialRequisitionsPage />, { permissions: ["inventory.view", "inventory.stock.issue"] });
    await open();
    await userEvent.click(await screen.findByRole("button", { name: "Issue items" }));
    await userEvent.click(await screen.findByRole("button", { name: "Issue everything available" }));
    expect(await screen.findByText("Choose the location to issue from.")).toBeInTheDocument();
    await userEvent.selectOptions(screen.getByLabelText("Issue from location"), "l1");
    await userEvent.type(screen.getByLabelText("Received by"), "Sam");
    await userEvent.click(screen.getByRole("button", { name: "Issue everything available" }));
    await waitFor(() => expect(body).toEqual({ location: "l1", received_by: "Sam", notes: "" }));
  });

  it("returns issued items, limited to what is still out", async () => {
    let body: unknown = null;
    const vouchers = [{ id: "v1", number: "IV-1", lines: [{ id: "vl1", sku: "CH-1", quantity: "5.0000", unit_cost: "10", returned: "2.0000" }] }];
    server.use(list([lrow({ status: "PARTIALLY_ISSUED" })]), getD({ status: "PARTIALLY_ISSUED", vouchers }), whs, http.post("*/api/v1/inventory/requisitions/r1/return", async ({ request }) => { body = await request.json(); return HttpResponse.json(detail()); }));
    renderWithProviders(<MaterialRequisitionsPage />, { permissions: ["inventory.view", "inventory.stock.issue"] });
    await open();
    await userEvent.click(await screen.findByRole("button", { name: "Return CH-1" }));
    await userEvent.type(await screen.findByLabelText("Quantity"), "9");
    await userEvent.selectOptions(screen.getByLabelText("Return to location"), "l1");
    await userEvent.type(screen.getByLabelText("Reason"), "Unused");
    await userEvent.click(screen.getByRole("button", { name: "Return to stock" }));
    expect(await screen.findByText("Only 3 can still be returned.")).toBeInTheDocument();
    await userEvent.clear(screen.getByLabelText("Quantity"));
    await userEvent.type(screen.getByLabelText("Quantity"), "3");
    await userEvent.click(screen.getByRole("button", { name: "Return to stock" }));
    await waitFor(() => expect(body).toEqual({ voucher_line: "vl1", quantity: "3", location: "l1", reason: "Unused" }));
  });
});
