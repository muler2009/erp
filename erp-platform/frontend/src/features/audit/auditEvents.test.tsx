import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";

import * as auth from "../../shared/auth/authService";
import { renderWithProviders } from "../../test/utils";
import { EventOutboxPage, TenantAuditPage, metaText } from "./AuditEventsPages";

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
beforeEach(() => vi.spyOn(auth, "getAccessToken").mockResolvedValue("tok"));
afterEach(() => { server.resetHandlers(); vi.restoreAllMocks(); });
afterAll(() => server.close());

const emp = http.get("*/api/v1/hr/employees", () => HttpResponse.json({ results: [{ id: "e1", user_id: "u1", name: "Alice Admin" }], next: null, previous: null }));
const page = (rows: object[], extra = {}) => HttpResponse.json({ results: rows, next: null, previous: null, ...extra });

it("summarises event details", () => {
  expect(metaText({ role: "Viewer", user_id: "u1", empty: "" })).toBe("role: Viewer; user id: u1");
  expect(metaText(null)).toBe("");
  expect(metaText({ x: "y".repeat(300) }).length).toBeLessThanOrEqual(160);
});

describe("TenantAuditPage", () => {
  it("lists events with names and filters by action", async () => {
    let q = "";
    server.use(emp, http.get("*/api/v1/audit-events", ({ request }) => { q = new URL(request.url).search; return page([{ id: "1", created_at: "2026-11-20T08:00:00Z", action: "role.assigned", actor_user_id: "u1", target_type: "role_assignment", target_id: "x9", metadata: { role: "Viewer" }, correlation_id: "corr-1" }, { id: "2", created_at: "2026-11-20T09:00:00Z", action: "tenant.activated", actor_user_id: null, target_type: "", target_id: "", metadata: {}, correlation_id: "corr-2" }]); }));
    renderWithProviders(<TenantAuditPage />, { permissions: ["audit.view"] });
    expect(await screen.findByText("role.assigned")).toBeInTheDocument();
    expect(await screen.findByText("Alice Admin")).toBeInTheDocument();
    expect(screen.getByText("System")).toBeInTheDocument();
    expect(screen.getByText("role: Viewer")).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText(/Action/), "role.assigned");
    await userEvent.click(screen.getByRole("button", { name: "Filter" }));
    await waitFor(() => expect(q).toContain("action=role.assigned"));
  });
  it("shows the server error", async () => {
    server.use(emp, http.get("*/api/v1/audit-events", () => HttpResponse.json({ error: { code: "permission_denied", message: "Not allowed." } }, { status: 403 })));
    renderWithProviders(<TenantAuditPage />, { permissions: ["audit.view"] });
    expect(await screen.findByRole("alert")).toHaveTextContent("Not allowed.");
  });
});

describe("EventOutboxPage", () => {
  const rows = [{ id: "d1", type: "finance.invoice.posted", version: 1, status: "DEAD", attempts: 5, last_error: "broker down", created_at: "2026-11-20T08:00:00Z", published_at: null }, { id: "p1", type: "hr.employee.created", version: 1, status: "PUBLISHED", attempts: 1, last_error: "", created_at: "2026-11-20T08:00:00Z", published_at: "2026-11-20T08:01:00Z" }];
  const stats = { pending: 2, dead: 1, oldest_pending_age_seconds: 300 };
  it("shows counts, retries only failed events, and shows refusals", async () => {
    let status = ""; let retried = ""; let refuse = true;
    server.use(
      http.get("*/api/v1/events", ({ request }) => { status = new URL(request.url).searchParams.get("status") ?? ""; return page(rows, { stats }); }),
      http.post("*/api/v1/events/d1/retry", () => { retried = "d1"; return refuse ? HttpResponse.json({ error: { code: "invalid_state_transition", message: "Only dead-lettered events can be retried." } }, { status: 400 }) : HttpResponse.json(rows[0]); }),
    );
    renderWithProviders(<EventOutboxPage />, { permissions: ["events.manage"] });
    expect(await screen.findByText("finance.invoice.posted v1")).toBeInTheDocument();
    expect(screen.getByText(/oldest 5 min/)).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: /^Retry/ })).toHaveLength(1);
    await userEvent.click(screen.getByRole("button", { name: "Retry finance.invoice.posted" }));
    expect(await screen.findByText(/Only dead-lettered/)).toBeInTheDocument();
    refuse = false;
    await userEvent.click(screen.getByRole("button", { name: "Retry finance.invoice.posted" }));
    await waitFor(() => expect(screen.queryByText(/Only dead-lettered/)).toBeNull());
    await userEvent.selectOptions(screen.getByLabelText("Show"), "DEAD");
    await waitFor(() => expect(status).toBe("DEAD"));
    expect(retried).toBe("d1");
  });
  it("hides Retry without events.manage", async () => {
    server.use(http.get("*/api/v1/events", () => page(rows, { stats })));
    renderWithProviders(<EventOutboxPage />, { permissions: [] });
    await screen.findByText("finance.invoice.posted v1");
    expect(screen.queryByRole("button", { name: /^Retry/ })).toBeNull();
  });
});
