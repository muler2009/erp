import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";

import * as auth from "../../shared/auth/authService";
import { renderWithProviders } from "../../test/utils";
import { AcquisitionCard, validateAcquisition, validateExtraCost } from "./AcquisitionCard";
import { AssetCustodyPage, validateAssignment, validateTransfer } from "./AssetCustodyPage";
import { CapitalizationsPage } from "./CapitalizationsPage";

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
beforeEach(() => vi.spyOn(auth, "getAccessToken").mockResolvedValue("tok"));
afterEach(() => { server.resetHandlers(); vi.restoreAllMocks(); });
afterAll(() => server.close());

const asg = (o = {}) => ({ id: "g1", number: "AG-1", asset: "FA-0001", assignee_type: "EMPLOYEE", assignee_id: "e1", project: "", kind: "PERMANENT", status: "REQUESTED", assigned_on: "2026-11-01", expected_return_on: null, returned_on: null, condition_out: "", condition_in: "", acknowledged: false, ...o });
const trf = (o = {}) => ({ id: "t1", number: "TR-1", asset: "FA-0001", status: "REQUESTED", reason: "Move", effective_date: "2026-11-05", from_location: "HQ", to_location: "BR", condition_out: "", condition_in: "", ...o });
const base = (assignments: unknown[] = [], transfers: unknown[] = []) => server.use(
  http.get("*/api/v1/assets/assignments", () => HttpResponse.json({ results: assignments })), http.get("*/api/v1/assets/transfers", () => HttpResponse.json({ results: transfers })),
  http.get("*/api/v1/assets/reports/custody", () => HttpResponse.json({ results: [], unreturned: [{ assignment: "AG-9", asset: "FA-0009", expected_return_on: "2026-10-01" }], unacknowledged: [] })),
  http.get("*/api/v1/assets/locations", () => HttpResponse.json({ results: [{ id: "l2", code: "BR", name: "Branch", parent: null, is_active: true }] })),
  http.get("*/api/v1/assets/assets", () => HttpResponse.json({ results: [{ id: "a1", number: "FA-0001", name: "Laptop", status: "AVAILABLE", category: { id: "c", code: "IT" } }] })),
  http.get("*/api/v1/org/departments", () => HttpResponse.json({ results: [] })), http.get("*/api/v1/hr/employees", () => HttpResponse.json({ results: [{ id: "e1", employee_no: "E-1", name: "Abel", status: "ACTIVE" }] })));

describe("validators", () => {
  it("assignment, transfer, acquisition, extra cost", () => {
    const ok = { asset: "a", type: "EMPLOYEE", assignee: "e", kind: "PERMANENT", assigned_on: "2026-11-01", expected_return_on: "" };
    expect(validateAssignment({ ...ok, asset: "" })).toMatch(/asset/);
    expect(validateAssignment({ ...ok, assignee: "" })).toMatch(/assignee/);
    expect(validateAssignment({ ...ok, type: "PROJECT", assignee: "" })).toMatch(/project/);
    expect(validateAssignment({ ...ok, kind: "TEMPORARY" })).toMatch(/return date/);
    expect(validateAssignment({ ...ok, kind: "TEMPORARY", expected_return_on: "2026-10-01" })).toMatch(/return date/);
    expect(validateAssignment({ ...ok, kind: "TEMPORARY", expected_return_on: "2026-12-01" })).toBeNull();
    const t = { asset: "a", reason: "r", effective_date: "2026-11-05", to_location: "l", to_department: "" };
    expect(validateTransfer({ ...t, reason: " " })).toMatch(/reason/);
    expect(validateTransfer({ ...t, to_location: "" })).toMatch(/destination/);
    expect(validateTransfer(t)).toBeNull();
    expect(validateAcquisition({ source: "X", cost: "5" })).toMatch(/how the asset/);
    expect(validateAcquisition({ source: "PURCHASE", cost: "0" })).toMatch(/greater than zero/);
    expect(validateAcquisition({ source: "PURCHASE", cost: "1500.50" })).toBeNull();
    expect(validateExtraCost({ kind: "FREIGHT", amount: "-1" })).toMatch(/greater than zero/); expect(validateExtraCost({ kind: "FREIGHT", amount: "20" })).toBeNull();
  });
});

