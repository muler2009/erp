export function formatDateTime(value: string | null | undefined): string {
  if (!value) return "";
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

/** Backend amounts arrive as decimal strings. They are only formatted for display, never calculated on. */
export function formatNumber(value: string | number | null | undefined, maximumFractionDigits = 2): string {
  if (value === null || value === undefined || value === "") return "";
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n.toLocaleString(undefined, { maximumFractionDigits }) : String(value);
}
