import { useState } from "react";

import { useGetCompanyQuery, useListCurrenciesQuery, useUpdateCompanyMutation } from "../../shared/api/endpoints";
import { errorMessage } from "../../shared/api/errors";
import type { Company } from "../../shared/api/types";
import { useAccess } from "../../shared/permissions/usePermissions";
import { Button, Card, ErrorState, FormField, PageHeader, Spinner, inputClass } from "../../shared/ui/primitives";

const DAYS: [number, string][] = [[1, "Mon"], [2, "Tue"], [3, "Wed"], [4, "Thu"], [5, "Fri"], [6, "Sat"], [7, "Sun"]];
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

function CompanyForm({ company, canEdit }: { company: Company; canEdit: boolean }) {
  const [save, { isLoading }] = useUpdateCompanyMutation();
  const [f, setF] = useState({ legal_name: company.legal_name, trade_name: company.trade_name, registration_number: company.registration_number, tax_id: company.tax_id, country: company.country, address: company.address, phone: company.phone, email: company.email, fiscal_year_start_month: company.fiscal_year_start_month });
  const currencies = useListCurrenciesQuery({ active: true });
  const [base, setBase] = useState(company.base_currency ?? "");
  const [days, setDays] = useState<number[]>(company.work_days.length ? company.work_days : [1, 2, 3, 4, 5]);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const text = (name: keyof typeof f, label: string, area = false) => (
    <FormField label={label} htmlFor={`co-${name}`}>
      {area ? <textarea id={`co-${name}`} rows={3} disabled={!canEdit} className={inputClass} value={String(f[name])} onChange={(e) => setF({ ...f, [name]: e.target.value })} />
        : <input id={`co-${name}`} disabled={!canEdit} className={inputClass} value={String(f[name])} onChange={(e) => setF({ ...f, [name]: e.target.value })} />}
    </FormField>
  );
  const submit = async () => {
    if (!f.legal_name.trim()) { setMsg({ ok: false, text: "Legal name is required." }); return; }
    try { await save({ ...f, base_currency: base || null, work_days: days, version: company.version }).unwrap(); setMsg({ ok: true, text: "Company profile saved." }); } catch (e) { setMsg({ ok: false, text: errorMessage(e) }); }
  };
  return (
    <Card title="Company profile">
      {text("legal_name", "Legal name")}{text("trade_name", "Trade name")}{text("registration_number", "Registration number")}{text("tax_id", "Tax ID")}
      {text("country", "Country (2-letter code)")}{text("address", "Address", true)}{text("phone", "Phone")}{text("email", "Email")}
      <FormField label="Base currency" htmlFor="co-base">
        <select id="co-base" disabled={!canEdit} className={inputClass} value={base} onChange={(e) => setBase(e.target.value)}>
          <option value="">Not set</option>{(currencies.data?.results ?? []).map((c) => <option key={c.id} value={c.id}>{c.code} {c.name}</option>)}
        </select>
      </FormField>
      <FormField label="Fiscal year starts in" htmlFor="co-month">
        <select id="co-month" disabled={!canEdit} className={inputClass} value={f.fiscal_year_start_month} onChange={(e) => setF({ ...f, fiscal_year_start_month: Number(e.target.value) })}>
          {MONTHS.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}
        </select>
      </FormField>
      <fieldset className="mb-3"><legend className="mb-1 text-sm font-medium">Working days</legend>
        <div className="flex gap-3">{DAYS.map(([n, l]) => (
          <label key={n} className="flex items-center gap-1 text-sm"><input type="checkbox" disabled={!canEdit} checked={days.includes(n)} onChange={(e) => setDays(e.target.checked ? [...days, n].sort() : days.filter((d) => d !== n))} />{l}</label>
        ))}</div>
      </fieldset>
      {msg && <p role={msg.ok ? "status" : "alert"} className={`mb-3 text-sm ${msg.ok ? "text-green-700" : "text-red-700"}`}>{msg.text}</p>}
      {canEdit && <div className="flex justify-end"><Button loading={isLoading} onClick={() => void submit()}>Save company profile</Button></div>}
    </Card>
  );
}

export function CompanyPage() {
  const { can } = useAccess();
  const { data, isLoading, error, refetch } = useGetCompanyQuery();
  return (
    <>
      <PageHeader title="Company" description="Legal details, fiscal year and working week." />
      {isLoading ? <Spinner /> : error || !data ? <ErrorState error={error} onRetry={refetch} /> : <CompanyForm key={data.version} company={data} canEdit={can("org.settings.manage")} />}
    </>
  );
}
