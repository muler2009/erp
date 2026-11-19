import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";

import * as auth from "../../shared/auth/authService";
import { renderWithProviders } from "../../test/utils";
import TendersPage, { scoresProblem, tenderInput, tenderProblem, type TenderDraft } from "./TendersPage";

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
beforeEach(() => vi.spyOn(auth, "getAccessToken").mockResolvedValue("tok"));
afterEach(() => { server.resetHandlers(); vi.restoreAllMocks(); });
afterAll(() => server.close());

const FUTURE = new Date(Date.now() + 86400000 * 5).toISOString().slice(0, 16);
const draft = (o: Partial<TenderDraft> = {}): TenderDraft => ({ title: "Laptops", closing_at: FUTURE, committee: ["u1", "u2"], open_to_all: true, suppliers: [], lines: [{ description: "Laptop", quantity: "10" }], criteria: [{ name: "Price", type: "FINANCIAL", weight: "60" }, { name: "Tech", type: "TECHNICAL", weight: "40" }], min_technical_score: "", ...o });
const trow = (o = {}) => ({ id: "t1", number: "TND-1", title: "Laptops", kind: "TENDER", status: "DRAFT", closing_at: "2030-01-01T10:00:00Z", criteria: [], committee: ["u1", "u2"], opened_at: null, open_to_all: true, bids_visible: false, ...o });
const list = (rows: object[]) => http.get("*/api/v1/procurement/tenders", () => HttpResponse.json({ results: rows }));
const ALL = ["procurement.view", "procurement.rfq.manage", "procurement.tender.evaluate", "procurement.tender.award"];

describe("helpers", () => {
  it("tenderProblem", () => {
    expect(tenderProblem(draft())).toBeNull();
    expect(tenderProblem(draft({ title: " " }))).toMatch(/title/);
    expect(tenderProblem(draft({ closing_at: "" }))).toMatch(/closing/);
    expect(tenderProblem(draft({ closing_at: "2000-01-01T10:00" }))).toMatch(/future/);
    expect(tenderProblem(draft({ committee: ["u1"] }))).toMatch(/two/);
    expect(tenderProblem(draft({ open_to_all: false }))).toMatch(/Invite/);
    expect(tenderProblem(draft({ lines: [{ description: "", quantity: "1" }] }))).toMatch(/describe/);
    expect(tenderProblem(draft({ lines: [{ description: "x", quantity: "0" }] }))).toMatch(/more than 0/);
    expect(tenderProblem(draft({ criteria: [{ name: "A", type: "TECHNICAL", weight: "50" }, { name: "B", type: "TECHNICAL", weight: "50" }] }))).toMatch(/one financial/);
    expect(tenderProblem(draft({ criteria: [{ name: "P", type: "FINANCIAL", weight: "50" }, { name: "T", type: "TECHNICAL", weight: "40" }] }))).toMatch(/100/);
    expect(tenderProblem(draft({ min_technical_score: "150" }))).toMatch(/between/);
  });
  it("tenderInput builds numeric weights and either invitees or open_to_all", () => {
    const a = tenderInput(draft());
    expect(a.open_to_all).toBe(true);
    expect(a.criteria[0]?.weight).toBe(60);
    const b = tenderInput(draft({ open_to_all: false, suppliers: ["s1"], min_technical_score: "50" }));
    expect(b.suppliers).toEqual(["s1"]);
    expect(b.min_technical_score).toBe(50);
  });
  it("scoresProblem", () => {
    const c = [{ name: "Tech", type: "TECHNICAL" as const, weight: 40 }];
    expect(scoresProblem(c, { Tech: "80" })).toBeNull();
    expect(scoresProblem(c, { Tech: "" })).toMatch(/Tech/);
    expect(scoresProblem(c, { Tech: "101" })).toMatch(/Tech/);
  });
});

