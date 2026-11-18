import { useState } from "react";

import type { DirectoryUser } from "../api/types";
import { rememberUsers } from "../lib/userNames";
import { UserPicker } from "./UserPicker";
import { inputClass } from "./primitives";

/**
 * A select of known colleagues (for example HR employees) with a "find someone else" search underneath, so a person who
 * is a user but not in the list can still be chosen. Whoever is found is added to the select and chosen.
 */
export function UserSelect({ id, value, onChange, options, placeholder = "Choose…" }: { id: string; value: string; onChange: (value: string) => void; options: [string, string][]; placeholder?: string }) {
  const [found, setFound] = useState<DirectoryUser[]>([]);
  const known = new Set(options.map(([v]) => v));
  const all: [string, string][] = [...options, ...found.filter((u) => !known.has(u.id)).map((u) => [u.id, u.display_name] as [string, string])];
  return (
    <div className="space-y-2">
      <select id={id} className={inputClass} value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">{placeholder}</option>
        {all.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
      </select>
      <UserPicker label="Find someone else" onChange={(u) => { if (!u) return; rememberUsers([u]); setFound((f) => (f.some((x) => x.id === u.id) ? f : [...f, u])); onChange(u.id); }} />
    </div>
  );
}
