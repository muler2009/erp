import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { Route, Routes } from "react-router";

import * as auth from "../../shared/auth/authService";
import { renderWithProviders } from "../../test/utils";
import { AcknowledgementsPage, isOverdue } from "./AcknowledgementsPage";
import { DocumentDetailPage, sizeText, versionActions } from "./DocumentDetailPage";
import { DocumentsPage, fileProblem, flags } from "./DocumentsPage";

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
beforeEach(() => vi.spyOn(auth, "getAccessToken").mockResolvedValue("tok"));
afterEach(() => { server.resetHandlers(); vi.restoreAllMocks(); });
afterAll(() => server.close());

const page = (rows: object[]) => HttpResponse.json({ results: rows, next: null, previous: null });
const row = (o = {}) => ({ id: "d1", reference: "POL-0001", title: "Safety policy", status: "PUBLISHED", category: "c1", category_name: "Policy", classification: "INTERNAL", owner: "u1", folder: null, tags: ["hse"], current_version: { id: "v1", label: "1.0", file_name: "policy.pdf", published_at: "2026-11-01" },
  effective_date: null, expiry_date: null, next_review_date: null, expired: false, review_overdue: false, legal_hold: false, is_obsolete: false, is_template: false, pending_revision: null, ...o });
const ver = (o = {}) => ({ id: "v1", number: 1, label: "1.0", status: "PUBLISHED", change_reason: "Initial issue", file_name: "policy.pdf", size: 2048, created_by: "u1", created_at: "2026-11-01T08:00:00Z", submitted_at: null, published_at: "2026-11-01", rejection_note: "", ...o });
const CATS = http.get("*/api/v1/documents/categories", () => page([{ id: "c1", code: "POL", name: "Policy", doc_type: "POLICY", is_controlled: true, requires_expiry: false, review_interval_days: null, retention_years: null, is_active: true }, { id: "c2", code: "CERT", name: "Certificate", doc_type: "OTHER", is_controlled: true, requires_expiry: true, review_interval_days: null, retention_years: null, is_active: true }]));
const FOLDERS = http.get("*/api/v1/documents/folders", () => page([{ id: "f1", name: "HSE", parent: null, is_active: true }]));
const CLS = http.get("*/api/v1/documents/classifications", () => HttpResponse.json([{ code: "INTERNAL", name: "Internal", rank: 1 }]));
const STAFF = http.get("*/api/v1/hr/employees", () => HttpResponse.json({ results: [{ id: "e1", employee_no: "E-1", name: "Abel", status: "ACTIVE", user_id: "u1" }] }));

describe("helpers", () => {
  it("checks files, flags, sizes and actions", () => {
    expect(fileProblem(undefined, true)).toMatch(/Choose a file/);
    expect(fileProblem(undefined, false)).toBeNull();
    expect(fileProblem(new File([], "a.txt"), true)).toMatch(/empty/);
    expect(fileProblem(new File(["x"], "a.txt"), true)).toBeNull();
    expect(flags({ expired: true, review_overdue: false, legal_hold: true })).toEqual(["Expired", "Legal hold"]);
    expect(sizeText(2048)).toBe("2 KB");
    expect(sizeText(3 * 1048576)).toBe("3.0 MB");
    expect(versionActions({ status: "DRAFT" }, { edit: true })).toEqual(["submit"]);
    expect(versionActions({ status: "DRAFT" }, {})).toEqual([]);
    expect(versionActions({ status: "UNDER_REVIEW" }, { edit: true })).toEqual(["withdraw"]);
    expect(versionActions({ status: "CHANGES_REQUESTED" }, { edit: true })).toEqual(["resubmit"]);
    expect(versionActions({ status: "APPROVED" }, { publish: true })).toEqual(["publish"]);
    expect(versionActions({ status: "APPROVED" }, { edit: true })).toEqual([]);
    expect(isOverdue("2026-01-01", "2026-02-01")).toBe(true);
    expect(isOverdue(null)).toBe(false);
  });
});

