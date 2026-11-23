import { useState } from "react";

import { biDatasetPath } from "../../shared/api/biPath";
import {
  useArchiveBiReportMutation, useCreateBiReportMutation, useCreateBiScheduleMutation, useGetBiCatalogQuery, useListBiReportsQuery, useListBiRunsQuery, useListBiSchedulesQuery,
  useRunBiDatasetQuery, useRunBiReportQuery, useRunBiScheduleNowMutation, useUpdateBiScheduleMutation,
} from "../../shared/api/endpoints";
import { errorMessage } from "../../shared/api/errors";
import type { BiDatasetInfo, BiFilter, BiReportRow, BiRunResult, BiSort } from "../../shared/api/types";
import { downloadFile, downloadFromApi } from "../../shared/lib/fileDownload";
import { useAccess } from "../../shared/permissions/usePermissions";
import { Badge, Button, Card, EmptyState, ErrorState, FormField, Modal, PageHeader, Spinner, inputClass } from "../../shared/ui/primitives";
import { ActionDialog } from "../hr/ActionDialog";
import { useUserOptions } from "../quality/names";

export const PERIODS: [string, string][] = [["TODAY", "Today"], ["LAST_7_DAYS", "Last 7 days"], ["LAST_30_DAYS", "Last 30 days"], ["LAST_90_DAYS", "Last 90 days"], ["MTD", "This month so far"], ["LAST_MONTH", "Last month"], ["QTD", "This quarter so far"], ["LAST_QUARTER", "Last quarter"], ["YTD", "This year so far"], ["LAST_YEAR", "Last year"]];
export const OPS: [string, string][] = [["eq", "is"], ["ne", "is not"], ["gt", "greater than"], ["ge", "at least"], ["lt", "less than"], ["le", "at most"], ["contains", "contains"]];
export const WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const FORMATS: [string, string][] = [["CSV", "CSV"], ["XLSX", "Excel"], ["PDF", "PDF"]];

/** What is wrong with the chosen parameters and filters, or null. The server checks the same things again. */
export function reportProblem(ds: BiDatasetInfo | undefined, params: Record<string, string>, filters: BiFilter[]): string | null {
  if (!ds) return "Choose a dataset.";
  if (!params.period && params.date_from && params.date_to && params.date_from > params.date_to) return "The start date is after the end date.";
  for (const f of filters) {
    if (!f.column) return "Choose a column for each filter.";
    if (f.value.trim() === "") return `Give a value for the filter on ${f.column}.`;
  }
  return null;
}

export function scheduleProblem(frequency: string, weekday: string, day: string, recipients: string[]): string | null {
  if (!frequency) return "Choose how often to send it.";
  if (frequency === "WEEKLY" && weekday === "") return "Choose the weekday.";
  if (frequency === "MONTHLY" && !(Number(day) >= 1 && Number(day) <= 28)) return "Day of month must be 1 to 28.";
  if (recipients.length === 0) return "Choose at least one recipient.";
  return null;
}

const cols = (rows: Record<string, unknown>[]): string[] => [...new Set(rows.flatMap((r) => Object.keys(r)))];

function ResultTable({ result }: { result: BiRunResult }) {
  if (result.rows.length === 0) return <EmptyState title="No rows" hint="Nothing matches these settings." />;
  const c = cols(result.rows);
  return (
    <div>
      {result.truncated && <p className="mb-2 text-sm text-amber-700">Showing the first {result.rows.length} of {result.row_count} rows. Download the report to get all of them.</p>}
      <div className="overflow-x-auto"><table className="min-w-full text-sm">
        <thead><tr>{c.map((h) => <th key={h} scope="col" className="px-2 py-1 text-left font-medium text-slate-600">{h}</th>)}</tr></thead>
        <tbody>{result.rows.map((r, i) => <tr key={i} className="border-t border-slate-100">{c.map((h) => <td key={h} className="px-2 py-1">{String(r[h] ?? "")}</td>)}</tr>)}</tbody>
      </table></div>
    </div>
  );
}

