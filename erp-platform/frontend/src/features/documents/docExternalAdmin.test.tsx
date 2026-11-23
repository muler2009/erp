import { fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";

import * as auth from "../../shared/auth/authService";
import { renderWithProviders } from "../../test/utils";
import { categoryProblem, DocumentAdminPage, folderProblem } from "./DocumentAdminPage";
import { docReportProblem, DocumentReportsPage } from "./DocumentReportsPage";
import { ExternalPage, externalProblem, rfiProblem, transmittalProblem } from "./ExternalPage";

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
beforeEach(() => vi.spyOn(auth, "getAccessToken").mockResolvedValue("tok"));
afterEach(() => { server.resetHandlers(); vi.restoreAllMocks(); });
afterAll(() => server.close());

const page = (rows: object[], next: string | null = null) => HttpResponse.json({ results: rows, next, previous: null });
const cat = (o = {}) => ({ id: "c1", code: "COR", name: "Correspondence", doc_type: "CORRESPONDENCE", number_prefix: "COR", number_padding: 4, is_controlled: false, requires_expiry: false, review_interval_days: null, retention_years: 5, default_classification: "INTERNAL", is_active: true, ...o });
const CATS = http.get("*/api/v1/documents/categories", () => page([cat()]));
const PROJECTS = http.get("*/api/v1/projects/projects", () => page([{ id: "p1", code: "PRJ-1", name: "Bridge" }]));
const STAFF = http.get("*/api/v1/hr/employees", () => page([{ id: "e1", employee_no: "E1", name: "Abel", user_id: "u1", status: "ACTIVE" }]));
const ext = (o = {}) => ({ id: "x1", document: "d1", reference: "COR-0001", direction: "INCOMING", party_type: "SUPPLIER", party_name: "Acme Ltd", sender: "", recipient: "", party_reference: "", received_on: "2026-11-01", sent_on: null, response_due_on: "2026-11-30", responded_on: null, submission_status: "RECEIVED", contract_ref: "", resubmission_of: null, ...o });
const MANAGE = ["documents.view", "documents.external.manage"];

describe("helpers", () => {
  it("validate", () => {
    expect(externalProblem("", "S", "a", "t", "c", undefined)).toMatch(/incoming or outgoing/);
    expect(externalProblem("INCOMING", "", "a", "t", "c", undefined)).toMatch(/kind of party/);
    expect(externalProblem("INCOMING", "S", " ", "t", "c", undefined)).toMatch(/name/);
    expect(externalProblem("INCOMING", "S", "a", "", "c", undefined)).toMatch(/title/);
    expect(externalProblem("INCOMING", "S", "a", "t", "", undefined)).toMatch(/category/);
    expect(externalProblem("INCOMING", "S", "a", "t", "c", new File([], "e.txt"))).toMatch(/empty/);
    expect(externalProblem("INCOMING", "S", "a", "t", "c", undefined)).toBeNull();
    expect(transmittalProblem("OUTGOING", "", ["d"])).toMatch(/party/);
    expect(transmittalProblem("OUTGOING", "A", [])).toMatch(/at least one/);
    expect(transmittalProblem("OUTGOING", "A", ["d"])).toBeNull();
    expect(rfiProblem("", "s", "q", "u")).toMatch(/project/);
    expect(rfiProblem("p", " ", "q", "u")).toMatch(/subject/);
    expect(rfiProblem("p", "s", "", "u")).toMatch(/question/);
    expect(rfiProblem("p", "s", "q", "")).toMatch(/who/);
    expect(rfiProblem("p", "s", "q", "u")).toBeNull();
    expect(categoryProblem("", "N", "P", "4", "", "")).toMatch(/code/);
    expect(categoryProblem("C", " ", "P", "4", "", "")).toMatch(/name/);
    expect(categoryProblem("C", "N", "bad prefix", "4", "", "")).toMatch(/prefix/);
    expect(categoryProblem("C", "N", "P", "9", "", "")).toMatch(/1 to 8/);
    expect(categoryProblem("C", "N", "P", "4", "x", "")).toMatch(/days/);
    expect(categoryProblem("C", "N", "P", "4", "30", "0")).toMatch(/years/);
    expect(categoryProblem(undefined, "N", undefined, "4", "30", "5")).toBeNull();
    expect(folderProblem(" ")).toMatch(/name/);
    expect(folderProblem("a/b")).toMatch(/slash/);
    expect(folderProblem("HSE")).toBeNull();
    expect(docReportProblem("project-register", {})).toMatch(/project/);
    expect(docReportProblem("expiring", { within_days: "0" })).toMatch(/whole number/);
    expect(docReportProblem("access", { from: "2026-02-01", to: "2026-01-01" })).toMatch(/after/);
    expect(docReportProblem("register", {})).toBeNull();
  });
});

describe("Correspondence", () => {
  it("shows status; read-only users get no actions; filter is sent", async () => {
    const seen: string[] = [];
    server.use(http.get("*/api/v1/documents/external", ({ request }) => { seen.push(new URL(request.url).search); return page([ext()]); }));
    renderWithProviders(<ExternalPage />, { permissions: ["documents.view"] });
    expect(await screen.findByText("Reply due 2026-11-30")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Accept COR-0001" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Register correspondence" })).toBeNull();
    await userEvent.selectOptions(screen.getByLabelText("Status"), "REJECTED");
    await waitFor(() => expect(seen.some((s) => s.includes("status=REJECTED"))).toBe(true));
  });

  it("moves a submission along; rejection needs a reason; marks replied", async () => {
    const calls: [string, unknown][] = [];
    server.use(http.get("*/api/v1/documents/external", () => page([ext()])),
      http.post("*/api/v1/documents/external/x1/status", async ({ request }) => { calls.push(["status", await request.json()]); return HttpResponse.json(ext()); }),
      http.post("*/api/v1/documents/external/x1/responded", async ({ request }) => { calls.push(["responded", await request.json()]); return HttpResponse.json(ext()); }));
    renderWithProviders(<ExternalPage />, { permissions: MANAGE });
    await userEvent.click(await screen.findByRole("button", { name: "Start review COR-0001" }));
    await waitFor(() => expect(calls).toContainEqual(["status", { status: "UNDER_REVIEW", note: "" }]));
    await userEvent.click(screen.getByRole("button", { name: "Mark COR-0001 as replied" }));
    await waitFor(() => expect(calls).toContainEqual(["responded", {}]));
    await userEvent.click(screen.getByRole("button", { name: "Reject COR-0001" }));
    await userEvent.click(screen.getAllByRole("button", { name: "Reject" }).at(-1) as HTMLElement);
    expect(await screen.findByText("Reason is required.")).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText("Reason"), "Incomplete");
    await userEvent.click(screen.getAllByRole("button", { name: "Reject" }).at(-1) as HTMLElement);
    await waitFor(() => expect(calls).toContainEqual(["status", { status: "REJECTED", note: "Incomplete" }]));
  });

  it("registers incoming correspondence with a file", async () => {
    let form: FormData | null = null;
    server.use(CATS, http.get("*/api/v1/documents/external", () => page([])), http.post("*/api/v1/documents/external", async ({ request }) => { form = await request.formData(); return HttpResponse.json(ext(), { status: 201 }); }));
    renderWithProviders(<ExternalPage />, { permissions: MANAGE });
    await userEvent.click(await screen.findByRole("button", { name: "Register correspondence" }));
    await userEvent.click(screen.getByRole("button", { name: "Register" }));
    expect(await screen.findByText("Choose incoming or outgoing.")).toBeInTheDocument();
    await userEvent.selectOptions(screen.getByLabelText("Direction"), "INCOMING");
    await userEvent.selectOptions(screen.getByLabelText("Kind of party"), "SUPPLIER");
    await userEvent.type(screen.getByLabelText("Party name"), "Acme Ltd");
    await userEvent.type(screen.getByLabelText("Title"), "Delay notice");
    await waitFor(() => expect(screen.getByRole("option", { name: "Correspondence" })).toBeInTheDocument());
    await userEvent.selectOptions(screen.getByLabelText("Category"), "c1");
    fireEvent.change(screen.getByLabelText("Reply due by"), { target: { value: "2026-12-05" } });
    await userEvent.upload(screen.getByLabelText("File (optional)"), new File(["hello"], "notice.pdf", { type: "application/pdf" }));
    await userEvent.click(screen.getByRole("button", { name: "Register" }));
    await waitFor(() => expect(form).not.toBeNull());
    const f = form as unknown as FormData;
    expect(Object.fromEntries([...f.entries()].filter(([, v]) => typeof v === "string"))).toEqual({ direction: "INCOMING", party_type: "SUPPLIER", party_name: "Acme Ltd", title: "Delay notice", category: "c1", response_due_on: "2026-12-05" });
    expect((f.get("file") as Blob).size).toBe(5);
  });

  it("resubmits a rejected submission, keeping the party and linking to it", async () => {
    let form: FormData | null = null;
    server.use(CATS, http.get("*/api/v1/documents/external", () => page([ext({ submission_status: "REJECTED", response_due_on: null })])), http.post("*/api/v1/documents/external", async ({ request }) => { form = await request.formData(); return HttpResponse.json(ext(), { status: 201 }); }));
    renderWithProviders(<ExternalPage />, { permissions: MANAGE });
    await userEvent.click(await screen.findByRole("button", { name: "Resubmit COR-0001" }));
    expect(screen.getByLabelText("Party name")).toHaveValue("Acme Ltd");
    await userEvent.type(screen.getByLabelText("Title"), "Corrected notice");
    await waitFor(() => expect(screen.getByRole("option", { name: "Correspondence" })).toBeInTheDocument());
    await userEvent.selectOptions(screen.getByLabelText("Category"), "c1");
    await userEvent.click(screen.getByRole("button", { name: "Register" }));
    await waitFor(() => expect(form).not.toBeNull());
    expect((form as unknown as FormData).get("resubmission_of")).toBe("x1");
  });
});