describe("AssetCustodyPage", () => {
  it("approves a request only with approve permission and shows separation-of-duties refusals", async () => {
    base([asg()]);
    server.use(http.post("*/api/v1/assets/assignments/g1/approve", () => HttpResponse.json({ error: { code: "separation_of_duties", message: "Separation of duties: you cannot approve your own request." } }, { status: 403 })));
    const { unmount } = renderWithProviders(<AssetCustodyPage />, { permissions: ["assets.view"] });
    await screen.findByText(/AG-1/);
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
    unmount();
    renderWithProviders(<AssetCustodyPage />, { permissions: ["assets.view", "assets.custody.approve"] });
    await userEvent.click(await screen.findByRole("button", { name: "Approve" }));
    expect(await screen.findByText(/cannot approve your own request/)).toBeInTheDocument();
  });
  it("offers the next legal step per status and sends condition on handover", async () => {
    base([asg({ status: "APPROVED" })]);
    let sent: unknown;
    server.use(http.post("*/api/v1/assets/assignments/g1/handover", async ({ request }) => { sent = await request.json(); return HttpResponse.json(asg({ status: "ACTIVE" })); }));
    renderWithProviders(<AssetCustodyPage />, { permissions: ["assets.view", "assets.custody.manage"] });
    expect(screen.queryByRole("button", { name: "Record return" })).toBeNull();
    await userEvent.click(await screen.findByRole("button", { name: "Hand over" }));
    const d = within(screen.getByRole("dialog", { name: "Hand over asset" }));
    await userEvent.selectOptions(d.getByLabelText("Condition"), "GOOD");
    await userEvent.click(d.getByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(sent).toEqual({ condition: "GOOD", notes: "" }));
  });
  it("lets the assignee acknowledge an active assignment", async () => {
    base([asg({ status: "ACTIVE" })]);
    let hit = false;
    server.use(http.post("*/api/v1/assets/assignments/g1/acknowledge", () => { hit = true; return HttpResponse.json(asg({ status: "ACTIVE", acknowledged: true })); }));
    renderWithProviders(<AssetCustodyPage />, { permissions: ["assets.view", "assets.custody.acknowledge"] });
    await userEvent.click(await screen.findByRole("button", { name: "Acknowledge receipt" }));
    await waitFor(() => expect(hit).toBe(true));
  });
  it("blocks a temporary assignment without a return date, then requests it", async () => {
    base();
    let sent: unknown;
    server.use(http.post("*/api/v1/assets/assignments", async ({ request }) => { sent = await request.json(); return HttpResponse.json(asg(), { status: 201 }); }));
    renderWithProviders(<AssetCustodyPage />, { permissions: ["assets.view", "assets.custody.manage"] });
    await userEvent.click(await screen.findByRole("button", { name: "New assignment" }));
    const d = within(screen.getByRole("dialog", { name: "Assign an asset" }));
    await userEvent.selectOptions(await d.findByLabelText("Asset"), "a1");
    await userEvent.selectOptions(await d.findByLabelText("Assignee"), "e1");
    await userEvent.selectOptions(d.getByLabelText("Kind"), "TEMPORARY");
    await userEvent.click(d.getByRole("button", { name: "Request assignment" }));
    expect(await screen.findByText(/needs a return date/)).toBeInTheDocument();
    fireEvent.change(d.getByLabelText("Return by"), { target: { value: "2099-01-01" } });
    await userEvent.click(d.getByRole("button", { name: "Request assignment" }));
    await waitFor(() => expect(sent).toMatchObject({ asset: "a1", assignee_type: "EMPLOYEE", assignee_id: "e1", kind: "TEMPORARY", expected_return_on: "2099-01-01" }));
  });
  it("walks a transfer: approved can be dispatched, in transit can be received", async () => {
    base([], [trf({ status: "APPROVED" }), trf({ id: "t2", number: "TR-2", status: "IN_TRANSIT" })]);
    let received: unknown;
    server.use(http.post("*/api/v1/assets/transfers/t2/receive", async ({ request }) => { received = await request.json(); return HttpResponse.json(trf({ status: "COMPLETED" })); }));
    renderWithProviders(<AssetCustodyPage />, { permissions: ["assets.view", "assets.custody.manage", "assets.custody.acknowledge"] });
    expect(await screen.findByRole("button", { name: "Dispatch TR-1" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Receive TR-1" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Receive TR-2" }));
    const d = within(screen.getByRole("dialog", { name: "Receive TR-2" }));
    await userEvent.selectOptions(d.getByLabelText("Condition"), "FAIR");
    await userEvent.click(d.getByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(received).toEqual({ condition: "FAIR" }));
  });
  it("requires a destination for a new transfer and shows overdue returns", async () => {
    base();
    renderWithProviders(<AssetCustodyPage />, { permissions: ["assets.view", "assets.custody.manage"] });
    expect(await screen.findByText(/FA-0009 \(AG-9\) was due 2026-10-01/)).toBeInTheDocument();
    await userEvent.click(await screen.findByRole("button", { name: "New transfer" }));
    const d = within(screen.getByRole("dialog", { name: "New asset transfer" }));
    await userEvent.selectOptions(await d.findByLabelText("Asset"), "a1");
    await userEvent.type(d.getByLabelText("Reason"), "Relocate");
    fireEvent.change(d.getByLabelText("Effective date"), { target: { value: "2026-11-20" } });
    await userEvent.click(d.getByRole("button", { name: "Request transfer" }));
    expect(await screen.findByText(/destination location or department/)).toBeInTheDocument();
  });
});

