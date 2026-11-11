/**
 * Browser sign-in with oidc-client-ts (authorization code flow with PKCE).
 *
 * Token handling, deliberately:
 *  - Access and refresh tokens live in memory only (InMemoryWebStorage). Nothing sensitive is written to
 *    localStorage or sessionStorage, so a reload means a new, usually instant, redirect to Keycloak
 *    (the Keycloak session cookie answers it).
 *  - The short-lived sign-in state (state, nonce and the PKCE verifier) uses sessionStorage, because it has to
 *    survive the redirect to the identity provider. It is removed when the callback is processed.
 *  - Who the user is comes from the token; which tenant and what they may do comes from the backend, which
 *    re-checks everything on every call.
 */
import { InMemoryWebStorage, UserManager, WebStorageStateStore, type User } from "oidc-client-ts";

import { safeReturnTo } from "../lib/returnTo";

export interface OidcConfig {
  issuer: string;
  client_id: string;
  scope: string;
}

let manager: UserManager | null = null;
let callbackRun: Promise<string> | null = null;
let renewing: Promise<User | null> | null = null;

export function createUserManager(config: OidcConfig, origin: string = window.location.origin): UserManager {
  return new UserManager({
    authority: config.issuer,
    client_id: config.client_id,
    redirect_uri: `${origin}/signin-callback`,
    post_logout_redirect_uri: `${origin}/`,
    response_type: "code",
    scope: config.scope,
    userStore: new WebStorageStateStore({ store: new InMemoryWebStorage() }),
    stateStore: new WebStorageStateStore({ store: window.sessionStorage }),
    automaticSilentRenew: true,
    accessTokenExpiringNotificationTimeInSeconds: 60,
    loadUserInfo: false,
    monitorSession: false,
    filterProtocolClaims: true,
  });
}

export function initAuth(config: OidcConfig): UserManager {
  manager = createUserManager(config);
  return manager;
}

function need(): UserManager {
  if (!manager) throw new Error("Authentication is not initialised.");
  return manager;
}

export function isReady(): boolean {
  return manager !== null;
}

export async function currentUser(): Promise<User | null> {
  const user = await need().getUser();
  return user && !user.expired ? user : null;
}

export async function getAccessToken(): Promise<string | null> {
  if (!manager) return null;
  return (await currentUser())?.access_token ?? null;
}

export function signIn(returnTo: string): Promise<void> {
  return need().signinRedirect({ state: { returnTo: safeReturnTo(returnTo) } });
}

/** Finishes the redirect from the identity provider once, even if React renders twice. Resolves to the path to open. */
export function completeSignIn(): Promise<string> {
  callbackRun ??= need()
    .signinRedirectCallback()
    .then((user) => safeReturnTo((user.state as { returnTo?: string } | undefined)?.returnTo));
  return callbackRun;
}

/** One renewal at a time: concurrent 401s share the same refresh. Returns null when the session cannot be renewed. */
export function renew(): Promise<User | null> {
  renewing ??= need()
    .signinSilent()
    .catch(() => null)
    .finally(() => {
      renewing = null;
    });
  return renewing;
}

export function signOut(): Promise<void> {
  return need().signoutRedirect();
}

export function onSessionLost(handler: () => void): () => void {
  const m = need();
  m.events.addAccessTokenExpired(handler);
  m.events.addSilentRenewError(handler);
  return () => {
    m.events.removeAccessTokenExpired(handler);
    m.events.removeSilentRenewError(handler);
  };
}

/** For tests: forget the module state. */
export function resetAuthForTests(): void {
  manager = null;
  callbackRun = null;
  renewing = null;
}
