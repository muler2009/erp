import { createContext, useContext, useMemo, type ReactNode } from "react";

import type { PermissionMap } from "../api/types";


/**
 * What the signed-in user can do, as reported by /api/v1/me. This only decides what to SHOW: the backend
 * checks every request again, so hiding a button is a convenience and never the protection.
 */
interface Access {
  can: (permission: string) => boolean;
  canAny: (permissions: string[]) => boolean;
  hasModule: (module: string) => boolean;
}

const AccessContext = createContext<Access | null>(null);

/**
 * The tenant API reports permissions as an object keyed by code ({ tenant_wide, scopes }); the platform API reports a
 * plain list. A scoped permission held only on some units still counts as held, because the page is shown and the
 * server narrows the data; a code with no reach at all does not count.
 */
export function permissionCodes(p: string[] | PermissionMap): string[] {
  if (Array.isArray(p)) return p;
  return Object.entries(p).filter(([, v]) => v.tenant_wide || v.scopes.length > 0).map(([k]) => k);
}

export function AccessProvider({ me, children }: { me: { permissions: string[] | PermissionMap; modules?: string[] }; children: ReactNode }) {
  const value = useMemo<Access>(() => {
    const perms = new Set(permissionCodes(me.permissions));
    const modules = new Set(me.modules ?? []);
    return {
      can: (p) => perms.has(p),
      canAny: (ps) => ps.some((p) => perms.has(p)),
      hasModule: (m) => modules.has(m),
    };
  }, [me]);
  return <AccessContext.Provider value={value}>{children}</AccessContext.Provider>;
}

export function useAccess(): Access {
  const ctx = useContext(AccessContext);
  if (!ctx) throw new Error("useAccess must be used inside AccessProvider");
  return ctx;
}

export function Can({ permission, children, fallback = null }: { permission: string; children: ReactNode; fallback?: ReactNode }) {
  return useAccess().can(permission) ? <>{children}</> : <>{fallback}</>;
}
