import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";

import * as auth from "../../shared/auth/authService";
import { renderWithProviders } from "../../test/utils";
import { InboxPage } from "./InboxPage";
import { RequestsPage } from "./RequestsPage";

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
beforeEach(() => { vi.spyOn(auth, "getAccessToken").mockResolvedValue("tok"); });
afterEach(() => { server.resetHandlers(); vi.restoreAllMocks(); });
afterAll(() => server.close());

const page = (rows: unknown[]) => HttpResponse.json({ results: rows, next: null, previous: null });
const task = { id: "t1", instance_id: "w1", subject_type: "FINANCE_INVOICE", subject_id: "i1", title: "Approve invoice INV-9", amount: "115.0000", stage_order: 1, status: "PENDING", due_at: null, requester_id: "u2" };
const instance = (over = {}) => ({ id: "w1", subject_type: "FINANCE_INVOICE", subject_id: "i1", title: "Approve invoice INV-9", amount: "115.0000", status: "PENDING", round: 1, requester_id: "u1", definition: "inv@v1", created_at: "2026-01-01T00:00:00Z", completed_at: null, tasks: [], history: [{ action: "SUBMITTED", actor_id: "u2", round: 1, stage_order: null, comment: "Please approve", at: "2026-01-01T00:00:00Z" }], ...over });

describe("InboxPage", () => {
  it("shows an empty state", async () => {
    server.use(http.get("*/api/v1/workflows/inbox", () => page([])));
    renderWithProviders(<InboxPage />);
    expect(await screen.findByText("Nothing is waiting for you")).toBeInTheDocument();
  });

  it("opens a request with its history and approves it", async () => {
    let body: any;
    server.use(
      http.get("*/api/v1/workflows/inbox", () => page([task])),
      http.get("*/api/v1/workflows/instances/w1", () => HttpResponse.json(instance())),
      http.post("*/api/v1/workflows/tasks/t1/decide", async ({ request }) => { body = await request.json(); return HttpResponse.json(instance({ status: "APPROVED" })); }),
    );
    renderWithProviders(<InboxPage />);
    await userEvent.click(await screen.findByRole("button", { name: "Review Approve invoice INV-9" }));
    expect(await screen.findByText("Please approve")).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText("Comment"), "Looks right");
    await userEvent.click(screen.getByRole("button", { name: "Approve" }));
    await waitFor(() => expect(body).toEqual({ decision: "APPROVE", comment: "Looks right" }));
  });

  it("requires a reason to reject and sends nothing without one", async () => {
    let called = false;
    server.use(
      http.get("*/api/v1/workflows/inbox", () => page([task])),
      http.get("*/api/v1/workflows/instances/w1", () => HttpResponse.json(instance())),
      http.post("*/api/v1/workflows/tasks/t1/decide", () => { called = true; return HttpResponse.json(instance()); }),
    );
    renderWithProviders(<InboxPage />);
    await userEvent.click(await screen.findByRole("button", { name: /Review/ }));
    await userEvent.click(await screen.findByRole("button", { name: "Reject" }));
    expect(await screen.findByText("Please explain your decision.")).toBeInTheDocument();
    expect(called).toBe(false);
  });

  it("shows the server's refusal (e.g. self-approval) and keeps the dialog open", async () => {
    server.use(
      http.get("*/api/v1/workflows/inbox", () => page([task])),
      http.get("*/api/v1/workflows/instances/w1", () => HttpResponse.json(instance())),
      http.post("*/api/v1/workflows/tasks/t1/decide", () => HttpResponse.json({ error: { code: "separation_of_duties", message: "You cannot approve your own request.", details: [] } }, { status: 403 })),
    );
    renderWithProviders(<InboxPage />);
    await userEvent.click(await screen.findByRole("button", { name: /Review/ }));
    await userEvent.click(await screen.findByRole("button", { name: "Approve" }));
    expect(await screen.findByText("You cannot approve your own request.")).toBeInTheDocument();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });
});

describe("RequestsPage", () => {
  it("lets only the requester cancel a pending request", async () => {
    let cancelled = false;
    server.use(
      http.get("*/api/v1/workflows/instances", () => page([instance()])),
      http.get("*/api/v1/workflows/instances/w1", () => HttpResponse.json(instance())),
      http.post("*/api/v1/workflows/instances/w1/cancel", () => { cancelled = true; return HttpResponse.json(instance({ status: "CANCELLED" })); }),
    );
    const { unmount } = renderWithProviders(<RequestsPage currentUserId="someone-else" />);
    await userEvent.click(await screen.findByRole("button", { name: "Approve invoice INV-9" }));
    await screen.findByText("Please approve");
    expect(screen.queryByRole("button", { name: "Cancel request" })).toBeNull();
    unmount();

    renderWithProviders(<RequestsPage currentUserId="u1" />);
    await userEvent.click(await screen.findByRole("button", { name: "Approve invoice INV-9" }));
    await userEvent.click(await screen.findByRole("button", { name: "Cancel request" }));
    await waitFor(() => expect(cancelled).toBe(true));
  });

  it("filters by status through the API", async () => {
    let seen = "";
    server.use(http.get("*/api/v1/workflows/instances", ({ request }) => { seen = new URL(request.url).search; return page([]); }));
    renderWithProviders(<RequestsPage currentUserId="u1" />);
    await userEvent.selectOptions(await screen.findByLabelText("Status"), "APPROVED");
    await waitFor(() => expect(seen).toContain("status=APPROVED"));
  });
});

