import type { ColumnDef } from "@tanstack/react-table";
import { useMemo, useState } from "react";
import { Link } from "react-router";

import { useCreateCrmOpportunityMutation, useListCrmAccountsQuery, useListOpportunitiesQuery, useListStagesQuery, useOpportunityActionMutation } from "../../shared/api/endpoints";
import { errorMessage } from "../../shared/api/errors";
import type { Opportunity } from "../../shared/api/types";
import { formatMoney } from "../../shared/lib/money";
import { useAccess } from "../../shared/permissions/usePermissions";
import { DataTable } from "../../shared/ui/DataTable";
import { useAccountNames } from "../../shared/ui/useAccountNames";
import { ActionDialog as FormDialog } from "../hr/ActionDialog";
import { Badge, Button, FormField, Modal, PageHeader, inputClass } from "../../shared/ui/primitives";

const tone = (s: string) => (s === "WON" ? "green" : s === "LOST" ? "red" : "amber");

function ActionDialog({ opp, onClose }: { opp: Opportunity | null; onClose: () => void }) {
  const stages = useListStagesQuery(undefined, { skip: !opp });
  const [act, state] = useOpportunityActionMutation();
  const [stage, setStage] = useState("");
  const [reason, setReason] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const close = () => { setStage(""); setReason(""); setErr(null); onClose(); };
  const run = async (action: "stage" | "win" | "lose") => {
    setErr(null);
    if (action === "stage" && !stage) { setErr("Choose a stage."); return; }
    if (action === "lose" && !reason.trim()) { setErr("A reason is required to mark an opportunity lost."); return; }
    try { await act({ id: opp!.id, action, stage, reason: reason.trim() }).unwrap(); close(); } catch (e) { setErr(errorMessage(e)); }
  };
  const open = stages.data?.filter((s) => !s.is_won && !s.is_lost) ?? [];
  return (
    <Modal title={opp ? opp.name : ""} open={!!opp} onClose={close}>
      {opp && (
        <>
          <p className="mb-3 text-sm text-slate-600">Stage {opp.stage.toLowerCase()} · {formatMoney(opp.amount)} {opp.currency}</p>
          <FormField label="Move to stage" htmlFor="op-stage">
            <div className="flex gap-2">
              <select id="op-stage" className={inputClass} value={stage} onChange={(e) => setStage(e.target.value)}><option value="">Choose…</option>{open.filter((s) => s.code !== opp.stage).map((s) => <option key={s.code} value={s.code}>{s.name} ({s.probability}%)</option>)}</select>
              <Button variant="secondary" loading={state.isLoading} onClick={() => void run("stage")}>Move</Button>
            </div>
          </FormField>
          <FormField label="Reason (required if lost)" htmlFor="op-reason"><input id="op-reason" className={inputClass} value={reason} onChange={(e) => setReason(e.target.value)} /></FormField>
          {err && <p role="alert" className="mb-3 text-sm text-red-700">{err}</p>}
          <div className="flex justify-end gap-2">
            <Button variant="danger" loading={state.isLoading} onClick={() => void run("lose")}>Mark lost</Button>
            <Button loading={state.isLoading} onClick={() => void run("win")}>Mark won</Button>
            <Button variant="secondary" onClick={close}>Close</Button>
          </div>
        </>
      )}
    </Modal>
  );
}

export function OpportunitiesPage() {
  const [cursor, setCursor] = useState<string | null>(null);
  const [status, setStatus] = useState("OPEN");
  const { data, isLoading, error, refetch } = useListOpportunitiesQuery({ cursor, status });
  const name = useAccountNames();
  const [target, setTarget] = useState<Opportunity | null>(null);
  const { can } = useAccess();
  const manage = can("crm.manage");
  const [creating, setCreating] = useState(false);
  const accounts = useListCrmAccountsQuery(undefined, { skip: !creating });
  const stagesQ = useListStagesQuery(undefined, { skip: !creating });
  const [createOpp] = useCreateCrmOpportunityMutation();
  const columns = useMemo<ColumnDef<Opportunity>[]>(() => {
    const cols: ColumnDef<Opportunity>[] = [
      { header: "Opportunity", cell: ({ row }) => <Link className="text-indigo-700 hover:underline" to={`/app/crm/opportunities/${row.original.id}`}>{row.original.name}</Link> },
      { header: "Account", cell: ({ row }) => name(row.original.account) },
      { header: "Stage", cell: ({ row }) => `${row.original.stage.toLowerCase()} (${row.original.probability}%)` },
      { header: "Amount", cell: ({ row }) => <span className="block text-right">{formatMoney(row.original.amount)} {row.original.currency}</span> },
      { header: "Expected close", cell: ({ row }) => row.original.expected_close ?? "—" },
      { header: "Status", cell: ({ row }) => <Badge tone={tone(row.original.status)}>{row.original.status.toLowerCase()}</Badge> },
    ];
    if (manage) cols.push({ id: "actions", header: "", cell: ({ row }) => row.original.status === "OPEN" ? <Button variant="secondary" aria-label={`Update ${row.original.name}`} onClick={() => setTarget(row.original)}>Update</Button> : null });
    return cols;
  }, [manage, name]);
  return (
    <>
      <PageHeader title="Opportunities" description="The sales pipeline." actions={manage ? <Button onClick={() => setCreating(true)}>New opportunity</Button> : undefined} />
      {creating && (
        <FormDialog title="New opportunity" cta="Create opportunity" open onClose={() => setCreating(false)} initial={{ stage: "PROSPECTING" }}
          fields={[{ name: "name", label: "Name", required: true }, { name: "account", label: "Customer account", required: true, options: (accounts.data?.results ?? []).map((a) => [a.id, a.name]) },
            { name: "amount", label: "Amount" }, { name: "currency", label: "Currency (3 letters)" }, { name: "expected_close", label: "Expected close", type: "date" },
            { name: "stage", label: "Stage", options: (stagesQ.data ?? []).filter((s) => !s.is_won && !s.is_lost).map((s) => [s.code, s.name]) }]}
          submit={async (v) => {
            const amount = (v.amount ?? "").trim() || "0";
            if (!/^\d+(\.\d{1,2})?$/.test(amount)) throw new Error("The amount must be a number with at most 2 decimals.");
            await createOpp({ name: v.name!.trim(), account: v.account, amount, currency: (v.currency ?? "").trim().toUpperCase(), stage: v.stage || "PROSPECTING", ...(v.expected_close ? { expected_close: v.expected_close } : {}) }).unwrap();
          }} />
      )}
      <label className="mb-3 flex items-center gap-2 text-sm">Status
        <select className={`${inputClass} w-auto`} value={status} onChange={(e) => { setStatus(e.target.value); setCursor(null); }}>
          <option value="">All</option><option value="OPEN">Open</option><option value="WON">Won</option><option value="LOST">Lost</option>
        </select>
      </label>
      <DataTable caption="Opportunities" columns={columns} page={data} isLoading={isLoading} error={error} onRetry={refetch} emptyTitle="No opportunities" onCursor={setCursor} hasPrevious={cursor !== null} onFirst={() => setCursor(null)} />
      <ActionDialog opp={target} onClose={() => setTarget(null)} />
    </>
  );
}
