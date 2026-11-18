import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { useState } from "react";

import { ActionDialog } from "../../features/hr/ActionDialog";
import { useUserNames } from "../../features/quality/names";
import * as auth from "../auth/authService";
import { knownName, resetUserNames } from "../lib/userNames";
import { renderWithProviders } from "../../test/utils";
import { UserSelect } from "./UserSelect";

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
beforeEach(() => { vi.spyOn(auth, "getAccessToken").mockResolvedValue("tok"); resetUserNames(); });
afterEach(() => { server.resetHandlers(); vi.restoreAllMocks(); });
afterAll(() => server.close());

const bea = { id: "11111111-1111-4111-8111-111111111111", display_name: "Bea Builder" };
const search = http.get("*/api/v1/directory/users", ({ request }) => {
  const u = new URL(request.url);
  const q = u.searchParams.get("q");
  const ids = u.searchParams.get("ids");
  if (ids) return HttpResponse.json({ results: ids.split(",").includes(bea.id) ? [bea] : [] });
  return HttpResponse.json({ results: q && "bea builder".includes(q.toLowerCase()) ? [bea] : [] });
});

function Harness({ onValue }: { onValue: (v: string) => void }) {
  const [v, setV] = useState("");
  return <><label htmlFor="who">Owner</label><UserSelect id="who" value={v} onChange={(x) => { setV(x); onValue(x); }} options={[["u1", "E-1 Abel"]]} /></>;
}

describe("UserSelect", () => {
  it("lists the known colleagues, and finds someone who is not in the list", async () => {
    server.use(search);
    const seen: string[] = [];
    renderWithProviders(<Harness onValue={(v) => seen.push(v)} />, { permissions: [] });
    expect(screen.getByRole("option", { name: "E-1 Abel" })).toBeInTheDocument();
    await userEvent.type(screen.getByRole("combobox", { name: "Find someone else" }), "Bea");
    await userEvent.click(await screen.findByRole("button", { name: "Bea Builder" }));
    expect(seen).toEqual([bea.id]);
    expect(screen.getByRole("option", { name: "Bea Builder" })).toBeInTheDocument();
    expect((screen.getByLabelText("Owner") as HTMLSelectElement).value).toBe(bea.id);
    expect(knownName(bea.id)).toBe("Bea Builder");
  });

  it("does not search for fewer than two characters", async () => {
    let calls = 0;
    server.use(http.get("*/api/v1/directory/users", () => { calls += 1; return HttpResponse.json({ results: [] }); }));
    renderWithProviders(<Harness onValue={() => {}} />, { permissions: [] });
    await userEvent.type(screen.getByRole("combobox", { name: "Find someone else" }), "B");
    await new Promise((r) => setTimeout(r, 400));
    expect(calls).toBe(0);
  });

  it("works inside a generic dialog and submits the found person's id", async () => {
    server.use(search);
    let got: Record<string, string> = {};
    renderWithProviders(<ActionDialog title="Assign" open onClose={() => {}} cta="Assign" fields={[{ name: "who", label: "Assign to", required: true, options: [["u1", "E-1 Abel"]], searchUsers: true }]} submit={async (v) => { got = v; }} />, { permissions: [] });
    const d = within(screen.getByRole("dialog", { name: "Assign" }));
    await userEvent.type(d.getByRole("combobox", { name: "Find someone else" }), "Bea");
    await userEvent.click(await d.findByRole("button", { name: "Bea Builder" }));
    await userEvent.click(d.getByRole("button", { name: "Assign" }));
    await waitFor(() => expect(got).toEqual({ who: bea.id }));
  });
});

describe("useUserNames", () => {
  function Names({ ids }: { ids: string[] }) {
    const nameOf = useUserNames();
    return <ul>{ids.map((i) => <li key={i}>{nameOf(i)}</li>)}</ul>;
  }

  it("shows employees by name, and looks up anyone else in one batch", async () => {
    let asked = "";
    server.use(http.get("*/api/v1/hr/employees", () => HttpResponse.json({ results: [{ id: "e1", employee_no: "E-1", name: "Abel", status: "ACTIVE", user_id: "u1" }] })),
      http.get("*/api/v1/directory/users", ({ request }) => { asked = new URL(request.url).searchParams.get("ids") ?? ""; return HttpResponse.json({ results: [bea] }); }));
    renderWithProviders(<Names ids={["u1", bea.id, bea.id]} />, { permissions: [] });
    expect(await screen.findByText("Abel")).toBeInTheDocument();
    await waitFor(() => expect(screen.getAllByText("Bea Builder")).toHaveLength(2));
    expect(asked).toBe(bea.id);
  });

  it("keeps the short fallback when the directory does not know the id", async () => {
    server.use(http.get("*/api/v1/hr/employees", () => HttpResponse.json({ results: [] })), http.get("*/api/v1/directory/users", () => HttpResponse.json({ results: [] })));
    renderWithProviders(<Names ids={["99999999-9999-4999-8999-999999999999"]} />, { permissions: [] });
    expect(await screen.findByText("User 99999999")).toBeInTheDocument();
  });
});
