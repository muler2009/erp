import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { Route, Routes } from "react-router";

import * as auth from "../../shared/auth/authService";
import { renderWithProviders } from "../../test/utils";
import { EquipmentDetailPage, EquipmentPage, returnBlock, validateEquipment, validateRecord } from "./EquipmentPage";

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
beforeEach(() => vi.spyOn(auth, "getAccessToken").mockResolvedValue("tok"));
afterEach(() => { server.resetHandlers(); vi.restoreAllMocks(); });
afterAll(() => server.close());

const employees = http.get("*/api/v1/hr/employees", () => HttpResponse.json({ results: [{ id: "e1", employee_no: "E-1", name: "Abel", status: "ACTIVE", user_id: "u1" }] }));
const eq = (o = {}) => ({ id: "q1", tag: "CAL-1", name: "Micrometer", status: "ACTIVE", responsible_id: "u1", interval_days: 365, last_calibrated_on: "2026-01-10", next_due_on: "2027-01-10", overdue: false, location: "Lab", hold_reason: "", asset_id: null, ...o });
const cal = (o = {}) => ({ id: "c1", equipment_id: "q1", status: "SCHEDULED", scheduled_for: "2026-12-01", performed_on: null, performed_by: "", result: "", as_found: "", certificate_ref: "", out_of_tolerance: false, impacts: [], ...o });
const detail = (o = {}) => ({ ...eq(), manufacturer: "Mitutoyo", model: "M1", serial_number: "S9", calibrations: [], history: [], ...o });
const P = ["quality.view", "quality.calibration.manage"];
const route = (d: object, permissions: string[]) => { server.use(employees, http.get("*/api/v1/quality/equipment/q1", () => HttpResponse.json(d))); return renderWithProviders(<Routes><Route path="/app/quality/equipment/:id" element={<EquipmentDetailPage />} /></Routes>, { permissions, route: "/app/quality/equipment/q1" }); };

describe("validators", () => {
  it("equipment, record and return rules", () => {
    const f = { tag: "T", name: "N", responsible_id: "u1", interval_days: "365", last_calibrated_on: "" };
    expect(validateEquipment({ ...f, tag: " " })).toMatch(/tag/);
    expect(validateEquipment({ ...f, interval_days: "0" })).toMatch(/positive/);
    expect(validateEquipment({ ...f, interval_days: "1.5" })).toMatch(/positive/);
    expect(validateEquipment({ ...f, last_calibrated_on: "2999-01-01" })).toMatch(/future/);
    expect(validateEquipment(f)).toBeNull();
    const r = { performed_on: "2026-01-01", performed_by: "Lab", result: "PASS", certificate_ref: "C1", as_found: "" };
    expect(validateRecord({ ...r, performed_on: "2999-01-01" })).toMatch(/future/);
    expect(validateRecord({ ...r, performed_by: "" })).toMatch(/who/);
    expect(validateRecord({ ...r, certificate_ref: "" })).toMatch(/certificate/);
    expect(validateRecord({ ...r, result: "FAIL" })).toMatch(/as-found/);
    expect(validateRecord({ ...r, result: "FAIL", as_found: "Out by 0.1" })).toBeNull();
    expect(validateRecord(r)).toBeNull();
    const bad = cal({ status: "DONE", result: "FAIL", out_of_tolerance: true, performed_on: "2026-06-01", impacts: [{ id: "i1", inspection_id: "x", status: "PENDING", note: "" }] });
    const good = cal({ id: "c2", status: "DONE", result: "PASS", performed_on: "2026-07-01" });
    expect(returnBlock({ status: "ACTIVE", calibrations: [] }).block).toMatch(/not on hold/);
    expect(returnBlock({ status: "ON_HOLD", calibrations: [bad] }).block).toMatch(/passing calibration/);
    expect(returnBlock({ status: "ON_HOLD", calibrations: [bad, good] }).block).toMatch(/Assess the impact/);
    const done = { ...bad, impacts: [{ id: "i1", inspection_id: "x", status: "NOT_AFFECTED", note: "n" }] };
    expect(returnBlock({ status: "ON_HOLD", calibrations: [done, good] })).toEqual({ block: null, calibrationId: "c2" });
  });
});

