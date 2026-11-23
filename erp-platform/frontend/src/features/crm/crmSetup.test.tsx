import { fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";

import * as auth from "../../shared/auth/authService";
import { renderWithProviders } from "../../test/utils";
import { AccountSummaryCard, LeadConsentDialog, LinkContactDialog, PipelineSettingsPage, stageProblem } from "./CrmSetup";

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
beforeEach(() => vi.spyOn(auth, "getAccessToken").mockResolvedValue("tok"));
afterEach(() => { server.resetHandlers(); vi.restoreAllMocks(); });
afterAll(() => server.close());

const STAGES = [{ code: "QUAL", name: "Qualified", probability: 20, is_won: false, is_lost: false }, { code: "WON", name: "Won", probability: 100, is_won: true, is_lost: false }];

it("checks stage input", () => {
  expect(stageProblem({ code: "1x", name: "A", position: "1", probability: "10" }, true)).toMatch(/code/);
  expect(stageProblem({ code: "NEW", name: "", position: "1", probability: "10" }, true)).toMatch(/name/);
  expect(stageProblem({ code: "NEW", name: "A", position: "1", probability: "150" }, true)).toMatch(/0 to 100/);
  expect(stageProblem({ code: "NEW", name: "A", position: "x", probability: "50" }, true)).toMatch(/Position/);
  expect(stageProblem({ code: "NEW", name: "A", position: "2", probability: "50" }, true)).toBeNull();
  expect(stageProblem({ code: "QUAL", name: "", position: "", probability: "30" }, false)).toBeNull();
});

describe("PipelineSettingsPage", () => {
  it("shows fixed stages without actions", async () => {
    server.use(http.get("*/api/v1/crm/stages", () => HttpResponse.json(STAGES)));
    renderWithProviders(<PipelineSettingsPage />, { permissions: ["crm.assign"] });
    await screen.findByText(/1\. Qualified/);
    expect(screen.getByText("Fixed")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Edit stage Won" })).toBeNull();
  });
  it("edits only what changed, creates stages, and shows refusals on retire", async () => {
    const puts: Record<string, unknown>[] = [];
    server.use(
      http.get("*/api/v1/crm/stages", () => HttpResponse.json(STAGES)),
      http.put("*/api/v1/crm/stages/:code", async ({ request, params }) => { puts.push({ code: params.code, ...((await request.json()) as object) }); return HttpResponse.json({ code: params.code, name: "x", position: 1, probability: 1 }); }),
      http.delete("*/api/v1/crm/stages/QUAL", () => HttpResponse.json({ error: { code: "stage_in_use", message: "Move the opportunities out of this stage first." } }, { status: 409 })),
    );
    renderWithProviders(<PipelineSettingsPage />, { permissions: ["crm.assign"] });
    await userEvent.click(await screen.findByRole("button", { name: "Edit stage Qualified" }));
    const prob = screen.getByLabelText("Chance of winning (%)");
    await userEvent.clear(prob); await userEvent.type(prob, "150");
    await userEvent.click(screen.getByRole("button", { name: "Save stage" }));
    expect(await screen.findByText(/0 to 100/)).toBeInTheDocument();
    await userEvent.clear(prob); await userEvent.type(prob, "35");
    await userEvent.click(screen.getByRole("button", { name: "Save stage" }));
    await waitFor(() => expect(puts).toEqual([{ code: "QUAL", name: "Qualified", probability: 35 }]));
    await userEvent.click(screen.getByRole("button", { name: "New stage" }));
    await userEvent.type(screen.getByLabelText("Code"), "proposal");
    await userEvent.type(screen.getByLabelText("Name"), "Proposal");
    await userEvent.type(screen.getByLabelText("Position (order number)"), "3");
    await userEvent.type(screen.getByLabelText("Chance of winning (%)"), "60");
    await userEvent.click(screen.getByRole("button", { name: "Save stage" }));
    await waitFor(() => expect(puts[1]).toEqual({ code: "PROPOSAL", name: "Proposal", position: 3, probability: 60 }));
    await userEvent.click(screen.getByRole("button", { name: "Retire stage Qualified" }));
    expect(await screen.findByText(/Move the opportunities out/)).toBeInTheDocument();
  });
});

describe("AccountSummaryCard", () => {
  const S = { account: "a1", currency: "USD", lifetime_value: "5000.00", orders: 4, average_order_value: "1250.00", first_order: "2025-01-02", last_order: "2026-10-01", top_products: [{ product: "Widget", revenue: "3000.00" }], open_opportunities: 2, open_cases: 1, satisfaction: 4.5 };
  it("shows history and passes a valid currency only", async () => {
    const seen: string[] = [];
    server.use(http.get("*/api/v1/crm/accounts/a1/summary", ({ request }) => { seen.push(new URL(request.url).search); return HttpResponse.json(S); }));
    renderWithProviders(<AccountSummaryCard id="a1" />, {});
    expect(await screen.findByText(/4 orders/)).toBeInTheDocument();
    expect(screen.getByText(/Widget/)).toBeInTheDocument();
    expect(screen.getByText(/satisfaction 4.5/)).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText("Summary currency"), "e");
    expect(await screen.findByText(/3-letter currency code/)).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText("Summary currency"), "ur");
    await waitFor(() => expect(seen.some((s) => s.includes("currency=EUR"))).toBe(true));
    expect(seen.some((s) => s.includes("currency=E&") || s.endsWith("currency=E"))).toBe(false);
  });
});

