import { useState } from "react";
import { Link } from "react-router";

import { useListDocFavouritesQuery, useSetDocFavouriteMutation } from "../../shared/api/endpoints";
import { errorMessage } from "../../shared/api/errors";
import { Badge, Button, Card, EmptyState, ErrorState, PageHeader, Spinner } from "../../shared/ui/primitives";
import { flags, statusOf } from "./DocumentsPage";

export function FavouritesPage() {
  const [cursor, setCursor] = useState<string | null>(null);
  const q = useListDocFavouritesQuery({ cursor });
  const [setFav] = useSetDocFavouriteMutation();
  const [err, setErr] = useState<string | null>(null);
  return (
    <>
      <PageHeader title="My favourite documents" />
      <p className="mb-3 text-sm"><Link className="text-indigo-700 underline" to="/app/documents">← All documents</Link></p>
      {err && <p role="alert" className="mb-3 text-sm text-red-700">{err}</p>}
      <Card>
        {q.isLoading && <Spinner />}
        {q.error && <ErrorState error={q.error} onRetry={q.refetch} />}
        {q.data?.results.length === 0 && <EmptyState title="No favourites yet" hint="Open a document and choose “Add to favourites”." />}
        <ul className="divide-y divide-slate-100 text-sm">{q.data?.results.map((d) => {
          const st = statusOf(d.status);
          return (
            <li key={d.id} className="flex flex-wrap items-center gap-2 py-2"><span>{d.reference}</span><Link className="text-indigo-700 underline" to={`/app/documents/${d.id}`}>{d.title}</Link><Badge tone={st.tone}>{st.label}</Badge>{flags(d).map((x) => <Badge key={x} tone="red">{x}</Badge>)}
              <Button variant="secondary" aria-label={`Remove ${d.title} from favourites`} onClick={() => { setErr(null); setFav({ id: d.id, on: false }).unwrap().catch((e) => setErr(errorMessage(e))); }}>Remove</Button></li>
          );
        })}</ul>
        <div className="mt-3 flex gap-2">{cursor && <Button variant="secondary" onClick={() => setCursor(null)}>First page</Button>}{q.data?.next && <Button variant="secondary" onClick={() => setCursor(q.data?.next ?? null)}>Next page</Button>}</div>
      </Card>
    </>
  );
}
