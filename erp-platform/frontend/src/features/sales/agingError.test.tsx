import { screen } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";

import * as auth from "../../shared/auth/authService";
import { renderWithProviders } from "../../test/utils";
import { AgingPage } from "./AgingPage";

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
beforeEach(() => vi.spyOn(auth, "getAccessToken").mockResolvedValue("tok"));
afterEach(() => { server.resetHandlers(); vi.restoreAllMocks(); });
afterAll(() => server.close());

it("shows the server's reason when the report cannot be produced (found in the real-browser pass)", async () => {
  server.use(http.get("*/api/v1/sales/receivables/aging", () => HttpResponse.json({ error: { code: "base_currency_required", message: "Set the company's base currency before using finance." } }, { status: 409 })));
  renderWithProviders(<AgingPage />, { permissions: ["sales.view"] });
  expect(await screen.findByText("Set the company's base currency before using finance.")).toBeInTheDocument();
});
