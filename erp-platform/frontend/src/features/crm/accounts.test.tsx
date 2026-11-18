import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { Route, Routes } from "react-router";

import * as auth from "../../shared/auth/authService";
import { renderWithProviders } from "../../test/utils";
import { AccountDetailPage } from "./AccountDetailPage";
import { CrmAccountsPage } from "./AccountsPage";
import { ContactsPage, consentSummary } from "./ContactsPage";

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
beforeEach(() => vi.spyOn(auth, "getAccessToken").mockResolvedValue("tok"));
afterEach(() => { server.resetHandlers(); vi.restoreAllMocks(); });
afterAll(() => server.close());

const page = (rows: object[]) => HttpResponse.json({ results: rows, next: null, previous: null });
const acct = (o = {}) => ({ id: "a1", name: "Acme Ltd", industry: "Retail", segment: "SMB", owner_id: "u1", is_active: true, credit_status: "OK", lifecycle_stage: "ACTIVE", website: "", tax_id: "", customer_type: "BUSINESS", parent: null, classification: "", credit_limit: null, restriction_note: "", preferred_channel: "", language: "", ...o });
const contact = (o = {}) => ({ id: "c1", account: "a1", first_name: "Dawit", last_name: "Alem", email: "d@acme.io", phone: "", job_title: "CFO", role: "DECISION_MAKER", preferred_channel: "EMAIL", consent: { email: false, phone: false, sms: false, opted_out: false }, ...o });
const VIEW = ["crm.view"];
const MANAGE = ["crm.view", "crm.manage"];

describe("consentSummary", () => {
  it("says what the contact agreed to", () => {
    expect(consentSummary({ email: false, phone: false, sms: false, opted_out: false })).toBe("No consent recorded");
    expect(consentSummary({ email: true, phone: false, sms: true, opted_out: false })).toBe("email, SMS");
    expect(consentSummary({ email: true, phone: true, sms: true, opted_out: true })).toBe("Opted out");
  });
});

describe("CrmAccountsPage", () => {
  it("lists and searches accounts; creating needs the manage permission", async () => {
    let q = "";
    server.use(http.get("*/api/v1/crm/accounts", ({ request }) => { q = new URL(request.url).searchParams.get("q") ?? ""; return page([acct()]); }));
    renderWithProviders(<CrmAccountsPage />, { permissions: VIEW });
    expect(await screen.findByRole("link", { name: "Acme Ltd" })).toHaveAttribute("href", "/app/crm/accounts/a1");
    expect(screen.queryByRole("button", { name: "New account" })).not.toBeInTheDocument();
    await userEvent.type(screen.getByLabelText("Search accounts"), "ac");
    await waitFor(() => expect(q).toBe("ac"));
  });

  it("creates an account", async () => {
    let body: Record<string, unknown> = {};
    server.use(http.get("*/api/v1/crm/accounts", () => page([])), http.post("*/api/v1/crm/accounts", async ({ request }) => { body = (await request.json()) as Record<string, unknown>; return HttpResponse.json(acct(), { status: 201 }); }));
    renderWithProviders(<CrmAccountsPage />, { permissions: MANAGE });
    await userEvent.click(await screen.findByRole("button", { name: "New account" }));
    const d = within(await screen.findByRole("dialog", { name: "New account" }));
    await userEvent.click(d.getByRole("button", { name: "Create account" }));
    expect(await d.findByRole("alert")).toHaveTextContent("Name is required");
    await userEvent.type(d.getByLabelText("Name"), "Zeta");
    await userEvent.type(d.getByLabelText("Industry"), "Food");
    await userEvent.click(d.getByRole("button", { name: "Create account" }));
    await waitFor(() => expect(body).toMatchObject({ name: "Zeta", industry: "Food" }));
    expect(body).not.toHaveProperty("owner_id"); // only managers who can assign get an owner field
  });
});

function detail(permissions: string[], extra: Parameters<typeof server.use>) {
  server.use(
    http.get("*/api/v1/crm/accounts/a1", () => HttpResponse.json(acct())),
    http.get("*/api/v1/crm/contacts", () => page([contact()])),
    http.get("*/api/v1/crm/accounts/a1/addresses", () => HttpResponse.json([{ id: "ad1", kind: "BILLING", label: "", line1: "Bole Rd 1", city: "Addis", region: "", country: "ET", is_default: true }])),
    http.get("*/api/v1/crm/accounts/a1/timeline", () => HttpResponse.json([{ at: "2026-11-01T09:00:00Z", kind: "order", summary: "Order SO-1 confirmed (100 USD)", ref: "o1" }])),
    ...extra);
  return renderWithProviders(<Routes><Route path="/app/crm/accounts/:id" element={<AccountDetailPage />} /></Routes>, { permissions, route: "/app/crm/accounts/a1" });
}

