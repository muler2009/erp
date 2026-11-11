import { parseMoney } from "../../shared/lib/money";

export interface ParsedLine { date: string; description: string; amount: string }

/**
 * Parses pasted statement lines: `YYYY-MM-DD,description,amount`, one per line. The date is the first field and the amount
 * the last, so descriptions may contain commas. Money in is positive, money out negative. A header row starting with "date" is skipped.
 */
export function parseStatementCsv(text: string): { lines: ParsedLine[]; errors: string[] } {
  const lines: ParsedLine[] = [];
  const errors: string[] = [];
  text.split(/\r?\n/).forEach((raw, idx) => {
    const row = raw.trim();
    if (!row || (idx === 0 && /^date\b/i.test(row))) return;
    const parts = row.split(",");
    if (parts.length < 2) { errors.push(`Line ${idx + 1}: expected date,description,amount.`); return; }
    const date = (parts[0] ?? "").trim();
    const amount = (parts[parts.length - 1] ?? "").trim();
    const description = parts.slice(1, -1).join(",").trim();
    const value = parseMoney(amount);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(date))) errors.push(`Line ${idx + 1}: the date must be YYYY-MM-DD.`);
    else if (value === null || value === 0n) errors.push(`Line ${idx + 1}: the amount must be a non-zero number with up to 4 decimals.`);
    else lines.push({ date, description, amount });
  });
  return { lines, errors };
}
