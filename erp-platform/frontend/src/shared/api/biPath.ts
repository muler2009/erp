import type { BiDatasetArgs } from "./types";

/** URL for running (or exporting) a dataset with the chosen parameters, columns, filters and sort. */
export function biDatasetPath(a: BiDatasetArgs, exportAs: string | false): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(a.params)) if (v !== "") q.set(k, v);
  if (a.columns?.length) q.set("columns", a.columns.join(","));
  if (a.filters?.length) q.set("filters", JSON.stringify(a.filters));
  if (a.sort?.length) q.set("sort", JSON.stringify(a.sort));
  if (exportAs) q.set("fmt", exportAs);
  const qs = q.toString();
  return `api/v1/analytics/datasets/${encodeURIComponent(a.code)}${exportAs ? "/export" : ""}${qs ? `?${qs}` : ""}`;
}
