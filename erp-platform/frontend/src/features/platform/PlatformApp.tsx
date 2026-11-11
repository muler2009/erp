import { NavLink, Navigate, Outlet, Route, Routes } from "react-router";

import { useGetPlatformMeQuery } from "../../shared/api/endpoints";
import { useAuth } from "../../shared/auth/AuthProvider";
import { AccessProvider, useAccess } from "../../shared/permissions/usePermissions";
import { Button, ErrorState, Spinner } from "../../shared/ui/primitives";
import { PlatformAuditPage } from "./AuditPage";
import { TenantsPage } from "./TenantsPage";

function Layout({ name }: { name: string }) {
  const { can } = useAccess();
  const { logout } = useAuth();
  const items = [
    { to: "/platform-admin/tenants", label: "Tenants", permission: "platform.tenants.view" },
    { to: "/platform-admin/audit", label: "Audit log", permission: "platform.audit.view" },
  ].filter((i) => can(i.permission));
  return (
    <div className="min-h-screen bg-slate-50">
      <header className="flex flex-wrap items-center gap-4 bg-slate-900 px-4 py-3 text-white">
        <span className="font-semibold">Platform administration</span>
        <nav aria-label="Platform" className="flex gap-3 text-sm">
          {items.map((i) => (
            <NavLink key={i.to} to={i.to} className={({ isActive }) => (isActive ? "underline" : "text-slate-300 hover:text-white")}>{i.label}</NavLink>
          ))}
        </nav>
        <div className="ml-auto flex items-center gap-3 text-sm">
          <span>{name}</span>
          <Button variant="secondary" onClick={logout}>Sign out</Button>
        </div>
      </header>
      <main className="p-4 md:p-6"><Outlet /></main>
    </div>
  );
}

export function PlatformApp() {
  const { data: me, isLoading, error, refetch } = useGetPlatformMeQuery();
  if (isLoading) return <div className="p-8"><Spinner label="Loading" /></div>;
  if (error || !me) return <div className="p-8"><ErrorState error={error} onRetry={refetch} /></div>;
  return (
    <AccessProvider me={me}>
      <Routes>
        <Route element={<Layout name={me.user.display_name || me.user.email} />}>
          <Route path="/platform-admin/tenants" element={<TenantsPage />} />
          <Route path="/platform-admin/audit" element={<PlatformAuditPage />} />
          <Route path="*" element={<Navigate to="/platform-admin/tenants" replace />} />
        </Route>
      </Routes>
    </AccessProvider>
  );
}
