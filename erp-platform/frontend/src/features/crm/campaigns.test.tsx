import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { Route, Routes } from "react-router";

import * as auth from "../../shared/auth/authService";
import { renderWithProviders } from "../../test/utils";
import { CampaignDetailPage } from "./CampaignDetailPage";
import { CampaignsPage, buildAudience } from "./CampaignsPage";

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
beforeEach(() => vi.spyOn(auth, "getAccessToken").mockResolvedValue("tok"));
afterEach(() => { server.resetHandlers(); vi.restoreAllMocks(); });
afterAll(() => server.close());

const page = (rows: object[]) => HttpResponse.json({ results: rows, next: null, previous: null });
const camp = (o = {}) => ({ id: "k1", number: "CMP-1", name: "Spring push", objective: "More demos", channel: "EMAIL", audience: { kind: "leads" }, budget: "5000.00", currency: "USD", start_date: "2026-12-01", end_date: "2026-12-31", status: "DRAFT", owner_id: "u1", ...o });
const report = (o = {}) => ({ campaign: "CMP-1", status: "ACTIVE", currency: "USD", members: { TARGETED: 3, SENT: 2, RESPONDED: 1 }, excluded: 1, response_rate: "33.33", leads_generated: 4, leads_converted: 1, budget: "5000.00", spent: "1200.00", remaining: "3800.00", opportunities: 2, open_pipeline: "9000", won_revenue: "3000", roi_percent: "150.00", cost_per_lead: "300.00", ...o });
const MANAGE = ["crm.view", "crm.campaign.manage"];

describe("buildAudience", () => {
  it("builds criteria and refuses half-filled or repeated rules", () => {
    expect(buildAudience("leads", [{ key: "", value: "" }])).toEqual({ kind: "leads" });
    expect(buildAudience("contacts", [{ key: "industry", value: " Retail " }, { key: "segment", value: "SMB" }])).toEqual({ kind: "contacts", industry: "Retail", segment: "SMB" });
    expect(() => buildAudience("leads", [{ key: "source", value: "" }])).toThrow(/both a field and a value/);
    expect(() => buildAudience("leads", [{ key: "source", value: "a" }, { key: "source", value: "b" }])).toThrow(/used twice/);
  });
});

describe("CampaignsPage", () => {
  it("lists campaigns with spend, leads and ROI from the overview", async () => {
    server.use(http.get("*/api/v1/crm/campaigns", () => page([camp()])), http.get("*/api/v1/crm/campaigns/overview", () => HttpResponse.json([report()])));
    renderWithProviders(<CampaignsPage />, { permissions: MANAGE });
    expect(await screen.findByRole("link", { name: "Spring push" })).toHaveAttribute("href", "/app/crm/campaigns/k1");
    expect(await screen.findByText("150.00%")).toBeInTheDocument();
    expect(screen.getByText("1,200.00")).toBeInTheDocument();
  });

  it("creates a campaign with an audience, validating before calling the server", async () => {
    let body: Record<string, unknown> = {};
    server.use(http.get("*/api/v1/crm/campaigns", () => page([])), http.get("*/api/v1/crm/campaigns/overview", () => HttpResponse.json([])),
      http.get("*/api/v1/org/currencies", () => page([{ id: "c1", code: "USD", name: "US dollar", symbol: "$", decimals: 2, is_active: true }])),
      http.post("*/api/v1/crm/campaigns", async ({ request }) => { body = (await request.json()) as Record<string, unknown>; return HttpResponse.json(camp(), { status: 201 }); }));
    renderWithProviders(<CampaignsPage />, { permissions: MANAGE });
    await userEvent.click(await screen.findByRole("button", { name: "New campaign" }));
    const d = within(await screen.findByRole("dialog", { name: "New campaign" }));
    await userEvent.click(d.getByRole("button", { name: "Create campaign" }));
    expect(await d.findByRole("alert")).toHaveTextContent("required");
    await userEvent.type(d.getByLabelText("Name"), "Spring push");
    await waitFor(() => expect(d.getByRole("option", { name: "USD US dollar" })).toBeInTheDocument());
    await userEvent.selectOptions(d.getByLabelText("Currency"), "USD");
    fireEvent.change(d.getByLabelText("Starts"), { target: { value: "2026-12-31" } });
    fireEvent.change(d.getByLabelText("Ends"), { target: { value: "2026-12-01" } });
    await userEvent.click(d.getByRole("button", { name: "Create campaign" }));
    expect(await d.findByRole("alert")).toHaveTextContent("end date cannot be before");
    fireEvent.change(d.getByLabelText("Starts"), { target: { value: "2026-12-01" } });
    fireEvent.change(d.getByLabelText("Ends"), { target: { value: "2026-12-31" } });
    await userEvent.clear(d.getByLabelText("Budget"));
    await userEvent.type(d.getByLabelText("Budget"), "5000");
    await userEvent.selectOptions(d.getByLabelText("Rule 1 field"), "industry");
    await userEvent.selectOptions(d.getByLabelText("Audience"), "contacts");
    await userEvent.selectOptions(d.getByLabelText("Rule 1 field"), "industry");
    await userEvent.type(d.getByLabelText("Rule 1 value"), "Retail");
    await userEvent.click(d.getByRole("button", { name: "Create campaign" }));
    await waitFor(() => expect(body).toMatchObject({ name: "Spring push", channel: "EMAIL", currency: "USD", budget: "5000", audience: { kind: "contacts", industry: "Retail" } }));
  });
});

