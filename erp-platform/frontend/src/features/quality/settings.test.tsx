import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";

import * as auth from "../../shared/auth/authService";
import { renderWithProviders } from "../../test/utils";
import { QualitySettingsPage, validateConfigItem } from "./QualitySettingsPage";

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
beforeEach(() => vi.spyOn(auth, "getAccessToken").mockResolvedValue("tok"));
afterEach(() => { server.resetHandlers(); vi.restoreAllMocks(); });
afterAll(() => server.close());

const item = (o = {}) => ({ id: "c1", kind: "SEVERITY", code: "MINOR", name: "Minor", rank: 1, requires_capa: false, is_active: true, ...o });
const sev = [item(), item({ id: "c2", code: "CRITICAL", name: "Critical", rank: 3, requires_capa: true }), item({ id: "c3", code: "OLD", name: "Old level", rank: 2, is_active: false })];
const A = ["quality.view", "quality.admin"];

describe("validateConfigItem", () => {
  it("checks code, name and rank", () => {
    const f = { code: "NEW", name: "New", rank: "2" };
    expect(validateConfigItem({ ...f, code: " " }, [], false)).toMatch(/code/);
    expect(validateConfigItem({ ...f, code: "has space" }, [], false)).toMatch(/letters/);
    expect(validateConfigItem({ ...f, code: "x".repeat(31) }, [], false)).toMatch(/30/);
    expect(validateConfigItem({ ...f, code: "minor" }, ["MINOR"], false)).toMatch(/already/);
    expect(validateConfigItem({ ...f, code: "MINOR" }, ["MINOR"], true)).toBeNull();
    expect(validateConfigItem({ ...f, name: " " }, [], false)).toMatch(/name/);
    expect(validateConfigItem({ ...f, rank: "0" }, [], false)).toMatch(/rank/);
    expect(validateConfigItem({ ...f, rank: "1.5" }, [], false)).toMatch(/rank/);
    expect(validateConfigItem({ ...f, rank: "99999" }, [], false)).toMatch(/rank/);
    expect(validateConfigItem(f, [], false)).toBeNull();
  });
});

describe("QualitySettingsPage", () => {
  it("lists the entries by rank with retired ones marked, and switches lists", async () => {
    const seen: string[] = [];
    server.use(http.get("*/api/v1/quality/config/:kind", ({ params }) => { seen.push(String(params.kind)); return HttpResponse.json(params.kind === "SEVERITY" ? sev : [item({ id: "n1", kind: "NCR_CATEGORY", code: "MATERIAL", name: "Material" })]); }));
    renderWithProviders(<QualitySettingsPage />, { permissions: A });
    expect(await screen.findByText("Old level")).toBeInTheDocument();
    const rows = screen.getAllByRole("row").slice(1).map((r) => r.textContent ?? "");
    expect(rows[0]).toMatch(/MINOR/); expect(rows[1]).toMatch(/OLD/); expect(rows[2]).toMatch(/CRITICAL/);
    expect(screen.getByText("Retired")).toBeInTheDocument();
    await userEvent.selectOptions(screen.getByLabelText("List"), "NCR_CATEGORY");
    expect(await screen.findByText("Material")).toBeInTheDocument();
    expect(screen.queryByText("Needs a CAPA to close")).not.toBeInTheDocument();
    expect(seen).toContain("NCR_CATEGORY");
  });

  it("adds a severity level with rank and CAPA requirement", async () => {
    let body: Record<string, unknown> = {};
    server.use(http.get("*/api/v1/quality/config/SEVERITY", () => HttpResponse.json(sev)), http.post("*/api/v1/quality/config/SEVERITY", async ({ request }) => { body = (await request.json()) as Record<string, unknown>; return HttpResponse.json(item(), { status: 201 }); }));
    renderWithProviders(<QualitySettingsPage />, { permissions: A });
    await userEvent.click(await screen.findByRole("button", { name: "Add an entry" }));
    const d = within(await screen.findByRole("dialog", { name: "Add to Severity levels" }));
    await userEvent.type(d.getByLabelText("Code"), "minor");
    await userEvent.type(d.getByLabelText("Name"), "Again");
    await userEvent.click(d.getByRole("button", { name: "Save" }));
    expect(await d.findByRole("alert")).toHaveTextContent(/already in the list/);
    await userEvent.clear(d.getByLabelText("Code"));
    await userEvent.type(d.getByLabelText("Code"), "SEVERE");
    await userEvent.clear(d.getByLabelText("Name"));
    await userEvent.type(d.getByLabelText("Name"), "Severe");
    await userEvent.clear(d.getByLabelText("Rank (higher is worse)"));
    await userEvent.type(d.getByLabelText("Rank (higher is worse)"), "4");
    await userEvent.click(d.getByLabelText(/needs a CAPA/));
    await userEvent.click(d.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(body).toEqual({ code: "SEVERE", name: "Severe", rank: 4, requires_capa: true, is_active: true }));
  });

  it("edits an entry with the code locked, keeping its active state", async () => {
    let body: Record<string, unknown> = {};
    server.use(http.get("*/api/v1/quality/config/SEVERITY", () => HttpResponse.json(sev)), http.post("*/api/v1/quality/config/SEVERITY", async ({ request }) => { body = (await request.json()) as Record<string, unknown>; return HttpResponse.json(item()); }));
    renderWithProviders(<QualitySettingsPage />, { permissions: A });
    await userEvent.click(await screen.findByRole("button", { name: "Edit OLD" }));
    const d = within(await screen.findByRole("dialog", { name: "Edit Severity levels entry" }));
    expect(d.getByLabelText("Code")).toBeDisabled();
    await userEvent.clear(d.getByLabelText("Name"));
    await userEvent.type(d.getByLabelText("Name"), "Older level");
    await userEvent.click(d.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(body).toEqual({ code: "OLD", name: "Older level", rank: 2, requires_capa: false, is_active: false }));
  });

  it("retires and restores an entry, and shows a server refusal", async () => {
    const calls: Record<string, unknown>[] = [];
    let n = 0;
    server.use(http.get("*/api/v1/quality/config/SEVERITY", () => HttpResponse.json(sev)), http.post("*/api/v1/quality/config/SEVERITY", async ({ request }) => { calls.push((await request.json()) as Record<string, unknown>); n += 1; return n === 3 ? HttpResponse.json({ error: { code: "forbidden", message: "Only a quality administrator can change lists." } }, { status: 403 }) : HttpResponse.json(item()); }));
    renderWithProviders(<QualitySettingsPage />, { permissions: A });
    await userEvent.click(await screen.findByRole("button", { name: "Retire MINOR" }));
    await waitFor(() => expect(calls[0]).toMatchObject({ code: "MINOR", is_active: false }));
    await userEvent.click(screen.getByRole("button", { name: "Restore OLD" }));
    await waitFor(() => expect(calls[1]).toMatchObject({ code: "OLD", is_active: true }));
    await userEvent.click(screen.getByRole("button", { name: "Retire CRITICAL" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/Only a quality administrator/);
  });

  it("shows the list but no controls without quality.admin", async () => {
    server.use(http.get("*/api/v1/quality/config/SEVERITY", () => HttpResponse.json(sev)));
    renderWithProviders(<QualitySettingsPage />, { permissions: ["quality.view"] });
    expect(await screen.findByText("Old level")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Add an entry" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Retire|Edit/ })).not.toBeInTheDocument();
  });
});
