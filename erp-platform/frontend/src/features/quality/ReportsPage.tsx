import { useState } from "react";

import { useGetQualityReportQuery, useListQualityReportsQuery } from "../../shared/api/endpoints";
import { downloadCsv } from "../../shared/lib/csvDownload";
import { Button, Card, EmptyState, ErrorState, PageHeader, Spinner, inputClass } from "../../shared/ui/primitives";

export const ROW_LIMIT = 500;

export function validateRange(from: string, to: string): string | null {
  return from && to && to < from ? "The end date cannot be before the start date." : null;
}

/** Column headings come from the report's own keys: "age_days" becomes "Age days". */
export function heading(key: string): string {
  const t = key.replace(/_/g, " ").trim();
  return t.charAt(0).toUpperCase() + t.slice(1);
}

export function cell(v: unknown): string {
  if (v === null || v === undefined || v === "") return "–";
  if (typeof v === "boolean") return v ? "Yes" : "No";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

export function columnsOf(rows: Record<string, unknown>[]): string[] {
  const cols: string[] = [];
  for (const r of rows) for (const k of Object.keys(r)) if (!cols.includes(k)) cols.push(k);
  return cols;
}

export function ReportsPage() {
  const reports = useListQualityReportsQuery();
  const [code, setCode] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const rangeProblem = validateRange(from, to);
  const params = { code, date_from: from || undefined, date_to: to || undefined };
  const { data, isFetching, error, refetch } = useGetQualityReportQuery(params, { skip: !code || !!rangeProblem });
  const exportCsv = async () => {
    setErr(null); setBusy(true);
    try { await downloadCsv(`/api/v1/quality/reports/${code}/csv`, { ...(from ? { date_from: from } : {}), ...(to ? { date_to: to } : {}) }, `quality-${code}.csv`); } catch (e) { setErr(e instanceof Error ? e.message : "The export failed."); } finally { setBusy(false); }
  };
  const rows = data?.rows ?? [];
  const cols = columnsOf(rows.slice(0, ROW_LIMIT));
  return (
    <>
      <PageHeader title="Quality reports" description="Choose a report, narrow it by date, and read it here or export it as CSV." />
      <Card>
        <div className="mb-3 flex flex-wrap items-end gap-4">
          <label className="text-sm">Report <select aria-label="Report" className={inputClass} value={code} onChange={(e) => setCode(e.target.value)}><option value="">Choose a report…</option>{reports.data?.map((r) => <option key={r.code} value={r.code}>{r.title}</option>)}</select></label>
          <label className="text-sm">From <input aria-label="From date" type="date" className={inputClass} value={from} onChange={(e) => setFrom(e.target.value)} /></label>
          <label className="text-sm">To <input aria-label="To date" type="date" className={inputClass} value={to} onChange={(e) => setTo(e.target.value)} /></label>
          <Button variant="secondary" loading={busy} disabled={!code || !!rangeProblem} onClick={() => void exportCsv()}>Export CSV</Button>
        </div>
        {(rangeProblem || err) && <p role="alert" className="mb-3 text-sm text-red-700">{rangeProblem ?? err}</p>}
        {reports.isLoading ? <Spinner /> : reports.error ? <ErrorState error={reports.error} onRetry={reports.refetch} /> : !code ? <EmptyState title="Choose a report to run" /> : rangeProblem ? <EmptyState title="Fix the date range to run the report" /> : isFetching ? <Spinner /> : error || !data ? <ErrorState error={error} onRetry={refetch} /> : !rows.length ? <EmptyState title="No rows for this report" /> : (
          <>
            <p className="mb-2 text-sm text-slate-600">{data.title}: {data.count} {data.count === 1 ? "row" : "rows"}{data.count > ROW_LIMIT ? `. Showing the first ${ROW_LIMIT}; export the CSV for all of them.` : ""}</p>
            <div className="overflow-x-auto">
              <table className="w-full text-sm"><thead><tr className="text-left">{cols.map((c) => <th key={c} className="pr-4">{heading(c)}</th>)}</tr></thead>
                <tbody>{rows.slice(0, ROW_LIMIT).map((r, i) => <tr key={i} className="border-t">{cols.map((c) => <td key={c} className="pr-4">{cell(r[c])}</td>)}</tr>)}</tbody></table>
            </div>
          </>
        )}
      </Card>
    </>
  );
}
