import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";

import * as auth from "../../shared/auth/authService";
import { renderWithProviders } from "../../test/utils";
import { NotificationBell, NotificationPreferencesPage, NotificationsPage, notificationLink } from "./NotificationsPage";

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
beforeEach(() => vi.spyOn(auth, "getAccessToken").mockResolvedValue("tok"));
afterEach(() => { server.resetHandlers(); vi.restoreAllMocks(); });
afterAll(() => server.close());

const N = (o = {}) => ({ id: "n1", type: "hr.leave.requested", title: "Leave request", body: "Sam asked for 2 days", ref_type: "", ref_id: "", created_at: "2026-11-20T08:00:00Z", read: false, ...o });
const list = (rows: object[], unread = rows.filter((r) => !(r as { read: boolean }).read).length, next: string | null = null) => HttpResponse.json({ results: rows, next, previous: null, unread_count: unread });

it("links only known subjects", () => {
  expect(notificationLink("", "")).toBeNull();
  expect(notificationLink("workflow_task", "abc")).toBe("/app/approvals");
  expect(notificationLink("leave", "abc")).toBeNull();
});

describe("bell", () => {
  it("shows the unread count", async () => {
    server.use(http.get("*/api/v1/notifications", () => list([N()], 3)));
    renderWithProviders(<NotificationBell />, {});
    expect(await screen.findByRole("link", { name: "Notifications, 3 unread" })).toBeInTheDocument();
  });
  it("shows no badge when nothing is unread", async () => {
    server.use(http.get("*/api/v1/notifications", () => list([], 0)));
    renderWithProviders(<NotificationBell />, {});
    expect(await screen.findByRole("link", { name: "Notifications" })).toBeInTheDocument();
  });
});

describe("NotificationsPage", () => {
  it("lists, marks one read, marks all read, and filters unread", async () => {
    let read: string[] = []; let allCalled = false; let lastQuery = "";
    server.use(
      http.get("*/api/v1/notifications", ({ request }) => { lastQuery = new URL(request.url).search; return list([N({ read: read.includes("n1") }), N({ id: "n2", title: "Old one", read: true })], 2); }),
      http.post("*/api/v1/notifications/n1/read", () => { read.push("n1"); return new HttpResponse(null, { status: 204 }); }),
      http.post("*/api/v1/notifications/read-all", () => { allCalled = true; return HttpResponse.json({ marked: 1 }); }),
    );
    renderWithProviders(<NotificationsPage />, {});
    expect(await screen.findByText("Leave request")).toBeInTheDocument();
    expect(screen.getByText("Old one")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Mark as read: Leave request" }));
    await waitFor(() => expect(read).toEqual(["n1"]));
    await userEvent.click(screen.getByLabelText("Unread only"));
    await waitFor(() => expect(lastQuery).toContain("unread=true"));
    await userEvent.click(screen.getByRole("button", { name: "Mark all as read" }));
    await waitFor(() => expect(allCalled).toBe(true));
  });
  it("shows an empty state", async () => {
    server.use(http.get("*/api/v1/notifications", () => list([], 0)));
    renderWithProviders(<NotificationsPage />, {});
    expect(await screen.findByText("No notifications yet")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Mark all as read" })).toBeDisabled();
  });
  it("follows the next cursor", async () => {
    let q = "";
    server.use(http.get("*/api/v1/notifications", ({ request }) => { q = new URL(request.url).search; return list([N()], 1, q.includes("cursor=c2") ? null : "http://h/api/v1/notifications?cursor=c2"); }));
    renderWithProviders(<NotificationsPage />, {});
    await userEvent.click(await screen.findByRole("button", { name: "Older" }));
    await waitFor(() => expect(q).toContain("cursor=c2"));
  });
});

describe("NotificationPreferencesPage", () => {
  it("defaults to on, saves a switch-off, and shows a server failure", async () => {
    let body: Record<string, unknown> | null = null; let fail = false;
    server.use(
      http.get("*/api/v1/notification-preferences", () => HttpResponse.json([{ notification_type: "crm.case.assigned", in_app: true, email: false }])),
      http.get("*/api/v1/notifications", () => list([N()])),
      http.put("*/api/v1/notification-preferences", async ({ request }) => { body = (await request.json()) as Record<string, unknown>; return fail ? HttpResponse.json({ error: { code: "invalid_type", message: "Invalid notification type." } }, { status: 400 }) : HttpResponse.json({ notification_type: body.notification_type, in_app: true, email: true }); }),
    );
    renderWithProviders(<NotificationPreferencesPage />, {});
    const leaveApp = await screen.findByLabelText("hr leave requested in the app");
    expect(leaveApp).toBeChecked();
    expect(screen.getByLabelText("crm case assigned by email")).not.toBeChecked();
    await userEvent.click(leaveApp);
    await waitFor(() => expect(body).toEqual({ notification_type: "hr.leave.requested", in_app: false }));
    fail = true;
    await userEvent.click(screen.getByLabelText("crm case assigned by email"));
    expect(await screen.findByText("Invalid notification type.")).toBeInTheDocument();
  });
  it("explains when there is nothing to set", async () => {
    server.use(http.get("*/api/v1/notification-preferences", () => HttpResponse.json([])), http.get("*/api/v1/notifications", () => list([], 0)));
    renderWithProviders(<NotificationPreferencesPage />, {});
    expect(await screen.findByText("Nothing to set yet")).toBeInTheDocument();
  });
});
