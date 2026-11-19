import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";

import * as auth from "../../shared/auth/authService";
import { renderWithProviders } from "../../test/utils";
import { RequisitionsPage } from "./RequisitionsPage";
import { ConsolidateDialog, GenerateButton, RequisitionExtras, recurrenceText } from "./RequisitionExtras";

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
beforeEach(() => vi.spyOn(auth, "getAccessToken").mockResolvedValue("tok"));
afterEach(() => { server.resetHandlers(); vi.restoreAllMocks(); });
afterAll(() => server.close());

const page = (rows: object[]) => HttpResponse.json({ results: rows, next: null, previous: null });
const req = (o = {}) => ({ id: "r1", number: "REQ-1", title: "Office", status: "APPROVED", requester_id: "u1", estimated_total: "100", needed_by: null, workflow_instance_id: null, priority: "NORMAL", source: "MANUAL", recurring_every_days: null, project_ref: "", cost_center_ref: "", lines: [], ...o });
const MGR = ["procurement.view", "procurement.requisition.create", "procurement.rfq.manage"];

describe("recurrenceText", () => {
  it("words the interval", () => {
    expect(recurrenceText(null)).toBeNull();
    expect(recurrenceText(1)).toBe("Repeats every day");
    expect(recurrenceText(30)).toBe("Repeats every 30 days");
  });
});

