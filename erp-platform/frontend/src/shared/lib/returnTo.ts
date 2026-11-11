/** Where to go after sign-in. Only a path on this same site is accepted: anything else becomes "/". */
export function safeReturnTo(value: unknown, fallback = "/"): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 2000) return fallback;
  if (!value.startsWith("/") || value.startsWith("//") || value.startsWith("/\\")) return fallback;
  if (/[\u0000-\u001f]/.test(value)) return fallback;
  if (value.startsWith("/signin-callback")) return fallback;
  return value;
}
