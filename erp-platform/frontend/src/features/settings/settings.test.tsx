import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";

import * as auth from "../../shared/auth/authService";
import { renderWithProviders } from "../../test/utils";
import { UsersPage } from "../users/UsersPage";
import { endOfDayIso, grantProblem } from "../users/RoleAssign";
import { ModulesPage, TenantSettingsPage, changedSettings, groupOf, settingLabel } from "./TenantSettingsPage";

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
beforeEach(() => vi.spyOn(auth, "getAccessToken").mockResolvedValue("tok"));
afterEach(() => { server.resetHandlers(); vi.restoreAllMocks(); });
afterAll(() => server.close());

const SET = { "sales.max_discount_percent": 10, "documents.auto_publish": false, "locale.date_format": "YYYY-MM-DD", "locale.timezone": "UTC" };

describe("helpers", () => {
  it("labels and groups settings", () => {
    expect(settingLabel("sales.max_discount_percent")).toBe("Max discount percent");
    expect(groupOf("supply_chain.fulfilment_days")).toBe("Supply chain");
  });
  it("keeps only changed values with the right types", () => {
    expect(changedSettings(SET, { "sales.max_discount_percent": "10", "documents.auto_publish": false })).toEqual({ values: {} });
    expect(changedSettings(SET, { "sales.max_discount_percent": "15", "documents.auto_publish": true, "locale.timezone": "Africa/Addis_Ababa" })).toEqual({ values: { "sales.max_discount_percent": 15, "documents.auto_publish": true, "locale.timezone": "Africa/Addis_Ababa" } });
    expect(changedSettings(SET, { "sales.max_discount_percent": "abc" })).toMatchObject({ problem: expect.stringMatching(/must be a number/) });
  });
  it("checks role grants", () => {
    expect(grantProblem("", "")).toMatch(/Choose a role/);
    expect(grantProblem("r1", "2020-01-01", "2026-11-22")).toMatch(/past/);
    expect(grantProblem("r1", "2026-12-01", "2026-11-22")).toBeNull();
    expect(endOfDayIso("")).toBeNull();
    expect(endOfDayIso("2026-12-01")).toMatch(/^2026-12-0[12]T/);
  });
});

describe("TenantSettingsPage", () => {
  it("saves only what changed and shows server refusals", async () => {
    let body: Record<string, unknown> | null = null; let refuse = true;
    server.use(
      http.get("*/api/v1/settings", () => HttpResponse.json(SET)),
      http.put("*/api/v1/settings", async ({ request }) => { body = (await request.json()) as Record<string, unknown>; return refuse ? HttpResponse.json({ error: { code: "invalid_setting", message: "Invalid value for 'sales.max_discount_percent'." } }, { status: 400 }) : HttpResponse.json({ ...SET, ...body }); }),
    );
    renderWithProviders(<TenantSettingsPage />, { permissions: ["org.settings.manage"] });
    const box = await screen.findByLabelText("Sales: Max discount percent");
    await userEvent.click(screen.getByRole("button", { name: "Save changes" }));
    expect(await screen.findByText("Nothing has changed.")).toBeInTheDocument();
    await userEvent.clear(box); await userEvent.type(box, "500");
    await userEvent.click(screen.getByRole("button", { name: "Save changes" }));
    expect(await screen.findByText(/Invalid value for/)).toBeInTheDocument();
    expect(body).toEqual({ "sales.max_discount_percent": 500 });
    refuse = false;
    await userEvent.click(screen.getByLabelText("Documents: Auto publish"));
    await userEvent.click(screen.getByRole("button", { name: "Save changes" }));
    expect(await screen.findByText("Settings saved.")).toBeInTheDocument();
    expect(body).toEqual({ "sales.max_discount_percent": 500, "documents.auto_publish": true });
  });
  it("rejects a non-number before calling the server", async () => {
    let hit = false;
    server.use(http.get("*/api/v1/settings", () => HttpResponse.json(SET)), http.put("*/api/v1/settings", () => { hit = true; return HttpResponse.json(SET); }));
    renderWithProviders(<TenantSettingsPage />, { permissions: ["org.settings.manage"] });
    const box = await screen.findByLabelText("Sales: Max discount percent");
    await userEvent.clear(box); await userEvent.type(box, "lots");
    await userEvent.click(screen.getByRole("button", { name: "Save changes" }));
    expect(await screen.findByText(/must be a number/)).toBeInTheDocument();
    expect(hit).toBe(false);
  });
});

