import { zodResolver } from "@hookform/resolvers/zod";
import type { ColumnDef } from "@tanstack/react-table";
import { useMemo, useState } from "react";
import { useFieldArray, useForm, useWatch } from "react-hook-form";
import { z } from "zod";

import { useCreateJournalMutation, useGetJournalQuery, useJournalActionMutation, useListJournalsQuery } from "../../shared/api/endpoints";
import { errorMessage, fieldErrors } from "../../shared/api/errors";
import type { JournalEntry } from "../../shared/api/types";
import { formatMoney, parseMoney, sumMoney } from "../../shared/lib/money";
import { Can, useAccess } from "../../shared/permissions/usePermissions";
import { DataTable } from "../../shared/ui/DataTable";
import { Badge, Button, FormField, Modal, PageHeader, Spinner, inputClass } from "../../shared/ui/primitives";

const amount = z.string().trim().refine((v) => v === "" || parseMoney(v) !== null, "Enter an amount with up to 4 decimals");
const positive = (v: string) => (parseMoney(v) ?? 0n) > 0n;

export const journalSchema = z
  .object({
    entry_date: z.string().min(1, "Date is required"),
    memo: z.string().max(500),
    lines: z.array(z.object({ account: z.string().trim().min(1, "Account code"), debit: amount, credit: amount, description: z.string().max(300) })).min(2, "A journal needs at least two lines"),
  })
  .superRefine((val, ctx) => {
    val.lines.forEach((l, i) => {
      const d = positive(l.debit), c = positive(l.credit);
      if (d === c) ctx.addIssue({ code: "custom", path: ["lines", i, "debit"], message: "Enter either a debit or a credit" });
    });
    if (sumMoney(val.lines.map((l) => l.debit)) !== sumMoney(val.lines.map((l) => l.credit))) {
      ctx.addIssue({ code: "custom", path: ["lines"], message: "Debits and credits must be equal" });
    }
  });
type JournalForm = z.infer<typeof journalSchema>;

const tone = { DRAFT: "amber", POSTED: "green", REVERSED: "slate" } as const;