describe("LeadConsentDialog", () => {
  it("sends each action and shows refusals", async () => {
    const bodies: Record<string, unknown>[] = []; let refuse = false;
    server.use(http.post("*/api/v1/crm/leads/l1/consent", async ({ request }) => { bodies.push((await request.json()) as Record<string, unknown>); return refuse ? HttpResponse.json({ error: { code: "x", message: "Lead not found." } }, { status: 404 }) : HttpResponse.json({}); }));
    renderWithProviders(<LeadConsentDialog lead={{ id: "l1", name: "Zed" } as never} onClose={() => {}} />, {});
    await userEvent.click(screen.getByRole("button", { name: "Record consent" }));
    expect(await screen.findByText("Consent recorded.")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Record opt-out" }));
    await userEvent.click(screen.getByRole("button", { name: "Clear opt-out" }));
    await waitFor(() => expect(bodies).toEqual([{ consent: true }, { opt_out: true }, { opt_out: false }]));
    refuse = true;
    await userEvent.click(screen.getByRole("button", { name: "Withdraw consent" }));
    expect(await screen.findByText("Lead not found.")).toBeInTheDocument();
  });
});

describe("LinkContactDialog", () => {
  it("requires an account, excludes the home account, and links with a role", async () => {
    let body: Record<string, unknown> | null = null; let q = "";
    server.use(
      http.get("*/api/v1/crm/accounts", ({ request }) => { q = new URL(request.url).search; return HttpResponse.json({ results: [{ id: "a1", name: "Home Co" }, { id: "a2", name: "Other Ltd" }], next: null, previous: null }); }),
      http.post("*/api/v1/crm/contacts/c1/links", async ({ request }) => { body = (await request.json()) as Record<string, unknown>; return HttpResponse.json({}, { status: 201 }); }),
    );
    const onClose = vi.fn();
    renderWithProviders(<LinkContactDialog contact={{ id: "c1", account: "a1", first_name: "Ann", last_name: "Lee" } as never} onClose={onClose} />, {});
    await userEvent.click(screen.getByRole("button", { name: "Link account" }));
    expect(await screen.findByText("Choose an account to link.")).toBeInTheDocument();
    await screen.findByRole("option", { name: "Other Ltd" });
    expect(screen.queryByRole("option", { name: "Home Co" })).toBeNull();
    fireEvent.change(screen.getByLabelText("Find account"), { target: { value: "oth" } });
    await userEvent.click(screen.getByRole("button", { name: "Search" }));
    await waitFor(() => expect(q).toContain("q=oth"));
    await userEvent.selectOptions(screen.getByLabelText("Account"), "a2");
    await userEvent.selectOptions(screen.getByLabelText("Role at that account"), "BILLING");
    await userEvent.click(screen.getByRole("button", { name: "Link account" }));
    await waitFor(() => expect(body).toEqual({ account: "a2", role: "BILLING" }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });
});
