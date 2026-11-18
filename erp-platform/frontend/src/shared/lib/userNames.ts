/** Names of colleagues learned this session (from the directory), shared by every page. */
const cache = new Map<string, string>();
const listeners = new Set<() => void>();
let version = 0;

export function rememberUsers(users: { id: string; display_name: string }[]): void {
  let changed = false;
  for (const u of users) if (cache.get(u.id) !== u.display_name) { cache.set(u.id, u.display_name); changed = true; }
  if (changed) { version += 1; listeners.forEach((l) => l()); }
}
export function knownName(id: string): string | undefined { return cache.get(id); }
export function subscribeNames(l: () => void): () => void { listeners.add(l); return () => { listeners.delete(l); }; }
export function namesVersion(): number { return version; }
/** For tests: start from an empty cache. */
export function resetUserNames(): void { cache.clear(); version += 1; listeners.forEach((l) => l()); }
