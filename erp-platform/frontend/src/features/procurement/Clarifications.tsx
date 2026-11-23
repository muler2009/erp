import { useState } from "react";

import { useListRfqClarificationsQuery, usePostRfqClarificationMutation } from "../../shared/api/endpoints";
import { errorMessage } from "../../shared/api/errors";
import type { RfqDetail } from "../../shared/api/types";
import { useAccess } from "../../shared/permissions/usePermissions";
import { Button, Card, EmptyState, ErrorState, FormField, Spinner, inputClass } from "../../shared/ui/primitives";

export function ClarificationsPanel({ rfq }: { rfq: RfqDetail }) {
  const { can } = useAccess();
  const q = useListRfqClarificationsQuery(rfq.id);
  const [post, st] = usePostRfqClarificationMutation();
  const [supplier, setSupplier] = useState("");
  const [question, setQuestion] = useState("");
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [err, setErr] = useState<string | null>(null);
  const manage = can("procurement.rfq.manage");
  const name = (id: string | null) => (id ? rfq.suppliers.find((s) => s.id === id)?.name ?? "Supplier" : "All suppliers");
  const ask = async () => {
    if (!question.trim()) return setErr("Write the question first.");
    setErr(null);
    try { await post({ rfqId: rfq.id, ...(supplier ? { supplier } : {}), question: question.trim() }).unwrap(); setQuestion(""); } catch (e) { setErr(errorMessage(e)); }
  };
  const reply = async (id: string) => {
    const a = (answers[id] ?? "").trim();
    if (!a) return setErr("Write the answer first.");
    setErr(null);
    try { await post({ rfqId: rfq.id, clarification: id, answer: a }).unwrap(); setAnswers((x) => ({ ...x, [id]: "" })); } catch (e) { setErr(errorMessage(e)); }
  };
  if (!manage) return null;
  return (
    <Card title="Clarifications">
      {q.isLoading && <Spinner />}
      {q.error && <ErrorState error={q.error} onRetry={q.refetch} />}
      {q.data && q.data.length === 0 && <EmptyState title="No questions yet" hint="Questions from suppliers and your answers appear here." />}
      {q.data?.map((c) => (
        <div key={c.id} className="mb-3 border-b border-slate-100 pb-2 text-sm">
          <p><span className="font-medium">{name(c.supplier)}:</span> {c.question}</p>
          {c.answer ? <p className="mt-1 text-slate-700">Answer: {c.answer}</p> : (
            <div className="mt-1 flex gap-2">
              <input aria-label={`Answer to ${c.question}`} className={inputClass} value={answers[c.id] ?? ""} onChange={(e) => setAnswers({ ...answers, [c.id]: e.target.value })} />
              <Button variant="secondary" onClick={() => void reply(c.id)}>Send answer</Button>
            </div>
          )}
        </div>
      ))}
      <FormField label="Ask on behalf of" htmlFor="cl-sup"><select id="cl-sup" className={inputClass} value={supplier} onChange={(e) => setSupplier(e.target.value)}><option value="">All suppliers</option>{rfq.suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></FormField>
      <FormField label="Question" htmlFor="cl-q"><input id="cl-q" className={inputClass} value={question} onChange={(e) => setQuestion(e.target.value)} /></FormField>
      {err && <p role="alert" className="mb-2 text-sm text-red-700">{err}</p>}
      <Button loading={st.isLoading} onClick={() => void ask()}>Post question</Button>
    </Card>
  );
}
