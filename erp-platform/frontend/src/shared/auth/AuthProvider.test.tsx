import { render, screen, waitFor } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";

import * as svc from "./authService";
import { AuthProvider, useAuth } from "./AuthProvider";

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => { server.resetHandlers(); vi.restoreAllMocks(); window.history.replaceState(null, "", "/"); });
afterAll(() => server.close());

const cfg = { context: "tenant", oidc: { issuer: "http://kc/realms/erp", client_id: "erp-spa", scope: "openid" }, tenant: { name: "Acme", slug: "acme" } };
const Child = () => <p>{useAuth().status}</p>;

describe("AuthProvider", () => {
  beforeEach(() => {
    server.use(http.get("*/api/v1/public/config", () => HttpResponse.json(cfg)));
    vi.spyOn(svc, "initAuth").mockReturnValue({} as never);
    vi.spyOn(svc, "onSessionLost").mockReturnValue(() => {});
  });

  it("redirects to sign-in, remembering the path, when there is no session", async () => {
    window.history.replaceState(null, "", "/app/settings/users?x=1");
    vi.spyOn(svc, "currentUser").mockResolvedValue(null);
    const signIn = vi.spyOn(svc, "signIn").mockResolvedValue(undefined);
    render(<AuthProvider><Child /></AuthProvider>);
    await waitFor(() => expect(signIn).toHaveBeenCalledWith("/app/settings/users?x=1"));
    expect(screen.queryByText("authenticated")).toBeNull();
  });

  it("renders children when a session exists", async () => {
    vi.spyOn(svc, "currentUser").mockResolvedValue({} as never);
    render(<AuthProvider><Child /></AuthProvider>);
    expect(await screen.findByText("authenticated")).toBeInTheDocument();
  });

  it("completes the callback once and returns to the saved path", async () => {
    window.history.replaceState(null, "", "/signin-callback?code=1&state=2");
    const done = vi.spyOn(svc, "completeSignIn").mockResolvedValue("/app/dashboard");
    vi.spyOn(svc, "currentUser").mockResolvedValue({} as never);
    render(<AuthProvider><Child /></AuthProvider>);
    expect(await screen.findByText("authenticated")).toBeInTheDocument();
    expect(done).toHaveBeenCalledTimes(1);
    expect(window.location.pathname).toBe("/app/dashboard");
  });

  it("shows an error for an unknown host", async () => {
    server.use(http.get("*/api/v1/public/config", () => new HttpResponse(null, { status: 404 })));
    render(<AuthProvider><Child /></AuthProvider>);
    expect(await screen.findByText(/not a known workspace/i)).toBeInTheDocument();
  });

  it("shows an error when the callback fails", async () => {
    window.history.replaceState(null, "", "/signin-callback?code=1&state=bad");
    vi.spyOn(svc, "completeSignIn").mockRejectedValue(new Error("No matching state found"));
    render(<AuthProvider><Child /></AuthProvider>);
    expect(await screen.findByText(/No matching state/)).toBeInTheDocument();
  });

  it("signs in again when the session is lost", async () => {
    vi.spyOn(svc, "currentUser").mockResolvedValue({} as never);
    let lost: () => void = () => {};
    const register = vi.spyOn(svc, "onSessionLost").mockImplementation((h) => { lost = h; return () => {}; });
    const signIn = vi.spyOn(svc, "signIn").mockResolvedValue(undefined);
    render(<AuthProvider><Child /></AuthProvider>);
    await screen.findByText("authenticated");
    await waitFor(() => expect(register).toHaveBeenCalled()); // the handler is registered in an effect after the render
    lost();
    expect(signIn).toHaveBeenCalled();
  });
});
