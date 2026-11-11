import { useListCrmAccountsQuery } from "../api/endpoints";

/** Maps account ids to names for list screens. Uses the first page of accounts the user may see; unknown ids show a short id. */
export function useAccountNames() {
  const { data } = useListCrmAccountsQuery();
  const map = new Map(data?.results.map((a) => [a.id, a.name]));
  return (id: string) => map.get(id) ?? `Account ${id.slice(0, 8)}`;
}
