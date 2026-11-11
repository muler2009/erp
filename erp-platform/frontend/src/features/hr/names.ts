import { useListEmployeesQuery } from "../../shared/api/endpoints";

/** Resolves employee ids to names from the first page of the directory the server lets this user see; falls back to a short id. */
export function useEmployeeNames(): (id: string) => string {
  const { data } = useListEmployeesQuery({});
  const map = new Map((data?.results ?? []).map((e) => [e.id, e.name]));
  return (id: string) => map.get(id) ?? id.slice(0, 8);
}
