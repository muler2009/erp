import { getAccessToken } from "../auth/authService";

/** Fetches a CSV export with the bearer token and hands it to the browser as a file. */
export async function downloadCsv(path: string, query: Record<string, string>, filename: string): Promise<void> {
  const token = await getAccessToken();
  const headers: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};
  const qs = new URLSearchParams(query).toString();
  const res = await fetch(`${path}${qs ? `?${qs}` : ""}`, { headers });
  if (!res.ok) {
    let message = "The export could not be downloaded.";
    try { const j = (await res.json()) as { error?: { message?: string } }; if (j.error?.message) message = j.error.message; } catch { /* keep the default message */ }
    throw new Error(message);
  }
  const blob = await res.blob();
  const href = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = href;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(href);
}