describe("ModulesPage", () => {
  const MODS = [{ module: "finance", entitled: true, enabled: true }, { module: "manufacturing", entitled: false, enabled: false }, { module: "crm", entitled: true, enabled: false }];
  it("is read-only without modules.manage", async () => {
    server.use(http.get("*/api/v1/modules", () => HttpResponse.json(MODS)));
    renderWithProviders(<ModulesPage />, { permissions: ["modules.view"] });
    await screen.findByText("finance");
    expect(screen.getByText("Not in subscription")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Switch/ })).toBeNull();
  });
  it("switches modules and shows the server refusal", async () => {
    let body: Record<string, unknown> | null = null;
    server.use(http.get("*/api/v1/modules", () => HttpResponse.json(MODS)), http.patch("*/api/v1/modules", async ({ request }) => { body = (await request.json()) as Record<string, unknown>; return body.module === "crm" ? HttpResponse.json({ error: { code: "module_not_entitled", message: "This module is not part of the tenant's subscription." } }, { status: 403 }) : HttpResponse.json({ module: "finance", entitled: true, enabled: false }); }));
    renderWithProviders(<ModulesPage />, { permissions: ["modules.view", "modules.manage"] });
    expect(await screen.findByRole("button", { name: "Switch on manufacturing" })).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: "Switch off finance" }));
    await waitFor(() => expect(body).toEqual({ module: "finance", enabled: false }));
    await userEvent.click(screen.getByRole("button", { name: "Switch on crm" }));
    expect(await screen.findByText(/not part of the tenant's subscription/)).toBeInTheDocument();
  });
});

describe("role assignment on the Users page", () => {
  const member = { id: "m1", user_id: "u1", email: "bob@acme.test", display_name: "Bob", status: "ACTIVE", roles: [{ assignment_id: "as1", role: "Finance Manager", scope_type: "TENANT", scope_id: null, valid_to: null }], created_at: "2026-01-01T00:00:00Z" };
  const ROLES = [{ id: "r1", name: "viewer", display_name: "Viewer", is_system: true, permissions: [] }];
  it("needs roles.assign", async () => {
    server.use(http.get("*/api/v1/users", () => HttpResponse.json({ results: [member], next: null, previous: null })));
    renderWithProviders(<UsersPage />, { permissions: ["users.view"] });
    await screen.findByText("bob@acme.test");
    expect(screen.queryByRole("button", { name: /Manage roles/ })).toBeNull();
  });
  it("grants (with an end date), validates, removes, and shows server refusals", async () => {
    let grant: Record<string, unknown> | null = null; let revoked = ""; let refuse = false;
    server.use(
      http.get("*/api/v1/users", () => HttpResponse.json({ results: [member], next: null, previous: null })),
      http.get("*/api/v1/roles", () => HttpResponse.json(ROLES)),
      http.post("*/api/v1/role-assignments", async ({ request }) => { grant = (await request.json()) as Record<string, unknown>; return refuse ? HttpResponse.json({ error: { code: "delegation_ceiling", message: "You cannot grant a role with more access than your own." } }, { status: 403 }) : HttpResponse.json({ id: "x", role: "viewer", scope_type: "TENANT" }, { status: 201 }); }),
      http.delete("*/api/v1/role-assignments/as1", () => { revoked = "as1"; return new HttpResponse(null, { status: 204 }); }),
    );
    renderWithProviders(<UsersPage />, { permissions: ["users.view", "roles.assign"] });
    await userEvent.click(await screen.findByRole("button", { name: "Manage roles for Bob" }));
    const dlg = await screen.findByRole("dialog");
    expect(within(dlg).getByText(/Finance Manager · whole workspace/)).toBeInTheDocument();
    await userEvent.click(within(dlg).getByRole("button", { name: "Grant role" }));
    expect(await within(dlg).findByText("Choose a role.")).toBeInTheDocument();
    await within(dlg).findByRole("option", { name: "Viewer" });
    await userEvent.selectOptions(within(dlg).getByLabelText("Role"), "r1");
    refuse = true;
    await userEvent.click(within(dlg).getByRole("button", { name: "Grant role" }));
    expect(await within(dlg).findByText(/more access than your own/)).toBeInTheDocument();
    refuse = false;
    await userEvent.click(within(dlg).getByRole("button", { name: "Grant role" }));
    expect(await within(dlg).findByText("Role granted.")).toBeInTheDocument();
    expect(grant).toMatchObject({ membership_id: "m1", role_id: "r1" });
    await userEvent.click(within(dlg).getByRole("button", { name: "Remove Finance Manager" }));
    await waitFor(() => expect(revoked).toBe("as1"));
  });
});
