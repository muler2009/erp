import { useState } from "react";

import { useCancelWorkflowMutation, useDecideTaskMutation, useDelegateTaskMutation, useGetWorkflowInstanceQuery, useResubmitWorkflowMutation } from "../../shared/api/endpoints";
import { errorMessage } from "../../shared/api/errors";
import { formatDateTime } from "../../shared/lib/format";
import { formatMoney, parseMoney } from "../../shared/lib/money";
import type { DirectoryUser } from "../../shared/api/types";
import { UserPicker } from "../../shared/ui/UserPicker";
import { Badge, Button, Modal, Spinner, inputClass } from "../../shared/ui/primitives";

export const statusTone = (s: string) => (s === "APPROVED" ? "green" : s === "REJECTED" || s === "CANCELLED" ? "red" : s === "CHANGES_REQUESTED" || s === "PENDING" ? "amber" : "slate");
export const pretty = (s: string) => s.toLowerCase().replace(/_/g, " ");

interface Props {
  instanceId: string | null;
  /** Set when the signed-in user is deciding on a task (inbox); omitted for a read-only/requester view. */
  taskId?: string | null;
  canCancel?: boolean;
  /** The signed-in user submitted this request, so they may resubmit it after changes were requested. */
  isRequester?: boolean;
  onClose: () => void;
}

/** Shows an approval request with its full history and, when a task is supplied, the approve / request changes / reject controls. */
export function InstanceDialog({ instanceId, taskId, canCancel, isRequester, onClose }: Props) {
  const { data, isFetching, error } = useGetWorkflowInstanceQuery(instanceId ?? "", { skip: !instanceId });
  const [decide, decideState] = useDecideTaskMutation();
  const [cancel, cancelState] = useCancelWorkflowMutation();
  const [delegate, delegateState] = useDelegateTaskMutation();
  const [resubmit, resubmitState] = useResubmitWorkflowMutation();
  const [comment, setComment] = useState("");
  const [delegating, setDelegating] = useState(false);
  const [to, setTo] = useState<DirectoryUser | null>(null);
  const [newAmount, setNewAmount] = useState("");
  const [err, setErr] = useState<string | null>(null);

  const finish = () => { setComment(""); setErr(null); setDelegating(false); setTo(null); setNewAmount(""); onClose(); };
  const doDelegate = async () => {
    setErr(null);
    if (!to) { setErr("Choose a colleague to delegate to."); return; }
    try { await delegate({ taskId: taskId!, toUserId: to.id, comment: comment.trim() }).unwrap(); finish(); } catch (e) { setErr(errorMessage(e)); }
  };
  const doResubmit = async () => {
    setErr(null);
    const amt = newAmount.trim();
    if (amt !== "" && (parseMoney(amt) === null || (amt.split(".")[1]?.length ?? 0) > 2)) { setErr("Enter the amount with at most 2 decimals."); return; }
    try { await resubmit({ id: instanceId!, comment: comment.trim(), ...(amt ? { amount: amt } : {}) }).unwrap(); finish(); } catch (e) { setErr(errorMessage(e)); }
  };
  const send = async (decision: "APPROVE" | "REJECT" | "REQUEST_CHANGES") => {
    setErr(null);
    // Rejecting or asking for changes without a reason is unhelpful; the server decides what is mandatory.
    if (decision !== "APPROVE" && comment.trim() === "") { setErr("Please explain your decision."); return; }
    try { await decide({ taskId: taskId!, decision, comment: comment.trim() }).unwrap(); finish(); } catch (e) { setErr(errorMessage(e)); }
  };
  const doCancel = async () => {
    setErr(null);
    try { await cancel({ id: instanceId!, comment: comment.trim() }).unwrap(); finish(); } catch (e) { setErr(errorMessage(e)); }
  };

  return (
    <Modal title={data?.title ?? "Approval request"} open={!!instanceId} onClose={finish}>
      {isFetching && !data && <Spinner />}
      {error && <p role="alert" className="text-sm text-red-700">{errorMessage(error)}</p>}
      {data && (
        <>
          <p className="mb-2 text-sm text-slate-600">
            {pretty(data.subject_type)} · {data.amount != null && `${formatMoney(data.amount)} · `}
            <Badge tone={statusTone(data.status)}>{pretty(data.status)}</Badge> · round {data.round}
          </p>
          <h3 className="mt-3 text-sm font-semibold">History</h3>
          <ol className="mt-1 max-h-48 space-y-2 overflow-y-auto text-sm" aria-label="History">
            {data.history?.map((h, i) => (
              <li key={i} className="border-l-2 border-slate-200 pl-3">
                <span className="font-medium">{pretty(h.action)}</span> <span className="text-xs text-slate-500">{formatDateTime(h.at)}</span>
                {h.comment && <p className="text-slate-600">{h.comment}</p>}
              </li>
            ))}
          </ol>
          {taskId && delegating && (
            <div className="mt-4">
              <UserPicker label="Delegate to" onChange={setTo} />
            </div>
          )}
          {isRequester && data.status === "CHANGES_REQUESTED" && (
            <div className="mt-4">
              <label htmlFor="wf-amount" className="mb-1 block text-sm font-medium text-slate-700">Updated amount (optional)</label>
              <input id="wf-amount" inputMode="decimal" className={inputClass} value={newAmount} onChange={(e) => setNewAmount(e.target.value)} />
            </div>
          )}
          {(taskId || canCancel || (isRequester && data.status === "CHANGES_REQUESTED")) && (
            <div className="mt-4">
              <label htmlFor="wf-comment" className="mb-1 block text-sm font-medium text-slate-700">Comment</label>
              <textarea id="wf-comment" rows={3} className={inputClass} value={comment} maxLength={4000} onChange={(e) => setComment(e.target.value)} />
            </div>
          )}
          {err && <p role="alert" className="mt-3 text-sm text-red-700">{err}</p>}
          <div className="mt-4 flex flex-wrap justify-end gap-2">
            {taskId && (
              <>
                {delegating ? (
                  <Button variant="secondary" loading={delegateState.isLoading} onClick={() => void doDelegate()}>Confirm delegation</Button>
                ) : (
                  <Button variant="secondary" onClick={() => setDelegating(true)}>Delegate</Button>
                )}
                <Button variant="danger" loading={decideState.isLoading} onClick={() => void send("REJECT")}>Reject</Button>
                <Button variant="secondary" loading={decideState.isLoading} onClick={() => void send("REQUEST_CHANGES")}>Request changes</Button>
                <Button loading={decideState.isLoading} onClick={() => void send("APPROVE")}>Approve</Button>
              </>
            )}
            {isRequester && data.status === "CHANGES_REQUESTED" && <Button loading={resubmitState.isLoading} onClick={() => void doResubmit()}>Resubmit</Button>}
            {canCancel && data.status === "PENDING" && <Button variant="secondary" loading={cancelState.isLoading} onClick={() => void doCancel()}>Cancel request</Button>}
            <Button variant="secondary" onClick={finish}>Close</Button>
          </div>
        </>
      )}
    </Modal>
  );
}