function Downloads({ path, name, disabled }: { path: (fmt: string) => string; name: string; disabled?: boolean }) {
  const { can } = useAccess();
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState("");
  if (!can("analytics.export")) return null;
  const go = async (fmt: string) => {
    setErr(null); setBusy(fmt);
    try { await downloadFromApi(`/${path(fmt)}`, `${name}.${fmt === "XLSX" ? "xlsx" : fmt.toLowerCase()}`); } catch (e) { setErr(e instanceof Error ? e.message : errorMessage(e)); } finally { setBusy(""); }
  };
  return (
    <div className="flex flex-wrap items-center gap-2">
      {FORMATS.map(([k, l]) => <Button key={k} variant="secondary" disabled={disabled} loading={busy === k} onClick={() => void go(k)}>Download {l}</Button>)}
      {err && <p role="alert" className="text-sm text-red-700">{err}</p>}
    </div>
  );
}

function Builder() {
  const cat = useGetBiCatalogQuery();
  const [code, setCode] = useState("");
  const [params, setParams] = useState<Record<string, string>>({});
  const [filters, setFilters] = useState<BiFilter[]>([]);
  const [sort, setSort] = useState<BiSort[]>([]);
  const [picked, setPicked] = useState<string[]>([]);
  const [problem, setProblem] = useState<string | null>(null);
  const [args, setArgs] = useState<{ code: string; params: Record<string, string>; columns: string[]; filters: BiFilter[]; sort: BiSort[] } | null>(null);
  const [allCols, setAllCols] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [create] = useCreateBiReportMutation();
  const run = useRunBiDatasetQuery(args ?? { code: "", params: {} }, { skip: !args });
  const ds = cat.data?.datasets.find((d) => d.code === code);
  const modules = [...new Set((cat.data?.datasets ?? []).map((d) => d.module))].sort();
  const hasDates = !!ds && ("date_from" in ds.params || "as_of" in ds.params);
  const resultCols = run.data ? cols(run.data.rows) : [];
  const set = (k: string, v: string) => setParams({ ...params, [k]: v });

  const doRun = () => {
    const p = reportProblem(ds, params, filters);
    setProblem(p);
    if (p || !ds) return;
    const clean = Object.fromEntries(Object.entries(params).filter(([, v]) => v !== ""));
    if (!picked.length) setAllCols([]);
    setArgs({ code: ds.code, params: clean, columns: picked, filters, sort });
  };
  if (run.data && !picked.length && allCols.length === 0 && resultCols.length) setAllCols(resultCols);
  const columnChoices = allCols.length ? allCols : resultCols;
  const currentArgs = args ?? { code, params, columns: picked, filters, sort };

  return (
    <div className="space-y-4">
      <Card title="Choose the data">
        {cat.isLoading && <Spinner />}
        {cat.error && <ErrorState error={cat.error} onRetry={cat.refetch} />}
        {cat.data && cat.data.datasets.length === 0 && <EmptyState title="No data sets available to you" />}
        {cat.data && cat.data.datasets.length > 0 && (
          <div className="grid gap-3 sm:grid-cols-2">
            <FormField label="Data set" htmlFor="bi-ds">
              <select id="bi-ds" className={inputClass} value={code} onChange={(e) => { setCode(e.target.value); setParams({}); setFilters([]); setSort([]); setPicked([]); setAllCols([]); setArgs(null); setProblem(null); }}>
                <option value="">Choose…</option>
                {modules.map((m) => <optgroup key={m} label={m}>{(cat.data?.datasets ?? []).filter((d) => d.module === m).map((d) => <option key={d.code} value={d.code}>{d.title}</option>)}</optgroup>)}
              </select>
            </FormField>
            {hasDates && (
              <FormField label="Period" htmlFor="bi-period">
                <select id="bi-period" className={inputClass} value={params.period ?? ""} onChange={(e) => set("period", e.target.value)}>
                  <option value="">Custom dates</option>
                  {PERIODS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                </select>
              </FormField>
            )}
            {ds && Object.entries(ds.params).map(([k, kind]) => (k === "period" ? null : (
              <FormField key={k} label={k.replace(/_/g, " ")} htmlFor={`bi-p-${k}`}>
                {Array.isArray(kind)
                  ? <select id={`bi-p-${k}`} className={inputClass} value={params[k] ?? ""} onChange={(e) => set(k, e.target.value)}><option value="">Any</option>{kind.map((o) => <option key={o} value={o}>{o}</option>)}</select>
                  : <input id={`bi-p-${k}`} type={kind === "date" ? "date" : kind === "int" ? "number" : "text"} disabled={!!params.period && (k === "date_from" || k === "date_to" || k === "as_of")} className={inputClass} value={params[k] ?? ""} onChange={(e) => set(k, e.target.value)} />}
              </FormField>
            )))}
          </div>
        )}
      </Card>

      {ds && (
        <Card title="Narrow it down" actions={<Button variant="secondary" onClick={() => setFilters([...filters, { column: "", op: "eq", value: "" }])}>Add filter</Button>}>
          {filters.length === 0 && <p className="text-sm text-slate-500">No filters. Run once to see the columns you can filter, sort and pick.</p>}
          {filters.map((f, i) => (
            <div key={i} className="mb-2 flex flex-wrap items-end gap-2">
              <FormField label="Column" htmlFor={`bi-fc-${i}`}>{columnChoices.length
                ? <select id={`bi-fc-${i}`} className={inputClass} value={f.column} onChange={(e) => setFilters(filters.map((x, j) => (j === i ? { ...x, column: e.target.value } : x)))}><option value="">Choose…</option>{columnChoices.map((c) => <option key={c} value={c}>{c}</option>)}</select>
                : <input id={`bi-fc-${i}`} className={inputClass} value={f.column} onChange={(e) => setFilters(filters.map((x, j) => (j === i ? { ...x, column: e.target.value } : x)))} />}</FormField>
              <FormField label="Condition" htmlFor={`bi-fo-${i}`}><select id={`bi-fo-${i}`} className={inputClass} value={f.op} onChange={(e) => setFilters(filters.map((x, j) => (j === i ? { ...x, op: e.target.value } : x)))}>{OPS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></FormField>
              <FormField label="Value" htmlFor={`bi-fv-${i}`}><input id={`bi-fv-${i}`} className={inputClass} value={f.value} onChange={(e) => setFilters(filters.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))} /></FormField>
              <Button variant="secondary" aria-label={`Remove filter ${i + 1}`} onClick={() => setFilters(filters.filter((_, j) => j !== i))}>Remove</Button>
            </div>
          ))}
          {columnChoices.length > 0 && (
            <>
              <FormField label="Sort by" htmlFor="bi-sort">
                <div className="flex gap-2">
                  <select id="bi-sort" className={inputClass} value={sort[0]?.column ?? ""} onChange={(e) => setSort(e.target.value ? [{ column: e.target.value, desc: sort[0]?.desc }] : [])}><option value="">Default order</option>{columnChoices.map((c) => <option key={c} value={c}>{c}</option>)}</select>
                  <label className="flex items-center gap-1 text-sm"><input type="checkbox" checked={!!sort[0]?.desc} disabled={!sort[0]} onChange={(e) => sort[0] && setSort([{ ...sort[0], desc: e.target.checked }])} />Highest first</label>
                </div>
              </FormField>
              <fieldset className="mt-2"><legend className="text-sm font-medium text-slate-700">Columns to show (none ticked = all)</legend>
                <div className="mt-1 flex flex-wrap gap-3">{columnChoices.map((c) => <label key={c} className="flex items-center gap-1 text-sm"><input type="checkbox" checked={picked.includes(c)} onChange={(e) => setPicked(e.target.checked ? [...picked, c] : picked.filter((x) => x !== c))} />{c}</label>)}</div>
              </fieldset>
            </>
          )}
        </Card>
      )}

      {ds && (
        <div className="flex flex-wrap items-center gap-2">
          <Button onClick={doRun} loading={run.isFetching}>Run report</Button>
          {args && run.data && <Button variant="secondary" onClick={() => setSaving(true)}>Save as report</Button>}
          {args && <Downloads path={(fmt) => biDatasetPath(currentArgs, fmt)} name={args.code} />}
        </div>
      )}
      {problem && <p role="alert" className="text-sm text-red-700">{problem}</p>}
      {run.error && <ErrorState error={run.error} onRetry={run.refetch} />}
      {run.data && !run.error && <Card title={run.data.title ?? "Result"}><ResultTable result={run.data} /></Card>}

      <ActionDialog title="Save as report" open={saving} onClose={() => setSaving(false)} cta="Save report"
        fields={[{ name: "name", label: "Report name", required: true }, { name: "description", label: "Description" }, { name: "shared", label: "Who can see it", options: [["no", "Only me"], ["yes", "Everyone with analytics access"]] }]}
        submit={async (v) => { await create({ name: (v.name ?? "").trim(), description: v.description ?? "", dataset: code, params: args?.params ?? {}, columns: picked, filters, sort, shared: v.shared === "yes" }).unwrap(); }} />
    </div>
  );
}

function Saved({ onSchedule }: { onSchedule: (r: BiReportRow) => void }) {
  const { can } = useAccess();
  const list = useListBiReportsQuery();
  const [open, setOpen] = useState<string | null>(null);
  const run = useRunBiReportQuery({ id: open ?? "" }, { skip: !open });
  const [archive] = useArchiveBiReportMutation();
  const [err, setErr] = useState<string | null>(null);
  return (
    <div className="space-y-4">
      {list.isLoading && <Spinner />}
      {list.error && <ErrorState error={list.error} onRetry={list.refetch} />}
      {err && <p role="alert" className="text-sm text-red-700">{err}</p>}
      {list.data?.length === 0 && <Card><EmptyState title="No saved reports" hint="Run a data set and choose “Save as report”." /></Card>}
      {list.data?.map((r) => (
        <Card key={r.id} title={r.name} actions={r.shared ? <Badge tone="slate">Shared</Badge> : undefined}>
          <p className="text-sm text-slate-600">{r.description || r.dataset}</p>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button variant="secondary" aria-label={`Run ${r.name}`} onClick={() => setOpen(open === r.id ? null : r.id)}>{open === r.id ? "Hide" : "Run"}</Button>
            {can("analytics.export") && <Button variant="secondary" aria-label={`Schedule ${r.name}`} onClick={() => onSchedule(r)}>Schedule</Button>}
            <Button variant="danger" aria-label={`Archive ${r.name}`} onClick={() => { setErr(null); archive(r.id).unwrap().catch((e) => setErr(errorMessage(e))); }}>Archive</Button>
          </div>
          {open === r.id && (
            <div className="mt-3">
              {run.isFetching && <Spinner />}
              {run.error && <ErrorState error={run.error} onRetry={run.refetch} />}
              {run.data && !run.isFetching && <ResultTable result={run.data} />}
              <div className="mt-3"><Downloads path={(fmt) => `api/v1/analytics/reports/${r.id}/export?fmt=${fmt}`} name={r.name} /></div>
            </div>
          )}
        </Card>
      ))}
    </div>
  );
}

function ScheduleDialog({ report, onClose }: { report: BiReportRow | null; onClose: () => void }) {
  const users = useUserOptions(!report);
  const [create] = useCreateBiScheduleMutation();
  const [frequency, setFrequency] = useState("WEEKLY");
  const [weekday, setWeekday] = useState("0");
  const [day, setDay] = useState("1");
  const [fmt, setFmt] = useState("XLSX");
  const [rec, setRec] = useState<string[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const go = async () => {
    const p = scheduleProblem(frequency, weekday, day, rec);
    if (p) { setErr(p); return; }
    setErr(null);
    try {
      await create({ report_id: report!.id, frequency, fmt, recipients: rec, ...(frequency === "WEEKLY" ? { weekday: Number(weekday) } : {}), ...(frequency === "MONTHLY" ? { day_of_month: Number(day) } : {}) }).unwrap();
      setRec([]); onClose();
    } catch (e) { setErr(errorMessage(e)); }
  };
  return (
    <Modal title={`Schedule ${report?.name ?? ""}`} open={!!report} onClose={onClose}>
      <FormField label="How often" htmlFor="sc-freq"><select id="sc-freq" className={inputClass} value={frequency} onChange={(e) => setFrequency(e.target.value)}><option value="DAILY">Every day</option><option value="WEEKLY">Every week</option><option value="MONTHLY">Every month</option></select></FormField>
      {frequency === "WEEKLY" && <FormField label="Weekday" htmlFor="sc-wd"><select id="sc-wd" className={inputClass} value={weekday} onChange={(e) => setWeekday(e.target.value)}>{WEEKDAYS.map((w, i) => <option key={w} value={i}>{w}</option>)}</select></FormField>}
      {frequency === "MONTHLY" && <FormField label="Day of month (1–28)" htmlFor="sc-dom"><input id="sc-dom" type="number" className={inputClass} value={day} onChange={(e) => setDay(e.target.value)} /></FormField>}
      <FormField label="File type" htmlFor="sc-fmt"><select id="sc-fmt" className={inputClass} value={fmt} onChange={(e) => setFmt(e.target.value)}>{FORMATS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></FormField>
      <fieldset className="mb-3"><legend className="text-sm font-medium text-slate-700">Send to</legend>
        {users.map(([id, name]) => <label key={id} className="mr-3 inline-flex items-center gap-1 text-sm"><input type="checkbox" checked={rec.includes(id)} onChange={(e) => setRec(e.target.checked ? [...rec, id] : rec.filter((x) => x !== id))} />{name}</label>)}
      </fieldset>
      {err && <p role="alert" className="mb-3 text-sm text-red-700">{err}</p>}
      <div className="flex justify-end gap-2"><Button variant="secondary" onClick={onClose}>Cancel</Button><Button onClick={() => void go()}>Schedule</Button></div>
    </Modal>
  );
}

const when = (s: { frequency: string; weekday: number | null; day_of_month: number | null }) => (s.frequency === "DAILY" ? "Every day" : s.frequency === "WEEKLY" ? `Every ${WEEKDAYS[s.weekday ?? 0]}` : `Monthly on day ${s.day_of_month}`);

function Schedules() {
  const list = useListBiSchedulesQuery();
  const [update] = useUpdateBiScheduleMutation();
  const [runNow] = useRunBiScheduleNowMutation();
  const [err, setErr] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const fail = (e: unknown) => setErr(errorMessage(e));
  return (
    <Card title="Scheduled deliveries">
      {list.isLoading && <Spinner />}
      {list.error && <ErrorState error={list.error} onRetry={list.refetch} />}
      {err && <p role="alert" className="mb-2 text-sm text-red-700">{err}</p>}
      {note && <p role="status" className="mb-2 text-sm text-green-700">{note}</p>}
      {list.data?.length === 0 && <EmptyState title="Nothing scheduled" hint="Open a saved report and choose “Schedule”." />}
      <ul className="divide-y divide-slate-100">
        {list.data?.map((s) => (
          <li key={s.id} className="py-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium">{s.report}</span>
              <Badge tone={s.is_active ? "green" : "slate"}>{s.is_active ? "Active" : "Stopped"}</Badge>
              {s.last_status === "FAILED" && <Badge tone="red">Last run failed</Badge>}
            </div>
            <p className="text-sm text-slate-600">{when(s)} as {s.fmt}, to {s.recipients.length} {s.recipients.length === 1 ? "person" : "people"}. Next: {s.next_run_on}{s.last_run_on ? `. Last: ${s.last_run_on}` : ""}.</p>
            {s.last_error && <p className="text-sm text-red-700">{s.last_error}</p>}
            <div className="mt-2 flex gap-2">
              <Button variant="secondary" aria-label={`Send ${s.report} now`} onClick={() => { setErr(null); setNote(null); runNow(s.id).unwrap().then(() => setNote(`${s.report} was sent.`)).catch(fail); }}>Send now</Button>
              <Button variant="secondary" aria-label={`${s.is_active ? "Stop" : "Resume"} ${s.report}`} onClick={() => { setErr(null); update({ id: s.id, body: { is_active: !s.is_active } }).unwrap().catch(fail); }}>{s.is_active ? "Stop" : "Resume"}</Button>
            </div>
          </li>
        ))}
      </ul>
    </Card>
  );
}

function History() {
  const [cursor, setCursor] = useState<string | null>(null);
  const q = useListBiRunsQuery({ cursor });
  const [err, setErr] = useState<string | null>(null);
  return (
    <Card title="Report history">
      {q.isLoading && <Spinner />}
      {q.error && <ErrorState error={q.error} onRetry={q.refetch} />}
      {err && <p role="alert" className="mb-2 text-sm text-red-700">{err}</p>}
      {q.data?.results.length === 0 && <EmptyState title="No reports have been run or downloaded yet" />}
      <ul className="divide-y divide-slate-100">
        {q.data?.results.map((r) => (
          <li key={r.id} className="flex flex-wrap items-center gap-2 py-2 text-sm">
            <span className="font-medium">{r.dataset}</span><span>{r.fmt}</span><span>{r.row_count} rows</span>
            <Badge tone={r.status === "OK" ? "green" : "red"}>{r.status === "OK" ? "Done" : "Failed"}</Badge>
            <span className="text-slate-500">{r.created_at.slice(0, 16).replace("T", " ")}</span>
            {r.error && <span className="text-red-700">{r.error}</span>}
            {r.file_id && <Button variant="secondary" aria-label={`Download file of ${r.dataset} ${r.created_at.slice(0, 10)}`} onClick={() => { setErr(null); downloadFile(r.file_id as string, `${r.dataset}.${r.fmt.toLowerCase()}`).catch((e: unknown) => setErr(e instanceof Error ? e.message : errorMessage(e))); }}>Download file</Button>}
          </li>
        ))}
      </ul>
      <div className="mt-3 flex gap-2">
        {cursor && <Button variant="secondary" onClick={() => setCursor(null)}>Back to newest</Button>}
        {q.data?.next && <Button variant="secondary" onClick={() => setCursor(q.data?.next ?? null)}>Older</Button>}
      </div>
    </Card>
  );
}

export function ReportsPage() {
  const { can } = useAccess();
  const tabs = [["build", "Build a report"], ["saved", "Saved reports"], ...(can("analytics.export") ? [["schedules", "Schedules"]] : []), ["history", "History"]] as [string, string][];
  const [tab, setTab] = useState("build");
  const [sched, setSched] = useState<BiReportRow | null>(null);
  return (
    <>
      <PageHeader title="Reports" description="Build a report from any data set you can see, save it, download it, or have it sent on a schedule." />
      <div role="tablist" aria-label="Reports sections" className="mb-4 flex flex-wrap gap-2">
        {tabs.map(([k, l]) => <button key={k} role="tab" type="button" aria-selected={tab === k} onClick={() => setTab(k)} className={`rounded-md px-3 py-1.5 text-sm ${tab === k ? "bg-brand-600 text-white" : "bg-white text-slate-700 ring-1 ring-slate-300"}`}>{l}</button>)}
      </div>
      {tab === "build" && <Builder />}
      {tab === "saved" && <Saved onSchedule={(r) => setSched(r)} />}
      {tab === "schedules" && <Schedules />}
      {tab === "history" && <History />}
      <ScheduleDialog report={sched} onClose={() => setSched(null)} />
    </>
  );
}
