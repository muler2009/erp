import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";

import * as auth from "../../shared/auth/authService";
import { renderWithProviders } from "../../test/utils";
import { ChildrenCard, ContactDateDialog, CrossSellCard, OwnershipCard, UpcomingDatesPage, dateProblem } from "./AccountExtras";
import { LeadsPage } from "./LeadsPage";
import { importProblem } from "./LeadTools";

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
beforeEach(() => vi.spyOn(auth, "getAccessToken").mockResolvedValue("tok"));
afterEach(() => { server.resetHandlers(); vi.restoreAllMocks(); });
afterAll(() => server.close());

const page = (rows: object[]) => HttpResponse.json({ results: rows, next: null, previous: null });
const lead = (o = {}) => ({ id: "ld1", name: "Ada", company: "Initech", email: "ada@i.co", phone: "", status: "NEW", source: "web", owner_id: null, converted_opportunity: null, potential_value: null, currency: "", follow_up_date: null, ...o });
const MANAGE = ["crm.view", "crm.manage"];
const EMP = http.get("*/api/v1/hr/employees", () => HttpResponse.json({ results: [{ id: "e1", employee_no: "E1", name: "Abel", status: "ACTIVE", user_id: "u1" }, { id: "e2", employee_no: "E2", name: "Sara", status: "ACTIVE", user_id: "u2" }] }));

describe("helpers", () => {
  it("checks the import file", () => {
    expect(importProblem("name,email\nAda,a@b.co")).toBeNull();
    expect(importProblem("")).toMatch(/Choose a file/);
    expect(importProblem("company\nX")).toMatch(/name column/);
    expect(importProblem("name,colour\nAda,red")).toMatch(/Unknown column: colour/);
    expect(importProblem("name\n")).toMatch(/no rows/);
    expect(importProblem(`name\n${Array.from({ length: 501 }, (_, i) => `L${i}`).join("\n")}`)).toMatch(/500/);
  });
  it("checks contact dates", () => {
    expect(dateProblem("Birthday", "2026-12-01", "7")).toBeNull();
    expect(dateProblem(" ", "2026-12-01", "7")).toMatch(/Say what/);
    expect(dateProblem("B", "", "7")).toMatch(/Choose the date/);
    expect(dateProblem("B", "2026-12-01", "400")).toMatch(/365/);
  });
});

describe("Lead import", () => {
  const open = async (extra: Parameters<typeof server.use> = []) => {
    server.use(http.get("*/api/v1/crm/leads", () => page([lead()])), ...extra);
    renderWithProviders(<LeadsPage />, { permissions: MANAGE });
    await userEvent.click(await screen.findByRole("button", { name: "Import leads" }));
    return within(await screen.findByRole("dialog", { name: "Import leads" }));
  };
  it("only lets you import after a clean check of the same text", async () => {
    const calls: Record<string, unknown>[] = [];
    const d = await open([http.post("*/api/v1/crm/leads/import", async ({ request }) => { const b = (await request.json()) as Record<string, unknown>; calls.push(b); return HttpResponse.json({ dry_run: b.dry_run, valid: true, rows: 1, errors: [], created: b.dry_run ? 0 : 1 }); })]);
    const box = d.getByLabelText("Or paste the rows");
    expect(d.getByRole("button", { name: "Import" })).toBeDisabled();
    await userEvent.click(d.getByRole("button", { name: "Check file" }));
    expect(await d.findByText(/Choose a file or paste/)).toBeInTheDocument();
    fireEvent.change(box, { target: { value: "name,email\nAda,a@b.co" } });
    await userEvent.click(d.getByRole("button", { name: "Check file" }));
    expect(await d.findByText(/All 1 row\(s\) look good/)).toBeInTheDocument();
    expect(d.getByRole("button", { name: "Import" })).toBeEnabled();
    fireEvent.change(box, { target: { value: "name,email\nAda,a@b.co\nBob,b@b.co" } });
    expect(d.getByRole("button", { name: "Import" })).toBeDisabled();
    fireEvent.change(box, { target: { value: "name,email\nAda,a@b.co" } });
    await userEvent.click(d.getByRole("button", { name: "Check file" }));
    await userEvent.click(await d.findByRole("button", { name: "Import" }).then((b) => { expect(b).toBeEnabled(); return b; }));
    expect(await d.findByText("1 lead(s) created.")).toBeInTheDocument();
    expect(calls.map((c) => c.dry_run)).toEqual([true, true, false]);
  });
  it("lists the problems row by row and keeps Import disabled", async () => {
    const d = await open([http.post("*/api/v1/crm/leads/import", () => HttpResponse.json({ dry_run: true, valid: false, rows: 2, errors: [{ row: 2, errors: ["invalid priority", "duplicate of an existing lead"] }], created: 0 }))]);
    fireEvent.change(d.getByLabelText("Or paste the rows"), { target: { value: "name,priority\nAda,HIGH\nBob,URGENT" } });
    await userEvent.click(d.getByRole("button", { name: "Check file" }));
    expect(await d.findByText("Row 2: invalid priority, duplicate of an existing lead")).toBeInTheDocument();
    expect(d.getByRole("button", { name: "Import" })).toBeDisabled();
  });
  it("is hidden from people who cannot manage leads", async () => {
    server.use(http.get("*/api/v1/crm/leads", () => page([lead()])));
    renderWithProviders(<LeadsPage />, { permissions: ["crm.view"] });
    await screen.findByText("Ada");
    expect(screen.queryByRole("button", { name: "Import leads" })).toBeNull();
    expect(screen.queryByRole("button", { name: /Find duplicates/ })).toBeNull();
  });
});

