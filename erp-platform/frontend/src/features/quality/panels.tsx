import { useRef, useState } from "react";

import { useAddQualityActionMutation, useAddQualityCostMutation, useQualityActionDecisionMutation, useUploadQualityEvidenceMutation } from "../../shared/api/endpoints";
import { errorMessage } from "../../shared/api/errors";
import type { QAction, QCost, QEvidence, QHistory } from "../../shared/api/types";
import { downloadFile } from "../../shared/lib/fileDownload";
import { formatMoney, sumMoney } from "../../shared/lib/money";
import { Badge, Button, Card, EmptyState, inputClass } from "../../shared/ui/primitives";
import { ActionDialog, failure } from "../hr/ActionDialog";
import { pretty } from "../hr/EmployeeDialogs";
import { useUserNames, useUserOptions } from "./names";

export const ACTION_TYPES = ["CONTAINMENT", "CORRECTION", "CORRECTIVE", "PREVENTIVE", "MITIGATION"];
export const COST_CATEGORIES = ["SCRAP", "REWORK", "RETURN", "WARRANTY", "INSPECTION", "PREVENTION", "OTHER"];
const DEC = /^\d+(\.\d{1,4})?$/;

export function validateQAction(type: string, description: string, owner: string, due: string): string | null {
  if (!ACTION_TYPES.includes(type)) return "Choose the kind of action.";
  if (!description.trim()) return "Describe the action.";
  if (!owner) return "Choose who owns it.";
  if (!due) return "Enter the due date.";
  return null;
}
export function validateQCost(category: string, amount: string): string | null {
  if (!COST_CATEGORIES.includes(category)) return "Choose the cost category.";
  if (!DEC.test(amount.trim()) || Number(amount) <= 0) return "The amount must be a positive number.";
  return null;
}

export function ActionsPanel({ parent, id, actions, canManage, canReport, open }: { parent: string; id: string; actions: QAction[]; canManage: boolean; canReport: boolean; open: boolean }) {
  const [add] = useAddQualityActionMutation();
  const [decide] = useQualityActionDecisionMutation();
  const owners = useUserOptions(!canManage);
  const nameOf = useUserNames();
  const [dlg, setDlg] = useState<{ kind: "add" } | { kind: "done" | "cancel"; a: QAction } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const target = dlg && dlg.kind !== "add" ? dlg.a : null;
  const verify = async (a: QAction) => { setErr(null); try { await decide({ id: a.id, action: "verify" }).unwrap(); } catch (e) { setErr(failure(e)); } };
  return (
    <Card title="Actions">
      {canManage && open && <div className="mb-2"><Button variant="secondary" onClick={() => setDlg({ kind: "add" })}>Add an action</Button></div>}
      {err && <p role="alert" className="mb-2 text-sm text-red-700">{err}</p>}
      {!actions.length ? <EmptyState title="No actions yet" /> : (
        <ul className="text-sm">{actions.map((a) => (
          <li key={a.id} className="flex flex-wrap items-center gap-2 border-b border-slate-100 py-2">
            <Badge tone="slate">{pretty(a.action_type)}</Badge><span className="min-w-40 flex-1">{a.description}</span><span className="text-slate-500">{nameOf(a.owner_id)} · due {a.due_date}</span>
            <Badge tone={a.status === "VERIFIED" ? "green" : a.status === "CANCELLED" ? "red" : a.status === "DONE" ? "slate" : a.overdue ? "red" : "amber"}>{a.overdue && a.status === "OPEN" ? "Overdue" : pretty(a.status)}</Badge>
            {a.completion_note && <span className="text-slate-500">{a.completion_note}</span>}
            {a.status === "OPEN" && canReport && <Button variant="secondary" onClick={() => setDlg({ kind: "done", a })}>{`Mark done: ${a.description}`}</Button>}
            {a.status === "DONE" && canManage && <Button variant="secondary" onClick={() => void verify(a)}>{`Verify: ${a.description}`}</Button>}
            {a.status === "OPEN" && canManage && <Button variant="secondary" onClick={() => setDlg({ kind: "cancel", a })}>{`Cancel action: ${a.description}`}</Button>}
          </li>))}</ul>
      )}
      <ActionDialog title="Add an action" open={dlg?.kind === "add"} onClose={() => setDlg(null)} cta="Add action"
        fields={[{ name: "action_type", label: "Kind", required: true, options: ACTION_TYPES.map((t) => [t, pretty(t)] as [string, string]) }, { name: "description", label: "What must be done", required: true }, { name: "owner_id", label: "Owner", required: true, options: owners }, { name: "due_date", label: "Due date", type: "date", required: true }]}
        submit={async (v) => { const p = validateQAction(v.action_type ?? "", v.description ?? "", v.owner_id ?? "", v.due_date ?? ""); if (p) throw new Error(p); await add({ parent, id, body: { action_type: v.action_type, description: (v.description ?? "").trim(), owner_id: v.owner_id, due_date: v.due_date } }).unwrap(); }} />
      <ActionDialog key={`dn${target?.id}`} title="Mark action done" open={dlg?.kind === "done"} onClose={() => setDlg(null)} cta="Mark done" fields={[{ name: "note", label: "What was done" }]} submit={(v) => decide({ id: target!.id, action: "done", body: { note: (v.note ?? "").trim() } }).unwrap()} />
      <ActionDialog key={`cn${target?.id}`} title="Cancel action" open={dlg?.kind === "cancel"} onClose={() => setDlg(null)} cta="Cancel action" fields={[{ name: "reason", label: "Reason", required: true }]} submit={(v) => decide({ id: target!.id, action: "cancel", body: { reason: (v.reason ?? "").trim() } }).unwrap()} />
    </Card>
  );
}

