import { useListEmployeesQuery } from "../../shared/api/endpoints";
import { inputClass } from "../../shared/ui/primitives";

/** Employee dropdown from the first page of the directory the server allows. */
export function EmployeeSelect({ id, label, value, onChange }: { id: string; label: string; value: string; onChange: (v: string) => void }) {
  const { data } = useListEmployeesQuery({ status: "ACTIVE" });
  return (
    <select id={id} aria-label={label} className={inputClass} value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">Choose…</option>
      {data?.results.map((e) => <option key={e.id} value={e.id}>{e.employee_no} {e.name}</option>)}
    </select>
  );
}
