import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { Route, Routes } from "react-router";

import * as auth from "../../shared/auth/authService";
import { renderWithProviders } from "../../test/utils";
import { RfqDetailPage } from "./RfqDetailPage";
import { SingleSourcePage, singleSourceInput, singleSourceProblem, type SsDraft } from "./SingleSourcePage";
import { esc, poDocumentHtml } from "./poDocument";

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
beforeEach(() => vi.spyOn(auth, "getAccessToken").mockResolvedValue("tok"));
afterEach(() => { server.resetHandlers(); vi.restoreAllMocks(); });
afterAll(() => server.close());

const ssd = (o: Partial<SsDraft> = {}): SsDraft => ({ supplier: "s1", currency: "USD", order_date: "2026-11-19", justification: "Only supplier certified for this part", lines: [{ description: "Valve", quantity: "2", unit_price: "10.5" }], ...o });

describe("helpers", () => {
  it("singleSourceProblem", () => {
    expect(singleSourceProblem(ssd())).toBeNull();
    expect(singleSourceProblem(ssd({ supplier: "" }))).toMatch(/supplier/);
    expect(singleSourceProblem(ssd({ currency: "" }))).toMatch(/currency/);
    expect(singleSourceProblem(ssd({ justification: "too short" }))).toMatch(/20/);
    expect(singleSourceProblem(ssd({ lines: [] }))).toMatch(/at least one/);
    expect(singleSourceProblem(ssd({ lines: [{ description: "x", quantity: "0", unit_price: "1" }] }))).toMatch(/more than 0/);
    expect(singleSourceProblem(ssd({ lines: [{ description: "x", quantity: "1", unit_price: "abc" }] }))).toMatch(/unit price/);
  });
  it("singleSourceInput trims", () => {
    expect(singleSourceInput(ssd({ justification: "  Only supplier certified for this part  " })).justification).toBe("Only supplier certified for this part");
  });
  it("poDocumentHtml escapes user text", () => {
    expect(esc(`<b>"x"&'`)).toBe("&lt;b&gt;&quot;x&quot;&amp;&#39;");
    const html = poDocumentHtml({ id: "p", number: "PO-1", supplier: { id: "s", name: "<script>alert(1)</script>" }, currency: "USD", status: "APPROVED", order_date: "2026-11-19", expected_date: null, total: "21.0000", invoiced_value: "0", version: 1, workflow_instance_id: null, lines: [{ id: "l", line_no: 1, product: null, description: "<img src=x onerror=1>", quantity: "2", unit_price: "10.5", received_quantity: "0" }] });
    expect(html).not.toContain("<script>alert");
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("PO-1");
    expect(html).toContain("&lt;script&gt;");
  });
});

describe("SingleSourcePage", () => {
  it("lists orders and creates one with the server's rule message shown", async () => {
    let body: unknown = null;
    server.use(
      http.get("*/api/v1/procurement/single-source", () => HttpResponse.json({ results: [{ po: "PO-9", supplier: "Acme", total: "21.0000", currency: "USD", justification: "Only certified supplier", status: "DRAFT" }] })),
      http.get("*/api/v1/procurement/suppliers", () => HttpResponse.json({ results: [{ id: "s1", name: "Acme", tax_id: "", email: "", status: "QUALIFIED", partner: null, qualified_at: null }], next: null })),
      http.get("*/api/v1/org/currencies", () => HttpResponse.json({ results: [{ code: "USD", name: "Dollar", is_active: true }], next: null })),
      http.post("*/api/v1/procurement/single-source", async ({ request }) => { body = await request.json(); return HttpResponse.json({ id: "p", number: "PO-10" }, { status: 201 }); }),
    );
    renderWithProviders(<SingleSourcePage />, { permissions: ["procurement.view", "procurement.single_source"] });
    expect(await screen.findByText("PO-9")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "New single-source order" }));
    await userEvent.click(await screen.findByRole("button", { name: "Create order" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/supplier/);
    await userEvent.selectOptions(await screen.findByLabelText("Supplier"), "s1");
    await userEvent.selectOptions(await screen.findByLabelText("Currency"), "USD");
    await userEvent.type(screen.getByLabelText("Item 1"), "Valve");
    await userEvent.type(screen.getByLabelText("Unit price 1"), "10.5");
    await userEvent.type(screen.getByLabelText("Justification"), "Only supplier certified for this part");
    await userEvent.click(screen.getByRole("button", { name: "Create order" }));
    await waitFor(() => expect(body).toMatchObject({ supplier: "s1", currency: "USD", justification: "Only supplier certified for this part", lines: [{ description: "Valve", quantity: "1", unit_price: "10.5" }] }));
  });

  it("hides the create button without permission and shows the empty state", async () => {
    server.use(http.get("*/api/v1/procurement/single-source", () => HttpResponse.json({ results: [] })));
    renderWithProviders(<SingleSourcePage />, { permissions: ["procurement.view"] });
    expect(await screen.findByText("No single-source orders")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "New single-source order" })).toBeNull();
  });
});

describe("RFQ clarifications", () => {
  const rfq = { id: "r1", number: "RFQ-1", title: "Bolts", kind: "RFQ", status: "OPEN", due_date: null, requisition: null, closing_at: null, open_to_all: false, suppliers: [{ id: "s1", name: "Acme" }], lines: [], sealed: false, quotation_count: 0, quotations: [] };
  const view = (perms: string[]) => renderWithProviders(<Routes><Route path="/app/procurement/rfqs/:id" element={<RfqDetailPage />} /></Routes>, { permissions: perms, route: "/app/procurement/rfqs/r1" });

  it("asks a question and answers a pending one", async () => {
    const posts: unknown[] = [];
    server.use(
      http.get("*/api/v1/procurement/rfqs/r1", () => HttpResponse.json(rfq)),
      http.get("*/api/v1/procurement/rfqs/r1/clarifications", () => HttpResponse.json({ results: [{ id: "c1", supplier: "s1", question: "Is delivery included?", answer: "" }, { id: "c2", supplier: null, question: "Closing date?", answer: "Friday" }] })),
      http.post("*/api/v1/procurement/rfqs/r1/clarifications", async ({ request }) => { posts.push(await request.json()); return HttpResponse.json({ id: "c3" }, { status: 201 }); }),
    );
    view(["procurement.view", "procurement.rfq.manage"]);
    expect(await screen.findByText("Is delivery included?")).toBeInTheDocument();
    expect(screen.getByText(/Answer: Friday/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Send answer" }));
    expect(await screen.findByText("Write the answer first.")).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText("Answer to Is delivery included?"), "Yes");
    await userEvent.click(screen.getByRole("button", { name: "Send answer" }));
    await waitFor(() => expect(posts[0]).toEqual({ clarification: "c1", answer: "Yes" }));
    await userEvent.type(screen.getByLabelText("Question"), "Packaging?");
    await userEvent.click(screen.getByRole("button", { name: "Post question" }));
    await waitFor(() => expect(posts[1]).toEqual({ question: "Packaging?" }));
  });

  it("is not shown without the manage permission", async () => {
    server.use(http.get("*/api/v1/procurement/rfqs/r1", () => HttpResponse.json(rfq)));
    view(["procurement.view"]);
    await screen.findByText(/RFQ-1/);
    expect(screen.queryByText("Clarifications")).toBeNull();
  });
});
