import { useEffect, useRef, useState, useSyncExternalStore } from "react";

import { useListEmployeesQuery, useLookupDirectoryQuery } from "../../shared/api/endpoints";
import { knownName, namesVersion, rememberUsers, subscribeNames } from "../../shared/lib/userNames";

/**
 * Quality records point at user ids. A name comes from the HR employee list, then from the directory: ids that are
 * neither (an owner who is a user but not an employee) are looked up in one batch after the page has rendered.
 */
export function useUserNames(): (id: string | null | undefined) => string {
  const { data, isLoading } = useListEmployeesQuery({ status: "ACTIVE" });
  useSyncExternalStore(subscribeNames, namesVersion);
  const map = new Map((data?.results ?? []).filter((e) => e.user_id).map((e) => [e.user_id as string, e.name]));
  const wanted = useRef(new Set<string>());
  const [batch, setBatch] = useState("");
  const looked = useLookupDirectoryQuery(batch, { skip: !batch });
  useEffect(() => { if (looked.data) rememberUsers(looked.data); }, [looked.data]);
  useEffect(() => {
    if (isLoading) return; // employees first, so colleagues who are employees are not looked up twice
    const ids = [...wanted.current].filter((i) => !map.has(i) && knownName(i) === undefined).sort().slice(0, 50);
    const key = ids.join(",");
    if (key !== batch && key) setBatch(key);
  });
  return (id) => {
    if (!id) return "–";
    const n = map.get(id) ?? knownName(id);
    if (n) return n;
    wanted.current.add(id);
    return `User ${id.slice(0, 8)}`;
  };
}

export function useUserOptions(skip = false): [string, string][] {
  const { data } = useListEmployeesQuery({ status: "ACTIVE" }, { skip });
  return (data?.results ?? []).filter((e) => e.user_id).map((e) => [e.user_id as string, `${e.employee_no} ${e.name}`]);
}