function NewJournal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [create, state] = useCreateJournalMutation();
  const blank = { account: "", debit: "", credit: "", description: "" };
  const { register, control, handleSubmit, setError, reset, formState } = useForm<JournalForm>({
    resolver: zodResolver(journalSchema),
    defaultValues: { entry_date: new Date().toISOString().slice(0, 10), memo: "", lines: [blank, blank] },
  });
  const { fields, append, remove } = useFieldArray({ control, name: "lines" });
  const lines = useWatch({ control, name: "lines" });
  const debit = sumMoney(lines.map((l) => l.debit)), credit = sumMoney(lines.map((l) => l.credit));
  const close = () => { reset(); onClose(); };
  const submit = handleSubmit(async (body) => {
    try {
      await create({ ...body, lines: body.lines.map((l) => ({ ...l, debit: l.debit || "0", credit: l.credit || "0" })) }).unwrap();
      close();
    } catch (e) {
      const fe = fieldErrors(e);
      setError("root", { message: Object.values(fe)[0] ?? errorMessage(e) });
    }
  });
  const rootErr = formState.errors.root?.message ?? (formState.errors.lines as { message?: string; root?: { message?: string } } | undefined)?.root?.message ?? formState.errors.lines?.message;
  return (
    <Modal title="New journal entry" open={open} onClose={close}>
      <form onSubmit={submit} noValidate className="max-h-[75vh] overflow-y-auto">
        <FormField label="Date" htmlFor="j-date" error={formState.errors.entry_date?.message}>
          <input id="j-date" type="date" className={inputClass} {...register("entry_date")} />
        </FormField>
        <FormField label="Memo" htmlFor="j-memo"><input id="j-memo" className={inputClass} {...register("memo")} /></FormField>
        <table className="mb-2 w-full text-sm">
          <thead><tr><th className="text-left">Account</th><th className="text-right">Debit</th><th className="text-right">Credit</th><th /></tr></thead>
          <tbody>
            {fields.map((f, i) => (
              <tr key={f.id}>
                <td><input aria-label={`Line ${i + 1} account`} className={inputClass} {...register(`lines.${i}.account`)} /></td>
                <td><input aria-label={`Line ${i + 1} debit`} inputMode="decimal" className={`${inputClass} text-right`} {...register(`lines.${i}.debit`)} /></td>
                <td><input aria-label={`Line ${i + 1} credit`} inputMode="decimal" className={`${inputClass} text-right`} {...register(`lines.${i}.credit`)} /></td>
                <td>{fields.length > 2 && <Button variant="secondary" aria-label={`Remove line ${i + 1}`} onClick={() => remove(i)}>×</Button>}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="font-medium"><td>Totals</td><td className="text-right">{formatMoney(debit)}</td><td className="text-right">{formatMoney(credit)}</td><td /></tr>
          </tfoot>
        </table>
        {formState.errors.lines?.map?.((le, i) => le && <p key={i} role="alert" className="text-xs text-red-700">Line {i + 1}: {le.account?.message ?? le.debit?.message ?? le.credit?.message}</p>)}
        <Button variant="secondary" onClick={() => append(blank)}>Add line</Button>
        {rootErr && <p role="alert" className="mt-3 text-sm text-red-700">{rootErr}</p>}
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="secondary" onClick={close}>Cancel</Button>
          <Button type="submit" loading={state.isLoading}>Save draft</Button>
        </div>
      </form>
    </Modal>
  );
}

function JournalDetail({ id, onClose }: { id: string | null; onClose: () => void }) {
  const { data, isFetching, error } = useGetJournalQuery(id ?? "", { skip: !id });
  const [act, state] = useJournalActionMutation();
  const [err, setErr] = useState<string | null>(null);
  const run = async (action: "post" | "reverse") => {
    setErr(null);
    try { await act({ id: id!, action }).unwrap(); } catch (e) { setErr(errorMessage(e)); }
  };
  return (
    <Modal title={data ? `Journal ${data.number}` : "Journal"} open={!!id} onClose={onClose}>
      {isFetching && !data && <Spinner />}
      {error && <p role="alert" className="text-sm text-red-700">{errorMessage(error)}</p>}
      {data && (
        <>
          <p className="mb-2 text-sm text-slate-600">{data.entry_date} · <Badge tone={tone[data.status]}>{data.status}</Badge> {data.memo && `· ${data.memo}`}</p>
          <table className="w-full text-sm">
            <thead><tr><th className="text-left">Account</th><th className="text-right">Debit</th><th className="text-right">Credit</th></tr></thead>
            <tbody>
              {data.lines?.map((l) => (
                <tr key={l.line_no} className="border-t border-slate-100">
                  <td>{l.account} {l.account_name}</td><td className="text-right">{formatMoney(l.debit)}</td><td className="text-right">{formatMoney(l.credit)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {err && <p role="alert" className="mt-3 text-sm text-red-700">{err}</p>}
          <div className="mt-4 flex justify-end gap-2">
            <Can permission="finance.journal.post">
              {data.status === "DRAFT" && <Button loading={state.isLoading} onClick={() => void run("post")}>Post</Button>}
              {data.status === "POSTED" && <Button variant="danger" loading={state.isLoading} onClick={() => void run("reverse")}>Reverse</Button>}
            </Can>
            <Button variant="secondary" onClick={onClose}>Close</Button>
          </div>
        </>
      )}
    </Modal>
  );
}

export function JournalsPage() {
  const [cursor, setCursor] = useState<string | null>(null);
  const [status, setStatus] = useState("");
  const { data, isLoading, error, refetch } = useListJournalsQuery({ cursor, status });
  const [creating, setCreating] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const { can } = useAccess();
  const columns = useMemo<ColumnDef<JournalEntry>[]>(
    () => [
      { header: "Number", cell: ({ row }) => <button type="button" className="text-brand-700 underline" onClick={() => setOpenId(row.original.id)}>{row.original.number}</button> },
      { header: "Date", accessorKey: "entry_date" },
      { header: "Memo", accessorKey: "memo" },
      { header: "Status", cell: ({ row }) => <Badge tone={tone[row.original.status]}>{row.original.status}</Badge> },
    ],
    [],
  );
  return (
    <>
      <PageHeader title="Journal entries" actions={can("finance.journal.create") ? <Button onClick={() => setCreating(true)}>New entry</Button> : undefined} />
      <label className="mb-3 flex items-center gap-2 text-sm">Status
        <select className={`${inputClass} w-auto`} value={status} onChange={(e) => { setStatus(e.target.value); setCursor(null); }}>
          <option value="">All</option><option>DRAFT</option><option>POSTED</option><option>REVERSED</option>
        </select>
      </label>
      <DataTable caption="Journal entries" columns={columns} page={data} isLoading={isLoading} error={error} onRetry={refetch} emptyTitle="No journal entries" onCursor={setCursor} hasPrevious={cursor !== null} onFirst={() => setCursor(null)} />
      <NewJournal open={creating} onClose={() => setCreating(false)} />
      <JournalDetail id={openId} onClose={() => setOpenId(null)} />
    </>
  );
}