export function EvidencePanel({ record, id, evidence, canUpload }: { record: string; id: string; evidence: QEvidence[]; canUpload: boolean }) {
  const [upload] = useUploadQualityEvidenceMutation();
  const nameOf = useUserNames();
  const input = useRef<HTMLInputElement>(null);
  const [desc, setDesc] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const send = async () => {
    const f = input.current?.files?.[0];
    if (!f) { setErr("Choose a file to attach."); return; }
    setErr(null); setBusy(true);
    const form = new FormData();
    form.append("file", f);
    form.append("kind", "EVIDENCE");
    if (desc.trim()) form.append("description", desc.trim());
    try { await upload({ record, id, form }).unwrap(); setDesc(""); if (input.current) input.current.value = ""; } catch (e) { setErr(errorMessage(e)); } finally { setBusy(false); }
  };
  const get = async (e: QEvidence) => { setErr(null); try { await downloadFile(e.file_id, e.file_name); } catch (x) { setErr(x instanceof Error ? x.message : "Download failed."); } };
  return (
    <Card title="Evidence">
      {!evidence.length ? <EmptyState title="No evidence attached" /> : (
        <ul className="text-sm">{evidence.map((e) => <li key={e.id} className="flex flex-wrap items-center gap-2 border-b border-slate-100 py-1"><Button variant="secondary" onClick={() => void get(e)}>{`Download ${e.file_name}`}</Button><span className="text-slate-500">{e.description} · {nameOf(e.uploaded_by)} · {new Date(e.at).toLocaleDateString()}</span></li>)}</ul>
      )}
      {canUpload && (
        <div className="mt-3 flex flex-wrap items-end gap-2">
          <label className="text-sm">File <input ref={input} type="file" className={inputClass} /></label>
          <label className="text-sm">Description <input className={inputClass} value={desc} onChange={(e) => setDesc(e.target.value)} /></label>
          <Button variant="secondary" disabled={busy} onClick={() => void send()}>Attach</Button>
        </div>
      )}
      {err && <p role="alert" className="mt-2 text-sm text-red-700">{err}</p>}
    </Card>
  );
}

export function CostsPanel({ refType, id, costs, canRecord }: { refType: string; id: string; costs: QCost[]; canRecord: boolean }) {
  const [add] = useAddQualityCostMutation();
  const [open, setOpen] = useState(false);
  return (
    <Card title="Cost of poor quality">
      {canRecord && <div className="mb-2"><Button variant="secondary" onClick={() => setOpen(true)}>Record a cost</Button></div>}
      {!costs.length ? <EmptyState title="No costs recorded" /> : (
        <>
          <ul className="text-sm">{costs.map((c) => <li key={c.id} className="flex flex-wrap gap-2 border-b border-slate-100 py-1"><Badge tone="slate">{pretty(c.category)}</Badge><span>{formatMoney(c.amount)}</span><span className="text-slate-500">{c.incurred_on} {c.description}</span></li>)}</ul>
          <p className="mt-2 text-sm font-semibold">Total {formatMoney(sumMoney(costs.map((c) => c.amount)))}</p>
        </>
      )}
      <ActionDialog title="Record a cost" open={open} onClose={() => setOpen(false)} cta="Record cost" fields={[{ name: "category", label: "Category", required: true, options: COST_CATEGORIES.map((c) => [c, pretty(c)] as [string, string]) }, { name: "amount", label: "Amount", required: true }, { name: "incurred_on", label: "Incurred on", type: "date" }, { name: "description", label: "What for" }]}
        submit={async (v) => { const p = validateQCost(v.category ?? "", v.amount ?? ""); if (p) throw new Error(p); await add({ ref: refType, id, body: { category: v.category, amount: (v.amount ?? "").trim(), description: (v.description ?? "").trim(), ...(v.incurred_on ? { incurred_on: v.incurred_on } : {}) } }).unwrap(); }} />
    </Card>
  );
}

export function HistoryPanel({ history }: { history: QHistory[] }) {
  const nameOf = useUserNames();
  return (
    <Card title="History">
      {!history.length ? <EmptyState title="No history yet" /> : (
        <ol className="text-sm">{history.map((h, i) => <li key={i} className="border-b border-slate-100 py-1"><span className="text-slate-500">{new Date(h.at).toLocaleString()}</span> · <strong>{pretty(h.action)}</strong>{h.to ? ` → ${pretty(h.to)}` : ""} · {h.actor ? nameOf(h.actor) : "System"}{h.note ? ` — ${h.note}` : ""}</li>)}</ol>
      )}
    </Card>
  );
}