describe("Transmittals and RFIs", () => {
  const nav = async (tab: string) => userEvent.click(screen.getByRole("tab", { name: tab }));
  const quiet = http.get("*/api/v1/documents/external", () => page([]));

  it("lists and creates a transmittal for chosen documents", async () => {
    let body: unknown = null;
    server.use(quiet, PROJECTS, http.get("*/api/v1/documents/documents", () => page([{ id: "d1", reference: "DRW-1", title: "Plan" }, { id: "d2", reference: "DRW-2", title: "Section" }])),
      http.get("*/api/v1/documents/transmittals", () => page([{ id: "t1", number: "TR-0001", project: "p1", direction: "OUTGOING", party: "Contractor", purpose: "FOR_REVIEW", sent_on: "2026-11-02", items: [{ document: "d1", reference: "DRW-1", version: "2.0" }] }])),
      http.post("*/api/v1/documents/transmittals", async ({ request }) => { body = await request.json(); return HttpResponse.json({}, { status: 201 }); }));
    renderWithProviders(<ExternalPage />, { permissions: MANAGE });
    await nav("Transmittals");
    expect(await screen.findByText("DRW-1 v2.0")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "New transmittal" }));
    await userEvent.click(screen.getByRole("button", { name: "Create transmittal" }));
    expect(await screen.findByText("Give the party's name.")).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText("Party"), "Contractor");
    await userEvent.click(screen.getByRole("button", { name: "Create transmittal" }));
    expect(await screen.findByText("Choose at least one document.")).toBeInTheDocument();
    await userEvent.click(await screen.findByLabelText("DRW-2 — Section"));
    await userEvent.selectOptions(screen.getByLabelText("Purpose"), "FOR_APPROVAL");
    await userEvent.click(screen.getByRole("button", { name: "Create transmittal" }));
    await waitFor(() => expect(body).toEqual({ direction: "OUTGOING", party_name: "Contractor", purpose: "FOR_APPROVAL", items: [{ document: "d2" }] }));
  });

  it("raises, answers and closes RFIs", async () => {
    const calls: [string, unknown][] = [];
    const rfi = (o = {}) => ({ id: "r1", number: "RFI-0001", project: "p1", subject: "Rebar spacing", question: "Which spacing?", raised_by: "u1", assigned_to: "u1", due_date: null, status: "OPEN", response: "", ...o });
    server.use(quiet, PROJECTS, STAFF, http.get("*/api/v1/documents/rfis", () => page([rfi(), rfi({ id: "r2", number: "RFI-0002", status: "ANSWERED", response: "150 mm" })])),
      http.post("*/api/v1/documents/rfis", async ({ request }) => { calls.push(["raise", await request.json()]); return HttpResponse.json(rfi(), { status: 201 }); }),
      http.post("*/api/v1/documents/rfis/r1/answer", async ({ request }) => { calls.push(["answer", await request.json()]); return HttpResponse.json(rfi()); }),
      http.post("*/api/v1/documents/rfis/r2/close", () => { calls.push(["close", null]); return HttpResponse.json(rfi()); }));
    renderWithProviders(<ExternalPage />, { permissions: MANAGE });
    await nav("Requests for information");
    expect(await screen.findByText("Answer: 150 mm")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Close RFI-0002" }));
    await waitFor(() => expect(calls).toContainEqual(["close", null]));
    await userEvent.click(screen.getByRole("button", { name: "Answer RFI-0001" }));
    await userEvent.click(screen.getByRole("button", { name: "Send answer" }));
    expect(await screen.findByText("Your answer is required.")).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText("Your answer"), "200 mm");
    await userEvent.click(screen.getByRole("button", { name: "Send answer" }));
    await waitFor(() => expect(calls).toContainEqual(["answer", { response: "200 mm" }]));
    await userEvent.click(screen.getAllByRole("button", { name: "Raise request" })[0] as HTMLElement);
    await userEvent.click(screen.getAllByRole("button", { name: "Raise request" }).at(-1) as HTMLElement);
    expect(await screen.findByText("Choose the project.")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("option", { name: "PRJ-1 — Bridge" })).toBeInTheDocument());
    await userEvent.selectOptions(screen.getByLabelText("Project"), "p1");
    await userEvent.type(screen.getByLabelText("Subject"), "Gate width");
    await userEvent.type(screen.getByLabelText("Question"), "How wide?");
    await waitFor(() => expect(screen.getByRole("option", { name: "E1 Abel" })).toBeInTheDocument());
    await userEvent.selectOptions(screen.getByLabelText("Who should answer"), "u1");
    await userEvent.click(screen.getAllByRole("button", { name: "Raise request" }).at(-1) as HTMLElement);
    await waitFor(() => expect(calls).toContainEqual(["raise", { project: "p1", subject: "Gate width", question: "How wide?", assigned_to: "u1" }]));
  });
});

