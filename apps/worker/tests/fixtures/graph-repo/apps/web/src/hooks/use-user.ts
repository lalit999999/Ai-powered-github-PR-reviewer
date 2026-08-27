export interface UserState {
  id: string;
  name: string;
}

/** `useUser` — matches the adapter's `HOOK_NAME_PATTERN` (`^use[A-Z0-9]`),
 * extracted as SymbolKind.HOOK rather than a plain FUNCTION/ARROW_FUNCTION. */
export function useUser(id: string): UserState {
  return { id, name: formatUserName(id) };
}

/** Same-file call (rule 1) from a HOOK to a plain FUNCTION. */
function formatUserName(id: string): string {
  return `user-${id}`;
}
