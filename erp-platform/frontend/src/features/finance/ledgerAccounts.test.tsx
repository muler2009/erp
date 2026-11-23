import { fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";

import * as auth from "../../shared/auth/authService";
import { renderWithProviders } from "../../test/utils";
import { AccountsPage } from "./AccountsPage";
import { LedgerPage, ledgerProblem } from "./AccountEdit";

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
beforeEach(() => vi.spyOn(auth, "getAccessToken").mockResolvedValue("tok"));
afterEach(() => { server.resetHandlers(); vi.restoreAllMocks(); });
afterAll(() => server.close());

const ACC = { id: "a1", code: "1000", name: "Cash", type: "ASSET", parent: null, is_postable: true, is_control: false, system_key: null, is_active: true };
const page = (rows: object[]) => HttpResponse.json({ results: rows, next: null, previous: null });

it("checks ledger input", () => {
  expect(ledgerProblem("", "", "")).toMatch(/account code/);
  expect(ledgerProblem("1000", "2026-02-01", "2026-01-01")).toMatch(/after the end/);
  expect(ledgerProblem("1000", "", "")).toBeNull();
});

describe("account edit", () => {
  it("hides Edit without permission", async () => {
    server.use(http.get("*/api/v1/finance/accounts", () => page([ACC])));
    renderWithProviders(<AccountsPage />, { permissions: ["finance.accounts.view"] });
    await screen.findByText("Cash");
    expect(screen.queryByRole("button", { name: "Edit account 1000" })).toBeNull();
  });
  it("renames and shows a server refusal on deactivate", async () => {
    let body: Record<string, unknown> | null = null;
    server.use(
      http.get("*/api/v1/finance/accounts", () => page([ACC])),
      http.get("*/api/v1/finance/accounts/a1", () => HttpResponse.json({ ...ACC, balance: "250.00" })),
      http.patch("*/api/v1/finance/accounts/a1", async ({ request }) => {
        const b = (await request.json()) as Record<string, unknown>;
        if ("is_active" in b) return HttpResponse.json({ error: { code: "invalid", message: "An account with a balance cannot be deactivated." } }, { status: 400 });
        body = b; return HttpResponse.json({ ...ACC, ...b });
      }),
    );
    renderWithProviders(<AccountsPage />, { permissions: ["finance.accounts.view", "finance.accounts.manage"] });
    await userEvent.click(await screen.findByRole("button", { name: "Edit account 1000" }));
    const name = await screen.findByLabelText("Name");
    await userEvent.clear(name); await userEvent.type(name, "Petty cash");
    await userEvent.click(screen.getByRole("button", { name: "Save name" }));
    expect(await screen.findByText("Name saved.")).toBeInTheDocument();
    expect(body).toEqual({ name: "Petty cash" });
    await userEvent.click(screen.getByRole("button", { name: "Deactivate account" }));
    expect(await screen.findByText(/with a balance cannot be deactivated/)).toBeInTheDocument();
  });
});

describe("LedgerPage", () => {
  it("rejects a backwards range without calling the API", async () => {
    server.use(http.get("*/api/v1/finance/accounts", () => page([ACC])));
    renderWithProviders(<LedgerPage />, { permissions: ["reports.financial.view"] });
    await userEvent.type(screen.getByLabelText("Account code"), "1000");
    fireEvent.change(screen.getByLabelText("From (optional)"), { target: { value: "2026-02-01" } });
    fireEvent.change(screen.getByLabelText("To (optional)"), { target: { value: "2026-01-01" } });
    await userEvent.click(screen.getByRole("button", { name: "Show ledger" }));
    expect(await screen.findByText(/start date is after/)).toBeInTheDocument();
  });
  it("shows opening, rows and closing balance", async () => {
    let q = "";
    server.use(
      http.get("*/api/v1/finance/accounts", () => page([ACC])),
      http.get("*/api/v1/finance/ledger", ({ request }) => { q = new URL(request.url).search; return HttpResponse.json({ account: "1000", name: "Cash", opening_balance: "100.00", rows: [{ date: "2026-01-05", entry: "JE-1", description: "Sale", debit: "50.00", credit: "0.00", balance: "150.00" }], closing_balance: "150.00" }); }),
    );
    renderWithProviders(<LedgerPage />, { permissions: ["reports.financial.view"] });
    await userEvent.type(screen.getByLabelText("Account code"), "1000");
    await userEvent.click(screen.getByRole("button", { name: "Show ledger" }));
    expect(await screen.findByText("JE-1")).toBeInTheDocument();
    expect(screen.getByText(/Opening balance/)).toBeInTheDocument();
    expect(screen.getByText(/Closing balance/)).toBeInTheDocument();
    await waitFor(() => expect(q).toContain("account=1000"));
  });
});
