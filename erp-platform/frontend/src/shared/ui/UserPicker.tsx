import { useEffect, useId, useState } from "react";

import { useSearchDirectoryQuery } from "../api/endpoints";
import type { DirectoryUser } from "../api/types";
import { inputClass } from "./primitives";

/**
 * Search-as-you-type colleague picker. The server only answers for two or more characters and only returns
 * id + name, so nothing is listed until the user types. Selecting a person reports their id (a UUID the API validates).
 */
export function UserPicker({ label, onChange }: { label: string; onChange: (user: DirectoryUser | null) => void }) {
  const inputId = useId();
  const listId = useId();
  const [text, setText] = useState("");
  const [query, setQuery] = useState("");
  const [picked, setPicked] = useState<DirectoryUser | null>(null);

  useEffect(() => {
    const t = setTimeout(() => setQuery(text.trim()), 250);
    return () => clearTimeout(t);
  }, [text]);

  const { data, isFetching } = useSearchDirectoryQuery(query, { skip: query.length < 2 || picked !== null });
  const showList = !picked && query.length >= 2;

  return (
    <div className="relative">
      <label htmlFor={inputId} className="mb-1 block text-sm font-medium text-slate-700">{label}</label>
      <input
        id={inputId}
        role="combobox"
        aria-expanded={showList}
        aria-controls={listId}
        aria-autocomplete="list"
        autoComplete="off"
        className={inputClass}
        value={text}
        placeholder="Start typing a name"
        onChange={(e) => { setText(e.target.value); if (picked) { setPicked(null); onChange(null); } }}
      />
      {showList && (
        <ul id={listId} role="listbox" aria-label={`${label} results`} className="absolute z-10 mt-1 max-h-48 w-full overflow-y-auto rounded-md border border-slate-200 bg-white text-sm shadow">
          {isFetching && <li className="px-3 py-2 text-slate-500">Searching…</li>}
          {!isFetching && data?.length === 0 && <li className="px-3 py-2 text-slate-500">No matching colleague</li>}
          {data?.map((u) => (
            <li key={u.id} role="option" aria-selected={false}>
              <button type="button" className="block w-full px-3 py-2 text-left hover:bg-slate-100" onClick={() => { setPicked(u); setText(u.display_name); onChange(u); }}>
                {u.display_name}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
