import { useState } from "react";

import { useAssignRoleMutation, useListRolesQuery, useRevokeRoleAssignmentMutation } from "../../shared/api/endpoints";
import { errorMessage } from "../../shared/api/errors";
import type { Membership } from "../../shared/api/types";
import { formatDateTime } from "../../shared/lib/format";
import { Button, FormField, Modal, Spinner, inputClass } from "../../shared/ui/primitives";

/** The end of a temporary grant is picked as a date and means the end of that day. */
export function endOfDayIso(date: string): string | null {
  if (!date) return null;
  const d = new Date(`${date}T23:59:59`);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

export function grantProblem(roleId: string, validTo: string, today = new Date().toISOString().slice(0, 10)): string | null {
  if (!roleId) return "Choose a role.";
  if (validTo && validTo < today) return "The end date cannot be in the past.";
  return null;
}

/** `roles` comes from the user list; `member` is read fresh from it so a grant or revoke shows at once. */
export function RolesDialog({ member, onClose }: { member: Membership; onClose: () => void }) {
  const roles = useListRolesQuery();
  const [assign, a] = useAssignRoleMutation();
  const [revoke, r] = useRevokeRoleAssignmentMutation();
  const [roleId, setRoleId] = useState("");
  const [validTo, setValidTo] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const label = member.display_name || member.email;
  const give = async () => {
    const p = grantProblem(roleId, validTo);
    if (p) { setErr(p); setOk(null); return; }
    setErr(null); setOk(null);
    try { await assign({ membership_id: member.id, role_id: roleId, ...(validTo ? { valid_to: endOfDayIso(validTo) } : {}) }).unwrap(); setRoleId(""); setValidTo(""); setOk("Role granted."); } catch (e) { setErr(errorMessage(e)); }
  };
  const take = async (id: string) => {
    setErr(null); setOk(null);
    try { await revoke(id).unwrap(); setOk("Role removed."); } catch (e) { setErr(errorMessage(e)); }
  };
  const scope = (x: Membership["roles"][number]) => (x.scope_type === "TENANT" ? "whole workspace" : x.scope_type.toLowerCase().replace(/_/g, " "));
  return (
    <Modal title={`Roles for ${label}`} open onClose={onClose}>
      <h3 className="mb-1 text-sm font-semibold">Current roles</h3>
      {member.roles.length === 0 ? <p className="mb-3 text-sm text-slate-500">No roles yet.</p> : (
        <ul className="mb-3 text-sm">{member.roles.map((x) => (
          <li key={x.assignment_id} className="flex items-center justify-between border-b border-slate-100 py-1">
            <span>{x.role} · {scope(x)}{x.valid_to ? ` · until ${formatDateTime(x.valid_to)}` : ""}</span>
            <Button variant="secondary" aria-label={`Remove ${x.role}`} loading={r.isLoading} onClick={() => void take(x.assignment_id)}>Remove</Button>
          </li>))}</ul>
      )}
      <h3 className="mb-1 text-sm font-semibold">Grant a role</h3>
      {roles.isLoading ? <Spinner /> : (
        <>
          <FormField label="Role" htmlFor="ra-role"><select id="ra-role" className={inputClass} value={roleId} onChange={(e) => setRoleId(e.target.value)}><option value="">Choose…</option>{(roles.data ?? []).map((x) => <option key={x.id} value={x.id}>{x.display_name || x.name}</option>)}</select></FormField>
          <FormField label="Until (optional, for temporary access)" htmlFor="ra-until"><input id="ra-until" type="date" className={inputClass} value={validTo} onChange={(e) => setValidTo(e.target.value)} /></FormField>
        </>
      )}
      <p className="mb-2 text-xs text-slate-500">You can only grant roles that carry no more access than you hold yourself. Roles limited to one department or project are shown here but are granted from where they apply.</p>
      {err && <p role="alert" className="mb-2 text-sm text-red-700">{err}</p>}
      {ok && <p role="status" className="mb-2 text-sm text-green-700">{ok}</p>}
      <div className="flex justify-end gap-2"><Button variant="secondary" onClick={onClose}>Close</Button><Button loading={a.isLoading} onClick={() => void give()}>Grant role</Button></div>
    </Modal>
  );
}