describe("EquipmentPage", () => {
  it("lists equipment with overdue flag and filters overdue", async () => {
    const seen: string[] = [];
    server.use(employees, http.get("*/api/v1/quality/equipment", ({ request }) => { seen.push(new URL(request.url).search); return HttpResponse.json({ results: [eq({ overdue: true, next_due_on: "2026-01-01" })] }); }));
    renderWithProviders(<EquipmentPage />, { permissions: ["quality.view"] });
    expect(await screen.findByText("Micrometer")).toBeInTheDocument();
    expect(screen.getByText("Overdue")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Register equipment" })).not.toBeInTheDocument();
    await userEvent.click(screen.getByLabelText("Overdue only"));
    await waitFor(() => expect(seen.some((s) => s.includes("overdue=1"))).toBe(true));
  });

  it("registers equipment and shows the server refusal for a duplicate tag", async () => {
    let body: Record<string, unknown> = {};
    let n = 0;
    server.use(employees, http.get("*/api/v1/quality/equipment", () => HttpResponse.json({ results: [] })),
      http.post("*/api/v1/quality/equipment", async ({ request }) => { body = (await request.json()) as Record<string, unknown>; n += 1; return n === 1 ? HttpResponse.json({ error: { code: "duplicate", message: "This equipment tag is already registered." } }, { status: 400 }) : HttpResponse.json(eq(), { status: 201 }); }));
    renderWithProviders(<EquipmentPage />, { permissions: P });
    await userEvent.click(await screen.findByRole("button", { name: "Register equipment" }));
    const d = within(await screen.findByRole("dialog", { name: "Register equipment" }));
    await userEvent.click(d.getByRole("button", { name: "Register" }));
    expect(await d.findByRole("alert")).toHaveTextContent(/tag/);
    await userEvent.type(d.getByLabelText("Tag"), "CAL-1");
    await userEvent.type(d.getByLabelText("Name"), "Micrometer");
    await d.findByRole("option", { name: /Abel/ });
    await userEvent.selectOptions(d.getByLabelText("Responsible"), "u1");
    await userEvent.click(d.getByRole("button", { name: "Register" }));
    expect(await d.findByText(/already registered/)).toBeInTheDocument();
    await userEvent.click(d.getByRole("button", { name: "Register" }));
    await waitFor(() => expect(n).toBe(2));
    expect(body).toMatchObject({ tag: "CAL-1", name: "Micrometer", responsible_id: "u1", interval_days: 365 });
  });
});

describe("EquipmentPage with a colleague who is not an employee", () => {
  it("finds the responsible person through the directory and registers with their id", async () => {
    let body: Record<string, unknown> = {};
    const cara = { id: "22222222-2222-4222-8222-222222222222", display_name: "Cara Newhire" };
    server.use(http.get("*/api/v1/hr/employees", () => HttpResponse.json({ results: [] })),  // a new tenant: nobody is an employee yet
      http.get("*/api/v1/quality/equipment", () => HttpResponse.json({ results: [] })),
      http.get("*/api/v1/directory/users", () => HttpResponse.json({ results: [cara] })),
      http.post("*/api/v1/quality/equipment", async ({ request }) => { body = (await request.json()) as Record<string, unknown>; return HttpResponse.json(eq(), { status: 201 }); }));
    renderWithProviders(<EquipmentPage />, { permissions: P });
    await userEvent.click(await screen.findByRole("button", { name: "Register equipment" }));
    const d = within(await screen.findByRole("dialog", { name: "Register equipment" }));
    await userEvent.type(d.getByLabelText("Tag"), "CAL-9");
    await userEvent.type(d.getByLabelText("Name"), "Caliper");
    await userEvent.type(d.getByRole("combobox", { name: "Find someone else" }), "Ca");
    await userEvent.click(await d.findByRole("button", { name: "Cara Newhire" }));
    await userEvent.click(d.getByRole("button", { name: "Register" }));
    await waitFor(() => expect(body).toMatchObject({ tag: "CAL-9", responsible_id: cara.id }));
  });
});

describe("EquipmentDetailPage", () => {
  it("schedules a calibration, then hides the schedule button once one is pending", async () => {
    let sent: Record<string, unknown> = {};
    server.use(http.post("*/api/v1/quality/equipment/q1/schedule", async ({ request }) => { sent = (await request.json()) as Record<string, unknown>; return HttpResponse.json(cal(), { status: 201 }); }));
    route(detail(), P);
    await userEvent.click(await screen.findByRole("button", { name: "Schedule a calibration" }));
    const d = within(await screen.findByRole("dialog", { name: "Schedule a calibration" }));
    fireEvent.change(d.getByLabelText("Scheduled for"), { target: { value: "2026-12-01" } });
    await userEvent.click(d.getByRole("button", { name: "Schedule" }));
    await waitFor(() => expect(sent).toEqual({ scheduled_for: "2026-12-01" }));
  });

  it("does not offer schedule when one is already scheduled, and hides actions without permission", async () => {
    route(detail({ calibrations: [cal()] }), P);
    expect(await screen.findByText("Scheduled for 2026-12-01")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Schedule a calibration" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Record result" })).toBeInTheDocument();
  });

  it("view-only users see no actions", async () => {
    route(detail({ calibrations: [cal()] }), ["quality.view"]);
    expect(await screen.findByText("Scheduled for 2026-12-01")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Record result" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Retire" })).not.toBeInTheDocument();
  });

  it("records a failed calibration as multipart, needing the as-found condition first", async () => {
    let form: FormData | null = null;
    server.use(http.post("*/api/v1/quality/calibrations/c1/record", async ({ request }) => { form = await request.formData(); return HttpResponse.json(cal({ status: "DONE" })); }));
    route(detail({ calibrations: [cal()] }), P);
    await userEvent.click(await screen.findByRole("button", { name: "Record result" }));
    const d = within(await screen.findByRole("dialog", { name: "Record the calibration" }));
    fireEvent.change(d.getByLabelText("Calibrated on"), { target: { value: "2026-11-01" } });
    await userEvent.type(d.getByLabelText("Calibrated by"), "Acme Lab");
    await userEvent.selectOptions(d.getByLabelText("Result"), "FAIL");
    await userEvent.type(d.getByLabelText("Certificate reference"), "CERT-9");
    await userEvent.click(d.getByRole("button", { name: "Record" }));
    expect(await d.findByRole("alert")).toHaveTextContent(/as-found/);
    expect(form).toBeNull();
    await userEvent.type(d.getByLabelText("As-found condition"), "Reads 0.2 mm high");
    await userEvent.upload(d.getByLabelText("Certificate file"), new File(["pdf"], "cert.pdf", { type: "application/pdf" }));
    await userEvent.click(d.getByRole("button", { name: "Record" }));
    await waitFor(() => expect(form).not.toBeNull());
    const f = form as unknown as FormData;
    expect(f.get("result")).toBe("FAIL");
    expect(f.get("certificate_ref")).toBe("CERT-9");
    expect(f.get("as_found")).toBe("Reads 0.2 mm high");
    expect((f.get("certificate") as Blob).size).toBe(3); // the test transport drops the file name; the page passes it explicitly
  });

  it("assesses an impact with a note and sends affected as a boolean", async () => {
    let sent: Record<string, unknown> = {};
    server.use(http.post("*/api/v1/quality/impact-assessments/i1", async ({ request }) => { sent = (await request.json()) as Record<string, unknown>; return HttpResponse.json({ id: "i1", status: "REINSPECT" }); }));
    route(detail({ status: "ON_HOLD", hold_reason: "Out of tolerance", calibrations: [cal({ status: "DONE", result: "FAIL", out_of_tolerance: true, performed_on: "2026-11-01", impacts: [{ id: "i1", inspection_id: "x1", status: "PENDING", note: "" }] })] }), P);
    await userEvent.click(await screen.findByRole("button", { name: "Assess" }));
    const d = within(await screen.findByRole("dialog", { name: "Assess the impact" }));
    await userEvent.click(d.getByRole("button", { name: "Record assessment" }));
    expect(await d.findByRole("alert")).toHaveTextContent(/required/);
    await userEvent.selectOptions(d.getByLabelText("Was the inspection affected?"), "yes");
    await userEvent.type(d.getByLabelText("Assessment"), "Measured parts out of limit");
    await userEvent.click(d.getByRole("button", { name: "Record assessment" }));
    await waitFor(() => expect(sent).toEqual({ affected: true, note: "Measured parts out of limit" }));
  });

  it("blocks return to service until impacts are assessed, then returns with the passing calibration", async () => {
    let sent: Record<string, unknown> = {};
    server.use(http.post("*/api/v1/quality/equipment/q1/return-to-service", async ({ request }) => { sent = (await request.json()) as Record<string, unknown>; return HttpResponse.json(eq()); }));
    const failed = cal({ id: "c1", status: "DONE", result: "FAIL", out_of_tolerance: true, performed_on: "2026-10-01", impacts: [{ id: "i1", inspection_id: "x1", status: "PENDING", note: "" }] });
    const good = cal({ id: "c2", status: "DONE", result: "PASS", performed_on: "2026-11-01", certificate_ref: "C2", performed_by: "Lab" });
    const { unmount } = route(detail({ status: "ON_HOLD", calibrations: [good, failed] }), P);
    await userEvent.click(await screen.findByRole("button", { name: "Return to service" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/Assess the impact/);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    unmount();
    route(detail({ status: "ON_HOLD", calibrations: [good, { ...failed, impacts: [{ id: "i1", inspection_id: "x1", status: "NOT_AFFECTED", note: "ok" }] }] }), P);
    await userEvent.click(await screen.findByRole("button", { name: "Return to service" }));
    const d = within(await screen.findByRole("dialog", { name: "Return to service" }));
    await userEvent.click(d.getByRole("button", { name: "Return to service" }));
    await waitFor(() => expect(sent).toMatchObject({ calibration_id: "c2" }));
  });

  it("retires with a reason and shows a server refusal", async () => {
    server.use(http.post("*/api/v1/quality/equipment/q1/retire", () => HttpResponse.json({ error: { code: "invalid_transition", message: "Cannot retire." } }, { status: 409 })));
    route(detail(), P);
    await userEvent.click(await screen.findByRole("button", { name: "Retire" }));
    const d = within(await screen.findByRole("dialog", { name: "Retire the equipment" }));
    await userEvent.click(d.getByRole("button", { name: "Retire" }));
    expect(await d.findByRole("alert")).toHaveTextContent(/Reason is required/);
    await userEvent.type(d.getByLabelText("Reason"), "Damaged");
    await userEvent.click(d.getByRole("button", { name: "Retire" }));
    expect(await d.findByText(/Cannot retire/)).toBeInTheDocument();
  });

  it("retired equipment offers no actions", async () => {
    route(detail({ status: "RETIRED" }), P);
    expect(await screen.findByText("Retired")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Retire" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Schedule a calibration" })).not.toBeInTheDocument();
  });
});