describe("DocumentsPage", () => {
  it("lists documents, flags problems and sends the search and filters", async () => {
    const seen: URLSearchParams[] = [];
    server.use(CATS, FOLDERS, http.get("*/api/v1/documents/documents", ({ request }) => { seen.push(new URL(request.url).searchParams); return page([row({ expired: true })]); }));
    renderWithProviders(<DocumentsPage />, { permissions: ["documents.view"] });
    expect(await screen.findByRole("link", { name: "Safety policy" })).toHaveAttribute("href", "/app/documents/d1");
    expect(screen.getByText("Expired")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "New document" })).toBeNull();
    await userEvent.type(screen.getByLabelText("Search"), "safety");
    await userEvent.click(screen.getByLabelText("Search inside files"));
    await userEvent.selectOptions(screen.getByLabelText("Status"), "DRAFT");
    await waitFor(() => expect(seen.some((p) => p.get("q") === "safety" && p.get("full_text") === "1" && p.get("status") === "DRAFT")).toBe(true));
  });

  it("creates a document with a file, checking the form first", async () => {
    let form: FormData | null = null;
    server.use(CATS, FOLDERS, CLS, http.get("*/api/v1/documents/documents", () => page([])),
      http.post("*/api/v1/documents/documents", async ({ request }) => { form = await request.formData(); return HttpResponse.json({ ...row(), versions: [], links: [], related: [], description: "" }, { status: 201 }); }));
    renderWithProviders(<DocumentsPage />, { permissions: ["documents.view", "documents.create"] });
    await userEvent.click(await screen.findByRole("button", { name: "New document" }));
    const d = within(await screen.findByRole("dialog", { name: "New document" }));
    await userEvent.click(d.getByRole("button", { name: "Create document" }));
    expect(await d.findByText("A title is required.")).toBeInTheDocument();
    await userEvent.type(d.getByLabelText("Title"), "Fire plan");
    await d.findByRole("option", { name: "Certificate" });
    await userEvent.selectOptions(d.getByLabelText("Category"), "c2");
    await userEvent.click(d.getByRole("button", { name: "Create document" }));
    expect(await d.findByText("Choose a file to upload.")).toBeInTheDocument();
    await userEvent.upload(d.getByLabelText("File"), new File(["hello"], "plan.pdf", { type: "application/pdf" }));
    await userEvent.click(d.getByRole("button", { name: "Create document" }));
    expect(await d.findByText("This kind of document needs an expiry date.")).toBeInTheDocument();
    await userEvent.selectOptions(d.getByLabelText("Category"), "c1");
    await userEvent.click(d.getByRole("button", { name: "Create document" }));
    await waitFor(() => expect(form).not.toBeNull());
    expect((form as unknown as FormData).get("title")).toBe("Fire plan");
    expect((form as unknown as FormData).get("category")).toBe("c1");
    expect(((form as unknown as FormData).get("file") as Blob).size).toBe(5); // the file itself was sent (jsdom drops the file name)
  });
});

function detail(perms: string[], d: object, extra: Parameters<typeof server.use> = []) {
  server.use(STAFF, http.get("*/api/v1/documents/documents/d1", () => HttpResponse.json(d)), http.get("*/api/v1/documents/documents/d1/comments", () => HttpResponse.json([{ id: "c9", document: "d1", version: null, author: "u1", comment: "Typo on page 2", response: "", status: "OPEN", at: "2026-11-02T08:00:00Z" }])), ...extra);
  return renderWithProviders(<Routes><Route path="/app/documents/:id" element={<DocumentDetailPage />} /></Routes>, { permissions: perms, route: "/app/documents/d1" });
}
const full = (o = {}) => ({ ...row(), description: "Rules", origin: "", versions: [ver()], links: [], related: [], history: [{ action: "PUBLISH", from: "DRAFT", to: "PUBLISHED", by: "u1", note: "", at: "2026-11-01T09:00:00Z", version: "1.0" }], approvals: [], can: { edit: true, upload: true, publish: true }, ...o });

