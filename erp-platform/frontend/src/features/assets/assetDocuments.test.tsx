import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";

import * as auth from "../../shared/auth/authService";
import { renderWithProviders } from "../../test/utils";
import { assetDocProblem, AssetDocumentsCard } from "./AssetDocuments";

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
beforeEach(() => vi.spyOn(auth, "getAccessToken").mockResolvedValue("tok"));
afterEach(() => { server.resetHandlers(); vi.restoreAllMocks(); });
afterAll(() => server.close());

describe("asset documents", () => {
  it("checks the form", () => {
    expect(assetDocProblem("NOPE", true)).toMatch(/kind/);
    expect(assetDocProblem("MANUAL", false)).toMatch(/file/);
    expect(assetDocProblem("MANUAL", true)).toBeNull();
  });
  it("lists documents and hides attach without permission", async () => {
    server.use(http.get("*/api/v1/assets/assets/a1/documents", () => HttpResponse.json({ results: [{ id: "d1", type: "MANUAL", title: "User manual", file_id: "f1" }] })));
    renderWithProviders(<AssetDocumentsCard id="a1" />, { permissions: ["assets.view"] });
    expect(await screen.findByText("User manual")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Attach a document" })).toBeNull();
  });
  it("uploads a file and refreshes the list; shows a server refusal", async () => {
    let docs: unknown[] = [];
    let fields: Record<string, unknown> = {};
    let refuse = true;
    server.use(
      http.get("*/api/v1/assets/assets/a1/documents", () => HttpResponse.json({ results: docs })),
      http.post("*/api/v1/assets/assets/a1/documents", async ({ request }) => {
        if (refuse) { refuse = false; return HttpResponse.json({ error: { code: "invalid_doc_type", message: "Unknown document type." } }, { status: 400 }); }
        const f = await request.formData();
        fields = { type: f.get("doc_type"), title: f.get("title"), sent_file: typeof f.get("file") === "object" && f.get("file") !== null };
        docs = [{ id: "d2", type: "INVOICE", title: "Invoice 7", file_id: "f2" }];
        return HttpResponse.json({ id: "d2", file_id: "f2" }, { status: 201 });
      }),
    );
    renderWithProviders(<AssetDocumentsCard id="a1" />, { permissions: ["assets.view", "assets.asset.manage"] });
    await userEvent.click(await screen.findByRole("button", { name: "Attach a document" }));
    await userEvent.click(screen.getByRole("button", { name: "Attach" }));
    expect(await screen.findByText("Choose a file to attach.")).toBeInTheDocument();
    const input = screen.getByLabelText("File") as HTMLInputElement;
    await userEvent.upload(input, new File(["x"], "inv.pdf", { type: "application/pdf" }));
    await userEvent.click(screen.getByRole("button", { name: "Attach" }));
    expect(await screen.findByText("Unknown document type.")).toBeInTheDocument();
    await userEvent.selectOptions(screen.getByLabelText("Kind"), "INVOICE");
    await userEvent.type(screen.getByLabelText("Title (optional)"), "Invoice 7");
    await userEvent.click(screen.getByRole("button", { name: "Attach" }));
    expect(await screen.findByText("Invoice 7")).toBeInTheDocument();
    await waitFor(() => { expect(fields).toEqual({ type: "INVOICE", title: "Invoice 7", sent_file: true }); });
  });
});