describe("delegation and resubmit", () => {
  const dir = http.get("*/api/v1/directory/users", ({ request }) => {
    const q = new URL(request.url).searchParams.get("q") ?? "";
    return HttpResponse.json({ results: q.toLowerCase().startsWith("ca") ? [{ id: "u-carol", display_name: "Carol Ng" }] : [] });
  });

  it("delegates to a colleague found by name", async () => {
    let body: any;
    server.use(
      http.get("*/api/v1/workflows/inbox", () => page([task])),
      http.get("*/api/v1/workflows/instances/w1", () => HttpResponse.json(instance())),
      dir,
      http.post("*/api/v1/workflows/tasks/t1/delegate", async ({ request }) => { body = await request.json(); return new HttpResponse(null, { status: 201 }); }),
    );
    renderWithProviders(<InboxPage />);
    await userEvent.click(await screen.findByRole("button", { name: /Review/ }));
    await userEvent.click(await screen.findByRole("button", { name: "Delegate" }));
    await userEvent.click(screen.getByRole("button", { name: "Confirm delegation" }));
    expect(await screen.findByText("Choose a colleague to delegate to.")).toBeInTheDocument();
    expect(body).toBeUndefined();
    await userEvent.type(screen.getByRole("combobox"), "Ca");
    await userEvent.click(await screen.findByRole("button", { name: "Carol Ng" }, { timeout: 2000 }));
    await userEvent.click(screen.getByRole("button", { name: "Confirm delegation" }));
    await waitFor(() => expect(body).toEqual({ to_user_id: "u-carol", comment: "" }));
  });

  it("does not search for a single character", async () => {
    let calls = 0;
    server.use(
      http.get("*/api/v1/workflows/inbox", () => page([task])),
      http.get("*/api/v1/workflows/instances/w1", () => HttpResponse.json(instance())),
      http.get("*/api/v1/directory/users", () => { calls++; return HttpResponse.json({ results: [] }); }),
    );
    renderWithProviders(<InboxPage />);
    await userEvent.click(await screen.findByRole("button", { name: /Review/ }));
    await userEvent.click(await screen.findByRole("button", { name: "Delegate" }));
    await userEvent.type(screen.getByRole("combobox"), "C");
    await new Promise((r) => setTimeout(r, 400));
    expect(calls).toBe(0);
  });

  it("lets the requester resubmit after changes were requested", async () => {
    let body: any;
    const changes = instance({ status: "CHANGES_REQUESTED", requester_id: "u1" });
    server.use(
      http.get("*/api/v1/workflows/instances", () => page([changes])),
      http.get("*/api/v1/workflows/instances/w1", () => HttpResponse.json(changes)),
      http.post("*/api/v1/workflows/instances/w1/resubmit", async ({ request }) => { body = await request.json(); return HttpResponse.json(instance({ round: 2 })); }),
    );
    renderWithProviders(<RequestsPage currentUserId="u1" />);
    await userEvent.click(await screen.findByRole("button", { name: "Approve invoice INV-9" }));
    await userEvent.type(await screen.findByLabelText("Updated amount (optional)"), "100.505");
    await userEvent.click(screen.getByRole("button", { name: "Resubmit" }));
    expect(await screen.findByText("Enter the amount with at most 2 decimals.")).toBeInTheDocument();
    expect(body).toBeUndefined();
    await userEvent.clear(screen.getByLabelText("Updated amount (optional)"));
    await userEvent.type(screen.getByLabelText("Updated amount (optional)"), "100.50");
    await userEvent.type(screen.getByLabelText("Comment"), "Fixed price");
    await userEvent.click(screen.getByRole("button", { name: "Resubmit" }));
    await waitFor(() => expect(body).toEqual({ comment: "Fixed price", amount: "100.50" }));
  });

  it("hides resubmit from people who did not submit the request", async () => {
    const changes = instance({ status: "CHANGES_REQUESTED", requester_id: "u1" });
    server.use(http.get("*/api/v1/workflows/instances", () => page([changes])), http.get("*/api/v1/workflows/instances/w1", () => HttpResponse.json(changes)));
    renderWithProviders(<RequestsPage currentUserId="other" />);
    await userEvent.click(await screen.findByRole("button", { name: "Approve invoice INV-9" }));
    await screen.findByText("Please approve");
    expect(screen.queryByRole("button", { name: "Resubmit" })).toBeNull();
  });
});
