import { useState } from "react";

import { useCreateEmployeeMutation, useListDepartmentsQuery, useListPositionsQuery, useUpdateEmployeeMutation } from "../../shared/api/endpoints";
import { errorMessage } from "../../shared/api/errors";
import type { Employee } from "../../shared/api/types";
import { Button, FormField, Modal, inputClass } from "../../shared/ui/primitives";

export const EMPLOYMENT_TYPES = ["FULL_TIME", "PART_TIME", "CONTRACT", "INTERN"];
export const pretty = (s: string) => (s.charAt(0) + s.slice(1).toLowerCase()).replace(/_/g, " ");
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export interface EmployeeForm { first: string; last: string; hire: string; email: string; phone: string; department: string; position: string; type: string; dob: string }

export function validateEmployee(f: EmployeeForm, creating: boolean): string | null {
  if (!f.first.trim() || !f.last.trim()) return "Enter the first and last name.";
  if (creating && !f.hire) return "Enter the hire date.";
  if (f.email.trim() && !EMAIL.test(f.email.trim())) return "Enter a valid email address.";
  return null;
}

function Fields({ f, set }: { f: EmployeeForm; set: (p: Partial<EmployeeForm>) => void }) {
  const departments = useListDepartmentsQuery();
  const positions = useListPositionsQuery();
  return (
    <>
      <div className="grid grid-cols-2 gap-3">
        <FormField label="First name" htmlFor="em-first"><input id="em-first" maxLength={80} className={inputClass} value={f.first} onChange={(e) => set({ first: e.target.value })} /></FormField>
        <FormField label="Last name" htmlFor="em-last"><input id="em-last" maxLength={80} className={inputClass} value={f.last} onChange={(e) => set({ last: e.target.value })} /></FormField>
        <FormField label="Email" htmlFor="em-email"><input id="em-email" type="email" className={inputClass} value={f.email} onChange={(e) => set({ email: e.target.value })} /></FormField>
        <FormField label="Phone" htmlFor="em-phone"><input id="em-phone" className={inputClass} value={f.phone} onChange={(e) => set({ phone: e.target.value })} /></FormField>
        <FormField label="Department" htmlFor="em-dept"><select id="em-dept" className={inputClass} value={f.department} onChange={(e) => set({ department: e.target.value })}><option value="">None</option>{departments.data?.results.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</select></FormField>
        <FormField label="Position" htmlFor="em-pos"><select id="em-pos" className={inputClass} value={f.position} onChange={(e) => set({ position: e.target.value })}><option value="">None</option>{positions.data?.results.map((p) => <option key={p.id} value={p.id}>{p.title}</option>)}</select></FormField>
        <FormField label="Employment type" htmlFor="em-type"><select id="em-type" className={inputClass} value={f.type} onChange={(e) => set({ type: e.target.value })}>{EMPLOYMENT_TYPES.map((t) => <option key={t} value={t}>{pretty(t)}</option>)}</select></FormField>
        <FormField label="Date of birth (optional)" htmlFor="em-dob"><input id="em-dob" type="date" className={inputClass} value={f.dob} onChange={(e) => set({ dob: e.target.value })} /></FormField>
      </div>
    </>
  );
}

const blank: EmployeeForm = { first: "", last: "", hire: "", email: "", phone: "", department: "", position: "", type: "FULL_TIME", dob: "" };

export function NewEmployeeDialog({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated?: (e: Employee) => void }) {
  const [create, state] = useCreateEmployeeMutation();
  const [f, setF] = useState(blank);
  const [dup, setDup] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const set = (p: Partial<EmployeeForm>) => setF((x) => ({ ...x, ...p }));
  const go = async () => {
    const problem = validateEmployee(f, true);
    if (problem) { setErr(problem); return; }
    setErr(null);
    try {
      const e = await create({ first_name: f.first.trim(), last_name: f.last.trim(), hire_date: f.hire, email: f.email.trim(), phone: f.phone.trim(), employment_type: f.type, ...(f.department ? { department: f.department } : {}), ...(f.position ? { position: f.position } : {}), ...(dup ? { allow_duplicate: true } : {}) }).unwrap();
      setF(blank); setDup(false); onCreated?.(e); onClose();
    } catch (e) { setErr(errorMessage(e)); }
  };
  const duplicateWarning = err && /duplicate|already/i.test(err);
  return (
    <Modal title="New employee" open={open} onClose={onClose}>
      <Fields f={f} set={set} />
      <FormField label="Hire date" htmlFor="em-hire"><input id="em-hire" type="date" className={inputClass} value={f.hire} onChange={(e) => set({ hire: e.target.value })} /></FormField>
      {duplicateWarning && <label className="mb-3 flex items-center gap-2 text-sm"><input type="checkbox" checked={dup} onChange={(e) => setDup(e.target.checked)} /> This is a different person; create anyway</label>}
      {err && <p role="alert" className="mb-3 text-sm text-red-700">{err}</p>}
      <div className="flex justify-end gap-2"><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={state.isLoading} onClick={() => void go()}>Create employee</Button></div>
    </Modal>
  );
}

export function EditEmployeeDialog({ employee, open, onClose }: { employee: Employee; open: boolean; onClose: () => void }) {
  const [update, state] = useUpdateEmployeeMutation();
  const [f, setF] = useState<EmployeeForm>({ ...blank, first: employee.first_name, last: employee.last_name, email: employee.email, phone: employee.phone ?? "", hire: employee.hire_date });
  const [err, setErr] = useState<string | null>(null);
  const set = (p: Partial<EmployeeForm>) => setF((x) => ({ ...x, ...p }));
  const go = async () => {
    const problem = validateEmployee(f, false);
    if (problem) { setErr(problem); return; }
    setErr(null);
    const body: Record<string, unknown> = { first_name: f.first.trim(), last_name: f.last.trim(), email: f.email.trim(), phone: f.phone.trim(), employment_type: f.type };
    if (f.department) body.department = f.department;
    if (f.position) body.position = f.position;
    if (f.dob) body.date_of_birth = f.dob;
    try { await update({ id: employee.id, body }).unwrap(); onClose(); } catch (e) { setErr(errorMessage(e)); }
  };
  return (
    <Modal title="Edit employee" open={open} onClose={onClose}>
      <p className="mb-3 text-sm text-slate-600">Choose a department or position only to change it; leaving them as None keeps the current ones. Use the Assignment tab for approved transfers and promotions.</p>
      <Fields f={f} set={set} />
      {err && <p role="alert" className="mb-3 text-sm text-red-700">{err}</p>}
      <div className="flex justify-end gap-2"><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={state.isLoading} onClick={() => void go()}>Save changes</Button></div>
    </Modal>
  );
}
