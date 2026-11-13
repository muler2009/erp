import { useState } from "react";

import { useImportEmployeesMutation, useImportPunchesMutation } from "../../shared/api/endpoints";
import type { ImportReport, PunchReport } from "../../shared/api/types";
import { useAccess } from "../../shared/permissions/usePermissions";
import { Badge, Button, Card, PageHeader, inputClass } from "../../shared/ui/primitives";
import { failure } from "./ActionDialog";

export const MAX_CSV_CHARS = 1_000_000;
export const MAX_PUNCHES = 5000;

/** Parses "employee_no,timestamp" lines (an optional header is skipped). Timestamps must carry a zone offset. */
export function parsePunches(text: string): { punches: { employee_no: string; timestamp: string }[]; error: string | null } {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const rows = /^employee_no\s*,/i.test(lines[0] ?? "") ? lines.slice(1) : lines;
  if (rows.length === 0) return { punches: [], error: "Paste at least one punch (employee_no,timestamp)." };
  if (rows.length > MAX_PUNCHES) return { punches: [], error: `At most ${MAX_PUNCHES} punches per upload.` };
  const punches: { employee_no: string; timestamp: string }[] = [];
  for (const [i, line] of rows.entries()) {
    const [no, ts, ...rest] = line.split(",").map((x) => x.trim());
    if (!no || !ts || rest.length) return { punches: [], error: `Line ${i + 1}: expected "employee_no,timestamp".` };
    if (!/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2})?(Z|[+-]\d{2}:?\d{2})$/.test(ts)) return { punches: [], error: `Line ${i + 1}: the timestamp needs a date, a time and a zone, e.g. 2026-11-02T08:01:00+03:00.` };
    punches.push({ employee_no: no, timestamp: ts });
  }
  return { punches, error: null };
}

export function validateCsv(text: string): string | null {
  if (!text.trim()) return "Paste or choose a CSV file first.";
  if (text.length > MAX_CSV_CHARS) return "The file is too large (limit 1,000,000 characters).";
  if (!/first_name/.test(text.split(/\r?\n/)[0] ?? "")) return "The first line must be the header row (first_name, last_name, hire_date, …).";
  return null;
}

async function readFile(f: File | undefined): Promise<string> {
  if (!f) return "";
  if (f.size > MAX_CSV_CHARS * 2) throw new Error("The file is too large.");
  return await f.text();
}

function EmployeeImport() {
  const [csv, setCsv] = useState("");
  const [report, setReport] = useState<ImportReport | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [run, state] = useImportEmployeesMutation();
  const go = async (commit: boolean) => {
    const p = validateCsv(csv);
    if (p) { setErr(p); return; }
    setErr(null);
    try { setReport(await run({ csv, commit }).unwrap()); } catch (e) { setErr(failure(e)); }
  };
  return (
    <Card title="Import employees">
      <p className="mb-2 text-sm text-slate-600">Columns: first_name, last_name, hire_date (YYYY-MM-DD), optional email, phone, tax_id, bank_account, employment_type, date_of_birth, address. Check first; nothing is created unless every row is valid.</p>
      <input aria-label="Employee CSV file" type="file" accept=".csv,text/csv" className="mb-2 block text-sm" onChange={(e) => { setReport(null); readFile(e.target.files?.[0]).then(setCsv).catch((x) => setErr(failure(x))); }} />
      <textarea aria-label="Employee CSV" rows={6} className={inputClass} value={csv} onChange={(e) => { setCsv(e.target.value); setReport(null); }} />
      {err && <p role="alert" className="mt-2 text-sm text-red-700">{err}</p>}
      <div className="mt-2 flex gap-2">
        <Button variant="secondary" loading={state.isLoading} onClick={() => void go(false)}>Check file</Button>
        <Button loading={state.isLoading} disabled={!report || report.error_rows > 0 || report.committed} onClick={() => void go(true)}>Import employees</Button>
      </div>
      {report && (
        <div className="mt-3 text-sm" role="status">
          {report.committed ? <p>Imported {report.created.length} employee(s): {report.created.join(", ")}.</p> : <p>{report.valid_rows} valid row(s), {report.error_rows} with errors.</p>}
          <ul>{report.rows.filter((r) => !r.ok).map((r) => <li key={r.row}><Badge tone="red">Row {r.row}</Badge> {r.errors.join("; ")}</li>)}</ul>
        </div>
      )}
    </Card>
  );
}

function PunchImport() {
  const [text, setText] = useState("");
  const [report, setReport] = useState<PunchReport | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [run, state] = useImportPunchesMutation();
  const go = async () => {
    const { punches, error } = parsePunches(text);
    if (error) { setErr(error); return; }
    setErr(null);
    try { setReport(await run({ punches }).unwrap()); } catch (e) { setErr(failure(e)); }
  };
  return (
    <Card title="Import attendance punches">
      <p className="mb-2 text-sm text-slate-600">One punch per line: employee_no,timestamp (with zone). The first punch of a day is the check-in, the last the check-out; manual and corrected records are kept.</p>
      <textarea aria-label="Punches" rows={6} className={inputClass} value={text} onChange={(e) => { setText(e.target.value); setReport(null); }} />
      {err && <p role="alert" className="mt-2 text-sm text-red-700">{err}</p>}
      <div className="mt-2"><Button loading={state.isLoading} onClick={() => void go()}>Import punches</Button></div>
      {report && <p role="status" className="mt-3 text-sm">{report.created} created, {report.updated} updated, {report.skipped} skipped, {report.invalid_rows} invalid.{report.unknown_employees.length > 0 && ` Unknown employees: ${report.unknown_employees.join(", ")}.`}</p>}
    </Card>
  );
}

export function ImportPage() {
  const { can } = useAccess();
  return (
    <>
      <PageHeader title="Imports" description="Bulk-load employees and attendance punches." />
      <div className="grid gap-4">
        {can("hr.employee.manage") && <EmployeeImport />}
        {can("hr.attendance.import") && <PunchImport />}
      </div>
    </>
  );
}