describe("Lead duplicates and merge", () => {
  const open = async (dups: object, extra: Parameters<typeof server.use> = []) => {
    server.use(http.get("*/api/v1/crm/leads", () => page([lead(), lead({ id: "ld9", name: "Done", status: "CONVERTED" })])), http.get("*/api/v1/crm/leads/duplicates", () => HttpResponse.json(dups)), ...extra);
    renderWithProviders(<LeadsPage />, { permissions: MANAGE });
    await userEvent.click(await screen.findByRole("button", { name: "Find duplicates of Ada" }));
    return within(await screen.findByRole("dialog", { name: /Possible duplicates of Ada/ }));
  };
  it("is not offered for converted leads", async () => {
    await open({ leads: [], accounts: [] });
    expect(screen.queryByRole("button", { name: "Find duplicates of Done" })).toBeNull();
  });
  it("says so when nothing matches, ignoring the lead itself", async () => {
    const d = await open({ leads: [{ id: "ld1", name: "Ada", company: "Initech", status: "NEW", matched_on: "email" }], accounts: [] });
    expect(await d.findByText(/No other open lead looks like this one/)).toBeInTheDocument();
    expect(d.queryByRole("button", { name: "Merge leads" })).toBeNull();
  });
  it("merges into this lead by default and can keep the other instead", async () => {
    const bodies: Record<string, unknown>[] = [];
    const d = await open({ leads: [{ id: "ld2", name: "Ada L", company: "Initech", status: "CONTACTED", matched_on: "name+company" }], accounts: [{ id: "a1", name: "Initech" }] },
      [http.post("*/api/v1/crm/leads/merge", async ({ request }) => { bodies.push((await request.json()) as Record<string, unknown>); return HttpResponse.json(lead()); })]);
    expect(await d.findByText(/account with this company name already exists/)).toBeInTheDocument();
    await userEvent.click(d.getByRole("button", { name: "Merge leads" }));
    expect(await d.findByText("Choose the lead to merge.")).toBeInTheDocument();
    await userEvent.click(d.getByRole("radio", { name: /Ada L/ }));
    await userEvent.click(d.getByRole("radio", { name: /The other lead/ }));
    await userEvent.click(d.getByRole("button", { name: "Merge leads" }));
    await waitFor(() => expect(bodies).toEqual([{ keep: "ld2", merge: "ld1" }]));
  });
  it("shows the server's refusal", async () => {
    const d = await open({ leads: [{ id: "ld2", name: "Ada L", company: "", status: "QUALIFIED", matched_on: "email" }], accounts: [] },
      [http.post("*/api/v1/crm/leads/merge", () => HttpResponse.json({ error: { code: "invalid_state_transition", message: "Converted or already merged leads cannot be merged." } }, { status: 409 }))]);
    await userEvent.click(await d.findByRole("radio", { name: /Ada L/ }));
    await userEvent.click(d.getByRole("button", { name: "Merge leads" }));
    expect(await d.findByText("Converted or already merged leads cannot be merged.")).toBeInTheDocument();
  });
});

