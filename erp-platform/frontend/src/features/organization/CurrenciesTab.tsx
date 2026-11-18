import type { ColumnDef } from "@tanstack/react-table";
import { useState } from "react";

import { useCreateExchangeRateMutation, useListCurrenciesQuery, useListExchangeRatesQuery, useSetCurrencyActiveMutation } from "../../shared/api/endpoints";
import { errorMessage } from "../../shared/api/errors";
import type { Currency, ExchangeRate } from "../../shared/api/types";
import { DataTable } from "../../shared/ui/DataTable";
import { Badge, Button, Card } from "../../shared/ui/primitives";
import { ActionDialog } from "../hr/ActionDialog";

export function CurrenciesTab({ canManage }: { canManage: boolean }) {
  const [cursor, setCursor] = useState<string | null>(null);
  const [onlyActive, setOnlyActive] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const { data, isLoading, error, refetch } = useListCurrenciesQuery({ cursor, ...(onlyActive ? { active: true } : {}) });
  const [toggle] = useSetCurrencyActiveMutation();
  const columns: ColumnDef<Currency>[] = [
    { header: "Code", accessorKey: "code" },
    { header: "Name", accessorKey: "name" },
    { header: "Symbol", accessorKey: "symbol" },
    { header: "Decimals", accessorKey: "decimals" },
    { header: "Status", cell: ({ row }) => <Badge tone={row.original.is_active ? "green" : "slate"}>{row.original.is_active ? "In use" : "Not in use"}</Badge> },
    ...(canManage ? [{ header: "", id: "toggle", cell: ({ row }: { row: { original: Currency } }) => (
      <Button variant="secondary" onClick={() => { setErr(null); toggle({ code: row.original.code, is_active: !row.original.is_active }).unwrap().catch((e) => setErr(errorMessage(e))); }}>
        {row.original.is_active ? "Stop using" : "Start using"}
      </Button>) } as ColumnDef<Currency>] : []),
  ];
  return (
    <Card title="Currencies">
      <label className="mb-3 flex items-center gap-2 text-sm"><input type="checkbox" checked={onlyActive} onChange={(e) => { setOnlyActive(e.target.checked); setCursor(null); }} /> Only currencies in use</label>
      {err && <p role="alert" className="mb-3 text-sm text-red-700">{err}</p>}
      <DataTable caption="Currencies" columns={columns} page={data} isLoading={isLoading} error={error} onRetry={refetch} emptyTitle="No currencies" onCursor={setCursor} hasPrevious={cursor !== null} onFirst={() => setCursor(null)} />
    </Card>
  );
}

export function RatesTab({ canManage }: { canManage: boolean }) {
  const [cursor, setCursor] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [open, setOpen] = useState(false);
  const active = useListCurrenciesQuery({ active: true });
  const { data, isLoading, error, refetch } = useListExchangeRatesQuery({ cursor, ...(code ? { currency: code } : {}) });
  const [add] = useCreateExchangeRateMutation();
  const options: [string, string][] = (active.data?.results ?? []).map((c) => [c.code, `${c.code} ${c.name}`]);
  const columns: ColumnDef<ExchangeRate>[] = [
    { header: "Date", accessorKey: "rate_date" },
    { header: "Currency", accessorKey: "currency_code" },
    { header: "Rate", accessorKey: "rate" },
    { header: "Source", accessorKey: "source" },
  ];
  return (
    <Card title="Exchange rates" actions={canManage ? <Button onClick={() => setOpen(true)}>Add rate</Button> : undefined}>
      <p className="mb-3 text-sm text-slate-600">Each rate is how many units of your base currency one unit of the foreign currency is worth on that day.</p>
      <label className="mb-3 flex items-center gap-2 text-sm">Show
        <select aria-label="Currency filter" className="rounded border border-slate-300 px-2 py-1" value={code} onChange={(e) => { setCode(e.target.value); setCursor(null); }}>
          <option value="">All currencies</option>{options.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
        </select>
      </label>
      <DataTable caption="Exchange rates" columns={columns} page={data} isLoading={isLoading} error={error} onRetry={refetch} emptyTitle="No exchange rates yet" onCursor={setCursor} hasPrevious={cursor !== null} onFirst={() => setCursor(null)} />
      <ActionDialog title="Add exchange rate" cta="Save rate" open={open} onClose={() => setOpen(false)}
        fields={[{ name: "currency", label: "Currency", required: true, options }, { name: "rate_date", label: "Date", type: "date", required: true }, { name: "rate", label: "Rate (base units per 1)", required: true }, { name: "source", label: "Source" }]}
        submit={async (v) => {
          if (!/^\d+(\.\d{1,8})?$/.test(v.rate!.trim()) || Number(v.rate) <= 0) throw new Error("The rate must be a positive number with at most 8 decimals.");
          await add({ currency: v.currency!, rate_date: v.rate_date!, rate: v.rate!.trim(), source: (v.source ?? "").trim() }).unwrap();
        }} />
    </Card>
  );
}