describe("DocumentAdminPage", () => {
  it("adds a category with checks, changes one, switches it off, and adds a folder", async () => {
    const calls: [string, unknown][] = [];
    server.use(CATS, http.get("*/api/v1/documents/classifications", () => HttpResponse.json([{ code: "INTERNAL", name: "Internal", rank: 1 }])),
      http.get("*/api/v1/documents/folders", () => page([{ id: "f1", name: "HSE", parent: null, is_active: true }])),
      http.post("*/api/v1/documents/categories", async ({ request }) => { calls.push(["create", await request.json()]); return HttpResponse.json(cat(), { status: 201 }); }),
      http.patch("*/api/v1/documents/categories/c1", async ({ request }) => { calls.push(["patch", await request.json()]); return HttpResponse.json(cat()); }),
      http.post("*/api/v1/documents/folders", async ({ request }) => { calls.push(["folder", await request.json()]); return HttpResponse.json({}, { status: 201 }); }));
    renderWithProviders(<DocumentAdminPage />, { permissions: ["documents.admin"] });
    expect(await screen.findByText("5 years")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Add category" }));
    await userEvent.click(screen.getAllByRole("button", { name: "Add category" }).at(-1) as HTMLElement);
    expect(await screen.findByText("Give the category a code.")).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText("Code"), "MEMO");
    await userEvent.type(screen.getByLabelText("Name"), "Memos");
    await userEvent.type(screen.getByLabelText("Number prefix"), "memo");
    await userEvent.type(screen.getByLabelText("Review every (days)"), "365");
    await userEvent.click(screen.getAllByRole("button", { name: "Add category" }).at(-1) as HTMLElement);
    await waitFor(() => expect(calls).toContainEqual(["create", { name: "Memos", number_padding: 4, is_controlled: true, requires_expiry: false, review_interval_days: 365, retention_years: null, code: "MEMO", number_prefix: "MEMO", doc_type: "OTHER" }]));
    await userEvent.click(screen.getByRole("button", { name: "Change Correspondence" }));
    const ret = screen.getByLabelText("Keep for (years)");
    expect(ret).toHaveValue("5");
    await userEvent.clear(ret); await userEvent.type(ret, "7");
    await userEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(calls).toContainEqual(["patch", { name: "Correspondence", number_padding: 4, is_controlled: false, requires_expiry: false, review_interval_days: null, retention_years: 7, default_classification: "INTERNAL" }]));
    await userEvent.click(screen.getByRole("button", { name: "Switch off Correspondence" }));
    await waitFor(() => expect(calls).toContainEqual(["patch", { is_active: false }]));
    await userEvent.click(screen.getByRole("button", { name: "Add folder" }));
    expect(await screen.findByText("Give the folder a name.")).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText("New folder name"), "Audits");
    await userEvent.selectOptions(screen.getByLabelText("Inside"), "f1");
    await userEvent.click(screen.getByRole("button", { name: "Add folder" }));
    await waitFor(() => expect(calls).toContainEqual(["folder", { name: "Audits", parent: "f1" }]));
  });
});

