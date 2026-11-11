import { useEffect, useId, useState } from "react";

import { useListProductsQuery } from "../api/endpoints";
import type { Product } from "../api/types";
import { inputClass } from "./primitives";

/** Search-as-you-type product picker (name search on the server; results are one page of matches). */
export function ProductPicker({ label, onChange }: { label: string; onChange: (p: Product | null) => void }) {
  const inputId = useId();
  const listId = useId();
  const [text, setText] = useState("");
  const [query, setQuery] = useState("");
  const [picked, setPicked] = useState<Product | null>(null);
  useEffect(() => {
    const t = setTimeout(() => setQuery(text.trim()), 250);
    return () => clearTimeout(t);
  }, [text]);
  const { data, isFetching } = useListProductsQuery({ search: query }, { skip: query.length < 2 || picked !== null });
  const showList = !picked && query.length >= 2;
  return (
    <div className="relative mb-4">
      <label htmlFor={inputId} className="mb-1 block text-sm font-medium text-slate-700">{label}</label>
      <input
        id={inputId} role="combobox" aria-expanded={showList} aria-controls={listId} aria-autocomplete="list" autoComplete="off"
        className={inputClass} value={text} placeholder="Type at least 2 letters of the product name"
        onChange={(e) => { setText(e.target.value); if (picked) { setPicked(null); onChange(null); } }}
      />
      {showList && (
        <ul id={listId} role="listbox" aria-label={`${label} results`} className="absolute z-10 mt-1 max-h-48 w-full overflow-y-auto rounded-md border border-slate-200 bg-white text-sm shadow">
          {isFetching && <li className="px-3 py-2 text-slate-500">Searching…</li>}
          {!isFetching && data?.results.length === 0 && <li className="px-3 py-2 text-slate-500">No matching product</li>}
          {data?.results.map((p) => (
            <li key={p.id} role="option" aria-selected={false}>
              <button type="button" className="block w-full px-3 py-2 text-left hover:bg-slate-100" onClick={() => { setPicked(p); setText(`${p.sku} — ${p.name}`); onChange(p); }}>
                {p.sku} — {p.name}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
