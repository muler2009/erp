import { getAccessToken } from "../auth/authService";

/** Fetches a stored file through a short-lived link (both calls carry the bearer token) and hands it to the browser. */
export async function downloadFile(fileId: string, name: string): Promise<void> {
  const token = await getAccessToken();
  const headers: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};
  const link = await fetch(`/api/v1/files/${fileId}/link`, { method: "POST", headers });
  if (!link.ok) throw new Error("The file could not be opened. You may not have access to it.");
  const { url } = (await link.json()) as { url: string };
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error("The file could not be downloaded.");
  const blob = await res.blob();
  const href = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = href;
  a.download = name;
  a.click();
  URL.revokeObjectURL(href);
}