describe("TendersPage", () => {
  it("shows an empty state", async () => {
    server.use(list([]));
    renderWithProviders(<TendersPage />, { permissions: ALL });
    expect(await screen.findByText("No tenders yet")).toBeInTheDocument();
  });

  it("publishes a draft tender", async () => {
    let hit = false;
    server.use(list([trow()]), http.post("*/api/v1/procurement/tenders/t1/publish", () => { hit = true; return HttpResponse.json(trow({ status: "OPEN" })); }));
    renderWithProviders(<TendersPage />, { permissions: ALL });
    await userEvent.click(await screen.findByRole("button", { name: "Publish TND-1" }));
    await waitFor(() => expect(hit).toBe(true));
  });

  it("hides committee and manage actions without permission", async () => {
    server.use(list([trow({ status: "CLOSED" })]));
    renderWithProviders(<TendersPage />, { permissions: ["procurement.view"] });
    await screen.findByText("TND-1");
    expect(screen.queryByRole("button", { name: /Open bids/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "New tender" })).toBeNull();
  });

  it("opens sealed bids and shows the server's refusal message", async () => {
    server.use(list([trow({ status: "CLOSED" })]), http.post("*/api/v1/procurement/tenders/t1/open", () => HttpResponse.json({ error: { code: "committee_quorum", message: "Two committee members must open the bids." } }, { status: 409 })));
    renderWithProviders(<TendersPage />, { permissions: ALL });
    await userEvent.click(await screen.findByRole("button", { name: "Open bids TND-1" }));
    expect(await screen.findByText("Two committee members must open the bids.")).toBeInTheDocument();
  });

  it("explains that sealed bids stay hidden", async () => {
    server.use(list([trow({ status: "CLOSED" })]));
    renderWithProviders(<TendersPage />, { permissions: ALL });
    await userEvent.click(await screen.findByRole("button", { name: "View TND-1" }));
    expect(await screen.findByText(/Bids are sealed/)).toBeInTheDocument();
  });

  const evalData = { rfq: "t1", criteria: [{ name: "Price", type: "FINANCIAL", weight: 60 }, { name: "Tech", type: "TECHNICAL", weight: 40 }], recommended: "q1", results: [
    { quotation: "q1", supplier: "Acme", total_base: "900.0000", scores: {}, weighted_score: 82, compliant: true, issues: [], rank: 1 },
    { quotation: "q2", supplier: "Beta", total_base: "800.0000", scores: {}, weighted_score: 70, compliant: false, issues: ["Below minimum technical score"], rank: 2 }] };

  it("scores, disqualifies and awards with justification for a non-recommended bid", async () => {
    let scored: unknown = null; let dq: unknown = null; let awarded: unknown = null;
    server.use(
      list([trow({ status: "CLOSED", bids_visible: true, opened_at: "2030-01-02T00:00:00Z" })]),
      http.get("*/api/v1/procurement/tenders/t1/evaluation", () => HttpResponse.json(evalData)),
      http.post("*/api/v1/procurement/quotations/q1/score", async ({ request }) => { scored = await request.json(); return HttpResponse.json({ scored: true }); }),
      http.post("*/api/v1/procurement/quotations/q2/disqualify", async ({ request }) => { dq = await request.json(); return HttpResponse.json({ disqualified: true }); }),
      http.post("*/api/v1/procurement/rfqs/t1/award-justified", async ({ request }) => { awarded = await request.json(); return HttpResponse.json({ po: "po1", number: "PO-1" }); }),
    );
    renderWithProviders(<TendersPage />, { permissions: ALL });
    await userEvent.click(await screen.findByRole("button", { name: "View TND-1" }));
    expect(await screen.findByText("Recommended")).toBeInTheDocument();
    expect(screen.getByText("Below minimum technical score")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Score Acme" }));
    await userEvent.click(await screen.findByRole("button", { name: "Save scores" }));
    expect(await screen.findByText(/Score "Tech" from 0 to 100/)).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText(/Tech \(0–100\)/), "85");
    await userEvent.click(screen.getByRole("button", { name: "Save scores" }));
    await waitFor(() => expect(scored).toEqual({ scores: { Tech: 85 }, comment: "" }));

    await userEvent.click(screen.getByRole("button", { name: "Disqualify Beta" }));
    await userEvent.click(await screen.findByRole("button", { name: "Disqualify" }));
    expect(await screen.findByText("A reason is required.")).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText("Reason"), "Late documents");
    await userEvent.click(screen.getByRole("button", { name: "Disqualify" }));
    await waitFor(() => expect(dq).toEqual({ reason: "Late documents" }));

    await userEvent.click(screen.getByRole("button", { name: "Award Beta" }));
    await userEvent.click(await screen.findByRole("button", { name: "Award and create PO" }));
    expect(await screen.findByText("Explain why this bid is awarded.")).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText(/Justification/), "Only bidder able to deliver in time");
    await userEvent.click(screen.getByRole("button", { name: "Award and create PO" }));
    await waitFor(() => expect(awarded).toEqual({ quotation: "q2", justification: "Only bidder able to deliver in time" }));
  });

  it("shows bidder results for an awarded tender", async () => {
    server.use(
      list([trow({ status: "AWARDED", bids_visible: true })]),
      http.get("*/api/v1/procurement/tenders/t1/evaluation", () => HttpResponse.json(evalData)),
      http.get("*/api/v1/procurement/tenders/t1/results", () => HttpResponse.json({ results: [{ supplier: "Acme", outcome: "AWARDED", rank: 1, weighted_score: 82, reason: "" }, { supplier: "Beta", outcome: "DISQUALIFIED", rank: null, weighted_score: null, reason: "Late documents" }] })),
    );
    renderWithProviders(<TendersPage />, { permissions: ALL });
    await userEvent.click(await screen.findByRole("button", { name: "View TND-1" }));
    expect(await screen.findByText("Bidder results")).toBeInTheDocument();
    expect(await screen.findByText("Late documents")).toBeInTheDocument();
    expect(screen.getAllByText("Awarded").length).toBeGreaterThan(0);
  });

  it("blocks creating a tender with weights that do not add up", async () => {
    server.use(list([]), http.get("*/api/v1/procurement/suppliers", () => HttpResponse.json({ results: [], next: null })), http.get("*/api/v1/hr/employees", () => HttpResponse.json({ results: [], next: null })));
    renderWithProviders(<TendersPage />, { permissions: ALL });
    await userEvent.click(await screen.findByRole("button", { name: "New tender" }));
    await userEvent.type(screen.getByLabelText("Title"), "X");
    await userEvent.click(screen.getByRole("button", { name: "Create tender" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/closing/);
  });
});
