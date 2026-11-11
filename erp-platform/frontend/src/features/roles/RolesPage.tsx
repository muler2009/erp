import { useListRolesQuery } from "../../shared/api/endpoints";
import { Badge, Card, EmptyState, ErrorState, PageHeader, Spinner } from "../../shared/ui/primitives";

export function RolesPage() {
  const { data, isLoading, error, refetch } = useListRolesQuery();
  return (
    <>
      <PageHeader title="Roles" description="What each role is allowed to do in this workspace." />
      {isLoading && <Spinner />}
      {error && <ErrorState error={error} onRetry={refetch} />}
      {data && data.length === 0 && <EmptyState title="No roles defined" />}
      <div className="grid gap-4 md:grid-cols-2">
        {data?.map((r) => (
          <Card key={r.id} title={r.display_name || r.name} actions={r.is_system ? <Badge>System</Badge> : undefined}>
            <p className="mb-2 text-xs text-slate-500">{r.permissions.length} permissions</p>
            <ul className="flex flex-wrap gap-1">
              {r.permissions.map((p) => (
                <li key={p} className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-[11px] text-slate-700">
                  {p}
                </li>
              ))}
            </ul>
          </Card>
        ))}
      </div>
    </>
  );
}
