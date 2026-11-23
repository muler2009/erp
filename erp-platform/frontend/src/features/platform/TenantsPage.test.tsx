import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";

import * as auth from "../../shared/auth/authService";
import { renderWithProviders } from "../../test/utils";
import { TenantsPage, tenantSchema } from "./TenantsPage";

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
beforeEach(() => { vi.spyOn(auth, "getAccessToken").mockResolvedValue("tok"); });
afterEach(() => { server.resetHandlers(); vi.restoreAllMocks(); });
afterAll(() => server.close());

const tenant = (over = {}) => ({ id: "t1", name: "Acme", slug: "acme", status: "ACTIVE", plan: "standard", suspension_policy: "READ_ONLY", created_at: "2026-01-01T00:00:00Z", retention_until: null, ...over });
const list = (rows: unknown[]) => http.get("*/api/v1/platform/tenants", () => HttpResponse.json({ results: rows, next: null, previous: null }));

describe("tenantSchema", () => {
  it("validates the slug", () => {
    const ok = { name: "A", slug: "acme-co", plan: "standard", admin_email: "a@b.co", admin_display_name: "A" };
    expect(tenantSchema.safeParse(ok).success).toBe(true);
    for (const slug of ["A", "ab", "9acme", "acme_co", "-acme"]) expect(tenantSchema.safeParse({ ...ok, slug }).success).toBe(false);
  });
});

describe("TenantsPage", () => {
  it("offers lifecycle actions by status and permission", async () => {
    server.use(list([tenant(), tenant({ id: "t2", name: "Beta", status: "PROVISIONING_FAILED" })]));
    renderWithProviders(<TenantsPage />, { permissions: ["platform.tenants.view", "platform.tenants.lifecycle", "platform.tenants.provision"] });
    expect(await screen.findByRole("button", { name: "Suspend Acme" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry provisioning Beta" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Create tenant" })).toBeNull();
  });

  it("hides actions without the lifecycle permission", async () => {
    server.use(list([tenant()]));
    renderWithProviders(<TenantsPage />, { permissions: ["platform.tenants.view"] });
    await screen.findByText("Acme");
    expect(screen.queryByRole("button", { name: /Suspend/ })).toBeNull();
  });

  it("suspends a tenant", async () => {
    let hit = false;
    server.use(list([tenant()]), http.post("*/api/v1/platform/tenants/t1/lifecycle/suspend", () => { hit = true; return HttpResponse.json(tenant({ status: "SUSPENDED" })); }));
    renderWithProviders(<TenantsPage />, { permissions: ["platform.tenants.view", "platform.tenants.lifecycle"] });
    await userEvent.click(await screen.findByRole("button", { name: "Suspend Acme" }));
    await waitFor(() => expect(hit).toBe(true));
  });

  it("creates a tenant with an idempotency key", async () => {
    let key = ""; let body: unknown;
    server.use(list([]), http.post("*/api/v1/platform/tenants", async ({ request }) => { key = request.headers.get("idempotency-key") ?? ""; body = await request.json(); return HttpResponse.json({ tenant: tenant(), job: {} }, { status: 201 }); }));
    renderWithProviders(<TenantsPage />, { permissions: ["platform.tenants.view", "platform.tenants.create"] });
    await userEvent.click(await screen.findByRole("button", { name: "Create tenant" }));
    await userEvent.click(document.querySelector("form button[type=submit]")!);
    expect(await screen.findByText("Name is required")).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText("Company name"), "Initech");
    await userEvent.type(screen.getByLabelText("Short name (used in the address)"), "initech");
    await userEvent.type(screen.getByLabelText("Administrator name"), "Bill");
    await userEvent.type(screen.getByLabelText("Administrator email"), "bill@initech.test");
    await userEvent.click(document.querySelector("form button[type=submit]")!);
    await waitFor(() => expect(body).toMatchObject({ slug: "initech", admin_email: "bill@initech.test", plan: "standard" }));
    expect(key).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("shows server errors from an action", async () => {
    server.use(list([tenant()]), http.post("*/api/v1/platform/tenants/t1/lifecycle/suspend", () => HttpResponse.json({ error: { code: "invalid_state_transition", message: "Cannot suspend.", details: [] } }, { status: 409 })));
    renderWithProviders(<TenantsPage />, { permissions: ["platform.tenants.view", "platform.tenants.lifecycle"] });
    await userEvent.click(await screen.findByRole("button", { name: "Suspend Acme" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Cannot suspend.");
  });
});

describe("resend setup email", () => {
  it("shows only for active tenants with the provision permission", async () => {
    server.use(list([tenant(), tenant({ id: "t2", name: "Beta", status: "SUSPENDED" })]));
    const { unmount } = renderWithProviders(<TenantsPage />, { permissions: ["platform.tenants.view", "platform.tenants.provision"] });
    expect(await screen.findByRole("button", { name: "Resend setup email Acme" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Resend setup email Beta" })).toBeNull();
    expect(screen.queryByRole("button", { name: /Suspend/ })).toBeNull();
    unmount();
    renderWithProviders(<TenantsPage />, { permissions: ["platform.tenants.view", "platform.tenants.lifecycle"] });
    await screen.findByRole("button", { name: "Suspend Acme" });
    expect(screen.queryByRole("button", { name: /Resend setup email/ })).toBeNull();
  });
  it("confirms on success and shows the server message on failure", async () => {
    let fail = true;
    server.use(list([tenant()]), http.post("*/api/v1/platform/tenants/t1/resend-admin-setup", () => fail
      ? HttpResponse.json({ error: { code: "identity_mail_failed", message: "The identity provider could not send the email.", details: [] } }, { status: 400 })
      : HttpResponse.json({ sent: true })));
    renderWithProviders(<TenantsPage />, { permissions: ["platform.tenants.view", "platform.tenants.provision"] });
    await userEvent.click(await screen.findByRole("button", { name: "Resend setup email Acme" }));
    expect(await screen.findByText(/could not send the email/)).toBeInTheDocument();
    fail = false;
    await userEvent.click(screen.getByRole("button", { name: "Resend setup email Acme" }));
    expect(await screen.findByText(/Setup email sent again to the administrator of Acme/)).toBeInTheDocument();
    expect(screen.queryByText(/could not send the email/)).toBeNull();
  });
});
