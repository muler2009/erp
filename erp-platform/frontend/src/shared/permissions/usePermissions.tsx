import { createContext, useContext, useMemo, type ReactNode } from "react";


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

export function AccessProvider({ me, children }: { me: { permissions: string[]; modules?: string[] }; children: ReactNode }) {
  const value = useMemo<Access>(() => {
    const perms = new Set(me.permissions);
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
