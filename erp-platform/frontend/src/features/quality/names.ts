import { useListEmployeesQuery } from "../../shared/api/endpoints";

/** Quality records point at user ids; employees carry the user id, so names come from there. */
export function useUserNames(): (id: string | null | undefined) => string {
  const { data } = useListEmployeesQuery({ status: "ACTIVE" });
  const map = new Map((data?.results ?? []).filter((e) => e.user_id).map((e) => [e.user_id as string, e.name]));
  return (id) => (id ? map.get(id) ?? `User ${id.slice(0, 8)}` : "–");
}

export function useUserOptions(skip = false): [string, string][] {
  const { data } = useListEmployeesQuery({ status: "ACTIVE" }, { skip });
  return (data?.results ?? []).filter((e) => e.user_id).map((e) => [e.user_id as string, `${e.employee_no} ${e.name}`]);
}
