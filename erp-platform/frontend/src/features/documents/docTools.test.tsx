import { fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { Route, Routes } from "react-router";

import * as auth from "../../shared/auth/authService";
import { renderWithProviders } from "../../test/utils";
import { DisposalPage } from "./DisposalPage";
import { DocumentDetailPage } from "./DocumentDetailPage";
import { DocumentTools, grantProblem, linkProblem, retentionProblem, reviewProblem, shareProblem } from "./DocumentTools";
import { DocumentsPage } from "./DocumentsPage";
import { FavouritesPage } from "./FavouritesPage";

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
beforeEach(() => vi.spyOn(auth, "getAccessToken").mockResolvedValue("tok"));
afterEach(() => { server.resetHandlers(); vi.restoreAllMocks(); });
afterAll(() => server.close());

const page = (rows: object[], next: string | null = null) => HttpResponse.json({ results: rows, next, previous: null });
const row = (o = {}) => ({ id: "d1", reference: "POL-0001", title: "Safety policy", status: "PUBLISHED", category: "c1", category_name: "Policy", classification: "INTERNAL", owner: "u1", folder: null, tags: [], current_version: { id: "v1", label: "1.0", file_name: "p.pdf", published_at: "2026-11-01" }, effective_date: null, expiry_date: null, next_review_date: null, expired: false, review_overdue: false, legal_hold: false, is_obsolete: false, is_template: false, pending_revision: null, ...o });
const doc = (o = {}) => ({ ...row(), description: "", origin: "", versions: [], links: [], related: [], retention_until: null, can: { edit: true, publish: true, archive: true, review: true, upload: true }, ...o });
const FAVS = (rows: object[] = []) => http.get("*/api/v1/documents/favourites", () => page(rows));
const staff = http.get("*/api/v1/hr/employees", () => page([{ id: "e1", employee_no: "E1", name: "Abel", user_id: "u1", status: "ACTIVE" }]));
const depts = http.get("*/api/v1/org/departments", () => page([{ id: "dp1", name: "Finance" }]));
const roles = http.get("*/api/v1/roles", () => HttpResponse.json([{ id: "r1", name: "qa_manager", display_name: "QA Manager", is_system: false, permissions: [] }]));
const ALL = ["documents.view", "documents.admin", "documents.create", "documents.distribute", "documents.disposal.approve"];
const tools = (d: object, perms = ALL) => renderWithProviders(<DocumentTools doc={d as never} />, { permissions: perms });

describe("helpers", () => {
  it("validate", () => {
    expect(reviewProblem("", "")).toMatch(/outcome/);
    expect(reviewProblem("OBSOLETE", " ")).toMatch(/what needs/);
    expect(reviewProblem("NO_CHANGE", "")).toBeNull();
    expect(retentionProblem("", "", null)).toMatch(/Set a retention/);
    expect(retentionProblem("2026-01-01", "", "2027-01-01")).toMatch(/not shortened/);
    expect(retentionProblem("2028-01-01", "", "2027-01-01")).toBeNull();
    expect(retentionProblem("", "yes", null)).toBeNull();
    expect(grantProblem("", ["VIEW"], "", "2026-11-21")).toMatch(/who/);
    expect(grantProblem("u", [], "", "2026-11-21")).toMatch(/at least one/);
    expect(grantProblem("u", ["VIEW"], "2026-11-21", "2026-11-21")).toMatch(/future/);
    expect(grantProblem("u", ["VIEW"], "2026-12-01", "2026-11-21")).toBeNull();
    expect(linkProblem("", "x")).toMatch(/kind/);
    expect(linkProblem("TASK", " ")).toMatch(/identifier/);
    expect(linkProblem("TASK", "t1")).toBeNull();
    expect(shareProblem("", "")).toMatch(/who/i);
    expect(shareProblem("USER", "")).toMatch(/Choose the/);
    expect(shareProblem("USER", "u1")).toBeNull();
  });
});

describe("DocumentTools: lifecycle", () => {
  it("offers only what the document's state and rights allow", () => {
    server.use(FAVS());
    tools(doc({ status: "DRAFT", can: { edit: false } }), ["documents.view"]);
    expect(screen.queryByText("Lifecycle and retention")).toBeNull();
    expect(screen.queryByRole("button", { name: "Add link" })).toBeNull();
    expect(screen.queryByText("Who has been given access")).toBeNull();
    expect(screen.queryByRole("button", { name: "Send to people" })).toBeNull();
  });

  it("marks obsolete with a reason and replacement; refusal is shown", async () => {
    let body: unknown = null;
    server.use(FAVS(), http.get("*/api/v1/documents/documents", () => page([row(), row({ id: "d2", reference: "POL-0002", title: "New policy" })])), http.get("*/api/v1/documents/documents/d1/grants", () => HttpResponse.json([])), staff, depts, roles,
      http.post("*/api/v1/documents/documents/d1/obsolete", async ({ request }) => { body = await request.json(); return HttpResponse.json({ error: { code: "invalid_state_transition", message: "Only a published document can be made obsolete." } }, { status: 409 }); }));
    tools(doc());
    await userEvent.click(screen.getByRole("button", { name: "Mark obsolete" }));
    await userEvent.click(screen.getAllByRole("button", { name: "Mark obsolete" }).at(-1) as HTMLElement);
    expect(await screen.findByText("Reason is required.")).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText("Reason"), "Superseded");
    await waitFor(() => expect(screen.getByRole("option", { name: "POL-0002 — New policy" })).toBeInTheDocument());
    expect(screen.queryByRole("option", { name: /POL-0001/ })).toBeNull();
    await userEvent.selectOptions(screen.getByLabelText("Replaced by (optional)"), "d2");
    await userEvent.click((screen.getAllByRole("button", { name: "Mark obsolete" }).at(-1)) as HTMLElement);
    expect(await screen.findByText("Only a published document can be made obsolete.")).toBeInTheDocument();
    expect(body).toEqual({ reason: "Superseded", replaced_by: "d2" });
  });

  it("archive only for obsolete/expired; retention checks; disposal for archived", async () => {
    const calls: [string, unknown][] = [];
    const rec = (name: string) => async ({ request }: { request: Request }) => { calls.push([name, await request.json()]); return HttpResponse.json({}); };
    server.use(FAVS(), http.get("*/api/v1/documents/documents/d1/grants", () => HttpResponse.json([])), staff, depts, roles,
      http.post("*/api/v1/documents/documents/d1/retention", rec("retention")), http.post("*/api/v1/documents/documents/d1/archive", rec("archive")), http.post("*/api/v1/documents/disposals", rec("disposal")));
    const { unmount } = tools(doc({ status: "PUBLISHED" }));
    expect(screen.queryByRole("button", { name: "Archive" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Request disposal" })).toBeNull();
    unmount();
    tools(doc({ status: "OBSOLETE", retention_until: "2027-01-01" }));
    await userEvent.click(screen.getByRole("button", { name: "Retention and legal hold" }));
    await userEvent.click(screen.getAllByRole("button", { name: "Save" }).at(-1) as HTMLElement);
    expect(await screen.findByText(/Set a retention date/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Keep until"), { target: { value: "2026-06-01" } });
    await userEvent.click(screen.getAllByRole("button", { name: "Save" }).at(-1) as HTMLElement);
    expect(await screen.findByText(/extended, not shortened/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Keep until"), { target: { value: "2028-06-01" } });
    await userEvent.selectOptions(screen.getByLabelText("Legal hold"), "yes");
    await userEvent.click(screen.getAllByRole("button", { name: "Save" }).at(-1) as HTMLElement);
    await waitFor(() => expect(calls).toContainEqual(["retention", { retention_until: "2028-06-01", legal_hold: true }]));
    expect(await screen.findByText("Retention settings saved.")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Archive" }));
    await userEvent.type(screen.getByLabelText("Reason (optional)"), "Done");
    await userEvent.click(screen.getAllByRole("button", { name: "Archive" }).at(-1) as HTMLElement);
    await waitFor(() => expect(calls).toContainEqual(["archive", { reason: "Done" }]));
  });

  it("requests disposal of an archived document", async () => {
    let body: unknown = null;
    server.use(FAVS(), http.get("*/api/v1/documents/documents/d1/grants", () => HttpResponse.json([])), staff, depts, roles, http.post("*/api/v1/documents/disposals", async ({ request }) => { body = await request.json(); return HttpResponse.json({}, { status: 201 }); }));
    tools(doc({ status: "ARCHIVED", retention_until: "2025-01-01" }));
    await userEvent.click(screen.getByRole("button", { name: "Request disposal" }));
    await userEvent.type(screen.getByLabelText("Reason"), "Retention over");
    await userEvent.click(screen.getAllByRole("button", { name: "Request disposal" }).at(-1) as HTMLElement);
    await waitFor(() => expect(body).toEqual({ document: "d1", reason: "Retention over" }));
    expect(await screen.findByText(/Someone else must approve/)).toBeInTheDocument();
  });
});

describe("DocumentTools: links, review, sharing, access, shortcuts", () => {
  it("adds and removes a link", async () => {
    let body: unknown = null; let removed = false;
    server.use(FAVS(), http.get("*/api/v1/documents/documents/d1/grants", () => HttpResponse.json([])), staff, depts, roles,
      http.post("*/api/v1/documents/documents/d1/links", async ({ request }) => { body = await request.json(); return HttpResponse.json({}, { status: 201 }); }),
      http.delete("*/api/v1/documents/links/l1", () => { removed = true; return new HttpResponse(null, { status: 204 }); }));
    tools(doc({ links: [{ id: "l1", type: "PROJECT", ref_id: "p1", label: "Bridge" }] }));
    expect(screen.getByText("Bridge")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Remove link Bridge" }));
    await waitFor(() => expect(removed).toBe(true));
    await userEvent.click(screen.getByRole("button", { name: "Add link" }));
    await userEvent.click(screen.getAllByRole("button", { name: "Add link" }).at(-1) as HTMLElement);
    expect(await screen.findByText("Choose what kind of record.")).toBeInTheDocument();
    await userEvent.selectOptions(screen.getByLabelText("Kind of record"), "SUPPLIER");
    await userEvent.type(screen.getByLabelText("Record identifier"), "s-9");
    await userEvent.click(screen.getAllByRole("button", { name: "Add link" }).at(-1) as HTMLElement);
    await waitFor(() => expect(body).toEqual({ type: "SUPPLIER", ref_id: "s-9", label: "" }));
  });

  it("records a review: comment needed unless nothing changes", async () => {
    let body: unknown = null;
    server.use(FAVS(), http.get("*/api/v1/documents/documents/d1/grants", () => HttpResponse.json([])), staff, depts, roles, http.post("*/api/v1/documents/documents/d1/review", async ({ request }) => { body = await request.json(); return HttpResponse.json({}); }));
    tools(doc());
    await userEvent.click(screen.getByRole("button", { name: "Record a review" }));
    await userEvent.selectOptions(screen.getByLabelText("Outcome"), "REVISION_REQUIRED");
    await userEvent.click(screen.getAllByRole("button", { name: "Record review" }).at(-1) as HTMLElement);
    expect(await screen.findByText("Say what needs to change.")).toBeInTheDocument();
    await userEvent.selectOptions(screen.getByLabelText("Outcome"), "NO_CHANGE");
    await userEvent.click(screen.getAllByRole("button", { name: "Record review" }).at(-1) as HTMLElement);
    await waitFor(() => expect(body).toEqual({ outcome: "NO_CHANGE", comment: "" }));
  });

  it("sends the document to a role with an acknowledgement deadline", async () => {
    let body: unknown = null;
    server.use(FAVS(), http.get("*/api/v1/documents/documents/d1/grants", () => HttpResponse.json([])), staff, depts, roles, http.post("*/api/v1/documents/documents/d1/distribute", async ({ request }) => { body = await request.json(); return HttpResponse.json({ users: 3 }, { status: 201 }); }));
    tools(doc());
    await userEvent.click(screen.getByRole("button", { name: "Send to people" }));
    await userEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(await screen.findByText("Choose who to send it to.")).toBeInTheDocument();
    await userEvent.selectOptions(screen.getByLabelText("Send to"), "ROLE");
    await waitFor(() => expect(screen.getByRole("option", { name: "QA Manager" })).toBeInTheDocument());
    await userEvent.selectOptions(screen.getByLabelText("Who"), "qa_manager");
    await userEvent.click(screen.getByLabelText("They must confirm they have read it"));
    fireEvent.change(screen.getByLabelText("Confirm by"), { target: { value: "2026-12-15" } });
    await userEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(await screen.findByText("Sent to 3 people.")).toBeInTheDocument();
    expect(body).toEqual({ targets: [{ type: "ROLE", id: "qa_manager" }], requires_acknowledgement: true, due_date: "2026-12-15" });
  });

  it("lists, grants and withdraws access", async () => {
    let body: unknown = null; let revoked = false;
    server.use(FAVS(), staff, depts, roles, http.get("*/api/v1/documents/documents/d1/grants", () => HttpResponse.json([{ id: "g1", document: "d1", folder: null, subject_type: "DEPARTMENT", subject_id: "dp1", actions: ["VIEW", "DOWNLOAD"], expires_at: "2027-01-01T00:00:00Z", revoked_at: null }])),
      http.post("*/api/v1/documents/documents/d1/grants", async ({ request }) => { body = await request.json(); return HttpResponse.json({}, { status: 201 }); }),
      http.delete("*/api/v1/documents/grants/g1", () => { revoked = true; return new HttpResponse(null, { status: 204 }); }));
    tools(doc());
    expect(await screen.findByText("Finance")).toBeInTheDocument();
    expect(screen.getByText("See, Download")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Withdraw access of Finance" }));
    await waitFor(() => expect(revoked).toBe(true));
    await userEvent.click(screen.getAllByRole("button", { name: "Give access" })[0] as HTMLElement);
    await userEvent.click(screen.getAllByRole("button", { name: "Give access" }).at(-1) as HTMLElement);
    expect(await screen.findByText("Choose who gets access.")).toBeInTheDocument();
    await userEvent.selectOptions(screen.getByLabelText("Send to"), "USER");
    await waitFor(() => expect(screen.getByRole("option", { name: "E1 Abel" })).toBeInTheDocument());
    await userEvent.selectOptions(screen.getByLabelText("Who"), "u1");
    await userEvent.click(screen.getByLabelText("Edit"));
    await userEvent.click(screen.getAllByRole("button", { name: "Give access" }).at(-1) as HTMLElement);
    await waitFor(() => expect(body).toEqual({ subject_type: "USER", subject_id: "u1", actions: ["VIEW", "EDIT"] }));
  });

  it("toggles favourite from the favourites list", async () => {
    const calls: string[] = [];
    server.use(FAVS([row()]), http.get("*/api/v1/documents/documents/d1/grants", () => HttpResponse.json([])), staff, depts, roles,
      http.delete("*/api/v1/documents/documents/d1/favourite", () => { calls.push("off"); return new HttpResponse(null, { status: 204 }); }));
    tools(doc());
    await userEvent.click(await screen.findByRole("button", { name: "Remove from favourites" }));
    await waitFor(() => expect(calls).toEqual(["off"]));
  });

  it("uses a published template to start a new document", async () => {
    let body: unknown = null;
    server.use(FAVS(), http.get("*/api/v1/documents/documents/d1/grants", () => HttpResponse.json([])), staff, depts, roles,
      http.get("*/api/v1/documents/categories", () => page([{ id: "c1", code: "POL", name: "Policy", doc_type: "POLICY", is_controlled: true, requires_expiry: false, review_interval_days: null, retention_years: null, is_active: true }])),
      http.post("*/api/v1/documents/templates/d1/use", async ({ request }) => { body = await request.json(); return HttpResponse.json({ ...doc({ id: "d7" }) }, { status: 201 }); }),
      http.get("*/api/v1/documents/documents/d7", () => HttpResponse.json(doc({ id: "d7", title: "Copy" }))), http.get("*/api/v1/documents/documents/d7/comments", () => HttpResponse.json([])));
    renderWithProviders(<Routes><Route path="/app/documents/:id" element={<><DocumentTools doc={doc({ is_template: true }) as never} /><DocumentDetailPage /></>} /></Routes>, { permissions: ALL, route: "/app/documents/d7" });
    await userEvent.click(await screen.findByRole("button", { name: "Use as template" }));
    await userEvent.click(screen.getByRole("button", { name: "Create document" }));
    expect(await screen.findByText("A title is required.")).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText("Title"), "Copy");
    await userEvent.click(screen.getByRole("button", { name: "Create document" }));
    expect(await screen.findByText("Choose a category.")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("option", { name: "Policy" })).toBeInTheDocument());
    await userEvent.selectOptions(screen.getByLabelText("Category"), "c1");
    await userEvent.click(screen.getByRole("button", { name: "Create document" }));
    await waitFor(() => expect(body).toEqual({ title: "Copy", category: "c1" }));
  });
});

describe("DisposalPage", () => {
  const req = (o = {}) => ({ id: "q1", document: "d1", reference: "POL-0001", status: "PENDING", reason: "Retention over", requested_by: "u1", decided_by: null, decision_note: "", ...o });
  it("approves; rejection needs a note; approved ones can be carried out", async () => {
    const calls: [string, unknown][] = [];
    server.use(staff, http.get("*/api/v1/documents/disposals", () => page([req(), req({ id: "q2", reference: "POL-0002", document: "d2", status: "APPROVED" })])),
      http.post("*/api/v1/documents/disposals/:id/decide", async ({ request, params }) => { calls.push([`decide ${params.id}`, await request.json()]); return params.id === "q1" && calls.length === 1 ? HttpResponse.json({ error: { code: "separation_of_duties", message: "You cannot approve disposal that you requested." } }, { status: 403 }) : HttpResponse.json({}); }),
      http.post("*/api/v1/documents/disposals/q2/execute", () => { calls.push(["execute", null]); return HttpResponse.json({}); }));
    renderWithProviders(<DisposalPage />, { permissions: ["documents.disposal.approve"] });
    await userEvent.click(await screen.findByRole("button", { name: "Approve disposal of POL-0001" }));
    expect(await screen.findByText("You cannot approve disposal that you requested.")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Reject disposal of POL-0001" }));
    await userEvent.click(screen.getAllByRole("button", { name: "Reject" }).at(-1) as HTMLElement);
    expect(await screen.findByText("Why not is required.")).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText("Why not"), "Still needed");
    await userEvent.click(screen.getAllByRole("button", { name: "Reject" }).at(-1) as HTMLElement);
    await waitFor(() => expect(calls).toContainEqual(["decide q1", { approve: false, note: "Still needed" }]));
    await userEvent.click(screen.getByRole("button", { name: "Carry out disposal of POL-0002" }));
    await waitFor(() => expect(calls).toContainEqual(["execute", null]));
  });
});

describe("Favourites and saved searches", () => {
  it("lists favourites and removes one", async () => {
    let off = false;
    server.use(http.get("*/api/v1/documents/favourites", () => page([row()])), http.delete("*/api/v1/documents/documents/d1/favourite", () => { off = true; return new HttpResponse(null, { status: 204 }); }));
    renderWithProviders(<FavouritesPage />, { permissions: ["documents.view"] });
    expect(await screen.findByRole("link", { name: "Safety policy" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Remove Safety policy from favourites" }));
    await waitFor(() => expect(off).toBe(true));
  });

  it("saves the current search, re-applies a saved one and deletes it", async () => {
    let saved: unknown = null; let deleted = false; const seen: URLSearchParams[] = [];
    server.use(http.get("*/api/v1/documents/categories", () => page([])), http.get("*/api/v1/documents/folders", () => page([])), http.get("*/api/v1/documents/documents", ({ request }) => { seen.push(new URL(request.url).searchParams); return page([]); }),
      http.get("*/api/v1/documents/saved-searches", () => HttpResponse.json([{ id: "s1", name: "Expired policies", params: { q: "policy", full_text: false, status: "PUBLISHED", category_code: "", folder: "", expired: true } }])),
      http.post("*/api/v1/documents/saved-searches", async ({ request }) => { saved = await request.json(); return HttpResponse.json({ id: "s2", name: "x", params: {} }, { status: 201 }); }),
      http.delete("*/api/v1/documents/saved-searches/s1", () => { deleted = true; return new HttpResponse(null, { status: 204 }); }));
    renderWithProviders(<DocumentsPage />, { permissions: ["documents.view"] });
    await userEvent.click(await screen.findByRole("button", { name: "Expired policies" }));
    await waitFor(() => expect(seen.some((p) => p.get("q") === "policy" && p.get("status") === "PUBLISHED" && p.get("expired") === "1")).toBe(true));
    await userEvent.click(screen.getByRole("button", { name: "Save this search" }));
    await userEvent.type(screen.getByLabelText("Name"), "Mine");
    await userEvent.click(screen.getAllByRole("button", { name: "Save" }).at(-1) as HTMLElement);
    await waitFor(() => expect(saved).toEqual({ name: "Mine", params: { q: "policy", full_text: false, status: "PUBLISHED", category_code: "", folder: "", expired: true } }));
    await userEvent.click(screen.getByRole("button", { name: "Delete saved search Expired policies" }));
    await waitFor(() => expect(deleted).toBe(true));
  });
});
