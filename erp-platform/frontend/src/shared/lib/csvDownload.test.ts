import * as auth from "../auth/authService";
import { downloadCsv } from "./csvDownload";

describe("downloadCsv", () => {
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  it("sends the bearer token and the query, then saves the file under the given name", async () => {
    vi.spyOn(auth, "getAccessToken").mockResolvedValue("tok");
    const fetchMock = vi.fn().mockResolvedValue(new Response("a,b\n1,2\n", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const create = vi.fn().mockReturnValue("blob:x");
    const revoke = vi.fn();
    vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: create, revokeObjectURL: revoke }));
    let saved = "";
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) { saved = this.download; });
    await downloadCsv("/api/v1/quality/reports/x/csv", { date_from: "2026-01-01" }, "quality-x.csv");
    expect(fetchMock).toHaveBeenCalledWith("/api/v1/quality/reports/x/csv?date_from=2026-01-01", { headers: { Authorization: "Bearer tok" } });
    expect(saved).toBe("quality-x.csv");
    expect(create).toHaveBeenCalled();
    expect(revoke).toHaveBeenCalledWith("blob:x");
  });

  it("raises the server's message when the export is refused", async () => {
    vi.spyOn(auth, "getAccessToken").mockResolvedValue("tok");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: { code: "forbidden", message: "You cannot export this." } }), { status: 403 })));
    await expect(downloadCsv("/x", {}, "f.csv")).rejects.toThrow("You cannot export this.");
  });

  it("falls back to a plain message when the error is not JSON", async () => {
    vi.spyOn(auth, "getAccessToken").mockResolvedValue(null);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("oops", { status: 500 })));
    await expect(downloadCsv("/x", {}, "f.csv")).rejects.toThrow("could not be downloaded");
  });
});