describe("AcquisitionCard", () => {
  const acq = { asset: "FA-0001", source: "PURCHASE", cost: "1000.00", extra_costs: [{ kind: "FREIGHT", description: "", amount: "50.00" }], total_cost: "1050.00", delivered_on: null, accepted_on: "2026-11-02", commissioning_passed: true, commissioned_on: "2026-11-03" };
  it("offers to record an acquisition when none exists, with cost as a string", async () => {
    server.use(http.get("*/api/v1/assets/assets/a1/acquisition", () => HttpResponse.json({ error: { code: "acquisition_required", message: "Record the asset's acquisition first." } }, { status: 409 })));
    let sent: unknown;
    server.use(http.post("*/api/v1/assets/assets/a1/acquisition", async ({ request }) => { sent = await request.json(); return HttpResponse.json(acq, { status: 201 }); }));
    renderWithProviders(<AcquisitionCard id="a1" />, { permissions: ["assets.view", "assets.acquisition.manage"] });
    expect(await screen.findByText(/No acquisition has been recorded/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Record acquisition" }));
    const d = within(screen.getByRole("dialog", { name: "Record acquisition" }));
    await userEvent.selectOptions(d.getByLabelText("Source"), "PURCHASE"); await userEvent.type(d.getByLabelText("Cost"), "0");
    await userEvent.click(d.getByRole("button", { name: "Record" }));
    expect(await screen.findByText(/greater than zero/)).toBeInTheDocument();
    await userEvent.clear(d.getByLabelText("Cost")); await userEvent.type(d.getByLabelText("Cost"), "1000.00");
    await userEvent.click(d.getByRole("button", { name: "Record" }));
    await waitFor(() => expect(sent).toEqual({ source: "PURCHASE", cost: "1000.00" }));
  });
  it("shows totals and requests capitalisation once accepted; read-only users see no actions", async () => {
    server.use(http.get("*/api/v1/assets/assets/a1/acquisition", () => HttpResponse.json(acq)));
    let sent: unknown;
    server.use(http.post("*/api/v1/assets/assets/a1/acquisition/capitalize", async ({ request }) => { sent = await request.json(); return HttpResponse.json({}); }));
    const { unmount } = renderWithProviders(<AcquisitionCard id="a1" />, { permissions: ["assets.view"] });
    expect(await screen.findByText("Ready to capitalise")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Request capitalisation" })).toBeNull();
    unmount();
    renderWithProviders(<AcquisitionCard id="a1" />, { permissions: ["assets.view", "assets.acquisition.manage"] });
    expect(screen.queryByRole("button", { name: "Accept delivery" })).toBeNull();
    await userEvent.click(await screen.findByRole("button", { name: "Request capitalisation" }));
    const d = within(screen.getByRole("dialog", { name: "Request capitalisation" }));
    fireEvent.change(d.getByLabelText("Capitalisation date"), { target: { value: "2026-11-04" } });
    await userEvent.click(d.getByRole("button", { name: "Request" }));
    await waitFor(() => expect(sent).toEqual({ date: "2026-11-04" }));
  });
});

describe("CapitalizationsPage", () => {
  const req = { id: "r1", number: "CAP-1", asset: "FA-0001", status: "REQUESTED", capitalize: false, total_cost: "300.00", base_amount: "0.00", capitalization_date: "2026-11-04", decision_note: "" };
  it("flags below-threshold requests and gates approval", async () => {
    server.use(http.get("*/api/v1/assets/capitalizations", () => HttpResponse.json({ results: [req] })));
    const { unmount } = renderWithProviders(<CapitalizationsPage />, { permissions: ["assets.view"] });
    expect(await screen.findByText(/expensed, below the category threshold/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Approve CAP-1" })).toBeNull();
    unmount();
    let hit = false;
    server.use(http.post("*/api/v1/assets/capitalizations/r1/approve", () => { hit = true; return HttpResponse.json({ ...req, status: "APPROVED" }); }));
    renderWithProviders(<CapitalizationsPage />, { permissions: ["assets.view", "assets.capitalization.approve"] });
    await userEvent.click(await screen.findByRole("button", { name: "Approve CAP-1" }));
    await waitFor(() => expect(hit).toBe(true));
  });
});
