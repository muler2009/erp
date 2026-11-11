import type { Page } from "./types";

/** The backend pages with cursors and answers with full URLs for next/previous; the app only needs the cursor. */
export function cursorOf(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url, "http://x").searchParams.get("cursor");
  } catch {
    return null;
  }
}

interface RawPage<T> {
  results: T[];
  next: string | null;
  previous: string | null;
}

export function normalizePage<T>(raw: RawPage<T>): Page<T> {
  return { results: raw.results, next: cursorOf(raw.next), previous: cursorOf(raw.previous) };
}

export function withCursor(path: string, cursor?: string | null, extra: Record<string, string> = {}): string {
  const params = new URLSearchParams(extra);
  if (cursor) params.set("cursor", cursor);
  const qs = params.toString();
  return qs ? `${path}?${qs}` : path;
}