describe("Account extras", () => {
  it("lists child accounts as links, and says when there are none", async () => {
    server.use(http.get("*/api/v1/crm/accounts/a1/children", () => HttpResponse.json([{ id: "c1", name: "Acme East", is_active: true }, { id: "c2", name: "Acme Old", is_active: false }])));
    renderWithProviders(<ChildrenCard id="a1" />, { permissions: ["crm.view"] });
    expect(await screen.findByRole("link", { name: "Acme East" })).toHaveAttribute("href", "/app/crm/accounts/c1");
    expect(screen.getByText(/\(archived\)/)).toBeInTheDocument();
  });
  it("shows cross-sell ideas and refuses a bad currency without asking", async () => {
    const seen: string[] = [];
    server.use(http.get("*/api/v1/crm/accounts/a1/cross-sell", ({ request }) => { seen.push(new URL(request.url).searchParams.get("currency") ?? ""); return HttpResponse.json([{ product: "p1", name: "Widget", peer_buyers: 3, revenue: "900.00" }]); }));
    renderWithProviders(<CrossSellCard id="a1" />, { permissions: ["crm.view"] });
    expect(await screen.findByText("Widget")).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText("Cross-sell currency"), "US");
    expect(screen.getByText("Enter a 3-letter currency code.")).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText("Cross-sell currency"), "d");
    await waitFor(() => expect(seen).toContain("USD"));
  });
  it("explains an empty cross-sell result", async () => {
    server.use(http.get("*/api/v1/crm/accounts/a1/cross-sell", () => HttpResponse.json([])));
    renderWithProviders(<CrossSellCard id="a1" />, { permissions: ["crm.view"] });
    expect(await screen.findByText("No suggestions")).toBeInTheDocument();
  });
  it("shows who owned a record and when", async () => {
    server.use(EMP, http.get("*/api/v1/crm/ownership/account/a1", () => HttpResponse.json([{ from: null, to: "u1", by: "u2", reason: "New customer", at: "2026-10-01T08:00:00Z" }, { from: "u1", to: "u2", by: "u2", reason: "", at: "2026-11-01T08:00:00Z" }])));
    renderWithProviders(<OwnershipCard kind="account" id="a1" />, { permissions: ["crm.view"] });
    expect(await screen.findByText(/2026-10-01: No owner → .*Abel.* \(by .*Sara.*\), New customer/)).toBeInTheDocument();
    expect(screen.getByText(/2026-11-01: .*Abel.* → .*Sara/)).toBeInTheDocument();
  });
  it("says when the owner never changed", async () => {
    server.use(EMP, http.get("*/api/v1/crm/ownership/opportunity/o1", () => HttpResponse.json([])));
    renderWithProviders(<OwnershipCard kind="opportunity" id="o1" />, { permissions: ["crm.view"] });
    expect(await screen.findByText("The owner has not changed.")).toBeInTheDocument();
  });
});

describe("Contact dates", () => {
  it("adds a yearly date with a reminder", async () => {
    let body: Record<string, unknown> | null = null;
    server.use(http.post("*/api/v1/crm/contacts/c1/dates", async ({ request }) => { body = (await request.json()) as Record<string, unknown>; return HttpResponse.json({ id: "d1" }, { status: 201 }); }));
    renderWithProviders(<ContactDateDialog contactId="c1" name="Ann Lee" onClose={() => {}} />, { permissions: MANAGE });
    const d = within(await screen.findByRole("dialog", { name: "Add date for Ann Lee" }));
    await userEvent.type(d.getByLabelText(/What is it/), "Birthday");
    fireEvent.change(d.getByLabelText("Date"), { target: { value: "2026-12-05" } });
    await userEvent.click(d.getByRole("button", { name: "Add date" }));
    await waitFor(() => expect(body).toEqual({ label: "Birthday", on_date: "2026-12-05", remind_days_before: 7, yearly: true }));
  });
  it("rejects reminder days over a year", async () => {
    renderWithProviders(<ContactDateDialog contactId="c1" name="Ann Lee" onClose={() => {}} />, { permissions: MANAGE });
    const d = within(await screen.findByRole("dialog", { name: "Add date for Ann Lee" }));
    await userEvent.type(d.getByLabelText(/What is it/), "Renewal");
    fireEvent.change(d.getByLabelText("Date"), { target: { value: "2026-12-05" } });
    await userEvent.clear(d.getByLabelText(/Remind/)); await userEvent.type(d.getByLabelText(/Remind/), "400");
    await userEvent.click(d.getByRole("button", { name: "Add date" }));
    expect(await d.findByText(/up to 365/)).toBeInTheDocument();
  });
  it("lists upcoming dates for the chosen window", async () => {
    const asked: string[] = [];
    server.use(http.get("*/api/v1/crm/contact-dates/upcoming", ({ request }) => { asked.push(new URL(request.url).searchParams.get("days") ?? ""); return HttpResponse.json([{ contact: "c1", name: "Ann Lee", label: "Birthday", date: "2026-12-05", remind_on: "2026-11-28" }]); }));
    renderWithProviders(<UpcomingDatesPage />, { permissions: ["crm.view"] });
    expect(await screen.findByText("Ann Lee")).toBeInTheDocument();
    await userEvent.selectOptions(screen.getByLabelText("Look ahead"), "90");
    await waitFor(() => expect(asked).toEqual(["30", "90"]));
  });
});
