/**
 * Money is never a JavaScript float. The API sends decimal strings; here they are parsed to integers scaled by
 * 10^4 (the backend's precision) so sums and comparisons are exact.
 */
const SCALE = 4;
const FACTOR = 10n ** BigInt(SCALE);

/** "12.5" -> 125000n. Returns null for anything that is not a plain decimal with at most 4 fraction digits. */
export function parseMoney(value: string | null | undefined): bigint | null {
  const v = (value ?? "").trim();
  const m = /^(-)?(\d+)(?:\.(\d{1,4}))?$/.exec(v);
  if (!m) return null;
  const n = BigInt(m[2]!) * FACTOR + BigInt((m[3] ?? "").padEnd(SCALE, "0"));
  return m[1] ? -n : n;
}

export function sumMoney(values: (string | null | undefined)[]): bigint {
  return values.reduce<bigint>((acc, v) => acc + (parseMoney(v) ?? 0n), 0n);
}

/** Display with thousands separators and 2–4 decimals ("1234.5" -> "1,234.50"). */
export function formatMoney(value: string | bigint | null | undefined): string {
  const n = typeof value === "bigint" ? value : parseMoney(value);
  if (n === null || n === undefined) return "—";
  const neg = n < 0n;
  const abs = neg ? -n : n;
  const whole = (abs / FACTOR).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  let frac = (abs % FACTOR).toString().padStart(SCALE, "0");
  while (frac.length > 2 && frac.endsWith("0")) frac = frac.slice(0, -1);
  return `${neg ? "-" : ""}${whole}.${frac}`;
}

/** Exact quantity × unit price on the same 4-decimal scale (truncates beyond 4 decimals, as a display estimate only). */
export function multiplyMoney(quantity: string | null | undefined, price: string | null | undefined): bigint {
  const q = parseMoney(quantity), p = parseMoney(price);
  if (q === null || p === null) return 0n;
  return (q * p) / FACTOR;
}

/** amount × percent / 100, on the same 4-decimal scale (truncating). "15" percent of 100.0000 -> 15.0000. Display estimate only. */
export function percentOf(amount: bigint, percent: string | null | undefined): bigint {
  const p = parseMoney(percent);
  if (p === null) return 0n;
  return (amount * p) / (100n * FACTOR);
}