const staff = http.get("*/api/v1/hr/employees", () => HttpResponse.json({ results: [{ id: "e1", employee_no: "E-1", name: "Abel", status: "ACTIVE", user_id: "u1" }, { id: "e2", employee_no: "E-2", name: "Sara", status: "ACTIVE", user_id: "u2" }] }));

describe("AccountDetailPage owner", () => {
  it("is only offered to people who can assign", async () => {
    detail(MANAGE, [staff]);
    await screen.findByRole("heading", { name: "Acme Ltd" });
    expect(screen.queryByRole("button", { name: "Change owner" })).not.toBeInTheDocument();
  });

  it("changes the owner", async () => {
    let body: unknown = null;
    detail(["crm.view", "crm.assign"], [staff, http.post("*/api/v1/crm/account/a1/assign", async ({ request }) => { body = await request.json(); return HttpResponse.json({}); })]);
    await userEvent.click(await screen.findByRole("button", { name: "Change owner" }));
    const d = within(await screen.findByRole("dialog", { name: "Change owner" }));
    await userEvent.selectOptions(d.getByLabelText("New owner"), "u2");
    await userEvent.click(d.getByRole("button", { name: "Change owner" }));
    await waitFor(() => expect(body).toEqual({ owner_id: "u2" }));
  });

  it("assigns by territory and reports a refusal", async () => {
    let n = 0;
    detail(["crm.view", "crm.assign"], [staff, http.post("*/api/v1/crm/accounts/a1/assign-territory", () => { n += 1; return n === 1 ? HttpResponse.json({ error: { code: "no_territory", message: "No territory matches this account." } }, { status: 409 }) : HttpResponse.json({ account: "a1", owner_id: "u2", territory: "East" }); })]);
    await userEvent.click(await screen.findByRole("button", { name: "Assign by territory" }));
    expect(await screen.findByText("No territory matches this account.")).toBeInTheDocument();
    await new Promise((r) => setTimeout(r, 100));
    await userEvent.click(screen.getByRole("button", { name: "Assign by territory" }));
    expect(await screen.findByText('Assigned by territory "East".')).toBeInTheDocument();
  });
});

describe("AccountDetailPage", () => {
  it("shows the profile, contacts, addresses and the timeline", async () => {
    detail(VIEW, []);
    expect(await screen.findByRole("heading", { name: "Acme Ltd" })).toBeInTheDocument();
    expect(await screen.findByText("Dawit Alem")).toBeInTheDocument();
    expect(await screen.findByText(/Bole Rd 1/)).toBeInTheDocument();
    expect(await screen.findByText("Order SO-1 confirmed (100 USD)")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Edit profile" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Change credit terms" })).not.toBeInTheDocument();
  });

  it("edits the profile and archives nothing unless asked", async () => {
    let body: Record<string, unknown> = {};
    detail(MANAGE, [http.patch("*/api/v1/crm/accounts/a1", async ({ request }) => { body = (await request.json()) as Record<string, unknown>; return HttpResponse.json(acct()); })]);
    await userEvent.click(await screen.findByRole("button", { name: "Edit profile" }));
    const d = within(await screen.findByRole("dialog", { name: "Edit profile" }));
    expect((d.getByLabelText("Name") as HTMLInputElement).value).toBe("Acme Ltd");
    await userEvent.type(d.getByLabelText("Classification"), "A");
    await userEvent.click(d.getByRole("button", { name: "Save profile" }));
    await waitFor(() => expect(body).toMatchObject({ name: "Acme Ltd", classification: "A", lifecycle_stage: "ACTIVE", is_active: true }));
  });

  it("credit terms need the assign permission, a reason when restricting, and a sane limit", async () => {
    let body: Record<string, unknown> = {};
    detail([...MANAGE, "crm.assign"], [http.post("*/api/v1/crm/accounts/a1/credit", async ({ request }) => { body = (await request.json()) as Record<string, unknown>; return HttpResponse.json(acct()); })]);
    await userEvent.click(await screen.findByRole("button", { name: "Change credit terms" }));
    const d = within(await screen.findByRole("dialog", { name: "Change credit terms" }));
    await userEvent.selectOptions(d.getByLabelText("Status"), "ON_HOLD");
    await userEvent.click(d.getByRole("button", { name: "Save credit terms" }));
    expect(await d.findByRole("alert")).toHaveTextContent("Give a reason");
    await userEvent.type(d.getByLabelText("Reason (needed unless status is OK)"), "Overdue invoices");
    await userEvent.type(d.getByLabelText("Credit limit"), "-5");
    await userEvent.click(d.getByRole("button", { name: "Save credit terms" }));
    expect(await d.findByRole("alert")).toHaveTextContent("positive amount");
    await userEvent.clear(d.getByLabelText("Credit limit"));
    await userEvent.type(d.getByLabelText("Credit limit"), "20000");
    await userEvent.click(d.getByRole("button", { name: "Save credit terms" }));
    await waitFor(() => expect(body).toEqual({ credit_status: "ON_HOLD", note: "Overdue invoices", credit_limit: "20000" }));
  });

  it("adds and removes an address, and shows a refusal", async () => {
    let added: Record<string, unknown> = {}; let removed = false;
    detail(MANAGE, [http.post("*/api/v1/crm/accounts/a1/addresses", async ({ request }) => { added = (await request.json()) as Record<string, unknown>; return HttpResponse.json({ id: "ad2" }, { status: 201 }); }),
      http.delete("*/api/v1/crm/addresses/ad1", () => { removed = true; return new HttpResponse(null, { status: 204 }); })]);
    await userEvent.click(await screen.findByRole("button", { name: "Add address" }));
    const d = within(await screen.findByRole("dialog", { name: "Add address" }));
    await userEvent.selectOptions(d.getByLabelText("Kind"), "DELIVERY");
    await userEvent.type(d.getByLabelText("Address"), "Warehouse 4");
    await userEvent.click(d.getByRole("button", { name: "Save address" }));
    await waitFor(() => expect(added).toMatchObject({ kind: "DELIVERY", line1: "Warehouse 4" }));
    await userEvent.click(await screen.findByRole("button", { name: "Remove Bole Rd 1" }));
    await waitFor(() => expect(removed).toBe(true));
  });

  it("adds a contact to this account", async () => {
    let body: Record<string, unknown> = {};
    detail(MANAGE, [http.post("*/api/v1/crm/contacts", async ({ request }) => { body = (await request.json()) as Record<string, unknown>; return HttpResponse.json(contact({ id: "c2" }), { status: 201 }); }),
      http.patch("*/api/v1/crm/contacts/c2", () => HttpResponse.json(contact()))]);
    await userEvent.click(await screen.findByRole("button", { name: "Add contact" }));
    const d = within(await screen.findByRole("dialog", { name: "New contact" }));
    await userEvent.type(d.getByLabelText("First name"), "Sara");
    await userEvent.type(d.getByLabelText("Email"), "not-an-email");
    await userEvent.click(d.getByRole("button", { name: "Add contact" }));
    expect(await d.findByRole("alert")).toHaveTextContent("valid email");
    await userEvent.clear(d.getByLabelText("Email"));
    await userEvent.type(d.getByLabelText("Email"), "sara@acme.io");
    await userEvent.click(d.getByRole("button", { name: "Add contact" }));
    await waitFor(() => expect(body).toMatchObject({ first_name: "Sara", email: "sara@acme.io", account: "a1" }));
  });
});