describe("GenerateButton", () => {
  it("reports the draft created, or that nothing needs ordering", async () => {
    let n = 0;
    server.use(http.post("*/api/v1/procurement/requisitions/generate", () => (++n === 1 ? HttpResponse.json({ id: "r9", number: "REQ-9" }, { status: 201 }) : HttpResponse.json({ id: null, number: null }))));
    renderWithProviders(<GenerateButton />, { permissions: MGR });
    await userEvent.click(screen.getByRole("button", { name: "Generate replenishment" }));
    expect(await screen.findByText(/Created draft REQ-9/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Generate replenishment" }));
    expect(await screen.findByText("Nothing needs reordering right now.")).toBeInTheDocument();
  });
});

describe("RequisitionExtras", () => {
  it("checks stock and gives advice per line", async () => {
    server.use(http.get("*/api/v1/procurement/requisitions/r1/stock-check", () => HttpResponse.json({ results: [
      { line: 1, description: "Widget", stock_item: true, needed: "10.0000", available: "12.0000", recommendation: "ISSUE_FROM_STOCK", shortfall: "0" },
      { line: 2, description: "Bolt", stock_item: true, needed: "10.0000", available: "4.0000", recommendation: "PARTIAL_FROM_STOCK", shortfall: "6" },
      { line: 3, description: "Consulting", stock_item: false, recommendation: "PURCHASE" }] })));
    renderWithProviders(<RequisitionExtras req={req() as never} />, { permissions: MGR });
    await userEvent.click(screen.getByRole("button", { name: "Check stock" }));
    expect(await screen.findByText(/Widget — need 10, 12 available/)).toBeInTheDocument();
    expect(screen.getByText("Enough in stock — issue instead of buying")).toBeInTheDocument();
    expect(screen.getByText("Part in stock — buy the shortfall")).toBeInTheDocument();
    expect(screen.getByText("Consulting")).toBeInTheDocument();
  });
  it("shows flags and stops a recurring requisition", async () => {
    let hit = false;
    server.use(http.delete("*/api/v1/procurement/requisitions/r1/recurring", () => { hit = true; return new HttpResponse(null, { status: 204 }); }));
    renderWithProviders(<RequisitionExtras req={req({ priority: "EMERGENCY", recurring_every_days: 30, project_ref: "PRJ-1", source: "REORDER" }) as never} />, { permissions: MGR });
    expect(screen.getByText("Emergency")).toBeInTheDocument();
    expect(screen.getByText(/Raised automatically from reorder levels/)).toBeInTheDocument();
    expect(screen.getByText("Repeats every 30 days.")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Stop repeating" }));
    expect(await screen.findByText("Recurrence stopped.")).toBeInTheDocument();
    expect(hit).toBe(true);
  });
  it("attaches a file", async () => {
    let size = 0;
    server.use(http.post("*/api/v1/procurement/requisitions/r1/attachments", async ({ request }) => { size = ((await request.formData()).get("file") as File).size; return HttpResponse.json({ file_id: "f1", name: "quote.pdf" }, { status: 201 }); }));
    renderWithProviders(<RequisitionExtras req={req() as never} />, { permissions: MGR });
    await userEvent.upload(screen.getByLabelText("Requisition attachment"), new File(["hello"], "quote.pdf", { type: "application/pdf" }));
    expect(await screen.findByText("Attached quote.pdf.")).toBeInTheDocument();
    expect(size).toBe(5);
  });
  it("shows the server's refusal to attach", async () => {
    server.use(http.post("*/api/v1/procurement/requisitions/r1/attachments", () => HttpResponse.json({ error: { code: "file_type_not_allowed", message: "This file type is not allowed." } }, { status: 400 })));
    renderWithProviders(<RequisitionExtras req={req() as never} />, { permissions: MGR });
    await userEvent.upload(screen.getByLabelText("Requisition attachment"), new File(["x"], "run.exe"));
    expect(await screen.findByRole("alert")).toHaveTextContent("not allowed");
  });
  it("hides attach and stop-repeating without the create permission", () => {
    renderWithProviders(<RequisitionExtras req={req({ recurring_every_days: 7 }) as never} />, { permissions: ["procurement.view"] });
    expect(screen.queryByRole("button", { name: /Attach|Stop repeating/ })).toBeNull();
    expect(screen.getByText("Repeats every 7 days.")).toBeInTheDocument();
  });
});

describe("ConsolidateDialog", () => {
  const cands = [req(), req({ id: "r2", number: "REQ-2", title: "Chairs" })] as never[];
  const mount = () => renderWithProviders(<ConsolidateDialog candidates={cands} onClose={() => {}} />, { permissions: MGR });
  it("combines items, then creates an RFQ for chosen suppliers", async () => {
    let preview: Record<string, unknown> | null = null; let body: Record<string, unknown> | null = null;
    server.use(http.get("*/api/v1/procurement/suppliers", () => page([{ id: "s1", name: "Globex" }, { id: "s2", name: "Initech" }])),
      http.post("*/api/v1/procurement/requisitions/consolidate", async ({ request }) => {
        const b = (await request.json()) as Record<string, unknown>;
        if (b.suppliers) { body = b; return HttpResponse.json({ rfq: "q1", number: "RFQ-1" }, { status: 201 }); }
        preview = b;
        return HttpResponse.json({ lines: [{ product: "p1", description: "Widget", quantity: "15.0000", sources: [{ requisition: "REQ-1", line: 1, quantity: "10" }, { requisition: "REQ-2", line: 1, quantity: "5" }] }] });
      }));
    mount();
    const d = await screen.findByRole("dialog");
    await userEvent.click(within(d).getByRole("button", { name: "Combine items" }));
    expect(await within(d).findByRole("alert")).toHaveTextContent("at least one requisition");
    await userEvent.click(within(d).getByLabelText("REQ-1 — Office"));
    await userEvent.click(within(d).getByLabelText("REQ-2 — Chairs"));
    await userEvent.click(within(d).getByRole("button", { name: "Combine items" }));
    expect(await within(d).findByText("REQ-1 (10), REQ-2 (5)")).toBeInTheDocument();
    expect(preview).toEqual({ requisitions: ["r1", "r2"] });
    await userEvent.click(within(d).getByRole("button", { name: "Create request for quotation" }));
    expect(await within(d).findByRole("alert")).toHaveTextContent("at least one supplier");
    await userEvent.click(await within(d).findByLabelText("Globex"));
    await userEvent.click(within(d).getByRole("button", { name: "Create request for quotation" }));
    expect(await within(d).findByText("Created request for quotation RFQ-1.")).toBeInTheDocument();
    expect(body).toEqual({ requisitions: ["r1", "r2"], suppliers: ["s1"], title: "Consolidated sourcing" });
    expect(within(d).getByRole("link", { name: "Open it" })).toHaveAttribute("href", "/app/procurement/rfqs/q1");
  });
  it("says when there is nothing approved to consolidate", async () => {
    server.use(http.get("*/api/v1/procurement/suppliers", () => page([])));
    renderWithProviders(<ConsolidateDialog candidates={[]} onClose={() => {}} />, { permissions: MGR });
    expect(await screen.findByText(/No approved requisitions are waiting/)).toBeInTheDocument();
  });
});

describe("RequisitionsPage integration", () => {
  it("offers generate and consolidate by permission", async () => {
    server.use(http.get("*/api/v1/procurement/requisitions", () => page([req()])));
    const { unmount } = renderWithProviders(<RequisitionsPage />, { permissions: MGR });
    expect(await screen.findByRole("button", { name: "Generate replenishment" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Consolidate for sourcing" })).toBeInTheDocument();
    unmount();
    server.use(http.get("*/api/v1/procurement/requisitions", () => page([req()])));
    renderWithProviders(<RequisitionsPage />, { permissions: ["procurement.view"] });
    await screen.findByText("REQ-1");
    expect(screen.queryByRole("button", { name: /Generate|Consolidate/ })).toBeNull();
  });
});
