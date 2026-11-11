import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

import type { PublicConfig } from "../api/types";
import { safeReturnTo } from "../lib/returnTo";
import { completeSignIn, currentUser, initAuth, onSessionLost, signIn, signOut } from "./authService";

type Status = "starting" | "signing-in" | "authenticated" | "error";

interface AuthContextValue {
  status: Status;
  config: PublicConfig | null;
  error: string | null;
  logout: () => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside AuthProvider");
  return ctx;
}

async function fetchConfig(): Promise<PublicConfig> {
  const response = await fetch(`${window.location.origin}/api/v1/public/config`, { headers: { Accept: "application/json" } });
  if (!response.ok) throw new Error(response.status === 404 ? "This address is not a known workspace." : "The server could not be reached.");
  return (await response.json()) as PublicConfig;
}

/**
 * Starts the app: asks the host who it is, then either finishes a sign-in redirect, continues an existing in-memory
 * session, or sends the browser to the identity provider. Children render only when a session exists.
 */
export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<Status>("starting");
  const [config, setConfig] = useState<PublicConfig | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const cfg = await fetchConfig();
        if (cancelled) return;
        setConfig(cfg);
        initAuth(cfg.oidc);
        if (window.location.pathname === "/signin-callback") {
          const returnTo = await completeSignIn();
          window.history.replaceState(null, "", returnTo);
        }
        if (await currentUser()) {
          if (!cancelled) setStatus("authenticated");
          return;
        }
        if (!cancelled) setStatus("signing-in");
        await signIn(safeReturnTo(window.location.pathname + window.location.search));
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : "Sign-in failed.");
          setStatus("error");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (status !== "authenticated") return;
    return onSessionLost(() => {
      void signIn(window.location.pathname + window.location.search);
    });
  }, [status]);

  const logout = useCallback(() => {
    void signOut();
  }, []);

  const value = useMemo(() => ({ status, config, error, logout }), [status, config, error, logout]);

  if (status === "authenticated") return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
  return (
    <AuthContext.Provider value={value}>
      <div className="flex min-h-screen items-center justify-center p-6" role="status" aria-live="polite">
        {status === "error" ? (
          <div className="max-w-md rounded-lg border border-red-200 bg-white p-6 text-center shadow-sm">
            <h1 className="text-lg font-semibold text-red-700">Cannot sign in</h1>
            <p className="mt-2 text-sm text-slate-600">{error}</p>
            <button
              type="button"
              className="mt-4 rounded-md bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700"
              onClick={() => window.location.assign("/")}
            >
              Try again
            </button>
          </div>
        ) : (
          <p className="text-sm text-slate-500">{status === "signing-in" ? "Redirecting to sign in…" : "Loading…"}</p>
        )}
      </div>
    </AuthContext.Provider>
  );
}