describe("DocumentDetailPage", () => {
  it("shows details, versions, comments and history", async () => {
    detail(["documents.view"], full());
    expect(await screen.findByRole("heading", { name: "Safety policy" })).toBeInTheDocument();
    expect(await screen.findByText("Typo on page 2")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Download 1.0" })).toBeInTheDocument();
    expect(await screen.findByText(/publish 1.0/)).toBeInTheDocument();
  });

  it("sends a draft for approval", async () => {
    let body: unknown = null;
    detail(["documents.view"], full({ status: "DRAFT", versions: [ver({ status: "DRAFT" })] }), [http.post("*/api/v1/documents/versions/v1/submit", async ({ request }) => { body = await request.json(); return HttpResponse.json(ver({ status: "UNDER_REVIEW" })); })]);
    await userEvent.click(await screen.findByRole("button", { name: "Send for approval 1.0" }));
    const d = within(await screen.findByRole("dialog", { name: "Send for approval" }));
    await userEvent.type(d.getByLabelText("Comment (optional)"), "please review");
    await userEvent.click(d.getByRole("button", { name: "Send for approval" }));
    await waitFor(() => expect(body).toEqual({ comment: "please review" }));
  });

  it("offers publish only when the server says the person can publish", async () => {
    detail(["documents.view"], full({ status: "UNDER_REVIEW", versions: [ver({ status: "APPROVED" })], can: { edit: true, publish: false } }));
    await screen.findByText("Approved — not yet published");
    expect(screen.queryByRole("button", { name: "Publish 1.0" })).toBeNull();
  });

  it("uploads a new file with a reason, refusing an empty form", async () => {
    let form: FormData | null = null;
    detail(["documents.view"], full(), [http.post("*/api/v1/documents/documents/d1/versions", async ({ request }) => { form = await request.formData(); return HttpResponse.json(ver({ id: "v2", number: 2, label: "1.1", status: "DRAFT" }), { status: 201 }); })]);
    await userEvent.click(await screen.findByRole("button", { name: "Upload a new file" }));
    const d = within(await screen.findByRole("dialog", { name: "Upload a new file" }));
    await userEvent.click(d.getByRole("button", { name: "Upload" }));
    expect(await d.findByText("Choose a file to upload.")).toBeInTheDocument();
    await userEvent.upload(d.getByLabelText("File"), new File(["v2"], "policy-v2.pdf"));
    await userEvent.click(d.getByRole("button", { name: "Upload" }));
    expect(await d.findByText("Say what changed.")).toBeInTheDocument();
    await userEvent.type(d.getByLabelText("What changed"), "Fixed typo");
    await userEvent.click(d.getByRole("button", { name: "Upload" }));
    await waitFor(() => expect(form).not.toBeNull());
    expect((form as unknown as FormData).get("change_reason")).toBe("Fixed typo");
  });

  it("adds a comment and resolves one", async () => {
    let added: unknown = null; let resolved = 0;
    detail(["documents.view"], full(), [http.post("*/api/v1/documents/documents/d1/comments", async ({ request }) => { added = await request.json(); return HttpResponse.json({}, { status: 201 }); }),
      http.post("*/api/v1/documents/comments/c9/resolve", () => { resolved += 1; return HttpResponse.json({}); })]);
    await screen.findByText("Typo on page 2");
    await userEvent.click(screen.getByRole("button", { name: "Add comment" }));
    expect(await screen.findByText("Write a comment first.")).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText("Add a comment"), "Looks good");
    await userEvent.click(screen.getByRole("button", { name: "Add comment" }));
    await waitFor(() => expect(added).toEqual({ comment: "Looks good" }));
    await userEvent.click(screen.getByRole("button", { name: /Mark resolved/ }));
    await waitFor(() => expect(resolved).toBe(1));
  });

  it("records an acknowledgement and shows a refusal", async () => {
    detail(["documents.view"], full(), [http.post("*/api/v1/documents/documents/d1/acknowledge", () => HttpResponse.json({ error: { code: "not_distributed", message: "This document was not sent to you." } }, { status: 404 }))]);
    await userEvent.click(await screen.findByRole("button", { name: "I have read this" }));
    expect(await screen.findByText("This document was not sent to you.")).toBeInTheDocument();
  });
});

describe("AcknowledgementsPage", () => {
  it("lists pending documents and acknowledges one", async () => {
    let n = 0;
    server.use(http.get("*/api/v1/documents/acknowledgements/mine", () => HttpResponse.json(n ? [] : [{ document: "d1", reference: "POL-1", title: "Safety policy", version: "1.0", due_date: "2020-01-01" }])),
      http.post("*/api/v1/documents/documents/d1/acknowledge", () => { n += 1; return HttpResponse.json({}); }));
    renderWithProviders(<AcknowledgementsPage />, { permissions: ["documents.view"] });
    expect(await screen.findByText(/due 2020-01-01/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Acknowledge POL-1" }));
    expect(await screen.findByText("Nothing to acknowledge")).toBeInTheDocument();
  });
});
