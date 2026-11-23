import type { PurchaseOrder } from "../../shared/api/types";
import { formatMoney } from "../../shared/lib/money";

export const esc = (v: unknown) => String(v ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

/** Self-contained printable purchase order. Every value is escaped because supplier and item text is user-entered. */
export function poDocumentHtml(o: PurchaseOrder): string {
  const rows = (o.lines ?? []).map((l) => `<tr><td>${l.line_no}</td><td>${esc(l.description)}</td><td class="r">${esc(formatMoney(l.quantity))}</td><td class="r">${esc(formatMoney(l.unit_price))}</td></tr>`).join("");
  const meta = [["Order date", o.order_date], ["Expected delivery", o.expected_date ?? "—"], ["Payment terms", o.payment_terms || "—"], ["Delivery terms", o.delivery_terms || "—"], ["Delivery address", o.delivery_address || "—"]];
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(o.number)}</title><style>body{font:14px sans-serif;margin:32px;color:#111}table{width:100%;border-collapse:collapse;margin-top:16px}th,td{border-bottom:1px solid #ccc;padding:6px;text-align:left}.r{text-align:right}h1{font-size:20px}</style></head><body><h1>Purchase order ${esc(o.number)}</h1><p><strong>Supplier:</strong> ${esc(o.supplier.name)}<br>${meta.map(([k, v]) => `<strong>${esc(k)}:</strong> ${esc(v)}`).join("<br>")}</p><table><thead><tr><th>#</th><th>Item</th><th class="r">Quantity</th><th class="r">Unit price (${esc(o.currency)})</th></tr></thead><tbody>${rows}</tbody></table><p class="r"><strong>Total: ${esc(o.currency)} ${esc(formatMoney(o.total))}</strong></p></body></html>`;
}

export function printPurchaseOrder(o: PurchaseOrder): boolean {
  const w = window.open("", "_blank");
  if (!w) return false;
  w.document.write(poDocumentHtml(o));
  w.document.close();
  w.focus();
  w.print();
  return true;
}
