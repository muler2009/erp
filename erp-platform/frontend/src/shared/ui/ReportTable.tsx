import { EmptyState } from "./primitives";

export const label = (k: string) => k.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());
export function cell(v: unknown): string {
  if (v === null || v === undefined || v === "") return "—";
  if (typeof v === "object") return Object.entries(v as Record<string, unknown>).map(([k, x]) => `${label(k)}: ${cell(x)}`).join(", ");
  return String(v);
}

export function ReportTable({ data }: { data: unknown }) {
  if (Array.isArray(data)) {
    if (data.length === 0) return <EmptyState title="Nothing to report" hint="No records fall in this period." />;
    const cols = Array.from(new Set(data.flatMap((r) => Object.keys(r as object))));
    return (
      <table className="w-full text-sm">
        <thead><tr className="text-left">{cols.map((c) => <th key={c}>{label(c)}</th>)}</tr></thead>
        <tbody>{data.map((r, i) => <tr key={i}>{cols.map((c) => <td key={c}>{cell((r as Record<string, unknown>)[c])}</td>)}</tr>)}</tbody>
      </table>
    );
  }
  const entries = Object.entries((data ?? {}) as Record<string, unknown>);
  if (entries.length === 0) return <EmptyState title="Nothing to report" hint="No records fall in this period." />;
  const scalars = entries.filter(([, v]) => !Array.isArray(v));
  const lists = entries.filter(([, v]) => Array.isArray(v));
  return (
    <div>
      {scalars.length > 0 && <table className="w-full text-sm"><tbody>{scalars.map(([k, v]) => <tr key={k}><th className="text-left">{label(k)}</th><td>{cell(v)}</td></tr>)}</tbody></table>}
      {lists.map(([k, v]) => <div key={k} className="mt-3"><h3 className="text-sm font-semibold">{label(k)}</h3><ReportTable data={v} /></div>)}
    </div>
  );
}
