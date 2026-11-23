import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";

import * as auth from "../../shared/auth/authService";
import { renderWithProviders } from "../../test/utils";
import { DocumentAdminPage } from "./DocumentAdminPage";

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
beforeEach(() => vi.spyOn(auth, "getAccessToken").mockResolvedValue("tok"));
afterEach(() => { server.resetHandlers(); vi.restoreAllMocks(); });
afterAll(() => server.close());

const page = (rows: object[]) => HttpResponse.json({ results: rows, next: null, previous: null });
const base = () => server.use(
  http.get("*/api/v1/documents/categories", () => page([])),
  http.get("*/api/v1/documents/classifications", () => HttpResponse.json([])),
  http.get("*/api/v1/documents/folders", () => page([{ id: "f1", name: "HSE", parent: null, is_active: true }])),
  http.get("*/api/v1/hr/employees", () => page([{ id: "e1", user_id: "u1", name: "Alice Admin" }])),
  http.get("*/api/v1/org/departments", () => page([{ id: "d1", name: "Safety" }])),
  http.get("*/api/v1/roles", () => HttpResponse.json([])),
);

describe("folder access grants", () => {
  it("gives access to a folder, lists it, and withdraws it", async () => {
    let body: Record<string, unknown> | null = null; let revoked = "";
    base();
    server.use(
      http.post("*/api/v1/documents/folders/f1/grants", async ({ request }) => { body = (await request.json()) as Record<string, unknown>; return HttpResponse.json({ id: "g1", document: null, folder: "f1", subject_type: "DEPARTMENT", subject_id: "d1", actions: ["VIEW"], expires_at: null, revoked_at: null }, { status: 201 }); }),
      http.delete("*/api/v1/documents/grants/g1", () => { revoked = "g1"; return new HttpResponse(null, { status: 204 }); }),
    );
    renderWithProviders(<DocumentAdminPage />, { permissions: ["documents.admin"] });
    await userEvent.click(await screen.findByRole("button", { name: "Give access to folder HSE" }));
    const dlg = await screen.findByRole("dialog");
    await userEvent.click(within(dlg).getByRole("button", { name: "Give access" }));
    expect(await within(dlg).findByText("Choose who gets access.")).toBeInTheDocument();
    await userEvent.selectOptions(within(dlg).getByLabelText("Send to"), "DEPARTMENT");
    await within(dlg).findByRole("option", { name: "Safety" });
    await userEvent.selectOptions(within(dlg).getByLabelText("Who"), "d1");
    await userEvent.click(within(dlg).getByRole("button", { name: "Give access" }));
    await waitFor(() => expect(body).toEqual({ subject_type: "DEPARTMENT", subject_id: "d1", actions: ["VIEW"] }));
    expect(await screen.findByText(/Access given in this session/)).toBeInTheDocument();
    expect(screen.getByText(/HSE: Safety \(See\)/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Withdraw folder access of Safety" }));
    await waitFor(() => expect(revoked).toBe("g1"));
    await waitFor(() => expect(screen.queryByText(/Access given in this session/)).toBeNull());
  });
  it("shows the server refusal in the dialog", async () => {
    base();
    server.use(http.post("*/api/v1/documents/folders/f1/grants", () => HttpResponse.json({ error: { code: "invalid_actions", message: "actions must be from VIEW, DOWNLOAD." } }, { status: 400 })));
    renderWithProviders(<DocumentAdminPage />, { permissions: ["documents.admin"] });
    await userEvent.click(await screen.findByRole("button", { name: "Give access to folder HSE" }));
    const dlg = await screen.findByRole("dialog");
    await userEvent.selectOptions(within(dlg).getByLabelText("Send to"), "DEPARTMENT");
    await within(dlg).findByRole("option", { name: "Safety" });
    await userEvent.selectOptions(within(dlg).getByLabelText("Who"), "d1");
    await userEvent.click(within(dlg).getByRole("button", { name: "Give access" }));
    expect(await within(dlg).findByText(/actions must be from/)).toBeInTheDocument();
  });
});