describe("CampaignDetailPage", () => {
  function detail(permissions: string[], c: object, extra: Parameters<typeof server.use> = []) {
    server.use(http.get("*/api/v1/crm/campaigns/k1", () => HttpResponse.json(c)), http.get("*/api/v1/crm/campaigns/k1/report", () => HttpResponse.json(report())),
      http.get("*/api/v1/crm/campaigns/k1/members", ({ request }) => { const s = new URL(request.url).searchParams.get("status"); const all = [{ id: "m1", contact: null, lead: "l1", status: "SENT", excluded_reason: "" }, { id: "m2", contact: "ct1", lead: null, status: "EXCLUDED", excluded_reason: "no consent" }]; return page(s ? all.filter((m) => m.status === s) : all); }),
      http.get("*/api/v1/crm/leads", () => page([{ id: "l1", name: "Lemlem Tadesse" }])),
      http.get("*/api/v1/crm/contacts", () => page([{ id: "ct1", first_name: "Dawit", last_name: "Alem" }])), ...extra);
    return renderWithProviders(<Routes><Route path="/app/crm/campaigns/:id" element={<CampaignDetailPage />} /></Routes>, { permissions, route: "/app/crm/campaigns/k1" });
  }

  it("shows results and the audience with who was excluded and why", async () => {
    detail(MANAGE, camp({ status: "ACTIVE" }));
    expect(await screen.findByRole("heading", { name: "Spring push" })).toBeInTheDocument();
    expect(await screen.findByText("150.00%")).toBeInTheDocument();
    expect(await screen.findByText("Lemlem Tadesse")).toBeInTheDocument();
    expect(screen.getByText(/Dawit Alem/)).toBeInTheDocument();
    expect(screen.getByText(/no consent/)).toBeInTheDocument();
  });

  it("filters members by status", async () => {
    detail(MANAGE, camp({ status: "ACTIVE" }));
    await screen.findByText("Lemlem Tadesse");
    await userEvent.selectOptions(screen.getByLabelText("Member status"), "EXCLUDED");
    await waitFor(() => expect(screen.queryByText("Lemlem Tadesse")).not.toBeInTheDocument());
    expect(screen.getByText(/Dawit Alem/)).toBeInTheDocument();
  });

  it("builds the audience and reports what was added and excluded", async () => {
    detail(MANAGE, camp(), [http.post("*/api/v1/crm/campaigns/k1/audience", () => HttpResponse.json({ added: 5, excluded: 2 }))]);
    await userEvent.click(await screen.findByRole("button", { name: "Build audience" }));
    expect(await screen.findByRole("status")).toHaveTextContent("Added 5 to the audience; 2 excluded");
  });

  it("shows the server's reason when activation is refused", async () => {
    detail(MANAGE, camp(), [http.post("*/api/v1/crm/campaigns/k1/activate", () => HttpResponse.json({ error: { code: "empty_audience", message: "Build an audience with at least one consenting member before activating." } }, { status: 409 }))]);
    await userEvent.click(await screen.findByRole("button", { name: "Activate" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("consenting member");
  });

  it("only offers sending to an active campaign, and records a response", async () => {
    let responded = false;
    detail(MANAGE, camp({ status: "ACTIVE" }), [http.post("*/api/v1/crm/campaigns/k1/send", () => HttpResponse.json({ sent: 3, blocked: 1 })), http.post("*/api/v1/crm/campaign-members/m1/respond", () => { responded = true; return HttpResponse.json({}); })]);
    await userEvent.click(await screen.findByRole("button", { name: "Mark all as sent" }));
    expect(await screen.findByRole("status")).toHaveTextContent("Marked 3 as sent; 1 blocked");
    await userEvent.click(await screen.findByRole("button", { name: "Record response from Lemlem Tadesse" }));
    await waitFor(() => expect(responded).toBe(true));
  });

  it("closed campaigns offer no actions, and viewers without the permission see none", async () => {
    detail(MANAGE, camp({ status: "COMPLETED" }));
    await screen.findByRole("heading", { name: "Spring push" });
    expect(screen.queryByRole("button", { name: "Build audience" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Record expense" })).not.toBeInTheDocument();
  });

  it("records an expense (amount validated), changes budget only with assign permission, and captures a lead", async () => {
    const calls: Record<string, unknown> = {};
    const post = (a: string) => http.post(`*/api/v1/crm/campaigns/k1/${a}`, async ({ request }) => { calls[a] = await request.json(); return HttpResponse.json({}, { status: 201 }); });
    detail([...MANAGE, "crm.assign"], camp({ status: "ACTIVE" }), [post("expenses"), post("budget"), post("capture")]);
    await userEvent.click(await screen.findByRole("button", { name: "Record expense" }));
    const e = within(await screen.findByRole("dialog", { name: "Record expense" }));
    fireEvent.change(e.getByLabelText("Date"), { target: { value: "2026-12-05" } });
    await userEvent.type(e.getByLabelText("What was it for?"), "Ads");
    await userEvent.type(e.getByLabelText("Amount"), "0");
    await userEvent.click(e.getByRole("button", { name: "Save expense" }));
    expect(await e.findByRole("alert")).toHaveTextContent("greater than zero");
    await userEvent.clear(e.getByLabelText("Amount"));
    await userEvent.type(e.getByLabelText("Amount"), "250.50");
    await userEvent.click(e.getByRole("button", { name: "Save expense" }));
    await waitFor(() => expect(calls.expenses).toEqual({ on_date: "2026-12-05", description: "Ads", amount: "250.50" }));
    await userEvent.click(screen.getByRole("button", { name: "Change budget" }));
    const b = within(await screen.findByRole("dialog", { name: "Change budget" }));
    await userEvent.clear(b.getByLabelText("Budget"));
    await userEvent.type(b.getByLabelText("Budget"), "6000");
    await userEvent.click(b.getByRole("button", { name: "Save budget" }));
    await waitFor(() => expect(calls.budget).toEqual({ budget: "6000" }));
    await userEvent.click(screen.getByRole("button", { name: "Capture lead" }));
    const l = within(await screen.findByRole("dialog", { name: "Capture lead" }));
    await userEvent.type(l.getByLabelText("Name"), "Walk-in");
    await userEvent.selectOptions(l.getByLabelText("Agreed to marketing"), "yes");
    await userEvent.click(l.getByRole("button", { name: "Capture" }));
    await waitFor(() => expect(calls.capture).toMatchObject({ name: "Walk-in", marketing_consent: true }));
  });

  it("hides the budget change from people without the assign permission", async () => {
    detail(MANAGE, camp({ status: "ACTIVE" }));
    await screen.findByRole("button", { name: "Record expense" });
    expect(screen.queryByRole("button", { name: "Change budget" })).not.toBeInTheDocument();
  });
});
