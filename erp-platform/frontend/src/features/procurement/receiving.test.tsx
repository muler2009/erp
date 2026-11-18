import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";

import * as auth from "../../shared/auth/authService";
import { renderWithProviders } from "../../test/utils";
import { ReceivingPage, inspectionProblem } from "./ReceivingPage";

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
beforeEach(() => vi.spyOn(auth, "getAccessToken").mockResolvedValue("tok"));
afterEach(() => { server.resetHandlers(); vi.restoreAllMocks(); });
afterAll(() => server.close());

const PEND = { line: "l1", receipt: "GR-1", po: "PO-1", product: "SKU-1", quantity: "10.0000", open: "10.0000", quarantine: "QRN" };
const RECEIPT = { id: "r1", number: "GR-1", po: "PO-1", kind: "STANDARD", receipt_date: "2026-11-10", delivery_note: "DN-9", notes: "", lines: [{ id: "l1", po_line: "pl1", quantity: "10.0000", over_quantity: "1.0000", inspection_status: "PARTIAL", accepted: "4.0000", rejected: "2.0000", lot_code: "L7" }] };

describe("inspectionProblem", () => {
  it("checks quantities and the rejection reason", () => {
    expect(inspectionProblem("10", "10", "", "")).toBeNull();
    expect(inspectionProblem("10", "x", "", "")).toMatch(/numbers/);
    expect(inspectionProblem("10", "", "", "")).toMatch(/at least some/);
    expect(inspectionProblem("10", "8", "3", "bad")).toMatch(/Only 10/);
    expect(inspectionProblem("10", "5", "2", " ")).toMatch(/why/);
    expect(inspectionProblem("10", "5", "2", "cracked")).toBeNull();
  });
});

describe("ReceivingPage", () => {
  it("lists goods waiting for inspection and records a rejection", async () => {
    let body: Record<string, unknown> | null = null;
    server.use(http.get("*/api/v1/procurement/inspections", () => HttpResponse.json({ results: [PEND] })),
      http.post("*/api/v1/procurement/inspections/l1", async ({ request }) => { body = (await request.json()) as Record<string, unknown>; return HttpResponse.json({ inspection_status: "COMPLETE", accepted: "6", rejected: "4" }); }));
    renderWithProviders(<ReceivingPage />, { permissions: ["procurement.view", "procurement.receipt.inspect"] });
    await userEvent.click(await screen.findByRole("button", { name: "Inspect GR-1 SKU-1" }));
    const d = await screen.findByRole("dialog");
    await userEvent.clear(within(d).getByLabelText("Accept"));
    await userEvent.type(within(d).getByLabelText("Accept"), "6");
    await userEvent.type(within(d).getByLabelText("Reject"), "4");
    await userEvent.click(within(d).getByRole("button", { name: "Record inspection" }));
    expect(await within(d).findByRole("alert")).toHaveTextContent("Say why");
    await userEvent.type(within(d).getByLabelText(/^Note/), "Cracked");
    await userEvent.click(within(d).getByRole("button", { name: "Record inspection" }));
    await waitFor(() => expect(body).toEqual({ accept: "6", reject: "4", note: "Cracked" }));
  });
  it("sends serial numbers and refuses mixing them with a split", async () => {
    let body: Record<string, unknown> | null = null;
    server.use(http.get("*/api/v1/procurement/inspections", () => HttpResponse.json({ results: [PEND] })),
      http.post("*/api/v1/procurement/inspections/l1", async ({ request }) => { body = (await request.json()) as Record<string, unknown>; return HttpResponse.json({ inspection_status: "COMPLETE", accepted: "2", rejected: "0" }); }));
    renderWithProviders(<ReceivingPage />, { permissions: ["procurement.view", "procurement.receipt.inspect"] });
    await userEvent.click(await screen.findByRole("button", { name: "Inspect GR-1 SKU-1" }));
    const d = await screen.findByRole("dialog");
    await userEvent.clear(within(d).getByLabelText("Accept"));
    await userEvent.type(within(d).getByLabelText("Accept"), "2");
    await userEvent.type(within(d).getByLabelText("Reject"), "1");
    await userEvent.type(within(d).getByLabelText(/Note/), "x");
    await userEvent.type(within(d).getByLabelText(/Serial numbers/), "A1{enter}A2");
    await userEvent.click(within(d).getByRole("button", { name: "Record inspection" }));
    expect(await within(d).findByRole("alert")).toHaveTextContent("separate accept and reject");
    await userEvent.clear(within(d).getByLabelText("Reject"));
    await userEvent.click(within(d).getByRole("button", { name: "Record inspection" }));
    await waitFor(() => expect(body).toMatchObject({ accept: "2", reject: "0", serials: ["A1", "A2"] }));
  });
  it("tells a user without inspection permission, and shows receipts with evidence upload", async () => {
    let size = 0;
    server.use(http.get("*/api/v1/procurement/receipts", () => HttpResponse.json({ results: [RECEIPT] })),
      http.post("*/api/v1/procurement/receipts/r1/evidence", async ({ request }) => { size = ((await request.formData()).get("file") as File).size; return HttpResponse.json({ file_id: "f1", name: "photo.png" }, { status: 201 }); }));
    renderWithProviders(<ReceivingPage />, { permissions: ["procurement.view", "inventory.goods.receive"] });
    expect(screen.getByText(/do not have permission to inspect/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("tab", { name: "Receipts" }));
    expect(await screen.findByText("Partly inspected")).toBeInTheDocument();
    expect(screen.getByText("2 rejected")).toBeInTheDocument();
    expect(screen.getByText(/1 over the order/)).toBeInTheDocument();
    await userEvent.upload(screen.getByLabelText("Evidence file"), new File(["hello"], "photo.png", { type: "image/png" }));
    // no target chosen yet, so nothing is sent
    expect(size).toBe(0);
    await userEvent.click(screen.getByRole("button", { name: "Attach evidence to GR-1" }));
    await userEvent.upload(screen.getByLabelText("Evidence file"), new File(["hello"], "photo.png", { type: "image/png" }));
    expect(await screen.findByText("Attached photo.png.")).toBeInTheDocument();
    expect(size).toBe(5);
  });
  it("hides evidence upload without the receive permission", async () => {
    server.use(http.get("*/api/v1/procurement/receipts", () => HttpResponse.json({ results: [RECEIPT] })));
    renderWithProviders(<ReceivingPage />, { permissions: ["procurement.view"] });
    await userEvent.click(screen.getByRole("tab", { name: "Receipts" }));
    expect(await screen.findByText(/DN-9/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Attach evidence/ })).toBeNull();
  });
});
