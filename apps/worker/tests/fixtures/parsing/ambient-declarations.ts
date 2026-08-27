// `declare module` / ambient declarations (§2.6) — the whole block wraps a
// `function_signature` (no body), which the adapter's query never matches (the same
// reason overload signatures produce no symbol) — this file's declarations are expected
// to produce zero ParsedFile.symbols entries, a documented gap, not a crash.
declare module "legacy-lib" {
  export function legacyFn(input: string): number;
}

export function readLegacyLib(input: string): number {
  return input.length;
}