describe("ContactsPage", () => {
  it("lists contacts with their account, searches, and records consent and opt-outs", async () => {
    const sent: Record<string, unknown>[] = []; let q = ""; let lists = 0;
    server.use(http.get("*/api/v1/crm/accounts", () => page([acct()])),
      http.get("*/api/v1/crm/contacts", ({ request }) => { lists += 1; q = new URL(request.url).searchParams.get("q") ?? ""; return page([contact()]); }),
      http.post("*/api/v1/crm/contacts/c1/consent", async ({ request }) => { sent.push((await request.json()) as Record<string, unknown>); return HttpResponse.json(contact()); }));
    renderWithProviders(<ContactsPage />, { permissions: MANAGE });
    expect(await screen.findByText("Dawit Alem")).toBeInTheDocument();
    expect(await screen.findByRole("link", { name: "Acme Ltd" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Record email consent for Dawit Alem" }));
    await waitFor(() => expect(sent).toHaveLength(1));
    await waitFor(() => expect(lists).toBe(2)); // the list reloads after a change; click again only once it has settled
    await new Promise((r) => setTimeout(r, 50));
    await userEvent.click(await screen.findByRole("button", { name: "Opt out Dawit Alem" }));
    await waitFor(() => expect(sent).toEqual([{ email: true }, { opt_out: true }]));
    await userEvent.type(screen.getByLabelText("Search contacts"), "daw");
    await waitFor(() => expect(q).toBe("daw"));
  });

  it("offers to resume contact for someone who opted out, and is read-only for viewers", async () => {
    server.use(http.get("*/api/v1/crm/accounts", () => page([acct()])), http.get("*/api/v1/crm/contacts", () => page([contact({ consent: { email: false, phone: false, sms: false, opted_out: true } })])));
    const { unmount } = renderWithProviders(<ContactsPage />, { permissions: MANAGE });
    expect(await screen.findByRole("button", { name: "Resume contact with Dawit Alem" })).toBeInTheDocument();
    unmount();
    renderWithProviders(<ContactsPage />, { permissions: VIEW });
    expect(await screen.findByText("Opted out")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Resume/ })).not.toBeInTheDocument();
  });
});
