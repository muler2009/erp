import { useState } from "react";
import { Link } from "react-router";

import { useAddContactDateMutation, useGetCrossSellQuery, useListAccountChildrenQuery, useListOwnershipQuery, useListUpcomingDatesQuery } from "../../shared/api/endpoints";
import { formatMoney } from "../../shared/lib/money";
import { Card, EmptyState, ErrorState, PageHeader, Spinner, inputClass } from "../../shared/ui/primitives";
import { ActionDialog } from "../hr/ActionDialog";
import { useUserNames } from "../quality/names";

export function ChildrenCard({ id }: { id: string }) {
  const q = useListAccountChildrenQuery(id);
  return (
    <Card title="Child accounts">
      {q.isLoading ? <Spinner /> : q.error ? <ErrorState error={q.error} onRetry={q.refetch} /> : !q.data?.length ? <p className="text-sm text-slate-600">No child accounts.</p> : (
        <ul className="text-sm">{q.data.map((c) => <li key={c.id} className="border-t border-slate-100 py-1"><Link className="text-indigo-700 hover:underline" to={`/app/crm/accounts/${c.id}`}>{c.name}</Link>{c.is_active ? "" : " (archived)"}</li>)}</ul>
      )}
    </Card>
  );
}

export function CrossSellCard({ id }: { id: string }) {
  const [currency, setCurrency] = useState("");
  const valid = currency.trim() === "" || /^[A-Za-z]{3}$/.test(currency.trim());
  const q = useGetCrossSellQuery({ id, ...(currency.trim() && valid ? { currency: currency.trim().toUpperCase() } : {}) }, { skip: !valid });
  return (
    <Card title="Cross-sell ideas">
      <p className="mb-2 text-sm text-slate-600">Products that similar customers (same industry or segment) buy and this one does not.</p>
      <label className="mb-2 block text-sm">Currency (optional) <input aria-label="Cross-sell currency" maxLength={3} className={`${inputClass} w-24`} value={currency} onChange={(e) => setCurrency(e.target.value)} /></label>
      {!valid && <p role="alert" className="text-sm text-red-700">Enter a 3-letter currency code.</p>}
      {valid && (q.isFetching ? <Spinner /> : q.error ? <ErrorState error={q.error} onRetry={q.refetch} /> : !q.data?.length ? <EmptyState title="No suggestions" hint="Needs an industry or segment on the account and purchases by similar customers." /> : (
        <table className="w-full text-sm"><caption className="sr-only">Cross-sell ideas</caption><thead><tr className="text-left text-slate-500"><th>Product</th><th className="text-right">Similar customers buying</th><th className="text-right">Their revenue</th></tr></thead>
          <tbody>{q.data.map((r) => <tr key={r.product} className="border-t border-slate-100"><td>{r.name}</td><td className="text-right">{r.peer_buyers}</td><td className="text-right">{formatMoney(r.revenue)}</td></tr>)}</tbody></table>
      ))}
    </Card>
  );
}

export function OwnershipCard({ kind, id }: { kind: "account" | "lead" | "opportunity"; id: string }) {
  const q = useListOwnershipQuery({ kind, id });
  const nameOf = useUserNames();
  return (
    <Card title="Ownership history">
      {q.isLoading ? <Spinner /> : q.error ? <ErrorState error={q.error} onRetry={q.refetch} /> : !q.data?.length ? <p className="text-sm text-slate-600">The owner has not changed.</p> : (
        <ul className="text-sm">{q.data.map((c, i) => <li key={i} className="border-t border-slate-100 py-1">{c.at.slice(0, 10)}: {c.from ? nameOf(c.from) : "No owner"} → {nameOf(c.to)}{c.by ? ` (by ${nameOf(c.by)})` : ""}{c.reason ? `, ${c.reason}` : ""}</li>)}</ul>
      )}
    </Card>
  );
}

export function dateProblem(label: string, on: string, remind: string): string | null {
  if (!label.trim()) return "Say what the date is (birthday, contract renewal…).";
  if (!on) return "Choose the date.";
  return /^\d+$/.test(remind.trim()) && Number(remind) <= 365 ? null : "Reminder days must be a whole number up to 365.";
}

export function ContactDateDialog({ contactId, name, onClose }: { contactId: string; name: string; onClose: () => void }) {
  const [add] = useAddContactDateMutation();
  return (
    <ActionDialog title={`Add date for ${name}`} cta="Add date" open onClose={onClose} initial={{ remind: "7", yearly: "yes" }}
      fields={[{ name: "label", label: "What is it", required: true }, { name: "on", label: "Date", type: "date", required: true }, { name: "remind", label: "Remind this many days before" }, { name: "yearly", label: "Repeats every year", options: [["yes", "Yes"], ["no", "No"]] }]}
      submit={async (v) => {
        const p = dateProblem(v.label ?? "", v.on ?? "", v.remind ?? "");
        if (p) throw new Error(p);
        await add({ id: contactId, label: (v.label ?? "").trim(), on_date: v.on ?? "", remind_days_before: Number(v.remind), yearly: v.yearly !== "no" }).unwrap();
      }} />
  );
}

export function UpcomingDatesPage() {
  const [days, setDays] = useState(30);
  const q = useListUpcomingDatesQuery(days);
  return (
    <>
      <PageHeader title="Contact dates" description="Birthdays, renewals and other dates to remember for your customers' contacts. Add dates from a contact's row on the Contacts page." />
      <label className="mb-3 block text-sm">Look ahead <select aria-label="Look ahead" className={`${inputClass} w-auto`} value={days} onChange={(e) => setDays(Number(e.target.value))}>{[30, 60, 90, 365].map((d) => <option key={d} value={d}>{d} days</option>)}</select></label>
      <Card>
        {q.isLoading ? <Spinner /> : q.error ? <ErrorState error={q.error} onRetry={q.refetch} /> : !q.data?.length ? <EmptyState title="Nothing coming up" /> : (
          <table className="w-full text-sm"><caption className="sr-only">Upcoming contact dates</caption><thead><tr className="text-left text-slate-500"><th>Date</th><th>Contact</th><th>What</th><th>Remind on</th></tr></thead>
            <tbody>{q.data.map((r, i) => <tr key={i} className="border-t border-slate-100"><td>{r.date}</td><td>{r.name}</td><td>{r.label}</td><td>{r.remind_on}</td></tr>)}</tbody></table>
        )}
      </Card>
    </>
  );
}