describe("DocumentReportsPage", () => {
  it("runs reports with their settings; the access report is for admins only", async () => {
    const urls: string[] = [];
    server.use(PROJECTS, http.get("*/api/v1/documents/reports/:name", ({ request, params }) => { urls.push(`${params.name}${new URL(request.url).search}`); return HttpResponse.json([{ reference: "POL-1", title: "Safety" }]); }));
    const { unmount } = renderWithProviders(<DocumentReportsPage />, { permissions: ["documents.view"] });
    expect(screen.queryByRole("option", { name: "Who opened what" })).toBeNull();
    await userEvent.selectOptions(screen.getByLabelText("Report"), "project-register");
    await userEvent.click(screen.getByRole("button", { name: "Show report" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Choose the project.");
    expect(urls).toHaveLength(0);
    await waitFor(() => expect(screen.getByRole("option", { name: "PRJ-1 — Bridge" })).toBeInTheDocument());
    await userEvent.selectOptions(screen.getByLabelText("Project"), "p1");
    await userEvent.click(screen.getByRole("button", { name: "Show report" }));
    expect(await screen.findByText("POL-1")).toBeInTheDocument();
    expect(urls[0]).toBe("project-register?project=p1");
    await userEvent.selectOptions(screen.getByLabelText("Report"), "expiring");
    await userEvent.type(screen.getByLabelText("Within days"), "30");
    await userEvent.click(screen.getByRole("button", { name: "Show report" }));
    await waitFor(() => expect(urls).toContain("expiring?within_days=30"));
    unmount();
    renderWithProviders(<DocumentReportsPage />, { permissions: ["documents.view", "documents.admin"] });
    expect(screen.getByRole("option", { name: "Who opened what" })).toBeInTheDocument();
  });
});
