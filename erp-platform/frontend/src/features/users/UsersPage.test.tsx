import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";

import * as auth from "../../shared/auth/authService";
import { renderWithProviders } from "../../test/utils";
import { UsersPage, inviteSchema } from "./UsersPage";

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
beforeEach(() => { vi.spyOn(auth, "getAccessToken").mockResolvedValue("tok"); });
afterEach(() => { server.resetHandlers(); vi.restoreAllMocks(); });
afterAll(() => server.close());

const member = (over = {}) => ({ id: "m1", user_id: "u1", email: "bob@acme.test", display_name: "Bob", status: "ACTIVE", roles: [{ assignment_id: "a", role: "Finance Manager", scope_type: "TENANT", scope_id: null, valid_to: null }], created_at: "2026-01-01T00:00:00Z", ...over });
const roles = [{ id: "r1", name: "viewer", display_name: "Viewer", is_system: true, permissions: [] }];

describe("inviteSchema", () => {
  it("requires email, name and a role", () => {
    expect(inviteSchema.safeParse({ email: "x", display_name: "", role_ids: [] }).success).toBe(false);
    expect(inviteSchema.safeParse({ email: "a@b.co", display_name: "A", role_ids: ["r1"] }).success).toBe(true);
  });
});

describe("UsersPage", () => {
  it("lists users and hides write actions without permission", async () => {
    server.use(http.get("*/api/v1/users", () => HttpResponse.json({ results: [member()], next: null, previous: null })));
    renderWithProviders(<UsersPage />, { permissions: ["users.view"] });
    expect(await screen.findByText("bob@acme.test")).toBeInTheDocument();
    expect(screen.getByText("Finance Manager")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Invite user" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Deactivate" })).toBeNull();
  });

  it("shows the server error", async () => {
    server.use(http.get("*/api/v1/users", () => HttpResponse.json({ error: { code: "permission_denied", message: "Not allowed.", details: [] } }, { status: 403 })));
    renderWithProviders(<UsersPage />, { permissions: ["users.view"] });
    expect(await screen.findByRole("alert")).toHaveTextContent("Not allowed.");
  });

  it("deactivates a user", async () => {
    let hit = false;
    server.use(
      http.get("*/api/v1/users", () => HttpResponse.json({ results: [member()], next: null, previous: null })),
      http.post("*/api/v1/users/m1/deactivate", () => { hit = true; return HttpResponse.json({}); }),
    );
    renderWithProviders(<UsersPage />, { permissions: ["users.view", "users.deactivate"] });
    await userEvent.click(await screen.findByRole("button", { name: "Deactivate" }));
    await waitFor(() => expect(hit).toBe(true));
  });

  it("validates then submits the invite form", async () => {
    let body: unknown;
    server.use(
      http.get("*/api/v1/users", () => HttpResponse.json({ results: [], next: null, previous: null })),
      http.get("*/api/v1/roles", () => HttpResponse.json(roles)),
      http.post("*/api/v1/users/invite", async ({ request }) => { body = await request.json(); return HttpResponse.json(member(), { status: 201 }); }),
    );
    renderWithProviders(<UsersPage />, { permissions: ["users.view", "users.create"] });
    await userEvent.click(await screen.findByRole("button", { name: "Invite user" }));
    await userEvent.click(screen.getByRole("button", { name: "Send invitation" }));
    expect(await screen.findByText("Enter a valid email address")).toBeInTheDocument();
    expect(body).toBeUndefined();

    await userEvent.type(screen.getByLabelText("Email"), "new@acme.test");
    await userEvent.type(screen.getByLabelText("Display name"), "New Person");
    await userEvent.click(await screen.findByLabelText("Viewer"));
    await userEvent.click(screen.getByRole("button", { name: "Send invitation" }));
    await waitFor(() => expect(body).toEqual({ email: "new@acme.test", display_name: "New Person", role_ids: ["r1"] }));
  });

  it("maps server field errors onto the form", async () => {
    server.use(
      http.get("*/api/v1/users", () => HttpResponse.json({ results: [], next: null, previous: null })),
      http.get("*/api/v1/roles", () => HttpResponse.json(roles)),
      http.post("*/api/v1/users/invite", () => HttpResponse.json({ error: { code: "validation_error", message: "Invalid.", details: [{ field: "email", code: "duplicate", message: "Already a member" }] } }, { status: 400 })),
    );
    renderWithProviders(<UsersPage />, { permissions: ["users.view", "users.create"] });
    await userEvent.click(await screen.findByRole("button", { name: "Invite user" }));
    await userEvent.type(screen.getByLabelText("Email"), "dup@acme.test");
    await userEvent.type(screen.getByLabelText("Display name"), "Dup");
    await userEvent.click(await screen.findByLabelText("Viewer"));
    await userEvent.click(screen.getByRole("button", { name: "Send invitation" }));
    expect(await screen.findByText("Already a member")).toBeInTheDocument();
  });
});
