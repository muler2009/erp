import { useState } from "react";
import { Link } from "react-router";

import { useListNotificationPrefsQuery, useListNotificationsQuery, useMarkAllNotificationsReadMutation, useMarkNotificationReadMutation, useSetNotificationPrefMutation } from "../../shared/api/endpoints";
import { errorMessage } from "../../shared/api/errors";
import { formatDateTime } from "../../shared/lib/format";
import { Badge, Button, Card, EmptyState, ErrorState, PageHeader, Spinner } from "../../shared/ui/primitives";

/** Where a notification's subject lives, when we know. Unknown subjects simply have no link. */
export function notificationLink(refType: string, refId: string): string | null {
  if (!refId) return null;
  const t = refType.toLowerCase();
  if (t.includes("workflow")) return "/app/approvals";
  return null;
}

export const typeLabel = (t: string) => t.replace(/[._]/g, " ");

export function NotificationBell() {
  const { data } = useListNotificationsQuery({ unread: true }, { pollingInterval: 60000 });
  const n = data?.unread_count ?? 0;
  return (
    <Link to="/app/notifications" className="relative rounded-md px-2 py-1 text-sm text-slate-700 hover:bg-slate-100" aria-label={n > 0 ? `Notifications, ${n} unread` : "Notifications"}>
      Notifications{n > 0 && <span className="ml-1 rounded-full bg-red-600 px-1.5 text-xs font-semibold text-white">{n > 99 ? "99+" : n}</span>}
    </Link>
  );
}

export function NotificationsPage() {
  const [cursor, setCursor] = useState<string | null>(null);
  const [unreadOnly, setUnreadOnly] = useState(false);
  const q = useListNotificationsQuery({ cursor, unread: unreadOnly });
  const [markOne] = useMarkNotificationReadMutation();
  const [markAll, all] = useMarkAllNotificationsReadMutation();
  const [err, setErr] = useState<string | null>(null);
  const run = async (fn: () => Promise<unknown>) => { setErr(null); try { await fn(); } catch (e) { setErr(errorMessage(e)); } };
  const rows = q.data?.results ?? [];
  return (
    <>
      <PageHeader title="Notifications" description="Messages addressed to you." actions={<div className="flex gap-2"><Link className="rounded-md border border-slate-300 px-3 py-2 text-sm text-slate-700 hover:bg-slate-50" to="/app/notifications/preferences">Preferences</Link><Button variant="secondary" loading={all.isLoading} disabled={(q.data?.unread_count ?? 0) === 0} onClick={() => void run(() => markAll().unwrap())}>Mark all as read</Button></div>} />
      <label className="mb-3 flex items-center gap-2 text-sm"><input type="checkbox" checked={unreadOnly} onChange={(e) => { setUnreadOnly(e.target.checked); setCursor(null); }} />Unread only</label>
      {err && <p role="alert" className="mb-3 text-sm text-red-700">{err}</p>}
      {q.isLoading ? <Spinner /> : q.error ? <ErrorState error={q.error} onRetry={q.refetch} /> : rows.length === 0 ? <EmptyState title={unreadOnly ? "Nothing unread" : "No notifications yet"} /> : (
        <ul className="divide-y divide-slate-100 rounded-md border border-slate-200 bg-white">
          {rows.map((n) => {
            const link = notificationLink(n.ref_type, n.ref_id);
            return (
              <li key={n.id} className={`flex items-start justify-between gap-3 p-3 ${n.read ? "" : "bg-brand-50"}`}>
                <div className="min-w-0 text-sm">
                  <p className={n.read ? "text-slate-700" : "font-semibold text-slate-900"}>{link ? <Link className="underline" to={link}>{n.title}</Link> : n.title} {!n.read && <Badge tone="amber">New</Badge>}</p>
                  {n.body && <p className="text-slate-600">{n.body}</p>}
                  <p className="text-xs text-slate-500">{typeLabel(n.type)} · {formatDateTime(n.created_at)}</p>
                </div>
                {!n.read && <Button variant="secondary" aria-label={`Mark as read: ${n.title}`} onClick={() => void run(() => markOne(n.id).unwrap())}>Mark as read</Button>}
              </li>
            );
          })}
        </ul>
      )}
      <div className="mt-3 flex gap-2">
        {cursor !== null && <Button variant="secondary" onClick={() => setCursor(null)}>First page</Button>}
        {q.data?.next && <Button variant="secondary" onClick={() => setCursor(q.data!.next)}>Older</Button>}
      </div>
    </>
  );
}

export function NotificationPreferencesPage() {
  const prefs = useListNotificationPrefsQuery();
  const seen = useListNotificationsQuery();
  const [set] = useSetNotificationPrefMutation();
  const [err, setErr] = useState<string | null>(null);
  const saved = new Map((prefs.data ?? []).map((p) => [p.notification_type, p]));
  const types = [...new Set([...saved.keys(), ...(seen.data?.results ?? []).map((n) => n.type)])].sort();
  const toggle = async (type: string, key: "in_app" | "email", value: boolean) => {
    setErr(null);
    try { await set({ notification_type: type, [key]: value }).unwrap(); } catch (e) { setErr(errorMessage(e)); }
  };
  return (
    <>
      <PageHeader title="Notification preferences" description="Choose how you hear about each kind of message. Everything is on until you switch it off." />
      {err && <p role="alert" className="mb-3 text-sm text-red-700">{err}</p>}
      {prefs.isLoading ? <Spinner /> : prefs.error ? <ErrorState error={prefs.error} onRetry={prefs.refetch} /> : types.length === 0 ? <EmptyState title="Nothing to set yet" hint="Kinds of notification appear here after you have received one." /> : (
        <Card>
          <table className="w-full text-sm"><caption className="sr-only">Notification preferences</caption>
            <thead><tr className="text-left text-slate-500"><th>Kind</th><th>In the app</th><th>By email</th></tr></thead>
            <tbody>{types.map((t) => { const p = saved.get(t); return (
              <tr key={t} className="border-t border-slate-100"><td className="py-1">{typeLabel(t)}</td>
                <td><input type="checkbox" aria-label={`${typeLabel(t)} in the app`} checked={p?.in_app ?? true} onChange={(e) => void toggle(t, "in_app", e.target.checked)} /></td>
                <td><input type="checkbox" aria-label={`${typeLabel(t)} by email`} checked={p?.email ?? true} onChange={(e) => void toggle(t, "email", e.target.checked)} /></td></tr>); })}</tbody></table>
          <p className="mt-2 text-xs text-slate-500">Email also depends on your workspace setting for notification emails.</p>
        </Card>
      )}
    </>
  );
}
