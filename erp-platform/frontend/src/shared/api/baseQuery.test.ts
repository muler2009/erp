import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";

import { makeStore } from "../../app/store";
import * as auth from "../auth/authService";
import { api } from "./endpoints";

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => { server.resetHandlers(); vi.restoreAllMocks(); });
afterAll(() => server.close());

const me = { context: "tenant", user: { id: "1", email: "a@b.c", display_name: "A" }, tenant: { id: "t", name: "T", slug: "t", status: "ACTIVE" }, modules: [], permissions: [] };

describe("baseQuery", () => {
  it("sends the bearer token", async () => {
    vi.spyOn(auth, "getAccessToken").mockResolvedValue("tok-1");
    let seen = "";
    server.use(http.get("*/api/v1/me", ({ request }) => { seen = request.headers.get("authorization") ?? ""; return HttpResponse.json(me); }));
    const r = await makeStore().dispatch(api.endpoints.getMe.initiate());
    expect(r.data?.tenant.slug).toBe("t");
    expect(seen).toBe("Bearer tok-1");
  });

  it("renews once and retries after a 401", async () => {
    vi.spyOn(auth, "getAccessToken").mockResolvedValue("tok");
    const renew = vi.spyOn(auth, "renew").mockResolvedValue({} as never);
    let calls = 0;
    server.use(http.get("*/api/v1/me", () => (++calls === 1 ? new HttpResponse(null, { status: 401 }) : HttpResponse.json(me))));
    const r = await makeStore().dispatch(api.endpoints.getMe.initiate());
    expect(r.data).toBeTruthy();
    expect(renew).toHaveBeenCalledTimes(1);
    expect(calls).toBe(2);
  });

  it("signs in again when renewal fails", async () => {
    vi.spyOn(auth, "getAccessToken").mockResolvedValue("tok");
    vi.spyOn(auth, "renew").mockResolvedValue(null);
    const signIn = vi.spyOn(auth, "signIn").mockResolvedValue(undefined);
    server.use(http.get("*/api/v1/me", () => new HttpResponse(null, { status: 401 })));
    const r = await makeStore().dispatch(api.endpoints.getMe.initiate());
    expect(r.error).toMatchObject({ status: 401 });
    expect(signIn).toHaveBeenCalled();
  });

  it("normalizes the error envelope", async () => {
    vi.spyOn(auth, "getAccessToken").mockResolvedValue("tok");
    server.use(http.get("*/api/v1/me", () => HttpResponse.json({ error: { code: "forbidden", message: "No.", details: [], correlation_id: "c" } }, { status: 403 })));
    const r = await makeStore().dispatch(api.endpoints.getMe.initiate());
    expect(r.error).toMatchObject({ status: 403, code: "forbidden", correlationId: "c" });
  });

  it("flattens cursor pages", async () => {
    vi.spyOn(auth, "getAccessToken").mockResolvedValue("tok");
    server.use(http.get("*/api/v1/users", () => HttpResponse.json({ results: [], next: "http://x/api/v1/users?cursor=zz", previous: null })));
    const r = await makeStore().dispatch(api.endpoints.listUsers.initiate());
    expect(r.data?.next).toBe("zz");
  });
});
